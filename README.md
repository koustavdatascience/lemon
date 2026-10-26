# 🍋 Lemon

A user-controlled browser AI agent that reads, understands, and acts on web pages — with your approval on every step.

> Built by [koustavdatascience](https://github.com/koustavdatascience)

## What it does

| Feature | Description |
|---|---|
| **Summarise** | TL;DR + key points for articles and YouTube videos |
| **Page Chat** | Answers grounded in the current page — no hallucination |
| **Context Menu** | Right-click to Explain, Translate, or Draft a Reply |
| **Screenshot & Ask** | Capture the tab and ask Gemini Flash about it |
| **Find It for Me** | Describe an element — Lemon highlights it on the page |
| **Agent Loop** | Multi-step tasks with Approve / Skip / Stop on every action |
| **Profile Memory** | Saves your details and auto-suggests them on forms |
| **Skills** | Reusable one-click prompt recipes, export/import as JSON |
| **Safety Rails** | Blocks banking pages, password/OTP fields, and flags Submit/Pay actions |
| **Language Toggle** | English or Hinglish output |

## Quick Start

**Requirements:** Google Chrome, Node.js 18+

```bash
git clone https://github.com/koustavdatascience/lemon.git
cd lemon
npm install && npm run build
```

1. Go to `chrome://extensions/` → enable **Developer mode**
2. Click **Load unpacked** → select the `dist/` folder
3. Open the side panel → **Settings** → add your free [Gemini API key](https://aistudio.google.com)

## Development

```bash
npm run dev    # watch mode
npm run build  # production build
```

## Tech Stack

- Chrome Manifest V3 + Side Panel API
- React 18 + Vite + Tailwind CSS
- Gemini Flash-Lite / Flash (primary) · Groq Llama 3.3 70B (fallback)

## Privacy

All data stays on your device in `chrome.storage.local`. API keys are never logged or synced. The agent never acts on banking or payment pages, and never fills password, OTP, or card fields.

## License

MIT
