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

/**
 * Build a compact plain-text snippet summarising the user profile for injection
 * into AI prompts. Only includes non-empty fields to keep tokens low.
 *
 * Edge case 14.1: values are escaped so special chars don't break prompt structure.
 * Edge case 14.4: only fields relevant to the current context should be sent;
 *   callers can pass `fieldsOfInterest` (array of label keywords) to filter.
 *   Pass null/undefined to include everything.
 *
 * @param {object} [fieldsOfInterest]  array of lowercase label keywords, e.g. ["name","email"]
 * @returns {Promise<string>}
 */
export async function buildProfilePromptSnippet(fieldsOfInterest = null) {
  const profile = await getProfile();
  if (!profile || Object.keys(profile).length === 0) return "";

  const lines = [];

  /** Helper: escape a value so it can't break the surrounding prompt */
  const esc = (v) => String(v ?? "").replace(/[<>"]/g, "").trim();

  /** Helper: check if a field label matches a keyword of interest */
  const relevant = (label) => {
    if (!fieldsOfInterest) return true;
    const lower = label.toLowerCase();
    return fieldsOfInterest.some((kw) => lower.includes(kw));
  };

  // Standard fields
  const STANDARD = [
    { key: "name",       label: "Full name"     },
    { key: "firstName",  label: "First name"    },
    { key: "lastName",   label: "Last name"     },
    { key: "email",      label: "Email"         },
    { key: "phone",      label: "Phone"         },
    { key: "college",    label: "College/School"},
    { key: "degree",     label: "Degree"        },
    { key: "graduation", label: "Graduation year"},
    { key: "linkedin",   label: "LinkedIn"      },
    { key: "github",     label: "GitHub"        },
    { key: "website",    label: "Website"       },
    { key: "city",       label: "City"          },
    { key: "country",    label: "Country"       },
    { key: "tone",       label: "Preferred tone"},
  ];

  for (const { key, label } of STANDARD) {
    const val = profile[key];
    if (val && relevant(label)) lines.push(`${label}: ${esc(val)}`);
  }

  // skills[] array
  if (Array.isArray(profile.skills) && profile.skills.length > 0 && relevant("skills")) {
    lines.push(`Skills: ${profile.skills.map(esc).join(", ")}`);
  }

  // links[] array
  if (Array.isArray(profile.links) && profile.links.length > 0 && relevant("links")) {
    for (const lnk of profile.links) {
      if (lnk?.label && lnk?.url) lines.push(`${esc(lnk.label)}: ${esc(lnk.url)}`);
    }
  }

  // custom fields
  if (Array.isArray(profile.customFields)) {
    for (const cf of profile.customFields) {
      if (cf?.label && cf?.value && relevant(cf.label)) {
        lines.push(`${esc(cf.label)}: ${esc(cf.value)}`);
      }
    }
  }

  if (lines.length === 0) return "";
  return `User profile:\n${lines.join("\n")}`;
}

// ─── Skills (Slice 15) ────────────────────────────────────────────────────────

export async function getSkills() {
  return storageGet(SKILLS_KEY, []);
}

export async function setSkills(skills) {
  return storageSet(SKILLS_KEY, skills);
}

/**
 * Add or update a skill. If a skill with the same id exists it is replaced;
 * otherwise the new skill is appended.
 * @param {{ id:string, name:string, prompt:string, createdAt:number }} skill
 */
export async function upsertSkill(skill) {
  const skills = await getSkills();
  const idx    = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    skills[idx] = skill;
  } else {
    skills.push(skill);
  }
  return setSkills(skills);
}

/**
 * Delete a skill by id. Returns the deleted skill so the caller can offer Undo.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function deleteSkill(id) {
  const skills  = await getSkills();
  const deleted = skills.find((s) => s.id === id) ?? null;
  await setSkills(skills.filter((s) => s.id !== id));
  return deleted;
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
