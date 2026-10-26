/**
 * scanner.js — Content Script (Slice 10)
 *
 * Injected on-demand by the service worker via chrome.scripting.executeScript
 * (same mechanism used for reader.js in Slice 3). On injection it immediately
 * scans the page for interactive elements, overlays numbered yellow badges on
 * them, builds a compact "action map", and reports it back to the extension
 * via chrome.runtime.sendMessage.
 *
 * The script stays resident so later commands can reuse the same snapshot:
 *   { type: "scan-rescan" }               → cleanup + re-scan + re-badge + report
 *   { type: "scan-get-map" }               → return current action map (no re-scan)
 *   { type: "scan-cleanup" }               → remove all badges (idempotent)
 *   { type: "scan-highlight", id: N }      → outline element N (visual only)
 *   { type: "scan-clear-highlight" }       → remove highlight
 *
 * Re-injection is safe: a second inject triggers a rescan instead of
 * double-badging (see INJECTION_GUARD).
 *
 * Action map shape (compact — no raw HTML, to keep tokens low and avoid prompt
 * injection from page content, per architecture §6.3):
 *   {
 *     id: 1,                       // 1-based, stable for THIS snapshot
 *     type: "button"|"link"|"text"|"email"|"password"|"checkbox"|"radio"
 *         |"number"|"search"|"tel"|"url"|"file"|"date"|"range"|"color"
 *         |"textarea"|"select"|"summary"|"menuitem"|"tab"|"option"
 *         |"switch"|"focusable",
 *     label: "Submit",             // aria-label / associated label / text / placeholder
 *     placeholder: "Email",        // inputs/textareas only (when present)
 *     value: "current value",      // inputs/selects/textareas (truncated); omitted for password
 *     options: ["IN","USA"],       // selects only (first 50 options)
 *     checked: true,               // checkbox / radio / switch only
 *     href: "/login",              // links only (when not "#")
 *     rect: { x, y, w, h },        // document coords — disambiguates duplicate labels (edge 10.4)
 *     disabled: false
 *   }
 *
 * Edge cases handled:
 *   10.1 Shadow DOM            → queryAll() recurses into open shadow roots
 *   10.2 Too many elements     → capped at 50, in-viewport elements prioritised
 *   10.3 DOM changes           → IDs valid only for current snapshot; use scan-rescan
 *   10.4 Duplicate labels      → rect included for disambiguation
 *   10.5 Badges shift layout   → badges are position:absolute, pointer-events:none
 *   10.6 cleanup idempotent    → skip silently if no badges
 *   10.7 Cross-origin iframes  → only the top-level document is scanned
 *   X.1  lastError checks      → all chrome API calls guarded
 *   X.2  unknown message type  → returns an error, never throws
 *   X.5  own extension page     → scanner refuses on chrome:// / chrome-extension:// / about:
 */

(function scannerInit() {
  "use strict";

  // ─── Guards & constants ──────────────────────────────────────────────────────

  const BADGE_ATTR      = "data-lemon-badge";
  const BADGE_ID_ATTR   = "data-lemon-badge-id";
  const OVERLAY_ATTR    = "data-lemon-overlay";
  const HIGHLIGHT_ATTR  = "data-lemon-highlight";
  const STYLE_ID        = "lemon-scanner-styles";
  const MAX_ELEMENTS    = 50;   // edge case 10.2
  const LABEL_MAX_CHARS = 60;   // keep the action map compact
  const VALUE_MAX_CHARS = 80;

  // Re-injection guard: if the file is injected again on the same page, just
  // refresh the snapshot instead of stacking duplicate badges.
  if (window.__lemonScannerInjected) {
    rescan();
    return;
  }
  window.__lemonScannerInjected = true;

  /** @type {HTMLElement[]} element index; ids are 1-based → elements[id - 1] */
  let elements = [];
  /** @type {{ id:number, el:HTMLElement, badge:HTMLElement }[]} */
  let badgeRecords = [];
  let overlay = null;
  let styleEl = null;
  let resizeRaf = 0;

  // ─── Styles ───────────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      [${OVERLAY_ATTR}] {
        position: absolute; top: 0; left: 0;
        pointer-events: none;               /* edge case 10.5 */
        z-index: 2147483646;
      }
      [${BADGE_ATTR}] {
        position: absolute;
        min-width: 18px; height: 18px;
        padding: 0 4px;
        border-radius: 999px;
        background: #facc15;                 /* lemon yellow */
        color: #1f2937;
        font: 700 11px/18px -apple-system, "Segoe UI", Roboto, sans-serif;
        text-align: center;
        box-shadow: 0 1px 3px rgba(0,0,0,.45);
        pointer-events: none;                /* edge case 10.5 */
        transform: translate(-9px, -9px);     /* straddle the element's top-left corner */
        white-space: nowrap;
      }
      [${HIGHLIGHT_ATTR}] {
        outline: 3px solid #f97316 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(249,115,22,.25) !important;
        transition: outline-offset .15s ease, box-shadow .15s ease;
      }
    `;
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = css;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ─── Element discovery (queryAll) ─────────────────────────────────────────────

  const INTERACTIVE_SELECTOR = [
    "button",
    "a[href]",
    "input",
    "textarea",
    "select",
    "summary",
    "[role='button']",
    "[role='checkbox']",
    "[role='link']",
    "[role='menuitem']",
    "[role='menuitemcheckbox']",
    "[role='menuitemradio']",
    "[role='tab']",
    "[role='option']",
    "[role='switch']",
    "[role='treeitem']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  /**
   * Collect all candidate interactive elements in document order, recursing
   * into open shadow roots (edge case 10.1). Cross-origin iframes are never
   * entered — querySelectorAll does not traverse into them (edge case 10.7).
   * @returns {HTMLElement[]}
   */
  function queryAll() {
    const out = [];
    collect(document, out);
    return out;
  }

  function collect(root, out) {
    try {
      root.querySelectorAll(INTERACTIVE_SELECTOR).forEach((el) => out.push(el));
    } catch (e) {
      // Malformed roots shouldn't abort the whole scan.
    }
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) collect(el.shadowRoot, out);
      });
    } catch (e) {
      // ignore — keep the scan resilient
    }
  }

  /**
   * Cheap synchronous visibility test (edge case 10.2).
   * @param {HTMLElement} el
   * @returns {boolean}
   */
  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.tagName === "INPUT" && el.type === "hidden") return false;
    const style = getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      style.contentVisibility === "hidden"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return false;
    return true;
  }

  /**
   * Fraction of the element overlapping the viewport (0..1). Higher = more
   * in-view; used to prioritise when capping the action map (edge case 10.2).
   * @param {HTMLElement} el
   * @returns {number}
   */
  function viewportScore(el) {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const ox = Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0));
    const oy = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
    const area = (rect.width || 1) * (rect.height || 1);
    return area > 0 ? (ox * oy) / area : 0;
  }

  // ─── Type & label extraction ──────────────────────────────────────────────────

  /** @param {HTMLElement} el @returns {string} */
  function getType(el) {
    const tag = el.tagName;
    const role = el.getAttribute("role") || "";

    if (tag === "BUTTON") return "button";
    if (tag === "A") return "link";
    if (tag === "TEXTAREA") return "textarea";
    if (tag === "SELECT") return "select";
    if (tag === "SUMMARY") return "summary";

    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "submit" || t === "button" || t === "image" || t === "reset") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["number", "email", "password", "search", "tel", "url", "file", "date",
           "datetime-local", "time", "month", "range", "color"].includes(t)) {
        if (t === "datetime-local" || t === "time" || t === "month") return "date";
        return t;
      }
      return "text";
    }

    if (role === "button") return "button";
    if (role === "checkbox") return "checkbox";
    if (role === "link") return "link";
    if (role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio" || role === "treeitem") return "menuitem";
    if (role === "tab") return "tab";
    if (role === "option") return "option";
    if (role === "switch") return "switch";

    // generic focusable element (tabindex)
    return "focusable";
  }

  /** @param {HTMLElement} el @returns {string} */
  function getLabel(el) {
    // 1. aria-label
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel?.trim()) return clamp(ariaLabel.trim());

    // 2. aria-labelledby → text of referenced element(s)
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((e) => e.textContent?.trim() || "")
        .filter(Boolean)
        .join(" ");
      if (text) return clamp(text);
    }

    // 3. associated <label for="id">
    if (el.id) {
      const lbl = document.querySelector(`label[for='${cssEscape(el.id)}']`);
      if (lbl?.textContent?.trim()) return clamp(lbl.textContent.trim());
    }

    // 4. wrapping <label>
    if (el.tagName !== "LABEL") {
      const wrapping = el.closest("label");
      if (wrapping?.textContent?.trim() && el.value !== wrapping.textContent.trim()) {
        return clamp(wrapping.textContent.trim());
      }
    }

    // 5. placeholder (inputs / textareas)
    if (el.placeholder?.trim()) return clamp(el.placeholder.trim());

    // 6. title
    if (el.title?.trim()) return clamp(el.title.trim());

    // 7. visible text — only for non-form elements (avoid <select> option soup)
    const isFormField = el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
    if (!isFormField) {
      const text = el.textContent?.trim();
      if (text) return clamp(text);
    }

    // 8. value for inputs
    if (el.value?.trim()) return clamp(el.value.trim());

    // 9. name attribute
    const name = el.getAttribute("name");
    if (name?.trim()) return clamp(name.trim());

    // 10. fallback to type so the AI at least knows what it is
    return getType(el);
  }

  function clamp(s) {
    s = String(s).replace(/\s+/g, " ").trim();
    return s.length > LABEL_MAX_CHARS ? s.slice(0, LABEL_MAX_CHARS) + "…" : s;
  }

  function clampValue(s) {
    s = String(s ?? "");
    return s.length > VALUE_MAX_CHARS ? s.slice(0, VALUE_MAX_CHARS) + "…" : s;
  }

  function cssEscape(s) {
    if (window.CSS?.escape) return window.CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // ─── Action map ───────────────────────────────────────────────────────────────

  /**
   * Build the compact action map for the current `elements` snapshot.
   * @returns {object[]}
   */
  function buildActionMap() {
    return elements.map((el, i) => {
      const rect = el.getBoundingClientRect();
      const type = getType(el);
      const entry = {
        id: i + 1,
        type,
        label: getLabel(el),
        rect: {
          x: Math.round(rect.left + window.scrollX),
          y: Math.round(rect.top + window.scrollY),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      };

      if ("placeholder" in el && el.placeholder) entry.placeholder = clamp(el.placeholder);

      if (type === "select") {
        entry.options = Array.from(el.options).slice(0, 50)
          .map((o) => clamp(o.label || o.value || ""));
        if (el.value) entry.value = clampValue(el.value);
      } else if (type === "checkbox" || type === "radio" || type === "switch") {
        entry.checked = !!el.checked;
      } else if (type === "link") {
        const href = el.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) entry.href = clamp(href);
      } else if (type === "password") {
        // Never echo a password value into the action map (privacy); Slice 16
        // SafetyGuard will block the field entirely, but we don't leak it here.
        entry.value = "";
        entry.sensitive = true;
      } else {
        // text-ish inputs, textarea, date, number, search, etc.
        if (el.value) entry.value = clampValue(el.value);
      }

      return entry;
    });
  }

  // ─── Badges ───────────────────────────────────────────────────────────────────

  function ensureOverlay() {
    if (overlay && overlay.isConnected) return overlay;
    overlay = document.createElement("div");
    overlay.setAttribute(OVERLAY_ATTR, "");
    (document.body || document.documentElement).appendChild(overlay);
    return overlay;
  }

  /**
   * Create one numbered badge per element (edge case 10.5: absolute,
   * pointer-events:none so layout is unaffected).
   */
  function injectBadges() {
    const mount = ensureOverlay();
    badgeRecords = [];
    elements.forEach((el, i) => {
      const badge = document.createElement("div");
      badge.setAttribute(BADGE_ATTR, "");
      badge.setAttribute(BADGE_ID_ATTR, String(i + 1));
      badge.textContent = String(i + 1);
      mount.appendChild(badge);
      badgeRecords.push({ id: i + 1, el, badge });
    });
    positionBadges();
  }

  /**
   * Position every badge at its element's top-left corner in document coords.
   * Called on inject, resize, and scroll (rAF-throttled).
   */
  function positionBadges() {
    resizeRaf = 0;
    for (const r of badgeRecords) {
      const rect = r.el.getBoundingClientRect();
      const hidden = rect.width <= 0 && rect.height <= 0;
      r.badge.style.top  = `${rect.top + window.scrollY}px`;
      r.badge.style.left = `${rect.left + window.scrollX}px`;
      r.badge.style.display = hidden ? "none" : "block";
    }
  }

  function onResizeOrScroll() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(positionBadges);
  }

  // ─── Highlight (visual only; used by Slice 11 / 13) ────────────────────────────

  function highlight(id) {
    clearHighlight();
    const el = elements[id - 1];
    if (!el) return false;
    el.setAttribute(HIGHLIGHT_ATTR, "");
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) { /* ignore */ }
    return true;
  }

  function clearHighlight() {
    document.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((el) => el.removeAttribute(HIGHLIGHT_ATTR));
  }

  // ─── Cleanup (edge case 10.6: idempotent) ──────────────────────────────────────

  /**
   * Remove all badges + highlight. Safe to call when none exist.
   * Keeps the <style> (matches nothing once badges are gone) so a later
   * rescan doesn't need to re-inject it.
   */
  function cleanup() {
    overlay?.remove();
    overlay = null;
    clearHighlight();
    badgeRecords = [];
    elements = [];
  }

  // ─── Orchestration ─────────────────────────────────────────────────────────────

  function isBrowserInternalPage(href) {
    return (
      href.startsWith("chrome-extension://") || // edge case X.5
      href.startsWith("chrome://") ||
      href.startsWith("about:") ||
      href.startsWith("edge://")
    );
  }

  /**
   * Full scan: cleanup → query → filter → cap → number → badge → map.
   * @returns {{ actionMap:object[], count:number, truncated:boolean, iframeNote:boolean, blocked:boolean }}
   */
  function scan() {
    cleanup();

    const href = location.href;
    if (isBrowserInternalPage(href)) {
      return { actionMap: [], count: 0, truncated: false, iframeNote: false, blocked: true };
    }

    const all = queryAll();

    // Build visible candidates with their original DOM-collection index so we
    // can re-sort back to document order after capping (deterministic, works
    // across shadow roots where compareDocumentPosition is unreliable).
    const visibleEntries = [];
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (isVisible(el)) visibleEntries.push({ el, idx: i, score: viewportScore(el) });
    }

    let truncated = false;
    let chosen;

    if (visibleEntries.length > MAX_ELEMENTS) {
      // edge case 10.2: keep the 50 most in-view, then restore DOM order.
      truncated = true;
      const byScore = [...visibleEntries].sort((a, b) => b.score - a.score || a.idx - b.idx);
      chosen = byScore.slice(0, MAX_ELEMENTS)
        .sort((a, b) => a.idx - b.idx)
        .map((e) => e.el);
    } else {
      chosen = visibleEntries.map((e) => e.el);
    }

    elements = chosen;
    injectBadges();

    // edge case 10.7: note that iframe content was out of reach.
    const iframeNote = document.querySelectorAll("iframe").length > 0;

    return {
      actionMap: buildActionMap(),
      count: elements.length,
      truncated,
      iframeNote,
      blocked: false,
    };
  }

  function rescan() {
    const result = scan();
    report(result);
    return result;
  }

  // ─── Messaging ─────────────────────────────────────────────────────────────────

  /**
   * Report the page state back to the extension (edge case X.1: guard errors).
   * If no listener is registered (Slice 10 wires none in the SW yet) the
   * message is silently dropped — the badges still render, so the scanner is
   * still useful on its own.
   */
  function report(result) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage({
        type:      "page-state",
        success:   !result.blocked,
        url:       location.href,
        actionMap: result.actionMap,
        count:     result.count,
        truncated: result.truncated,
        iframeNote: result.iframeNote,
        ...(result.blocked ? { error: "Scanner cannot run on browser or extension pages." } : {}),
      });
    } catch (e) {
      // No receiver — ignore (badges are still visible).
    }
  }

  if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      const { type } = msg || {};
      try {
        switch (type) {
          case "scan-rescan": {
            const result = scan();
            report(result);
            sendResponse({ ok: true, ...result });
            break;
          }
          case "scan-get-map":
            sendResponse({ ok: true, actionMap: buildActionMap(), count: elements.length });
            break;
          case "scan-cleanup": {
            const had = badgeRecords.length;
            cleanup();
            sendResponse({ ok: true, removed: had });
            break;
          }
          case "scan-highlight": {
            const ok = highlight(Number(msg?.id));
            sendResponse(ok
              ? { ok: true }
              : { ok: false, error: "Element id not found in current snapshot." });
            break;
          }
          case "scan-clear-highlight":
            clearHighlight();
            sendResponse({ ok: true });
            break;
          default:
            // edge case X.2: never throw — return an error.
            sendResponse({ ok: false, error: `Unknown scan message type: ${type}` });
        }
      } catch (err) {
        sendResponse({ ok: false, error: `Scanner error: ${err.message}` });
      }
      return false; // synchronous sendResponse
    });
  }

  // ─── Listeners ─────────────────────────────────────────────────────────────────

  window.addEventListener("resize", onResizeOrScroll, { passive: true });
  window.addEventListener("scroll", onResizeOrScroll, { passive: true, capture: true });

  // ─── Auto-run on inject ─────────────────────────────────────────────────────────

  injectStyles();
  report(scan());
})();
