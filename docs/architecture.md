# Architecture — Lemon Chrome Extension

## 1. High-Level Overview

Lemon is a Chrome Manifest V3 extension that runs as a side-panel AI agent. It reads the active tab's content, reasons about it using Gemini (with Groq as fallback), and can perform browser actions only after explicit user approval. All personal data stays on the user's device.

### System Diagram

```
                       ┌────────────┐
                       │    User    │
                       └─────┬──────┘
                             │
┌────────────────────────────▼────────────────────────────────┐
│  Chrome Browser                                             │
│                                                             │
│  ┌─────────────────┐   ┌───────────────────────────────┐    │
│  │   Active Tab    │   │    Side Panel (React UI)      │    │
│  │                 │◄─►│  ┌───────────┐ ┌───────────┐  │    │
│  │ Content Script  │   │  │ Chat View │ │Agent View │  │    │
│  │ (scanner +      │   │  └───────────┘ └───────────┘  │    │
│  │  badges +       │   │  ┌───────────┐ ┌───────────┐  │    │
│  │  DOM actions)   │   │  │  Summary  │ │  Skills   │  │    │
│  └───────┬─────────┘   │  └───────────┘ └───────────┘  │    │
│          │             └─────────────┬─────────────────┘    │
│          │  chrome.runtime           │                      │
│          └───────────────────────────┘                      │
│                        │                                    │
│                        ▼                                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │           Background Service Worker                  │   │
│  │  ┌───────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │ AI Router │  │ Agent Engine │  │ Safety Guard │   │   │
│  │  └───────────┘  └──────────────┘  └──────────────┘   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │             chrome.storage.local                     │   │
│  │  API keys · Profile · Skills · Agent state · Log     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                       │  HTTPS only
          ┌────────────┴─────────────┐
          ▼                          ▼
┌──────────────────────┐   ┌──────────────────────┐
│     Gemini API       │   │      Groq API        │
│     (primary)        │   │     (fallback)       │
└──────────────────────┘   └──────────────────────┘
```

---

## 2. Extension Component Map

### 2.1 Manifest V3 Entry Points

| Entry point | Role |
|---|---|
| `background/service-worker.js` | Orchestrates all async work, holds AI router, agent engine, safety guard |
| `side-panel/index.html` | Side panel shell loaded by Chrome Side Panel API |
| `content-scripts/reader.js` | Extracts readable text via Readability.js |
| `content-scripts/scanner.js` | Scans interactive elements, injects numbered badges |
| `content-scripts/actor.js` | Executes approved DOM actions (click, type, select, scroll) |
| `options/options.html` | Settings page for API keys and user profile |

### 2.2 Side Panel (React)

The entire UI lives inside the side panel. Views are tab-switched, never separate windows.

```
SidePanel
├── Toolbar           (tab switcher: Chat | Summary | Agent | Skills | Settings)
├── ChatView          (grounded Q&A, streaming, history)
├── SummaryView       (article summary + YouTube summary + language toggle)
├── AgentView         (task input, action card, Approve/Skip/Stop, log)
├── SkillsView        (saved skills list, run / edit / import / export)
└── SettingsView      (API keys, user profile, language, tone preferences)
```

State management: React Context + `chrome.storage.local` as the persistent store. No external state library needed at this scale.

### 2.3 Background Service Worker

Responsibilities:
- Route messages between content scripts and the side panel.
- Call AI APIs (Gemini / Groq) and stream tokens back.
- Run the agent loop (one-step-at-a-time with persistence).
- Apply safety rules before every action.
- Persist agent state so it survives service-worker sleep.

---

## 3. Module Architecture

### 3.1 AI Router

Decides which model to call based on task type, current error state, and configured keys.

```
AIRouter
  ├── selectModel(task)         → "gemini-flash-lite" | "gemini-flash" | "groq"
  ├── call(model, prompt)       → streams tokens; wraps fetch
  ├── handleError(response)     → detects 429/5xx, triggers retry or fallback
  └── fallbackChain             → [gemini-flash-lite → gemini-flash → groq]
```

Model selection rules:

| Task | Default model | Escalate to | Fallback |
|---|---|---|---|
| Chat / summarise (text) | `gemini-flash-lite` | `gemini-flash` | Groq |
| YouTube summarise | `gemini-flash-lite` (URL input) | `gemini-flash` | — |
| Screenshot-and-ask | `gemini-flash` (multimodal) | — | — |
| Agent action JSON | `gemini-flash-lite` | `gemini-flash` | — |

### 3.2 Content Extraction Pipeline

```
Tab URL / selected text
        │
        ▼
  reader.js (content script)
        │   Mozilla Readability.js
        │   strips nav / ads / footer
        ▼
  { title, byline, content, excerpt }
        │
        ▼
  Truncation / chunking (max ~12 k tokens for context window)
        │
        ▼
  AI Router → Gemini
```

YouTube summarisation sends the public URL directly to Gemini's URL-input feature rather than scraping the page HTML.

### 3.3 Interactive Element Scanner

Runs inside `scanner.js` as a content script injected on-demand.

```
scanner.js
  ├── queryAll()         → finds buttons, a[href], input, textarea,
  │                         select, [role=button/checkbox/...], label
  ├── assignNumbers()    → stable sequential IDs for current DOM snapshot
  ├── injectBadges()     → overlays numbered yellow labels on each element
  ├── buildActionMap()   → [ { id, type, label, placeholder, value, rect } ]
  └── cleanup()          → removes badges when agent stops
```

The action map is a compact JSON array (not raw HTML) sent to the AI. This keeps tokens low and prevents prompt injection from hidden page content.

### 3.4 Agent Engine

Single-responsibility: runs the approval loop, persists state.

```
AgentEngine
  ├── start(task, tabId)
  ├── tick()                  → one loop iteration
  │     ├── getPageState()    → calls scanner.js
  │     ├── buildPrompt()     → task + history + actionMap
  │     ├── askAI()           → expects strict JSON
  │     ├── validateAction()  → JSON schema + safety check
  │     ├── emitForApproval() → sends proposed action to UI
  │     └── waitForDecision() → pauses; persists state to storage
  ├── approve(actionId)       → resumes, calls actor.js
  ├── skip(actionId)          → logs skip, calls tick() again
  ├── stop()                  → clears state, removes badges
  └── persist() / restore()   → chrome.storage.local snapshot
```

Agent state persisted to storage:

```json
{
  "task": "...",
  "tabId": 123,
  "step": 4,
  "history": [...],
  "status": "waiting_approval",
  "pendingAction": { "type": "click", "elementId": 3, "reason": "..." },
  "log": [...]
}
```

### 3.5 Safety Guard

Called synchronously before every action execution. Returns `{ allowed: boolean, reason: string }`.

```
SafetyGuard
  ├── checkPage(url)
  │     blocked domains: banking, payment, UPI patterns
  │     blocked URL patterns: *.bank.*, pay.*, upi.*, etc.
  ├── checkField(element)
  │     blocked input types: password, OTP heuristic, card-number heuristic
  ├── checkAction(action)
  │     extra confirm: submit, pay, send button text patterns
  └── checkPrivacy(url)
        sensitive: webmail, medical, gov, tax
        → prevents page content being sent to external API
```

Safety rules are enforced deterministically in code — the AI model cannot override them.

### 3.6 Local Memory

Stored exclusively in `chrome.storage.local`. Never synced, never sent to any server except as explicit user instruction input to an approved action.

```
storage schema
├── settings
│     ├── geminiApiKey
│     ├── groqApiKey
│     ├── language        ("en" | "hi-en")
│     └── tone            ("formal" | "casual")
├── profile
│     ├── name, college, skills[], links[]
│     └── custom fields[]
├── skills[]
│     └── { id, name, prompt, createdAt }
└── agentState             (live agent snapshot, wiped on stop)
```

---

## 4. Messaging Architecture

Chrome MV3 does not allow shared memory between contexts. All communication is message-passing.

```
Content Script  ──runtime.sendMessage──►  Service Worker
Side Panel      ──runtime.sendMessage──►  Service Worker
Service Worker  ──tabs.sendMessage──────►  Content Script
Service Worker  ──runtime.sendMessage──►  Side Panel (via port)
```

Long-lived connection (Port) used for streaming AI tokens from service worker to side panel:

```
SidePanel connects port "ai-stream"
ServiceWorker port.postMessage({ type: "token", text: "..." })
ServiceWorker port.postMessage({ type: "done" })
```

Message type catalogue (abbreviated):

| Direction | Type | Payload |
|---|---|---|
| Panel → SW | `summarise` | `{ url, mode }` |
| Panel → SW | `chat` | `{ message, history }` |
| Panel → SW | `screenshot-ask` | `{ dataUrl, question }` |
| Panel → SW | `agent-start` | `{ task }` |
| Panel → SW | `agent-decision` | `{ decision: "approve"|"skip"|"stop" }` |
| SW → Panel | `token` | `{ text }` (streaming) |
| SW → Panel | `action-proposal` | `{ action, reason, step }` |
| SW → Panel | `agent-log-update` | `{ log[] }` |
| SW → CS | `scan-page` | — |
| SW → CS | `execute-action` | `{ action }` |
| CS → SW | `page-state` | `{ actionMap[], text }` |

---

## 5. Data Flow Diagrams

### 5.1 Article Summarisation

```
User opens side panel → clicks Summarise
        │
        ▼
Panel sends { type: "summarise", url } to SW
        │
        ▼
SW injects reader.js into active tab
        │
        ▼
reader.js runs Readability → returns { title, content }
        │
        ▼
SW checks SafetyGuard.checkPrivacy(url)
        │
        ├─ blocked → streams error message to panel
        │
        └─ allowed →
              AIRouter.call("gemini-flash-lite", summaryPrompt)
                      │  streaming
                      ▼
              Tokens streamed via port to SummaryView
```

### 5.2 Agent Loop (one step)

```
User types task → clicks Go
        │
        ▼
AgentEngine.start(task, tabId)
        │
        ▼
scanner.js → actionMap[]
        │
        ▼
AIRouter → JSON response
  { type: "click", elementId: 5, reason: "Submit the form" }
        │
        ▼
SafetyGuard.checkAction(action)
        │
        ├─ blocked → send safety-block event to panel, stop
        │
        └─ allowed →
              emit action-proposal to panel
                      │
                      ▼
              User sees card: Approve / Skip / Stop
                      │
               ┌──────┼──────┐
           Approve   Skip   Stop
               │       │       │
               ▼       ▼       ▼
          actor.js   tick()  cleanup
          executes
               │
               ▼
          SW calls tick() for next step
```

---

## 6. Key Technical Decisions

### 6.1 Manifest V3 Service Worker Constraints

Service workers can be killed by Chrome at any time. To survive this:
- Agent state is always written to `chrome.storage.local` after every state transition.
- On `chrome.runtime.onStartup` and `chrome.runtime.onInstalled`, the service worker checks for a pending `agentState` and re-registers its listeners.
- The side panel reconnects its streaming port on visibility change.

### 6.2 Strict JSON for Agent Actions

The AI is always given a JSON schema in the system prompt:

```json
{
  "type": "click|type|select|scroll|done",
  "elementId": 5,
  "value": "optional string",
  "reason": "one sentence"
}
```

The service worker validates the response with a JSON schema parser before using it. If validation fails, the engine requests a retry (max 2 retries) or stops with an error.

### 6.3 Action Map Instead of Raw DOM

Sending raw page HTML to the AI would:
- Consume too many tokens.
- Expose private page content to an external model.
- Risk prompt injection from malicious page content.

Instead, `scanner.js` builds a minimal action map like:

```json
[
  { "id": 1, "type": "input", "label": "First name", "placeholder": "Enter first name" },
  { "id": 2, "type": "button", "label": "Submit" },
  { "id": 3, "type": "select", "label": "Country", "options": ["India", "USA"] }
]
```

This is compact, deterministic, and strips all raw HTML.

### 6.4 Content Security Policy

MV3 restricts inline scripts and remote code execution. All code is bundled locally. The Gemini/Groq API calls are made from the service worker (not content scripts) to keep network access minimal and auditable.

### 6.5 API Key Storage

- Keys are stored in `chrome.storage.local` (not `sync`), so they never leave the device.
- The options page reads/writes them directly via `chrome.storage.local.get/set`.
- Keys are never included in any log, message payload, or exported file.
- A `.env` file can be used during local development (gitignored). Production keys come from the settings page only.

### 6.6 Screenshot Capture

`chrome.tabs.captureVisibleTab` requires the `"activeTab"` and `"tabs"` permissions. The captured data URL is:
- Sent directly to Gemini Flash (multimodal) from the service worker.
- Never stored to disk.
- Never logged.

---

## 7. Folder Structure

```
lemon-extension/
├── manifest.json
├── background/
│   ├── service-worker.js          # entry, message router
│   ├── ai-router.js               # model selection + fetch wrappers
│   ├── agent-engine.js            # approval loop
│   ├── safety-guard.js            # deterministic safety checks
│   └── storage-helpers.js         # typed wrappers around chrome.storage
├── content-scripts/
│   ├── reader.js                  # Readability.js wrapper
│   ├── scanner.js                 # element detection + badge injection
│   └── actor.js                   # DOM action executor
├── side-panel/
│   ├── index.html
│   ├── main.jsx                   # React root
│   ├── App.jsx                    # tab router
│   ├── views/
│   │   ├── ChatView.jsx
│   │   ├── SummaryView.jsx
│   │   ├── AgentView.jsx
│   │   ├── SkillsView.jsx
│   │   └── SettingsView.jsx
│   └── components/
│       ├── ActionCard.jsx         # Approve/Skip/Stop UI
│       ├── ActionLog.jsx
│       ├── LanguageToggle.jsx
│       ├── MessageBubble.jsx
│       └── SkillChip.jsx
├── options/
│   ├── options.html
│   └── options.js
├── lib/
│   ├── Readability.js             # vendored Mozilla Readability
│   └── schema-validator.js        # lightweight JSON schema check
├── assets/
│   ├── icons/                     # 16, 32, 48, 128 px PNG icons
│   └── styles/
│       └── panel.css
└── docs/
    ├── problemstatement.md
    ├── architecture.md            # this file
    ├── implementation-plan.md
    └── edge-cases.md
```

---

## 8. Permissions Audit

| Permission | Reason |
|---|---|
| `sidePanel` | Open the side panel |
| `activeTab` | Read current tab URL and capture screenshot |
| `tabs` | `captureVisibleTab` for screenshot |
| `scripting` | Inject content scripts on demand |
| `storage` | `chrome.storage.local` for all local state |
| `contextMenus` | Right-click Explain / Translate / Draft actions |
| `host_permissions: <all_urls>` | Content script must run on any page the user is viewing (reader, scanner, actor) |

No remote-code-execution permissions. No `webNavigation` (not needed). No `cookies`. No `history`.

---

## 9. Safety Architecture Summary

Safety is enforced in layers, not just by the AI model:

| Layer | Mechanism |
|---|---|
| **Page block** | `SafetyGuard.checkPage(url)` — regex list of banking/payment/UPI domains |
| **Field block** | `SafetyGuard.checkField(el)` — input type === password; OTP/card heuristics |
| **Action confirm** | Extra user confirmation modal for Submit, Pay, Send, Delete buttons |
| **Privacy filter** | `SafetyGuard.checkPrivacy(url)` — prevents sending sensitive-page content to API |
| **API key isolation** | Keys in `chrome.storage.local`, never in exported files or logs |
| **Kill switch** | Stop button always visible during agent loop; removes badges, clears state |
| **JSON validation** | Schema check before any action executes; malformed response → retry or stop |
| **Step limit** | Configurable max steps (default 20); auto-stops runaway loops |
| **Dry-run mode** | Highlights target element, no DOM mutation |

---

## 10. Technology Stack Summary

| Layer | Choice | Reason |
|---|---|---|
| Extension platform | Chrome MV3 | Required by platform |
| UI framework | React (bundled via Vite) | Component model fits multi-view panel |
| Bundler | Vite + `vite-plugin-web-extension` | MV3-aware build, fast HMR |
| Primary AI | Gemini Flash-Lite | Free tier, fast, low cost |
| Vision AI | Gemini Flash | Multimodal support |
| Text fallback | Groq free tier | Rate-limit resilience |
| Content extraction | Mozilla Readability.js | Battle-tested article parser |
| Local storage | `chrome.storage.local` | On-device, no server needed |
| JSON validation | Custom lightweight validator | Zero dependency, runs in SW |
| Styling | Tailwind CSS (scoped) | Utility-first, easy to keep compact |

---

## 11. Week-by-Week Architecture Milestones

| Week | What gets built | Key architectural piece |
|---|---|---|
| 1 | Extension shell, API key settings, reader, summariser, YouTube, language toggle | Manifest, service worker skeleton, AI Router (text), Content Extraction Pipeline |
| 2 | Page chat, context menus, screenshot-ask, error/fallback handling | Streaming port, multimodal call, fallback chain in AI Router |
| 3 | Element scanner, badges, agent loop, approval UI, action log, persistence | Scanner, Actor, Agent Engine, Safety Guard (action/field layer) |
| 4 | Profile memory, skills, safety rails, packaging | Full Safety Guard, Local Memory schema, GitHub Release workflow |
