#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { FigmaClient, type FigmaNode } from "./figma-client.js";
import { parseFigmaTarget } from "./parse-url.js";
import { renderMetadataXml, renderSingleNodeTokens } from "./xml.js";
import { renderCompactTree, renderTokensList } from "./render-tree.js";
import { makeSkipPredicate } from "./tokens.js";
import {
  DEFAULT_CONFIG,
  formatConfig,
  loadConfig,
  unfilteredConfig,
  type FtConfig,
  type LoadedConfig,
} from "./config.js";
import { c, progressBar, revealSplash, withSpinner } from "./cli-ui.js";

// --------------------------------------------------------------------------
// Project root + .env loader
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
    /* ignore */
  }
}

// --------------------------------------------------------------------------
// Figma client helpers
// --------------------------------------------------------------------------

function getClient(): FigmaClient {
  const apiKey = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
  if (!apiKey) {
    throw new Error(
      "FIGMA_API_KEY is not set.\n" +
        "  Run:  ft setup\n" +
        "to store a Figma personal access token in .env."
    );
  }
  return new FigmaClient({ apiKey });
}

async function loadNode(
  client: FigmaClient,
  target: { fileKey: string; nodeId?: string },
  depth?: number
): Promise<FigmaNode> {
  if (target.nodeId) {
    const res = await client.fetchNodes(target.fileKey, [target.nodeId], { depth });
    const entry = res.nodes[target.nodeId];
    if (!entry || !entry.document) {
      throw new Error(
        `Figma returned no document for node ${target.nodeId} in file ${target.fileKey}.`
      );
    }
    return entry.document;
  }
  const file = await client.fetchFile(target.fileKey, { depth });
  return file.document;
}

/**
 * Wrap a Figma fetch in the Braille spinner. MCP and piped callers see a
 * plain `▸ fetching…` log line instead — see `cli-ui.spinner`.
 */
async function loadNodeWithSpinner(
  client: FigmaClient,
  target: { fileKey: string; nodeId?: string },
  depth?: number
): Promise<FigmaNode> {
  const label = target.nodeId
    ? `fetching node ${target.nodeId} from Figma`
    : `fetching file from Figma`;
  return withSpinner(label, async (sp) => {
    const node = await loadNode(client, target, depth);
    sp.update("rendering");
    return node;
  });
}

function targetFromInput(input: string): { fileKey: string; nodeId?: string } {
  return parseFigmaTarget({
    url: input.startsWith("http") ? input : undefined,
    fileKey: input.startsWith("http") ? undefined : input,
  });
}

// --------------------------------------------------------------------------
// CLI flag parsing
// --------------------------------------------------------------------------

interface CliFlags {
  /** User explicitly asked for --only-with-tokens on the command line. */
  onlyWithTokens: boolean | "unset";
  onlyGaps: boolean;
  layout: boolean;
  dedupe: boolean;
  format: "tree" | "xml";
  depth?: number;
  nodeOverride?: string;
  /** `--all` bypasses every config filter. */
  all: boolean;
  /** Explicit overrides for individual config filters. */
  withComponents: boolean;
  withVectors: boolean;
  withComposition: boolean;
  noWarn: boolean;
}

function parseFlags(args: string[]): { input?: string; flags: CliFlags } {
  const flags: CliFlags = {
    onlyWithTokens: "unset",
    onlyGaps: false,
    layout: false,
    dedupe: true,
    format: "tree",
    all: false,
    withComponents: false,
    withVectors: false,
    withComposition: false,
    noWarn: false,
  };
  let input: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--only-with-tokens" || a === "-o") flags.onlyWithTokens = true;
    else if (a === "--all-layers") flags.onlyWithTokens = false;
    else if (a === "--gaps" || a === "-g") flags.onlyGaps = true;
    else if (a === "--layout") flags.layout = true;
    else if (a === "--xml") flags.format = "xml";
    else if (a === "--no-dedupe") flags.dedupe = false;
    else if (a === "--all") flags.all = true;
    else if (a === "--with-components") flags.withComponents = true;
    else if (a === "--with-vectors") flags.withVectors = true;
    else if (a === "--with-composition") flags.withComposition = true;
    else if (a === "--no-warn") flags.noWarn = true;
    else if (a === "--depth" || a === "-d") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--depth expects a positive number, got "${args[i]}"`);
      }
      flags.depth = n;
    } else if (a === "--node" || a === "-n") flags.nodeOverride = args[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else if (!input) input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return { input, flags };
}

/**
 * Build the final effective config by applying CLI flag overrides on top
 * of the config loaded from disk. `--all` blows every filter away;
 * individual `--with-*` / `--no-warn` toggles override selectively.
 */
function effectiveConfig(loaded: LoadedConfig, flags: CliFlags): FtConfig {
  if (flags.all) return unfilteredConfig();
  const out: FtConfig = { ...loaded.config };
  if (flags.withComponents) out.ignoreComponents = false;
  if (flags.withVectors) out.ignoreVectorsWithoutFill = false;
  if (flags.withComposition) out.includeComposition = true;
  if (flags.noWarn) out.warnStyleGaps = false;
  // --only-with-tokens / --all-layers explicitly override the config default.
  if (flags.onlyWithTokens === true) out.onlyWithTokens = true;
  else if (flags.onlyWithTokens === false) out.onlyWithTokens = false;
  return out;
}

function resolveTarget(input: string, flags: CliFlags) {
  const base = targetFromInput(input);
  return flags.nodeOverride
    ? { ...base, nodeId: flags.nodeOverride.replace("-", ":") }
    : base;
}

/**
 * Detect the classic "zsh ate my URL" pattern and print a friendly hint.
 *
 * A Figma URL with query params but no `node-id` is the exact fingerprint
 * of a zsh split: the user typed `ft https://…?m=auto&node-id=1-2&t=abc`
 * unquoted, zsh treated `&` as a job-control separator, and `ft` only
 * received the truncated `https://…?m=auto` half. The URL still parses,
 * fileKey still resolves, but the expected node is gone.
 *
 * We can't distinguish this from a deliberate whole-file fetch with
 * tracking params (nobody does that), so we print a soft warning to
 * stderr and let the command continue — the user may actually have meant
 * the whole file, and they can ignore the hint if so.
 */
function maybeWarnAboutShellSplit(input: string | undefined): void {
  if (!input || !input.startsWith("http")) return;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return;
  }
  // Not a Figma URL → not our problem.
  if (!url.hostname.includes("figma.com")) return;
  // Has a node id → nothing lost, the URL survived.
  if (url.searchParams.has("node-id")) return;
  // No query params at all → user is doing a whole-file fetch on purpose.
  const paramCount = Array.from(url.searchParams.keys()).length;
  if (paramCount === 0) return;

  // Query params but no node-id — almost certainly a zsh split.
  process.stderr.write(
    "\n" +
      c.yellow("⚠  This URL has query params but no `node-id`.") +
      "\n" +
      c.dim(
        "   If your shell cut it off at `&`, wrap the URL in single quotes:"
      ) +
      "\n" +
      c.dim("     ft '") +
      c.cyan(input) +
      c.dim("&node-id=…'") +
      "\n" +
      c.dim("   Or copy the URL and run `ft` with no arguments.") +
      "\n\n"
  );
}

/** Lazy — only load once per process. */
let CACHED_CONFIG: LoadedConfig | null = null;
function getLoadedConfig(): LoadedConfig {
  if (!CACHED_CONFIG) CACHED_CONFIG = loadConfig();
  return CACHED_CONFIG;
}

// --------------------------------------------------------------------------
// Subcommands
// --------------------------------------------------------------------------

/**
 * Default `ft <url>` behaviour — the opinionated token dictionary with
 * gap warnings. Uses config filters (ignore components, ignore empty
 * vectors, strip composition tokens, surface style gaps).
 */
async function cmdTokens(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error(
      "usage: ft tokens <figma-url> [--with-composition] [--all] [--depth N]"
    );
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(getLoadedConfig(), flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);

  const text = renderTokensList(node, {
    skipNode,
    warnStyleGaps: config.warnStyleGaps,
    includeComposition: config.includeComposition,
  });
  process.stdout.write(text + "\n");
  console.error(
    "\n" +
      c.dim(
        `▸ file=${target.fileKey}${target.nodeId ? " node=" + target.nodeId : ""}`
      )
  );
}

/**
 * Explicit `ft tree <url>` — the compact box-drawing tree (old default).
 * Still respects config filters so the tree shows the same nodes the
 * token dictionary counted.
 */
async function cmdTree(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error("usage: ft tree <figma-url> [--xml] [--layout] [--no-dedupe] [--depth N]");
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(getLoadedConfig(), flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);

  let withTokens: number;
  let total: number;
  let gaps: number;
  if (flags.format === "xml") {
    const result = renderMetadataXml(node, {
      onlyWithTokens: config.onlyWithTokens,
      onlyGaps: flags.onlyGaps,
      layout: flags.layout,
      warnStyleGaps: config.warnStyleGaps,
      includeComposition: config.includeComposition,
      skipNode,
    });
    process.stdout.write(result.xml + "\n");
    withTokens = result.withTokens;
    total = result.total;
    gaps = result.gaps;
  } else {
    const result = renderCompactTree(node, {
      onlyWithTokens: config.onlyWithTokens,
      onlyGaps: flags.onlyGaps,
      layout: flags.layout,
      dedupe: flags.dedupe,
      warnStyleGaps: config.warnStyleGaps,
      includeComposition: config.includeComposition,
      skipNode,
    });
    process.stdout.write(result.text + "\n");
    withTokens = result.withTokens;
    total = result.total;
    gaps = result.gaps;
  }

  const summary =
    `▸ file=${target.fileKey}` +
    (target.nodeId ? ` node=${target.nodeId}` : "") +
    ` coverage=${withTokens}/${total}` +
    (gaps > 0 ? ` untokenized=${gaps}` : "");
  console.error("\n" + c.dim(summary));
}

function cmdConfig(): void {
  const loaded = getLoadedConfig();
  console.log(formatConfig(loaded));
  if (JSON.stringify(loaded.config) === JSON.stringify(DEFAULT_CONFIG)) {
    console.log("\n(all defaults — no overrides applied)");
  }
}

async function cmdNode(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error("usage: ft node <figma-url-with-node-id>");
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const target = resolveTarget(input, flags);
  if (!target.nodeId) {
    throw new Error(
      "`ft node` needs a node id. Use a URL with ?node-id=… or pass --node 1:2.\n" +
        "If your URL had `&node-id=…` and your shell cut it off, wrap the URL in single quotes."
    );
  }
  const client = getClient();
  const doc = await loadNodeWithSpinner(client, target, 1);
  process.stdout.write(renderSingleNodeTokens(doc) + "\n");
}

async function cmdCoverage(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error("usage: ft coverage <figma-url> [--depth N]");
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(getLoadedConfig(), flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);
  const result = renderMetadataXml(node, { onlyWithTokens: false, skipNode });
  const pct = result.total === 0 ? 0 : Math.round((result.withTokens / result.total) * 100);

  if (process.stdout.isTTY) {
    console.log(
      `${progressBar(pct, 20)} ${c.bold(`${result.withTokens} / ${result.total}`)}  ${c.dim(`(${pct}%)`)}`
    );
  } else {
    console.log(
      `${result.withTokens} / ${result.total} nodes have Tokens Studio tokens applied (${pct}%)`
    );
  }
  if (result.withTokens === 0) {
    console.log(
      c.yellow(
        "No Tokens Studio data found in this subtree. Is Tokens Studio installed and applied in this file?"
      )
    );
  }
}


async function cmdSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await revealSplash();
    console.log(c.bold("Set up your Figma access token") + "\n");
    console.log("1. Open this page and create a personal access token:");
    console.log("   " + c.cyan("https://www.figma.com/developers/api#access-tokens"));
    console.log("   " + c.dim("Scope needed: File content — Read-only.") + "\n");

    const existing = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
    if (existing) {
      const keep = await rl.question(
        `A token is already saved (${existing.slice(0, 8)}…). Replace it? [y/N] `
      );
      if (keep.trim().toLowerCase() !== "y") {
        console.log(c.green("✓") + " Keeping the existing token.");
        return;
      }
    }

    const token = (await rl.question("2. Paste your token (figd_…): ")).trim();
    if (!token) {
      console.error(c.red("✗") + " No token entered. Run `ft setup` again when you have one.");
      process.exit(1);
    }
    if (!token.startsWith("figd_")) {
      console.error(
        c.yellow(
          `Heads up: Figma tokens usually start with "figd_". Yours starts with "${token.slice(0, 6)}". Saving anyway.`
        )
      );
    }

    writeFileSync(ENV_PATH, `FIGMA_API_KEY=${token}\n`, { mode: 0o600 });
    console.log("\n" + c.green("✓") + ` Saved to ${c.dim(ENV_PATH)} (chmod 600).`);
    console.log("\n" + c.bold("Try it out:"));
    console.log(`  ${c.green("ft <figma-url>")}         ${c.dim("tree of a frame with applied tokens")}`);
    console.log(`  ${c.green("ft tokens <figma-url>")}  ${c.dim("grouped token list + gap report")}`);
    console.log(`  ${c.green("ft coverage <figma-url>")} ${c.dim("how much of the frame has tokens")}\n`);
    console.log(c.dim("If `ft` isn't on your PATH yet, run:") + "  npm run alias");
  } finally {
    rl.close();
  }
}

async function cmdHelp(): Promise<void> {
  await revealSplash();

  const heading = (title: string) => c.bold(c.brightCyan(title));
  // Colour is added AFTER padEnd so the ANSI codes don't break column alignment.
  const row = (
    key: string,
    description: string,
    keyColor: (s: string) => string,
    width = 24
  ) => `  ${keyColor(key.padEnd(width))}${c.dim(description)}`;
  const cmd = (key: string, description: string) => row(key, description, c.green);
  const flag = (key: string, description: string) => row(key, description, c.yellow);
  const desc = (text: string) => c.dim(text);

  const lines = [
    heading("Quick start"),
    "  1. Copy a Figma frame URL.",
    `  2. Run ${c.green("ft")}.`,
    "",
    heading("Commands"),
    cmd("ft", "read the URL from your clipboard and show a tree"),
    cmd("ft <url>", "show a tree of a Figma frame with applied tokens"),
    cmd("ft tokens <url>", "list every token used, grouped by property"),
    cmd("ft tree <url>", "same as ft <url>"),
    cmd("ft coverage <url>", "show the % of nodes that have tokens applied"),
    cmd("ft node <url>", "show the tokens applied to a single node"),
    cmd("ft config", "show the current config and where it came from"),
    cmd("ft setup", "save your Figma personal access token"),
    cmd("ft help", "show this help"),
    "",
    heading("What to show"),
    flag("-o, --only-with-tokens", "hide branches that have no tokens"),
    flag("    --all-layers", "show every layer, even untokenized ones"),
    flag("-g, --gaps", "hide branches that have no style gaps"),
    flag("    --with-components", "include COMPONENT and COMPONENT_SET nodes"),
    flag("    --with-vectors", "include vector nodes that have no fill"),
    flag("    --with-composition", "show composition tokens (hidden by default)"),
    flag("    --no-warn", "don't flag untokenized visual styling"),
    flag("    --all", "turn off every filter for this run"),
    "",
    heading("How to show it"),
    flag("-d, --depth N", "limit how deep to walk into the tree"),
    flag("-n, --node 1:2", "use this node id instead of the URL's"),
    flag("    --layout", "add [x,y w×h] coordinates to each line"),
    flag("    --xml", "use the legacy XML format instead of the tree"),
    flag("    --no-dedupe", "don't collapse repeated sibling groups"),
    "",
    heading("Config"),
    "  " + desc("Put defaults in ~/.ftrc.json or ./ft.config.json (all keys optional):"),
    "  " + c.dim('{ "ignoreVectorsWithoutFill": true, "ignoreComponents": true,'),
    "  " + c.dim('  "warnStyleGaps": true, "onlyWithTokens": true,'),
    "  " + c.dim('  "includeComposition": false }'),
    "",
    heading("Tips"),
    "  " + desc("Composition tokens are hidden by default because they usually bundle"),
    "  " + desc("other tokens that are already shown on the same node. Pass"),
    "  " + desc("--with-composition to include them."),
    "",
    heading("Quoting URLs (important)"),
    "  " + desc("Figma URLs contain `?` and `&`. Without quoting, the shell mangles them."),
    "  " + desc("The safest options, in order:"),
    "",
    `  ${c.green("1.")} ${desc("Copy the URL, then run")} ${c.green("ft")} ${desc("with no arguments. No quoting needed.")}`,
    `  ${c.green("2.")} ${desc("Wrap the URL in single quotes:")}`,
    `       ${c.green("ft")} ${c.cyan("'https://www.figma.com/design/abc/File?node-id=1-2&t=xyz'")}`,
    `  ${c.green("3.")} ${desc("Pass the node id separately with")} ${c.yellow("-n")}${desc(":")}`,
    `       ${c.green("ft")} ${c.cyan("https://www.figma.com/design/abc/File")} ${c.yellow("-n")} ${c.cyan("1-2")}`,
    "",
    "  " + desc("What breaks without quotes:"),
    `       ${c.red("ft")} ${c.red("https://www.figma.com/design/abc/File?m=auto&node-id=1-2")}`,
    "  " + desc("  zsh treats `&` as job control and `ft` only sees the part before it."),
    "  " + desc("  The `ft` alias uses `noglob`, so bare `?` is fine — `&` still isn't."),
    "",
    heading("Example"),
    `  ${c.green("ft")} ${c.cyan("'https://www.figma.com/design/abc/File?node-id=1-2'")}`,
    `  ${c.green("ft tokens")} ${c.cyan("'https://www.figma.com/design/abc/File?node-id=1-2'")}`,
    "",
  ];

  console.log(lines.join("\n"));
}

/** Read from macOS pbpaste if available. Returns an empty string on any failure. */
function readClipboard(): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("pbpaste", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------
// MCP stdio server
// --------------------------------------------------------------------------

const server = new McpServer({
  name: "tokens-studio-mcp",
  version: "0.2.0",
});

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

server.tool(
  "get_metadata_with_tokens",
  "STEP 2 of the recommended flow (call `list_tokens` first to see which " +
    "tokens exist before fetching the whole tree). Returns a Figma MCP-style " +
    "get_metadata XML tree for a Figma file or node, decorated with Tokens " +
    "Studio applied tokens on every node. Every element gets a <tokens .../> " +
    'child; nodes without applied tokens emit <tokens applied="none"/>. The ' +
    'root element carries a token-coverage="<withTokens>/<total>" attribute. ' +
    "Nodes with visual styling (shared styles, raw fills/strokes/effects) but " +
    'no covering token get an untokenized="fill,stroke,…" attribute on their ' +
    "tokens element. x/y/w/h are omitted by default — pass layout=true if you " +
    "need them. Composition tokens are stripped by default (they duplicate " +
    "individual property tokens); pass includeComposition=true to include them.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    depth: z.number().int().positive().optional(),
    onlyWithTokens: z.boolean().optional(),
    onlyGaps: z.boolean().optional(),
    layout: z.boolean().optional(),
    includeComposition: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTarget(args);
      const client = getClient();
      const node = await loadNode(client, target, args.depth);
      const config = getLoadedConfig().config;
      const skipNode = makeSkipPredicate(config);
      const result = renderMetadataXml(node, {
        onlyWithTokens: args.onlyWithTokens ?? config.onlyWithTokens,
        onlyGaps: args.onlyGaps,
        layout: args.layout,
        warnStyleGaps: config.warnStyleGaps,
        includeComposition:
          args.includeComposition ?? config.includeComposition,
        skipNode,
      });
      return { content: [{ type: "text" as const, text: result.xml }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "get_node_tokens",
  "Return just the Tokens Studio applied tokens for a single Figma node, as a " +
    'tiny XML snippet. Untokenized nodes come back as <tokens applied="none"/>.',
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTarget(args);
      if (!target.nodeId) {
        throw new Error(
          "get_node_tokens needs a node id. Pass nodeId or a URL with ?node-id=…"
        );
      }
      const client = getClient();
      const node = await loadNode(client, target, 1);
      return { content: [{ type: "text" as const, text: renderSingleNodeTokens(node) }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "list_tokens",
  "START HERE for any question about which design tokens a Figma frame uses. " +
    "Cheap pre-flight: returns the unique Tokens Studio tokens applied anywhere " +
    "in a subtree, grouped by property (fill, spacing, typography, …), with the " +
    "layer names that use each value and a style-gap report at the bottom. " +
    "Much smaller than `get_metadata_with_tokens` — call this first to decide " +
    "whether you actually need the full tree. If the subtree relies on " +
    "`composition` tokens the response surfaces a one-line hint so you don't " +
    "get silent empty output; pass includeComposition=true to include them.",
  {
    url: z.string().optional(),
    fileKey: z.string().optional(),
    nodeId: z.string().optional(),
    depth: z.number().int().positive().optional(),
    includeComposition: z.boolean().optional(),
  },
  async (args) => {
    try {
      const target = parseFigmaTarget(args);
      const client = getClient();
      const node = await loadNode(client, target, args.depth);
      const config = getLoadedConfig().config;
      const skipNode = makeSkipPredicate(config);
      const text = renderTokensList(node, {
        skipNode,
        warnStyleGaps: config.warnStyleGaps,
        includeComposition:
          args.includeComposition ?? config.includeComposition,
      });
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

async function runStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  // No args: two very different callers.
  //   - Claude Code: invokes `node dist/index.js` with stdio piped → run MCP server.
  //   - Terminal:    interactive TTY → try the clipboard, else show help.
  if (args.length === 0) {
    if (!process.stdin.isTTY) {
      await runStdioServer();
      return;
    }
    const clipped = readClipboard();
    if (clipped.startsWith("http") && clipped.includes("figma.com")) {
      console.error(
        `${c.green("▸")} ${c.dim("using URL from clipboard:")} ${c.cyan(clipped)}\n`
      );
      await cmdTree([clipped]);
      return;
    }
    await cmdHelp();
    if (clipped) {
      console.error(
        "\n" +
          c.yellow(
            `Clipboard had "${clipped.slice(0, 60)}…" — that doesn't look like a Figma URL.`
          )
      );
    } else {
      console.error(
        "\n" + c.dim("Clipboard is empty. Copy a Figma URL first, or pass one as an argument.")
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
      // Primary usage: `ft <url>` → compact ASCII tree of the subtree with
      // applied tokens on every node. Use `ft tokens <url>` for the
      // grouped-by-property dictionary view.
      if (cmd.startsWith("http") || cmd.startsWith("-")) {
        await cmdTree(args);
        return;
      }
      console.error(c.red(`Unknown command: ${cmd}`) + "\n");
      await cmdHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(c.red("ft:") + " " + message);
  // If the error looks like a bad URL, the most common cause is shell
  // mangling — surface the quoting hint even if our proactive check
  // didn't fire for some reason.
  if (/URL|file key|node id/i.test(message)) {
    console.error(
      c.dim(
        "\nTip: if your URL contains `&`, wrap it in single quotes:\n" +
          "     ft 'https://www.figma.com/design/…?node-id=1-2&t=…'\n" +
          "Or copy it to the clipboard and run `ft` with no arguments."
      )
    );
  }
  process.exit(1);
});
