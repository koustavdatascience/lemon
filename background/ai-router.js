/**
 * ai-router.js
 * Handles all AI API calls for Lemon.
 *
 * Responsibilities:
 *  - Model selection based on task type
 *  - Streaming fetch with token-by-token delivery via a callback
 *  - Error detection (429, 5xx, safety blocks, empty candidates)
 *  - Retry with exponential backoff (max 2 retries)
 *  - Fallback chain: gemini-flash-lite → gemini-flash → groq
 *
 * Slice 9: Groq fallback fully wired in.
 */

import { getGeminiApiKey, getGroqApiKey } from "./storage-helpers.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GROQ_BASE   = "https://api.groq.com/openai/v1/chat/completions";

const MODELS = {
  FLASH_LITE: "gemini-3.5-flash-lite",   // was gemini-2.0-flash-lite (retired June 2026)
  FLASH:      "gemini-3.5-flash",        // was gemini-2.0-flash (retired June 2026)
};

const GROQ_MODEL = "llama-3.3-70b-versatile";

/**
 * Task → default model mapping.
 * Values are keys into MODELS.
 */
const TASK_MODEL_MAP = {
  chat:           "FLASH_LITE",
  summarise:      "FLASH_LITE",
  "youtube":      "FLASH_LITE",
  "page-chat":    "FLASH_LITE",
  "context-menu": "FLASH_LITE",
  screenshot:     "FLASH",       // multimodal — always Flash
  agent:          "FLASH_LITE",
};

const MAX_RETRIES   = 2;
const RETRY_BASE_MS = 1000; // first retry after 1 s, second after 2 s
const FETCH_TIMEOUT_MS = 30_000;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Stream a response from the AI.
 *
 * @param {object} opts
 * @param {string}   opts.task        — key in TASK_MODEL_MAP
 * @param {Array}    opts.messages    — [{ role: "user"|"model", parts: [{ text }] }]
 * @param {string}  [opts.systemPrompt] — optional system instruction
 * @param {function} opts.onToken     — called with each text chunk as it arrives
 * @param {function} opts.onDone      — called with the full text when streaming ends
 * @param {function} opts.onError     — called with an Error object on failure
 * @param {AbortSignal} [opts.signal] — optional AbortSignal for cancellation
 */
export async function streamChat({
  task = "chat",
  messages,
  systemPrompt,
  onToken,
  onDone,
  onError,
  signal,
}) {
  const modelKey = TASK_MODEL_MAP[task] ?? "FLASH_LITE";
  const modelName = MODELS[modelKey];

  try {
    // ── Try Gemini first (flash-lite, with escalation to flash) ────────────
    await _streamWithRetry({
      modelName,
      messages,
      systemPrompt,
      onToken,
      onDone,
      signal,
      retryCount: 0,
      task,
    });
  } catch (err) {
    // ── Fallback to Groq if Gemini key missing or rate-limited (Slice 9) ────
    if (err.message.startsWith("NO_KEY:") || err.message.startsWith("RATE_LIMIT:")) {
      try {
        await _fallbackToGroq({ messages, systemPrompt, onToken, onDone, signal });
        return;
      } catch (groqErr) {
        // Edge case 9.1: both keys missing → single clear message
        if (err.message.startsWith("NO_KEY:") && groqErr.message.startsWith("NO_KEY:")) {
          onError(new Error("NO_KEY: Add at least one API key in Settings to use Lemon."));
        } else {
          onError(groqErr);
        }
        return;
      }
    }

    // Non-recoverable error (AUTH, SAFETY, NETWORK, etc.)
    onError(err);
  }
}

// ─── Internal implementation ──────────────────────────────────────────────────

async function _streamWithRetry({
  modelName,
  messages,
  systemPrompt,
  onToken,
  onDone,
  signal,
  retryCount,
  task,
}) {
  const apiKey = await getGeminiApiKey();

  if (!apiKey) {
    throw new Error("NO_KEY: Add your Gemini API key in Settings.");
  }

  const url = `${GEMINI_BASE}/${modelName}:streamGenerateContent?key=${apiKey}&alt=sse`;

  const body = buildGeminiBody(messages, systemPrompt);

  // Set up timeout
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  // Combine caller signal with our timeout signal
  const combinedSignal = signal
    ? anyAbort([signal, controller.signal])
    : controller.signal;

  let response;
  try {
    response = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
      signal:  combinedSignal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === "AbortError") {
      throw new Error("TIMEOUT: The request took too long. Check your connection and try again.");
    }
    throw new Error(`NETWORK: ${fetchErr.message}`);
  }

  clearTimeout(timeoutId);

  // ── Handle non-200 responses ─────────────────────────────────────────────
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return _handleHttpError({
      status: response.status,
      body: errorBody,
      modelName,
      messages,
      systemPrompt,
      onToken,
      onDone,
      signal,
      retryCount,
      task,
    });
  }

  // ── Stream SSE tokens ─────────────────────────────────────────────────────
  let fullText = "";

  try {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE lines arrive as "data: {...}\n\n"
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep the incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue; // malformed chunk — skip
        }

        // Check for safety block
        const finishReason = parsed?.candidates?.[0]?.finishReason;
        if (finishReason === "SAFETY") {
          throw new Error(
            "SAFETY: Response blocked by model safety filter — try rephrasing your question."
          );
        }

        const chunk = parsed?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (chunk) {
          fullText += chunk;
          onToken(chunk);
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.message.startsWith("SAFETY:")) throw streamErr;
    throw new Error(`STREAM: Lost connection while receiving response. ${streamErr.message}`);
  }

  onDone(fullText);
}

// ─── HTTP error handler ───────────────────────────────────────────────────────

async function _handleHttpError({
  status,
  body,
  modelName,
  messages,
  systemPrompt,
  onToken,
  onDone,
  signal,
  retryCount,
  task,
}) {
  // ── Rate limit — retry with backoff ─────────────────────────────────────
  if (status === 429) {
    if (retryCount < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * (retryCount + 1);
      onToken(`\n⏳ Rate limit reached — retrying in ${waitMs / 1000}s… (${retryCount + 1}/${MAX_RETRIES})\n`);
      await sleep(waitMs);
      return _streamWithRetry({
        modelName,
        messages,
        systemPrompt,
        onToken,
        onDone,
        signal,
        retryCount: retryCount + 1,
        task,
      });
    }

    // Escalate: flash-lite → flash
    if (modelName === MODELS.FLASH_LITE) {
      onToken("\n⬆️ Switching to a stronger model…\n");
      return _streamWithRetry({
        modelName: MODELS.FLASH,
        messages,
        systemPrompt,
        onToken,
        onDone,
        signal,
        retryCount: 0,
        task,
      });
    }

    // Flash also exhausted — let streamChat try Groq as fallback
    throw new Error(
      "RATE_LIMIT: All Gemini free-tier limits reached."
    );
  }

  // ── Auth errors ──────────────────────────────────────────────────────────
  if (status === 401) {
    throw new Error("AUTH: Invalid Gemini API key. Check Settings.");
  }
  if (status === 403) {
    throw new Error(
      "AUTH: API key doesn't have Gemini access. Make sure it's enabled in Google AI Studio."
    );
  }

  // ── Server errors — retry ────────────────────────────────────────────────
  if (status >= 500 && retryCount < MAX_RETRIES) {
    const waitMs = RETRY_BASE_MS * (retryCount + 1);
    await sleep(waitMs);
    return _streamWithRetry({
      modelName,
      messages,
      systemPrompt,
      onToken,
      onDone,
      signal,
      retryCount: retryCount + 1,
      task,
    });
  }

  throw new Error(`API_ERROR: Gemini returned HTTP ${status}. ${_extractApiMessage(body)}`);
}

// ─── Groq fallback (Slice 9) ──────────────────────────────────────────────────

/**
 * Checks for a Groq API key and streams via Groq's OpenAI-compatible endpoint.
 * Called by streamChat when Gemini fails with NO_KEY or RATE_LIMIT.
 *
 * Edge case 9.1: if no Groq key either, throws NO_KEY so streamChat can show
 *   a single combined "Add at least one API key" message.
 * Edge case 9.2: Groq 429 → throw RATE_LIMIT with "all limits reached" message.
 */
async function _fallbackToGroq({ messages, systemPrompt, onToken, onDone, signal }) {
  const groqKey = await getGroqApiKey();

  if (!groqKey) {
    throw new Error("NO_KEY: No Groq API key found.");
  }

  onToken("\n⬇️ Falling back to Groq…\n");

  await _streamGroqWithRetry({
    messages,
    systemPrompt,
    onToken,
    onDone,
    signal,
    retryCount: 0,
  });
}

/**
 * Streams a response from Groq's OpenAI-compatible API with retry logic.
 * Retries on 429 and 5xx with exponential backoff (max MAX_RETRIES).
 *
 * Note on edge case 9.6: retry uses `await sleep(ms)` which relies on
 * setTimeout. If the SW is killed during a retry wait, the request is lost.
 * Full retry-state persistence is deferred to Slice 13 (agent persistence).
 */
async function _streamGroqWithRetry({
  messages,
  systemPrompt,
  onToken,
  onDone,
  signal,
  retryCount,
}) {
  const groqKey = await getGroqApiKey();

  if (!groqKey) {
    throw new Error("NO_KEY: No Groq API key found.");
  }

  // Convert Gemini-format messages to OpenAI format
  const openaiMessages = convertToOpenAIMessages(messages, systemPrompt);

  const body = {
    model:       GROQ_MODEL,
    messages:    openaiMessages,
    stream:      true,
    max_tokens:  2048,
    temperature: 0.7,
  };

  // Timeout
  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const combinedSignal = signal
    ? anyAbort([signal, controller.signal])
    : controller.signal;

  let response;
  try {
    response = await fetch(GROQ_BASE, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${groqKey}`,
      },
      body:    JSON.stringify(body),
      signal:  combinedSignal,
    });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr.name === "AbortError") {
      throw new Error("TIMEOUT: The request took too long. Check your connection and try again.");
    }
    throw new Error(`NETWORK: ${fetchErr.message}`);
  }

  clearTimeout(timeoutId);

  // ── Handle non-200 ────────────────────────────────────────────────────────
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return _handleGroqHttpError({
      status:     response.status,
      body:        errorBody,
      messages,
      systemPrompt,
      onToken,
      onDone,
      signal,
      retryCount,
    });
  }

  // ── Stream SSE tokens (OpenAI format) ──────────────────────────────────────
  let fullText = "";

  try {
    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const jsonStr = trimmed.slice(5).trim();
        if (jsonStr === "[DONE]") break;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        // Check for safety/content filter
        const finishReason = parsed?.choices?.[0]?.finish_reason;
        if (finishReason === "content_filter") {
          throw new Error(
            "SAFETY: Response blocked by model safety filter — try rephrasing your question."
          );
        }

        const chunk = parsed?.choices?.[0]?.delta?.content ?? "";
        if (chunk) {
          fullText += chunk;
          onToken(chunk);
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.message.startsWith("SAFETY:")) throw streamErr;
    throw new Error(`STREAM: Lost connection while receiving response. ${streamErr.message}`);
  }

  onDone(fullText);
}

/**
 * Handles Groq HTTP errors with retry and clear user messages.
 * Edge case 9.2: Groq 429 → "all free-tier limits reached".
 */
async function _handleGroqHttpError({
  status,
  body,
  messages,
  systemPrompt,
  onToken,
  onDone,
  signal,
  retryCount,
}) {
  // ── Rate limit — retry then give up (Groq is last in the chain) ──────────
  if (status === 429) {
    if (retryCount < MAX_RETRIES) {
      const waitMs = RETRY_BASE_MS * (retryCount + 1);
      onToken(`\n⏳ Groq rate limit — retrying in ${waitMs / 1000}s… (${retryCount + 1}/${MAX_RETRIES})\n`);
      await sleep(waitMs);
      return _streamGroqWithRetry({
        messages,
        systemPrompt,
        onToken,
        onDone,
        signal,
        retryCount: retryCount + 1,
      });
    }

    // Edge case 9.2: Groq is the last fallback — all limits reached
    throw new Error(
      "RATE_LIMIT: All free-tier limits reached (Gemini and Groq). Try again later."
    );
  }

  // ── Auth errors ──────────────────────────────────────────────────────────
  if (status === 401) {
    throw new Error("AUTH: Invalid Groq API key. Check Settings.");
  }
  if (status === 403) {
    throw new Error("AUTH: Groq API key doesn't have access. Check your Groq console.");
  }

  // ── Server errors — retry ────────────────────────────────────────────────
  if (status >= 500 && retryCount < MAX_RETRIES) {
    const waitMs = RETRY_BASE_MS * (retryCount + 1);
    await sleep(waitMs);
    return _streamGroqWithRetry({
      messages,
      systemPrompt,
      onToken,
      onDone,
      signal,
      retryCount: retryCount + 1,
    });
  }

  throw new Error(`API_ERROR: Groq returned HTTP ${status}. ${_extractApiMessage(body)}`);
}

/**
 * Convert Gemini-format messages to OpenAI-format messages for Groq.
 * Extracts text from parts; skips inline image data (Groq text model can't use it).
 *
 * @param {Array<{role, parts}>} messages — Gemini format
 * @param {string} systemPrompt — optional system prompt
 * @returns {Array<{role, content}>} — OpenAI format
 */
function convertToOpenAIMessages(messages, systemPrompt) {
  const result = [];

  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt });
  }

  for (const msg of messages) {
    // Extract text from all parts, skip inlineData
    const textParts = msg.parts
      .filter((p) => p.text)
      .map((p) => p.text);
    const content = textParts.join("");

    if (!content) continue;

    result.push({
      role:    msg.role === "model" ? "assistant" : "user",
      content,
    });
  }

  return result;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Build the Gemini REST API request body.
 * messages: [{ role: "user"|"model", parts: [{ text }] }]
 */
function buildGeminiBody(messages, systemPrompt) {
  const body = { contents: messages };

  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  body.generationConfig = {
    temperature:     0.7,
    topP:            0.95,
    maxOutputTokens: 2048,
  };

  return body;
}

/**
 * Build a language instruction string for appending to system prompts.
 * @param {"en"|"hi-en"} language
 */
export function buildLanguageInstruction(language) {
  if (language === "hi-en") {
    return "Respond entirely in Hinglish (a natural mix of Hindi and English, written in Roman script). Do not switch to pure English or pure Hindi.";
  }
  return "Respond in clear, concise English.";
}

/**
 * Convert the simple chat history format used in the UI
 * to Gemini's `contents` array format.
 *
 * @param {Array<{role:"user"|"assistant", content:string}>} history
 * @param {string} newMessage — the latest user message
 * @returns {Array<{role:"user"|"model", parts:[{text:string}]}>}
 */
export function buildGeminiMessages(history, newMessage) {
  const contents = history.map((msg) => ({
    role:  msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  contents.push({
    role:  "user",
    parts: [{ text: newMessage }],
  });

  return contents;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _extractApiMessage(body) {
  try {
    const parsed = JSON.parse(body);
    return parsed?.error?.message ?? "";
  } catch {
    return "";
  }
}

/**
 * Returns an AbortSignal that aborts when ANY of the provided signals abort.
 */
function anyAbort(signals) {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}
