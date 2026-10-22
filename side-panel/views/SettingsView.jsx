import React, { useState, useEffect } from "react";

/**
 * SettingsView
 * Slice 1: Gemini API key entry, save, load.
 * Slice 9 will add: Groq API key field.
 * Slice 14 will add: profile fields (name, college, skills, links).
 */

const STORAGE_KEY = "settings";

function InputField({ label, id, type = "text", value, onChange, placeholder, helpText }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 focus:border-lemon-400 transition"
      />
      {helpText && (
        <p className="text-xs text-gray-500">{helpText}</p>
      )}
    </div>
  );
}

export default function SettingsView() {
  const [geminiKey, setGeminiKey]   = useState("");
  const [saveStatus, setSaveStatus] = useState("idle"); // "idle" | "saving" | "saved" | "error"
  const [loaded, setLoaded]         = useState(false);

  // Load persisted settings on mount
  useEffect(() => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        console.error("[SettingsView] storage.get error:", chrome.runtime.lastError);
        return;
      }
      const saved = result?.[STORAGE_KEY] ?? {};
      setGeminiKey(saved.geminiApiKey ?? "");
      setLoaded(true);
    });
  }, []);

  const handleSave = () => {
    // Trim keys to avoid whitespace mistakes (edge case 1.5)
    const trimmedKey = geminiKey.trim();

    setSaveStatus("saving");

    chrome.storage.local.get(STORAGE_KEY, (result) => {
      if (chrome.runtime.lastError) {
        setSaveStatus("error");
        return;
      }
      const current = result?.[STORAGE_KEY] ?? {};
      const updated = {
        ...current,
        geminiApiKey: trimmedKey,
      };

      chrome.storage.local.set({ [STORAGE_KEY]: updated }, () => {
        if (chrome.runtime.lastError) {
          console.error("[SettingsView] storage.set error:", chrome.runtime.lastError);
          setSaveStatus("error");
          return;
        }
        setSaveStatus("saved");
        // Reset status indicator after 2 s
        setTimeout(() => setSaveStatus("idle"), 2000);
      });
    });
  };

  const statusLabel = {
    idle:   null,
    saving: "Saving…",
    saved:  "✓ Saved",
    error:  "⚠ Save failed — try again",
  }[saveStatus];

  const statusClass = {
    idle:   "",
    saving: "text-gray-500",
    saved:  "text-green-600",
    error:  "text-red-600",
  }[saveStatus];

  if (!loaded) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-gray-400">
        Loading settings…
      </div>
    );
  }

  return (
    <div
      id="panel-settings"
      role="tabpanel"
      aria-labelledby="tab-settings"
      className="flex flex-col h-full overflow-y-auto"
    >
      <div className="flex flex-col gap-6 p-4">

        {/* ── Section: AI Keys ── */}
        <section aria-labelledby="section-keys">
          <h2
            id="section-keys"
            className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3"
          >
            AI API Keys
          </h2>

          <div className="flex flex-col gap-4 bg-gray-50 rounded-xl p-4 border border-gray-200">
            <InputField
              label="Gemini API Key"
              id="gemini-key"
              type="password"
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              placeholder="AIza…"
              helpText="Get a free key at aistudio.google.com. Stored only on this device."
            />

            {/* Groq key field — Slice 9 will uncomment this */}
            {/* <InputField
              label="Groq API Key (fallback)"
              id="groq-key"
              type="password"
              value={groqKey}
              onChange={(e) => setGroqKey(e.target.value)}
              placeholder="gsk_…"
              helpText="Optional. Used as a fallback when Gemini rate limits are reached."
            /> */}
          </div>
        </section>

        {/* ── Save button ── */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saveStatus === "saving"}
            className="px-4 py-2 text-sm font-medium bg-lemon-400 hover:bg-lemon-500 text-gray-900 rounded-lg transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
          >
            Save Settings
          </button>
          {statusLabel && (
            <span className={`text-sm ${statusClass}`} role="status" aria-live="polite">
              {statusLabel}
            </span>
          )}
        </div>

        {/* ── Section: About ── */}
        <section aria-labelledby="section-about" className="mt-auto">
          <h2
            id="section-about"
            className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2"
          >
            About
          </h2>
          <div className="text-xs text-gray-500 space-y-1 bg-gray-50 rounded-xl p-3 border border-gray-200">
            <p>🍋 Lemon v0.1.0</p>
            <p>All data is stored locally on your device.</p>
            <p>API keys are never committed to source control or sent anywhere except the respective AI provider.</p>
          </div>
        </section>

      </div>
    </div>
  );
}
