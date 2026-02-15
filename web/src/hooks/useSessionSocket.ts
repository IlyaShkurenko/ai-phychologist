import { useEffect } from "react";

import { openSessionSocket } from "../api";
import type { TdlibEvent } from "../types";

export type SessionSocketErrorCode = "parse_error" | "connection_error";

export function useSessionSocket(
  sessionId: string | null,
  onEvent: (event: TdlibEvent) => void,
  onError: (code: SessionSocketErrorCode) => void,
): void {
  useEffect(() => {
    if (!sessionId) {
      return;
    }

    const socket = openSessionSocket(sessionId);

    socket.onmessage = (message) => {
      try {
        const parsed = JSON.parse(message.data) as TdlibEvent;
        onEvent(parsed);
      } catch {
        onError("parse_error");
      }
    };

    socket.onerror = () => {
      onError("connection_error");
    };

    return () => {
      socket.close();
    };
  }, [sessionId, onEvent, onError]);
}
