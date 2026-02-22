import type {
  AnalysisConfig,
  AnalysisMode,
  AnalysisResult,
  AuthState,
  ChatMessage,
  ChatSummary,
  Locale,
  PromptStep,
  PromptTestResponse,
  PromptThemeState,
  PromptVersion,
} from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4001";
const REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_REQUEST_TIMEOUT_MS ?? 60000);
const RANGE_REQUEST_TIMEOUT_MS = Number(import.meta.env.VITE_RANGE_REQUEST_TIMEOUT_MS ?? 300000);
const RESUME_PATH = "/api/sessions/resume";

const resumeInFlightBySessionId = new Map<string, Promise<void>>();

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
    undefined,
    RANGE_REQUEST_TIMEOUT_MS,
  );
  return response.messages;
}

export async function exportRangeMessagesAsText(
  sessionId: string,
  chatId: number,
  startTs: number,
  endTs: number,
): Promise<string> {
  return requestText(
    `/api/sessions/${sessionId}/chats/${chatId}/messages/range/export.txt?startTs=${startTs}&endTs=${endTs}`,
    RANGE_REQUEST_TIMEOUT_MS,
  );
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
  const timeoutMs = args.mode === "range" ? RANGE_REQUEST_TIMEOUT_MS : 120_000;
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
    timeoutMs,
  );

  return response.analysis;
}

export async function getGaslightingPrompts(): Promise<PromptThemeState> {
  return request<PromptThemeState>("/api/prompts/gaslighting");
}

export async function createGaslightingPromptVersion(
  step: PromptStep,
  content: string,
): Promise<PromptVersion> {
  const response = await request<{ version: PromptVersion }>(`/api/prompts/gaslighting/${step}/versions`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  return response.version;
}

export async function activateGaslightingPromptVersion(step: PromptStep, versionId: string): Promise<void> {
  await request(`/api/prompts/gaslighting/${step}/activate`, {
    method: "POST",
    body: JSON.stringify({ versionId }),
  });
}

export async function testGaslightingPromptStep(args: {
  sessionId: string;
  chatId: number;
  step: PromptStep;
  prompt: string;
  locale: Locale;
  startTs: number;
  endTs: number;
}): Promise<PromptTestResponse> {
  return request<PromptTestResponse>(`/api/sessions/${args.sessionId}/chats/${args.chatId}/prompts/gaslighting/test`, {
    method: "POST",
    body: JSON.stringify({
      step: args.step,
      prompt: args.prompt,
      locale: args.locale,
      selection: {
        startTs: args.startTs,
        endTs: args.endTs,
      },
    }),
  }, RANGE_REQUEST_TIMEOUT_MS);
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
  return requestJsonInternal<T>(path, init, timeoutMs, true);
}

async function requestText(path: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
  return requestTextInternal(path, timeoutMs, true);
}

async function requestJsonInternal<T>(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  allowUnknownSessionRetry: boolean,
): Promise<T> {
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
    if (
      allowUnknownSessionRetry &&
      response.status === 404 &&
      isUnknownSessionError(payload?.error) &&
      path !== RESUME_PATH
    ) {
      const sessionId = extractSessionIdFromPath(path);
      if (sessionId) {
        await resumeMissingSession(sessionId);
        return requestJsonInternal<T>(path, init, timeoutMs, false);
      }
    }

    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return payload as T;
}

async function requestTextInternal(
  path: string,
  timeoutMs: number,
  allowUnknownSessionRetry: boolean,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Accept: "text/plain",
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

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (
      allowUnknownSessionRetry &&
      response.status === 404 &&
      isUnknownSessionError(payload?.error)
    ) {
      const sessionId = extractSessionIdFromPath(path);
      if (sessionId) {
        await resumeMissingSession(sessionId);
        return requestTextInternal(path, timeoutMs, false);
      }
    }
    throw new Error(payload?.error ?? `Request failed (${response.status})`);
  }

  return response.text();
}

function isUnknownSessionError(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" && errorMessage.includes("Unknown session");
}

function extractSessionIdFromPath(path: string): string | null {
  const match = path.match(/\/api\/sessions\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

async function resumeMissingSession(sessionId: string): Promise<void> {
  const existing = resumeInFlightBySessionId.get(sessionId);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${API_BASE_URL}${RESUME_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? `Request failed (${response.status})`);
      }
    } finally {
      window.clearTimeout(timeoutId);
      resumeInFlightBySessionId.delete(sessionId);
    }
  })();

  resumeInFlightBySessionId.set(sessionId, promise);
  return promise;
}
