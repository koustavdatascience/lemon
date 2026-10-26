/**
 * ActionCard.jsx — Slice 12
 *
 * Displays a single pending agent action and lets the user
 * Approve, Skip, or Stop the agent.
 *
 * Props:
 *   proposal  — { action, elementId, value, reason, element, step }
 *   onApprove — () => void
 *   onSkip    — () => void
 *   onStop    — () => void
 *   busy      — bool  (buttons disabled while SW processes the decision)
 */

import React from "react";

// Human-readable labels per action type
const ACTION_LABELS = {
  click:  "Click",
  type:   "Type into",
  select: "Select in",
  scroll: "Scroll",
  done:   "Mark complete",
};

const ACTION_ICONS = {
  click:  "🖱️",
  type:   "⌨️",
  select: "🔽",
  scroll: "📜",
  done:   "✅",
};

export default function ActionCard({ proposal, onApprove, onSkip, onStop, busy }) {
  if (!proposal) return null;

  const { action, elementId, value, reason, element, step, needsConfirm, confirmReason } = proposal;

  const actionLabel  = ACTION_LABELS[action] ?? action;
  const actionIcon   = ACTION_ICONS[action]  ?? "⚙️";
  const elementLabel = element?.label || (elementId ? `Element #${elementId}` : null);
  const elementType  = element?.type;

  return (
    <div
      className="flex flex-col gap-3 p-3 rounded-xl border border-lemon-300 bg-lemon-50"
      role="region"
      aria-label={`Proposed action: ${actionLabel}`}
    >
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          Step {step}
        </span>
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          aria-label="Stop the agent"
          className="text-xs text-red-500 hover:text-red-700 font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 disabled:opacity-50"
        >
          ■ Stop
        </button>
      </div>

      {/* ── Safety confirmation banner (Slice 16) ── */}
      {needsConfirm && (
        <div className="flex items-start gap-2 px-2 py-2 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-800">
          <span className="shrink-0 text-base" aria-hidden="true">⚠️</span>
          <p>{confirmReason || "This action may be consequential. Please confirm before proceeding."}</p>
        </div>
      )}

      {/* ── Action description ── */}
      <div className="flex items-start gap-2">
        <span className="text-xl shrink-0" aria-hidden="true">{actionIcon}</span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <p className="text-sm font-semibold text-gray-800">
            {actionLabel}
            {elementLabel && (
              <>
                {" "}
                <span className="font-normal text-gray-600">"{elementLabel}"</span>
              </>
            )}
            {elementType && (
              <span className="ml-1 text-xs text-gray-400 font-normal capitalize">
                ({elementType})
              </span>
            )}
          </p>

          {/* Value preview for type / select */}
          {value != null && (
            <p className="text-xs text-gray-500 mt-0.5">
              Value:{" "}
              <span className="font-mono bg-gray-100 px-1 rounded text-gray-700">
                {String(value).length > 60 ? String(value).slice(0, 60) + "…" : String(value)}
              </span>
            </p>
          )}

          {/* Element badge */}
          {elementId && (
            <div className="flex items-center gap-1 mt-1">
              <span
                className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-lemon-400 text-gray-900 font-bold text-xs shadow-sm"
                aria-label={`Element ${elementId}`}
              >
                {elementId}
              </span>
              <span className="text-xs text-gray-400">on page</span>
            </div>
          )}
        </div>
      </div>

      {/* ── AI reason ── */}
      <p className="text-xs text-gray-600 leading-relaxed italic border-l-2 border-lemon-300 pl-2">
        {reason}
      </p>

      {/* ── Decision buttons ── */}
      <div className="flex gap-2 pt-1">
        <button
          type="button"
          onClick={onApprove}
          disabled={busy}
          className="flex-1 py-2 rounded-lg bg-lemon-400 hover:bg-lemon-500 text-gray-900 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          ✓ Approve
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="flex-1 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          → Skip
        </button>
      </div>
    </div>
  );
}
