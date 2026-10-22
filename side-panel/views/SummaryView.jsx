import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAppContext } from "../App.jsx";

/**
 * SummaryView — Slice 3 + 4 + 5
 *
 * Slice 3: article extraction + structured summary (TL;DR, key points, next steps).
 * Slice 4: YouTube detection → chapter notes with clickable timestamp seek buttons.
 * Slice 5: language passed through every port message so prompts respect the toggle.
 *
 * Mode is determined automatically from the current tab URL:
 *   - youtube.com/watch?v=… or youtu.be/…  → "youtube"
 *   - everything else                       → "article"
 */

// ─── Port management ──────────────────────────────────────────────────────────

let _port = null;

function getPort() {
  if (!_port) {
    _port = chrome.runtime.connect({ name: "ai-stream" });
    _port.onDisconnect.addListener(() => { _port = null; });
  }
  return _port;
}

// ─── YouTube URL detection ────────────────────────────────────────────────────

/**
 * Returns "youtube" if the URL is a youtube.com/watch or youtu.be link,
 * "article" otherwise.
 * @param {string} url
 * @returns {"youtube"|"article"}
 */
function detectMode(url) {
  try {
    const parsed = new URL(url);
    const host   = parsed.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return "youtube";
    if (host === "youtube.com" && parsed.pathname.startsWith("/watch")) return "youtube";
    if (host === "youtube.com" && parsed.pathname.startsWith("/shorts/")) return "youtube"; // SW will reject gracefully
  } catch {
    // not a valid URL — treat as article
  }
  return "article";
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function SummaryView() {
  const { language } = useAppContext();  // Slice 5

  const [status,     setStatus]     = useState("idle");   // "idle"|"loading"|"done"|"error"
  const [statusText, setStatusText] = useState("");
  const [summary,    setSummary]    = useState("");       // accumulated stream
  const [meta,       setMeta]       = useState(null);     // { title, url, truncated, isYoutube, timestamps, videoId }
  const [error,      setError]      = useState(null);
  const [mode,       setMode]       = useState("article"); // detected from current tab

  const listenerRef = useRef(null);
  const bottomRef   = useRef(null);

  // Auto-scroll as tokens stream in
  useEffect(() => {
    if (status === "loading") {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [summary, status]);

  // Detect mode whenever SummaryView mounts or becomes visible
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
      if (chrome.runtime.lastError || !tab?.url) return;
      setMode(detectMode(tab.url));
    });
  }, []);

  // ── Summarise ───────────────────────────────────────────────────────────────

  const handleSummarise = useCallback(async () => {
    if (status === "loading") return;

    setError(null);
    setSummary("");
    setMeta(null);
    setStatus("loading");
    setStatusText(mode === "youtube" ? "Reading YouTube URL…" : "Reading page…");

    // Get active tab
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      setError("Could not access the current tab.");
      setStatus("error");
      return;
    }

    if (!tab?.id) {
      setError("No active tab found. Open a web page first.");
      setStatus("error");
      return;
    }

    const url = tab.url ?? "";

    // Re-detect mode from the actual current URL (may have changed)
    const currentMode = detectMode(url);
    setMode(currentMode);

    // Block browser system pages for article mode
    if (currentMode === "article") {
      if (url.startsWith("chrome://") || url.startsWith("edge://") || url.startsWith("about:")) {
        setError("🚫 Lemon can't read browser system pages. Open a regular web page first.");
        setStatus("error");
        return;
      }
    }

    // Set up port listener before posting
    const port = getPort();
    if (listenerRef.current) port.onMessage.removeListener(listenerRef.current);

    const listener = (msg) => {
      switch (msg.type) {
        case "status":
          setStatusText(msg.text);
          break;

        case "token":
          setSummary((prev) => prev + msg.text);
          break;

        case "done":
          setStatus("done");
          setMeta(msg.meta ?? null);
          port.onMessage.removeListener(listener);
          listenerRef.current = null;
          break;

        case "error":
          setError(msg.message);
          setStatus("error");
          port.onMessage.removeListener(listener);
          listenerRef.current = null;
          break;
      }
    };

    listenerRef.current = listener;
    port.onMessage.addListener(listener);

    const request = {
      type:     "summarise",
      tabId:    tab.id,
      mode:     currentMode,
      language, // Slice 5: pass current language to SW
    };

    try {
      port.postMessage(request);
    } catch {
      // Port disconnected between getPort() and postMessage — reconnect once
      _port = null;
      const fresh = getPort();
      fresh.onMessage.addListener(listener);
      fresh.postMessage(request);
    }
  }, [status, mode, language]);

  // ── Reset ────────────────────────────────────────────────────────────────────

  const handleReset = () => {
    setSummary("");
    setMeta(null);
    setError(null);
    setStatus("idle");
    setStatusText("");
  };

  // ── Timestamp seek (Slice 4) ─────────────────────────────────────────────────

  /**
   * Sends a seek message to the YouTube tab's content.
   * Uses chrome.tabs.sendMessage to the active tab; the page itself handles
   * seeking via the YouTube iframe player API or direct video element.
   *
   * Edge case 4.5: if the tab has navigated away, sendMessage throws — we catch
   * it and show a toast-style error.
   */
  const handleSeek = useCallback(async (seconds) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      // Inject a tiny script to seek the video element directly.
      // This avoids needing a persistent content script for seeking.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func:   seekYouTubeVideo,
        args:   [seconds],
      });
    } catch (err) {
      console.warn("[SummaryView] Seek failed:", err.message);
      setError("⚠️ Could not seek — the video tab may have changed. (Edge case 4.5)");
    }
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  const isLoading = status === "loading";
  const isYoutube = mode === "youtube" || meta?.isYoutube;

  return (
    <div
      id="panel-summary"
      role="tabpanel"
      aria-labelledby="tab-summary"
      className="flex flex-col h-full"
    >
      {/* ── Toolbar ── */}
      <div className="px-3 pt-3 pb-2 border-b border-gray-100 shrink-0 flex items-center gap-2">
        <button
          onClick={handleSummarise}
          disabled={isLoading}
          className="
            flex-1 flex items-center justify-center gap-2
            px-4 py-2 rounded-xl text-sm font-medium
            bg-lemon-400 hover:bg-lemon-500 text-gray-900
            disabled:opacity-50 disabled:cursor-not-allowed
            transition focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500
          "
          aria-busy={isLoading}
        >
          {isLoading ? (
            <>
              <span
                className="w-3.5 h-3.5 border-2 border-gray-700 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              <span>{statusText || "Working…"}</span>
            </>
          ) : (
            <>
              <span aria-hidden="true">{isYoutube ? "▶️" : "📄"}</span>
              <span>{isYoutube ? "Summarise video" : "Summarise this page"}</span>
            </>
          )}
        </button>

        {(status === "done" || status === "error") && (
          <button
            onClick={handleReset}
            className="p-2 rounded-xl text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
            aria-label="Clear summary"
            title="Clear"
          >
            {/* Trash icon */}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="w-4 h-4"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        )}
      </div>

      {/* ── Content area ── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 scrollbar-thin">

        {/* Idle state */}
        {status === "idle" && <IdleState mode={mode} />}

        {/* Error */}
        {status === "error" && error && (
          <div
            role="alert"
            className="rounded-xl bg-red-50 border border-red-200 p-4 text-sm text-red-700"
          >
            {error}
          </div>
        )}

        {/* Streaming / done — article */}
        {!meta?.isYoutube && (status === "loading" || status === "done") && summary && (
          <div className="flex flex-col gap-3">
            {meta?.title && (
              <p className="text-xs text-gray-400 truncate" title={meta.title}>
                {meta.title}
              </p>
            )}
            {meta?.truncated && (
              <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                ⚠️ Article was very long — summarising first section only.
              </p>
            )}
            <SummaryContent text={summary} streaming={status === "loading"} />
          </div>
        )}

        {/* Streaming / done — YouTube */}
        {meta?.isYoutube && (status === "loading" || status === "done") && summary && (
          <div className="flex flex-col gap-3">
            {/* Video title */}
            {meta?.title && (
              <p className="text-xs text-gray-400 truncate" title={meta.title}>
                📺 {meta.title}
              </p>
            )}

            {/* Chapter notes with inline seek buttons */}
            <YoutubeContent
              text={summary}
              timestamps={meta?.timestamps ?? []}
              streaming={status === "loading"}
              onSeek={handleSeek}
            />
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Article summary renderer ─────────────────────────────────────────────────

/**
 * Renders the streamed article summary (markdown-lite: **headers** + - bullets).
 */
function SummaryContent({ text, streaming }) {
  const lines = text.split("\n");

  return (
    <div className="text-sm text-gray-800 leading-relaxed space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
          return (
            <h3 key={i} className="font-semibold text-gray-900 mt-3 first:mt-0">
              {trimmed.slice(2, -2)}
            </h3>
          );
        }

        if (trimmed.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2 pl-2">
              <span className="text-lemon-500 shrink-0 mt-0.5" aria-hidden="true">•</span>
              <span>{trimmed.slice(2)}</span>
            </div>
          );
        }

        if (!trimmed) return <div key={i} className="h-1" />;
        return <p key={i}>{trimmed}</p>;
      })}

      {streaming && (
        <span
          aria-hidden="true"
          className="inline-block w-0.5 h-3.5 bg-gray-400 ml-0.5 align-middle animate-pulse"
        />
      )}
    </div>
  );
}

// ─── YouTube chapter renderer ─────────────────────────────────────────────────

/**
 * Renders YouTube chapter notes.
 * Lines that match [M:SS] become clickable seek buttons.
 * Bullet lines are indented under their chapter.
 */
function YoutubeContent({ text, timestamps, streaming, onSeek }) {
  // Build a lookup: "M:SS" → seconds
  const seekMap = {};
  for (const ts of timestamps) {
    seekMap[ts.time] = ts.seconds;
  }

  const lines = text.split("\n");

  return (
    <div className="text-sm text-gray-800 leading-relaxed space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-1" />;

        // Chapter heading: [M:SS] Title
        const chapterMatch = trimmed.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.+)/);
        if (chapterMatch) {
          const time    = chapterMatch[1];
          const label   = chapterMatch[2];
          const seconds = seekMap[time] ?? timestampToSecondsUI(time);

          return (
            <div key={i} className="flex items-baseline gap-2 mt-3 first:mt-0">
              {/* Clickable timestamp chip */}
              <button
                onClick={() => onSeek(seconds)}
                className="
                  shrink-0 inline-flex items-center gap-0.5
                  px-1.5 py-0.5 rounded text-xs font-mono font-semibold
                  bg-red-100 text-red-700 hover:bg-red-200
                  transition focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400
                "
                aria-label={`Seek to ${time}`}
                title={`Seek to ${time}`}
              >
                ▶ {time}
              </button>
              <span className="font-semibold text-gray-900">{label}</span>
            </div>
          );
        }

        // Bullet point under a chapter
        if (trimmed.startsWith("- ")) {
          return (
            <div key={i} className="flex gap-2 pl-6">
              <span className="text-lemon-500 shrink-0 mt-0.5" aria-hidden="true">•</span>
              <span>{trimmed.slice(2)}</span>
            </div>
          );
        }

        // Plain text
        return <p key={i} className="pl-1">{trimmed}</p>;
      })}

      {streaming && (
        <span
          aria-hidden="true"
          className="inline-block w-0.5 h-3.5 bg-gray-400 ml-0.5 align-middle animate-pulse"
        />
      )}
    </div>
  );
}

/**
 * Client-side timestamp parser (mirrors the SW's timestampToSeconds).
 * Used as a fallback when the seek map doesn't have a key yet during streaming.
 */
function timestampToSecondsUI(ts) {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// ─── Idle state ───────────────────────────────────────────────────────────────

function IdleState({ mode }) {
  if (mode === "youtube") {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 py-12 text-center px-6">
        <span className="text-4xl" aria-hidden="true">▶️</span>
        <p className="font-medium text-gray-700 text-sm">Summarise this YouTube video</p>
        <ul className="text-xs text-gray-400 space-y-1 text-left list-none">
          <li>📑  Chapter-style notes</li>
          <li>⏱️  Clickable timestamps to seek</li>
          <li>🌐  Works on public videos</li>
        </ul>
        <p className="text-xs text-gray-400 mt-1">
          Tap <strong>Summarise video</strong> to start.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 py-12 text-center px-6">
      <span className="text-4xl" aria-hidden="true">📄</span>
      <p className="font-medium text-gray-700 text-sm">Summarise any article</p>
      <ul className="text-xs text-gray-400 space-y-1 text-left list-none">
        <li>📰  News articles</li>
        <li>📝  Blog posts</li>
        <li>📚  Research pages</li>
      </ul>
      <p className="text-xs text-gray-400 mt-1">
        Open an article and tap <strong>Summarise this page</strong>.
      </p>
    </div>
  );
}

// ─── Seek helper (injected into page via executeScript) ───────────────────────

/**
 * This function is serialised and injected into the YouTube tab via
 * chrome.scripting.executeScript. It finds the <video> element and seeks it.
 *
 * Defined at module scope so it doesn't capture any closure variables —
 * executeScript requires the function to be self-contained.
 *
 * @param {number} seconds
 */
function seekYouTubeVideo(seconds) {
  const video = document.querySelector("video");
  if (video) {
    video.currentTime = seconds;
    // If the video is paused, play it after seeking for a better UX
    if (video.paused) video.play().catch(() => {});
  }
}
