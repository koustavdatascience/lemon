/**
 * SkillChip.jsx — Slice 15
 *
 * Compact pill button for a saved skill. Used in the SkillsView header
 * for quick-access and can be embedded anywhere chips are needed.
 *
 * Props:
 *   skill     — { id, name, prompt, createdAt }
 *   onRun     — (skill) => void
 *   onEdit    — (skill) => void   (optional — omit to hide edit affordance)
 *   onDelete  — (skill) => void   (optional)
 *   compact   — bool  if true, show only the name + run icon (no edit/delete)
 */
import React from "react";

export default function SkillChip({ skill, onRun, onEdit, onDelete, compact = false }) {
  if (!skill) return null;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onRun?.(skill)}
        title={`Run: ${skill.name}`}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full bg-lemon-100 hover:bg-lemon-300 text-lemon-800 border border-lemon-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500 whitespace-nowrap"
      >
        <span aria-hidden="true">⚡</span>
        {skill.name}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      {/* Run */}
      <button
        type="button"
        onClick={() => onRun?.(skill)}
        className="flex-1 min-w-0 flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-l-full bg-lemon-100 hover:bg-lemon-300 text-lemon-800 border border-lemon-300 border-r-0 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500 truncate"
        title={`Run "${skill.name}"`}
      >
        <span aria-hidden="true" className="shrink-0">⚡</span>
        <span className="truncate">{skill.name}</span>
      </button>

      {/* Edit */}
      {onEdit && (
        <button
          type="button"
          onClick={() => onEdit(skill)}
          aria-label={`Edit "${skill.name}"`}
          className="px-1.5 py-1 text-xs text-gray-400 hover:text-gray-700 border border-lemon-300 border-l-0 border-r-0 bg-lemon-50 hover:bg-lemon-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
        >
          ✏️
        </button>
      )}

      {/* Delete */}
      {onDelete && (
        <button
          type="button"
          onClick={() => onDelete(skill)}
          aria-label={`Delete "${skill.name}"`}
          className="px-1.5 py-1 text-xs text-gray-400 hover:text-red-500 border border-lemon-300 border-l-0 rounded-r-full bg-lemon-50 hover:bg-red-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          ×
        </button>
      )}
    </div>
  );
}
