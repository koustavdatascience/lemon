# 🍋 Lemon

A user-controlled browser AI agent that reads, understands, and acts on web pages — with your explicit approval on every step.

Lemon lives in Chrome's side panel. It can summarise articles and YouTube videos, answer questions grounded in the current page, find and fill form fields, and run multi-step browser tasks. Critically, **nothing changes on the page without your OK** — every action is proposed one at a time, and you Approve, Skip, or Stop before anything executes.

## Features

| Feature | What it does |
|---|---|
| **Summarise** | TL;DR + 5 key points + next steps for any article or YouTube video |
| **Page Chat** | Ask questions answered only from the current page content — no hallucination |
| **Context Menu** | Right-click selected text to Explain, Translate, or Draft a Reply |
| **Screenshot & Ask** | Capture the visible tab and ask Gemini Flash about what's on screen |
| **Find It for Me** | Describe an element in plain English — Lemon highlights it on the page |
| **Agent Loop** | Give a task ("Fill in my name and email and submit"). Lemon proposes one action at a time. You approve each before it runs. |
| **Dry-Run Mode** | Propose actions and highlight targets without touching the DOM |
| **Profile Memory** | Save your name, email, college, links, etc. The agent auto-suggests them when filling forms |
| **One-Click Skills** | Save reusable prompt recipes ("Exam notes", "Extract all links"). Run with one click. Export/import as JSON. |
| **Safety Rails** | Lemon refuses to act on banking/payment pages, never types into password/OTP/card fields, and requires extra confirmation for Submit/Pay/Send actions |
| **Language Toggle** | English or Hinglish output across all features |

## Quick Start

### Prerequisites

- **Google Chrome** (the Side Panel API is Chrome-specific)
- **Node.js 18+** and npm

### Install & Build

```bash
git clone <your-repo-url> lemon
cd lemon
npm install
npm run build
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `dist/` folder
5. Open any web page and click the Lemon icon in the toolbar to open the side panel

### Set Your API Key

1. Open the side panel and switch to the **Settings** tab
2. Enter your **Gemini API Key** (free at [aistudio.google.com](https://aistudio.google.com))
3. Optionally add a **Groq API key** ([console.groq.com](https://console.groq.com)) as a fallback when Gemini rate limits hit
4. Click **Save**

Keys are stored only in `chrome.storage.local` on your device. They are never synced, logged, or sent anywhere except the respective AI provider.

## Usage Guide

### Summarise an Article
Open any news article or blog post. Go to the **Summary** tab. Click **Summarise**. Switch the language toggle to Hinglish if you prefer Hindi-English mixed output.

### Summarise a YouTube Video
Open a `youtube.com/watch?v=...` page. Click **Summarise** in the Summary tab. You'll get chapter-style notes with clickable timestamps that seek the video.

### Chat With the Page
Go to the **Chat** tab. Ask any question about the current page. Lemon answers only from what's on the page — and will tell you "I can't find that on this page" when the answer isn't there.

### Screenshot & Ask
Click the camera icon in the Chat tab to capture the visible tab. Type a question about what's on screen and Gemini Flash (multimodal) will analyse it.

### Find an Element
Go to the **Agent** tab → **Find** sub-tab. Type "Where do I upload my resume?" and click Find. Lemon scans the page, numbers every interactive element, and highlights the best match with a yellow badge.

### Run an Agent Task
Switch to the **Agent** sub-tab. Type a task like "Fill in my name and email and click Submit." Click Go. Lemon proposes each step as an action card:
- **Approve** — executes the action and moves to the next step
- **Skip** — logs the skip and proposes the next action
- **Stop** — clears all state and removes page badges

Toggle **Dry-run** to see what Lemon would do without executing anything. Adjust the **step limit** (default 20, max 50) to cap how far the agent will go.

### Fill Your Profile
Go to **Settings** → **Profile** section. Enter your name, email, college, skills, links, and preferred writing tone. When the agent encounters a matching form field, it suggests your profile value automatically.

### Create a Skill
Go to the **Skills** tab. Click **New skill**. Give it a name and a prompt, e.g.:
- **Exam notes**: "Summarise this page as structured exam notes with headings, key terms, and 5 practice questions."
- **Extract links**: "Extract all links and their descriptions from the page."

Click **Run** on any page to apply the skill. Export all skills to a `.json` file and import them on another machine.

### Right-Click Context Menu
Select any text on a page. Right-click → **🍋 Lemon** → **Explain** / **Translate** / **Draft a reply**. The result appears in the Chat tab.

## Architecture

```
Chrome Browser
├── Active Tab (content scripts: reader, scanner, actor)
├── Side Panel (React UI: Chat, Summary, Agent, Skills, Settings)
└── Background Service Worker (AI router, agent engine, safety guard)
    └── chrome.storage.local (API keys, profile, skills, agent state)
```

Lemon is a Manifest V3 extension. All AI calls happen in the background service worker. Content scripts are injected on-demand. Page content is never sent raw to the AI — the scanner builds a compact JSON action map (no HTML) to keep tokens low and prevent prompt injection.

| Component | Role |
|---|---|
| `background/ai-router.js` | Gemini (primary) + Groq (fallback), streaming, retry/backoff |
| `background/agent-engine.js` | Approval-gated agent loop with persistence and dry-run |
| `background/safety-guard.js` | Deterministic safety checks (no AI override) |
| `content-scripts/scanner.js` | Detects interactive elements, injects numbered badges |
| `content-scripts/actor.js` | Executes approved DOM actions (click, type, select, scroll) |
| `content-scripts/reader.js` | Mozilla Readability.js wrapper for article extraction |
| `lib/schema-validator.js` | Lightweight JSON schema validation for agent actions |

## Tech Stack

- **Manifest V3** with side panel API
- **React 18** + Vite for the side panel UI
- **Tailwind CSS** for styling
- **vite-plugin-web-extension** for build orchestration
- **Gemini Flash-Lite / Flash** (primary AI) + **Groq Llama 3.3 70B** (fallback)

## Privacy

- All data stays on your device in `chrome.storage.local` — never synced to the cloud
- API keys are never logged, exported, or sent anywhere except the AI provider
- Page content is never sent to the AI on webmail, medical, or government portal pages
- The agent never acts on banking, payment, or crypto pages
- Screenshot data is never stored — it exists only in memory during the request

## Development

```bash
# Watch mode (rebuilds on file change)
npm run dev

# Production build
npm run build

# Load dist/ in Chrome via Load unpacked
npm run preview
```

## License

MIT
