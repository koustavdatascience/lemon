/**
 * actor.js — Content Script (Slice 12)
 *
 * Executes approved DOM actions on behalf of the agent engine.
 * Injected on-demand by agent-engine.js via chrome.scripting.executeScript.
 *
 * Listens for:
 *   { type: "execute-action", action: {
 *       action:    "click" | "type" | "select" | "scroll" | "done",
 *       elementId: <integer | null>,
 *       value:     <string | null>,
 *   }}
 *
 * Responds via sendResponse:
 *   { ok: true }
 *   { ok: false, error: string }
 *
 * Element IDs refer to the CURRENT scanner snapshot.
 * The scanner must be injected before actor.js is called so that the
 * page has live badge records the actor can look up via the same global map.
 * Rather than coupling directly to scanner internals, we ask the scanner
 * for the current action map via the "scan-get-map" message and use the
 * rect data to locate the element by position.
 *
 * Re-injection guard: a second inject is a no-op (INJECTION_GUARD).
 *
 * Edge cases handled:
 *   12.2 Element scrolled out of view → scrollIntoView before acting
 *   12.3 type on pre-filled input     → clear before typing
 *   12.8 Custom dropdown (non-native) → flagged; click-sequence fallback
 *   X.1  lastError checks             → all chrome API calls guarded
 *   X.2  Unknown message type         → returns error, never throws
 */

(function actorInit() {
  "use strict";

  // ─── Re-injection guard ──────────────────────────────────────────────────────
  if (window.__lemonActorInjected) return;
  window.__lemonActorInjected = true;

  // ─── Element lookup ───────────────────────────────────────────────────────────

  /**
   * Find an element by its scanner-assigned elementId.
   * We ask the scanner for the current action map, then use the stored
   * rect to find the live element at that position in the DOM.
   *
   * @param {number} elementId
   * @returns {Promise<{ok:true, el:HTMLElement} | {ok:false, error:string}>}
   */
  async function findElement(elementId) {
    // Ask the scanner (same document) for its current element map
    const mapResult = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "scan-get-map" }, (resp) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(resp);
      });
    });

    if (!mapResult?.ok || !mapResult.actionMap?.length) {
      return { ok: false, error: `Element lookup failed: scanner not ready or no elements on page.` };
    }

    const entry = mapResult.actionMap.find((e) => e.id === elementId);
    if (!entry) {
      return { ok: false, error: `Element ${elementId} not found in current scanner snapshot.` };
    }

    // Use the rect centre to hit-test the live DOM.
    const { x, y, w, h } = entry.rect ?? {};
    if (x == null) {
      return { ok: false, error: `Element ${elementId} has no position data.` };
    }

    const cx = x + Math.round(w / 2);
    const cy = y + Math.round(h / 2);

    // elementFromPoint needs viewport coords — subtract scroll
    const vx = cx - window.scrollX;
    const vy = cy - window.scrollY;
    const el = document.elementFromPoint(vx, vy);

    if (!el) {
      // Scroll the approximate position into view and try once more
      window.scrollTo({ top: Math.max(0, y - 200), behavior: "instant" });
      await _sleep(150);
      const vx2 = cx - window.scrollX;
      const vy2 = cy - window.scrollY;
      const el2 = document.elementFromPoint(vx2, vy2);
      if (!el2) {
        return { ok: false, error: `Could not locate element ${elementId} in the live DOM.` };
      }
      return { ok: true, el: el2 };
    }

    return { ok: true, el };
  }

  // ─── Action implementations ───────────────────────────────────────────────────

  /** Click a button, link, checkbox, or other clickable element. */
  async function doClick(elementId) {
    const found = await findElement(elementId);
    if (!found.ok) return found;

    const el = found.el;
    _scrollIntoView(el);
    await _sleep(80); // let scroll settle

    try {
      // Dispatch a real mouse event sequence so page JS sees it
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      el.dispatchEvent(new MouseEvent("mouseup",   { bubbles: true, cancelable: true }));
      el.click();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `click failed: ${err.message}` };
    }
  }

  /**
   * Type text into an input or textarea.
   * Clears the existing value first (edge case 12.3).
   */
  async function doType(elementId, value) {
    if (value == null) return { ok: false, error: "type action requires a value." };

    const found = await findElement(elementId);
    if (!found.ok) return found;

    const el = found.el;

    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement)
    ) {
      return { ok: false, error: `Element ${elementId} is not a text input or textarea.` };
    }

    _scrollIntoView(el);
    await _sleep(80);

    try {
      el.focus();
      await _sleep(40);

      // Edge case 12.3: clear existing value
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el), "value"
      )?.set;

      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        el.value = "";
      }

      // Type character by character for maximum compatibility with React/Vue
      for (const char of String(value)) {
        el.dispatchEvent(new KeyboardEvent("keydown",  { key: char, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));

        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(el, el.value + char);
        } else {
          el.value += char;
        }

        el.dispatchEvent(new Event("input",   { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        await _sleep(8); // ~120 wpm pacing
      }

      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur",   { bubbles: true }));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `type failed: ${err.message}` };
    }
  }

  /**
   * Select an option in a <select> element.
   * Falls back to a click-sequence for custom dropdowns (edge case 12.8).
   */
  async function doSelect(elementId, value) {
    if (value == null) return { ok: false, error: "select action requires a value." };

    const found = await findElement(elementId);
    if (!found.ok) return found;

    const el = found.el;
    _scrollIntoView(el);
    await _sleep(80);

    // Native <select>
    if (el instanceof HTMLSelectElement) {
      try {
        const option = Array.from(el.options).find(
          (o) => o.value === value || o.text === value || o.label === value
        );
        if (!option) {
          return { ok: false, error: `Option "${value}" not found in select element ${elementId}.` };
        }

        el.value = option.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `select failed: ${err.message}` };
      }
    }

    // Edge case 12.8: custom dropdown — try clicking the element to open it,
    // then clicking a child that matches the value text.
    try {
      el.click();
      await _sleep(300);
      // Look for a child or sibling option with matching text
      const allItems = [
        ...document.querySelectorAll('[role="option"],[role="menuitem"],[role="listitem"]'),
      ];
      const match = allItems.find(
        (item) => item.textContent?.trim() === value
      );
      if (match) {
        match.click();
        return { ok: true };
      }
      return {
        ok: false,
        error: `Custom dropdown: option "${value}" not found after opening.`,
      };
    } catch (err) {
      return { ok: false, error: `custom select failed: ${err.message}` };
    }
  }

  /**
   * Scroll the page in a direction.
   * elementId is null for scroll actions.
   */
  async function doScroll(value) {
    const dir = (value ?? "down").toLowerCase();
    const SCROLL_PX = 600;
    try {
      switch (dir) {
        case "up":    window.scrollBy({ top: -SCROLL_PX, behavior: "smooth" }); break;
        case "down":  window.scrollBy({ top:  SCROLL_PX, behavior: "smooth" }); break;
        case "top":   window.scrollTo({ top: 0,           behavior: "smooth" }); break;
        case "bottom":window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
        default:      window.scrollBy({ top:  SCROLL_PX, behavior: "smooth" }); break;
      }
      await _sleep(500); // give smooth scroll time to settle
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `scroll failed: ${err.message}` };
    }
  }

  // ─── Message listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const { type } = msg ?? {};

    if (type !== "execute-action") {
      // edge case X.2: unknown types bubble; actor only handles execute-action
      return false;
    }

    const { action } = msg;
    if (!action) {
      sendResponse({ ok: false, error: "execute-action: missing action payload." });
      return false;
    }

    // Run async and keep the response channel open
    (async () => {
      try {
        let result;
        switch (action.action) {
          case "click":
            result = await doClick(action.elementId);
            break;
          case "type":
            result = await doType(action.elementId, action.value);
            break;
          case "select":
            result = await doSelect(action.elementId, action.value);
            break;
          case "scroll":
            result = await doScroll(action.value);
            break;
          case "done":
            result = { ok: true };
            break;
          default:
            result = { ok: false, error: `Unknown action type: "${action.action}"` };
        }
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: `Actor unhandled error: ${err.message}` });
      }
    })();

    return true; // keep sendResponse channel open (async)
  });

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /** Scroll element into view with minimal disruption (edge case 12.2). */
  function _scrollIntoView(el) {
    try {
      el.scrollIntoView({ block: "nearest", behavior: "instant" });
    } catch { /* non-fatal */ }
  }

  /** Simple async sleep. */
  function _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

})();
