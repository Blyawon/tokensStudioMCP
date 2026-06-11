/// <reference types="@figma/plugin-typings" />

/**
 * Color parsing and paint caching. Supports #RGB, #RRGGBB, #RRGGBBAA,
 * rgb(), rgba(), hsl(), hsla(). All outputs normalize to 0–1 component
 * range (Figma's internal format).
 */

// ---------------------------------------------------------------------------
// Paint cache — same color across many nodes reuses one Paint array.
// Cleared at the start of each opApplyVisualWrites batch.
// ---------------------------------------------------------------------------

const paintCache = new Map<string, Paint[]>();

import { parseGradient } from "./gradient.js";

export function colorToPaints(value: string): Paint[] {
  const cached = paintCache.get(value);
  if (cached) return cached;
  // Gradient check first — `parseColor` would reject gradient strings.
  // `parseGradient` returns null for non-gradients, so non-gradient inputs
  // fall through to the solid-color path unchanged.
  const gradient = parseGradient(value);
  if (gradient) {
    const paints: Paint[] = [gradient];
    paintCache.set(value, paints);
    return paints;
  }
  const { r, g, b, a } = parseColor(value);
  const paints: Paint[] = [{ type: "SOLID", color: { r, g, b }, opacity: a }];
  paintCache.set(value, paints);
  return paints;
}

export function clearPaintCache(): void {
  paintCache.clear();
}

// ---------------------------------------------------------------------------
// Color parsing
// ---------------------------------------------------------------------------

// Minimal CSS named-color table. Covers the common design-token vocabulary
// (transparent + black/white + primary color keywords) without shipping the
// full 140-entry CSS list. Extend as needed.
const NAMED_COLORS: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  yellow: "#ffff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  gray: "#808080",
  grey: "#808080",
  silver: "#c0c0c0",
  orange: "#ffa500",
  purple: "#800080",
  pink: "#ffc0cb",
  brown: "#a52a2a",
};

export function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const s = input.trim();
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return parseColor(named);
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { r: r / 255, g: g / 255, b: b / 255, a: 1 };
    }
    if (hex.length === 6) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: 1,
      };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16) / 255,
        g: parseInt(hex.slice(2, 4), 16) / 255,
        b: parseInt(hex.slice(4, 6), 16) / 255,
        a: parseInt(hex.slice(6, 8), 16) / 255,
      };
    }
    throw new Error(`Expected a hex colour like #RRGGBB or #RRGGBBAA. Got: ${input}`);
  }
  const rgbMatch = s.match(/^rgba?\s*\(\s*([^)]+)\)\s*$/i);
  if (rgbMatch) {
    // Support comma-separated (rgb(255, 0, 0)) and modern space-separated
    // with slash alpha (rgb(255 0 0 / 0.5)) via a unified split.
    const parts = rgbMatch[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    if (parts.length < 3) throw new Error(`Expected rgb(r, g, b) or rgba(r, g, b, a). Got: ${input}`);
    const r = Number(parts[0]) / 255;
    const g = Number(parts[1]) / 255;
    const b = Number(parts[2]) / 255;
    const a = parts.length >= 4 ? parsePctOr01(parts[3]) : 1;
    return { r, g, b, a };
  }
  const hslMatch = s.match(/^hsla?\s*\(\s*([^)]+)\)\s*$/i);
  if (hslMatch) {
    const parts = hslMatch[1].split(/[\s,/]+/).filter((p) => p.length > 0);
    if (parts.length < 3) throw new Error(`Expected hsl(h, s%, l%) or hsla(h, s%, l%, a). Got: ${input}`);
    const h = Number(parts[0].replace(/deg$/i, ""));
    const sat = parsePct(parts[1]);
    const lit = parsePct(parts[2]);
    const a = parts.length >= 4 ? parsePctOr01(parts[3]) : 1;
    if (![h, sat, lit, a].every(Number.isFinite)) throw new Error(`Couldn't parse the hsl components in: ${input}. Expected numbers (e.g. hsl(210, 50%, 40%)).`);
    const { r, g, b } = hslToRgb(h, sat, lit);
    return { r, g, b, a };
  }
  throw new Error(`Unsupported colour format. Supported: hex (#RRGGBB / #RRGGBBAA), rgb/rgba, hsl/hsla. Got: ${input}`);
}

function parsePct(token: string): number {
  if (token.endsWith("%")) return Number(token.slice(0, -1)) / 100;
  return Number(token);
}

function parsePctOr01(token: string): number {
  if (token.endsWith("%")) return Number(token.slice(0, -1)) / 100;
  return Number(token);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = (((h % 360) + 360) % 360) / 360;
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: hue2rgb(p, q, hue + 1 / 3),
    g: hue2rgb(p, q, hue),
    b: hue2rgb(p, q, hue - 1 / 3),
  };
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

// ---------------------------------------------------------------------------
// Shared numeric helpers
// ---------------------------------------------------------------------------

/**
 * Default baseline for `rem` / `em` → px conversion. Matches browsers'
 * 16px default. Overridable via the optional second arg.
 */
const BASE_FONT_SIZE = 16;

export function numericValue(value: string | number, baseFontSize: number = BASE_FONT_SIZE): number {
  if (typeof value === "number") return value;
  const s = String(value).trim();
  // Rem / em → px using the supplied base. Matches Tokens Studio's
  // `transformValue` behaviour for size-like properties.
  const remMatch = s.match(/^(-?\d+(?:\.\d+)?)(rem|em)$/i);
  if (remMatch) {
    const n = Number(remMatch[1]);
    if (!Number.isFinite(n)) throw new Error(`Expected a numeric value (optionally with px/rem/em), got: ${value}`);
    return n * baseFontSize;
  }
  const cleaned = s.replace(/px$/i, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) throw new Error(`Expected a numeric value (optionally with px/rem/em), got: ${value}`);
  return n;
}

export function numericOrUndefined(v: unknown): number | undefined {
  if (v == null) return undefined;
  const n = numericValue(v as string | number);
  return Number.isFinite(n) ? n : undefined;
}

export function clampOpacity(n: number): number {
  if (n > 1) return Math.min(1, n / 100);
  return Math.max(0, Math.min(1, n));
}

export function readFirstSolidColor(paints: unknown): string | undefined {
  if (!Array.isArray(paints) || paints.length === 0) return undefined;
  const p = paints[0] as { type?: string; color?: { r: number; g: number; b: number }; opacity?: number };
  if (p?.type !== "SOLID" || !p.color) return undefined;
  const r = Math.round(p.color.r * 255);
  const g = Math.round(p.color.g * 255);
  const b = Math.round(p.color.b * 255);
  const hex = "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (p.opacity != null && p.opacity < 1) {
    const a = Math.round(p.opacity * 255).toString(16).padStart(2, "0");
    return hex + a;
  }
  return hex;
}
