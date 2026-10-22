/**
 * sync-public.js
 * Copies static assets that must be served verbatim (not bundled by Vite/Rollup)
 * into the public/ directory before each build.
 *
 * Files copied:
 *   lib/Readability.js              → public/lib/Readability.js
 *   content-scripts/reader.js       → public/content-scripts/reader.js
 *   content-scripts/scanner.js      → public/content-scripts/scanner.js   (Slice 10)
 *   content-scripts/actor.js        → public/content-scripts/actor.js     (Slice 12)
 *   assets/icons/*                  → public/assets/icons/*
 *
 * Why: vite-plugin-web-extension bundles JS entry points through Rollup, which
 * breaks content scripts that rely on being plain IIFE scripts. Readability.js
 * must also stay unmodified. Putting them in public/ ensures Vite copies them
 * as-is to dist/.
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function syncFile(src, dest) {
  if (!existsSync(src)) return; // skip if not yet created (later slices)
  ensureDir(dirname(dest));
  copyFileSync(src, dest);
  console.log(`  synced: ${src.replace(ROOT, "").replace(/\\/g, "/")} → ${dest.replace(ROOT, "").replace(/\\/g, "/")}`);
}

console.log("[sync-public] Syncing static assets to public/…");

// ── lib/ ──────────────────────────────────────────────────────────────────────
syncFile(
  join(ROOT, "lib", "Readability.js"),
  join(ROOT, "public", "lib", "Readability.js")
);

// ── content-scripts/ ─────────────────────────────────────────────────────────
for (const file of ["reader.js", "scanner.js", "actor.js"]) {
  syncFile(
    join(ROOT, "content-scripts", file),
    join(ROOT, "public", "content-scripts", file)
  );
}

// ── icons/ ────────────────────────────────────────────────────────────────────
const iconsDir = join(ROOT, "assets", "icons");
if (existsSync(iconsDir)) {
  for (const file of readdirSync(iconsDir)) {
    syncFile(
      join(iconsDir, file),
      join(ROOT, "public", "assets", "icons", file)
    );
  }
}

console.log("[sync-public] Done.");
