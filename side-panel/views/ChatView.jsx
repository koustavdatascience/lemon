import React, {
  useState,
  useRef,
  useEffect,
  useCallback,
} from "react";
import MessageBubble from "../components/MessageBubble.jsx";
import { useAppContext } from "../App.jsx";

/**
 * ChatView — Slice 2 + 5 + 6 + 7 + 8
 *
 * Slice 2: free-form chat ("chat" message type).
 * Slice 5: language passed in every port message.
 * Slice 6: grounded page-chat ("page-chat" message type).
 *   - Auto-extracts page context when the view opens.
 *   - Context indicator shows the page title, stale badge, and an Extract button.
 *   - Answers are grounded in page content; model admits when info is absent.
 *   - Tab URL changes detected via chrome.tabs.onUpdated → context marked stale.
 *   - History capped at MAX_HISTORY_MESSAGES for display (edge case 6.5).
 *   - Rolling window of last ROLLING_TURNS turns sent with every request (edge case 6.2).
 *   - Blocked submission when page-chat mode and context extraction failed (edge case 6.3).
 * Slice 7: receives context-menu results (Explain / Translate / Draft a reply)
 *   via AppContext.pendingContextResult and displays them as chat messages.
 * Slice 8: screenshot-and-ask ("screenshot-ask" message type).
 *   - Camera button captures the visible tab, downscales to ≤ 1280 px (edge case 8.2).
 *   - Screenshot preview with remove button.
 *   - Question required before send (edge case 8.3).
 *   - Screenshot data never persisted to storage.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum messages kept in React state (display cap — edge case 6.5). */
const MAX_HISTORY_MESSAGES = 50;

/**
 * Number of full conversation turns (user+assistant pairs) kept in the
 * rolling window sent to the SW with each page-chat request (edge case 6.2).
 * Each turn = 2 messages. 3 turns = 6 messages.
 */
const ROLLING_TURNS = 3;

// ─── Port management ──────────────────────────────────────────────────────────

let _port = null;

function getPort() {
  if (!_port) {
    _port = chrome.runtime.connect({ name: "ai-stream" });
    _port.onDisconnect.addListener(() => { _port = null; });
  }
  return _port;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ChatView() {
  const { language, pendingContextResult, setPendingContextResult } = useAppContext();

  // ── Message state ──────────────────────────────────────────────────────────
  /** @type {[Array<{id,role,content,streaming}>, Function]} */
  const [messages,    setMessages]    = useState([]);
  const [input,       setInput]       = useState("");
  const [isStreaming, setStreaming]    = useState(false);
  const [error,       setError]       = useState(null);

  // ── Page-chat context state (Slice 6) ──────────────────────────────────────
  /**
   * contextStatus:
   *   "idle"        — view just opened, haven't tried extracting yet
   *   "extracting"  — extraction in progress
   *   "ready"       — extraction succeeded, context is fresh
   *   "stale"       — tab URL changed since last extraction (edge case 6.1)
   *   "failed"      — extraction failed or page has no content
   *   "restricted"  — chrome:// / edge:// page, can't extract
   */
  const [contextStatus,  setContextStatus]  = useState("idle");
  const [pageTitle,      setPageTitle]      = useState(null);   // shown in context indicator
  const [pageTabId,      setPageTabId]      = useState(null);   // tab we extracted from
  const [pageUrl,        setPageUrl]        = useState(null);   // URL at extraction time

  /** Chat mode: "free" | "page" */
  const [chatMode, setChatMode] = useState("page"); // default to page-chat

  // ── Screenshot state (Slice 8) ──────────────────────────────────────────────
  /** Data URL of captured screenshot, or null. Never persisted to storage. */
  const [screenshot, setScreenshot] = useState(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);

  const bottomRef   = useRef(null);
  const inputRef    = useRef(null);
  const listenerRef = useRef(null);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Port cleanup on unmount ────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (listenerRef.current && _port) {
        _port.onMessage.removeListener(listenerRef.current);
        listenerRef.current = null;
      }
    };
  }, []);

  // ── Auto-extract on mount (page-chat mode) ─────────────────────────────────
  useEffect(() => {
    if (chatMode === "page") {
      extractPageContext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount; user can re-trigger manually

  // ── Stale detection: listen for tab URL changes (edge case 6.1) ───────────
  useEffect(() => {
    if (chatMode !== "page") return;

    const onTabUpdated = (tabId, changeInfo) => {
      if (tabId !== pageTabId) return;
      if (!changeInfo.url) return;
      if (changeInfo.url === pageUrl) return;

      setContextStatus("stale");
    };

    chrome.tabs.onUpdated.addListener(onTabUpdated);
    return () => chrome.tabs.onUpdated.removeListener(onTabUpdated);
  }, [chatMode, pageTabId, pageUrl]);

  // ── Consume pending context-menu results (Slice 7) ──────────────────────────
  useEffect(() => {
    if (!pendingContextResult) return;

    const { action, text, selection, error } = pendingContextResult;

    // Add a user bubble showing the action + truncated selection
    const userMsg = {
      id: Date.now(),
      role: "user",
      content: `🍋 ${action}: "${selection.slice(0, 200)}${selection.length > 200 ? "…" : ""}"`,
      streaming: false,
    };

    // Add the AI result as an assistant message
    const aiMsg = {
      id: Date.now() + 1,
      role: "assistant",
      content: text,
      streaming: false,
    };

    setMessages((prev) => {
      const next = [...prev, userMsg, aiMsg];
      return next.length > MAX_HISTORY_MESSAGES ? next.slice(-MAX_HISTORY_MESSAGES) : next;
    });

    // Clear the pending result so it's only consumed once
    setPendingContextResult(null);
  }, [pendingContextResult, setPendingContextResult]);

  // ── Screenshot capture (Slice 8) ──────────────────────────────────────────────

  const handleScreenshot = useCallback(async () => {
    if (screenshotLoading || isStreaming) return;

    setScreenshotLoading(true);
    try {
      // Capture the visible tab (edge case 8.1: may fail if tab not foreground)
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: "png" });

      // Downscale to max 1280px width (edge case 8.2)
      const downscaled = await downscaleImage(dataUrl, 1280);
      setScreenshot(downscaled);
    } catch (err) {
      console.error("[ChatView] Screenshot capture failed:", err);
      setError("📸 Could not capture the screen. Make sure the tab is active and visible.");
    } finally {
      setScreenshotLoading(false);
    }
  }, [screenshotLoading, isStreaming]);

  const handleRemoveScreenshot = () => {
    setScreenshot(null);
  };

  // ── Extract page context ───────────────────────────────────────────────────

  const extractPageContext = useCallback(async () => {
    setContextStatus("extracting");
    setPageTitle(null);

    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      setContextStatus("failed");
      return;
    }

    if (!tab?.id) {
      setContextStatus("failed");
      return;
    }

    const url = tab.url ?? "";

    // Can't extract from browser system pages
    if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:")) {
      setContextStatus("restricted");
      setPageTabId(tab.id);
      setPageUrl(url);
      return;
    }

    // Store the tab and URL so stale detection works
    setPageTabId(tab.id);
    setPageUrl(url);

    // Inject Readability + reader.js via the SW's existing extractArticle path.
    // We do this by sending a one-shot "extract-page" message to the SW and
    // listening for the reader-result. However, the simpler approach is to
    // inject the scripts directly from here using chrome.scripting, mirroring
    // what the SW does in extractArticle(), and listen for "reader-result".
    // This keeps the extraction logic consistent.
    try {
      const result = await injectAndExtract(tab.id);
      if (result.success) {
        setPageTitle(result.title || tab.title || "Untitled page");
        setPageUrl(result.url || url);
        setContextStatus("ready");
      } else {
        setContextStatus("failed");
      }
    } catch {
      setContextStatus("failed");
    }
  }, []);

  // ── Send message ────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    // Edge case 6.3: block submission in page mode when context failed
    if (chatMode === "page" && (contextStatus === "failed" || contextStatus === "restricted")) {
      return;
    }

    // If context is stale, re-extract silently before sending (edge case 6.1)
    if (chatMode === "page" && contextStatus === "stale") {
      await extractPageContext();
    }

    setError(null);
    setInput("");
    setStreaming(true);

    // Determine if this is a screenshot-ask (Slice 8)
    const hasScreenshot = !!screenshot;

    // Add user message bubble
    const userContent = hasScreenshot ? `📸 ${text}` : text;
    const userMsg = { id: Date.now(), role: "user", content: userContent, streaming: false };

    // Clamp message history display (edge case 6.5)
    setMessages((prev) => {
      const next = [...prev, userMsg];
      return next.length > MAX_HISTORY_MESSAGES ? next.slice(-MAX_HISTORY_MESSAGES) : next;
    });

    // Placeholder for streaming assistant reply
    const assistantId = Date.now() + 1;
    setMessages((prev) => [
      ...prev,
      { id: assistantId, role: "assistant", content: "", streaming: true },
    ]);

    // Build history for the request.
    // For screenshot-ask or page-chat: rolling window of last ROLLING_TURNS turns (edge case 6.2).
    // For free-chat: full history.
    const fullHistory = messages.map((m) => ({ role: m.role, content: m.content }));
    const history = (chatMode === "page" || hasScreenshot)
      ? rollingWindow(fullHistory, ROLLING_TURNS)
      : fullHistory;

    // Build the request
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tab = null;
    }

    let request;
    if (hasScreenshot) {
      request = { type: "screenshot-ask", image: screenshot, question: text, history, language };
    } else if (chatMode === "page") {
      request = { type: "page-chat", tabId: tab?.id, message: text, history, language };
    } else {
      request = { type: "chat", message: text, history, language };
    }

    // Set up port listener
    const port = getPort();
    if (listenerRef.current) port.onMessage.removeListener(listenerRef.current);

    const listener = (msg) => {
      switch (msg.type) {
        case "status":
          // Swallow status messages during chat (they're brief and show in context indicator)
          break;

        case "token":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + msg.text } : m
            )
          );
          break;

        case "done":
          // If SW returned fresh meta (page title), update context indicator
          if (msg.meta?.title) setPageTitle(msg.meta.title);
          if (msg.meta?.url)   setPageUrl(msg.meta.url);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, streaming: false } : m
            )
          );
          setStreaming(false);
          setScreenshot(null);  // Clear screenshot after response (Slice 8)
          port.onMessage.removeListener(listener);
          listenerRef.current = null;
          break;

        case "error":
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: msg.message, streaming: false }
                : m
            )
          );
          setError(msg.message);
          setStreaming(false);
          setScreenshot(null);  // Clear screenshot after error
          port.onMessage.removeListener(listener);
          listenerRef.current = null;
          break;
      }
    };

    listenerRef.current = listener;
    port.onMessage.addListener(listener);

    try {
      port.postMessage(request);
    } catch {
      _port = null;
      const fresh = getPort();
      fresh.onMessage.addListener(listener);
      try {
        fresh.postMessage(request);
      } catch {
        setError("Could not connect to the extension background. Try reloading.");
        setStreaming(false);
      }
    }
  }, [input, isStreaming, messages, chatMode, contextStatus, language, extractPageContext, screenshot]);

  // ── Keyboard handler ────────────────────────────────────────────────────────

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Toggle chat mode ────────────────────────────────────────────────────────

  const toggleMode = () => {
    const next = chatMode === "page" ? "free" : "page";
    setChatMode(next);
    if (next === "page" && contextStatus === "idle") {
      extractPageContext();
    }
  };

  // ── Clear conversation ──────────────────────────────────────────────────────

  const clearChat = () => {
    if (isStreaming) return;
    setMessages([]);
    setError(null);
    inputRef.current?.focus();
  };

  // ── Derived state ────────────────────────────────────────────────────────────

  const hasMessages = messages.length > 0;

  const hasScreenshot = !!screenshot;

  // Submission is blocked when: page mode + context failed/restricted AND no screenshot
  const isBlocked =
    !hasScreenshot &&
    chatMode === "page" &&
    (contextStatus === "failed" || contextStatus === "restricted");

  const canSend = input.trim().length > 0 && !isStreaming && !isBlocked;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div
      id="panel-chat"
      role="tabpanel"
      aria-labelledby="tab-chat"
      className="flex flex-col h-full"
    >
      {/* ── Context indicator (Slice 6) ── */}
      {chatMode === "page" && (
        <ContextIndicator
          status={contextStatus}
          title={pageTitle}
          onExtract={extractPageContext}
        />
      )}

      {/* ── Message list ── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin">
        {!hasMessages ? (
          <EmptyState chatMode={chatMode} contextStatus={contextStatus} />
        ) : (
          <ul
            className="flex flex-col gap-3 list-none p-0 m-0"
            aria-live="polite"
            aria-label="Chat messages"
          >
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                role={msg.role}
                content={msg.content}
                streaming={msg.streaming}
              />
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ── Error banner ── */}
      {error && !isStreaming && (
        <div
          role="alert"
          className="mx-3 mb-2 px-3 py-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded-lg"
        >
          {error}
        </div>
      )}

      {/* ── Input area ── */}
      <div className="border-t border-gray-200 bg-white px-3 py-2 shrink-0">
        {/* Blocked notice when context failed and no screenshot */}
        {isBlocked && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 mb-2">
            {contextStatus === "restricted"
              ? "🚫 Can't read browser system pages. Switch to Free chat or open a regular web page."
              : "⚠️ Couldn't read this page — answers won't be grounded. Try extracting again or switch to Free chat."}
          </p>
        )}

        {/* Screenshot preview (Slice 8) */}
        {screenshot && (
          <div className="flex items-center gap-2 mb-2 bg-gray-50 border border-gray-200 rounded-lg p-2">
            <img
              src={screenshot}
              alt="Screenshot preview"
              className="h-12 rounded border border-gray-300 object-cover"
            />
            <span className="text-xs text-gray-500 flex-1">Screenshot ready — type your question below</span>
            <button
              onClick={handleRemoveScreenshot}
              className="text-gray-400 hover:text-red-500 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 rounded"
              aria-label="Remove screenshot"
              title="Remove screenshot"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4" aria-hidden="true">
                <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isBlocked
                ? "Context unavailable…"
                : hasScreenshot
                  ? "Ask about the screenshot…"
                  : chatMode === "page"
                    ? "Ask about this page…"
                    : "Ask anything…"
            }
            rows={1}
            disabled={isStreaming || isBlocked}
            aria-label="Chat input"
            className="
              flex-1 resize-none rounded-xl border border-gray-300 px-3 py-2 text-sm
              focus:outline-none focus:ring-2 focus:ring-lemon-400 focus:border-lemon-400
              disabled:opacity-50 scrollbar-thin leading-relaxed
              max-h-32 overflow-y-auto
            "
            style={{ minHeight: "38px" }}
            onInput={(e) => {
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 128) + "px";
            }}
          />

          {/* Screenshot button (Slice 8) */}
          <button
            onClick={handleScreenshot}
            disabled={screenshotLoading || isStreaming}
            aria-label="Capture screenshot"
            title="Capture a screenshot and ask about it"
            className="
              shrink-0 w-9 h-9 flex items-center justify-center rounded-xl
              border border-gray-300 bg-white hover:bg-gray-50 transition
              disabled:opacity-40 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500
            "
          >
            {screenshotLoading ? (
              <span
                className="w-3.5 h-3.5 border-2 border-gray-500 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-gray-600" aria-hidden="true">
                <path fillRule="evenodd" d="M4.5 2A1.5 1.5 0 003 3.5v13A1.5 1.5 0 004.5 18h11a1.5 1.5 0 001.5-1.5v-13A1.5 1.5 0 0015.5 2h-11zm.873 4.5h9.254a.873.873 0 01.873.873v6.754a.873.873 0 01-.873.873H5.373a.873.873 0 01-.873-.873V7.373A.873.873 0 015.373 6.5h.873zM10 8a2 2 0 100 4 2 2 0 000-4z" clipRule="evenodd" />
              </svg>
            )}
          </button>

          <button
            onClick={sendMessage}
            disabled={!canSend}
            aria-label="Send message"
            className="
              shrink-0 w-9 h-9 flex items-center justify-center rounded-xl
              bg-lemon-400 hover:bg-lemon-500 transition
              disabled:opacity-40 disabled:cursor-not-allowed
              focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500
            "
          >
            {isStreaming ? (
              <span
                className="w-3.5 h-3.5 border-2 border-gray-700 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-4 h-4 text-gray-900"
                aria-hidden="true"
              >
                <path d="M3.105 2.289a.75.75 0 00-.826.95l1.903 6.308H10.5a.75.75 0 010 1.5H4.182l-1.903 6.308a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
              </svg>
            )}
          </button>
        </div>

        {/* Mode toggle + clear */}
        <div className="flex items-center justify-between mt-1.5">
          <button
            onClick={toggleMode}
            disabled={isStreaming}
            className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 focus:outline-none focus-visible:underline flex items-center gap-1"
            title={chatMode === "page" ? "Switch to free chat (no page context)" : "Switch to page-grounded chat"}
          >
            <span aria-hidden="true">{chatMode === "page" ? "📄" : "💬"}</span>
            {chatMode === "page" ? "Page chat" : "Free chat"}
          </button>

          {hasMessages && (
            <button
              onClick={clearChat}
              disabled={isStreaming}
              className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-40 focus:outline-none focus-visible:underline"
            >
              Clear chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Context indicator (Slice 6) ─────────────────────────────────────────────

/**
 * A slim banner under the header showing the current page context status.
 * States: extracting, ready, stale, failed, restricted.
 */
function ContextIndicator({ status, title, onExtract }) {
  if (status === "idle") return null;

  if (status === "extracting") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-50 border-b border-blue-100 text-xs text-blue-700 shrink-0">
        <span
          className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin shrink-0"
          aria-hidden="true"
        />
        <span>Reading page…</span>
      </div>
    );
  }

  if (status === "ready") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 border-b border-green-100 text-xs text-green-700 shrink-0">
        <span aria-hidden="true" className="shrink-0">📄</span>
        <span className="truncate flex-1" title={title}>{title ?? "Page loaded"}</span>
        <button
          onClick={onExtract}
          className="shrink-0 text-green-600 hover:text-green-800 underline focus:outline-none focus-visible:ring-1 focus-visible:ring-green-500 rounded"
          aria-label="Re-extract page content"
          title="Re-extract"
        >
          Refresh
        </button>
      </div>
    );
  }

  if (status === "stale") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-amber-50 border-b border-amber-100 text-xs text-amber-700 shrink-0">
        <span aria-hidden="true" className="shrink-0">🔄</span>
        <span className="flex-1">Page changed — context may be outdated</span>
        <button
          onClick={onExtract}
          className="shrink-0 font-medium text-amber-700 hover:text-amber-900 underline focus:outline-none focus-visible:ring-1 focus-visible:ring-amber-500 rounded"
          aria-label="Re-extract updated page content"
        >
          Update
        </button>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-red-50 border-b border-red-100 text-xs text-red-700 shrink-0">
        <span aria-hidden="true" className="shrink-0">⚠️</span>
        <span className="flex-1">Couldn't read this page</span>
        <button
          onClick={onExtract}
          className="shrink-0 text-red-600 hover:text-red-800 underline focus:outline-none focus-visible:ring-1 focus-visible:ring-red-400 rounded"
          aria-label="Retry page extraction"
        >
          Retry
        </button>
      </div>
    );
  }

  if (status === "restricted") {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-xs text-gray-500 shrink-0">
        <span aria-hidden="true" className="shrink-0">🚫</span>
        <span>Can't read browser system pages</span>
      </div>
    );
  }

  return null;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ chatMode, contextStatus }) {
  if (chatMode === "page") {
    const waiting = contextStatus === "extracting" || contextStatus === "idle";
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-12 text-center px-6">
        <span className="text-4xl" aria-hidden="true">📄</span>
        <p className="font-medium text-gray-700 text-sm">Chat about this page</p>
        {waiting ? (
          <p className="text-xs text-gray-400">Loading page context…</p>
        ) : contextStatus === "ready" || contextStatus === "stale" ? (
          <ul className="text-xs text-gray-400 space-y-1 text-left list-none">
            <li>🔍  Ask about content on the page</li>
            <li>❓  Get clarification on anything you read</li>
            <li>📝  Request a specific detail or quote</li>
          </ul>
        ) : (
          <p className="text-xs text-gray-400">
            Switch to <strong>Free chat</strong> or open a regular web page to use Page chat.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 py-12 text-center px-6">
      <span className="text-4xl" aria-hidden="true">🍋</span>
      <p className="font-medium text-gray-700 text-sm">Ask Lemon anything</p>
      <ul className="text-xs text-gray-400 space-y-1 text-left list-none">
        <li>💬  Explain a concept</li>
        <li>✍️  Draft a message</li>
        <li>🔍  Summarise text you paste</li>
      </ul>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Injects Readability.js + reader.js into a tab and resolves with the
 * extracted article data. Mirrors the SW's extractArticle() logic but
 * runs from the panel so the context indicator can update immediately.
 *
 * @param {number} tabId
 * @returns {Promise<{success, title, content, url, ...}>}
 */
function injectAndExtract(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error("Extraction timed out."));
    }, 15_000);

    function listener(msg, sender) {
      if (msg.type !== "reader-result") return;
      if (sender.tab?.id !== tabId) return;
      clearTimeout(timeout);
      chrome.runtime.onMessage.removeListener(listener);
      resolve(msg);
    }

    chrome.runtime.onMessage.addListener(listener);

    chrome.scripting.executeScript(
      { target: { tabId }, files: ["lib/Readability.js"] },
      () => {
        if (chrome.runtime.lastError) {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        chrome.scripting.executeScript(
          { target: { tabId }, files: ["content-scripts/reader.js"] },
          () => {
            if (chrome.runtime.lastError) {
              clearTimeout(timeout);
              chrome.runtime.onMessage.removeListener(listener);
              reject(new Error(chrome.runtime.lastError.message));
            }
          }
        );
      }
    );
  });
}

/**
 * Build a rolling window from a flat history array.
 * Keeps the last `turns` complete user+assistant pairs (edge case 6.2).
 *
 * @param {Array<{role, content}>} history
 * @param {number} turns
 * @returns {Array<{role, content}>}
 */
function rollingWindow(history, turns) {
  // Find pairs from the end: each pair = [user, assistant]
  const pairs = [];
  for (let i = history.length - 1; i >= 1; i--) {
    if (history[i].role === "assistant" && history[i - 1].role === "user") {
      pairs.unshift([history[i - 1], history[i]]);
      i--; // skip the user message we just consumed
      if (pairs.length >= turns) break;
    }
  }
  return pairs.flat();
}

/**
 * Downscale an image data URL to a maximum width (edge case 8.2).
 * Uses a canvas to resize and re-encode as JPEG 0.8 quality for smaller payloads.
 * If the image is already within the width limit, it's returned as-is.
 *
 * @param {string} dataUrl  — "data:image/png;base64,…"
 * @param {number} maxWidth — max pixel width (default 1280)
 * @returns {Promise<string>} — downscaled data URL
 */
function downscaleImage(dataUrl, maxWidth = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (img.width <= maxWidth) {
        // No downscaling needed
        resolve(dataUrl);
        return;
      }

      const scale = maxWidth / img.width;
      const canvas = document.createElement("canvas");
      canvas.width = maxWidth;
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Re-encode as JPEG for smaller size
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("Failed to load screenshot for downscaling."));
    img.src = dataUrl;
  });
}
