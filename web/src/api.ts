import type {
  AnalysisConfig,
  AnalysisMode,
  AnalysisResult,
  AuthState,
  ChatMessage,
  ChatSummary,
  Locale,
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? 60000);

export async function createSession(): Promise<{ sessionId: string; authState: AuthState }> {
  return request("/api/sessions", { method: "POST" });
}

export async function resumeSession(
  sessionId: string,
): Promise<{ sessionId: string; authState: AuthState }> {
  return request("/api/sessions/resume", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
}

export async function disconnectSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

export async function clearSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}/clear`, { method: "POST" });
}

export async function submitPhoneNumber(sessionId: string, phoneNumber: string): Promise<{ authState: AuthState }> {
  return request(`/api/sessions/${sessionId}/auth/phone`, {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  });
}

export async function startQrAuthentication(
  sessionId: string,
): Promise<{ authState: AuthState; qrLink?: string }> {
  return request(`/api/sessions/${sessionId}/auth/qr`, {
    method: "POST",
  });
}

export async function submitCode(sessionId: string, code: string): Promise<{ authState: AuthState }> {
  return request(`/api/sessions/${sessionId}/auth/code`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function submitPassword(sessionId: string, password: string): Promise<{ authState: AuthState }> {
  return request(`/api/sessions/${sessionId}/auth/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function listChats(sessionId: string): Promise<ChatSummary[]> {
  const response = await request<{ chats: ChatSummary[] }>(`/api/sessions/${sessionId}/chats`);
  return response.chats;
}

export async function getMessages(
  sessionId: string,
  chatId: number,
  limit = 100,
  fromMessageId?: number,
): Promise<ChatMessage[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (fromMessageId) {
    params.set("fromMessageId", String(fromMessageId));
  }
  const response = await request<{ messages: ChatMessage[] }>(
    `/api/sessions/${sessionId}/chats/${chatId}/messages?${params.toString()}`,
  );
  return response.messages;
}

export async function getMessagesByRange(
  sessionId: string,
  chatId: number,
  startTs: number,
  endTs: number,
): Promise<ChatMessage[]> {
  const response = await request<{ messages: ChatMessage[] }>(
    `/api/sessions/${sessionId}/chats/${chatId}/messages/range?startTs=${startTs}&endTs=${endTs}`,
  );
  return response.messages;
}

export async function analyzeMessages(args: {
  sessionId: string;
  chatId: number;
  mode: AnalysisMode;
  locale: Locale;
  config: AnalysisConfig;
  selection?: {
    startTs?: number;
    endTs?: number;
    messageIds?: number[];
  };
}): Promise<AnalysisResult> {
  const response = await request<{ analysis: AnalysisResult }>(
    `/api/sessions/${args.sessionId}/analysis`,
    {
      method: "POST",
      body: JSON.stringify({
        chatId: args.chatId,
        mode: args.mode,
        locale: args.locale,
        config: args.config,
        selection: args.selection,
      }),
    },
    120_000,
  );

  return response.analysis;
}

function buildWsUrl(sessionId: string): string {
  const apiUrl = new URL(API_BASE_URL);
  apiUrl.protocol = apiUrl.protocol === "https:" ? "wss:" : "ws:";
  apiUrl.pathname = "/ws";
  apiUrl.search = `?sessionId=${sessionId}`;
  return apiUrl.toString();
}

export function openSessionSocket(sessionId: string): WebSocket {
  return new WebSocket(buildWsUrl(sessionId));
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return payload as T;
}
