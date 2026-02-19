import { useMemo, useState } from "react";

import { t } from "../i18n";
import type { Locale } from "../types";
import type { ChatSummary } from "../types";

interface ChatListProps {
  locale: Locale;
  chats: ChatSummary[];
  selectedChatId: number | null;
  onSelectChat: (chatId: number) => void;
  onAnalyzeLast300: (chatId: number) => void;
  disabled?: boolean;
  loading?: boolean;
}

export function ChatList({
  locale,
  chats,
  selectedChatId,
  onSelectChat,
  onAnalyzeLast300,
  disabled,
  loading,
}: ChatListProps): JSX.Element {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    if (!normalized) {
      return chats;
    }
    return chats.filter((chat) => chat.title.toLowerCase().includes(normalized));
  }, [chats, search]);

  return (
    <section className="panel chat-list-panel">
      <div className="panel-header">
        <h3>{t(locale, "chatList.title")}</h3>
      </div>

      <input
        className="search-input"
        placeholder={t(locale, "chatList.search")}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <ul className="chat-list">
        {filtered.map((chat) => (
          <li key={chat.id} className={chat.id === selectedChatId ? "chat-item selected" : "chat-item"}>
            <button type="button" className="chat-main-button" onClick={() => onSelectChat(chat.id)}>
              <span className="chat-title">{chat.title}</span>
              <span className="chat-snippet">{chat.lastMessageSnippet ?? t(locale, "chatList.noMessages")}</span>
            </button>

            <div className="chat-actions">
              {chat.unreadCount ? <span className="badge">{chat.unreadCount}</span> : null}
              <button
                type="button"
                className="small-button"
                onClick={() => onAnalyzeLast300(chat.id)}
                disabled={disabled}
              >
                {t(locale, "chatList.analyzeLast300")}
              </button>
            </div>
          </li>
        ))}
      </ul>

      {loading ? (
        <p className="muted chat-list-loading">
          <span className="chat-list-spinner" aria-hidden="true" />
          <span>{filtered.length > 0 ? t(locale, "chatList.loadingMore") : t(locale, "chatList.loading")}</span>
        </p>
      ) : null}
      {!loading && filtered.length === 0 ? <p className="muted">{t(locale, "chatList.empty")}</p> : null}
    </section>
  );
}
