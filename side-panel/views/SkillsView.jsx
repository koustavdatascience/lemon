/**
 * SkillsView — Slice 15: One-Click Skills (Save, Run, Import, Export)
 *
 * Features:
 *   • List all saved skills with Run / Edit / Delete
 *   • Create / edit modal — name + prompt template
 *   • Run skill — streams result into an inline output panel
 *   • Export skills — JSON file download (edge case 16.7: scan for key-shaped strings before export)
 *   • Import skills — JSON file picker with merge/overwrite prompt (edge case 15.2)
 *   • Undo delete — session-scoped buffer for last 3 deletions (edge case 15.5)
 *
 * Streaming uses the same "ai-stream" long-lived port as ChatView.
 *
 * Edge cases:
 *   15.1 Malformed import JSON    → parse error shown, no data overwritten
 *   15.2 Duplicate IDs on import  → user chooses Merge (keep both) or Overwrite
 *   15.3 Large skill + large page → SW truncates page context; meta.truncated flag
 *   15.4 No page content          → SW warns; skill runs without grounding
 *   15.5 Accidental delete        → Undo toast for last 3 deleted skills
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import SkillChip from "../components/SkillChip.jsx";
import { useAppContext } from "../App.jsx";

// ─── Port (reuses the existing "ai-stream" port pattern) ──────────────────────

let _port = null;
function getPort() {
  if (!_port) {
    _port = chrome.runtime.connect({ name: "ai-stream" });
    _port.onDisconnect.addListener(() => { _port = null; });
  }
  return _port;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId() {
  return `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const STORAGE_KEY = "skills";

async function loadSkills() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      resolve(chrome.runtime.lastError ? [] : (result?.[STORAGE_KEY] ?? []));
    });
  });
}

async function saveSkills(skills) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: skills }, () => {
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve();
    });
  });
}

// ─── Root component ────────────────────────────────────────────────────────────

export default function SkillsView() {
  const { language } = useAppContext();

  const [skills,      setSkills]      = useState([]);
  const [loaded,      setLoaded]      = useState(false);

  // Create / edit modal
  const [modalOpen,   setModalOpen]   = useState(false);
  const [editSkill,   setEditSkill]   = useState(null);   // null = create, object = edit

  // Running state
  const [running,     setRunning]     = useState(false);
  const [runOutput,   setRunOutput]   = useState("");     // streamed text
  const [runMeta,     setRunMeta]     = useState(null);   // { skillName, truncated, noContent }
  const [runError,    setRunError]    = useState("");
  const [activeSkill, setActiveSkill] = useState(null);

  // Undo delete buffer (edge case 15.5) — session only
  const [undoBuffer,  setUndoBuffer]  = useState([]);     // last 3 deleted skills
  const [undoToast,   setUndoToast]   = useState(null);   // { skill, timerId }

  // Import state
  const [importStatus,  setImportStatus]  = useState(null); // null | "confirm" | "error"
  const [importPayload, setImportPayload] = useState(null); // { toAdd[], toUpdate[] }
  const [importError,   setImportError]   = useState("");
  const importInputRef = useRef(null);

  // Port listener ref
  const portListenerRef = useRef(null);

  // Load from storage on mount
  useEffect(() => {
    loadSkills().then((s) => { setSkills(s); setLoaded(true); });
  }, []);

  // ─── Persist helper ────────────────────────────────────────────────────────
  async function persistSkills(updated) {
    setSkills(updated);
    try { await saveSkills(updated); } catch { /* non-fatal */ }
  }

  // ─── Create / Edit ─────────────────────────────────────────────────────────
  function openCreate() { setEditSkill(null); setModalOpen(true); }
  function openEdit(skill) { setEditSkill(skill); setModalOpen(true); }

  async function handleModalSave(data) {
    const isNew  = !editSkill;
    const skill  = {
      id:        isNew ? generateId() : editSkill.id,
      name:      data.name.trim(),
      prompt:    data.prompt.trim(),
      createdAt: isNew ? Date.now() : (editSkill.createdAt ?? Date.now()),
      updatedAt: Date.now(),
    };

    const updated = isNew
      ? [...skills, skill]
      : skills.map((s) => s.id === skill.id ? skill : s);

    await persistSkills(updated);
    setModalOpen(false);
  }

  // ─── Delete with undo (edge case 15.5) ────────────────────────────────────
  async function handleDelete(skill) {
    const updated = skills.filter((s) => s.id !== skill.id);
    await persistSkills(updated);

    // Keep last 3 in undo buffer
    setUndoBuffer((prev) => [skill, ...prev].slice(0, 3));

    // Show toast
    if (undoToast?.timerId) clearTimeout(undoToast.timerId);
    const timerId = setTimeout(() => setUndoToast(null), 5000);
    setUndoToast({ skill, timerId });
  }

  async function handleUndo() {
    if (!undoToast?.skill) return;
    clearTimeout(undoToast.timerId);
    const restored = undoToast.skill;
    setUndoToast(null);

    const updated = [...skills, restored].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    await persistSkills(updated);
  }

  // ─── Run skill ─────────────────────────────────────────────────────────────
  const handleRun = useCallback((skill) => {
    setActiveSkill(skill);
    setRunOutput("");
    setRunMeta(null);
    setRunError("");
    setRunning(true);

    // Detach any prior listener
    if (portListenerRef.current && _port) {
      _port.onMessage.removeListener(portListenerRef.current);
      portListenerRef.current = null;
    }

    const port = getPort();
    let buffer = "";

    function onPortMsg(msg) {
      switch (msg.type) {
        case "status":
          // status messages are brief — show in the output area until real tokens arrive
          if (!buffer) setRunOutput(msg.text ?? "");
          break;
        case "token":
          buffer += msg.text;
          setRunOutput(buffer);
          break;
        case "done":
          setRunning(false);
          setRunMeta(msg.meta ?? null);
          port.onMessage.removeListener(onPortMsg);
          portListenerRef.current = null;
          break;
        case "error":
          setRunError(msg.message ?? "An error occurred.");
          setRunning(false);
          port.onMessage.removeListener(onPortMsg);
          portListenerRef.current = null;
          break;
        default:
          break;
      }
    }

    portListenerRef.current = onPortMsg;
    port.onMessage.addListener(onPortMsg);

    // Get active tab then send
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs?.[0]?.id ?? null;
      port.postMessage({ type: "run-skill", skill, tabId, language });
    });
  }, [language]);

  // ─── Export ────────────────────────────────────────────────────────────────
  function handleExport() {
    if (skills.length === 0) return;

    // Edge case 16.7: scan for key-shaped strings (40+ char alphanumeric)
    const json = JSON.stringify(skills, null, 2);
    const keyPattern = /[A-Za-z0-9_\-]{40,}/g;
    const suspiciousMatches = json.match(keyPattern) ?? [];
    // Filter to things that look like API keys (start with common prefixes)
    const likelyKeys = suspiciousMatches.filter(
      (m) => /^(AIza|gsk_|sk-|Bearer\s)/i.test(m)
    );

    if (likelyKeys.length > 0) {
      const proceed = window.confirm(
        `⚠️ One or more skill prompts may contain an API key or token.\n\nExporting will include it in the file. Continue?`
      );
      if (!proceed) return;
    }

    const blob = new Blob([json], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `lemon-skills-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─── Import ────────────────────────────────────────────────────────────────
  function handleImportClick() {
    importInputRef.current?.click();
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset so re-selecting the same file fires onChange again
    e.target.value = "";

    const reader = new FileReader();
    reader.onload = (ev) => {
      let parsed;
      try {
        parsed = JSON.parse(ev.target.result);
      } catch {
        // Edge case 15.1
        setImportError("Invalid file — could not parse JSON.");
        setImportStatus("error");
        return;
      }

      if (!Array.isArray(parsed)) {
        setImportError("Invalid format — expected a JSON array of skills.");
        setImportStatus("error");
        return;
      }

      // Validate minimal shape
      const valid = parsed.filter(
        (s) => s && typeof s.id === "string" && typeof s.name === "string" && typeof s.prompt === "string"
      );

      if (valid.length === 0) {
        setImportError("No valid skills found in the file.");
        setImportStatus("error");
        return;
      }

      // Edge case 15.2: detect duplicates
      const existingIds = new Set(skills.map((s) => s.id));
      const toUpdate    = valid.filter((s) => existingIds.has(s.id));
      const toAdd       = valid.filter((s) => !existingIds.has(s.id));

      if (toUpdate.length > 0) {
        setImportPayload({ toAdd, toUpdate, all: valid });
        setImportStatus("confirm");
      } else {
        // No conflicts — import directly
        doImport(toAdd, []);
      }
    };
    reader.readAsText(file);
  }

  async function doImport(toAdd, toUpdate) {
    // Build merged list: replace updated skills, append new ones
    const updatedIds = new Set(toUpdate.map((s) => s.id));
    const base = skills.map((s) => updatedIds.has(s.id) ? toUpdate.find((u) => u.id === s.id) : s);
    const merged = [...base, ...toAdd];
    await persistSkills(merged);
    setImportStatus(null);
    setImportPayload(null);
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  if (!loaded) {
    return (
      <div id="panel-skills" role="tabpanel" aria-labelledby="tab-skills"
        className="flex items-center justify-center h-full text-sm text-gray-400">
        Loading skills…
      </div>
    );
  }

  return (
    <div id="panel-skills" role="tabpanel" aria-labelledby="tab-skills"
      className="flex flex-col h-full overflow-hidden">

      {/* ── Toolbar ── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 shrink-0">
        <button
          type="button"
          onClick={openCreate}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-lemon-400 hover:bg-lemon-500 text-gray-900 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600"
        >
          + New skill
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleExport}
          disabled={skills.length === 0}
          title="Export skills to JSON"
          className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-40"
        >
          ↓ Export
        </button>
        <button
          type="button"
          onClick={handleImportClick}
          title="Import skills from JSON"
          className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          ↑ Import
        </button>
        {/* Hidden file input */}
        <input
          ref={importInputRef}
          type="file"
          accept=".json,application/json"
          onChange={handleFileChange}
          className="hidden"
          aria-hidden="true"
        />
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-4">

        {/* ── Skills list ── */}
        {skills.length === 0 ? (
          <EmptyState onCreate={openCreate} />
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                isActive={activeSkill?.id === skill.id}
                onRun={handleRun}
                onEdit={openEdit}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}

        {/* ── Run output panel ── */}
        {(running || runOutput || runError) && activeSkill && (
          <RunOutputPanel
            skill={activeSkill}
            output={runOutput}
            meta={runMeta}
            error={runError}
            running={running}
            onClose={() => { setRunOutput(""); setRunMeta(null); setRunError(""); setActiveSkill(null); }}
          />
        )}
      </div>

      {/* ── Undo toast (edge case 15.5) ── */}
      {undoToast && (
        <div
          role="status"
          aria-live="polite"
          className="mx-3 mb-3 flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-gray-800 text-white text-xs shadow-lg"
        >
          <span>Deleted "<strong>{undoToast.skill.name}</strong>"</span>
          <button
            type="button"
            onClick={handleUndo}
            className="font-semibold text-lemon-300 hover:text-lemon-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-400"
          >
            Undo
          </button>
        </div>
      )}

      {/* ── Import confirm dialog (edge case 15.2) ── */}
      {importStatus === "confirm" && importPayload && (
        <ImportConfirmModal
          payload={importPayload}
          onMerge={() => doImport(importPayload.toAdd, [])}
          onOverwrite={() => doImport(importPayload.toAdd, importPayload.toUpdate)}
          onCancel={() => { setImportStatus(null); setImportPayload(null); }}
        />
      )}

      {/* ── Import error (edge case 15.1) ── */}
      {importStatus === "error" && (
        <div className="mx-3 mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-center justify-between">
          <span>{importError}</span>
          <button type="button" onClick={() => setImportStatus(null)} className="ml-2 text-red-400 hover:text-red-700 text-base leading-none">×</button>
        </div>
      )}

      {/* ── Create / Edit modal ── */}
      {modalOpen && (
        <SkillModal
          skill={editSkill}
          onSave={handleModalSave}
          onClose={() => setModalOpen(false)}
        />
      )}
    </div>
  );
}

// ─── SkillRow ─────────────────────────────────────────────────────────────────

function SkillRow({ skill, isActive, onRun, onEdit, onDelete }) {
  return (
    <div
      className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-colors ${
        isActive
          ? "border-lemon-400 bg-lemon-50"
          : "border-gray-200 bg-white hover:bg-gray-50"
      }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-800 truncate">{skill.name}</p>
        <p className="text-xs text-gray-400 truncate mt-0.5">{skill.prompt}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => onRun(skill)}
          title={`Run "${skill.name}"`}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium bg-lemon-400 hover:bg-lemon-500 text-gray-900 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600"
        >
          ⚡ Run
        </button>
        <button
          type="button"
          onClick={() => onEdit(skill)}
          aria-label={`Edit "${skill.name}"`}
          title="Edit"
          className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          ✏️
        </button>
        <button
          type="button"
          onClick={() => onDelete(skill)}
          aria-label={`Delete "${skill.name}"`}
          title="Delete"
          className="p-1.5 text-gray-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}

// ─── Run output panel ─────────────────────────────────────────────────────────

function RunOutputPanel({ skill, output, meta, error, running, onClose }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-lemon-300 bg-lemon-50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 pt-3">
        <span className="text-xs font-semibold text-lemon-700">
          ⚡ {skill.name}
          {running && <span className="ml-1 text-gray-400 font-normal animate-pulse">Running…</span>}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close output"
          className="text-gray-400 hover:text-gray-700 text-base leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
        >
          ×
        </button>
      </div>

      {/* Caveats */}
      {meta?.noContent && (
        <p className="px-3 text-xs text-amber-700 bg-amber-50 py-1 border-t border-amber-200">
          ⚠️ No readable page content — skill ran without page grounding.
        </p>
      )}
      {meta?.truncated && (
        <p className="px-3 text-xs text-gray-500">
          ℹ️ Page content was shortened to fit the skill prompt.
        </p>
      )}

      {/* Output */}
      <div className="px-3 pb-3 max-h-72 overflow-y-auto">
        {error ? (
          <p className="text-sm text-red-600">{error}</p>
        ) : (
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans leading-relaxed">
            {output || (running ? "" : "(no output)")}
          </pre>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Skill modal (create / edit) ──────────────────────────────────────────────

function SkillModal({ skill, onSave, onClose }) {
  const [name,   setName]   = useState(skill?.name   ?? "");
  const [prompt, setPrompt] = useState(skill?.prompt ?? "");
  const [error,  setError]  = useState("");
  const nameRef = useRef(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim())   { setError("Skill name is required."); return; }
    if (!prompt.trim()) { setError("Prompt is required."); return; }
    onSave({ name, prompt });
  }

  function onKeyDown(e) {
    if (e.key === "Escape") onClose();
  }

  return (
    /* Backdrop */
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label={skill ? "Edit skill" : "Create skill"}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={onKeyDown}
    >
      <div className="w-full max-w-sm bg-white rounded-t-2xl shadow-xl p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-800">
          {skill ? "Edit skill" : "New skill"}
        </h2>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="skill-name" className="text-xs font-medium text-gray-600">Name</label>
            <input
              id="skill-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Exam notes"
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="skill-prompt" className="text-xs font-medium text-gray-600">Prompt</label>
            <textarea
              id="skill-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              placeholder={`e.g. "Summarise this page as structured exam notes with headings, key terms, and 5 practice questions."`}
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-lemon-400 transition placeholder:text-gray-400"
            />
            <p className="text-xs text-gray-400">
              This prompt will be applied to the current page when you run the skill.
            </p>
          </div>

          {error && (
            <p className="text-xs text-red-600" role="alert">{error}</p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              className="flex-1 py-2 bg-lemon-400 hover:bg-lemon-500 text-gray-900 text-sm font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600"
            >
              {skill ? "Save changes" : "Create"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Import confirm modal (edge case 15.2) ────────────────────────────────────

function ImportConfirmModal({ payload, onMerge, onOverwrite, onCancel }) {
  const { toAdd, toUpdate } = payload;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog" aria-modal="true" aria-label="Import conflict">
      <div className="w-full max-w-sm bg-white rounded-t-2xl shadow-xl p-5 flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-gray-800">Import conflict</h2>
        <p className="text-xs text-gray-600">
          {toUpdate.length} skill{toUpdate.length !== 1 ? "s" : ""} already exist
          {toUpdate.length !== 1 ? "" : "s"} with the same ID.
          {toAdd.length > 0 && ` ${toAdd.length} new skill${toAdd.length !== 1 ? "s" : ""} will be added.`}
        </p>
        <ul className="text-xs text-gray-500 list-disc list-inside">
          {toUpdate.map((s) => <li key={s.id}>{s.name}</li>)}
        </ul>
        <div className="flex flex-col gap-2">
          <button type="button" onClick={onMerge}
            className="py-2 bg-lemon-400 hover:bg-lemon-500 text-gray-900 text-sm font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600">
            Keep both (add new only)
          </button>
          <button type="button" onClick={onOverwrite}
            className="py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400">
            Overwrite existing
          </button>
          <button type="button" onClick={onCancel}
            className="py-2 text-xs text-gray-400 hover:text-gray-600 focus:outline-none">
            Cancel import
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onCreate }) {
  return (
    <div className="flex flex-col items-center gap-4 py-10 text-center">
      <span className="text-4xl" aria-hidden="true">⚡</span>
      <div>
        <p className="text-sm font-medium text-gray-600">No skills yet</p>
        <p className="text-xs text-gray-400 mt-1 max-w-48 mx-auto">
          Save a reusable prompt recipe — run it on any page with one click.
        </p>
      </div>
      <button
        type="button"
        onClick={onCreate}
        className="px-4 py-2 text-sm font-medium bg-lemon-400 hover:bg-lemon-500 text-gray-900 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600"
      >
        Create your first skill
      </button>
      <div className="text-xs text-gray-400 space-y-1">
        <p className="font-medium text-gray-500">Example skills:</p>
        <p>"Exam notes — headings, key terms, 5 practice questions"</p>
        <p>"Fill this form from my profile"</p>
        <p>"Translate this page to English"</p>
        <p>"Extract all links and their descriptions"</p>
      </div>
    </div>
  );
}
