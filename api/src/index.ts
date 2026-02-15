import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { TdlibEventBridge } from "./eventBridge.js";
import { OpenAiAnalyzer } from "./openaiAnalyzer.js";
import { SessionRateLimiter } from "./rateLimiter.js";
import { TdlibClient } from "./tdlibClient.js";
import type { AnalysisConfig, AnalysisMode, ChatMessage, Locale } from "./types.js";

dotenv.config();
const apiModuleDir = path.dirname(fileURLToPath(import.meta.url));
for (const candidatePath of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../.env"),
  path.resolve(apiModuleDir, "../.env"),
  path.resolve(apiModuleDir, "../../.env"),
]) {
  dotenv.config({ path: candidatePath });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiPort = Number(process.env.API_PORT ?? 4001);
const tdlibBaseUrl = process.env.TDLIB_BASE_URL ?? "http://localhost:4002";
const tdlibRequestTimeoutMs = Number(process.env.TDLIB_REQUEST_TIMEOUT_MS ?? 30000);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

const tdlibClient = new TdlibClient({ baseUrl: tdlibBaseUrl, requestTimeoutMs: tdlibRequestTimeoutMs });
const analyzer = new OpenAiAnalyzer(openAiApiKey, openAiModel);
const eventBridge = new TdlibEventBridge(tdlibBaseUrl);
const rateLimiter = new SessionRateLimiter(60_000, 5);

interface SessionState {
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}

const sessions = new Map<string, SessionState>();
const sessionTtlMs = Number(process.env.SESSION_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

const analysisConfigSchema = z.object({
  theme: z.enum(["Love", "Work", "Friendship", ""]).optional(),
  behaviorPatterns: z.array(z.string()).default([]),
  focus: z.array(z.string()).default([]),
  goal: z.string().default(""),
  helpMeToggles: z.array(z.string()).default([]),
  helpMeText: z.string().optional(),
});

const analysisRequestSchema = z.object({
  chatId: z.number().int(),
  mode: z.enum(["last300", "range", "selected"]),
  locale: z.enum(["ru", "en"]).default("ru"),
  selection: z
    .object({
      startTs: z.number().optional(),
      endTs: z.number().optional(),
      messageIds: z.array(z.number().int()).optional(),
    })
    .optional(),
  config: analysisConfigSchema,
});

const resumeSessionSchema = z.object({
  sessionId: z.string().min(8).max(128),
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openAiApiKey),
    openaiModel: openAiModel,
  });
});

app.post("/api/sessions", async (_req, res) => {
  try {
    const created = await tdlibClient.createSession();
    sessions.set(created.sessionId, {
      sessionId: created.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.status(201).json(created);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/resume", async (req, res) => {
  try {
    const payload = resumeSessionSchema.parse(req.body);
    const resumed = await tdlibClient.resumeSession(payload.sessionId);
    sessions.set(resumed.sessionId, {
      sessionId: resumed.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    res.json(resumed);
  } catch (error) {
    handleError(res, error);
  }
});

app.delete("/api/sessions/:sessionId", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSession(sessionId);
    await tdlibClient.destroySession(sessionId);
    sessions.delete(sessionId);
    rateLimiter.clear(sessionId);
    eventBridge.clearSession(sessionId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/clear", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    assertSession(sessionId);
    await tdlibClient.destroySession(sessionId);
    sessions.delete(sessionId);
    rateLimiter.clear(sessionId);
    eventBridge.clearSession(sessionId);
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/auth/phone", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const payload = z.object({ phoneNumber: z.string().min(6) }).parse(req.body);
    const response = await tdlibClient.submitPhone(sessionId, payload.phoneNumber);
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/auth/qr", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const response = await tdlibClient.startQrAuthentication(sessionId);
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/auth/code", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const payload = z.object({ code: z.string().min(3) }).parse(req.body);
    const response = await tdlibClient.submitCode(sessionId, payload.code);
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/auth/password", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const payload = z.object({ password: z.string().min(1) }).parse(req.body);
    const response = await tdlibClient.submitPassword(sessionId, payload.password);
    res.json(response);
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/sessions/:sessionId/chats", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const limit = Number(req.query.limit ?? 100);
    const listed = await tdlibClient.listChats(sessionId, limit);
    const privateChats = listed
      .filter((chat) => chat.isPrivate !== false)
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));

    const fallbackChats = listed.sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
    const chatsToReturn = privateChats.length > 0 ? privateChats : fallbackChats;
    res.json({ chats: chatsToReturn.slice(0, limit) });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/sessions/:sessionId/chats/:chatId/messages", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const chatId = Number(req.params.chatId);
    const limit = Number(req.query.limit ?? 100);
    const fromMessageId = req.query.fromMessageId ? Number(req.query.fromMessageId) : undefined;
    const messages = await tdlibClient.getChatHistory(sessionId, chatId, limit, fromMessageId);
    res.json({ messages });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/sessions/:sessionId/chats/:chatId/messages/range", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const chatId = Number(req.params.chatId);
    const startTs = Number(req.query.startTs);
    const endTs = Number(req.query.endTs);

    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
      throw new Error("startTs and endTs are required");
    }

    const messages = await tdlibClient.getChatHistoryByDate(sessionId, chatId, startTs, endTs);
    res.json({ messages });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/sessions/:sessionId/analysis", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    rateLimiter.assertWithinLimit(sessionId);

    const payload = analysisRequestSchema.parse(req.body);
    const messages = await resolveMessagesForAnalysis(
      tdlibClient,
      sessionId,
      payload.chatId,
      payload.mode,
      payload.selection,
    );

    if (messages.length === 0) {
      throw new Error("No text messages matched the selected mode.");
    }

    const analysis = await analyzer.analyze({
      mode: payload.mode,
      messages,
      config: payload.config as AnalysisConfig,
      locale: payload.locale as Locale,
    });

    res.json({
      analysis,
      mode: payload.mode,
      messageCount: messages.length,
    });
  } catch (error) {
    handleError(res, error);
  }
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket, req) => {
  const origin = req.headers.host ? `http://${req.headers.host}` : "http://localhost";
  const url = new URL(req.url ?? "", origin);
  const sessionId = url.searchParams.get("sessionId");

  if (!sessionId || !sessions.has(sessionId)) {
    socket.close(1008, "Unknown session");
    return;
  }

  eventBridge.addSubscriber(sessionId, socket);
  socket.send(
    JSON.stringify({
      type: "auth_state",
      sessionId,
      payload: {
        status: "ws_connected",
      },
      ts: Date.now(),
    }),
  );

  socket.on("close", () => {
    eventBridge.removeSubscriber(sessionId, socket);
  });
});

server.listen(apiPort, () => {
  console.log(`api service listening on :${apiPort}`);
  console.log(`openai configured: ${openAiApiKey ? "yes" : "no"} (model=${openAiModel})`);
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.updatedAt > sessionTtlMs) {
      sessions.delete(session.sessionId);
      rateLimiter.clear(session.sessionId);
      eventBridge.clearSession(session.sessionId);
      void tdlibClient.destroySession(session.sessionId).catch(() => undefined);
    }
  }
}, 60_000).unref();

async function resolveMessagesForAnalysis(
  client: TdlibClient,
  sessionId: string,
  chatId: number,
  mode: AnalysisMode,
  selection:
    | {
        startTs?: number;
        endTs?: number;
        messageIds?: number[];
      }
    | undefined,
): Promise<ChatMessage[]> {
  if (mode === "selected") {
    const ids = selection?.messageIds ?? [];
    if (ids.length === 0) {
      throw new Error("messageIds is required for selected mode");
    }
    return client.getMessagesByIds(sessionId, chatId, ids);
  }

  if (mode === "range") {
    const startTs = selection?.startTs;
    const endTs = selection?.endTs;
    if (!startTs || !endTs) {
      throw new Error("startTs and endTs are required for range mode");
    }
    return client.getChatHistoryByDate(sessionId, chatId, startTs, endTs);
  }

  return fetchLastMessages(client, sessionId, chatId, 300);
}

async function fetchLastMessages(
  client: TdlibClient,
  sessionId: string,
  chatId: number,
  totalLimit: number,
): Promise<ChatMessage[]> {
  let fromMessageId: number | undefined;
  let collected: ChatMessage[] = [];

  while (collected.length < totalLimit) {
    const remaining = totalLimit - collected.length;
    const batchSize = Math.min(100, remaining);
    const batch = await client.getChatHistory(sessionId, chatId, batchSize, fromMessageId);

    if (batch.length === 0) {
      break;
    }

    collected = [...batch, ...collected];
    fromMessageId = batch[0]?.id;

    if (!fromMessageId) {
      break;
    }
  }

  const deduped = new Map<number, ChatMessage>();
  for (const message of collected) {
    deduped.set(message.id, message);
  }

  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-totalLimit);
}

function assertSession(sessionId: string): void {
  if (!sessions.has(sessionId)) {
    throw new Error(`Unknown session ${sessionId}`);
  }
}

function touchSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown session ${sessionId}`);
  }
  session.updatedAt = Date.now();
}

function handleError(res: express.Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unexpected error";
  let status = 400;
  if (message.includes("Unknown session")) {
    status = 404;
  } else if (message.toLowerCase().includes("too many")) {
    status = 429;
  }

  res.status(status).json({ error: message });
}
