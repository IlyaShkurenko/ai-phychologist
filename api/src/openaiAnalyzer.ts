import OpenAI from "openai";
import { z } from "zod";

import type { AnalysisConfig, AnalysisMode, AnalysisResponse, ChatMessage, Locale } from "./types.js";

const analysisResultSchema = z.object({
  summary: z.string(),
  keySignals: z.object({
    redFlags: z.array(z.string()),
    greenFlags: z.array(z.string()),
    patterns: z.array(z.string()),
  }),
  suggestedReplies: z.array(z.string()).min(1).max(3),
  outcomes: z.object({
    ifReply: z.string(),
    ifNoReply: z.string(),
  }),
});

const analysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "keySignals", "suggestedReplies", "outcomes"],
  properties: {
    summary: { type: "string" },
    keySignals: {
      type: "object",
      additionalProperties: false,
      required: ["redFlags", "greenFlags", "patterns"],
      properties: {
        redFlags: {
          type: "array",
          items: { type: "string" },
        },
        greenFlags: {
          type: "array",
          items: { type: "string" },
        },
        patterns: {
          type: "array",
          items: { type: "string" },
        },
      },
    },
    suggestedReplies: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string" },
    },
    outcomes: {
      type: "object",
      additionalProperties: false,
      required: ["ifReply", "ifNoReply"],
      properties: {
        ifReply: { type: "string" },
        ifNoReply: { type: "string" },
      },
    },
  },
} as const;

type AnalysisResultShape = z.infer<typeof analysisResultSchema>;
type JsonRecord = Record<string, unknown>;
type FallbackReason = "missing_key" | "invalid_response" | "openai_error";

interface AnalyzeArgs {
  mode: AnalysisMode;
  config: AnalysisConfig;
  messages: ChatMessage[];
  locale: Locale;
}

export class OpenAiAnalyzer {
  private readonly client?: OpenAI;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
  ) {
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    }
  }

  async analyze(args: AnalyzeArgs): Promise<AnalysisResponse> {
    if (!this.client) {
      const fallback = this.fallbackAnalysis(args, "missing_key");
      return {
        mode: args.mode,
        messageCount: args.messages.length,
        ...fallback,
      };
    }

    const parsed = await this.callOpenAiWithRetry(args);
    return {
      mode: args.mode,
      messageCount: args.messages.length,
      ...parsed,
    };
  }

  private async callOpenAiWithRetry(args: AnalyzeArgs): Promise<AnalysisResultShape> {
    const maxAttempts = 3;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.callOpenAi(args);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await sleep(attempt * 500);
        }
      }
    }

    void lastError;
    return this.fallbackAnalysis(args, "openai_error");
  }

  private async callOpenAi(args: AnalyzeArgs): Promise<AnalysisResultShape> {
    const completion = await this.client!.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "dialog_behavior_analysis",
          strict: true,
          schema: analysisJsonSchema,
        },
      } as never,
      messages: [
        {
          role: "system",
          content:
            "You are a dialog behavior analyst. Analyze ONLY provided selected messages. " +
            "Always respond in the user's selected language. " +
            "Return ONLY valid JSON that matches the schema exactly. No markdown, no extra text.",
        },
        {
          role: "user",
          content: this.buildUserPrompt(args),
        },
      ],
    });

    const text = completion.choices[0]?.message?.content?.trim();
    if (!text) {
      throw new Error("OpenAI returned empty response");
    }

    const parsed = this.parseModelResponse(text, args);
    if (parsed) {
      return parsed;
    }

    console.warn("OpenAI response could not be parsed into analysis schema");
    return this.fallbackAnalysis(args, "invalid_response");
  }

  private parseModelResponse(rawText: string, args: AnalyzeArgs): AnalysisResultShape | null {
    const candidates: unknown[] = [];

    const direct = safeJsonParse(rawText);
    if (direct !== null) {
      candidates.push(direct);
    }

    const extracted = extractFirstJsonObject(rawText);
    if (extracted) {
      const parsedExtracted = safeJsonParse(extracted);
      if (parsedExtracted !== null) {
        candidates.push(parsedExtracted);
      }
    }

    for (const candidate of candidates) {
      const strict = analysisResultSchema.safeParse(candidate);
      if (strict.success) {
        return strict.data;
      }

      const normalized = this.normalizeLooseResponse(candidate, args);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeLooseResponse(raw: unknown, args: AnalyzeArgs): AnalysisResultShape | null {
    const root = toRecord(raw);
    if (!root) {
      return null;
    }

    const keySignals = toRecord(root.keySignals);
    const flags = toRecord(root.flags);
    const outcomes = toRecord(root.outcomes) ?? toRecord(root.outcome);

    const summary =
      toText(root.summary) ??
      toText(root.overview) ??
      toText(root.analysis) ??
      toText(root.findings) ??
      toText(root.result);

    if (!summary) {
      return null;
    }

    const fallback = this.fallbackAnalysis(args, "openai_error");

    const redFlags =
      toTextArray(keySignals?.redFlags) || toTextArray(flags?.redFlags) || toTextArray(flags?.red) || [];
    const greenFlags =
      toTextArray(keySignals?.greenFlags) || toTextArray(flags?.greenFlags) || toTextArray(flags?.green) || [];
    const patterns = toTextArray(keySignals?.patterns) || toTextArray(root.patterns) || [];

    const suggestedRepliesRaw =
      toTextArray(root.suggestedReplies) ||
      toTextArray(root.suggestions) ||
      toTextArray(root.replies) ||
      toTextArray(root.replyOptions) ||
      toTextArray(root.nextReplies) ||
      [];
    const suggestedReplies = suggestedRepliesRaw.slice(0, 3);

    const ifReply =
      toText(outcomes?.ifReply) ??
      toText(outcomes?.if_reply) ??
      toText(root.ifReply) ??
      toText(root.if_reply) ??
      fallback.outcomes.ifReply;

    const ifNoReply =
      toText(outcomes?.ifNoReply) ??
      toText(outcomes?.if_no_reply) ??
      toText(root.ifNoReply) ??
      toText(root.if_no_reply) ??
      fallback.outcomes.ifNoReply;

    const normalized: AnalysisResultShape = {
      summary,
      keySignals: {
        redFlags: redFlags.length > 0 ? redFlags : fallback.keySignals.redFlags,
        greenFlags: greenFlags.length > 0 ? greenFlags : fallback.keySignals.greenFlags,
        patterns: patterns.length > 0 ? patterns : fallback.keySignals.patterns,
      },
      suggestedReplies: suggestedReplies.length > 0 ? suggestedReplies : fallback.suggestedReplies,
      outcomes: {
        ifReply,
        ifNoReply,
      },
    };

    const parsed = analysisResultSchema.safeParse(normalized);
    return parsed.success ? parsed.data : null;
  }

  private buildUserPrompt(args: AnalyzeArgs): string {
    return JSON.stringify(
      {
        instruction: [
          "Analyze only these selected messages.",
          "Keep response concise and practical.",
          "Include 1-3 suggested reply options.",
          "Respect configuration fields if present.",
          `Answer language must be: ${args.locale === "ru" ? "Russian" : "English"}.`,
        ],
        locale: args.locale,
        config: this.localizeConfig(args.config, args.locale),
        selectedMessages: args.messages.map((message) => ({
          id: message.id,
          senderLabel: message.senderLabel,
          text: message.text,
          timestamp: new Date(message.timestamp).toISOString(),
        })),
      },
      null,
      2,
    );
  }

  private fallbackAnalysis(args: AnalyzeArgs, reason: FallbackReason): AnalysisResultShape {
    const texts = args.messages.map((message) => message.text.toLowerCase());
    const redFlags: string[] = [];
    const greenFlags: string[] = [];
    const isRu = args.locale === "ru";

    if (texts.some((text) => text.includes("never") || text.includes("always"))) {
      redFlags.push(isRu ? "Категоричные формулировки могут усиливать напряжение." : "Absolute language may escalate tension.");
    }
    if (texts.some((text) => text.includes("ignore") || text.includes("fine."))) {
      redFlags.push(isRu ? "Возможны сигналы избегания или ухода из контакта." : "Possible withdrawal/avoidance signals.");
    }
    if (texts.some((text) => text.includes("thanks") || text.includes("appreciate"))) {
      greenFlags.push(isRu ? "Есть признаки благодарности в диалоге." : "Presence of appreciation language.");
    }
    if (texts.some((text) => text.includes("can we") || text.includes("let's"))) {
      greenFlags.push(
        isRu ? "В диалоге есть кооперативная формулировка." : "Collaborative framing appears in the dialog.",
      );
    }

    const goal =
      args.config.goal || (isRu ? "прояснить намерение и сохранить конструктивный тон" : "clarify intent and keep tone constructive");

    const summaryByReason: Record<FallbackReason, string> = {
      missing_key: isRu
        ? `AI-анализ недоступен: OpenAI ключ не настроен. Базовый разбор построен по ${args.messages.length} сообщениям, цель — ${goal}.`
        : `AI analysis is unavailable because OpenAI API key is not configured. Basic analysis was generated from ${args.messages.length} messages with goal to ${goal}.`,
      invalid_response: isRu
        ? `Структурированный ответ модели временно недоступен. Ниже базовый разбор по ${args.messages.length} выбранным сообщениям; цель — ${goal}.`
        : `Structured model output is temporarily unavailable. Showing basic analysis for ${args.messages.length} selected messages with goal to ${goal}.`,
      openai_error: isRu
        ? `Не удалось получить ответ модели. Ниже базовый разбор по ${args.messages.length} выбранным сообщениям; цель — ${goal}.`
        : `Failed to get model response. Showing basic analysis for ${args.messages.length} selected messages with goal to ${goal}.`,
    };

    return {
      summary: summaryByReason[reason],
      keySignals: {
        redFlags: redFlags.length
          ? redFlags
          : [
              isRu
                ? "Явные высокорисковые паттерны в выбранном тексте не обнаружены."
                : "No obvious high-risk pattern detected in selected text only.",
            ],
        greenFlags: greenFlags.length
          ? greenFlags
          : [
              isRu
                ? "Явные позитивные опоры не обнаружены; лучше уточнить позицию прямо."
                : "No clear positive anchors detected; ask for clarity directly.",
            ],
        patterns: args.config.behaviorPatterns.length
          ? args.config.behaviorPatterns.map((item) => localizeBehaviorPattern(item, args.locale))
          : [isRu ? "Паттерны поведения не выбраны" : "No behavior patterns selected"],
      },
      suggestedReplies: isRu
        ? [
            "Хочу сохранить конструктив. Можем уточнить, что ты имел(а) в виду?",
            "Я тебя услышал(а). Моя цель — решить это без эскалации.",
            "Давай сделаем паузу и вернемся с одним конкретным следующим шагом каждый.",
          ]
        : [
            "I want to keep this constructive. Can we clarify what you meant?",
            "I hear you. My goal is to solve this without escalation.",
            "Let’s pause and return with one concrete next step each.",
          ],
      outcomes: {
        ifReply: isRu
          ? "Спокойный и прямой ответ может снизить неопределенность и деэскалировать конфликт."
          : "A calm, explicit response may reduce ambiguity and de-escalate.",
        ifNoReply: isRu
          ? "Молчание может снизить краткосрочный конфликт, но увеличить неопределенность."
          : "Silence may reduce short-term conflict but can increase uncertainty.",
      },
    };
  }

  private localizeConfig(config: AnalysisConfig, locale: Locale): AnalysisConfig {
    return {
      ...config,
      behaviorPatterns: config.behaviorPatterns.map((item) => localizeBehaviorPattern(item, locale)),
      focus: config.focus.map((item) => localizeFocus(item, locale)),
      helpMeToggles: config.helpMeToggles.map((item) => localizeHelpMe(item, locale)),
    };
  }
}

function localizeBehaviorPattern(value: string, locale: Locale): string {
  const ruMap: Record<string, string> = {
    push_pull_dynamic: "Сближение и отдаление",
    boundary_testing: "Проверка границ",
    passive_aggression: "Пассивная агрессия",
    defensiveness: "Защитная реакция",
    consistent_support: "Стабильная поддержка",
  };
  const enMap: Record<string, string> = {
    push_pull_dynamic: "Push-pull dynamic",
    boundary_testing: "Boundary testing",
    passive_aggression: "Passive aggression",
    defensiveness: "Defensiveness",
    consistent_support: "Consistent support",
  };
  const map = locale === "ru" ? ruMap : enMap;
  return map[value] ?? value;
}

function localizeFocus(value: string, locale: Locale): string {
  const ruMap: Record<string, string> = {
    manipulations: "Манипуляции",
    aggression: "Агрессия",
    abuse: "Абьюз",
    ignore: "Игнор",
  };
  const enMap: Record<string, string> = {
    manipulations: "Manipulations",
    aggression: "Aggression",
    abuse: "Abuse",
    ignore: "Ignore",
  };
  const map = locale === "ru" ? ruMap : enMap;
  return map[value] ?? value;
}

function localizeHelpMe(value: string, locale: Locale): string {
  const ruMap: Record<string, string> = {
    warn_spam: "Предупреди, если я спамлю",
    suggest_pause: "Подскажи сделать паузу",
    suggest_confident_tone: "Подскажи более уверенный тон",
  };
  const enMap: Record<string, string> = {
    warn_spam: "Warn me when I spam",
    suggest_pause: "Suggest pause",
    suggest_confident_tone: "Suggest more confident tone",
  };
  const map = locale === "ru" ? ruMap : enMap;
  return map[value] ?? value;
}

function toRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function toText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function toTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const result = value
    .map((item) => toText(item))
    .filter((item): item is string => Boolean(item));

  return result.length > 0 ? result : null;
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
