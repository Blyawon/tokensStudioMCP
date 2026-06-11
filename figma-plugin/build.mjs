/**
 * Plugin build — bundles modular sandbox code and copies the UI.
 *
 * Sandbox: esbuild bundles src/sandbox/index.ts → dist/code.js
 *          (follows all imports, outputs a single IIFE)
 *
 * UI:      Copies ui.html → dist/ui.html as-is. The UI is a single
 *          self-contained HTML file (Figma plugin requirement). CSS and
 *          JS are inlined because Figma sandboxes the UI iframe and
 *          blocks external <link> / <script src> references.
 *
 * No watch mode; rerun `npm run build:plugin` after editing.
 */

import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });

// Bundle sandbox code from modular source files.
await build({
  entryPoints: [resolve(root, "src", "sandbox", "index.ts")],
  outfile: resolve(dist, "code.js"),
  bundle: true,
  format: "iife",
  target: "es2017",
  platform: "browser",
  logLevel: "info",
});

// Copy UI (self-contained HTML with inline CSS + JS).
await copyFile(resolve(root, "ui.html"), resolve(dist, "ui.html"));

console.log("[plugin] built dist/code.js + dist/ui.html");
