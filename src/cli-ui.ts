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
// Splash — ANSI Shadow "FT" block letters with a gradient + tagline.
// --------------------------------------------------------------------------

interface SplashRow {
  block: string;
  tag: string;
}

const SPLASH_ROWS: SplashRow[] = [
  { block: "  ███████╗ ████████╗", tag: "" },
  { block: "  ██╔════╝ ╚══██╔══╝", tag: "   ft — design tokens from Figma" },
  { block: "  █████╗      ██║   ", tag: "" },
  { block: "  ██╔══╝      ██║   ", tag: "   pulls Tokens Studio tokens out of" },
  { block: "  ██║         ██║   ", tag: "   any Figma frame so your code can" },
  { block: "  ╚═╝         ╚═╝   ", tag: "   reference the real design tokens." },
];

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
  const rows = SPLASH_ROWS.map((r, i) => paintRow(r, i));
  return ["", ...rows, ""].join("\n");
}

/**
 * Row-by-row reveal of the splash with a small per-line delay. Falls back
 * to an instant print when stdout isn't a TTY so non-interactive callers
 * (scripts, MCP) don't pay the latency or get garbled cursor moves.
 */
export async function revealSplash(): Promise<void> {
  if (!STDOUT_TTY) {
    process.stdout.write(splash() + "\n");
    return;
  }
  process.stdout.write("\n");
  for (let i = 0; i < SPLASH_ROWS.length; i++) {
    process.stdout.write(paintRow(SPLASH_ROWS[i], i) + "\n");
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
