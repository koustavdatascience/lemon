import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import webExtension from "vite-plugin-web-extension";

export default defineConfig({
  // The `public/` directory is copied verbatim into `dist/` by Vite.
  // We point it at the project root so that assets/ and lib/ are
  // copied without transformation (icons, vendored Readability.js, etc.)
  publicDir: "public",

  plugins: [
    react(),
    webExtension({
      manifest: "manifest.json",
      // The plugin reads manifest.json and discovers all entry points automatically.
      // Do NOT list service-worker or HTML pages in additionalInputs — the plugin
      // handles them. additionalInputs is only for files not referenced in the manifest.
      disableAutoLaunch: true,
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV !== "production",
  },
});
