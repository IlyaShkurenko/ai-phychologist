export type AuthState =
  | "wait_phone_number"
  | "wait_other_device_confirmation"
  | "wait_code"
  | "wait_password"
  | "ready"
  | "closed";

export type Locale = "ru" | "en";

export interface ChatSummary {
  id: number;
  title: string;
  unreadCount?: number;
  lastMessageSnippet?: string;
  lastMessageTs?: number;
  isPrivate?: boolean;
}

export interface ChatMessage {
  id: number;
  chatId: number;
  senderLabel: "Me" | "Other";
  senderId?: number;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
}

export interface AnalysisConfig {
  theme?: "Love" | "Work" | "Friendship" | "Gaslighting" | "";
  behaviorPatterns: string[];
  focus: string[];
  goal: string;
  helpMeToggles: string[];
  helpMeText?: string;
}

export type AnalysisMode = "last300" | "range" | "selected";

export interface GaslightingResult {
  episodes: {
    anchor: {
      msg_id: string;
      speaker: "self" | "partner";
      fact_span: string;
      anchor_event: string;
      action_type:
        | "said_phrase"
        | "promise"
        | "changed_agreement"
        | "no_reply"
        | "online_activity"
        | "third_party_contact"
        | "meeting_change"
        | "disappearance"
        | "other_fact";
      confidence: number;
    };
    partner_replies: {
      msg_id: string;
      speaker: "self" | "partner";
      text: string;
      ts: string;
    }[];
    step2: {
      reaction_type:
        | "normal_engagement"
        | "non_engagement"
        | "fact_denial_only"
        | "perception_attack_only"
        | "reality_avoidance_only"
        | "mixed";
      normal_engagement: boolean;
      non_engagement: boolean;
      fact_denial: boolean;
      perception_attack: boolean;
      reality_avoidance: boolean;
      notes: string;
    };
    gaslighting: boolean;
    verification?: {
      anchor_msg_id: string;
      verdict: "supported" | "contradicted" | "not_found";
      evidence: {
        msg_id: string;
        text: string;
        reason: string;
        ts?: string;
        speaker?: "self" | "partner";
      }[];
      notes: string;
    };
  }[];
  aggregates: {
    total_episodes: number;
    gaslighting_episodes: number;
    gaslighting_ratio: number;
    repeatability: "single_or_none" | "suspicion" | "likely" | "stable_pattern";
    marker_counts: {
      fact_denial: number;
      perception_attack: number;
      reality_avoidance: number;
    };
  };
  verification?: {
    anchor_msg_id: string;
    verdict: "supported" | "contradicted" | "not_found";
    evidence: {
      msg_id: string;
      text: string;
      reason: string;
      ts?: string;
      speaker?: "self" | "partner";
    }[];
    notes: string;
  }[];
}

export interface AnalysisResult {
  mode: AnalysisMode;
  messageCount: number;
  summary: string;
  keySignals: {
    redFlags: string[];
    greenFlags: string[];
    patterns: string[];
  };
  suggestedReplies: string[];
  outcomes: {
    ifReply: string;
    ifNoReply: string;
  };
  gaslighting?: GaslightingResult;
}

export interface TdlibEvent {
  type: "auth_state" | "chats_updated" | "history_loaded" | "message_received" | "errors";
  sessionId: string;
  payload: unknown;
  ts: number;
}
