/**
 * CLI command implementations for the `ft` tool. Each public function
 * corresponds to a subcommand (tree, tokens, node, coverage, config,
 * setup, help). Flag parsing and config merging live here too.
 *
 * Separated from the MCP server so CLI-only concerns (readline, splash,
 * process.exit) don't leak into the tool layer.
 */

import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { renderMetadataXml, renderSingleNodeTokens } from "./xml.js";
import { renderCompactTree, renderTokensList } from "./render-tree.js";
import { makeSkipPredicate } from "./tokens.js";
import {
  buildCoverageJson,
  buildNodeJson,
  buildTokensJson,
  buildTreeJson,
} from "./json-output.js";
import {
  DEFAULT_CONFIG,
  formatConfig,
  unfilteredConfig,
  type FtConfig,
} from "./config.js";
import { c, coverageBar, hr, kv, revealSplash } from "./cli-ui.js";
import {
  getClient,
  loadNodeWithSpinner,
  targetFromInput,
  getLoadedConfig,
} from "./figma-helpers.js";

// --------------------------------------------------------------------------
// .env path (for setup command)
// --------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, "..");
const ENV_PATH = resolve(PROJECT_ROOT, ".env");

// --------------------------------------------------------------------------
// CLI flag parsing
// --------------------------------------------------------------------------

export interface CliFlags {
  onlyWithTokens: boolean | "unset";
  onlyGaps: boolean;
  layout: boolean;
  dedupe: boolean;
  format: "tree" | "xml";
  json: boolean;
  depth?: number;
  nodeOverride?: string;
  all: boolean;
  withComponents: boolean;
  withVectors: boolean;
  withComposition: boolean;
  noWarn: boolean;
}

const KNOWN_FLAGS = [
  "--only-with-tokens", "-o",
  "--all-layers",
  "--gaps", "-g",
  "--layout",
  "--xml",
  "--json",
  "--no-dedupe",
  "--all",
  "--with-components",
  "--with-vectors",
  "--with-composition",
  "--no-warn",
  "--depth", "-d",
  "--node", "-n",
];

/**
 * Suggest the closest known flag when the user types something unknown.
 * Uses Levenshtein distance — returns null if no flag is close enough.
 */
function suggestFlag(unknown: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const flag of KNOWN_FLAGS) {
    const d = levenshtein(unknown, flag);
    if (d < bestDist) {
      bestDist = d;
      best = flag;
    }
  }
  return bestDist <= 3 ? best : null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export function parseFlags(args: string[]): { input?: string; flags: CliFlags } {
  const flags: CliFlags = {
    onlyWithTokens: "unset",
    onlyGaps: false,
    layout: false,
    dedupe: true,
    format: "tree",
    json: false,
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
    else if (a === "--json") flags.json = true;
    else if (a === "--no-dedupe") flags.dedupe = false;
    else if (a === "--all") flags.all = true;
    else if (a === "--with-components") flags.withComponents = true;
    else if (a === "--with-vectors") flags.withVectors = true;
    else if (a === "--with-composition") flags.withComposition = true;
    else if (a === "--no-warn") flags.noWarn = true;
    else if (a === "--depth" || a === "-d") {
      const n = Number(args[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--depth expects a non-negative number, got "${args[i]}"`);
      }
      flags.depth = n;
    } else if (a === "--node" || a === "-n") flags.nodeOverride = args[++i];
    else if (a.startsWith("-")) {
      const suggestion = suggestFlag(a);
      const hint = suggestion ? ` Did you mean ${suggestion}?` : "";
      throw new Error(`Unknown flag: ${a}.${hint}`);
    }
    else if (!input) input = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return { input, flags };
}

export function effectiveConfig(flags: CliFlags): FtConfig {
  const loaded = getLoadedConfig();
  if (flags.all) return unfilteredConfig();
  const out: FtConfig = { ...loaded.config };
  if (flags.withComponents) out.ignoreComponents = false;
  if (flags.withVectors) out.ignoreVectorsWithoutFill = false;
  if (flags.withComposition) out.includeComposition = true;
  if (flags.noWarn) out.warnStyleGaps = false;
  if (flags.onlyWithTokens === true) out.onlyWithTokens = true;
  else if (flags.onlyWithTokens === false) out.onlyWithTokens = false;
  return out;
}

export function resolveTarget(input: string, flags: CliFlags) {
  const base = targetFromInput(input);
  return flags.nodeOverride
    ? { ...base, nodeId: flags.nodeOverride.replaceAll("-", ":") }
    : base;
}

/**
 * Detect the classic "zsh ate my URL" pattern and print a friendly hint.
 */
function maybeWarnAboutShellSplit(input: string | undefined): void {
  if (!input || !input.startsWith("http")) return;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return;
  }
  if (!url.hostname.includes("figma.com")) return;
  if (url.searchParams.has("node-id")) return;
  const paramCount = Array.from(url.searchParams.keys()).length;
  if (paramCount === 0) return;

  process.stderr.write(
    "\n" +
      c.yellow("Warning: this URL has query params but no `node-id`.") +
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

// --------------------------------------------------------------------------
// Summary footer
// --------------------------------------------------------------------------

function printSummary(
  jsonMode: boolean,
  target: { fileKey: string; nodeId?: string },
  extras: Array<[string, string | number | undefined]> = []
): void {
  if (jsonMode) return;
  process.stderr.write("\n" + hr() + "\n");
  const pairs: Array<[string, string | number | undefined]> = [
    ["file", target.fileKey],
    ["node", target.nodeId],
    ...extras,
  ];
  process.stderr.write(kv(pairs) + "\n");
}

// --------------------------------------------------------------------------
// Subcommands
// --------------------------------------------------------------------------

export async function cmdTokens(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error(
      "usage: ft tokens <figma-url> [--json] [--with-composition] [--all] [--depth N]"
    );
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);

  if (flags.json) {
    const json = buildTokensJson(node, {
      skipNode,
      warnStyleGaps: config.warnStyleGaps,
      includeComposition: config.includeComposition,
    });
    process.stdout.write(JSON.stringify(json, null, 2) + "\n");
    return;
  }

  const text = renderTokensList(node, {
    skipNode,
    warnStyleGaps: config.warnStyleGaps,
    includeComposition: config.includeComposition,
  });
  process.stdout.write(text + "\n");
  printSummary(false, target);
}

export async function cmdTree(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error(
      "usage: ft tree <figma-url> [--xml] [--json] [--layout] [--no-dedupe] [--depth N]"
    );
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);

  if (flags.json) {
    const json = buildTreeJson(node, {
      onlyWithTokens: config.onlyWithTokens,
      onlyGaps: flags.onlyGaps,
      layout: flags.layout,
      warnStyleGaps: config.warnStyleGaps,
      includeComposition: config.includeComposition,
      skipNode,
    });
    process.stdout.write(JSON.stringify(json, null, 2) + "\n");
    return;
  }

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

  printSummary(false, target, [
    ["coverage", `${withTokens}/${total}`],
    ["untokenized", gaps > 0 ? gaps : undefined],
  ]);
}

export function cmdConfig(): void {
  const loaded = getLoadedConfig();
  console.log(formatConfig(loaded));
  if (JSON.stringify(loaded.config) === JSON.stringify(DEFAULT_CONFIG)) {
    console.log("\n(all defaults — no overrides applied)");
  }
}

export async function cmdNode(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error("usage: ft node <figma-url-with-node-id> [--json]");
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(flags);
  const target = resolveTarget(input, flags);
  if (!target.nodeId) {
    throw new Error(
      "`ft node` needs a node id. Use a URL with ?node-id=… or pass --node 1:2.\n" +
        "If your URL had `&node-id=…` and your shell cut it off, wrap the URL in single quotes."
    );
  }
  const client = getClient();
  const doc = await loadNodeWithSpinner(client, target, 1);
  if (flags.json) {
    const json = buildNodeJson(doc, {
      includeComposition: config.includeComposition,
    });
    process.stdout.write(JSON.stringify(json, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderSingleNodeTokens(doc) + "\n");
}

export async function cmdCoverage(args: string[]): Promise<void> {
  const { input, flags } = parseFlags(args);
  if (!input) {
    console.error("usage: ft coverage <figma-url> [--json] [--depth N]");
    process.exit(1);
  }
  maybeWarnAboutShellSplit(input);
  const config = effectiveConfig(flags);
  const target = resolveTarget(input, flags);
  const client = getClient();
  const node = await loadNodeWithSpinner(client, target, flags.depth);
  const skipNode = makeSkipPredicate(config);
  const result = renderMetadataXml(node, { onlyWithTokens: false, skipNode });
  const pct =
    result.total === 0 ? 0 : Math.round((result.withTokens / result.total) * 100);

  if (flags.json) {
    process.stdout.write(
      JSON.stringify(buildCoverageJson(result.withTokens, result.total), null, 2) +
        "\n"
    );
    return;
  }

  if (process.stdout.isTTY) {
    console.log(
      `${coverageBar(pct, 24)} ${c.bold(`${result.withTokens} / ${result.total}`)}  ${c.dim(`(${pct}%)`)}`
    );
  } else {
    console.log(
      `${result.withTokens} / ${result.total} nodes have Tokens Studio tokens applied (${pct}%)`
    );
  }
  if (result.withTokens === 0) {
    console.log(
      c.yellow(
        "Zero tokens applied. Either this frame is tokenless, or Tokens Studio hasn't touched it yet."
      )
    );
  } else if (result.withTokens === result.total && result.total > 0) {
    console.log(
      c.green("Every node tokenized. Nothing to report, which is the best report.")
    );
  }
}

export async function cmdSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const stage = (n: number, total: number) =>
    c.dim(`[${n}/${total}]`) + " ";
  try {
    await revealSplash();
    console.log(c.bold("Let's get you a Figma token.") + "\n");

    const existing = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
    if (existing) {
      const keep = await rl.question(
        `You already have a token on file (${existing.slice(0, 8)}…). Replace it? [y/N] `
      );
      if (keep.trim().toLowerCase() !== "y") {
        console.log(
          c.green("✓") + " Keeping the one you have. Nothing changed."
        );
        return;
      }
    }

    console.log(stage(1, 3) + "Open this page and create a personal access token:");
    console.log(
      "      " + c.cyan("https://www.figma.com/developers/api#access-tokens")
    );
    console.log("      " + c.dim("Scope: File content — Read-only.") + "\n");

    const token = (
      await rl.question(stage(2, 3) + "Paste your token (figd_…): ")
    ).trim();
    if (!token) {
      console.error(
        c.red("✗") +
          " No token entered. Run `ft setup` again when you have one."
      );
      process.exit(1);
    }
    if (!token.startsWith("figd_")) {
      console.error(
        c.yellow(
          `  Heads up: Figma tokens usually start with "figd_". ` +
            `Saving anyway — if it's wrong, ft will tell you on the first request.`
        )
      );
    }

    writeFileSync(ENV_PATH, `FIGMA_API_KEY=${token}\n`, { mode: 0o600 });
    console.log(
      "\n" +
        stage(3, 3) +
        c.green("✓") +
        ` Saved to ${c.dim(ENV_PATH)} ${c.dim("(chmod 600)")}.`
    );
    console.log("\n" + c.bold("Try it:"));
    console.log(
      `  ${c.green("ft <figma-url>")}          ${c.dim("tree of a frame with applied tokens")}`
    );
    console.log(
      `  ${c.green("ft tokens <figma-url>")}   ${c.dim("grouped token list + gap report")}`
    );
    console.log(
      `  ${c.green("ft coverage <figma-url>")} ${c.dim("how much of the frame has tokens")}\n`
    );
    console.log(
      c.dim("If `ft` isn't on your PATH yet, run:") + "  " + c.green("npm run alias")
    );
  } finally {
    rl.close();
  }
}

export async function cmdHelp(): Promise<void> {
  await revealSplash();

  const heading = (title: string) => c.bold(c.brightCyan(title));
  const row = (
    key: string,
    description: string,
    keyColor: (s: string) => string,
    padTo = 30
  ) => `  ${keyColor(key.padEnd(padTo))} ${c.dim(description)}`;

  const lines = [
    heading("Commands"),
    row("ft <url>", "compact ASCII tree (default)", c.green),
    row("ft tree <url>", "same — explicit alias", c.green),
    row("ft tokens <url>", "grouped token dictionary + gap report", c.green),
    row("ft node <url>", "single node's applied tokens (XML)", c.green),
    row("ft coverage <url>", "% of nodes with tokens applied", c.green),
    row("ft config", "show effective config + sources", c.green),
    row("ft setup", "store a Figma personal access token", c.green),
    row("ft mcp", "start the MCP stdio server", c.green),
    "",
    heading("Flags"),
    row("-o, --only-with-tokens", "keep only tokenized branches", c.cyan),
    row("    --all-layers", "show every layer (override config)", c.cyan),
    row("-g, --gaps", "keep only branches with style gaps", c.cyan),
    row("    --layout", "add [x,y w×h] after node ids", c.cyan),
    row("    --xml", "output Figma-MCP-style XML", c.cyan),
    row("    --json", "output structured JSON", c.cyan),
    row("    --no-dedupe", "don't collapse identical siblings", c.cyan),
    row("    --all", "bypass all config filters", c.cyan),
    row("    --with-components", "include component definitions", c.cyan),
    row("    --with-vectors", "include empty vector primitives", c.cyan),
    row("    --with-composition", "include composition tokens", c.cyan),
    row("    --no-warn", "suppress untokenized warnings", c.cyan),
    row("-d, --depth N", "limit tree depth", c.cyan),
    row("-n, --node 1:2", "override node id", c.cyan),
    "",
    heading("Quoting"),
    "",
    "  " + c.dim("What breaks without quotes:"),
    `       ${c.red("ft")} ${c.red("https://www.figma.com/design/abc/File?m=auto&node-id=1-2")}`,
    "  " + c.dim("  zsh treats `&` as job control and `ft` only sees the part before it."),
    "  " + c.dim("  The `ft` alias uses `noglob`, so bare `?` is fine — `&` still isn't."),
    "",
    heading("Example"),
    `  ${c.green("ft")} ${c.cyan("'https://www.figma.com/design/abc/File?node-id=1-2'")}`,
    `  ${c.green("ft tokens")} ${c.cyan("'https://www.figma.com/design/abc/File?node-id=1-2'")}`,
    "",
  ];

  console.log(lines.join("\n"));
}

/**
 * Short command list for unknown command errors — avoids flooding the
 * terminal with the full help text when the user just mistyped.
 */
export function printCommandList(): void {
  const commands = [
    "ft <url>",
    "ft tree <url>",
    "ft tokens <url>",
    "ft node <url>",
    "ft coverage <url>",
    "ft config",
    "ft setup",
    "ft mcp",
    "ft help",
  ];
  console.error(c.dim("Available commands:"));
  for (const cmd of commands) {
    console.error(`  ${c.green(cmd)}`);
  }
  console.error(c.dim("\nRun `ft help` for full details."));
}
