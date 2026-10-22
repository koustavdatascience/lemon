import React from "react";

/**
 * MessageBubble
 * Renders a single chat turn.
 *
 * Props:
 *   role     : "user" | "assistant"
 *   content  : string   — the message text (may contain markdown-lite formatting)
 *   streaming: boolean  — when true, show a blinking cursor at the end
 */
export default function MessageBubble({ role, content, streaming = false }) {
  const isUser = role === "user";

  return (
    <div
      className={`flex w-full ${isUser ? "justify-end" : "justify-start"}`}
      role="listitem"
    >
      {/* Avatar — only for assistant */}
      {!isUser && (
        <span
          className="shrink-0 mr-2 mt-1 text-base leading-none select-none"
          aria-hidden="true"
        >
          🍋
        </span>
      )}

      <div
        className={`
          max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words
          ${isUser
            ? "bg-lemon-400 text-gray-900 rounded-br-sm"
            : "bg-gray-100 text-gray-800 rounded-bl-sm"
          }
        `}
      >
        {content}
        {/* Blinking cursor while streaming */}
        {streaming && (
          <span
            aria-hidden="true"
            className="inline-block w-0.5 h-3.5 bg-gray-500 ml-0.5 align-middle animate-pulse"
          />
        )}
      </div>
    </div>
  );
}
