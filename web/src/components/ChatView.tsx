import { useEffect, useMemo, useRef } from "react";

import { localeCode, t } from "../i18n";
import { DateRangePicker } from "./DateRangePicker";
import type { ChatMessage, ChatSummary, Locale } from "../types";

interface DateRangeValue {
  from?: Date;
  to?: Date;
}

interface ChatViewProps {
  locale: Locale;
  chat: ChatSummary | null;
  messages: ChatMessage[];
  selectedMessageIds: Set<number>;
  hasMore: boolean;
  loadingMessages: boolean;
  actionBusy: boolean;
  range: DateRangeValue;
  onRangeChange: (value: DateRangeValue) => void;
  onToggleMessageSelection: (messageId: number) => void;
  onLoadOlder: () => void;
  onAnalyzeSelected: () => void;
  onAnalyzeRange: () => void;
  onAnalyzeLast300: () => void;
}

export function ChatView({
  locale,
  chat,
  messages,
  selectedMessageIds,
  hasMore,
  loadingMessages,
  actionBusy,
  range,
  onRangeChange,
  onToggleMessageSelection,
  onLoadOlder,
  onAnalyzeSelected,
  onAnalyzeRange,
  onAnalyzeLast300,
}: ChatViewProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const shouldInitialScrollToBottomRef = useRef(false);
  const loadingOlderFromScrollRef = useRef(false);
  const prependSnapshotRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const messageById = useMemo(() => new Map(messages.map((item) => [item.id, item] as const)), [messages]);

  useEffect(() => {
    shouldInitialScrollToBottomRef.current = true;
    loadingOlderFromScrollRef.current = false;
    prependSnapshotRef.current = null;
  }, [chat?.id]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    if (loadingOlderFromScrollRef.current && !loadingMessages) {
      const snapshot = prependSnapshotRef.current;
      if (snapshot) {
        const delta = container.scrollHeight - snapshot.scrollHeight;
        container.scrollTop = snapshot.scrollTop + Math.max(delta, 0);
      }
      prependSnapshotRef.current = null;
      loadingOlderFromScrollRef.current = false;
      return;
    }

    if (shouldInitialScrollToBottomRef.current && !loadingMessages && messages.length > 0) {
      container.scrollTop = container.scrollHeight;
      shouldInitialScrollToBottomRef.current = false;
    }
  }, [messages.length, loadingMessages]);

  const handleMessagesScroll = (): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    if (!hasMore || loadingMessages || loadingOlderFromScrollRef.current) {
      return;
    }

    if (container.scrollTop <= 80) {
      loadingOlderFromScrollRef.current = true;
      prependSnapshotRef.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
      };
      onLoadOlder();
    }
  };

  if (!chat) {
    return (
      <section className="panel chat-view-panel empty">
        <p>{t(locale, "chatView.empty")}</p>
      </section>
    );
  }

  const hasRange = Boolean(range.from && range.to);

  return (
    <section className="panel chat-view-panel">
      <div className="panel-header">
        <h3>{chat.title}</h3>
      </div>

      <div className="range-controls">
        <label>
          {t(locale, "chatView.dateRange")}
          <DateRangePicker locale={locale} value={range} onChange={onRangeChange} />
        </label>
      </div>

      <div className="analysis-actions">
        <button type="button" onClick={onAnalyzeLast300} disabled={actionBusy || loadingMessages}>
          {t(locale, "chatView.analyzeLast300")}
        </button>
        <button type="button" onClick={onAnalyzeRange} disabled={actionBusy || loadingMessages || !hasRange}>
          {t(locale, "chatView.analyzeRange")}
        </button>
        <button
          type="button"
          onClick={onAnalyzeSelected}
          disabled={actionBusy || loadingMessages || selectedMessageIds.size === 0}
        >
          {t(locale, "chatView.analyzeSelected", { count: selectedMessageIds.size })}
        </button>
      </div>

      <div className="messages-scroll" ref={scrollRef} onScroll={handleMessagesScroll}>
        {hasMore ? <p className="muted">{t(locale, "chatView.scrollLoadOlder")}</p> : null}
        {loadingMessages ? <p className="muted">{t(locale, "chatView.loadingMessages")}</p> : null}
        <ul className="messages-list">
          {messages.map((message, index) => (
            <li
              key={`${message.id}-${message.timestamp}-${index}`}
              className={message.senderLabel === "Me" ? "message-row me" : "message-row other"}
            >
              <label className="message-item">
                <input
                  type="checkbox"
                  checked={selectedMessageIds.has(message.id)}
                  onChange={() => onToggleMessageSelection(message.id)}
                />
                <div className="message-content">
                  <div className="message-meta">
                    <strong>
                      {message.senderLabel === "Me" ? t(locale, "chatView.sender.me") : t(locale, "chatView.sender.other")}
                    </strong>
                    <span>{new Date(message.timestamp).toLocaleString(localeCode(locale))}</span>
                  </div>
                  {typeof message.replyToMessageId === "number" ? (
                    <div className="message-reply-preview">
                      <span className="message-reply-label">{t(locale, "chatView.replyTo")}</span>
                      <strong>
                        {messageById.get(message.replyToMessageId)?.senderLabel === "Me"
                          ? t(locale, "chatView.sender.me")
                          : messageById.get(message.replyToMessageId)?.senderLabel === "Other"
                            ? t(locale, "chatView.sender.other")
                            : `#${message.replyToMessageId}`}
                      </strong>
                      <p>{messageById.get(message.replyToMessageId)?.text ?? t(locale, "chatView.replyUnavailable")}</p>
                    </div>
                  ) : null}
                  <p>{message.text}</p>
                </div>
              </label>
            </li>
          ))}
        </ul>

        {!loadingMessages && messages.length === 0 ? <p className="muted">{t(locale, "chatView.noMessages")}</p> : null}
      </div>
    </section>
  );
}
