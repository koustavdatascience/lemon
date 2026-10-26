/**
 * SettingsView — Slice 14: Local Profile Memory
 *
 * Sections:
 *   1. AI API Keys   (Gemini + Groq, unchanged from Slice 9)
 *   2. Profile       (Slice 14) — name, email, phone, college, degree,
 *                    graduation year, city, country, LinkedIn, GitHub,
 *                    website, skills[], links[], preferred tone,
 *                    and up to 5 custom key→value fields
 *   3. About
 *
 * Storage keys:
 *   chrome.storage.local["settings"]  — API keys + language
 *   chrome.storage.local["profile"]   — all profile fields
 *
 * Edge cases:
 *   1.4  Concurrent writes  → each section saves its own key atomically
 *   1.5  Whitespace in keys → trimmed on save
 *   14.1 Special chars      → escaped in storage-helpers before prompt injection
 *   14.2 Empty fields       → only non-empty values are injected into prompts
 */

import React, { useState, useEffect, useId } from "react";

const SETTINGS_KEY = "settings";
const PROFILE_KEY  = "profile";
const MAX_CUSTOM_FIELDS = 5;

// ─── Root component ────────────────────────────────────────────────────────────

export default function SettingsView() {
  return (
    <div
      id="panel-settings"
      role="tabpanel"
      aria-labelledby="tab-settings"
      className="flex flex-col h-full overflow-y-auto"
    >
      <div className="flex flex-col gap-6 p-4 pb-10">
        <ApiKeysSection />
        <ProfileSection />
        <AboutSection />
      </div>
    </div>
  );
}

// ─── API Keys section (unchanged from Slice 9) ────────────────────────────────

function ApiKeysSection() {
  const [geminiKey,   setGeminiKey]   = useState("");
  const [groqKey,     setGroqKey]     = useState("");
  const [saveStatus,  setSaveStatus]  = useState("idle");
  const [loaded,      setLoaded]      = useState(false);

  useEffect(() => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      if (chrome.runtime.lastError) return;
      const saved = result?.[SETTINGS_KEY] ?? {};
      setGeminiKey(saved.geminiApiKey ?? "");
      setGroqKey(saved.groqApiKey ?? "");
      setLoaded(true);
    });
  }, []);

  function handleSave() {
    setSaveStatus("saving");
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      if (chrome.runtime.lastError) { setSaveStatus("error"); return; }
      const current = result?.[SETTINGS_KEY] ?? {};
      chrome.storage.local.set({
        [SETTINGS_KEY]: {
          ...current,
          geminiApiKey: geminiKey.trim(),
          groqApiKey:   groqKey.trim(),
        },
      }, () => {
        if (chrome.runtime.lastError) { setSaveStatus("error"); return; }
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 2000);
      });
    });
  }

  const statusLabel = { idle: null, saving: "Saving…", saved: "✓ Saved", error: "⚠ Save failed" }[saveStatus];
  const statusClass = { idle: "", saving: "text-gray-500", saved: "text-green-600", error: "text-red-600" }[saveStatus];

  if (!loaded) return <SectionSkeleton />;

  return (
    <section aria-labelledby="section-keys">
      <SectionHeading id="section-keys">AI API Keys</SectionHeading>
      <div className="flex flex-col gap-4 bg-gray-50 rounded-xl p-4 border border-gray-200">
        <InputField
          label="Gemini API Key"
          id="gemini-key"
          type="password"
          value={geminiKey}
          onChange={(e) => setGeminiKey(e.target.value)}
          placeholder="AIza…"
          helpText="Get a free key at aistudio.google.com. Stored only on this device."
        />
        <InputField
          label="Groq API Key (fallback)"
          id="groq-key"
          type="password"
          value={groqKey}
          onChange={(e) => setGroqKey(e.target.value)}
          placeholder="gsk_…"
          helpText="Optional. Used when Gemini rate limits are reached. Get a key at console.groq.com."
        />
      </div>
      <SaveRow onSave={handleSave} busy={saveStatus === "saving"} statusLabel={statusLabel} statusClass={statusClass} />
    </section>
  );
}

// ─── Profile section (Slice 14) ───────────────────────────────────────────────

function ProfileSection() {
  // Standard fields
  const [name,        setName]        = useState("");
  const [firstName,   setFirstName]   = useState("");
  const [lastName,    setLastName]    = useState("");
  const [email,       setEmail]       = useState("");
  const [phone,       setPhone]       = useState("");
  const [college,     setCollege]     = useState("");
  const [degree,      setDegree]      = useState("");
  const [graduation,  setGraduation]  = useState("");
  const [city,        setCity]        = useState("");
  const [country,     setCountry]     = useState("");
  const [linkedin,    setLinkedin]    = useState("");
  const [github,      setGithub]      = useState("");
  const [website,     setWebsite]     = useState("");
  const [tone,        setTone]        = useState("professional");

  // Skills — stored as comma-separated in the textarea, serialised as string[]
  const [skillsRaw,   setSkillsRaw]   = useState("");

  // Links — array of { label, url }
  const [links,       setLinks]       = useState([{ label: "", url: "" }]);

  // Custom fields — array of { label, value }
  const [customFields, setCustomFields] = useState([]);

  const [saveStatus, setSaveStatus] = useState("idle");
  const [loaded,     setLoaded]     = useState(false);

  useEffect(() => {
    chrome.storage.local.get(PROFILE_KEY, (result) => {
      if (chrome.runtime.lastError) return;
      const p = result?.[PROFILE_KEY] ?? {};

      setName(p.name ?? "");
      setFirstName(p.firstName ?? "");
      setLastName(p.lastName ?? "");
      setEmail(p.email ?? "");
      setPhone(p.phone ?? "");
      setCollege(p.college ?? "");
      setDegree(p.degree ?? "");
      setGraduation(p.graduation ?? "");
      setCity(p.city ?? "");
      setCountry(p.country ?? "");
      setLinkedin(p.linkedin ?? "");
      setGithub(p.github ?? "");
      setWebsite(p.website ?? "");
      setTone(p.tone ?? "professional");
      setSkillsRaw(Array.isArray(p.skills) ? p.skills.join(", ") : (p.skills ?? ""));
      setLinks(p.links?.length ? p.links : [{ label: "", url: "" }]);
      setCustomFields(p.customFields ?? []);
      setLoaded(true);
    });
  }, []);

  function handleSave() {
    setSaveStatus("saving");

    // Parse skills from comma-separated text
    const skills = skillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Filter out blank links
    const cleanLinks = links.filter((l) => l.label.trim() || l.url.trim());

    // Filter out blank custom fields
    const cleanCustom = customFields.filter((cf) => cf.label.trim() && cf.value.trim());

    const profile = {
      name:         name.trim(),
      firstName:    firstName.trim(),
      lastName:     lastName.trim(),
      email:        email.trim(),
      phone:        phone.trim(),
      college:      college.trim(),
      degree:       degree.trim(),
      graduation:   graduation.trim(),
      city:         city.trim(),
      country:      country.trim(),
      linkedin:     linkedin.trim(),
      github:       github.trim(),
      website:      website.trim(),
      tone:         tone.trim(),
      skills,
      links:        cleanLinks,
      customFields: cleanCustom,
    };

    chrome.storage.local.set({ [PROFILE_KEY]: profile }, () => {
      if (chrome.runtime.lastError) { setSaveStatus("error"); return; }
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    });
  }

  // ── Link helpers ─────────────────────────────────────────────────────────
  function addLink() {
    setLinks((prev) => [...prev, { label: "", url: "" }]);
  }
  function updateLink(i, field, val) {
    setLinks((prev) => prev.map((l, idx) => idx === i ? { ...l, [field]: val } : l));
  }
  function removeLink(i) {
    setLinks((prev) => prev.filter((_, idx) => idx !== i));
  }

  // ── Custom field helpers ─────────────────────────────────────────────────
  function addCustomField() {
    if (customFields.length >= MAX_CUSTOM_FIELDS) return;
    setCustomFields((prev) => [...prev, { label: "", value: "" }]);
  }
  function updateCustomField(i, field, val) {
    setCustomFields((prev) => prev.map((cf, idx) => idx === i ? { ...cf, [field]: val } : cf));
  }
  function removeCustomField(i) {
    setCustomFields((prev) => prev.filter((_, idx) => idx !== i));
  }

  const statusLabel = { idle: null, saving: "Saving…", saved: "✓ Saved", error: "⚠ Save failed" }[saveStatus];
  const statusClass = { idle: "", saving: "text-gray-500", saved: "text-green-600", error: "text-red-600" }[saveStatus];

  if (!loaded) return <SectionSkeleton />;

  return (
    <section aria-labelledby="section-profile">
      <SectionHeading id="section-profile">Profile</SectionHeading>
      <p className="text-xs text-gray-500 mb-3">
        Lemon uses this data to autofill form fields when running agent tasks. Stored only on this device.
      </p>

      <div className="flex flex-col gap-5 bg-gray-50 rounded-xl p-4 border border-gray-200">

        {/* ── Personal ── */}
        <Subsection label="Personal">
          <div className="grid grid-cols-2 gap-3">
            <InputField label="First name" id="p-first" value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Ada" />
            <InputField label="Last name"  id="p-last"  value={lastName}  onChange={(e) => setLastName(e.target.value)}  placeholder="Lovelace" />
          </div>
          <InputField label="Full name" id="p-name"  value={name}  onChange={(e) => setName(e.target.value)}  placeholder="Ada Lovelace" />
          <InputField label="Email"     id="p-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" type="email" />
          <InputField label="Phone"     id="p-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 9876543210" />
          <div className="grid grid-cols-2 gap-3">
            <InputField label="City"    id="p-city"    value={city}    onChange={(e) => setCity(e.target.value)}    placeholder="Bangalore" />
            <InputField label="Country" id="p-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="India" />
          </div>
        </Subsection>

        {/* ── Education ── */}
        <Subsection label="Education">
          <InputField label="College / School"  id="p-college"    value={college}    onChange={(e) => setCollege(e.target.value)}    placeholder="IIT Delhi" />
          <InputField label="Degree"            id="p-degree"     value={degree}     onChange={(e) => setDegree(e.target.value)}     placeholder="B.Tech Computer Science" />
          <InputField label="Graduation year"   id="p-graduation" value={graduation} onChange={(e) => setGraduation(e.target.value)} placeholder="2025" />
        </Subsection>

        {/* ── Online presence ── */}
        <Subsection label="Online">
          <InputField label="LinkedIn"  id="p-linkedin" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder="linkedin.com/in/ada" />
          <InputField label="GitHub"    id="p-github"   value={github}   onChange={(e) => setGithub(e.target.value)}   placeholder="github.com/ada" />
          <InputField label="Website"   id="p-website"  value={website}  onChange={(e) => setWebsite(e.target.value)}  placeholder="ada.dev" />
        </Subsection>

        {/* ── Skills ── */}
        <Subsection label="Skills">
          <div className="flex flex-col gap-1">
            <label htmlFor="p-skills" className="text-xs font-medium text-gray-600">Skills (comma-separated)</label>
            <textarea
              id="p-skills"
              value={skillsRaw}
              onChange={(e) => setSkillsRaw(e.target.value)}
              rows={2}
              placeholder="React, Python, Machine Learning, Figma"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-lemon-400 focus:border-lemon-400 transition placeholder:text-gray-400"
            />
          </div>
        </Subsection>

        {/* ── Links ── */}
        <Subsection label="Links">
          <div className="flex flex-col gap-2">
            {links.map((lnk, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label={`Link ${i + 1} label`}
                  value={lnk.label}
                  onChange={(e) => updateLink(i, "label", e.target.value)}
                  placeholder="Label (e.g. Portfolio)"
                  className="w-28 shrink-0 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition"
                />
                <input
                  type="url"
                  aria-label={`Link ${i + 1} URL`}
                  value={lnk.url}
                  onChange={(e) => updateLink(i, "url", e.target.value)}
                  placeholder="https://…"
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition"
                />
                <button
                  type="button"
                  onClick={() => removeLink(i)}
                  aria-label={`Remove link ${i + 1}`}
                  className="shrink-0 text-gray-400 hover:text-red-500 transition text-lg leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={addLink}
              className="self-start text-xs text-lemon-700 hover:text-lemon-900 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
            >
              + Add link
            </button>
          </div>
        </Subsection>

        {/* ── Preferred tone ── */}
        <Subsection label="Writing style">
          <div className="flex flex-col gap-1">
            <label htmlFor="p-tone" className="text-xs font-medium text-gray-600">Preferred tone</label>
            <select
              id="p-tone"
              value={tone}
              onChange={(e) => setTone(e.target.value)}
              className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition bg-white"
            >
              <option value="professional">Professional</option>
              <option value="casual">Casual & friendly</option>
              <option value="formal">Formal</option>
              <option value="concise">Concise & direct</option>
              <option value="enthusiastic">Enthusiastic</option>
            </select>
            <p className="text-xs text-gray-400">Used by Draft-a-Reply and agent fill actions.</p>
          </div>
        </Subsection>

        {/* ── Custom fields ── */}
        <Subsection label={`Custom fields (${customFields.length}/${MAX_CUSTOM_FIELDS})`}>
          <div className="flex flex-col gap-2">
            {customFields.length === 0 && (
              <p className="text-xs text-gray-400">No custom fields yet.</p>
            )}
            {customFields.map((cf, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  aria-label={`Custom field ${i + 1} label`}
                  value={cf.label}
                  onChange={(e) => updateCustomField(i, "label", e.target.value)}
                  placeholder="Field name"
                  className="w-28 shrink-0 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition"
                />
                <input
                  type="text"
                  aria-label={`Custom field ${i + 1} value`}
                  value={cf.value}
                  onChange={(e) => updateCustomField(i, "value", e.target.value)}
                  placeholder="Value"
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 transition"
                />
                <button
                  type="button"
                  onClick={() => removeCustomField(i)}
                  aria-label={`Remove custom field ${i + 1}`}
                  className="shrink-0 text-gray-400 hover:text-red-500 transition text-lg leading-none focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
                >
                  ×
                </button>
              </div>
            ))}
            {customFields.length < MAX_CUSTOM_FIELDS && (
              <button
                type="button"
                onClick={addCustomField}
                className="self-start text-xs text-lemon-700 hover:text-lemon-900 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
              >
                + Add custom field
              </button>
            )}
          </div>
        </Subsection>
      </div>

      <SaveRow onSave={handleSave} busy={saveStatus === "saving"} statusLabel={statusLabel} statusClass={statusClass} />
    </section>
  );
}

// ─── About section ────────────────────────────────────────────────────────────

function AboutSection() {
  return (
    <section aria-labelledby="section-about" className="mt-auto">
      <SectionHeading id="section-about">About</SectionHeading>
      <div className="text-xs text-gray-500 space-y-1 bg-gray-50 rounded-xl p-3 border border-gray-200">
        <p>🍋 Lemon v0.1.0</p>
        <p>All data is stored locally on your device.</p>
        <p>API keys are never committed to source control or sent anywhere except the respective AI provider.</p>
      </div>
    </section>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionHeading({ id, children }) {
  return (
    <h2 id={id} className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">
      {children}
    </h2>
  );
}

function Subsection({ label, children }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-semibold text-gray-500">{label}</p>
      {children}
    </div>
  );
}

function InputField({ label, id, type = "text", value, onChange, placeholder, helpText }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-gray-600">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-lemon-400 focus:border-lemon-400 transition placeholder:text-gray-400"
      />
      {helpText && <p className="text-xs text-gray-400">{helpText}</p>}
    </div>
  );
}

function SaveRow({ onSave, busy, statusLabel, statusClass }) {
  return (
    <div className="flex items-center gap-3 mt-3">
      <button
        type="button"
        onClick={onSave}
        disabled={busy}
        className="px-4 py-2 text-sm font-medium bg-lemon-400 hover:bg-lemon-500 text-gray-900 rounded-lg transition disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-lemon-500"
      >
        Save
      </button>
      {statusLabel && (
        <span className={`text-sm ${statusClass}`} role="status" aria-live="polite">
          {statusLabel}
        </span>
      )}
    </div>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-3 animate-pulse">
      <div className="h-3 w-24 bg-gray-200 rounded" />
      <div className="h-9 bg-gray-100 rounded-lg" />
      <div className="h-9 bg-gray-100 rounded-lg" />
    </div>
  );
}
