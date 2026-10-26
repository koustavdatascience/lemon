/**
 * agent-engine.js — Slice 12 + 13
 *
 * The approval-gated agent loop for Lemon.
 *
 * Public API (called by service-worker.js):
 *   AgentEngine.start(task, tabId, language, opts)  → void
 *     opts: { dryRun?: boolean, maxSteps?: number }
 *   AgentEngine.approve()      → void
 *   AgentEngine.skip()         → void
 *   AgentEngine.stop()         → void
 *   AgentEngine.getState()     → serialisable snapshot | null
 *   AgentEngine.restore()      → Promise<boolean>  (Slice 13: called by SW onStartup)
 *
 * Loop invariant: only ONE active agent at a time. A second `start()` while
 * running stops the previous task first (edge case 12.6).
 *
 * State machine:
 *   idle → running → waiting_approval ↔ running → done | stopped | error
 *
 * Persistence (Slice 13):
 *   State is written to chrome.storage.local["agentState"] after every
 *   transition. On service-worker wake (onStartup / onInstalled) the SW
 *   calls AgentEngine.restore() which reads storage and re-emits the
 *   last pending action-proposal so the UI can resume.
 *
 * Dry-run mode (Slice 13):
 *   When dryRun === true the engine follows the normal loop but skips the
 *   _executeAction() call. Instead it just highlights the target element and
 *   continues to the next tick after approval.
 *
 * Step limit (Slice 13):
 *   Default MAX_STEPS_DEFAULT = 20. Caller can override via opts.maxSteps.
 *   The limit is checked at the START of every tick (edge case 13.4).
 *
 * Edge cases handled (Slice 12):
 *   12.1 Page navigates away mid-task    → chrome.tabs.onUpdated pauses agent
 *   12.3 type action on pre-filled field → actor clears before typing
 *   12.4 AI proposes "done" immediately  → confirm with user via action-proposal
 *   12.6 Second start while running      → stop previous first
 *   12.7 Action triggers page reload     → wait for tab "complete" before tick
 *
 * Edge cases handled (Slice 13):
 *   13.1 Stale tabId on restore          → validate tab still exists
 *   13.2 Storage quota exceeded          → log warn; continue without crashing
 *   13.3 Dry-run highlight not cleaned   → cleanup() always called on stop
 *   13.4 Step limit mid-execution        → check BEFORE executing action
 *
 *   X.1  lastError checks everywhere     → all chrome API calls guarded
 */

import { streamChat, buildLanguageInstruction } from "./ai-router.js";
import { getLanguage, setAgentState, clearAgentState, getAgentState, buildProfilePromptSnippet } from "./storage-helpers.js";
import { validate, AGENT_ACTION_SCHEMA } from "../lib/schema-validator.js";
import { SafetyGuard } from "./safety-guard.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_STEPS_DEFAULT = 20;
const AI_JSON_RETRIES   = 2;

// ─── Module-level state ───────────────────────────────────────────────────────

/**
 * @type {{
 *   task:              string,
 *   tabId:             number,
 *   language:          string,
 *   dryRun:            boolean,
 *   maxSteps:          number,
 *   step:              number,
 *   history:           Array,
 *   status:            "running"|"waiting_approval"|"done"|"stopped"|"error",
 *   pendingAction:     object | null,
 *   log:               Array,
 *   abortController:   AbortController | null,   // not persisted
 *   tabUpdateListener: Function | null,           // not persisted
 * } | null}
 */
let _state = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export const AgentEngine = {

  // ── start ──────────────────────────────────────────────────────────────────

  /**
   * Start a new agent task.
   * @param {string}  task
   * @param {number}  tabId
   * @param {string}  [language]      — "en" | "hi-en"
   * @param {object}  [opts]
   * @param {boolean} [opts.dryRun=false]
   * @param {number}  [opts.maxSteps=20]
   */
  async start(task, tabId, language, opts = {}) {
    // Edge case 12.6: stop any running agent first
    if (_state && _state.status !== "stopped" && _state.status !== "done") {
      await _doStop(false);
    }

    const lang = (language === "en" || language === "hi-en")
      ? language
      : await getLanguage();

    // Slice 14: snapshot profile once at task start (edge case 14.5 — don't
    // re-read during the task so in-flight prompts stay consistent)
    const profileSnippet = await buildProfilePromptSnippet();

    _state = {
      task,
      tabId,
      language:          lang,
      dryRun:            opts.dryRun === true,
      maxSteps:          Number.isInteger(opts.maxSteps) && opts.maxSteps > 0
                           ? opts.maxSteps
                           : MAX_STEPS_DEFAULT,
      step:              0,
      history:           [],
      status:            "running",
      pendingAction:     null,
      log:               [],
      profileSnippet,
      stopping:          false,   // Slice 16: edge case 16.5 — Stop races actor
      abortController:   null,
      tabUpdateListener: null,
    };

    // Edge case 12.1: watch for tab navigation mid-task
    _state.tabUpdateListener = _onTabUpdated.bind(null, tabId);
    chrome.tabs.onUpdated.addListener(_state.tabUpdateListener);

    await _persist();
    _notifyPanel({ type: "agent-status", status: "running", step: 0, task, dryRun: _state.dryRun, maxSteps: _state.maxSteps });

    await _tick();
  },

  // ── approve ────────────────────────────────────────────────────────────────

  async approve() {
    if (!_state || _state.status !== "waiting_approval") return;
    if (!_state.pendingAction) return;

    const action = _state.pendingAction;
    _state.status = "running";
    _appendLog({ ...action, decision: "approved", step: _state.step });
    await _persist();

    _notifyPanel({ type: "agent-status", status: "running", step: _state.step });

    if (_state.dryRun) {
      // Dry-run: highlight the element but skip DOM mutation (Slice 13)
      if (action.elementId) {
        try {
          await _sendToScanner(_state.tabId, { type: "scan-highlight", id: action.elementId });
        } catch { /* non-fatal */ }
      }
    } else {
      // Live run: execute the action in the content script

      // Slice 16: field-level safety check before any DOM mutation
      const fieldCheck = SafetyGuard.checkField(action.element);
      if (fieldCheck.blocked) {
        _appendLog({ type: "error", message: fieldCheck.reason, step: _state.step });
        await _doStop(false);
        _notifyPanel({ type: "agent-error", message: fieldCheck.reason });
        return;
      }

      // Slice 16: action-level check — flag consequential buttons
      const actionCheck = SafetyGuard.checkAction(action);
      if (actionCheck.needsConfirm) {
        // Re-emit as a proposal with a confirmation flag so the UI shows a modal.
        // If the user then approves, needsConfirm will be absent in the re-proposal.
        // If the user skips, the engine records it and moves on (edge case 16.4).
        _state.pendingAction = { ...action, _confirming: true };
        _state.status = "waiting_approval";
        await _persist();
        _notifyPanel({
          type:         "action-proposal",
          action:       action.action,
          elementId:    action.elementId,
          value:        action.value,
          reason:       action.reason,
          element:      action.element,
          step:         _state.step,
          log:          _getLogSnapshot(),
          needsConfirm: true,
          confirmReason: actionCheck.reason,
        });
        return;
      }

      const execResult = await _executeAction(action);
      if (!execResult.ok) {
        _appendLog({ type: "error", message: execResult.error, step: _state.step });
        await _doStop(false);
        _notifyPanel({ type: "agent-error", message: execResult.error });
        return;
      }
    }

    // "done" action completes the task regardless of dry-run
    if (action.action === "done") {
      await _doStop(true);
      _notifyPanel({ type: "agent-done", step: _state?.step ?? 0 });
      return;
    }

    // Edge case 12.7: wait for potential navigation to settle (live run only)
    if (!_state.dryRun && (action.action === "click" || action.action === "select")) {
      await _waitForTabIdle(_state.tabId, 2500);
    }

    await _tick();
  },

  // ── skip ───────────────────────────────────────────────────────────────────

  async skip() {
    if (!_state || _state.status !== "waiting_approval") return;
    if (!_state.pendingAction) return;

    _appendLog({ ..._state.pendingAction, decision: "skipped", step: _state.step });
    _state.status = "running";
    _state.pendingAction = null;
    await _persist();

    _notifyPanel({ type: "agent-status", status: "running", step: _state.step });
    await _tick();
  },

  // ── stop ───────────────────────────────────────────────────────────────────

  async stop() {
    // Edge case 16.5: set flag synchronously so actor checks it before DOM mutations
    if (_state) _state.stopping = true;
    await _doStop(false);
    _notifyPanel({ type: "agent-stopped" });
  },

  // ── getState ───────────────────────────────────────────────────────────────

  getState() {
    if (!_state) return null;
    // eslint-disable-next-line no-unused-vars
    const { abortController, tabUpdateListener, ...safe } = _state;
    return safe;
  },

  // ── restore (Slice 13) ─────────────────────────────────────────────────────

  /**
   * Called by the service worker on `chrome.runtime.onStartup` (and optionally
   * on `onInstalled` for update scenarios).
   *
   * Reads the persisted agent state from storage. If a task was in
   * `waiting_approval`, re-emits the action-proposal so the UI can resume.
   * If the tab no longer exists the state is discarded (edge case 13.1).
   *
   * @returns {Promise<boolean>} true if state was restored, false if none found
   */
  async restore() {
    const saved = await getAgentState();
    if (!saved) return false;
    if (saved.status !== "waiting_approval") {
      // The SW was killed while running — nothing useful to restore
      await clearAgentState();
      return false;
    }

    // Edge case 13.1: validate the tab still exists
    const tabExists = await _tabExists(saved.tabId);
    if (!tabExists) {
      await clearAgentState();
      _notifyPanel({
        type:    "agent-error",
        message: "⚠️ A previous task was waiting for approval but its tab no longer exists.",
      });
      return false;
    }

    // Reconstitute state without the non-serialisable fields
    _state = {
      ...saved,
      abortController:   null,
      tabUpdateListener: null,
    };

    // Re-attach the tab navigation listener
    _state.tabUpdateListener = _onTabUpdated.bind(null, _state.tabId);
    chrome.tabs.onUpdated.addListener(_state.tabUpdateListener);

    // Re-emit the pending action-proposal to wake the UI
    const { pendingAction } = _state;
    _notifyPanel({
      type:      "agent-restored",
      task:      _state.task,
      step:      _state.step,
      dryRun:    _state.dryRun,
      maxSteps:  _state.maxSteps,
      log:       _getLogSnapshot(),
    });

    if (pendingAction) {
      _notifyPanel({
        type:      "action-proposal",
        action:    pendingAction.action,
        elementId: pendingAction.elementId,
        value:     pendingAction.value,
        reason:    pendingAction.reason,
        element:   pendingAction.element,
        step:      _state.step,
        log:       _getLogSnapshot(),
      });
    }

    return true;
  },
};

// ─── Core tick loop ───────────────────────────────────────────────────────────

async function _tick() {
  if (!_state || _state.status === "stopped" || _state.status === "done") return;

  _state.step += 1;

  // Edge case 13.4: check step limit at the START of tick, before any action
  if (_state.step > _state.maxSteps) {
    _appendLog({
      type:    "limit",
      message: `Step limit (${_state.maxSteps}) reached.`,
      step:    _state.step,
    });
    await _doStop(false);
    _notifyPanel({
      type:    "agent-error",
      message: `⏱️ Step limit (${_state.maxSteps}) reached. Task stopped automatically.`,
    });
    return;
  }

  _notifyPanel({ type: "agent-status", status: "running", step: _state.step });

  // ── 1. Get page state ─────────────────────────────────────────────────────
  let scanResult;
  try {
    scanResult = await _getPageState(_state.tabId);
  } catch (err) {
    await _doStop(false);
    _notifyPanel({ type: "agent-error", message: `🔍 ${err.message}` });
    return;
  }

  if (scanResult.blocked) {
    await _doStop(false);
    _notifyPanel({ type: "agent-error", message: "🚫 Lemon can't act on this page." });
    return;
  }

  // Slice 16: check the current tab URL for banking/payment pages
  try {
    const tab = await _getTab(_state.tabId);
    if (tab?.url) {
      const pageCheck = SafetyGuard.checkPage(tab.url);
      if (pageCheck.blocked) {
        _appendLog({ type: "error", message: pageCheck.reason, step: _state.step });
        await _doStop(false);
        _notifyPanel({ type: "agent-error", message: pageCheck.reason });
        return;
      }
    }
  } catch { /* tab disappeared — continue; next action will fail gracefully */ }

  const { actionMap } = scanResult;

  // ── 2. Build prompt ───────────────────────────────────────────────────────
  const { messages, systemPrompt } = _buildPrompt(_state, actionMap);

  // ── 3. Call AI, collect strict JSON ──────────────────────────────────────
  const aiResult = await _callAI(messages, systemPrompt);
  if (!aiResult.ok) {
    await _doStop(false);
    _notifyPanel({ type: "agent-error", message: aiResult.error });
    return;
  }

  const action = aiResult.action;

  // ── 4. Range-check elementId against current map ──────────────────────────
  if (
    action.action !== "scroll" &&
    action.action !== "done"   &&
    (action.elementId == null || action.elementId < 1 || action.elementId > actionMap.length)
  ) {
    await _doStop(false);
    _notifyPanel({
      type:    "agent-error",
      message: `⚠️ AI chose element ${action.elementId} but the page only has ${actionMap.length} element(s).`,
    });
    return;
  }

  // ── 5. Save pending action, emit for approval, pause ─────────────────────
  const element = actionMap.find((el) => el.id === action.elementId) ?? null;

  _state.pendingAction = { ...action, element };
  _state.status = "waiting_approval";

  // Accumulate AI conversation history (capped to avoid unbounded growth)
  _state.history.push(
    { role: "user",  parts: [{ text: messages[messages.length - 1].parts[0].text }] },
    { role: "model", parts: [{ text: JSON.stringify(action) }] }
  );
  // Keep history to last 10 turns (5 round-trips) so prompts stay within budget
  if (_state.history.length > 10) {
    _state.history = _state.history.slice(_state.history.length - 10);
  }

  // Highlight target element (non-fatal)
  if (action.elementId) {
    try {
      await _sendToScanner(_state.tabId, { type: "scan-highlight", id: action.elementId });
    } catch { /* non-fatal */ }
  }

  await _persist();
  _notifyPanel({
    type:      "action-proposal",
    action:    action.action,
    elementId: action.elementId,
    value:     action.value,
    reason:    action.reason,
    element,
    step:      _state.step,
    log:       _getLogSnapshot(),
  });
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function _buildPrompt(state, actionMap) {
  const langInstruct  = buildLanguageInstruction(state.language);
  const dryRunNote    = state.dryRun ? " (DRY-RUN: the action will NOT be executed — just propose the best step)" : "";

  // Slice 14: include profile snippet when available
  const profileSection = state.profileSnippet
    ? `\n\nThe following user profile data is available. Use it to populate matching form fields automatically — prefer profile values over guessing:\n<profile>\n${state.profileSnippet}\n</profile>`
    : "";

  const systemPrompt = `You are Lemon, a precise browser automation agent.${dryRunNote} ${langInstruct}
Complete the user's task one step at a time by choosing the best action from the page elements.${profileSection}
Respond ONLY with a single line of valid JSON — no markdown fences, no explanation outside the JSON:
{"action":"<click|type|select|scroll|done>","elementId":<integer|null>,"value":"<string or null>","reason":"<one sentence>"}

Rules:
- "click"  → buttons, links, checkboxes, radio buttons.
- "type"   → text/email/number/textarea — set "value" to the text to type. Use profile data when the field label matches.
- "select" → <select> dropdowns — set "value" to one of the listed "options".
- "scroll" → when the target is not yet visible; elementId must be null.
- "done"   → task complete or cannot proceed; elementId and value must be null.
- Never choose a disabled element.
- elementId must be an integer ID from the elements list, or null for scroll/done.
- value must be a string or null (never undefined).`;

  // Compact action map — omit rect to save tokens
  const compactMap = actionMap.map(({ id, type, label, placeholder, value, options, checked, href, disabled }) => {
    const e = { id, type, label };
    if (placeholder)           e.placeholder = placeholder;
    if (value)                 e.value       = value;
    if (options?.length)       e.options     = options;
    if (checked !== undefined) e.checked     = checked;
    if (href)                  e.href        = href;
    if (disabled)              e.disabled    = disabled;
    return e;
  });

  const mapJson = JSON.stringify(compactMap, null, 0);

  const firstUserText =
    `Task: "${state.task}"\n\nPage elements (step ${state.step}):\n${mapJson}\n\nRespond with ONLY the JSON action.`;

  let messages;
  if (state.history.length === 0) {
    messages = [{ role: "user", parts: [{ text: firstUserText }] }];
  } else {
    const continuationText =
      `Step ${state.step} — updated page elements:\n${mapJson}\n\nRespond with ONLY the JSON action for the next step.`;
    messages = [
      ...state.history,
      { role: "user", parts: [{ text: continuationText }] },
    ];
  }

  return { messages, systemPrompt };
}

// ─── AI call + validation ─────────────────────────────────────────────────────

async function _callAI(messages, systemPrompt) {
  let lastRaw   = "";
  const msgHist = [...messages];

  for (let attempt = 1; attempt <= AI_JSON_RETRIES; attempt++) {
    let rawText = "";
    let aiErr   = null;

    const ctrl = new AbortController();
    if (_state) _state.abortController = ctrl;

    await streamChat({
      task:     "agent",
      messages: msgHist,
      systemPrompt,
      signal:   ctrl.signal,
      onToken:  (tok) => { rawText += tok; },
      onDone:   () => {},
      onError:  (err) => { aiErr = err; },
    });

    if (aiErr) return { ok: false, error: `AI error: ${aiErr.message}` };

    lastRaw = rawText;

    // Strip markdown fences that the model sometimes adds despite instructions
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      if (attempt < AI_JSON_RETRIES) {
        msgHist.push(
          { role: "model", parts: [{ text: lastRaw }] },
          { role: "user",  parts: [{ text: `Invalid JSON. Reply ONLY with: {"action":"...","elementId":null,"value":null,"reason":"..."}` }] }
        );
        continue;
      }
      return { ok: false, error: "⚠️ AI returned an unreadable response. Please try again." };
    }

    const validation = validate(parsed, AGENT_ACTION_SCHEMA);
    if (!validation.ok) {
      if (attempt < AI_JSON_RETRIES) {
        msgHist.push(
          { role: "model", parts: [{ text: lastRaw }] },
          { role: "user",  parts: [{ text: `Schema error: ${validation.errors.join("; ")}. Reply ONLY with valid JSON.` }] }
        );
        continue;
      }
      return { ok: false, error: `⚠️ AI response failed validation: ${validation.errors.join("; ")}` };
    }

    // Coerce absent optional fields
    if (parsed.elementId == null) parsed.elementId = null;
    if (parsed.value      == null) parsed.value     = null;

    return { ok: true, action: parsed };
  }

  return { ok: false, error: "⚠️ Could not get a valid action from the AI after retries." };
}

// ─── Action executor ──────────────────────────────────────────────────────────

async function _executeAction(action) {
  if (action.action === "done") return { ok: true };

  const tabId = _state.tabId;

  try {
    await _injectActor(tabId);
  } catch (err) {
    return { ok: false, error: `INJECT_ERROR: ${err.message}` };
  }

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({ ok: false, error: "TIMEOUT: Actor did not respond in time." });
    }, 15_000);

    chrome.tabs.sendMessage(tabId, { type: "execute-action", action }, (response) => {
      clearTimeout(timeoutId);
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response ?? { ok: false, error: "No response from actor." });
    });
  });
}

function _injectActor(tabId) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/actor.js"] }, () => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve();
    });
  });
}

// ─── Stop / cleanup ───────────────────────────────────────────────────────────

async function _doStop(completed) {
  if (!_state) return;

  try { _state.abortController?.abort(); } catch { /* ignore */ }

  if (_state.tabUpdateListener) {
    try { chrome.tabs.onUpdated.removeListener(_state.tabUpdateListener); } catch { /* ignore */ }
  }

  // Edge case 13.3: always clean up scanner/highlight on stop
  const tabId = _state.tabId;
  try { await _sendToScanner(tabId, { type: "scan-cleanup" }); } catch { /* scanner may be gone */ }

  _state.status = completed ? "done" : "stopped";
  _state = null;
  await clearAgentState();
}

// ─── Persistence ──────────────────────────────────────────────────────────────

async function _persist() {
  if (!_state) return;
  // eslint-disable-next-line no-unused-vars
  const { abortController, tabUpdateListener, ...safe } = _state;
  try {
    await setAgentState(safe);
  } catch (err) {
    // Edge case 13.2: storage quota exceeded — non-fatal
    console.warn("[AgentEngine] persist failed:", err);
  }
}

// ─── Log helpers ──────────────────────────────────────────────────────────────

function _appendLog(entry) {
  if (!_state) return;
  _state.log.push({ ...entry, ts: Date.now() });
}

function _getLogSnapshot() {
  return _state?.log ? [..._state.log] : [];
}

// ─── Panel notification ────────────────────────────────────────────────────────

function _notifyPanel(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Panel not open — silently discard (edge case 2.2)
  });
}

// ─── Page-state helper ────────────────────────────────────────────────────────

function _getPageState(tabId) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("TIMEOUT: Scanner did not respond."));
    }, 10_000);

    function listener(msg, sender) {
      if (msg.type !== "page-state") return;
      if (sender.tab?.id !== tabId) return;
      clearTimeout(timeoutId);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg);
    }

    chrome.runtime.onMessage.addListener(listener);

    chrome.tabs.sendMessage(tabId, { type: "scan-rescan" }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        chrome.scripting.executeScript({ target: { tabId }, files: ["content-scripts/scanner.js"] }, () => {
          if (chrome.runtime.lastError) {
            clearTimeout(timeoutId);
            chrome.runtime.onMessage.removeListener(listener);
            reject(new Error(`INJECT_ERROR: ${chrome.runtime.lastError.message}`));
          }
        });
      }
    });
  });
}

// ─── Scanner messaging helper ─────────────────────────────────────────────────

function _sendToScanner(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
      resolve(response ?? {});
    });
  });
}

// ─── Tab navigation handler (edge case 12.1) ──────────────────────────────────

function _onTabUpdated(watchedTabId, tabId, changeInfo) {
  if (tabId !== watchedTabId) return;
  if (changeInfo.status !== "loading") return;
  if (!_state || _state.status === "stopped" || _state.status === "done") return;

  if (_state.status === "running" || _state.status === "waiting_approval") {
    _appendLog({ type: "paused", message: "Page navigated — task paused.", step: _state.step });
    _state.status = "stopped";
    _persist().catch(() => {});
    chrome.tabs.onUpdated.removeListener(_state.tabUpdateListener);
    _state.tabUpdateListener = null;
    _notifyPanel({
      type:    "agent-error",
      message: "⚠️ The page navigated during the task. Start a new task on the new page.",
    });
  }
}

// ─── Tab idle helper (edge case 12.7) ────────────────────────────────────────

function _waitForTabIdle(tabId, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    function onUpdated(id, changeInfo) {
      if (id !== tabId) return;
      if (changeInfo.status === "complete") done();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(done, timeoutMs);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) { done(); return; }
      if (tab?.status === "complete") done();
    });
  });
}

// ─── Tab-exists helper (edge case 13.1) ──────────────────────────────────────

function _tabExists(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(!chrome.runtime.lastError && !!tab);
    });
  });
}

// ─── Get tab helper ───────────────────────────────────────────────────────────

function _getTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      resolve(chrome.runtime.lastError ? null : tab);
    });
  });
}
