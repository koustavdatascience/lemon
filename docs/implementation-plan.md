# Implementation Plan — Lemon Chrome Extension

> Build order: vertical slices, smallest working version first, test on real pages before moving on.

---

## Phase 1 — Week 1: The Eyes (Read the Web)

**Goal:** Ship a working Chrome extension that can read and summarise web content.

---

### Slice 1 — Extension Shell

**What to build:**
- `manifest.json` (MV3, declares side panel, background SW, permissions)
- `background/service-worker.js` — bare skeleton, listens for `chrome.runtime.onInstalled`
- `side-panel/index.html` + `main.jsx` — React root mounted in side panel
- `App.jsx` — tab bar with placeholder views (Chat, Summary, Agent, Skills, Settings)
- `options/options.html` + `options.js` — input fields for Gemini API key; save/load via `chrome.storage.local`
- Vite + `vite-plugin-web-extension` build config
- Tailwind CSS setup

**Files created:**
```
manifest.json
vite.config.js
package.json
background/service-worker.js
side-panel/index.html
side-panel/main.jsx
side-panel/App.jsx
side-panel/views/SettingsView.jsx
options/options.html
options/options.js
assets/icons/  (16, 32, 48, 128 px)
assets/styles/panel.css
```

**Acceptance criteria:**
- Extension loads via Load unpacked without errors.
- Side panel opens next to a real page.
- Gemini API key can be entered in Settings/Options and persists after reload.
- Tab bar switches between placeholder views.

---

### Slice 2 — Gemini Text Call + AI Router

**What to build:**
- `background/ai-router.js` — `selectModel()`, `call()`, `handleError()`, fallback chain
- `background/storage-helpers.js` — typed wrappers to read API keys from `chrome.storage.local`
- Long-lived streaming port (`"ai-stream"`) from service worker to side panel
- Message handler: `{ type: "chat", message, history }` → stream tokens back
- `ChatView.jsx` — basic input box + streaming message list
- `components/MessageBubble.jsx`

**Files created / modified:**
```
background/ai-router.js
background/storage-helpers.js
background/service-worker.js   (add message handler)
side-panel/views/ChatView.jsx
side-panel/components/MessageBubble.jsx
```

**Acceptance criteria:**
- User can type a free-form question in Chat and get a streamed response.
- API key from settings is used (no hardcoded key).
- Extension does not crash if the key is missing — shows a clear error.

---

### Slice 3 — Content Extraction + Article Summary

**What to build:**
- `lib/Readability.js` — vendored Mozilla Readability
- `content-scripts/reader.js` — injects Readability, returns `{ title, byline, content, excerpt }`
- Truncation / chunking helper (≤ 12 k tokens)
- Service worker handler: `{ type: "summarise", url, mode: "article" }`
- Summary prompt: TL;DR + 5 key points + What to do next
- `SummaryView.jsx` — Summarise button + rendered output

**Files created / modified:**
```
lib/Readability.js
content-scripts/reader.js
background/service-worker.js   (inject reader, call AI Router)
side-panel/views/SummaryView.jsx
```

**Acceptance criteria:**
- Clicking Summarise on a normal article shows TL;DR, 5 key points, and next-steps.
- Nav, ads, and footer are stripped.
- Works on at least 3 real news or blog articles.

---

### Slice 4 — YouTube Summary

**What to build:**
- Detect if active tab URL is `youtube.com/watch?v=...`
- Service worker handler: `{ type: "summarise", url, mode: "youtube" }`
- Sends the public URL to Gemini URL-input feature
- Prompt requests chapter-style notes with timestamps
- `SummaryView.jsx` — clickable timestamps that call `chrome.tabs.sendMessage` to seek the video

**Files modified:**
```
background/service-worker.js
side-panel/views/SummaryView.jsx
```

**Acceptance criteria:**
- A supported public YouTube link is summarised with chapter notes.
- Timestamps are clickable and seek the video in the active tab.
- Private / unsupported videos show a graceful error.

---

### Slice 5 — Language Toggle (English / Hinglish)

**What to build:**
- `components/LanguageToggle.jsx` — toggle button in Toolbar
- Language stored in `chrome.storage.local` (`settings.language`)
- All AI prompts read the stored language and append language instruction
- Applies to Summary, Chat, and all future AI calls

**Files created / modified:**
```
side-panel/components/LanguageToggle.jsx
side-panel/App.jsx   (expose language state via Context)
background/service-worker.js   (pass language to prompts)
```

**Acceptance criteria:**
- Switching to Hinglish produces a Hinglish response for summary and chat.
- Setting persists across panel close/open.

---

## Phase 2 — Week 2: The Brain (Understand Page and Screen)

**Goal:** Turn Lemon into a context-aware assistant with page chat, context menus, and screenshot Q&A.

---

### Slice 6 — Grounded Page Chat

**What to build:**
- Content extraction runs automatically when ChatView is opened or page changes
- System prompt includes extracted page text as context
- Chat must answer only from page content; admit when answer is absent
- Conversation history kept in React state for the active session
- Streaming into `ChatView.jsx`

**Files modified:**
```
background/service-worker.js   (add page-chat handler with context)
side-panel/views/ChatView.jsx  (history state, context indicator)
```

**Acceptance criteria:**
- Chat answers questions grounded in the current page.
- Answers a question correctly from a real article.
- Responds "I can't find that on this page" for out-of-scope questions.
- Conversation history is visible in the panel.

---

### Slice 7 — Right-Click Context Menu Actions

**What to build:**
- `chrome.contextMenus.create` in service worker for: Explain, Translate, Draft a reply
- Handler sends selected text + action type to AI Router
- Result is sent to side panel via runtime message and displayed in ChatView

**Files modified:**
```
background/service-worker.js   (contextMenus setup + handler)
side-panel/views/ChatView.jsx  (receive context-menu results)
manifest.json                  (add "contextMenus" permission)
```

**Acceptance criteria:**
- Right-clicking selected text shows Lemon submenu.
- Each action produces a relevant result in the side panel.
- Works on article text, emails, and forum posts.

---

### Slice 8 — Screenshot-and-Ask

**What to build:**
- Toolbar button in SummaryView or ChatView triggers `chrome.tabs.captureVisibleTab`
- Captured data URL sent to Gemini Flash (multimodal) with user question
- Result streamed to panel
- Screenshot is never stored or logged

**Files modified:**
```
background/service-worker.js   (captureVisibleTab + multimodal call)
side-panel/views/ChatView.jsx  (screenshot button + question input)
manifest.json                  (confirm "activeTab" + "tabs" permissions)
```

**Acceptance criteria:**
- User can attach a screenshot and ask a question.
- Gemini Flash correctly describes visual content (chart, form, error message).
- Screenshot data is not persisted anywhere.

---

### Slice 9 — Error Handling and Fallback Chain

**What to build:**
- `AIRouter.handleError()` — detects HTTP 429, 500, 503
- Retry with exponential backoff (max 2 retries)
- Fallback chain: `gemini-flash-lite → gemini-flash → groq`
- `background/storage-helpers.js` reads Groq API key
- User-visible error state in side panel (not a raw crash)

**Files modified:**
```
background/ai-router.js        (retry + fallback logic)
background/storage-helpers.js  (groqApiKey)
side-panel/views/SettingsView.jsx  (add Groq API key field)
```

**Acceptance criteria:**
- Simulating a 429 triggers retry then fallback without crashing.
- Side panel shows a friendly error if all providers fail.
- Groq key can be added in settings.

---

## Phase 3 — Week 3: The Hands (Act With User Approval)

**Goal:** Give Lemon safe, approval-gated browser-action capabilities.

---

### Slice 10 — Interactive Element Scanner + Badges

**What to build:**
- `content-scripts/scanner.js`
  - `queryAll()` — finds buttons, links, inputs, textareas, selects, checkboxes, `[role=button/checkbox]`
  - `assignNumbers()` — stable sequential IDs for current DOM snapshot
  - `injectBadges()` — yellow numbered overlays on each element
  - `buildActionMap()` — compact JSON array `[{ id, type, label, placeholder, value, rect }]`
  - `cleanup()` — removes badges

**Files created:**
```
content-scripts/scanner.js
```

**Acceptance criteria:**
- All interactive elements on a practice page get numbered badges.
- Action map JSON is correct and compact (no raw HTML).
- Cleanup removes all badges without leaving stray DOM nodes.

---

### Slice 11 — "Find It for Me" (Structured Element Selection)

**What to build:**
- Service worker handler: `{ type: "find-element", question }` → sends action map + question to AI
- AI response in strict JSON: `{ "elementId": N, "reason": "..." }`
- `lib/schema-validator.js` — lightweight JSON schema check
- Service worker highlights the target element by messaging scanner.js (no click)
- AgentView shows the found element and reason

**Files created / modified:**
```
lib/schema-validator.js
background/service-worker.js
side-panel/views/AgentView.jsx  (initial scaffold)
```

**Acceptance criteria:**
- "Where do I upload my resume?" highlights the correct file-input element.
- Strict JSON validation rejects malformed model output.
- Highlight is visual only — no DOM mutation.

---

### Slice 12 — Agent Loop Core

**What to build:**
- `background/agent-engine.js`
  - `start(task, tabId)`
  - `tick()` — getPageState → buildPrompt → askAI → validateAction → emitForApproval → waitForDecision
  - `approve(actionId)` — calls actor, then tick()
  - `skip(actionId)` — logs skip, calls tick()
  - `stop()` — clears state, sends cleanup message
  - `persist() / restore()` — snapshot to `chrome.storage.local`
- `content-scripts/actor.js`
  - `click(id)`, `type(id, value)`, `select(id, value)`, `scroll(direction)`, handles `done`
- `components/ActionCard.jsx` — shows proposed action + reason + Approve / Skip / Stop buttons
- `components/ActionLog.jsx` — running log of steps and decisions

**Files created / modified:**
```
background/agent-engine.js
content-scripts/actor.js
side-panel/views/AgentView.jsx   (task input, ActionCard, ActionLog)
side-panel/components/ActionCard.jsx
side-panel/components/ActionLog.jsx
background/service-worker.js    (agent-start, agent-decision handlers)
```

**Acceptance criteria:**
- Agent reads page state, proposes one action in strict JSON, and waits for approval.
- Approve executes the action and moves to the next step.
- Skip logs the skip and proposes the next action.
- Stop clears all state and removes badges.
- No DOM action executes without user approval.

---

### Slice 13 — Agent Controls (Persistence, Dry-Run, Step Limit, Logs)

**What to build:**
- Persist `agentState` to `chrome.storage.local` after every state transition
- Restore pending state on service-worker wake (`chrome.runtime.onStartup`)
- Dry-run mode: highlight target element, skip `actor.js` call
- Configurable max-step limit (default 20); auto-stop on reaching limit
- Full action log: step number, proposed action, reason, user decision, timestamp

**Files modified:**
```
background/agent-engine.js
side-panel/views/AgentView.jsx   (dry-run toggle, step counter, log view)
```

**Acceptance criteria:**
- Agent state survives service-worker suspension (close and reopen Chrome, state resumes).
- Dry-run highlights element without acting.
- Agent auto-stops at 20 steps with a clear message.
- Log shows all steps with decisions.

---

## Phase 4 — Week 4: Memory, Safety, and Shipping

**Goal:** Make Lemon personal, safe, and installable by others.

---

### Slice 14 — Local Profile Memory

**What to build:**
- `SettingsView.jsx` — profile section: name, college, skills[], links[], custom fields
- Stored in `chrome.storage.local` under `profile`
- Service worker reads profile and injects relevant fields into agent prompts and draft prompts
- Auto-fill integration: when agent encounters a known field (name, email), profile value is suggested as the action value

**Files modified:**
```
side-panel/views/SettingsView.jsx
background/service-worker.js   (profile injection into prompts)
background/storage-helpers.js  (profile read/write helpers)
```

**Acceptance criteria:**
- Profile fields save and reload after panel close.
- Agent uses profile name when filling a "First name" input.
- Draft-a-reply uses preferred tone from profile.

---

### Slice 15 — One-Click Skills (Save, Run, Import, Export)

**What to build:**
- `SkillsView.jsx` — list of saved skills, Run / Edit / Delete buttons
- `components/SkillChip.jsx` — quick-access chips in toolbar or chat
- Create/edit modal: skill name + prompt template
- Run skill: sends skill prompt + current page context to AI Router
- Export: `JSON.stringify(skills[])` → file download
- Import: file picker → parse + merge into storage

**Files created / modified:**
```
side-panel/views/SkillsView.jsx
side-panel/components/SkillChip.jsx
background/storage-helpers.js  (skills CRUD)
```

**Acceptance criteria:**
- User can create, edit, delete, and run a skill.
- "Exam notes" skill runs on an article and returns structured notes.
- Skills export to a `.json` file and re-import correctly.

---

### Slice 16 — Safety Rails

**What to build:**
- `background/safety-guard.js`
  - `checkPage(url)` — block banking/payment/UPI domains by regex list
  - `checkField(element)` — block password, OTP, card-number inputs
  - `checkAction(action)` — extra modal confirm for Submit/Pay/Send/Delete
  - `checkPrivacy(url)` — prevent sending webmail/medical/gov pages to external API
- Wire SafetyGuard into every path: summarise, chat, agent tick, actor
- Privacy filter blocks content extraction and sends error message to panel
- Kill switch: Stop button always visible; clears state and badges immediately

**Files created / modified:**
```
background/safety-guard.js
background/service-worker.js   (call SafetyGuard before every AI call and action)
background/agent-engine.js     (call SafetyGuard in tick() and approve())
side-panel/views/AgentView.jsx (always-visible Stop button)
```

**Acceptance criteria:**
- Opening side panel on a bank/payment URL shows a blocked message; no AI call is made.
- Agent refuses to type into a password or OTP field.
- Submit/Pay/Send buttons require a second confirmation modal.
- Webmail/medical pages cannot be summarised or sent to AI.
- API keys never appear in any log, message, or exported file.
- Stop button works at any point in the agent loop.

---

### Slice 17 — Public Packaging and Release

**What to build:**
- `README.md` — project description, screenshots, setup instructions, usage guide
- `.gitignore` — excludes `.env`, `node_modules`, `dist/`
- `.env.example` — placeholder key names, no real values
- GitHub Actions workflow (optional): `npm run build` → upload `dist/` as release ZIP
- `docs/` screenshots of each major feature
- GitHub Pages `index.html` — one-page landing site

**Files created:**
```
README.md
.gitignore
.env.example
docs/screenshots/
gh-pages/index.html   (or docs/index.html if using docs/ for Pages)
.github/workflows/release.yml   (optional CI)
```

**Acceptance criteria:**
- A fresh user can clone the repo, run `npm install && npm run build`, and load the `dist/` folder in Chrome.
- No API key is committed to the repo.
- README covers install, setup, and all key features with screenshots.
- A GitHub Release ZIP exists and installs cleanly via Load unpacked.
- Landing page is live on GitHub Pages.

---

## Cross-Cutting Concerns (apply throughout all phases)

| Concern | Approach |
|---|---|
| MV3 service worker sleep | Persist all async state to `chrome.storage.local` before yielding |
| Token limits | Truncate extracted text to ≤ 12 k tokens before any AI call |
| Strict JSON for agent actions | Always validate with `schema-validator.js`; retry max 2× on bad output |
| Streaming | Long-lived port `"ai-stream"` between SW and side panel; reconnect on visibility change |
| Content Security Policy | All code bundled locally; no remote scripts; API calls from SW only |
| Prompt injection | Never send raw HTML to AI; always use compact action map from `scanner.js` |
| API key safety | `chrome.storage.local` only; never in logs, exports, or source control |
| Cost | Default to `gemini-flash-lite`; escalate only when required |
| Accessibility | Side panel UI uses semantic HTML, keyboard navigation, ARIA labels |

---

## Dependency Map

```
Slice 1  (shell)
  └── Slice 2  (AI router + chat)
        ├── Slice 3  (article summary)
        │     └── Slice 4  (YouTube summary)
        │           └── Slice 5  (language toggle)
        ├── Slice 6  (page chat)           ← needs Slice 3
        ├── Slice 7  (context menus)       ← needs Slice 2
        ├── Slice 8  (screenshot-ask)      ← needs Slice 2
        └── Slice 9  (error handling)      ← wraps Slice 2

Slice 10 (scanner)
  └── Slice 11 (find-it)                  ← needs Slice 10 + Slice 2
        └── Slice 12 (agent loop)         ← needs Slice 11 + Slice 9
              └── Slice 13 (persistence + controls)

Slice 14 (profile)                        ← needs Slice 1
Slice 15 (skills)                         ← needs Slice 14
Slice 16 (safety)                         ← wraps Slices 3,6,8,12
Slice 17 (packaging)                      ← all slices done
```

---

## Week-by-Week Delivery Summary

| Week | Slices | Milestone |
|---|---|---|
| 1 | 1 → 5 | Installable extension that reads, summarises, and toggles language |
| 2 | 6 → 9 | Context-aware page chat, right-click actions, screenshot Q&A, resilient fallback |
| 3 | 10 → 13 | Approval-gated agent loop with scanner, actor, persistence, dry-run |
| 4 | 14 → 17 | Profile memory, skills, full safety rails, public release |
