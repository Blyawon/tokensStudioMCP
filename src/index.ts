#!/usr/bin/env node
/**
 * Entry point for the `ft` CLI and the MCP stdio server.
 * Loads .env, then dispatches to the right handler based on argv.
 *
 * - No args + piped stdin → MCP server
 * - No args + TTY → clipboard auto-detect or help
 * - Subcommand → delegated to cli-commands.ts
 * - `ft mcp` → MCP server
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { c } from "./cli-ui.js";
import {
  cmdTree,
  cmdTokens,
  cmdNode,
  cmdCoverage,
  cmdConfig,
  cmdSetup,
  cmdHelp,
  printCommandList,
} from "./cli-commands.js";
import { runStdioServer } from "./mcp-server.js";

// --------------------------------------------------------------------------
// .env loader
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");

loadDotEnv();

function loadDotEnv(): void {
  if (!existsSync(ENV_PATH)) return;
  try {
    const raw = readFileSync(ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* ignore unreadable .env */
  }
}

// --------------------------------------------------------------------------
// Clipboard (macOS only)
// --------------------------------------------------------------------------

function readClipboard(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // No args: two very different callers.
  if (args.length === 0) {
    if (!process.stdin.isTTY) {
      await runStdioServer();
      return;
    }
    const clipped = readClipboard();
    if (clipped.startsWith("http") && clipped.includes("figma.com")) {
      console.error(
        `${c.green("▸")} ${c.dim("grabbed URL from clipboard:")} ${c.cyan(clipped)}\n`
      );
      await cmdTree([clipped]);
      return;
    }
    await cmdHelp();
    if (clipped) {
      console.error(
        "\n" +
          c.yellow(
            `Your clipboard has "${clipped.slice(0, 60)}…" — that doesn't look like a Figma URL.`
          )
      );
    } else {
      console.error(
        "\n" + c.dim("Clipboard is empty. Copy a Figma URL or pass one as an argument.")
      );
    }
    return;
  }

  const [cmd, ...rest] = args;
  switch (cmd) {
    case "tree":
    case "render":
      await cmdTree(rest);
      return;
    case "tokens":
      await cmdTokens(rest);
      return;
    case "node":
      await cmdNode(rest);
      return;
    case "coverage":
      await cmdCoverage(rest);
      return;
    case "config":
      cmdConfig();
      return;
    case "setup":
      await cmdSetup();
      return;
    case "mcp":
      await runStdioServer();
      return;
    case "help":
    case "--help":
    case "-h":
      await cmdHelp();
      return;
    default:
      if (cmd.startsWith("http") || cmd.startsWith("-")) {
        await cmdTree(args);
        return;
      }
      console.error(
        c.red(`Unknown command: \`${cmd}\`.`) + "\n"
      );
      printCommandList();
      process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(c.red("ft:") + " " + message);
  if (/URL|file key|node id/i.test(message)) {
    console.error(
      c.dim(
        "  Tip: wrap the Figma URL in single quotes so your shell doesn't mangle it."
      )
    );
  }
  process.exit(1);
});
