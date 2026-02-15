import type WebSocket from "ws";

import type { TdlibEvent } from "./types.js";

interface SessionStream {
  abortController: AbortController;
  running: boolean;
}

export class TdlibEventBridge {
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly streams = new Map<string, SessionStream>();

  constructor(private readonly tdlibBaseUrl: string) {}

  addSubscriber(sessionId: string, socket: WebSocket): void {
    const set = this.subscribers.get(sessionId) ?? new Set<WebSocket>();
    set.add(socket);
    this.subscribers.set(sessionId, set);

    if (!this.streams.has(sessionId)) {
      void this.startStream(sessionId);
    }
  }

  removeSubscriber(sessionId: string, socket: WebSocket): void {
    const set = this.subscribers.get(sessionId);
    if (!set) {
      return;
    }
    set.delete(socket);

    if (set.size === 0) {
      this.subscribers.delete(sessionId);
      const stream = this.streams.get(sessionId);
      if (stream) {
        stream.abortController.abort();
        this.streams.delete(sessionId);
      }
    }
  }

  clearSession(sessionId: string): void {
    const set = this.subscribers.get(sessionId);
    if (set) {
      for (const socket of set) {
        if (socket.readyState === socket.OPEN) {
          socket.close(1000, "Session cleared");
        }
      }
      this.subscribers.delete(sessionId);
    }

    const stream = this.streams.get(sessionId);
    if (stream) {
      stream.abortController.abort();
      this.streams.delete(sessionId);
    }
  }

  private async startStream(sessionId: string): Promise<void> {
    const abortController = new AbortController();
    this.streams.set(sessionId, { abortController, running: true });

    try {
      await this.consumeSse(sessionId, abortController);
    } catch (error) {
      this.broadcast(sessionId, {
        type: "errors",
        sessionId,
        payload: {
          message: error instanceof Error ? error.message : "SSE stream failed",
        },
        ts: Date.now(),
      });

      if (this.subscribers.has(sessionId)) {
        setTimeout(() => {
          if (!this.streams.has(sessionId) && this.subscribers.has(sessionId)) {
            void this.startStream(sessionId);
          }
        }, 1500);
      }
    } finally {
      this.streams.delete(sessionId);
    }
  }

  private async consumeSse(sessionId: string, abortController: AbortController): Promise<void> {
    const response = await fetch(`${this.tdlibBaseUrl}/sessions/${sessionId}/events`, {
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Unable to connect to TDLib events (${response.status})`);
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const rawEvent = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        this.handleRawSseEvent(sessionId, rawEvent);
        delimiterIndex = buffer.indexOf("\n\n");
      }
    }
  }

  private handleRawSseEvent(sessionId: string, rawEvent: string): void {
    const lines = rawEvent.split("\n");
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    if (dataLines.length === 0) {
      return;
    }

    try {
      const event = JSON.parse(dataLines.join("\n")) as TdlibEvent;
      this.broadcast(sessionId, event);
    } catch {
      this.broadcast(sessionId, {
        type: "errors",
        sessionId,
        payload: { message: "Failed to parse TDLib event" },
        ts: Date.now(),
      });
    }
  }

  private broadcast(sessionId: string, event: TdlibEvent): void {
    const set = this.subscribers.get(sessionId);
    if (!set) {
      return;
    }

    const payload = JSON.stringify(event);
    for (const socket of set) {
      if (socket.readyState !== socket.OPEN) {
        continue;
      }
      socket.send(payload);
    }
  }
}
