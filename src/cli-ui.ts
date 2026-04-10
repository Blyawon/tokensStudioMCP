// Terminal UI helpers — colors, spinners, animated splash, progress bar.
//
// Every effect is TTY-gated: piped stdout (shell redirects, MCP stdio,
// scripts) gets plain ASCII. The moment a human terminal is on the other
// end, we light it up.

import { clearLine, cursorTo } from "node:readline";

const STDERR_TTY = process.stderr.isTTY === true;
const STDOUT_TTY = process.stdout.isTTY === true;
const ANY_TTY = STDERR_TTY || STDOUT_TTY;

/**
 * Wrap a string in an ANSI SGR sequence. Returns a no-op wrapper when
 * neither stderr nor stdout is a TTY, so piped output stays free of
 * escape codes (scripts, MCP hosts, grep, CI logs — all happy).
 */
function sgr(code: string): (s: string) => string {
  if (!ANY_TTY) return (s) => s;
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

export const c = {
  bold: sgr("1"),
  dim: sgr("2"),
  italic: sgr("3"),
  underline: sgr("4"),
  red: sgr("31"),
  green: sgr("32"),
  yellow: sgr("33"),
  blue: sgr("34"),
  magenta: sgr("35"),
  cyan: sgr("36"),
  gray: sgr("90"),
  brightRed: sgr("91"),
  brightGreen: sgr("92"),
  brightYellow: sgr("93"),
  brightBlue: sgr("94"),
  brightMagenta: sgr("95"),
  brightCyan: sgr("96"),
};

// --------------------------------------------------------------------------
// Spinner — Braille-based, TTY-only, writes to stderr so piped stdout is
// untouched.
// --------------------------------------------------------------------------

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Change the label mid-flight (e.g. "fetching" → "rendering"). */
  update(label: string): void;
  /** Stop the animation and clear the line. */
  stop(): void;
  /** Stop + print a green ✓ line. */
  succeed(label?: string): void;
  /** Stop + print a red ✗ line. */
  fail(label?: string): void;
}

/**
 * Start a Braille spinner pinned to the current stderr line. In non-TTY
 * mode (pipes, CI, MCP stdio) the spinner degrades to plain `▸ label`
 * lines so progress is still visible in logs.
 */
export function spinner(initialLabel: string): Spinner {
  if (!STDERR_TTY) {
    process.stderr.write(`▸ ${initialLabel}\n`);
    return {
      update(label) {
        process.stderr.write(`▸ ${label}\n`);
      },
      stop() {
        /* nothing to clear */
      },
      succeed(label) {
        if (label) process.stderr.write(`✓ ${label}\n`);
      },
      fail(label) {
        if (label) process.stderr.write(`✗ ${label}\n`);
      },
    };
  }

  let label = initialLabel;
  let idx = 0;
  const render = () => {
    const frame = c.cyan(SPINNER_FRAMES[idx % SPINNER_FRAMES.length]);
    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
    process.stderr.write(`${frame}  ${c.dim(label)}`);
    idx++;
  };
  render();
  const interval = setInterval(render, 80);

  const clear = () => {
    clearInterval(interval);
    clearLine(process.stderr, 0);
    cursorTo(process.stderr, 0);
  };

  return {
    update(next) {
      label = next;
    },
    stop: clear,
    succeed(next) {
      clear();
      process.stderr.write(`${c.green("✓")}  ${c.dim(next ?? label)}\n`);
    },
    fail(next) {
      clear();
      process.stderr.write(`${c.red("✗")}  ${next ?? label}\n`);
    },
  };
}

/**
 * Run an async task with a spinner pinned to stderr. Auto-stops on
 * success and converts throws to a red `✗` line before re-raising.
 */
export async function withSpinner<T>(
  label: string,
  fn: (sp: Spinner) => Promise<T>
): Promise<T> {
  const sp = spinner(label);
  try {
    const result = await fn(sp);
    sp.stop();
    return result;
  } catch (err) {
    sp.fail();
    throw err;
  }
}

// --------------------------------------------------------------------------
// Splash — ANSI Shadow "FT" block letters with a gradient + rotating tagline.
// --------------------------------------------------------------------------

interface SplashRow {
  block: string;
  tag: string;
}

/**
 * Three-line tagline sets. One is picked at random per splash so the
 * intro has a bit of personality without any single line wearing out its
 * welcome. Every set fits the same box to the right of the "FT" block.
 */
const TAGLINE_SETS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "pulls Tokens Studio tokens out of",
    "any Figma frame so your code can",
    "reference the real design tokens.",
  ],
  [
    "reads the plugin data Dev Mode",
    "forgets to surface, so your agent",
    "writes code with real tokens.",
  ],
  [
    "one REST call, every applied token,",
    "grouped by property, no guessing,",
    "no Figma desktop app required.",
  ],
  [
    "the tokens were in the plugin data",
    "the whole time. somebody had to",
    "go in there and get them.",
  ],
];

function makeSplashRows(): SplashRow[] {
  const [t1, t2, t3] =
    TAGLINE_SETS[Math.floor(Math.random() * TAGLINE_SETS.length)];
  return [
    { block: "  ███████╗ ████████╗", tag: "" },
    { block: "  ██╔════╝ ╚══██╔══╝", tag: "   ft — design tokens from Figma" },
    { block: "  █████╗      ██║   ", tag: "" },
    { block: "  ██╔══╝      ██║   ", tag: `   ${t1}` },
    { block: "  ██║         ██║   ", tag: `   ${t2}` },
    { block: "  ╚═╝         ╚═╝   ", tag: `   ${t3}` },
  ];
}

// Top-to-bottom gradient: bright cyan → cyan → magenta. Keeps the letters
// readable on both light and dark terminals and gives the intro a bit of
// personality without getting obnoxious.
const GRADIENT = [
  c.brightCyan,
  c.brightCyan,
  c.cyan,
  c.cyan,
  c.brightMagenta,
  c.brightMagenta,
];

function paintRow(row: SplashRow, i: number): string {
  const paint = GRADIENT[i] ?? c.cyan;
  return paint(row.block) + c.dim(row.tag);
}

/** Static splash — used when we can't animate (piped or non-TTY). */
export function splash(): string {
  const rows = makeSplashRows().map((r, i) => paintRow(r, i));
  return ["", ...rows, ""].join("\n");
}

/**
 * Row-by-row reveal of the splash with a small per-line delay. Falls back
 * to an instant print when stdout isn't a TTY so non-interactive callers
 * (scripts, MCP) don't pay the latency or get garbled cursor moves.
 */
export async function revealSplash(): Promise<void> {
  const rows = makeSplashRows();
  if (!STDOUT_TTY) {
    const painted = rows.map((r, i) => paintRow(r, i));
    process.stdout.write(["", ...painted, ""].join("\n") + "\n");
    return;
  }
  process.stdout.write("\n");
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(paintRow(rows[i], i) + "\n");
    await sleep(35);
  }
  process.stdout.write("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------------
// Progress bar — green for filled, gray for empty.
// --------------------------------------------------------------------------

/**
 * `[██████░░░░]` style progress bar. Uses Unicode full-block and
 * light-shade characters, coloured green/gray on TTYs and plain ASCII
 * characters everywhere else.
 */
export function progressBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = c.green("█".repeat(filled)) + c.gray("░".repeat(empty));
  return `[${bar}]`;
}

/**
 * Coverage bar with a percentage-driven colour ramp and sub-block
 * smoothing. Red below 30%, yellow in the mid range, green from 60% on,
 * bright green when you've hit the rare 85%+ mark. Uses the
 * `▏▎▍▌▋▊▉` partial-block glyphs so a 47% bar actually looks 47% full
 * instead of snapping to the nearest whole cell.
 */
export function coverageBar(percent: number, width: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const exact = (clamped / 100) * width;
  const fullBlocks = Math.floor(exact);
  const remainder = exact - fullBlocks;
  // 8 partial-block glyphs from empty (index 0) to nearly full (index 7).
  const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const partialIdx = Math.min(7, Math.max(0, Math.floor(remainder * 8)));
  const partialChar = PARTIALS[partialIdx];
  const partialWidth = partialChar ? 1 : 0;
  const emptyWidth = Math.max(0, width - fullBlocks - partialWidth);

  const tint =
    clamped < 30
      ? c.red
      : clamped < 60
        ? c.yellow
        : clamped < 85
          ? c.green
          : c.brightGreen;

  const filledStr = "█".repeat(fullBlocks) + partialChar;
  const emptyStr = "░".repeat(emptyWidth);
  return `[${tint(filledStr)}${c.gray(emptyStr)}]`;
}

// --------------------------------------------------------------------------
// Rules and summary cards
// --------------------------------------------------------------------------

/**
 * Dim horizontal rule for section dividers. Defaults to a 56-wide thin
 * line because that fits inside a standard 60-column summary card
 * without hugging the right margin.
 */
export function hr(width = 56, char = "─"): string {
  return c.dim(char.repeat(width));
}

/**
 * Key/value pair formatted for summary footers: `dim(key)=value` pairs
 * separated by two spaces. Omits pairs with `undefined` values so the
 * call site can build conditional summaries without an `if` ladder.
 */
export function kv(pairs: Array<[string, string | number | undefined]>): string {
  return pairs
    .filter((p): p is [string, string | number] => p[1] !== undefined)
    .map(([k, v]) => `${c.dim(k)}=${v}`)
    .join("  ");
}
