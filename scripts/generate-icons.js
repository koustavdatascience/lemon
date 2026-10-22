/**
 * Generates placeholder lemon-yellow PNG icons using the Canvas API (Node.js).
 * Run once after npm install: node scripts/generate-icons.js
 *
 * Requires: npm install canvas  (only needed for icon generation, not the extension itself)
 * If canvas is unavailable, replace the files in assets/icons/ with any real PNG icons.
 */

import { createCanvas } from "canvas";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(__dirname, "..", "assets", "icons");

mkdirSync(iconsDir, { recursive: true });

const sizes = [16, 32, 48, 128];

for (const size of sizes) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  // Background circle — lemon yellow
  ctx.fillStyle = "#facc15";
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  // Simple "L" text for sizes >= 32
  if (size >= 32) {
    ctx.fillStyle = "#1f2937";
    ctx.font = `bold ${Math.round(size * 0.55)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("L", size / 2, size / 2 + size * 0.04);
  }

  const buffer = canvas.toBuffer("image/png");
  const outPath = join(iconsDir, `icon${size}.png`);
  writeFileSync(outPath, buffer);
  console.log(`Created ${outPath}`);
}

console.log("Icon generation complete.");
