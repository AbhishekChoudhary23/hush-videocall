import { useEffect, useRef, useState } from "react";
import { Download, Send, X } from "lucide-react";
import { downloadChat, formatTime } from "../lib/util";

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

/** Message text is rendered as text nodes; only http(s) URLs become links. */
function Linkified({ text }) {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      part
    )
  );
}

export default function ChatPanel({ messages, onSend, onClose }) {
  const [draft, setDraft] = useState("");
  const listRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const submit = (e) => {
    e.preventDefault();
    if (!draft.trim()) return;
    onSend(draft);
    setDraft("");
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  return (
    <aside className="chat" aria-label="Chat">
      <header className="chat-head">
        <h2>Chat</h2>
        <div className="chat-head-actions">
          <button
            className="icon-btn"
            onClick={() => downloadChat(messages)}
            disabled={!messages.length}
            aria-label="Download chat"
            title="Download chat"
          >
            <Download size={18} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Close chat" title="Close chat">
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat-empty">
            Messages go straight to the people in this call and are never stored. Download the chat if you
            want to keep it.
          </p>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const grouped = prev && prev.from === m.from && m.ts - prev.ts < 120_000;
            return (
              <div key={m.id} className={`msg ${m.self ? "msg-self" : ""} ${grouped ? "msg-grouped" : ""}`}>
                {!grouped && (
                  <div className="msg-meta">
                    <span>{m.self ? "You" : m.name}</span>
                    <time>{formatTime(m.ts)}</time>
                  </div>
                )}
                <div className="msg-body">
                  <Linkified text={m.text} />
                </div>
              </div>
            );
          })
        )}
      </div>

      <form className="chat-form" onSubmit={submit}>
        <textarea
          ref={inputRef}
          className="input"
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={2000}
          placeholder="Write a message"
          aria-label="Message"
        />
        <button className="icon-btn accent" type="submit" disabled={!draft.trim()} aria-label="Send message">
          <Send size={18} />
        </button>
      </form>
    </aside>
  );
}
