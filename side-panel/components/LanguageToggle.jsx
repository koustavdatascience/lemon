import React from "react";
import { useAppContext } from "../App.jsx";

/**
 * LanguageToggle — Slice 5
 * A small pill-shaped toggle in the App header that switches between
 * English ("en") and Hinglish ("hi-en").
 *
 * Reads and sets `language` via AppContext so every view stays in sync.
 * The setting is persisted to chrome.storage.local by App.jsx.
 *
 * Edge case 5.1: language is only resolved BEFORE a request starts —
 *   in-flight requests always complete in the language they began with.
 */
export default function LanguageToggle() {
  const { language, setLanguage } = useAppContext();

  const isHinglish = language === "hi-en";

  const toggle = () => setLanguage(isHinglish ? "en" : "hi-en");

  return (
    <button
      onClick={toggle}
      aria-pressed={isHinglish}
      aria-label={isHinglish ? "Switch to English" : "Switch to Hinglish"}
      title={isHinglish ? "Currently: Hinglish — click for English" : "Currently: English — click for Hinglish"}
      className={`
        flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold
        border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500
        ${isHinglish
          ? "bg-orange-100 border-orange-300 text-orange-700 hover:bg-orange-200"
          : "bg-white border-gray-300 text-gray-600 hover:bg-gray-50"
        }
      `}
    >
      {/* Language emoji flag */}
      <span aria-hidden="true">{isHinglish ? "🇮🇳" : "🇬🇧"}</span>
      <span>{isHinglish ? "Hinglish" : "EN"}</span>
    </button>
  );
}
