import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * User-tunable defaults for `ft`. Loaded from (in merge order, later wins):
 *
 *   1. built-in DEFAULT_CONFIG
 *   2. ~/.ftrc.json                       (user-level)
 *   3. ./ft.config.json or ./.ftrc.json   (project-level, first found wins)
 *
 * Any CLI flag still overrides whatever the merged config says — config is
 * for defaults, flags are for overrides.
 */
export interface FtConfig {
  /**
   * Skip VECTOR/LINE/ELLIPSE/POLYGON/STAR/BOOLEAN_OPERATION nodes whose
   * `fills` array is empty or contains only invisible paints. These are
   * typically icon geometry primitives that don't need design tokens.
   */
  ignoreVectorsWithoutFill: boolean;

  /**
   * Skip COMPONENT and COMPONENT_SET subtrees entirely. Hides the component
   * library (the stuff living on "/Components" pages) so the output shows
   * only the consuming layouts — FRAMEs, INSTANCEs, GROUPs, TEXTs.
   */
  ignoreComponents: boolean;

  /**
   * Render the ⚠ untokenized=… marker on nodes that have visual styling
   * but no covering Tokens Studio token, and append a gap-report section
   * at the bottom of `ft tokens` output.
   */
  warnStyleGaps: boolean;

  /**
   * Hide branches with no applied tokens anywhere in them. Keeps the
   * output focused on what's actually tokenized instead of the entire
   * Figma layer hierarchy.
   */
  onlyWithTokens: boolean;

  /**
   * Include `composition` tokens in the output. Off by default because
   * most files use composition tokens as aliases for individual
   * fill/spacing/border tokens that also appear on the same node — showing
   * both doubles the output for no extra signal. Flip this on for files
   * where composition is the primary (or only) carrier of design intent;
   * `ft tokens` will auto-hint when it detects composition-only content.
   */
  includeComposition: boolean;
}

export const DEFAULT_CONFIG: FtConfig = {
  ignoreVectorsWithoutFill: true,
  ignoreComponents: true,
  warnStyleGaps: true,
  onlyWithTokens: true,
  includeComposition: false,
};

export interface LoadedConfig {
  config: FtConfig;
  /** Files that contributed to the merged config, in precedence order. */
  sources: string[];
}

const USER_CONFIG = ".ftrc.json";
const PROJECT_CONFIGS = ["ft.config.json", ".ftrc.json"];

export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const sources: string[] = [];
  let merged: FtConfig = { ...DEFAULT_CONFIG };

  // 1) User-level.
  const userPath = resolve(homedir(), USER_CONFIG);
  const userParsed = tryReadJson(userPath);
  if (userParsed) {
    merged = mergeConfig(merged, userParsed, userPath);
    sources.push(userPath);
  }

  // 2) Project-level. First-found wins (won't load both).
  for (const fn of PROJECT_CONFIGS) {
    const p = resolve(cwd, fn);
    const parsed = tryReadJson(p);
    if (parsed) {
      merged = mergeConfig(merged, parsed, p);
      sources.push(p);
      break;
    }
  }

  return { config: merged, sources };
}

/**
 * Returns an FtConfig with every filter disabled — used by `--all` so the
 * user can ask for "show everything, ignore my defaults" in one flag.
 */
export function unfilteredConfig(): FtConfig {
  return {
    ignoreVectorsWithoutFill: false,
    ignoreComponents: false,
    warnStyleGaps: false,
    onlyWithTokens: false,
    // `--all` means "show me everything" so composition tokens come along.
    includeComposition: true,
  };
}

function tryReadJson(path: string): Partial<FtConfig> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Partial<FtConfig>;
  } catch (err) {
    // Bad JSON or unreadable file — warn on stderr and keep going.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ft: could not parse config file ${path}: ${msg}\n`);
    return null;
  }
}

const KNOWN_KEYS = new Set<string>([
  "ignoreVectorsWithoutFill",
  "ignoreComponents",
  "warnStyleGaps",
  "onlyWithTokens",
  "includeComposition",
]);

function mergeConfig(base: FtConfig, override: Partial<FtConfig>, source?: string): FtConfig {
  const out: FtConfig = { ...base };
  for (const key of Object.keys(override)) {
    if (!KNOWN_KEYS.has(key)) {
      const label = source ? ` (${source})` : "";
      process.stderr.write(
        `ft: unknown config key "${key}"${label} — ` +
          `known keys: ${Array.from(KNOWN_KEYS).join(", ")}\n`
      );
      continue;
    }
    const value = override[key as keyof FtConfig];
    if (typeof value === "boolean") {
      (out[key as keyof FtConfig] as boolean) = value;
    }
  }
  return out;
}

/**
 * Human-readable dump of a config + its sources, for `ft config`.
 */
export function formatConfig(loaded: LoadedConfig): string {
  const lines: string[] = [];
  lines.push("Effective ft config:");
  lines.push("");
  for (const key of Object.keys(loaded.config) as (keyof FtConfig)[]) {
    lines.push(`  ${key.padEnd(28)} ${loaded.config[key]}`);
  }
  lines.push("");
  if (loaded.sources.length === 0) {
    lines.push("Sources: (built-in defaults only — no config files found)");
    lines.push("");
    lines.push("Create one to customize:");
    lines.push(`  ~/.ftrc.json             (user-level)`);
    lines.push(`  ./ft.config.json         (project-level, takes precedence)`);
  } else {
    lines.push("Sources (later overrides earlier):");
    for (const s of loaded.sources) lines.push(`  ${s}`);
  }
  return lines.join("\n");
}
