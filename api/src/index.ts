import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { TdlibEventBridge } from "./eventBridge.js";
import { PROMPT_STEP1, PROMPT_STEP2, PROMPT_STEP3 } from "./gaslightingPipeline.js";
import { OpenAiAnalyzer } from "./openaiAnalyzer.js";
import { PromptRepository } from "./promptRepository.js";
import { SessionRateLimiter } from "./rateLimiter.js";
import { SessionMetaRepository } from "./sessionMetaRepository.js";
import { TdlibClient } from "./tdlibClient.js";
import type { AnalysisConfig, AnalysisMode, ChatMessage, Locale, PromptStep, PromptThemeState } from "./types.js";

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
const isGcp = Boolean(process.env.GOOGLE_CLOUD_PROJECT);
const extensiveLogging = process.env.EXTENSIVE_LOGGING === "true";
const maxGroupMembers = Number(process.env.TDLIB_MAX_GROUP_MEMBERS ?? 20);
const tdlibBaseUrl = process.env.TDLIB_BASE_URL ?? "http://localhost:4002";
const tdlibRequestTimeoutMs = Number(process.env.TDLIB_REQUEST_TIMEOUT_MS ?? 60000);
const rangeTdlibRequestTimeoutMs = Number(process.env.TDLIB_RANGE_REQUEST_TIMEOUT_MS ?? 180000);
const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
const openAiModel = process.env.OPENAI_MODEL ?? "gpt-5.2";
const rangeScanMaxBatches = Number(process.env.RANGE_SCAN_MAX_BATCHES ?? 500);
const mongoUri = process.env.MONGODB_URI?.trim();
const mongoDbName = process.env.MONGODB_DB_NAME?.trim();
const mongoPromptCollection = process.env.MONGODB_PROMPTS_COLLECTION?.trim();
const mongoSessionMetaCollection = process.env.MONGODB_SESSION_META_COLLECTION?.trim();

const tdlibClient = new TdlibClient({ baseUrl: tdlibBaseUrl, requestTimeoutMs: tdlibRequestTimeoutMs });
const promptRepository = new PromptRepository({
  mongoUri,
  dbName: mongoDbName,
  collectionName: mongoPromptCollection,
});
const sessionMetaRepository = new SessionMetaRepository({
  mongoUri,
  dbName: mongoDbName,
  collectionName: mongoSessionMetaCollection,
});
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
let promptStorageStatus: "disabled" | "checking" | "ready" | "error" = promptRepository.isEnabled() ? "checking" : "disabled";
let promptStorageLastError: string | null = null;

const analysisConfigSchema = z.object({
  theme: z.enum(["Love", "Work", "Friendship", "Gaslighting", ""]).optional(),
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

const promptStepSchema = z.enum(["step1", "step2", "step3"]);
const createPromptVersionSchema = z.object({
  content: z.string().min(1),
});
const activatePromptVersionSchema = z.object({
  versionId: z.string().min(1),
});
const promptTestRequestSchema = z.object({
  step: promptStepSchema,
  prompt: z.string().min(1),
  locale: z.enum(["ru", "en"]).default("ru"),
  selection: z.object({
    startTs: z.number(),
    endTs: z.number(),
  }),
});

const connectContextSchema = z.object({
  ip: z.string().min(3).max(128).optional(),
  browserLocale: z.string().optional(),
  browserLanguages: z.array(z.string()).optional(),
  timeZone: z.string().optional(),
  screen: z
    .object({
      width: z.number().optional(),
      height: z.number().optional(),
      pixelRatio: z.number().optional(),
    })
    .optional(),
});

function defaultGaslightingPromptSet() {
  return {
    step1: PROMPT_STEP1,
    step2: PROMPT_STEP2,
    step3: PROMPT_STEP3,
  };
}

function buildDefaultPromptThemeState(): PromptThemeState {
  const defaults = defaultGaslightingPromptSet();
  const now = new Date().toISOString();
  return {
    theme: "gaslighting",
    steps: (["step1", "step2", "step3"] as const).map((step) => ({
      step,
      activeVersionId: `builtin-${step}`,
      versions: [
        {
          id: `builtin-${step}`,
          theme: "gaslighting",
          step,
          version: 1,
          content: defaults[step],
          isActive: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
    })),
  };
}

const colors = {
  reset: "\x1b[0m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

function colorizeStatus(statusCode: number): string {
  const value = String(statusCode);
  if (isGcp) {
    return value;
  }
  if (statusCode >= 500) {
    return `${colors.red}${value}${colors.reset}`;
  }
  if (statusCode >= 400) {
    return `${colors.yellow}${value}${colors.reset}`;
  }
  return `${colors.green}${value}${colors.reset}`;
}

function colorizeMethod(method: string): string {
  return isGcp ? method : `${colors.yellow}${method}${colors.reset}`;
}

function colorizeUrl(url: string): string {
  return isGcp ? url : `${colors.cyan}${url}${colors.reset}`;
}

function colorizeGray(value: string): string {
  return isGcp ? value : `${colors.gray}${value}${colors.reset}`;
}

function extractErrorMessage(payload: unknown): string {
  if (!payload) {
    return "";
  }
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as { error?: string; message?: string };
      return parsed.error ?? parsed.message ?? payload;
    } catch {
      return payload;
    }
  }
  if (Buffer.isBuffer(payload)) {
    return extractErrorMessage(payload.toString("utf8"));
  }
  if (typeof payload === "object") {
    const asRecord = payload as { error?: unknown; message?: unknown };
    if (typeof asRecord.error === "string" && asRecord.error.length > 0) {
      return asRecord.error;
    }
    if (typeof asRecord.message === "string" && asRecord.message.length > 0) {
      return asRecord.message;
    }
  }
  return "";
}

function normalizeResponseBody(payload: unknown): unknown {
  if (Buffer.isBuffer(payload)) {
    const asString = payload.toString("utf8");
    try {
      return JSON.parse(asString);
    } catch {
      return asString;
    }
  }
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

function makeRequestLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    let responsePayload: unknown;

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      responsePayload = body;
      return originalJson(body);
    }) as Response["json"];

    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (responsePayload === undefined) {
        responsePayload = body;
      }
      return originalSend(body as any);
    }) as Response["send"];

    res.on("finish", () => {
      if (req.method === "OPTIONS") {
        return;
      }

      const statusCode = res.statusCode;
      const responseTime = Date.now() - startedAt;
      const method = colorizeMethod(req.method);
      const url = colorizeUrl(req.originalUrl || req.url);
      const status = colorizeStatus(statusCode);
      const timeStr = colorizeGray(`(${responseTime}ms)`);
      const origin = (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined) ?? "";
      const originStr = origin ? ` ${colorizeGray(`← ${origin}`)}` : "";
      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
      const logger = level === "error" ? console.error : level === "warn" ? console.warn : console.info;

      if (!extensiveLogging) {
        if (statusCode >= 400) {
          const errorMessage = extractErrorMessage(responsePayload);
          const errorSuffix = errorMessage
            ? ` - ${isGcp ? errorMessage : `${colors.red}${errorMessage}${colors.reset}`}`
            : "";
          logger(`${method} ${url} -> ${status}${errorSuffix} ${timeStr}${originStr}`);
          return;
        }
        logger(`${method} ${url} -> ${status} ${timeStr}${originStr}`);
        return;
      }

      logger({
        msg: `${method} ${url} -> ${status} ${timeStr}${originStr}`,
        request: {
          headers: req.headers,
          body: req.body,
          query: req.query,
          params: req.params,
        },
        response: normalizeResponseBody(responsePayload),
      });
    });

    next();
  };
}

app.use(makeRequestLogger());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    openaiConfigured: Boolean(openAiApiKey),
    openaiModel: openAiModel,
    promptStorage: {
      enabled: promptRepository.isEnabled(),
      status: promptStorageStatus,
      lastError: promptStorageLastError,
    },
  });
});

app.post("/api/sessions", async (req, res) => {
  try {
    const created = await tdlibClient.createSession();
    sessions.set(created.sessionId, {
      sessionId: created.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    res.status(201).json(created);
  } catch (error) {
    handleError(req, res, error);
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
    handleError(req, res, error);
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
    handleError(req, res, error);
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
    handleError(req, res, error);
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
    handleError(req, res, error);
  }
});

app.post("/api/sessions/:sessionId/auth/qr", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const response = await tdlibClient.startQrAuthentication(sessionId);
    res.json(response);
  } catch (error) {
    handleError(req, res, error);
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
    handleError(req, res, error);
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
    handleError(req, res, error);
  }
});

app.post("/api/sessions/:sessionId/connect-context", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const payload = connectContextSchema.parse(req.body ?? {});

    if (!sessionMetaRepository.isEnabled()) {
      res.json({ ok: true, stored: false, reason: "mongo_disabled" });
      return;
    }

    const xForwardedFor = req.headers["x-forwarded-for"];
    const forwarded = Array.isArray(xForwardedFor) ? xForwardedFor[0] : xForwardedFor;
    const forwardedIp = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
    const realIpHeader = req.headers["x-real-ip"];
    const realIp = Array.isArray(realIpHeader) ? realIpHeader[0] : realIpHeader;
    const socketIp = req.socket.remoteAddress;
    const clientIp = forwardedIp || (typeof realIp === "string" ? realIp : undefined) || socketIp || undefined;

    try {
      await sessionMetaRepository.saveConnectContext({
        sessionId,
        ip: payload.ip || clientIp,
        userAgent: req.headers["user-agent"] as string | undefined,
        browserLocale: payload.browserLocale,
        browserLanguages: payload.browserLanguages,
        timeZone: payload.timeZone,
        screen: payload.screen,
      });
      res.json({ ok: true, stored: true });
    } catch (storageError) {
      console.warn("connect-context storage failed:", storageError instanceof Error ? storageError.message : storageError);
      res.json({ ok: true, stored: false, reason: "storage_failed" });
    }
  } catch (error) {
    handleError(req, res, error);
  }
});

app.get("/api/sessions/:sessionId/chats", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const limit = Number(req.query.limit ?? 100);
    const listed = await tdlibClient.listChats(sessionId, limit);
    const allowedChats = listed
      .filter((chat) => {
        if (chat.chatKind === "private") {
          return true;
        }
        if (chat.chatKind !== "group") {
          return false;
        }
        return typeof chat.memberCount === "number" && Number.isFinite(chat.memberCount) && chat.memberCount < maxGroupMembers;
      })
      .sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));

    res.json({ chats: allowedChats.slice(0, limit) });
  } catch (error) {
    handleError(req, res, error);
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
    handleError(req, res, error);
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
    if (endTs < startTs) {
      throw new Error("endTs must be greater than or equal to startTs");
    }

    const messages = await fetchMessagesByDateRange(
      tdlibClient,
      sessionId,
      chatId,
      startTs,
      endTs,
      rangeScanMaxBatches,
    );
    res.json({ messages });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.get("/api/sessions/:sessionId/chats/:chatId/messages/range/export.txt", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const chatId = Number(req.params.chatId);
    const startTs = Number(req.query.startTs);
    const endTs = Number(req.query.endTs);

    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) {
      throw new Error("startTs and endTs are required");
    }
    if (endTs < startTs) {
      throw new Error("endTs must be greater than or equal to startTs");
    }

    const rangeMessages = await fetchMessagesByDateRange(
      tdlibClient,
      sessionId,
      chatId,
      startTs,
      endTs,
      rangeScanMaxBatches,
    );
    const sorted = [...rangeMessages].sort((a, b) => a.timestamp - b.timestamp);
    if (sorted.length === 0) {
      throw new Error("No messages found in selected date range");
    }
    const messageById = new Map<number, ChatMessage>(sorted.map((item) => [item.id, item] as const));

    const missingReplyIds = [
      ...new Set(
        sorted
          .map((item) => item.replyToMessageId)
          .filter((value): value is number => typeof value === "number" && !messageById.has(value)),
      ),
    ];

    if (missingReplyIds.length > 0) {
      const replyMessages = await tdlibClient.getMessagesByIds(
        sessionId,
        chatId,
        missingReplyIds,
        rangeTdlibRequestTimeoutMs,
      );
      for (const item of replyMessages) {
        messageById.set(item.id, item);
      }
    }

    const transcript = sorted.map((item) => formatExportLine(item, messageById)).join("\n");

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="chat-${chatId}-${startTs}-${endTs}.txt"`);
    res.send(transcript);
  } catch (error) {
    handleError(req, res, error);
  }
});

app.get("/api/prompts/gaslighting", async (_req, res) => {
  try {
    const state = await promptRepository.getGaslightingThemeState(defaultGaslightingPromptSet());
    res.json(state);
  } catch (error) {
    const errorName =
      typeof error === "object" && error !== null && "name" in error
        ? String((error as { name?: unknown }).name ?? "")
        : "";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isMongoConnectivityIssue =
      errorName.toLowerCase().includes("mongo") ||
      errorMessage.toLowerCase().includes("ssl routines") ||
      errorMessage.toLowerCase().includes("tls");

    if (isMongoConnectivityIssue) {
      console.warn("Prompt storage unavailable, serving built-in prompts:", errorMessage);
      res.json(buildDefaultPromptThemeState());
      return;
    }
    handleError(_req, res, error);
  }
});

app.post("/api/prompts/gaslighting/:step/versions", async (req, res) => {
  try {
    const step = promptStepSchema.parse(req.params.step) as PromptStep;
    const payload = createPromptVersionSchema.parse(req.body);
    const version = await promptRepository.createGaslightingVersion(
      step,
      payload.content,
      defaultGaslightingPromptSet(),
    );
    res.status(201).json({ version });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.post("/api/prompts/gaslighting/:step/activate", async (req, res) => {
  try {
    const step = promptStepSchema.parse(req.params.step) as PromptStep;
    const payload = activatePromptVersionSchema.parse(req.body);
    await promptRepository.activateGaslightingVersion(
      step,
      payload.versionId,
      defaultGaslightingPromptSet(),
    );
    res.json({ ok: true });
  } catch (error) {
    handleError(req, res, error);
  }
});

app.post("/api/sessions/:sessionId/chats/:chatId/prompts/gaslighting/test", async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    touchSession(sessionId);
    const chatId = Number(req.params.chatId);
    const payload = promptTestRequestSchema.parse(req.body);

    if (payload.selection.endTs < payload.selection.startTs) {
      throw new Error("endTs must be greater than or equal to startTs");
    }

    const messages = await fetchMessagesByDateRange(
      tdlibClient,
      sessionId,
      chatId,
      payload.selection.startTs,
      payload.selection.endTs,
      rangeScanMaxBatches,
    );

    if (messages.length === 0) {
      throw new Error("No messages found in selected date range");
    }

    const result = await analyzer.runPromptLabDirectTest({
      step: payload.step,
      prompt: payload.prompt,
      messages,
      locale: payload.locale as Locale,
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("Prompt test returned invalid result shape");
    }

    res.json({
      answer: result.answer,
    });
  } catch (error) {
    handleError(req, res, error);
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
    handleError(req, res, error);
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
  console.log(`request logging: ${extensiveLogging ? "EXTENSIVE" : "BASIC"}${isGcp ? " (gcp mode)" : ""}`);
  void warmupPromptStorageOnStartup();
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

async function warmupPromptStorageOnStartup(): Promise<void> {
  if (!promptRepository.isEnabled()) {
    promptStorageStatus = "disabled";
    promptStorageLastError = null;
    console.log("prompt storage: disabled (MONGODB_URI is not set)");
    return;
  }

  promptStorageStatus = "checking";
  promptStorageLastError = null;
  try {
    await promptRepository.getGaslightingThemeState(defaultGaslightingPromptSet());
    promptStorageStatus = "ready";
    console.log("prompt storage: ready (MongoDB connected)");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    promptStorageStatus = "error";
    promptStorageLastError = message;
    console.warn(`prompt storage: startup check failed (${message})`);
  }
}

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
    return fetchMessagesByDateRange(client, sessionId, chatId, startTs, endTs, rangeScanMaxBatches);
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

function handleError(req: Request, res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const errorName =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  let status = 400;
  if (message.includes("Unknown session")) {
    status = 404;
  } else if (message.toLowerCase().includes("too many")) {
    status = 429;
  } else if (errorName.toLowerCase().includes("mongo")) {
    status = 503;
  } else if (message.toLowerCase().includes("mongodb")) {
    status = 503;
  }

  const stack = error instanceof Error ? error.stack : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : undefined;
  const logLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const logger = logLevel === "error" ? console.error : logLevel === "warn" ? console.warn : console.info;
  logger({
    msg: `${req.method} ${req.originalUrl || req.url} -> ${status} ERROR`,
    error: {
      message,
      stack,
      statusCode: status,
      code,
    },
    request: {
      headers: req.headers,
      body: req.body,
      query: req.query,
      params: req.params,
    },
  });

  res.status(status).json({ error: message });
}

async function fetchMessagesByDateRange(
  client: TdlibClient,
  sessionId: string,
  chatId: number,
  startTs: number,
  endTs: number,
  maxBatches: number,
): Promise<ChatMessage[]> {
  const safeMaxBatches =
    Number.isFinite(maxBatches) && maxBatches > 0 ? Math.floor(maxBatches) : 500;

  const anchorMessage = await client.getChatMessageByDate(
    sessionId,
    chatId,
    endTs,
    rangeTdlibRequestTimeoutMs,
  );
  if (!anchorMessage || !Number.isFinite(anchorMessage.id) || anchorMessage.id <= 0) {
    return [];
  }
  if (anchorMessage.timestamp < startTs) {
    return [];
  }

  let fromMessageId: number | undefined = anchorMessage.id;
  const inRange: ChatMessage[] = [];

  for (let batchIndex = 0; batchIndex < safeMaxBatches; batchIndex += 1) {
    const currentCursor = fromMessageId;
    const batch = await client.getChatHistory(
      sessionId,
      chatId,
      100,
      currentCursor,
      rangeTdlibRequestTimeoutMs,
    );
    if (batch.length === 0) {
      break;
    }

    for (const item of batch) {
      if (item.timestamp >= startTs && item.timestamp <= endTs) {
        inRange.push(item);
      }
    }

    const oldest = batch[0];
    const oldestId = oldest?.id;
    const oldestTs = oldest?.timestamp ?? 0;
    if (!oldestId) {
      break;
    }
    if (oldestTs < startTs) {
      break;
    }
    if (currentCursor && oldestId >= currentCursor) {
      break;
    }

    fromMessageId = oldestId;
  }

  const deduped = new Map<number, ChatMessage>();
  for (const item of inRange) {
    deduped.set(item.id, item);
  }

  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function formatExportLine(message: ChatMessage, messageById: Map<number, ChatMessage>): string {
  const parts = [
    `msg_id=${message.id}`,
    `${mapSenderLabel(message.senderLabel)}: ${sanitizeTranscriptText(message.text)} (${formatTranscriptTimestamp(message.timestamp)})`,
  ];

  if (typeof message.replyToMessageId === "number") {
    const replied = messageById.get(message.replyToMessageId);
    const replySpeaker = replied ? mapSenderLabel(replied.senderLabel) : "unknown";
    const replyText = replied ? sanitizeTranscriptText(replied.text) : "unavailable";
    parts.push(`reply_to=${message.replyToMessageId} (${replySpeaker}) -> ${replyText}`);
  }

  return parts.join(" | ");
}

function mapSenderLabel(label: ChatMessage["senderLabel"]): "self" | "partner" {
  return label === "Me" ? "self" : "partner";
}

function sanitizeTranscriptText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\|/g, "¦");
}

function formatTranscriptTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const sec = String(date.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`;
}
