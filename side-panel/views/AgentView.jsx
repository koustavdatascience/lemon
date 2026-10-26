/**
 * AgentView — Slice 13: Persistence, Dry-Run, Step Limit, Full Log
 *
 * Builds on the Slice 12 agent loop and adds:
 *   • Dry-run toggle — proposes actions but never mutates the DOM
 *   • Step counter   — "Step N / MAX" shown while running
 *   • Custom step limit — user-adjustable (default 20, range 1–50)
 *   • Full paginated log — shows last LOG_PAGE_SIZE entries; "Show all" expands
 *   • Restore on mount  — if the SW has a pending action-proposal waiting
 *     (e.g. Chrome restarted mid-task) the panel re-hydrates automatically
 *
 * Two modes via a top tab strip:
 *   • 🔍 Find  — highlight a single element (Slice 11)
 *   • 🤖 Agent — approval-gated multi-step task (Slice 12/13)
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAppContext } from "../App.jsx";
import ActionCard from "../components/ActionCard.jsx";
import ActionLog  from "../components/ActionLog.jsx";

// ─── Constants ─────────────────────────────────────────────────────────────────

const MODE = { FIND: "find", AGENT: "agent" };
const DEFAULT_MAX_STEPS = 20;

const AGENT_STATUS = {
  IDLE:             "idle",
  STARTING:         "starting",
  RUNNING:          "running",
  WAITING_APPROVAL: "waiting_approval",
  DONE:             "done",
  STOPPED:          "stopped",
  ERROR:            "error",
};

const FIND_STATUS = {
  IDLE:    "idle",
  LOADING: "loading",
  FOUND:   "found",
  ERROR:   "error",
};

// ─── Root component ────────────────────────────────────────────────────────────

export default function AgentView() {
  const { language } = useAppContext();

  // ── Shared ────────────────────────────────────────────────────────────────
  const [mode,  setMode]  = useState(MODE.FIND);
  const [tabId, setTabId] = useState(null);

  // ── Find mode ─────────────────────────────────────────────────────────────
  const [findQuestion, setFindQuestion] = useState("");
  const [findStatus,   setFindStatus]   = useState(FIND_STATUS.IDLE);
  const [findResult,   setFindResult]   = useState(null);
  const [findError,    setFindError]    = useState("");
  const findInputRef = useRef(null);

  // ── Agent mode ────────────────────────────────────────────────────────────
  const [agentTask,     setAgentTask]     = useState("");
  const [agentStatus,   setAgentStatus]   = useState(AGENT_STATUS.IDLE);
  const [agentStep,     setAgentStep]     = useState(0);
  const [agentMaxSteps, setAgentMaxSteps] = useState(DEFAULT_MAX_STEPS);  // Slice 13
  const [agentDryRun,   setAgentDryRun]   = useState(false);              // Slice 13
  const [agentProposal, setAgentProposal] = useState(null);
  const [agentLog,      setAgentLog]      = useState([]);
  const [agentError,    setAgentError]    = useState("");
  const [decisionBusy,  setDecisionBusy]  = useState(false);
  const [restoredTask,  setRestoredTask]  = useState(null);  // Slice 13: task name of restored session
  const taskInputRef = useRef(null);

  // ─── Resolve active tab ────────────────────────────────────────────────────
  useEffect(() => {
    function resolveTab() {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (chrome.runtime.lastError || !tabs?.[0]?.id) return;
        setTabId(tabs[0].id);
      });
    }
    resolveTab();
    window.addEventListener("focus", resolveTab);
    return () => window.removeEventListener("focus", resolveTab);
  }, []);

  // ─── Slice 13: restore pending state on mount ─────────────────────────────
  // If the SW restarted mid-task, it will have re-emitted an action-proposal
  // via the message listener below. But the panel may have opened BEFORE the
  // SW sent that. So we also read from storage directly on mount to check.
  useEffect(() => {
    chrome.storage.local.get("agentState", (result) => {
      if (chrome.runtime.lastError) return;
      const saved = result?.agentState;
      if (!saved || saved.status !== "waiting_approval") return;

      // Pre-populate UI from the saved snapshot
      setAgentTask(saved.task ?? "");
      setAgentStep(saved.step ?? 0);
      setAgentMaxSteps(saved.maxSteps ?? DEFAULT_MAX_STEPS);
      setAgentDryRun(saved.dryRun ?? false);
      setAgentLog(saved.log ?? []);
      setRestoredTask(saved.task ?? null);

      if (saved.pendingAction) {
        setAgentProposal({
          action:    saved.pendingAction.action,
          elementId: saved.pendingAction.elementId,
          value:     saved.pendingAction.value,
          reason:    saved.pendingAction.reason,
          element:   saved.pendingAction.element,
          step:      saved.step,
        });
        setAgentStatus(AGENT_STATUS.WAITING_APPROVAL);
        // Switch to agent tab so the user sees the pending action
        setMode(MODE.AGENT);
      }
    });
  }, []); // run once on mount

  // ─── Agent engine push messages ───────────────────────────────────────────
  useEffect(() => {
    function onMessage(msg) {
      switch (msg.type) {

        case "agent-restored":
          // SW broadcast its restore; already handled by storage read above
          // but update maxSteps/dryRun in case they differ
          if (msg.maxSteps) setAgentMaxSteps(msg.maxSteps);
          if (msg.dryRun   !== undefined) setAgentDryRun(msg.dryRun);
          if (msg.task)     setRestoredTask(msg.task);
          if (msg.log)      setAgentLog(msg.log);
          break;

        case "agent-status":
          setAgentStatus(
            msg.status === "running" ? AGENT_STATUS.RUNNING : msg.status
          );
          if (msg.step     !== undefined) setAgentStep(msg.step);
          if (msg.maxSteps !== undefined) setAgentMaxSteps(msg.maxSteps);
          if (msg.dryRun   !== undefined) setAgentDryRun(msg.dryRun);
          setAgentError("");
          setRestoredTask(null);
          break;

        case "action-proposal":
          setAgentStatus(AGENT_STATUS.WAITING_APPROVAL);
          setAgentStep(msg.step);
          setAgentProposal({
            action:        msg.action,
            elementId:     msg.elementId,
            value:         msg.value,
            reason:        msg.reason,
            element:       msg.element,
            step:          msg.step,
            needsConfirm:  msg.needsConfirm  ?? false,
            confirmReason: msg.confirmReason ?? "",
          });
          if (msg.log) setAgentLog(msg.log);
          setDecisionBusy(false);
          break;

        case "agent-done":
          setAgentStatus(AGENT_STATUS.DONE);
          setAgentProposal(null);
          setDecisionBusy(false);
          setRestoredTask(null);
          break;

        case "agent-stopped":
          setAgentStatus(AGENT_STATUS.STOPPED);
          setAgentProposal(null);
          setDecisionBusy(false);
          setRestoredTask(null);
          break;

        case "agent-error":
          setAgentStatus(AGENT_STATUS.ERROR);
          setAgentError(msg.message ?? "An unknown error occurred.");
          setAgentProposal(null);
          setDecisionBusy(false);
          setRestoredTask(null);
          break;

        default:
          break;
      }
    }

    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // ─── Find handlers ────────────────────────────────────────────────────────

  function handleFindSubmit(e) {
    e?.preventDefault();
    const q = findQuestion.trim();
    if (!q) { findInputRef.current?.focus(); return; }

    setFindStatus(FIND_STATUS.LOADING);
    setFindResult(null);
    setFindError("");

    chrome.runtime.sendMessage(
      { type: "find-element", question: q, tabId, language },
      (response) => {
        if (chrome.runtime.lastError) {
          setFindStatus(FIND_STATUS.ERROR);
          setFindError("⚠️ Could not reach the extension background. Try reloading.");
          return;
        }
        if (!response?.ok) {
          setFindStatus(FIND_STATUS.ERROR);
          setFindError(response?.error ?? "Something went wrong. Please try again.");
          return;
        }
        setFindResult(response);
        setFindStatus(FIND_STATUS.FOUND);
      }
    );
  }

  function handleFindClear() {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: "scan-clear-highlight" }, () => { void chrome.runtime.lastError; });
    }
    setFindStatus(FIND_STATUS.IDLE);
    setFindResult(null);
    setFindError("");
    setFindQuestion("");
    setTimeout(() => findInputRef.current?.focus(), 0);
  }

  function handleReHighlight() {
    if (!findResult?.elementId || !tabId) return;
    chrome.tabs.sendMessage(tabId, { type: "scan-highlight", id: findResult.elementId }, () => { void chrome.runtime.lastError; });
  }

  // ─── Agent handlers ───────────────────────────────────────────────────────

  function handleAgentStart(e) {
    e?.preventDefault();
    const task = agentTask.trim();
    if (!task) { taskInputRef.current?.focus(); return; }

    setAgentStatus(AGENT_STATUS.STARTING);
    setAgentProposal(null);
    setAgentLog([]);
    setAgentError("");
    setAgentStep(0);
    setRestoredTask(null);

    chrome.runtime.sendMessage(
      {
        type:     "agent-start",
        task,
        tabId,
        language,
        dryRun:   agentDryRun,   // Slice 13
        maxSteps: agentMaxSteps, // Slice 13
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          setAgentStatus(AGENT_STATUS.ERROR);
          setAgentError(response?.error ?? "Could not start the agent. Try reloading.");
        }
      }
    );
  }

  const handleApprove = useCallback(() => {
    setDecisionBusy(true);
    chrome.runtime.sendMessage({ type: "agent-decision", decision: "approve" }, () => { void chrome.runtime.lastError; });
  }, []);

  const handleSkip = useCallback(() => {
    setDecisionBusy(true);
    chrome.runtime.sendMessage({ type: "agent-decision", decision: "skip" }, () => { void chrome.runtime.lastError; });
  }, []);

  const handleStop = useCallback(() => {
    chrome.runtime.sendMessage({ type: "agent-decision", decision: "stop" }, () => { void chrome.runtime.lastError; });
    setAgentStatus(AGENT_STATUS.STOPPED);
    setAgentProposal(null);
    setDecisionBusy(false);
  }, []);

  function handleAgentReset() {
    setAgentStatus(AGENT_STATUS.IDLE);
    setAgentProposal(null);
    setAgentLog([]);
    setAgentError("");
    setAgentStep(0);
    setAgentTask("");
    setRestoredTask(null);
    setTimeout(() => taskInputRef.current?.focus(), 0);
  }

  // ─── Derived ──────────────────────────────────────────────────────────────

  const agentIsActive =
    agentStatus === AGENT_STATUS.STARTING ||
    agentStatus === AGENT_STATUS.RUNNING  ||
    agentStatus === AGENT_STATUS.WAITING_APPROVAL;

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      id="panel-agent"
      role="tabpanel"
      aria-labelledby="tab-agent"
      className="flex flex-col h-full overflow-hidden"
    >
      {/* ── Mode toggle ── */}
      <div className="flex border-b border-gray-200 shrink-0" role="tablist" aria-label="Agent mode">
        <ModeTab id="mode-find"  label="🔍 Find"  active={mode === MODE.FIND}  onClick={() => setMode(MODE.FIND)} />
        <ModeTab id="mode-agent" label="🤖 Agent" active={mode === MODE.AGENT} onClick={() => setMode(MODE.AGENT)} />
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-y-auto px-4 py-4 flex flex-col gap-4">
        {mode === MODE.FIND && (
          <FindPanel
            question={findQuestion}
            setQuestion={setFindQuestion}
            status={findStatus}
            result={findResult}
            errorMsg={findError}
            inputRef={findInputRef}
            onSubmit={handleFindSubmit}
            onClear={handleFindClear}
            onReHighlight={handleReHighlight}
          />
        )}

        {mode === MODE.AGENT && (
          <AgentPanel
            task={agentTask}
            setTask={setAgentTask}
            status={agentStatus}
            step={agentStep}
            maxSteps={agentMaxSteps}
            setMaxSteps={setAgentMaxSteps}
            dryRun={agentDryRun}
            setDryRun={setAgentDryRun}
            proposal={agentProposal}
            log={agentLog}
            errorMsg={agentError}
            decisionBusy={decisionBusy}
            taskInputRef={taskInputRef}
            agentIsActive={agentIsActive}
            restoredTask={restoredTask}
            onStart={handleAgentStart}
            onApprove={handleApprove}
            onSkip={handleSkip}
            onStop={handleStop}
            onReset={handleAgentReset}
          />
        )}
      </div>
    </div>
  );
}

// ─── Mode tab ─────────────────────────────────────────────────────────────────

function ModeTab({ id, label, active, onClick }) {
  return (
    <button
      id={id}
      role="tab"
      aria-selected={active}
      type="button"
      onClick={onClick}
      className={`flex-1 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-lemon-500 ${
        active
          ? "text-lemon-700 border-b-2 border-lemon-500 bg-lemon-50"
          : "text-gray-500 hover:text-gray-700"
      }`}
    >
      {label}
    </button>
  );
}

// ─── Find panel ───────────────────────────────────────────────────────────────

function FindPanel({ question, setQuestion, status, result, errorMsg, inputRef, onSubmit, onClear, onReHighlight }) {
  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSubmit(); }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-gray-500">
        Ask Lemon to find an element on the page — it will highlight it for you.
      </p>

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor="find-question" className="text-xs font-medium text-gray-600">
          What are you looking for?
        </label>
        <textarea
          id="find-question"
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder={`e.g. "Where do I upload my resume?"`}
          disabled={status === FIND_STATUS.LOADING}
          aria-describedby="find-hint"
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-lemon-500 focus:border-transparent disabled:opacity-60 disabled:bg-gray-50 placeholder:text-gray-400"
        />
        <span id="find-hint" className="text-xs text-gray-400">Press Enter or click Find.</span>

        <div className="flex gap-2">
          <button
            type="submit"
            disabled={status === FIND_STATUS.LOADING || !question.trim()}
            aria-busy={status === FIND_STATUS.LOADING}
            className="flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-lemon-400 hover:bg-lemon-500 text-gray-900 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {status === FIND_STATUS.LOADING ? <><Spinner /> Scanning…</> : <>🔍 Find</>}
          </button>
          {(status === FIND_STATUS.FOUND || status === FIND_STATUS.ERROR) && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear result"
              className="py-2 px-3 rounded-lg border border-gray-300 text-gray-600 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
            >
              Clear
            </button>
          )}
        </div>
      </form>

      {status === FIND_STATUS.FOUND && result && <FindResultCard result={result} onReHighlight={onReHighlight} />}
      {status === FIND_STATUS.ERROR && errorMsg && <ErrorCard message={errorMsg} />}
      {status === FIND_STATUS.IDLE && <FindIdleHint />}
    </div>
  );
}

function FindResultCard({ result, onReHighlight }) {
  const { elementId, reason, element, mapCount, truncated } = result;
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 p-3 rounded-xl border border-lemon-300 bg-lemon-50">
      <div className="flex items-start gap-3">
        <span className="inline-flex items-center justify-center shrink-0 w-7 h-7 rounded-full bg-lemon-400 text-gray-900 font-bold text-sm shadow-sm" aria-label={`Element ${elementId}`}>
          {elementId}
        </span>
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-xs font-semibold text-gray-800 truncate">{element?.label || "(no label)"}</span>
          <span className="text-xs text-gray-500 capitalize">
            {element?.type || "element"}
            {element?.disabled && <span className="ml-1 text-red-500 font-medium">(disabled)</span>}
          </span>
        </div>
      </div>
      <p className="text-sm text-gray-700 leading-relaxed">{reason}</p>
      <button type="button" onClick={onReHighlight} className="self-start text-xs text-lemon-700 hover:text-lemon-900 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500">
        🔆 Highlight again
      </button>
      {truncated && <p className="text-xs text-gray-400">ℹ️ Page has more than 50 elements — only the most visible were scanned.</p>}
      <p className="text-xs text-gray-400">{mapCount} element{mapCount !== 1 ? "s" : ""} scanned on this page.</p>
    </div>
  );
}

function FindIdleHint() {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      <span className="text-4xl" aria-hidden="true">🔍</span>
      <div>
        <p className="text-sm font-medium text-gray-500 mb-1">Try asking:</p>
        <ul className="text-xs text-gray-400 space-y-1">
          <li>"Where do I upload my resume?"</li>
          <li>"Find the search box"</li>
          <li>"Where is the login button?"</li>
          <li>"Which field is for my email?"</li>
        </ul>
      </div>
    </div>
  );
}

// ─── Agent panel ──────────────────────────────────────────────────────────────

function AgentPanel({
  task, setTask, status, step, maxSteps, setMaxSteps, dryRun, setDryRun,
  proposal, log, errorMsg, decisionBusy, taskInputRef, agentIsActive,
  restoredTask, onStart, onApprove, onSkip, onStop, onReset,
}) {
  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onStart(); }
  }

  const showInput    = status === AGENT_STATUS.IDLE;
  const showRunning  = status === AGENT_STATUS.STARTING || status === AGENT_STATUS.RUNNING;
  const showProposal = status === AGENT_STATUS.WAITING_APPROVAL && proposal;
  const showDone     = status === AGENT_STATUS.DONE;
  const showStopped  = status === AGENT_STATUS.STOPPED;
  const showError    = status === AGENT_STATUS.ERROR;

  return (
    <div className="flex flex-col gap-4">

      {/* ── Restored session banner (Slice 13) ── */}
      {restoredTask && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
          <span aria-hidden="true">🔄</span>
          <span>Resumed: <strong className="font-medium">"{restoredTask}"</strong></span>
        </div>
      )}

      {/* ── Task input form (idle only) ── */}
      {showInput && (
        <form onSubmit={onStart} className="flex flex-col gap-3">
          <p className="text-xs text-gray-500">
            Describe a task. Lemon proposes one action at a time and waits for your approval before acting.
          </p>

          <div className="flex flex-col gap-1">
            <label htmlFor="agent-task" className="text-xs font-medium text-gray-600">
              What should Lemon do?
            </label>
            <textarea
              id="agent-task"
              ref={taskInputRef}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              placeholder={`e.g. "Fill in my name and email and click Submit"`}
              aria-describedby="agent-task-hint"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-lemon-500 focus:border-transparent placeholder:text-gray-400"
            />
            <span id="agent-task-hint" className="text-xs text-gray-400">
              Press Enter or click Go — you approve every action before it runs.
            </span>
          </div>

          {/* ── Slice 13 controls ── */}
          <AgentOptions
            dryRun={dryRun}
            setDryRun={setDryRun}
            maxSteps={maxSteps}
            setMaxSteps={setMaxSteps}
          />

          <button
            type="submit"
            disabled={!task.trim()}
            className="py-2 px-4 rounded-lg bg-lemon-400 hover:bg-lemon-500 text-gray-900 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-600 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            🚀 Go
          </button>
        </form>
      )}

      {/* ── Running indicator ── */}
      {showRunning && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <Spinner />
              <span>
                {status === AGENT_STATUS.STARTING
                  ? "Starting…"
                  : <StepCounter step={step} maxSteps={maxSteps} dryRun={dryRun} />}
              </span>
            </div>
            <button type="button" onClick={onStop}
              className="text-xs text-red-500 hover:text-red-700 font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400">
              ■ Stop
            </button>
          </div>
          {log.length > 0 && <ActionLog log={log} />}
        </div>
      )}

      {/* ── Pending action card ── */}
      {showProposal && (
        <div className="flex flex-col gap-3">
          {/* Step counter above action card */}
          <div className="flex items-center justify-between text-xs text-gray-500">
            <StepCounter step={step} maxSteps={maxSteps} dryRun={dryRun} />
          </div>
          <ActionCard proposal={proposal} onApprove={onApprove} onSkip={onSkip} onStop={onStop} busy={decisionBusy} />
          {log.length > 0 && <ActionLog log={log} />}
        </div>
      )}

      {/* ── Done ── */}
      {showDone && (
        <div className="flex flex-col gap-3">
          <div className="p-3 rounded-xl bg-green-50 border border-green-200 text-sm text-green-800 font-medium">
            ✅ Task complete in {step} step{step !== 1 ? "s" : ""}!
          </div>
          {log.length > 0 && <ActionLog log={log} />}
          <button type="button" onClick={onReset}
            className="py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400">
            Start a new task
          </button>
        </div>
      )}

      {/* ── Stopped ── */}
      {showStopped && (
        <div className="flex flex-col gap-3">
          <div className="p-3 rounded-xl bg-gray-50 border border-gray-200 text-sm text-gray-600">
            ■ Task stopped after {step} step{step !== 1 ? "s" : ""}.
          </div>
          {log.length > 0 && <ActionLog log={log} />}
          <button type="button" onClick={onReset}
            className="py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400">
            Start a new task
          </button>
        </div>
      )}

      {/* ── Error ── */}
      {showError && (
        <div className="flex flex-col gap-3">
          <ErrorCard message={errorMsg} />
          {log.length > 0 && <ActionLog log={log} />}
          <button type="button" onClick={onReset}
            className="py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-400">
            Try again
          </button>
        </div>
      )}

      {/* ── Idle hint ── */}
      {showInput && <AgentIdleHint />}
    </div>
  );
}

// ─── Slice 13: AgentOptions (dry-run + step limit) ────────────────────────────

function AgentOptions({ dryRun, setDryRun, maxSteps, setMaxSteps }) {
  function handleMaxStepsChange(e) {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1 && v <= 50) setMaxSteps(v);
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-lg bg-gray-50 border border-gray-200">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Options</p>

      {/* Dry-run toggle */}
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <button
          type="button"
          role="switch"
          aria-checked={dryRun}
          onClick={() => setDryRun((v) => !v)}
          className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500 ${
            dryRun ? "bg-lemon-400" : "bg-gray-300"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow ring-0 transition-transform ${
              dryRun ? "translate-x-4" : "translate-x-0"
            }`}
          />
        </button>
        <span className="text-xs text-gray-700 font-medium">Dry-run</span>
        <span className="text-xs text-gray-400">(propose actions without executing them)</span>
      </label>

      {/* Step limit */}
      <div className="flex items-center gap-2">
        <label htmlFor="max-steps" className="text-xs text-gray-700 font-medium shrink-0">
          Step limit
        </label>
        <input
          id="max-steps"
          type="number"
          min={1}
          max={50}
          value={maxSteps}
          onChange={handleMaxStepsChange}
          className="w-16 px-2 py-1 text-xs border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-lemon-500 text-center"
          aria-label="Maximum number of steps before auto-stop"
        />
        <span className="text-xs text-gray-400">steps (max 50)</span>
      </div>
    </div>
  );
}

// ─── Slice 13: Step counter display ──────────────────────────────────────────

function StepCounter({ step, maxSteps, dryRun }) {
  const pct = Math.min(100, Math.round((step / maxSteps) * 100));
  const nearLimit = step >= maxSteps - 2 && step < maxSteps;
  const atLimit   = step >= maxSteps;

  return (
    <span className={`flex items-center gap-1.5 ${atLimit ? "text-orange-600" : nearLimit ? "text-amber-600" : "text-gray-600"}`}>
      {dryRun && <span className="text-lemon-600 font-semibold">[DRY]</span>}
      <span>Step {step} / {maxSteps}</span>
      {/* Mini progress bar */}
      <span className="inline-block w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden" aria-hidden="true">
        <span
          className={`block h-full rounded-full transition-all ${atLimit ? "bg-orange-400" : nearLimit ? "bg-amber-400" : "bg-lemon-400"}`}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

// ─── Idle hint ────────────────────────────────────────────────────────────────

function AgentIdleHint() {
  return (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <span className="text-3xl" aria-hidden="true">🤖</span>
      <div>
        <p className="text-sm font-medium text-gray-500 mb-1">Example tasks:</p>
        <ul className="text-xs text-gray-400 space-y-1">
          <li>"Fill in my name and email"</li>
          <li>"Click the Sign Up button"</li>
          <li>"Search for machine learning courses"</li>
          <li>"Select the Monthly option"</li>
        </ul>
      </div>
      <p className="text-xs text-gray-400">
        Every action requires your approval. Nothing changes without your OK.
      </p>
    </div>
  );
}

// ─── Shared utils ─────────────────────────────────────────────────────────────

function ErrorCard({ message }) {
  return (
    <div role="alert" className="p-3 rounded-xl border border-red-200 bg-red-50 text-sm text-red-700">
      {message}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4 text-gray-500 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}
