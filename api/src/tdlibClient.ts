import type { AuthState, ChatMessage, ChatSummary } from "./types.js";

interface TdlibSessionCreateResponse {
  sessionId: string;
  authState: AuthState;
}

interface TdlibSessionInfo {
  sessionId: string;
  authState: AuthState;
  createdAt: number;
}

interface TdlibClientConfig {
  baseUrl: string;
  requestTimeoutMs?: number;
}

export class TdlibClient {
  private readonly requestTimeoutMs: number;

  constructor(private readonly config: TdlibClientConfig) {
    this.requestTimeoutMs = config.requestTimeoutMs ?? 12000;
  }

  async createSession(): Promise<TdlibSessionCreateResponse> {
    return this.request<TdlibSessionCreateResponse>("/sessions", {
      method: "POST",
    });
  }

  async resumeSession(sessionId: string): Promise<TdlibSessionCreateResponse> {
    return this.request<TdlibSessionCreateResponse>("/sessions/resume", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
  }

  async getSession(sessionId: string): Promise<TdlibSessionInfo> {
    return this.request<TdlibSessionInfo>(`/sessions/${sessionId}`);
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${sessionId}`, { method: "DELETE" });
  }

  async submitPhone(sessionId: string, phoneNumber: string): Promise<{ authState: AuthState }> {
    return this.request<{ authState: AuthState }>(`/sessions/${sessionId}/auth/phone`, {
      method: "POST",
      body: JSON.stringify({ phoneNumber }),
    });
  }

  async startQrAuthentication(
    sessionId: string,
  ): Promise<{ authState: AuthState; qrLink?: string }> {
    return this.request<{ authState: AuthState; qrLink?: string }>(
      `/sessions/${sessionId}/auth/qr`,
      {
        method: "POST",
      },
    );
  }

  async submitCode(sessionId: string, code: string): Promise<{ authState: AuthState }> {
    return this.request<{ authState: AuthState }>(`/sessions/${sessionId}/auth/code`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
  }

  async submitPassword(sessionId: string, password: string): Promise<{ authState: AuthState }> {
    return this.request<{ authState: AuthState }>(`/sessions/${sessionId}/auth/password`, {
      method: "POST",
      body: JSON.stringify({ password }),
    });
  }

  async listChats(sessionId: string, limit = 100): Promise<ChatSummary[]> {
    const result = await this.request<{ chats: ChatSummary[] }>(`/sessions/${sessionId}/chats?limit=${limit}`);
    return result.chats;
  }

  async getChatHistory(
    sessionId: string,
    chatId: number,
    limit: number,
    fromMessageId?: number,
    timeoutMs?: number,
  ): Promise<ChatMessage[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (fromMessageId) {
      params.set("fromMessageId", String(fromMessageId));
    }

    const result = await this.request<{ messages: ChatMessage[] }>(
      `/sessions/${sessionId}/chats/${chatId}/history?${params.toString()}`,
      undefined,
      timeoutMs,
    );
    return result.messages;
  }

  async getChatHistoryByDate(
    sessionId: string,
    chatId: number,
    startTs: number,
    endTs: number,
    timeoutMs?: number,
  ): Promise<ChatMessage[]> {
    const result = await this.request<{ messages: ChatMessage[] }>(
      `/sessions/${sessionId}/chats/${chatId}/history-by-date?startTs=${startTs}&endTs=${endTs}`,
      undefined,
      timeoutMs,
    );
    return result.messages;
  }

  async getChatMessageByDate(
    sessionId: string,
    chatId: number,
    dateTs: number,
    timeoutMs?: number,
  ): Promise<ChatMessage | null> {
    const result = await this.request<{ message?: ChatMessage | null }>(
      `/sessions/${sessionId}/chats/${chatId}/message-by-date?dateTs=${dateTs}`,
      undefined,
      timeoutMs,
    );
    return result.message ?? null;
  }

  async getMessagesByIds(
    sessionId: string,
    chatId: number,
    ids: number[],
    timeoutMs?: number,
  ): Promise<ChatMessage[]> {
    const result = await this.request<{ messages: ChatMessage[] }>(
      `/sessions/${sessionId}/chats/${chatId}/messages/by-ids`,
      {
        method: "POST",
        body: JSON.stringify({ ids }),
      },
      timeoutMs,
    );
    return result.messages;
  }

  private async request<T = unknown>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
    const effectiveTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? timeoutMs
        : this.requestTimeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeoutMs);

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`TDLib request timeout after ${effectiveTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(payload?.error ?? `TDLib request failed (${response.status})`);
    }

    return payload as T;
  }
}
