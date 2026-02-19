import OpenAI from "openai";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import type {
  ChatMessage,
  GaslightingAggregates,
  GaslightingAnchor,
  GaslightingEpisode,
  GaslightingResult,
  GaslightingStep2,
  GaslightingVerification,
  Locale,
} from "./types.js";

export const PROMPT_STEP1 = `Ты — модуль структурного анализа переписки в отношениях.

Вход: Markdown-блоки:
- language
- instruction
- line_format
- transcript (код-блок со строками сообщений)

Задача:
Найти Anchor Events в сообщениях участника согласно instruction.
Контекст темы: детекция газлайтинга. Поэтому извлекай только такие факты, которые подходят для дальнейшей проверки
«отрицание факта + атака на восприятие / уход от проверки».

Anchor Event = утверждение автора сообщения о конкретном наблюдаемом действии/бездействии второго участника,
которое потенциально проверяемо по переписке/памяти/логам.
Важно: Anchor Event может быть выражен НЕ ТОЛЬКО утверждением, но и вопросом, который содержит утверждение факта.
Пример вопроса с фактом: "Почему ты вчера не ответил?" (факт: "ты вчера не ответил")

НЕ является Anchor Event:
- эмоции без факта ("мне больно", "я переживаю")
- оценки/ярлыки ("ты холодный", "ты грубый")
- интерпретации мотива ("тебе всё равно", "ты специально")
- обобщения без конкретики ("ты всегда/никогда")
- гипотезы ("наверное ты был с ней")
- двусмысленный факт, который нельзя восстановить однозначно
- высказывания только о состоянии/решении автора ("я не поведусь", "я не буду это обсуждать")
- комментарии недоверия без проверяемого события ("ага, так я и поверил")
- абстрактные рассуждения без конкретного события ("твои истории отпечатываются")

Критерий строгости:
- В fact_span должен быть проверяемый claim о действии/бездействии второго участника.
- Если проверяемого события нет — не возвращай якорь.
- Лучше пропустить сомнительный случай, чем добавить ложный anchor.

Если в одном сообщении несколько независимых фактов — извлеки ВСЕ.
fact_span всегда должен быть ТОЧНОЙ цитатой из сообщения автора (не перефразируй).
"msg_id" в ответе должен совпадать с "msg_id" из строки transcript.

action_type выбери строго из списка:
- said_phrase
- promise
- changed_agreement
- no_reply
- online_activity
- third_party_contact
- meeting_change
- disappearance
- other_fact

Вывод: строго JSON, без текста вне JSON.
{
  "anchors":[
    {
      "msg_id":"...",
      "fact_span":"...",
      "anchor_event":"...",
      "action_type":"...",
      "confidence":0.0
    }
  ]
}
Если якорей нет: {"anchors":[]}

Примеры (ориентиры):

1) "Мне больно, что ты вчера не ответил 6 часов."
→ Anchor: fact_span="ты вчера не ответил 6 часов", action_type=no_reply

2) "Почему ты был онлайн в 23:15 и молчал?"
→ Anchors:
- fact_span="ты был онлайн в 23:15", action_type=online_activity
- fact_span="и молчал", action_type=no_reply

3) "Ты холодный и тебе всё равно."
→ anchors=[]

4) "Ты обещал позвонить после работы и не позвонил."
→ Anchors:
- fact_span="Ты обещал позвонить после работы", action_type=promise
- fact_span="и не позвонил", action_type=no_reply

5) "Наверное ты специально игноришь меня."
→ anchors=[]

6) "Ты опять общался с ней."
(если неясно, кто "она", и нет контекста/проверяемости в этом сообщении) → пропусти как двусмысленное.

7) "В этот раз я на это не поведусь."
→ anchors=[]

8) "Ага, так я и поверил."
→ anchors=[]

9) "Я теперь вообще эти темы поднимать не буду."
→ anchors=[]
`;

export const PROMPT_STEP2 = `Ты — модуль анализа реакции партнёра на конкретный якорный факт.

Тебе дано:
1) anchor_line (одна строка якорного сообщения)
2) following_transcript (следующие 15 строк диалога после якоря, оба участника)
3) anchor_meta
Формат строк: msg_id=<id> | <speaker>: <text> (<ts>) | reply_to=<id> -> <reply_text>

Ты не ставишь диагнозы и не оцениваешь правоту сторон.
Проверяешь только структуру реакции на факт.

Fact Denial = уверенное отрицание события.
Perception Attack = перенос расхождения на дефект восприятия автора якоря.
Reality Avoidance = уход от проверки факта (смена темы, отказ обсуждать факт, уход в обвинения).

Normal engagement:
- признает/уточняет/объясняет факт
- частично соглашается
- извиняется

Non-engagement:
- не отвечает по существу факта
- уводит в общие фразы или атаки

Верни строго JSON.`;

export const PROMPT_STEP3 = `Ты — модуль верификации якорного факта по контексту переписки ДО эпизода.

Тебе дано:
1) anchors (массив якорей для верификации)
2) full_transcript (вся доступная переписка в хронологическом порядке)
Формат строк: msg_id=<id> | <speaker>: <text> (<ts>) | reply_to=<id> -> <reply_text>

Задача: для КАЖДОГО anchor_msg_id оценить, есть ли в full_transcript подтверждение или опровержение якорного факта.

Вердикт:
- supported: есть сообщения, поддерживающие факт
- contradicted: есть сообщения, прямо противоречащие факту
- not_found: проверяемых подтверждений/опровержений не найдено

В evidence добавляй только релевантные сообщения с msg_id и коротким reason.
Верни результат массивом по всем anchors.

Верни строго JSON.`;

type Speaker = "self" | "partner";
type AnchorSourceMode = "partner_only" | "both";

type Step1ActionType =
  | "said_phrase"
  | "promise"
  | "changed_agreement"
  | "no_reply"
  | "online_activity"
  | "third_party_contact"
  | "meeting_change"
  | "disappearance"
  | "other_fact";

interface PipelineMessage {
  msg_id: string;
  speaker: Speaker;
  ts: string;
  text: string;
  replyToMessageId?: string;
  replyToText?: string;
  replyToSpeaker?: Speaker;
  index: number;
  timestampMs?: number;
}

const step1AnchorSchema = z.object({
  msg_id: z.string().min(1),
  fact_span: z.string().min(1),
  anchor_event: z.string().min(1),
  action_type: z.enum([
    "said_phrase",
    "promise",
    "changed_agreement",
    "no_reply",
    "online_activity",
    "third_party_contact",
    "meeting_change",
    "disappearance",
    "other_fact",
  ]),
  confidence: z.number().min(0).max(1).default(0.6),
});

const step1ResponseSchema = z.object({
  anchors: z.array(step1AnchorSchema),
});

const step2ResponseSchema = z.object({
  reaction_type: z.enum([
    "normal_engagement",
    "non_engagement",
    "fact_denial_only",
    "perception_attack_only",
    "reality_avoidance_only",
    "mixed",
  ]),
  normal_engagement: z.boolean(),
  non_engagement: z.boolean(),
  fact_denial: z.boolean(),
  perception_attack: z.boolean(),
  reality_avoidance: z.boolean(),
  notes: z.string(),
});

const step3EvidenceSchema = z.object({
  msg_id: z.string().min(1),
  text: z.string().min(1),
  reason: z.string().min(1),
});

const step3ItemSchema = z.object({
  anchor_msg_id: z.string().min(1),
  verdict: z.enum(["supported", "contradicted", "not_found"]),
  evidence: z.array(step3EvidenceSchema).max(8),
  notes: z.string(),
});

const step3ResponseSchema = z.object({
  verifications: z.array(step3ItemSchema),
});

const STEP1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["anchors"],
  properties: {
    anchors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["msg_id", "fact_span", "anchor_event", "action_type", "confidence"],
        properties: {
          msg_id: { type: "string" },
          fact_span: { type: "string" },
          anchor_event: { type: "string" },
          action_type: {
            type: "string",
            enum: [
              "said_phrase",
              "promise",
              "changed_agreement",
              "no_reply",
              "online_activity",
              "third_party_contact",
              "meeting_change",
              "disappearance",
              "other_fact",
            ],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
} as const;

const STEP2_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "reaction_type",
    "normal_engagement",
    "non_engagement",
    "fact_denial",
    "perception_attack",
    "reality_avoidance",
    "notes",
  ],
  properties: {
    reaction_type: {
      type: "string",
      enum: [
        "normal_engagement",
        "non_engagement",
        "fact_denial_only",
        "perception_attack_only",
        "reality_avoidance_only",
        "mixed",
      ],
    },
    normal_engagement: { type: "boolean" },
    non_engagement: { type: "boolean" },
    fact_denial: { type: "boolean" },
    perception_attack: { type: "boolean" },
    reality_avoidance: { type: "boolean" },
    notes: { type: "string" },
  },
} as const;

const STEP3_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verifications"],
  properties: {
    verifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["anchor_msg_id", "verdict", "evidence", "notes"],
        properties: {
          anchor_msg_id: { type: "string" },
          verdict: {
            type: "string",
            enum: ["supported", "contradicted", "not_found"],
          },
          evidence: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["msg_id", "text", "reason"],
              properties: {
                msg_id: { type: "string" },
                text: { type: "string" },
                reason: { type: "string" },
              },
            },
            maxItems: 8,
          },
          notes: { type: "string" },
        },
      },
    },
  },
} as const;
const CHUNK_SPLIT_THRESHOLD = 300;
const CHUNK_SIZE = 220;
const CHUNK_OVERLAP = 40;
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const API_ROOT_DIR = resolve(CURRENT_DIR, "..");
const STEP2_DEBUG_DIR = join(API_ROOT_DIR, "debug", "gaslighting");
const STEP3_REASONING_MODEL = process.env.OPENAI_STEP3_MODEL ?? "gpt-5.2";
let llmLogSequence = 0;

export class GaslightingPipeline {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async run(
    messages: ChatMessage[],
    locale: Locale,
    options?: {
      anchorSource?: AnchorSourceMode;
    },
  ): Promise<GaslightingResult> {
    const anchorSource: AnchorSourceMode = options?.anchorSource ?? "partner_only";
    const conversation = this.toConversation(messages);
    writeJsonDebug("conversation.json", {
      conversation,
    });
    const anchors = await this.detectAnchors(conversation, locale, anchorSource);

    mkdirSync(STEP2_DEBUG_DIR, { recursive: true });
    writeJsonDebug("anchors.json", {
      anchor_source: anchorSource,
      count: anchors.length,
      anchors,
    });

    const results = await Promise.all(
      anchors.map(async (anchor, index) => {
        const stepIndex = index + 1;
        const anchorMessage = conversation.find((item) => item.msg_id === anchor.msg_id);
        if (!anchorMessage) {
          writeStep2Debug(stepIndex, {
            status: "anchor_not_found",
            step_index: stepIndex,
            anchor,
          });
          return null;
        }

        const followingMessages = collectFollowingMessages(conversation, anchorMessage.index, 15);
        const anchorLine = formatTranscriptLine(anchorMessage);
        const step2 =
          followingMessages.length > 0
            ? await this.classifyStep2(anchorLine, anchor, followingMessages, locale)
            : this.emptyStep2(locale);

        const gaslighting = step2.fact_denial && (step2.perception_attack || step2.reality_avoidance);

        writeStep2Debug(stepIndex, {
          status: "ok",
          step_index: stepIndex,
          anchor_msg_id: anchor.msg_id,
          anchor_ts: anchorMessage.ts,
          anchor_speaker: anchor.speaker,
          following_message_count: followingMessages.length,
          gaslighting,
          step2,
        });

        const episode: GaslightingEpisode = {
          anchor,
          partner_replies: followingMessages.map((item) => ({
            msg_id: item.msg_id,
            speaker: item.speaker,
            text: item.text,
            ts: item.ts,
          })),
          step2,
          gaslighting,
        };

        return { episode, stepIndex, anchorMessage };
      }),
    );

    const successfulResults = results.filter((item): item is NonNullable<typeof item> => item !== null);
    const episodesBase = successfulResults.map((item) => item.episode);
    let verificationResults: GaslightingVerification[] = [];
    try {
      verificationResults = await this.classifyStep3Batch(
        conversation,
        episodesBase.map((item) => item.anchor),
        locale,
      );
    } catch (error) {
      writeJsonDebug("step3_batch_error.json", {
        error: serializeError(error),
      });
    }
    const verificationByAnchorMsgId = new Map(
      verificationResults.map((item) => [item.anchor_msg_id, item] as const),
    );

    for (const item of successfulResults) {
      const verification = verificationByAnchorMsgId.get(item.episode.anchor.msg_id);
      writeJsonDebug(`step3_${item.stepIndex}.json`, {
        step_index: item.stepIndex,
        anchor_msg_id: item.episode.anchor.msg_id,
        anchor_ts: item.anchorMessage.ts,
        status: verification ? "ok" : "missing_verification_result",
        verdict: verification?.verdict,
      });
    }

    const episodes = episodesBase.map((item) => ({
      ...item,
      verification: verificationByAnchorMsgId.get(item.anchor.msg_id),
    }));

    const aggregates = buildAggregates(episodes);

    return {
      episodes,
      aggregates,
      verification: verificationResults.length > 0 ? verificationResults : undefined,
    };
  }

  private async detectAnchors(
    conversation: PipelineMessage[],
    locale: Locale,
    anchorSource: AnchorSourceMode,
  ): Promise<GaslightingAnchor[]> {
    const chunks = chunkMessages(conversation);
    const rawAnchors: GaslightingAnchor[] = [];

    for (const chunk of chunks) {
      const step1Input = buildStep1InputMarkdown(locale, anchorSource, chunk);
      const output = await this.callStructured(
        step1ResponseSchema,
        STEP1_JSON_SCHEMA,
        "gaslighting_step1_anchors",
        PROMPT_STEP1,
        step1Input,
      );

      const chunkMessageIds = new Set(chunk.map((message) => message.msg_id));
      const allowedSpeakers = new Set<Speaker>(
        anchorSource === "partner_only" ? ["self"] : ["self", "partner"],
      );
      const speakerByMessageId = new Map(chunk.map((message) => [message.msg_id, message.speaker] as const));

      for (const item of output.anchors) {
        if (!chunkMessageIds.has(item.msg_id)) {
          continue;
        }
        const anchorSpeaker = speakerByMessageId.get(item.msg_id);
        if (!anchorSpeaker || !allowedSpeakers.has(anchorSpeaker)) {
          continue;
        }
        rawAnchors.push({
          msg_id: item.msg_id,
          speaker: anchorSpeaker,
          fact_span: normalizeWhitespace(item.fact_span),
          anchor_event: normalizeWhitespace(item.anchor_event),
          action_type: item.action_type,
          confidence:
            typeof item.confidence === "number" && Number.isFinite(item.confidence)
              ? item.confidence
              : 0.6,
        });
      }
    }

    const deduped = new Map<string, GaslightingAnchor>();
    for (const anchor of rawAnchors) {
      const key = `${anchor.msg_id}::${anchor.fact_span.toLowerCase()}`;
      if (!deduped.has(key)) {
        deduped.set(key, anchor);
      }
    }

    const order = new Map(conversation.map((message, index) => [message.msg_id, index]));
    return [...deduped.values()].sort((a, b) => (order.get(a.msg_id) ?? 0) - (order.get(b.msg_id) ?? 0));
  }

  private async classifyStep2(
    anchorLine: string,
    anchor: GaslightingAnchor,
    followingMessages: PipelineMessage[],
    locale: Locale,
  ): Promise<GaslightingStep2> {
    const step2Input = buildStep2InputMarkdown(locale, anchorLine, anchor, followingMessages);
    const output = await this.callStructured(
      step2ResponseSchema,
      STEP2_JSON_SCHEMA,
      "gaslighting_step2_reaction",
      PROMPT_STEP2,
      step2Input,
    );

    return {
      reaction_type: output.reaction_type,
      normal_engagement: output.normal_engagement,
      non_engagement: output.non_engagement,
      fact_denial: output.fact_denial,
      perception_attack: output.perception_attack,
      reality_avoidance: output.reality_avoidance,
      notes: normalizeWhitespace(output.notes),
    };
  }

  private async classifyStep3Batch(
    conversation: PipelineMessage[],
    anchors: GaslightingAnchor[],
    locale: Locale,
  ): Promise<GaslightingVerification[]> {
    if (anchors.length === 0) {
      return [];
    }

    const step3Input = buildStep3InputMarkdown(locale, anchors, conversation);
    let output: z.infer<typeof step3ResponseSchema>;
    try {
      output = await this.callStructured(
        step3ResponseSchema,
        STEP3_JSON_SCHEMA,
        "gaslighting_step3_verification",
        PROMPT_STEP3,
        step3Input,
        {
          modelOverride: STEP3_REASONING_MODEL,
          reasoningEffort: "low",
        },
      );
    } catch (primaryError) {
      if (STEP3_REASONING_MODEL === this.model) {
        throw primaryError;
      }
      writeJsonDebug("step3_model_fallback.json", {
        primary_model: STEP3_REASONING_MODEL,
        fallback_model: this.model,
        error: serializeError(primaryError),
      });
      output = await this.callStructured(
        step3ResponseSchema,
        STEP3_JSON_SCHEMA,
        "gaslighting_step3_verification_fallback",
        PROMPT_STEP3,
        step3Input,
      );
    }

    const contextById = new Map(conversation.map((item) => [item.msg_id, item] as const));
    const validAnchorIds = new Set(anchors.map((item) => item.msg_id));

    return output.verifications
      .filter((item) => validAnchorIds.has(item.anchor_msg_id))
      .map((item) => ({
        anchor_msg_id: item.anchor_msg_id,
        verdict: item.verdict,
        evidence: (item.evidence ?? []).map((evidenceItem) => ({
          msg_id: evidenceItem.msg_id,
          text: truncate(evidenceItem.text, 280),
          reason: normalizeWhitespace(evidenceItem.reason),
          ts: contextById.get(evidenceItem.msg_id)?.ts ?? "",
          speaker: contextById.get(evidenceItem.msg_id)?.speaker,
        })),
        notes: normalizeWhitespace(item.notes),
      }));
  }

  private emptyStep2(locale: Locale): GaslightingStep2 {
    return {
      reaction_type: "non_engagement",
      normal_engagement: false,
      non_engagement: true,
      fact_denial: false,
      perception_attack: false,
      reality_avoidance: false,
      notes:
        locale === "ru"
          ? "После якорного события не найдены следующие сообщения в выбранном наборе."
          : "No following messages were found after the anchor event in the selected message set.",
    };
  }

  private async callStructured<T>(
    parser: z.ZodType<T>,
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    systemPrompt: string,
    payload: unknown,
    options?: {
      modelOverride?: string;
      reasoningEffort?: "low" | "medium" | "high";
    },
  ): Promise<T> {
    const logId = writeLlmPromptLog(schemaName, systemPrompt, payload);
    const completionRequest: any = {
      model: options?.modelOverride ?? this.model,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          strict: true,
          schema: jsonSchema,
        },
      },
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: stringifyPayload(payload),
        },
      ],
    };
    if (options?.reasoningEffort) {
      completionRequest.reasoning_effort = options.reasoningEffort;
    } else {
      completionRequest.temperature = 0;
    }

    let completion: any;
    try {
      completion = await this.client.chat.completions.create(completionRequest);
    } catch (error) {
      writeLlmOutputLog(logId, schemaName, {
        error: "OpenAI request failed before structured response parsing",
        details: serializeError(error),
      });
      throw error;
    }

    const content = completion.choices[0]?.message?.content?.trim();
    writeLlmOutputLog(logId, schemaName, {
      content: content ?? "",
      finish_reason: completion.choices[0]?.finish_reason ?? "",
    });
    if (!content) {
      writeLlmOutputLog(logId, schemaName, {
        error: "Structured output is empty",
      });
      throw new Error(`Structured output ${schemaName} is empty`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      writeLlmOutputLog(logId, schemaName, {
        error: "Failed to parse model content as JSON",
        raw_content: content,
      });
      throw new Error(`Structured output ${schemaName} is invalid JSON`);
    }
    const parsed = parser.safeParse(parsedJson);
    if (!parsed.success) {
      writeLlmOutputLog(logId, schemaName, {
        error: "Structured output failed schema validation",
        issues: parsed.error.issues,
        parsed_json: parsedJson,
      });
      throw new Error(`Structured output ${schemaName} failed validation`);
    }

    return parsed.data;
  }

  private toConversation(messages: ChatMessage[]): PipelineMessage[] {
    const base = messages
      .map((message, index) => {
        const msgId = String(message.id);
        const speaker: Speaker = message.senderLabel === "Me" ? "self" : "partner";
        const replyToMessageId =
          typeof message.replyToMessageId === "number" && Number.isFinite(message.replyToMessageId)
            ? String(message.replyToMessageId)
            : undefined;

        return {
          msg_id: msgId,
          speaker,
          ts: formatTimestamp(message.timestamp),
          text: normalizeWhitespace(message.text),
          replyToMessageId,
          index,
          timestampMs: Number.isFinite(message.timestamp) ? message.timestamp : undefined,
        };
      })
      .filter((message) => message.text.length > 0);

    const textById = new Map(base.map((item) => [item.msg_id, item.text] as const));
    const speakerById = new Map(base.map((item) => [item.msg_id, item.speaker] as const));
    return base.map((item) => ({
      ...item,
      replyToText: item.replyToMessageId ? textById.get(item.replyToMessageId) : undefined,
      replyToSpeaker: item.replyToMessageId ? speakerById.get(item.replyToMessageId) : undefined,
    }));
  }
}

function writeStep2Debug(stepIndex: number, payload: Record<string, unknown>): void {
  const path = join(STEP2_DEBUG_DIR, `step2_${stepIndex}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

function writeJsonDebug(fileName: string, payload: Record<string, unknown>): void {
  const path = join(STEP2_DEBUG_DIR, fileName);
  writeFileSync(path, JSON.stringify(payload, null, 2));
}

function writeLlmPromptLog(schemaName: string, systemPrompt: string, payload: unknown): number {
  mkdirSync(STEP2_DEBUG_DIR, { recursive: true });
  llmLogSequence += 1;
  const logId = llmLogSequence;
  const safeSchemaName = schemaName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `llm_${String(logId).padStart(4, "0")}_${safeSchemaName}_input.txt`;
  const content = [
    `schema: ${schemaName}`,
    `log_id: ${logId}`,
    "",
    "=== SYSTEM PROMPT ===",
    systemPrompt,
    "",
    "=== USER PAYLOAD ===",
    stringifyPayload(payload),
    "",
  ].join("\n");
  writeFileSync(join(STEP2_DEBUG_DIR, fileName), content);
  return logId;
}

function writeLlmOutputLog(logId: number, schemaName: string, payload: Record<string, unknown>): void {
  mkdirSync(STEP2_DEBUG_DIR, { recursive: true });
  const safeSchemaName = schemaName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const fileName = `llm_${String(logId).padStart(4, "0")}_${safeSchemaName}_output.txt`;
  const content = [
    `schema: ${schemaName}`,
    `log_id: ${logId}`,
    "",
    "=== MODEL OUTPUT ===",
    JSON.stringify(payload, null, 2),
    "",
  ].join("\n");
  writeFileSync(join(STEP2_DEBUG_DIR, fileName), content);
}

function formatTranscript(messages: PipelineMessage[]): string {
  return messages.map((item) => formatTranscriptLine(item)).join("\n");
}

function formatTranscriptLine(message: PipelineMessage): string {
  const ts = message.ts || "unknown_ts";
  const text = sanitizeInlineText(message.text);
  const parts = [`msg_id=${message.msg_id}`, `${message.speaker}: ${text} (${ts})`];

  if (message.replyToMessageId) {
    const replyText = message.replyToText ? sanitizeInlineText(message.replyToText) : "unavailable";
    const replySpeaker = message.replyToSpeaker ?? "unknown";
    parts.push(`reply_to=${message.replyToMessageId} (${replySpeaker}) -> ${replyText}`);
  }

  return parts.join(" | ");
}

function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  return JSON.stringify(payload, null, 2);
}

function buildStep1InputMarkdown(
  locale: Locale,
  anchorSource: AnchorSourceMode,
  chunk: PipelineMessage[],
): string {
  return [
    `language: ${locale === "ru" ? "Russian" : "English"}`,
    `instruction: ${
      anchorSource === "partner_only"
        ? "Analyze ONLY messages where speaker=self and return only verifiable anchor facts."
        : "Analyze BOTH speakers and return only verifiable anchor facts."
    }`,
    "speaker_mapping:",
    "- self = current Telegram account owner (senderLabel=Me)",
    "- partner = chat counterpart (senderLabel=Other)",
    "line_format: msg_id=<id> | <speaker>: <text> (<ts>) | reply_to=<id> -> <reply_text>",
    "### transcript",
    "```text",
    formatTranscript(chunk),
    "```",
  ].join("\n");
}

function buildStep2InputMarkdown(
  locale: Locale,
  anchorLine: string,
  anchor: GaslightingAnchor,
  followingMessages: PipelineMessage[],
): string {
  return [
    `language: ${locale === "ru" ? "Russian" : "English"}`,
    "line_format: msg_id=<id> | <speaker>: <text> (<ts>) | reply_to=<id> -> <reply_text>",
    "### anchor_line",
    "```text",
    anchorLine,
    "```",
    "### anchor_meta",
    "```json",
    JSON.stringify(anchor, null, 2),
    "```",
    "### following_transcript",
    "```text",
    formatTranscript(followingMessages),
    "```",
  ].join("\n");
}

function buildStep3InputMarkdown(
  locale: Locale,
  anchors: GaslightingAnchor[],
  fullConversation: PipelineMessage[],
): string {
  return [
    `language: ${locale === "ru" ? "Russian" : "English"}`,
    "line_format: msg_id=<id> | <speaker>: <text> (<ts>) | reply_to=<id> -> <reply_text>",
    "### anchors",
    "```json",
    JSON.stringify(
      anchors.map((item) => ({
        anchor_msg_id: item.msg_id,
        speaker: item.speaker,
        fact_span: item.fact_span,
        anchor_event: item.anchor_event,
        action_type: item.action_type,
      })),
      null,
      2,
    ),
    "```",
    "### full_transcript",
    "```text",
    formatTranscript(fullConversation),
    "```",
  ].join("\n");
}

function chunkMessages(messages: PipelineMessage[]): PipelineMessage[][] {
  if (messages.length <= CHUNK_SPLIT_THRESHOLD) {
    return [messages];
  }

  const chunks: PipelineMessage[][] = [];
  const step = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP);
  for (let start = 0; start < messages.length; start += step) {
    const end = Math.min(messages.length, start + CHUNK_SIZE);
    chunks.push(messages.slice(start, end));
    if (end === messages.length) {
      break;
    }
  }

  return chunks;
}

function collectFollowingMessages(
  messages: PipelineMessage[],
  anchorIndex: number,
  limit: number,
): PipelineMessage[] {
  const following: PipelineMessage[] = [];
  for (let index = anchorIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    following.push(message);
    if (following.length >= limit) {
      break;
    }
  }
  return following;
}

function buildAggregates(episodes: GaslightingEpisode[]): GaslightingAggregates {
  const totalEpisodes = episodes.length;
  const gaslightingEpisodes = episodes.filter((episode) => episode.gaslighting).length;

  const markerCounts = episodes.reduce(
    (acc, episode) => {
      if (episode.step2.fact_denial) {
        acc.fact_denial += 1;
      }
      if (episode.step2.perception_attack) {
        acc.perception_attack += 1;
      }
      if (episode.step2.reality_avoidance) {
        acc.reality_avoidance += 1;
      }
      return acc;
    },
    { fact_denial: 0, perception_attack: 0, reality_avoidance: 0 },
  );

  let repeatability: GaslightingAggregates["repeatability"] = "single_or_none";
  if (gaslightingEpisodes >= 5) {
    repeatability = "stable_pattern";
  } else if (gaslightingEpisodes >= 3) {
    repeatability = "likely";
  } else if (gaslightingEpisodes >= 2) {
    repeatability = "suspicion";
  }

  return {
    total_episodes: totalEpisodes,
    gaslighting_episodes: gaslightingEpisodes,
    gaslighting_ratio: totalEpisodes > 0 ? Number((gaslightingEpisodes / totalEpisodes).toFixed(3)) : 0,
    repeatability,
    marker_counts: markerCounts,
  };
}

function formatTimestamp(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) {
    return "";
  }
  const date = new Date(value);
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

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function sanitizeInlineText(value: string): string {
  return normalizeWhitespace(value).replace(/\|/g, "¦");
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withCause = error as Error & { cause?: unknown };
    const withStatus = error as Error & { status?: number; code?: string | number; response?: unknown };
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? "",
      code: withStatus.code,
      status: withStatus.status,
      cause: withCause.cause ? String(withCause.cause) : undefined,
      response: withStatus.response
        ? typeof withStatus.response === "object"
          ? withStatus.response
          : String(withStatus.response)
        : undefined,
    };
  }
  return {
    message: String(error),
  };
}
