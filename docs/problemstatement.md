# Problem Statement

## 1. Project Overview

Build Lemon, a Chrome side-panel AI agent that can understand the page currently open in the browser and help the user act on it safely.

Lemon should be able to:

- Summarise articles and public YouTube videos in English or Hinglish.
- Chat with the current web page and answer only from the page context.
- Explain, translate, or draft replies from selected page content.
- Read visible screen content through screenshot-based questions.
- Detect interactive elements such as buttons, links, inputs, dropdowns, and checkboxes.
- Turn those elements into a numbered action map that an AI model can reason about.
- Execute browser actions only after the user approves each step.
- Remember a local user profile and reuse it for forms, drafts, and saved one-click skills.
- Apply safety rules that prevent risky actions on sensitive pages or fields.
- Run locally as a Chrome extension using free-tier tools wherever possible.

The project must be completed in 4 weeks and should result in a safe, installable Chrome extension that can be shared through a public GitHub release.

## 2. Problem Statement

Most AI assistants can explain information, but they are separated from the browser context where users actually work. Users still need to copy text into a chatbot, explain what page they are viewing, identify which field or button matters, and manually carry out every browser step. More capable browser agents can automate these tasks, but they may be paid, unavailable to some users, or too autonomous for actions that involve personal information or consequential clicks.

The goal of Lemon is to create a user-controlled browser agent that combines understanding and action while keeping the user in charge.

Lemon must understand the current page, reason about visible and interactive content, propose one action at a time, and wait for explicit approval before acting. It must also include privacy and safety restrictions so it does not operate on sensitive pages or enter protected information.

## 3. Primary Goal

At the end of four weeks, a user should be able to open Lemon in the Chrome side panel on a supported page and do the following:

1. Ask Lemon to summarise the current article or a public YouTube link.
2. Switch the response language between English and Hinglish.
3. Ask follow-up questions about the page.
4. Use quick actions such as Explain, Translate, and Draft a reply.
5. Ask questions about visible non-text content using a screenshot.
6. Give Lemon a browser task such as filling a practice form or finding information.
7. Review the next proposed action and choose Approve, Skip, or Stop.
8. Let Lemon perform only the approved browser action.
9. See a log of the actions that were proposed and performed.
10. Reuse locally stored profile information and saved skills.

Lemon is not intended to be a fully autonomous browser bot. It is an agent the user controls.

## 4. Target Platform and Core Stack

### Browser

- Google Chrome on desktop.
- Chrome Extension Manifest V3.
- Chrome Side Panel API.
- Chrome content scripts and chrome.scripting for page interaction.
- chrome.tabs.captureVisibleTab for screen capture.
- chrome.contextMenus for right-click actions.
- chrome.storage.local for local memory and preferences.

### Development Environment

- Cursor as the primary code editor and AI-assisted development environment.

### AI and Content Processing

- Gemini Flash-Lite as the default everyday model.
- Gemini Flash for harder image or reasoning tasks when needed.
- Groq free tier as a text-only fallback when appropriate.
- Gemini public YouTube link input for supported public YouTube content.
- Mozilla Readability.js for extracting readable article content.

### Distribution

- GitHub repository.
- GitHub Releases for an installable extension ZIP.
- GitHub Pages for a simple project landing page.

## 5. Four-Week Build Plan

### Week 1 - The Eyes: Read the Web

#### Objective

Create the Chrome extension foundation and give Lemon the ability to read and summarise web content.

#### Required Features

**1. Chrome Extension Foundation**

Create a Manifest V3 Chrome extension containing:

- Extension manifest.
- Side-panel interface.
- Background service worker.
- Settings area for the user's Gemini API key.
- Ability to load the project through Chrome's Load unpacked flow.

**2. First AI Interaction**

The user should be able to select text on a page and ask Lemon to explain it in plain language. The result should be displayed inside the side panel.

**3. Article Summarisation**

Use Readability.js to extract the useful article content while excluding navigation, advertisements, footers, and other page noise.

Generate a structured summary containing:

- One-line TL;DR.
- Five key points.
- What to do next.

**4. Public YouTube Summarisation**

For a supported public YouTube link, Lemon should provide a useful structured summary. Where supported, the result should include chapter-style notes with clickable timestamps that jump to the relevant moment.

Private or unsupported YouTube content is outside the required scope.

**5. Language Toggle**

The user must be able to switch output between:

- English.
- Hinglish.

#### Week 1 Acceptance Criteria

Week 1 is complete when:

- The extension loads successfully in Chrome.
- The side panel opens next to a normal webpage.
- The API key can be entered through extension settings rather than hard-coded.
- Selected text can be explained by the AI.
- A normal article can be summarised into the required structure.
- A supported public YouTube link can be summarised.
- English/Hinglish switching works.

#### Optional Stretch Goal

If the device supports Chrome's built-in AI requirements, add on-device/offline article summarisation as an optional enhancement. This is not required for the core build.

---

### Week 2 - The Brain: Understand the Page and the Screen

#### Objective

Turn the side panel into a context-aware assistant that can reason about the current page and visible screen content.

#### Required Features

**1. Page Chat**

Add a chat interface that uses the current page as context.

The assistant must:

- Answer questions using the page content.
- Avoid inventing information that is not present on the page.
- Clearly say when the answer is not available from the current page.
- Keep conversation history for the active interaction.
- Stream responses into the side panel when supported.

**2. Right-Click AI Actions**

Add Chrome context-menu actions for selected text:

- Explain this - simplify jargon or dense text.
- Translate - translate into Hindi or another selected language.
- Draft a reply - create a reply for content such as an email, LinkedIn post, or forum message.

All results should open in or be sent to the Lemon side panel.

**3. Screenshot-and-Ask**

Allow the user to capture the visible browser tab and ask a question about visual content such as:

- Charts.
- Diagrams.
- Error messages.
- Forms.
- Other visible content that cannot be understood from extracted text alone.

The user should be able to focus the request on the relevant part of the screen before it is sent to the model.

**4. Free-Tier Resilience**

Lemon must fail gracefully when model limits are reached.

Required behaviour:

- Detect rate-limit responses such as HTTP 429.
- Wait and retry where appropriate.
- Use the lighter model by default.
- Switch to a stronger Gemini model only when needed.
- Use a text-only fallback provider for eligible text tasks.
- Show a helpful error state instead of crashing.

#### Week 2 Acceptance Criteria

Week 2 is complete when:

- The user can chat with the current page.
- Answers remain grounded in page content.
- Explain, Translate, and Draft a reply work from the right-click menu.
- The user can ask a question about a visible screenshot.
- Model errors and rate limits do not crash the extension.

---

### Week 3 - The Hands: Act With User Approval

#### Objective

Give Lemon controlled computer-use capabilities without allowing it to act autonomously.

#### Required Features

**1. Interactive Element Scanner**

Create a content script that scans the current page for interactive elements including:

- Buttons.
- Links.
- Text inputs.
- Text areas.
- Dropdowns.
- Checkboxes.
- Other supported user-action elements.

Assign each detected element a stable number for the current page state.

**2. Numbered Action Map**

Display numbered badges over detected interactive elements.

Create a compact structured representation of those elements for the AI so the model reasons over a concise action map instead of raw page HTML.

**3. Find It for Me**

Allow the user to ask a navigation question such as:

Where do I upload my resume?

Lemon should identify the most relevant numbered element and highlight it without taking the action automatically.

The model response for element selection should use strict structured JSON.

**4. Agent Loop**

Implement a one-step-at-a-time agent loop:

1. Read the current page state.
2. Build or refresh the action map.
3. Ask the AI for the single next action.
4. Receive that action as strict JSON.
5. Show the proposed action and reason to the user.
6. Wait for the user to choose Approve, Skip, or Stop.
7. Execute only an approved action.
8. Read the updated page state.
9. Repeat until the task is complete or stopped.

Supported action types should include:

- click
- type
- select
- scroll
- done

Each proposed action should include at least:

- Action type.
- Target element number when applicable.
- Required value when applicable.
- One-line reason.

**5. Agent Controls**

The agent must include:

- Maximum step limit.
- Stop button.
- Skip action.
- Dry-run mode that highlights the intended element without acting.
- Progress persistence so a paused approval flow is not lost when the extension background worker sleeps.
- Action log containing the proposed step, reason, and user decision.

**6. Practice Tasks**

The agent should be capable of completing controlled practice tasks such as:

- Filling a multi-step internship application from a short instruction.
- Searching a practice shop and applying filters.
- Collecting information from multiple pages into a table.

#### Week 3 Acceptance Criteria

Week 3 is complete when:

- Interactive elements are detected and numbered reliably on supported pages.
- Lemon can identify the correct element from a natural-language request.
- The next action is returned in strict JSON.
- No browser action happens before user approval.
- Approve, Skip, Stop, step limit, and dry-run controls work.
- The agent survives normal service-worker sleep by saving progress.
- An action log is preserved for the task.
- Lemon can complete at least two supported practice errands with approval at every step.

---

### Week 4 - Memory, Safety, and Shipping

#### Objective

Make Lemon personal, reusable, safe, and installable by other users.

#### Required Features

**1. Local Profile Memory**

Create a user profile stored only on the user's machine using chrome.storage.local.

The profile may contain fields such as:

- Name.
- College.
- Skills.
- Links.
- Preferred language.
- Preferred tone.

Use this profile when relevant for:

- Filling supported forms.
- Drafting replies.
- Personalising common workflows.

**2. One-Click Skills**

Allow the user to save reusable prompt recipes that can run on the current page.

Example skills from the cohort brief include:

- Exam notes.
- Explain in Hinglish.
- Reply to this email politely.
- Fill this form from my profile.

Skills should be exportable and importable as a small local file.

**3. Safety Rails**

Lemon must include explicit safety restrictions.

Required rules:

- Block agent actions on banking, payment, and UPI pages.
- Never type into password fields.
- Never type into OTP fields.
- Never type card information.
- Require an additional confirmation before consequential buttons such as Submit, Pay, or Send.
- Provide an immediate kill switch / Stop control.
- Keep API keys out of the public GitHub repository.
- Do not send private or sensitive pages to the free-tier model.
- Restrict agent errands to the provided practice environment or pages the user owns/controls.
- Do not automate logins, payments, or OTP workflows.

**4. Public Packaging**

Prepare Lemon so another user can install and understand it.

Required outputs:

- Public GitHub repository.
- Clean README.
- Setup instructions.
- Screenshots showing the extension and its key features.
- GitHub Release ZIP that can be installed with Load unpacked.
- One-page GitHub Pages landing site.

#### Week 4 Acceptance Criteria

Week 4 is complete when:

- User profile memory works locally.
- Saved skills can be created and reused.
- Skills can be exported and imported.
- Restricted pages and protected fields are blocked.
- Consequential actions require extra confirmation.
- The API key is not committed to the repository.
- The project can be installed by another user from the release package.
- The repository contains clear setup and usage documentation.
- A simple public landing page exists.

## 6. Functional Requirements

### FR-1: Side Panel

Lemon must run primarily inside the Chrome side panel and remain available while the user works on the current page.

### FR-2: Settings

The extension must provide a settings interface for API credentials and user preferences.

### FR-3: Content Extraction

Lemon must distinguish readable article content from page chrome and irrelevant layout content.

### FR-4: Summarisation

Lemon must produce structured summaries and support English/Hinglish output.

### FR-5: Grounded Page Chat

Page chat must use the current page as its source of truth and admit when the page does not contain the requested answer.

### FR-6: Visual Understanding

The user must be able to ask questions about the visible browser screen when text extraction is insufficient.

### FR-7: Structured Agent Decisions

Agent decisions must be returned in strict machine-readable JSON so application code controls execution.

### FR-8: Human Approval

Every agent action must require explicit user approval before execution.

### FR-9: Local Memory

Personal profile information and preferences must be stored locally using Chrome storage.

### FR-10: Safety Enforcement in Code

Safety rules must be enforced by extension code, not only by model instructions.

## 7. Non-Functional Requirements

### Reliability

- Handle API failures and rate limits without crashing.
- Preserve agent progress across service-worker suspension where needed.
- Validate model-generated JSON before using it.

### Privacy

- Keep API keys out of source control.
- Keep profile memory on the local device.
- Avoid sending private or sensitive pages to external models.

### Safety

- User approval is mandatory for actions.
- Sensitive pages and fields must be blocked by deterministic code.
- The user must always have a visible way to stop an active task.

### Cost

- The core project should work with the free stack described in the cohort plan.
- Stronger or paid model tiers are optional upgrades, not requirements for the core project.

### Usability

- Main features should be reachable from the side panel.
- Errors should be understandable to a non-expert user.
- The extension should make the proposed browser action clear before asking for approval.

## 8. Out of Scope

The following are not required for the four-week core build:

- Chrome on Android or iPhone.
- Autonomous execution without user approval.
- Banking or payment automation.
- Login automation.
- OTP automation.
- Entering passwords or card information.
- Sending private email, banking, or personal-document pages to an external free-tier AI service.
- Acting on arbitrary third-party sites for risky or consequential workflows.
- Chrome Web Store publication; a GitHub release installed through Load unpacked is sufficient for the core build.

## 9. Definition of Done

Lemon is considered complete when a new user can install the extension from the project release, enter their own API key, open the side panel on a supported webpage, and successfully use the complete workflow below:

1. Summarise an article or supported public YouTube link.
2. Switch between English and Hinglish.
3. Chat with the current page.
4. Use Explain, Translate, or Draft a reply from selected text.
5. Ask a question about visible screen content.
6. Ask Lemon to find a relevant interactive element.
7. Give the agent a supported browser task.
8. Review and approve each proposed step.
9. Stop or skip a step at any time.
10. Review the action log.
11. Reuse local profile data and a saved skill.
12. Confirm that protected pages, fields, and actions are blocked by the safety rules.

The final result should feel like a browser assistant that can read, explain, see, remember, and act - while the user remains in control of every consequential step.

## 10. Recommended Cursor Execution Order

Use this document as the top-level project specification in Cursor. Build the project in vertical slices rather than generating the entire extension at once.

Recommended order:

1. Extension shell + side panel + settings.
2. Gemini text call.
3. Article extraction and summary.
4. Public YouTube summary.
5. English/Hinglish toggle.
6. Grounded page chat.
7. Context-menu actions.
8. Screenshot-and-ask.
9. API error handling and fallback logic.
10. Interactive element scanner and badges.
11. Structured element selection.
12. Approval-based agent loop.
13. Persistence, dry run, step limits, and action logs.
14. Local profile memory.
15. Saved skills import/export.
16. Safety rails.
17. README, release packaging, and landing page.

For each slice, implement the smallest working version first, test it on real supported pages, and only then move to the next feature.



## Steps

### Context Setup

- problemStatement.md → detailed problemStatement of the project we are building
- architecture.md → high level decision that I take while building the project
- implementation-plan.md → phase-wise implementation-plan
- edge-case.md → corner scenarios and edge-cases

### Prompts

1. Generate a detailed architecture.md for making this project using @problemStatement.md
2. Generate a phase-wise implementation-plan.md for making this project using @architecture.md @problemStatement.md
3. Generate an edge-case.md which stores all the corner scenarios for the implementation of the project @implementation-plan.md
4. Implement slice 1 of phase1 using the @implementation-plan.md
5. Implement slice 2 from phase1 as per the @implementation-plan.md
6. I can add my API key in .env file if required for slice 2
7. Implement slice 3 of phase1 of @implementation-plan.md

**MANUAL TESTING**

8. run the project so that I can test in chrome
9. Copy paste the errors that are coming and fix them

https://aistudio.google.com/

GEMINI API KEY
