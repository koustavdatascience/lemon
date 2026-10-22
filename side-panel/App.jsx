import React, { createContext, useContext, useState, useEffect } from "react";
import ChatView from "./views/ChatView.jsx";
import SummaryView from "./views/SummaryView.jsx";
import AgentView from "./views/AgentView.jsx";
import SkillsView from "./views/SkillsView.jsx";
import SettingsView from "./views/SettingsView.jsx";
import LanguageToggle from "./components/LanguageToggle.jsx";

// ─── App-wide Context ─────────────────────────────────────────────────────────

/** Shared state available to all views via useAppContext() */
export const AppContext = createContext(null);

export function useAppContext() {
  return useContext(AppContext);
}

// ─── Tab definitions ──────────────────────────────────────────────────────────

const TABS = [
  { id: "chat",     label: "Chat",     icon: "💬" },
  { id: "summary",  label: "Summary",  icon: "📄" },
  { id: "agent",    label: "Agent",    icon: "🤖" },
  { id: "skills",   label: "Skills",   icon: "⚡" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

// ─── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [activeTab, setActiveTab] = useState("chat");

  // Language: "en" | "hi-en"
  const [language, setLanguage] = useState("en");

  // Slice 7: pending context-menu result to deliver to ChatView
  const [pendingContextResult, setPendingContextResult] = useState(null);

  // Load language preference from storage on mount
  useEffect(() => {
    chrome.storage.local.get("settings", (result) => {
      if (chrome.runtime.lastError) return;
      const lang = result?.settings?.language;
      if (lang === "en" || lang === "hi-en") {
        setLanguage(lang);
      }
    });
  }, []);

  // Persist language preference whenever it changes
  useEffect(() => {
    chrome.storage.local.get("settings", (result) => {
      if (chrome.runtime.lastError) return;
      const current = result?.settings ?? {};
      chrome.storage.local.set({ settings: { ...current, language } });
    });
  }, [language]);

  // Slice 7: Listen for context-menu results from the SW.
  // Switch to the Chat tab and store the result for ChatView to consume.
  useEffect(() => {
    const listener = (message) => {
      if (message.type !== "context-menu-result") return;
      setActiveTab("chat");
      setPendingContextResult(message);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const contextValue = {
    language,
    setLanguage,
    activeTab,
    setActiveTab,
    pendingContextResult,
    setPendingContextResult,
  };

  const renderView = () => {
    switch (activeTab) {
      case "chat":     return <ChatView />;
      case "summary":  return <SummaryView />;
      case "agent":    return <AgentView />;
      case "skills":   return <SkillsView />;
      case "settings": return <SettingsView />;
      default:         return <ChatView />;
    }
  };

  return (
    <AppContext.Provider value={contextValue}>
      <div className="flex flex-col h-screen bg-white">
        {/* ── Header ── */}
        <header className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-lemon-400 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xl" aria-hidden="true">🍋</span>
            <span className="font-semibold text-gray-900 text-sm">Lemon</span>
          </div>
          {/* Slice 5: language toggle — visible on all tabs */}
          <LanguageToggle />
        </header>

        {/* ── View content ── */}
        <main className="flex-1 overflow-hidden">
          {renderView()}
        </main>

        {/* ── Bottom tab bar ── */}
        <nav
          className="flex border-t border-gray-200 bg-white shrink-0"
          role="tablist"
          aria-label="Lemon navigation"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 flex flex-col items-center py-2 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500 ${
                activeTab === tab.id
                  ? "text-lemon-600 border-t-2 border-lemon-500 -mt-px bg-lemon-50"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <span className="text-base leading-none mb-0.5" aria-hidden="true">
                {tab.icon}
              </span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
      </div>
    </AppContext.Provider>
  );
}
