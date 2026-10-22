/**
 * storage-helpers.js
 * Typed wrappers around chrome.storage.local.
 * All reads/writes go through these helpers so the rest of the codebase
 * never hard-codes storage key strings.
 */

const SETTINGS_KEY = "settings";
const PROFILE_KEY  = "profile";
const SKILLS_KEY   = "skills";
const AGENT_KEY    = "agentState";

// ─── Generic helpers ──────────────────────────────────────────────────────────

/**
 * Promise-based wrapper for chrome.storage.local.get.
 * Returns the value at `key`, or `defaultValue` if absent.
 */
export function storageGet(key, defaultValue = null) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (result) => {
      if (chrome.runtime.lastError) {
        console.error("[storage] get error:", chrome.runtime.lastError);
        resolve(defaultValue);
        return;
      }
      resolve(result[key] ?? defaultValue);
    });
  });
}

/**
 * Promise-based wrapper for chrome.storage.local.set.
 */
export function storageSet(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) {
        console.error("[storage] set error:", chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
        return;
      }
      resolve();
    });
  });
}

/**
 * Merge a partial update into an existing storage object.
 * Safe to call even if the key doesn't exist yet.
 */
export async function storageMerge(key, patch) {
  const current = await storageGet(key, {});
  await storageSet(key, { ...current, ...patch });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Returns the full settings object. */
export async function getSettings() {
  return storageGet(SETTINGS_KEY, {});
}

/** Returns the Gemini API key, trimmed, or null if absent. */
export async function getGeminiApiKey() {
  const settings = await getSettings();
  const key = settings?.geminiApiKey?.trim();
  return key || null;
}

/** Returns the Groq API key, trimmed, or null if absent. Slice 9 uses this. */
export async function getGroqApiKey() {
  const settings = await getSettings();
  const key = settings?.groqApiKey?.trim();
  return key || null;
}

/** Returns the stored language preference ("en" | "hi-en"), defaulting to "en". */
export async function getLanguage() {
  const settings = await getSettings();
  const lang = settings?.language;
  return lang === "hi-en" ? "hi-en" : "en";
}

// ─── Profile (Slice 14) ───────────────────────────────────────────────────────

export async function getProfile() {
  return storageGet(PROFILE_KEY, {});
}

export async function setProfile(profile) {
  return storageSet(PROFILE_KEY, profile);
}

// ─── Skills (Slice 15) ────────────────────────────────────────────────────────

export async function getSkills() {
  return storageGet(SKILLS_KEY, []);
}

export async function setSkills(skills) {
  return storageSet(SKILLS_KEY, skills);
}

// ─── Agent State (Slice 12) ───────────────────────────────────────────────────

export async function getAgentState() {
  return storageGet(AGENT_KEY, null);
}

export async function setAgentState(state) {
  return storageSet(AGENT_KEY, state);
}

export async function clearAgentState() {
  return storageSet(AGENT_KEY, null);
}
