import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  analyzeMessages,
  clearSession,
  createSession,
  disconnectSession,
  getMessages,
  listChats,
  resumeSession,
  startQrAuthentication,
  submitCode,
  submitPassword,
  submitPhoneNumber,
} from "./api";
import { BottomSheet } from "./components/BottomSheet";
import { ChatList } from "./components/ChatList";
import { ChatView } from "./components/ChatView";
import { ConsentModal } from "./components/ConsentModal";
import { LoginModal } from "./components/LoginModal";
import { ResultPanel } from "./components/ResultPanel";
import { useSessionSocket, type SessionSocketErrorCode } from "./hooks/useSessionSocket";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  behaviorPatternIds,
  focusIds,
  helpMeOptionIds,
  isLocale,
  t,
} from "./i18n";
import type {
  AnalysisConfig,
  AnalysisMode,
  AnalysisResult,
  AuthState,
  ChatMessage,
  ChatSummary,
  Locale,
  TdlibEvent,
} from "./types";

const defaultConfig: AnalysisConfig = {
  theme: "",
  behaviorPatterns: [behaviorPatternIds[0], behaviorPatternIds[1]],
  focus: [...focusIds],
  goal: "",
  helpMeToggles: [helpMeOptionIds[0]],
  helpMeText: "",
};

interface PendingAnalysis {
  mode: AnalysisMode;
  chatId: number;
}

const SESSION_STORAGE_KEY = "telegram_analyzer_session_id";

interface DateRangeValue {
  from?: Date;
  to?: Date;
}

function sortChatsByRecent(chats: ChatSummary[]): ChatSummary[] {
  const sorted = [...chats].sort((a, b) => (b.lastMessageTs ?? 0) - (a.lastMessageTs ?? 0));
  const privateFirst = sorted.filter((chat) => chat.isPrivate !== false);
  return privateFirst.length > 0 ? privateFirst : sorted;
}

function mergeChatSnapshots(current: ChatSummary[], incoming: ChatSummary[]): ChatSummary[] {
  if (incoming.length === 0 && current.length > 0) {
    return current;
  }
  return incoming;
}

function toStartOfDayTimestamp(date: Date): number {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value.getTime();
}

function toEndOfDayTimestamp(date: Date): number {
  const value = new Date(date);
  value.setHours(23, 59, 59, 999);
  return value.getTime();
}

function dedupeMessages(messages: ChatMessage[]): ChatMessage[] {
  const seen = new Set<string>();
  const deduped: ChatMessage[] = [];
  for (const message of messages) {
    const key = `${message.id}:${message.timestamp}:${message.senderLabel}:${message.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(message);
  }
  return deduped;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export default function App(): JSX.Element {
  const [locale, setLocale] = useState<Locale>(() => {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : DEFAULT_LOCALE;
  });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [authState, setAuthState] = useState<AuthState>("wait_phone_number");
  const [qrLink, setQrLink] = useState<string | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [oldestMessageId, setOldestMessageId] = useState<number | undefined>(undefined);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<number>>(new Set());

  const [range, setRange] = useState<DateRangeValue>({});

  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("last300");
  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfig>(defaultConfig);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);

  const [isBusy, setIsBusy] = useState(false);
  const [isChatsLoading, setIsChatsLoading] = useState(false);
  const [isMessagesLoading, setIsMessagesLoading] = useState(false);
  const [isRestoringSession, setIsRestoringSession] = useState(true);

  const [consentOpen, setConsentOpen] = useState(false);
  const [hasConsent, setHasConsent] = useState(false);
  const [allowStorageOption, setAllowStorageOption] = useState(false);
  const pendingAnalysisRef = useRef<PendingAnalysis | null>(null);
  const activeChatLoadRef = useRef(0);

  useEffect(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.title = t(locale, "app.title");
  }, [locale]);

  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

  const handleTdlibEvent = useCallback(
    (event: TdlibEvent) => {
      if (event.type === "auth_state") {
        const payload = event.payload as { authState?: AuthState; qrLink?: string; status?: string };
        if (payload.authState) {
          setAuthState(payload.authState);
          setQrLink(payload.qrLink);
          if (payload.authState === "ready") {
            setStatusMessage(t(locale, "status.telegramConnected"));
            setQrLink(undefined);
          }
        }
        return;
      }

      if (event.type === "chats_updated") {
        const payload = event.payload as { chats?: ChatSummary[] };
        if (payload.chats) {
          const sortedIncoming = sortChatsByRecent(payload.chats);
          setChats((current) => mergeChatSnapshots(current, sortedIncoming));
          if (sortedIncoming.length > 0) {
            setIsChatsLoading(false);
          }
        }
        return;
      }

      if (event.type === "message_received") {
        const payload = event.payload as { chatId?: number; message?: ChatMessage };
        if (!payload.message || payload.chatId !== selectedChatId) {
          return;
        }
        setMessages((current) => {
          if (current.some((item) => item.id === payload.message!.id)) {
            return current;
          }
          return [...current, payload.message!].sort((a, b) => a.timestamp - b.timestamp);
        });
        return;
      }

      if (event.type === "errors") {
        const payload = event.payload as { message?: string };
        setStatusMessage(payload.message ?? t(locale, "status.telegramError"));
      }
    },
    [locale, selectedChatId],
  );

  const handleSocketError = useCallback(
    (code: SessionSocketErrorCode) => {
      setStatusMessage(
        code === "parse_error" ? t(locale, "status.realtimeParseError") : t(locale, "status.realtimeConnectionError"),
      );
    },
    [locale],
  );

  useSessionSocket(sessionId, handleTdlibEvent, handleSocketError);

  useEffect(() => {
    const savedSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!savedSessionId) {
      setIsRestoringSession(false);
      return;
    }

    void (async () => {
      try {
        const resumed = await resumeSession(savedSessionId);
        setSessionId(resumed.sessionId);
        setAuthState(resumed.authState);
        setStatusMessage(t(locale, "status.sessionRestored"));
        if (resumed.authState === "ready") {
          setIsChatsLoading(true);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const shouldClearSavedSession = message.includes("Unknown session");
        if (shouldClearSavedSession) {
          localStorage.removeItem(SESSION_STORAGE_KEY);
        } else {
          setStatusMessage(t(locale, "status.failedRestoreSession"));
        }
      } finally {
        setIsRestoringSession(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!sessionId || authState !== "ready") {
      return;
    }

    let cancelled = false;
    setIsChatsLoading(true);
    void (async () => {
      try {
        let attempts = 0;
        const maxAttempts = 12;
        let nextChats: ChatSummary[] = [];
        while (!cancelled && attempts < maxAttempts) {
          attempts += 1;
          nextChats = await listChats(sessionId);
          if (nextChats.length > 0 || attempts >= maxAttempts) {
            break;
          }
          await wait(700);
        }
        if (!cancelled) {
          const sortedIncoming = sortChatsByRecent(nextChats);
          setChats((current) => mergeChatSnapshots(current, sortedIncoming));
        }
      } catch (error) {
        if (!cancelled) {
          setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedLoadChats"));
        }
      } finally {
        if (!cancelled) {
          setIsChatsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, authState]);

  const connectTelegram = async (): Promise<void> => {
    setIsBusy(true);
    setStatusMessage(null);
    try {
      const created = await createSession();
      setSessionId(created.sessionId);
      setAuthState(created.authState);
      localStorage.setItem(SESSION_STORAGE_KEY, created.sessionId);
      setQrLink(undefined);
      setChats([]);
      setMessages([]);
      setSelectedChatId(null);
      setOldestMessageId(undefined);
      setHasMoreMessages(false);
      setRange({});
      setAnalysisResult(null);
      setIsChatsLoading(false);
      setIsMessagesLoading(false);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedCreateSession"));
    } finally {
      setIsBusy(false);
    }
  };

  const disconnectTelegram = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      await disconnectSession(sessionId);
      resetLocalState();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedDisconnect"));
    } finally {
      setIsBusy(false);
    }
  };

  const clearSessionData = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      await clearSession(sessionId);
      resetLocalState();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedClearSession"));
    } finally {
      setIsBusy(false);
    }
  };

  function resetLocalState(): void {
    activeChatLoadRef.current += 1;
    localStorage.removeItem(SESSION_STORAGE_KEY);
    setSessionId(null);
    setAuthState("wait_phone_number");
    setQrLink(undefined);
    setChats([]);
    setSelectedChatId(null);
    setMessages([]);
    setOldestMessageId(undefined);
    setHasMoreMessages(false);
    setSelectedMessageIds(new Set());
    setRange({});
    setAnalysisResult(null);
    setStatusMessage(t(locale, "status.sessionClosed"));
    setHasConsent(false);
    setAllowStorageOption(false);
    setIsChatsLoading(false);
    setIsMessagesLoading(false);
  }

  const handleSubmitPhone = async (phone: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      const result = await submitPhoneNumber(sessionId, phone);
      setAuthState(result.authState);
      setQrLink(undefined);
      setStatusMessage(t(locale, "status.codeSent"));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.phoneSubmitFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSubmitCode = async (code: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      const result = await submitCode(sessionId, code);
      setAuthState(result.authState);
      setQrLink(undefined);
      setStatusMessage(t(locale, "status.codeSubmitted"));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.codeSubmitFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const handleSubmitPassword = async (password: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      const result = await submitPassword(sessionId, password);
      setAuthState(result.authState);
      setQrLink(undefined);
      setStatusMessage(t(locale, "status.passwordSubmitted"));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.passwordSubmitFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartQrAuth = async (): Promise<void> => {
    if (!sessionId) {
      return;
    }
    setIsBusy(true);
    try {
      const result = await startQrAuthentication(sessionId);
      setAuthState(result.authState);
      setQrLink(result.qrLink);
      setStatusMessage(t(locale, "status.scanQr"));
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.qrStartFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const loadChat = async (chatId: number): Promise<void> => {
    if (!sessionId) {
      return;
    }
    const loadToken = activeChatLoadRef.current + 1;
    activeChatLoadRef.current = loadToken;
    setSelectedChatId(chatId);
    setSelectedMessageIds(new Set());
    setRange({});
    setMessages([]);
    setOldestMessageId(undefined);
    setHasMoreMessages(false);
    setIsMessagesLoading(true);
    try {
      const pageSize = 100;
      const targetInitialMessages = 120;
      const maxWarmupAttempts = 6;
      const maxNoProgressAttempts = 2;
      let noProgressAttempts = 0;
      let warmupAttempts = 0;
      const batch = await getMessages(sessionId, chatId, pageSize);

      if (activeChatLoadRef.current !== loadToken) {
        return;
      }

      let collected = dedupeMessages(batch).sort((a, b) => a.timestamp - b.timestamp);
      let oldestId = collected[0]?.id;

      while (oldestId && collected.length < targetInitialMessages && warmupAttempts < maxWarmupAttempts) {
        warmupAttempts += 1;
        const olderBatch = await getMessages(sessionId, chatId, pageSize, oldestId);

        if (activeChatLoadRef.current !== loadToken) {
          return;
        }

        const nextCollected = dedupeMessages([...olderBatch, ...collected]).sort((a, b) => a.timestamp - b.timestamp);
        const nextOldestId = nextCollected[0]?.id;
        const hasProgress = nextCollected.length > collected.length || nextOldestId !== oldestId;

        if (!hasProgress) {
          noProgressAttempts += 1;
          if (noProgressAttempts >= maxNoProgressAttempts) {
            break;
          }
          await wait(250);
          continue;
        }

        noProgressAttempts = 0;
        collected = nextCollected;
        oldestId = nextOldestId;
      }

      setMessages(collected);
      setOldestMessageId(oldestId);

      const likelyExhausted = !oldestId || noProgressAttempts >= maxNoProgressAttempts;
      setHasMoreMessages(Boolean(oldestId) && !likelyExhausted);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedLoadMessages"));
    } finally {
      if (activeChatLoadRef.current === loadToken) {
        setIsMessagesLoading(false);
      }
    }
  };

  const loadOlderMessages = async (): Promise<void> => {
    if (!sessionId || !selectedChatId || !oldestMessageId) {
      return;
    }

    setIsMessagesLoading(true);
    try {
      const pageSize = 100;
      const maxNoProgressAttempts = 2;
      let noProgressAttempts = 0;
      let previousOldestMessageId = oldestMessageId;
      let merged = messages;
      let nextOldestId = previousOldestMessageId;

      while (noProgressAttempts < maxNoProgressAttempts) {
        const batch = await getMessages(sessionId, selectedChatId, pageSize, previousOldestMessageId);
        if (batch.length === 0) {
          noProgressAttempts += 1;
          await wait(220);
          continue;
        }

        const next = dedupeMessages([...batch, ...merged]).sort((a, b) => a.timestamp - b.timestamp);
        const candidateOldest = next[0]?.id;
        const hasProgress = next.length > merged.length || candidateOldest !== previousOldestMessageId;

        if (!hasProgress) {
          noProgressAttempts += 1;
          await wait(220);
          continue;
        }

        merged = next;
        nextOldestId = candidateOldest ?? previousOldestMessageId;
        break;
      }

      setMessages(merged);

      if (!nextOldestId || nextOldestId === previousOldestMessageId || noProgressAttempts >= maxNoProgressAttempts) {
        setHasMoreMessages(false);
      } else {
        setOldestMessageId(nextOldestId);
        setHasMoreMessages(true);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.failedLoadOlderMessages"));
    } finally {
      setIsMessagesLoading(false);
    }
  };

  const toggleMessageSelection = (messageId: number): void => {
    setSelectedMessageIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  const runAnalysis = async (mode: AnalysisMode, chatId: number): Promise<void> => {
    if (!sessionId) {
      return;
    }

    const rangeSelection =
      range.from && range.to
        ? {
            startTs: toStartOfDayTimestamp(range.from),
            endTs: toEndOfDayTimestamp(range.to),
          }
        : undefined;

    const selection =
      mode === "selected"
        ? { messageIds: [...selectedMessageIds] }
        : mode === "range"
          ? rangeSelection
          : undefined;

    if (mode === "selected" && selectedMessageIds.size === 0) {
      setStatusMessage(t(locale, "status.selectMessage"));
      return;
    }

    if (!rangeSelection && mode === "range") {
      setStatusMessage(t(locale, "status.invalidRange"));
      return;
    }

    setIsBusy(true);
    setStatusMessage(t(locale, "status.analyzing"));

    try {
      const result = await analyzeMessages({
        sessionId,
        chatId,
        mode,
        locale,
        config: analysisConfig,
        selection,
      });
      setAnalysisResult(result);
      setStatusMessage(
        allowStorageOption
          ? t(locale, "status.analysisCompleteWithPref")
          : t(locale, "status.analysisComplete"),
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : t(locale, "status.analysisFailed"));
    } finally {
      setIsBusy(false);
    }
  };

  const attemptAnalysis = (mode: AnalysisMode, chatId: number): void => {
    setAnalysisMode(mode);
    if (!hasConsent) {
      pendingAnalysisRef.current = { mode, chatId };
      setConsentOpen(true);
      return;
    }

    void runAnalysis(mode, chatId);
  };

  const handleSheetSend = (): void => {
    if (!selectedChatId) {
      setStatusMessage(t(locale, "status.selectChatFirst"));
      return;
    }
    attemptAnalysis(analysisMode, selectedChatId);
  };

  const handleConsentAccept = (allowStorage: boolean): void => {
    setHasConsent(true);
    setAllowStorageOption(allowStorage);
    setConsentOpen(false);

    const pending = pendingAnalysisRef.current;
    if (pending) {
      pendingAnalysisRef.current = null;
      void runAnalysis(pending.mode, pending.chatId);
    }
  };

  const handleConsentCancel = (): void => {
    pendingAnalysisRef.current = null;
    setConsentOpen(false);
    setStatusMessage(t(locale, "status.consentRequired"));
  };

  return (
    <div className="app-shell">
      <header className="top-bar">
        <h1>{t(locale, "app.title")}</h1>
        <div className="top-actions">
          <label className="locale-switch-label">
            {t(locale, "app.language")}
            <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
              <option value="ru">{t(locale, "app.locale.ru")}</option>
              <option value="en">{t(locale, "app.locale.en")}</option>
            </select>
          </label>
          {sessionId ? (
            <button type="button" className="secondary" onClick={disconnectTelegram} disabled={isBusy}>
              {t(locale, "app.disconnect")}
            </button>
          ) : null}
          {sessionId ? (
            <button type="button" className="secondary" onClick={clearSessionData} disabled={isBusy}>
              {t(locale, "app.clearSession")}
            </button>
          ) : null}
        </div>
      </header>

      {!sessionId ? (
        <main className="home-panel panel">
          <h2>{t(locale, "home.title")}</h2>
          <p className="muted">{t(locale, "home.privacy")}</p>
          <button type="button" onClick={connectTelegram} disabled={isBusy || isRestoringSession}>
            {isRestoringSession
              ? t(locale, "home.restoring")
              : isBusy
                ? t(locale, "home.connecting")
                : t(locale, "home.connect")}
          </button>
        </main>
      ) : (
        <main className="workspace-grid">
          <ChatList
            locale={locale}
            chats={chats}
            selectedChatId={selectedChatId}
            onSelectChat={(chatId) => {
              void loadChat(chatId);
            }}
            onAnalyzeLast300={(chatId) => attemptAnalysis("last300", chatId)}
            disabled={isBusy}
            loading={isChatsLoading}
          />

          <ChatView
            locale={locale}
            chat={selectedChat}
            messages={messages}
            selectedMessageIds={selectedMessageIds}
            hasMore={hasMoreMessages}
            loadingMessages={isMessagesLoading}
            actionBusy={isBusy}
            range={range}
            onRangeChange={setRange}
            onToggleMessageSelection={toggleMessageSelection}
            onLoadOlder={() => {
              void loadOlderMessages();
            }}
            onAnalyzeSelected={() => {
              if (selectedChatId) {
                attemptAnalysis("selected", selectedChatId);
              }
            }}
            onAnalyzeRange={() => {
              if (selectedChatId) {
                attemptAnalysis("range", selectedChatId);
              }
            }}
            onAnalyzeLast300={() => {
              if (selectedChatId) {
                attemptAnalysis("last300", selectedChatId);
              }
            }}
          />

          <ResultPanel locale={locale} result={analysisResult} />

          <BottomSheet
            locale={locale}
            config={analysisConfig}
            mode={analysisMode}
            loading={isBusy}
            onChangeConfig={setAnalysisConfig}
            onChangeMode={setAnalysisMode}
            onSend={handleSheetSend}
          />
        </main>
      )}

      {statusMessage ? <p className="status-banner">{statusMessage}</p> : null}

      <LoginModal
        locale={locale}
        open={Boolean(sessionId) && authState !== "ready"}
        authState={authState}
        qrLink={qrLink}
        statusMessage={statusMessage}
        loading={isBusy}
        onSubmitPhone={handleSubmitPhone}
        onStartQr={handleStartQrAuth}
        onSubmitCode={handleSubmitCode}
        onSubmitPassword={handleSubmitPassword}
      />

      <ConsentModal locale={locale} open={consentOpen} onAccept={handleConsentAccept} onCancel={handleConsentCancel} />
    </div>
  );
}
