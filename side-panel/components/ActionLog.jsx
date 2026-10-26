/**
 * ActionLog.jsx — Slice 12
 *
 * Scrollable running log of every step taken by the agent.
 * Each entry shows: step number, action type, element label,
 * the AI's reason, and the user's decision (approved / skipped / error).
 *
 * Props:
 *   log — array of log entries from agent-engine.js
 *         Each entry:
 *           { step, action, elementId, value, reason, element,
 *             decision: "approved"|"skipped"|"error"|"paused"|"limit",
 *             message?, ts }
 */

import React, { useRef, useEffect } from "react";

const DECISION_STYLES = {
  approved: { dot: "bg-green-500",  label: "Approved", textClass: "text-green-700" },
  skipped:  { dot: "bg-yellow-400", label: "Skipped",  textClass: "text-yellow-700" },
  error:    { dot: "bg-red-500",    label: "Error",    textClass: "text-red-600"   },
  paused:   { dot: "bg-gray-400",   label: "Paused",   textClass: "text-gray-500"  },
  limit:    { dot: "bg-orange-400", label: "Limit hit",textClass: "text-orange-600"},
};

const ACTION_ICONS = {
  click:  "🖱️",
  type:   "⌨️",
  select: "🔽",
  scroll: "📜",
  done:   "✅",
  error:  "⚠️",
  paused: "⏸️",
  limit:  "⏱️",
};

export default function ActionLog({ log }) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom when a new entry is added
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log?.length]);

  if (!log || log.length === 0) return null;

  return (
    <div className="flex flex-col gap-1" aria-label="Agent action log" role="log" aria-live="polite">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        Log
      </h3>
      <ol className="flex flex-col gap-1.5">
        {log.map((entry, i) => (
          <LogEntry key={i} entry={entry} />
        ))}
      </ol>
      <div ref={bottomRef} aria-hidden="true" />
    </div>
  );
}

function LogEntry({ entry }) {
  const {
    step,
    action,
    decision,
    reason,
    element,
    elementId,
    value,
    message,
  } = entry;

  // Special system entries (error, paused, limit) that aren't real actions
  const isSystem = !action || ["error", "paused", "limit"].includes(action);

  const decisionStyle = DECISION_STYLES[decision] ?? DECISION_STYLES.error;
  const icon = ACTION_ICONS[isSystem ? (action ?? "error") : action] ?? "⚙️";

  const elementLabel = element?.label || (elementId ? `#${elementId}` : null);

  return (
    <li className="flex items-start gap-2 py-1.5 px-2 rounded-lg bg-gray-50 border border-gray-100 text-xs">
      {/* Step number */}
      <span className="shrink-0 font-mono text-gray-400 w-5 text-right">
        {step ?? "—"}
      </span>

      {/* Icon */}
      <span className="shrink-0" aria-hidden="true">{icon}</span>

      {/* Content */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {isSystem ? (
          <span className="text-gray-600">{message ?? decision}</span>
        ) : (
          <>
            <span className="text-gray-700 font-medium capitalize">
              {action}
              {elementLabel && (
                <span className="font-normal text-gray-500"> "{elementLabel}"</span>
              )}
              {value != null && (
                <span className="font-normal text-gray-400">
                  {" → "}
                  <span className="font-mono bg-gray-100 px-0.5 rounded">
                    {String(value).length > 30 ? String(value).slice(0, 30) + "…" : String(value)}
                  </span>
                </span>
              )}
            </span>
            {reason && (
              <span className="text-gray-400 italic">{reason}</span>
            )}
          </>
        )}
      </div>

      {/* Decision badge */}
      {decision && (
        <span
          className={`shrink-0 flex items-center gap-1 font-medium ${decisionStyle.textClass}`}
          aria-label={`Decision: ${decisionStyle.label}`}
        >
          <span className={`inline-block w-1.5 h-1.5 rounded-full ${decisionStyle.dot}`} />
          {decisionStyle.label}
        </span>
      )}
    </li>
  );
}
