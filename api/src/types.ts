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
}

export interface AnalysisConfig {
  theme?: "Love" | "Work" | "Friendship" | "";
  behaviorPatterns: string[];
  focus: string[];
  goal: string;
  helpMeToggles: string[];
  helpMeText?: string;
}

export type AnalysisMode = "last300" | "range" | "selected";

export interface AnalysisResponse {
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
}

export interface TdlibEvent {
  type: "auth_state" | "chats_updated" | "history_loaded" | "message_received" | "errors";
  sessionId: string;
  payload: unknown;
  ts: number;
}
