#!/usr/bin/env node
// Adds `alias ft=…` and `alias figtokens=…` lines to the user's shell rc,
// idempotently. On zsh we wrap with `noglob` so bare `?` in Figma URLs
// doesn't trigger filename globbing. bash has no `noglob` — we add a
// comment telling the user to single-quote URLs.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..");
const entrypoint = resolve(projectRoot, "dist", "index.js");

const shell = process.env.SHELL || "";
const isZsh = shell.includes("zsh");
const isBash = shell.includes("bash");

const rcFile = isZsh
  ? resolve(homedir(), ".zshrc")
  : isBash
    ? resolve(homedir(), ".bashrc")
    : resolve(homedir(), ".zshrc"); // sensible default on macOS

// v2 marker. The v1 marker is still recognized so we don't double-append,
// but we always write a new v2 block when v2 isn't present yet.
const MARKER_V1 = "# added by tokens-studio-mcp setup-alias";
const MARKER_V2 = "# added by tokens-studio-mcp setup-alias v2";

// zsh: `noglob` disables filename expansion for the rest of the command
// line, so `?` and `[` in URLs are passed through. `&` is still job
// control — users have to quote it or paste from clipboard.
const aliasLines = isZsh || (!isBash)
  ? [
      `alias figtokens='noglob node ${entrypoint}'`,
      `alias ft='noglob node ${entrypoint}'`,
    ]
  : [
      `# NOTE: bash has no 'noglob'. Single-quote Figma URLs that contain '?' or '&':`,
      `#   ft 'https://www.figma.com/design/abc/File?node-id=1-2&t=foo'`,
      `alias figtokens="node ${entrypoint}"`,
      `alias ft="node ${entrypoint}"`,
    ];

const block = `\n${MARKER_V2}\n${aliasLines.join("\n")}\n`;

function alreadyPresentV2() {
  if (!existsSync(rcFile)) return false;
  const contents = readFileSync(rcFile, "utf8");
  return contents.includes(MARKER_V2);
}

function hasV1Only() {
  if (!existsSync(rcFile)) return false;
  const contents = readFileSync(rcFile, "utf8");
  return contents.includes(MARKER_V1) && !contents.includes(MARKER_V2);
}

if (!existsSync(entrypoint)) {
  console.error(
    `✗ dist/index.js not found. Run \`npm run build\` first, then re-run \`npm run alias\`.`
  );
  process.exit(1);
}

if (alreadyPresentV2()) {
  console.log(`✓ v2 aliases already installed in ${rcFile}`);
} else {
  appendFileSync(rcFile, block, { mode: 0o644 });
  console.log(`✓ Added v2 aliases to ${rcFile}:`);
  for (const line of aliasLines) console.log(`    ${line}`);
  if (hasV1Only()) {
    console.log(
      `\nNote: an older v1 alias block is still in ${rcFile}. The new v2 block takes precedence`
    );
    console.log(
      `      after reload. You can delete the old block tagged "${MARKER_V1}" at your leisure.`
    );
  }
  if (isZsh) {
    console.log(
      `\n✓ zsh 'noglob' wrapper installed — bare '?' in Figma URLs will not trigger globbing.`
    );
    console.log(
      `  URLs containing '&' still need single quotes (zsh job control), or paste from clipboard.`
    );
  } else if (isBash) {
    console.log(
      `\n! bash alias installed without 'noglob'. Single-quote URLs that contain '?' or '&'.`
    );
  }
}

console.log("\nReload your shell or run:");
console.log(`    source ${rcFile}`);
console.log("\nThen try:");
console.log("    ft help");
console.log("    # copy a Figma URL in your browser, then:");
console.log("    ft");
