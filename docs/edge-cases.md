# Edge Cases — Lemon Chrome Extension

> This document catalogs corner scenarios for every implementation slice. Each entry names the scenario, the likely failure mode, and how to handle it.

---

## Phase 1 — The Eyes

---

### Slice 1 — Extension Shell

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 1.1 | Side panel opened before any page is loaded (new tab / `chrome://newtab`) | Content script injection fails; reader returns nothing | Detect `chrome://` and `about:` URLs; show "Open a web page first" placeholder in the panel |
| 1.2 | User has two Chrome profiles; installs extension in both | `chrome.storage.local` is profile-scoped — no conflict, but settings are not shared | Document this as expected behaviour in README |
| 1.3 | Vite build outputs files to an unexpected path | `manifest.json` `web_accessible_resources` mismatch → extension fails to load | Pin output dir in `vite.config.js`; add a post-build path check |
| 1.4 | User opens Options page while side panel is also open | Both pages write to `chrome.storage.local` concurrently | Use `chrome.storage.local.set` atomic writes; side panel listens to `chrome.storage.onChanged` to sync live |
| 1.5 | API key is pasted with leading/trailing whitespace | Gemini API returns 401 | Trim key before saving and before every API call |
| 1.6 | User clears extension storage manually (Dev Tools → Application → Clear) | Panel loads with empty settings; API calls fail | Always check for missing key at startup; show onboarding prompt if key is absent |

---

### Slice 2 — Gemini Text Call + AI Router

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 2.1 | Service worker is killed mid-stream | Port disconnects; partial response displayed | Catch `chrome.runtime.Port.onDisconnect`; show "Response interrupted — try again" in panel |
| 2.2 | Side panel is closed while a stream is in progress | Port write throws; uncaught error crashes SW | Wrap all `port.postMessage` calls in a try/catch; silently discard if port is gone |
| 2.3 | Gemini returns a 200 with an empty `candidates` array | No text to render; spinner hangs | Detect empty candidates; show "No response from model — try rephrasing" |
| 2.4 | User sends a second message before the first stream finishes | Two concurrent streams write to the same port | Queue or cancel the previous request before starting a new one |
| 2.5 | API key is valid but for a different Google Cloud project with no Gemini quota | Returns 403 Forbidden | Distinguish 401 (bad key) from 403 (no quota) in error messages |
| 2.6 | Network is offline when Chat is submitted | `fetch` rejects with `TypeError: Failed to fetch` | Catch network errors separately; show "No internet connection" rather than a generic error |

---

### Slice 3 — Content Extraction + Article Summary

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 3.1 | Page is a Single-Page App that renders content after load | Readability runs before DOM is populated; returns empty content | Retry extraction after a short delay (500 ms); show "Page may still be loading" if still empty |
| 3.2 | Page requires login (paywall / auth redirect) | Extracted content is the login screen, not the article | Detect very short extracted text (< 200 chars); warn "This page may require a login" |
| 3.3 | Article is extremely long (> 50 000 words) | Context window exceeded; Gemini refuses or truncates badly | Hard-truncate to ≤ 12 k tokens with a visible "summarising first section only" notice |
| 3.4 | Page has no extractable article content (dashboard, gallery, map) | Readability returns null or near-empty | Detect null result; show "No readable article found on this page" instead of sending empty prompt |
| 3.5 | Content script injection fails (CSP on the host page blocks scripts) | `chrome.scripting.executeScript` throws | Catch the error; show "Lemon can't read this page due to its security policy" |
| 3.6 | Extracted text contains `<script>` or template literals left by Readability | Injected as part of prompt; potential prompt confusion | Strip remaining HTML tags from extracted text before including in prompt |
| 3.7 | User navigates to a new page while summary is loading | Summary renders for the wrong page | Tag each request with a `tabId` + `url` snapshot; discard response if active URL has changed |

---

### Slice 4 — YouTube Summary

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 4.1 | YouTube video is private, age-restricted, or deleted | Gemini URL-input returns an error or empty response | Parse error response; show "This video is private, restricted, or unavailable" |
| 4.2 | URL is a YouTube Shorts link (`/shorts/`) | Gemini may not support the Shorts format | Detect `/shorts/` URL; show "YouTube Shorts are not supported" |
| 4.3 | URL is a YouTube playlist, not a single video | No single video to summarise | Detect absence of `v=` param; show "Please open a single video page" |
| 4.4 | Video has no spoken dialogue (music, ambient video) | Transcript is empty; summary is meaningless | Detect suspiciously short summary; show "This video may not have spoken content" |
| 4.5 | Timestamp seek fails because the YouTube tab was navigated away | `chrome.tabs.sendMessage` returns error | Catch messaging error; show "Could not seek — the video tab may have changed" |
| 4.6 | Video is very long (3+ hours) | Gemini may hit token limits on the transcript | Detect length from duration metadata if available; warn "Long video — summary may be partial" |

---

### Slice 5 — Language Toggle

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 5.1 | Language setting is changed mid-stream | First half of response is English, second half is Hinglish | Always resolve language before starting the prompt; never change language on an in-flight request |
| 5.2 | Model returns English despite Hinglish instruction | Inconsistent model compliance | Append explicit instruction: "Respond entirely in Hinglish. Do not switch to English mid-response." |
| 5.3 | Stored language value is corrupted or missing | Prompt is built without language instruction; falls back to English | Validate stored value against `["en", "hi-en"]`; default to `"en"` if invalid |

---

## Phase 2 — The Brain

---

### Slice 6 — Grounded Page Chat

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 6.1 | User navigates to a new page mid-conversation | Subsequent answers reference the old page | Detect `chrome.tabs.onUpdated` URL change; clear or mark context stale; prompt user to re-extract |
| 6.2 | Extracted page content is too large for the full history + context | Context window exceeded on a long conversation | Summarise earlier turns; keep last 3 full turns + fresh page context as rolling window |
| 6.3 | Page context is empty (extraction failed) and user asks a question | Model hallucinates without any grounding | Block chat submission if context is empty; show "Couldn't read this page — answers won't be grounded" |
| 6.4 | User asks a question in a different language than the page | Model may mix languages | Always apply the stored language preference as a prompt instruction regardless of page language |
| 6.5 | Conversation history grows very large in React state | Memory pressure in the panel; slow renders | Cap visible history at 50 messages; older messages collapsed or removed from in-memory state |

---

### Slice 7 — Right-Click Context Menu Actions

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 7.1 | User right-clicks without selecting any text | `selectionText` is empty; prompt is meaningless | Check for empty `selectionText` in context-menu handler; show "Select some text first" |
| 7.2 | Side panel is not open when context-menu action fires | Message to panel has no receiver | Use `chrome.sidePanel.open()` to open the panel before sending the result, or queue the result until panel connects |
| 7.3 | Selected text is extremely long (entire article selected) | Prompt is too large; hits token limit | Truncate selection to 3 000 chars with a visible notice |
| 7.4 | Context menu appears on a browser UI page (`chrome://`, `edge://`) | `scripting` API unavailable on these pages | The context menu should not be shown on restricted URLs; use `documentUrlPatterns` in `contextMenus.create` |
| 7.5 | User fires two context-menu actions in quick succession | Two concurrent AI calls overwrite each other in ChatView | Queue incoming context-menu results; render them sequentially |

---

### Slice 8 — Screenshot-and-Ask

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 8.1 | `captureVisibleTab` called when tab is not in the foreground | Chrome returns an error | Require active tab focus; show "Please make the tab active before taking a screenshot" |
| 8.2 | Captured image is very large (high-DPI display) | Base64 data URL is huge; Gemini may reject it | Downscale the canvas to max 1280 px width before encoding |
| 8.3 | User submits the screenshot without typing a question | Prompt is empty; model gives a generic description | Require a non-empty question before enabling the Send button |
| 8.4 | Tab contains sensitive content (banking page) | Screenshot sent to Gemini despite safety rules | Run `SafetyGuard.checkPrivacy(url)` before capturing; block if sensitive |
| 8.5 | Gemini Flash multimodal endpoint returns an image-policy refusal | Error surfaced as a confusing API message | Catch refusal response; show "The model couldn't process this image — it may contain restricted content" |

---

### Slice 9 — Error Handling and Fallback Chain

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 9.1 | Both Gemini and Groq keys are missing | Fallback chain exhausted immediately | Show a single clear message: "Add at least one API key in Settings to use Lemon" |
| 9.2 | Groq free tier hits its own daily limit | Second 429 on the fallback | Detect Groq 429; show "All free-tier limits reached — try again later" |
| 9.3 | Retry with exponential backoff takes longer than user expects | User thinks the extension crashed | Show a visible "Retrying…" spinner with attempt count (e.g. "Retrying 1/2…") |
| 9.4 | Gemini returns a 200 but with a `finishReason: SAFETY` block | No tokens in the stream; silent failure | Detect `finishReason: SAFETY`; show "Response blocked by model safety filter — rephrase your question" |
| 9.5 | Network request times out (slow connection) | `fetch` hangs indefinitely | Set an `AbortController` timeout of 30 s on every AI call |
| 9.6 | Service worker is killed during a retry wait | Retry timer lost; request silently dropped | Do not rely on `setTimeout` for retry state; persist retry metadata to storage |

---

## Phase 3 — The Hands

---

### Slice 10 — Interactive Element Scanner + Badges

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 10.1 | Page uses a shadow DOM (web components) | `querySelectorAll` misses elements inside shadow roots | Recursively walk open shadow roots during `queryAll()` |
| 10.2 | Page has hundreds of interactive elements (complex dashboard) | Action map is enormous; too many tokens | Cap action map at 50 elements; prioritise visible elements (`IntersectionObserver`) |
| 10.3 | DOM changes after scan (dynamic content load) | Stale element IDs; actor targets the wrong element | Re-scan before each agent tick; treat IDs as valid only for the current snapshot |
| 10.4 | Two elements share the same visible label (two "Submit" buttons) | AI picks the wrong one | Include `rect` (position) in action map so AI can disambiguate by location |
| 10.5 | Badge overlay changes the page layout (pushes elements) | Visual glitch; page breaks | Use `position: fixed` or `position: absolute` with pointer-events: none for badges |
| 10.6 | cleanup() is called but badges are already removed by page navigation | `querySelectorAll('[data-lemon-badge]')` returns nothing | Make cleanup() idempotent; skip silently if no badges found |
| 10.7 | Scanner runs on an `<iframe>` content | Cross-origin iframes are inaccessible | Only scan the top-level document; note in action map that iframe content is not scanned |

---

### Slice 11 — "Find It for Me"

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 11.1 | Requested element does not exist on the page | AI returns a plausible but wrong element ID | Show the element name + reason to the user; let them confirm before highlighting |
| 11.2 | AI returns an `elementId` that is out of range for the current action map | `actor.js` would target a non-existent element | Validate `elementId` is within `[1, actionMap.length]` in `schema-validator.js` |
| 11.3 | AI returns valid JSON but with extra unexpected keys | Schema validator rejects it | Validator should use `additionalProperties: false` only for mandatory keys; accept extra keys silently |
| 11.4 | AI wraps JSON in markdown code fences (` ```json ... ``` `) | `JSON.parse` fails | Strip leading/trailing ` ```json ` and ` ``` ` before parsing |
| 11.5 | Two retries both produce invalid JSON | Agent loop stuck | After 2 failed JSON parses, stop the agent and show "Model returned an unreadable response" |

---

### Slice 12 — Agent Loop Core

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 12.1 | Page navigates away mid-task (link click, redirect) | Action map is stale; next tick targets wrong page | Detect URL change via `chrome.tabs.onUpdated`; pause agent and notify "Page changed — task paused" |
| 12.2 | Target element is scrolled out of view when actor tries to click | `element.click()` may miss or hit wrong element | Scroll element into view (`scrollIntoView`) before any actor action |
| 12.3 | `type` action on an input that already has a value | Field is not cleared first; text appends to existing value | Clear field with `element.value = ""` before typing |
| 12.4 | AI proposes `done` immediately on step 1 without doing anything useful | Task ends too early | Show the `done` reason to the user and ask for confirmation before stopping |
| 12.5 | Agent is in `waiting_approval` state and user closes Chrome entirely | State is persisted but side panel port is gone | On next open, detect `agentState.status === "waiting_approval"`; show the pending action card and let user decide |
| 12.6 | Two browser tabs are open and agent is started on both | Two `agentState` objects collide in storage | Key agent state by `tabId`; only one active agent allowed at a time; show error if a second start is attempted |
| 12.7 | Actor action succeeds but triggers a full page reload | Next `getPageState` returns a fresh DOM, IDs reset | Wait for `chrome.tabs.onUpdated` status `"complete"` before calling `getPageState` after each action |
| 12.8 | `select` action on a custom dropdown (not a native `<select>`) | `element.value = x` does nothing | Detect non-native dropdowns in the action map; flag them as `type: custom-select`; use click-sequence fallback |

---

### Slice 13 — Agent Controls (Persistence, Dry-Run, Step Limit, Logs)

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 13.1 | Service worker wakes to a stale `agentState` from a previous browser session | Restores state on a tab that no longer exists | Validate `tabId` still exists via `chrome.tabs.get`; clear state if tab is gone |
| 13.2 | `chrome.storage.local` write fails (storage quota exceeded) | Persist silently fails; state is lost on SW sleep | Catch write errors; warn user "Storage full — agent progress may not be saved" |
| 13.3 | Dry-run highlight is not removed when mode is toggled off | Ghost highlight stays on page | Always call `cleanup()` when exiting dry-run mode |
| 13.4 | Step counter reaches limit but the current action is mid-execution | Partial action performed; loop breaks at a bad point | Check step limit at the start of `tick()`, before any action is executed |
| 13.5 | Log grows very large for a long task | Rendering thousands of log entries slows the panel | Virtualise the log list or paginate; store full log in storage but render last 100 entries |

---

## Phase 4 — Memory, Safety, and Shipping

---

### Slice 14 — Local Profile Memory

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 14.1 | Profile field contains special characters (quotes, angle brackets) | Injected into AI prompt; breaks prompt structure | Escape profile values before injecting into any prompt string |
| 14.2 | User has not filled profile but agent tries to autofill a "Name" field | Agent proposes an empty string | Check that profile field is non-empty before suggesting it; fall back to asking the user for the value |
| 14.3 | Two profile fields map to the same form field label (e.g. "name" and "full name") | Agent picks ambiguous match | Use fuzzy label matching with a confidence threshold; show the match to the user before applying |
| 14.4 | Profile contains a phone number or date of birth | Sensitive data injected into all prompts unnecessarily | Only inject profile fields that are relevant to the current detected form fields; do not send the full profile by default |
| 14.5 | User edits profile while an agent task is running | In-flight prompt uses stale profile data | Snapshot profile at `agent.start()`; don't re-read during the task |

---

### Slice 15 — One-Click Skills

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 15.1 | Imported skills file is malformed JSON | `JSON.parse` throws; import silently fails | Wrap parse in try/catch; show "Invalid file — could not import skills" |
| 15.2 | Imported skills file has duplicate IDs with existing skills | Storage overwritten silently | Compare IDs on import; prompt "3 skills already exist — overwrite or keep both?" |
| 15.3 | Skill prompt is very long and page context is also large | Combined prompt exceeds context window | Truncate page context more aggressively when a skill prompt is large; warn "Page context shortened for this skill" |
| 15.4 | User runs a skill on a page with no readable content | Skill produces a meaningless output | Check for empty page context before running a skill; show "No readable content — skill may not be useful here" |
| 15.5 | User deletes all skills accidentally | No undo | Keep a "recently deleted" buffer (last 3 deleted skills) for one session; show Undo toast |
| 15.6 | Exported file name collides with an existing file | Browser auto-renames to `skills (1).json` | This is default browser behaviour and is acceptable; no special handling needed |

---

### Slice 16 — Safety Rails

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 16.1 | Banking domain check uses an incomplete regex and misses a bank URL | Safety rule bypassed | Maintain a curated domain list plus a broad pattern (`*.bank.*`, `*pay*`, `*upi*`); log misses for iteration |
| 16.2 | Page dynamically loads a payment iframe after initial safety check | `checkPage` passes but payment fields appear | Re-run `checkField` on every element before the actor types into it, not just at scan time |
| 16.3 | OTP field is not typed `number` — it uses `type="text"` with name/id heuristics | `checkField` misses it | Check `name`, `id`, `placeholder`, `autocomplete` for OTP patterns (`otp`, `one.time`, `verification`) |
| 16.4 | User dismisses the extra confirmation modal and the agent re-proposes the same action | Endless confirmation loop | After user cancels a confirmation, log it as "user declined" and call `skip()`, not `tick()` with the same action |
| 16.5 | Stop button click races with an in-progress `actor.js` DOM action | Half-action executed; DOM in partial state | Set a `stopping` flag synchronously; actor checks the flag before each DOM mutation |
| 16.6 | SafetyGuard is bypassed because a page URL changes to a sensitive domain mid-task | Agent continues on a bank page | Run `checkPage` on every `chrome.tabs.onUpdated` URL change event during an active agent task |
| 16.7 | User exports skills file and it inadvertently contains API key (if key was ever stored in skill prompt) | Key exposed in exported file | Scan exported JSON for key-shaped strings (40+ char alphanumeric); warn before download |
| 16.8 | `checkPrivacy` regex too aggressive — blocks legitimate pages (e.g. a healthcare news article) | User cannot summarise valid content | Distinguish between healthcare content sites (news) and patient portals; block only authenticated/portal URLs |

---

### Slice 17 — Public Packaging and Release

| # | Scenario | Failure Mode | Handling |
|---|---|---|---|
| 17.1 | `.env` file is accidentally committed | API key exposed in git history | Add `.env` to `.gitignore` before the first commit; use `git-secrets` or a pre-commit hook to block key patterns |
| 17.2 | `dist/` folder is committed | Repo is bloated; build artefacts in version control | Add `dist/` to `.gitignore`; document that users build locally |
| 17.3 | GitHub Release ZIP is built on a different Node version | Subtle build differences; extension may behave unexpectedly | Pin Node version in `.github/workflows/release.yml` using `actions/setup-node` |
| 17.4 | User installs the ZIP on a Chromium-based browser that is not Chrome | Some APIs (Side Panel) may not exist | Document "Chrome only" clearly; detect missing `chrome.sidePanel` at startup and show a graceful message |
| 17.5 | Another user clones the repo and runs `npm install` on a newer Node | Peer dependency conflicts or changed lock file | Commit `package-lock.json`; document the tested Node version |

---

## Cross-Cutting Edge Cases

These scenarios cut across multiple slices and can surface anywhere.

| # | Scenario | Slices Affected | Handling |
|---|---|---|---|
| X.1 | `chrome.runtime.lastError` is not checked after every async Chrome API call | All | Wrap every `chrome.tabs.*`, `chrome.scripting.*`, `chrome.storage.*` call with `lastError` checks; log silently |
| X.2 | Message listener receives an unknown `type` | 2, 6, 7, 8, 11, 12 | Default case returns `{ error: "Unknown message type" }`; never throw uncaught |
| X.3 | Concurrent messages arrive before service worker finishes a previous one | 2, 6, 12 | Use an async message queue or guard with a `busy` flag per message type |
| X.4 | `chrome.storage.local` hits the 10 MB quota | 12, 13, 14, 15 | Monitor storage usage; compress or prune old agent logs and conversation history automatically |
| X.5 | User runs Lemon on a page that embeds Lemon itself (localhost dev server) | 3, 6, 10 | Detect own extension URL; skip extraction and show "Running on Lemon's own page" notice |
| X.6 | AI model responds in a language other than English or Hinglish | 5, 6 | Always include an explicit language constraint in every system prompt |
| X.7 | Prompt injection attempt in page content (page contains "Ignore previous instructions…") | 3, 6, 10 | Wrap page content in a clear delimiter in the prompt (`<page-content>…</page-content>`); instruct model to treat it as untrusted data |
| X.8 | Extension is updated while an agent task is in progress | 12, 13 | `chrome.runtime.onInstalled` fires; detect version change; stop any active agent task and notify user |
| X.9 | User runs multiple browser windows | 1, 12 | Each window's side panel is independent; agent state is keyed by `tabId` to avoid cross-window conflicts |
| X.10 | Device clock is wrong | 13, 15 | Use relative timestamps (elapsed time) in logs rather than absolute wall-clock time where possible |
