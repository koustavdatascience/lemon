/**
 * Options page script — Lemon Slice 1
 * Handles Gemini API key save/load via chrome.storage.local.
 * Slice 9 will add Groq key handling.
 * Slice 14 will add profile fields.
 */

const STORAGE_KEY = "settings";

const geminiInput = document.getElementById("gemini-key");
const saveBtn     = document.getElementById("save-btn");
const statusEl    = document.getElementById("status");

// ─── Load saved settings ───────────────────────────────────────────────────────

chrome.storage.local.get(STORAGE_KEY, (result) => {
  if (chrome.runtime.lastError) {
    console.error("[Options] storage.get error:", chrome.runtime.lastError);
    return;
  }
  const saved = result?.[STORAGE_KEY] ?? {};
  geminiInput.value = saved.geminiApiKey ?? "";
});

// ─── Save settings ─────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  // Trim keys to avoid whitespace mistakes (edge case 1.5)
  const geminiKey = geminiInput.value.trim();

  setStatus("saving", "Saving…");
  saveBtn.disabled = true;

  chrome.storage.local.get(STORAGE_KEY, (result) => {
    if (chrome.runtime.lastError) {
      setStatus("error", "⚠ Save failed — try again");
      saveBtn.disabled = false;
      return;
    }

    const current = result?.[STORAGE_KEY] ?? {};
    const updated = {
      ...current,
      geminiApiKey: geminiKey,
    };

    chrome.storage.local.set({ [STORAGE_KEY]: updated }, () => {
      if (chrome.runtime.lastError) {
        console.error("[Options] storage.set error:", chrome.runtime.lastError);
        setStatus("error", "⚠ Save failed — try again");
        saveBtn.disabled = false;
        return;
      }

      setStatus("saved", "✓ Saved");
      saveBtn.disabled = false;
      setTimeout(() => setStatus("idle", ""), 2000);
    });
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  statusEl.textContent = text;
  statusEl.className = state === "idle" ? "" : `status-${state}`;
}

// Sync settings panel inside the side panel when this options page writes to storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    // Re-load to confirm the displayed value matches what was written
    const newVal = changes[STORAGE_KEY].newValue ?? {};
    geminiInput.value = newVal.geminiApiKey ?? "";
  }
});
