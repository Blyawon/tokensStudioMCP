/// <reference types="@figma/plugin-typings" />

/**
 * CSS gradient string → Figma `GradientPaint` converter.
 *
 * Supports:
 *   - `linear-gradient(<angle|direction>, <stops…>)`
 *   - `radial-gradient([shape size] [at position], <stops…>)`
 *   - `conic-gradient([from <angle>] [at position], <stops…>)`
 *
 * Returns `null` for non-gradient inputs — callers can fall through to the
 * solid-color parser. Shape, size, and positional arguments of radial /
 * conic gradients are parsed defensively but rendered as identity-centred
 * gradients (Figma's GradientPaint lacks exact CSS-positional controls);
 * stops land correctly which is what matters for tokenised designs.
 *
 * Deliberately dependency-free — the transform matrix for linear gradients
 * is a tiny inline 3×3 affine, replacing Tokens Studio's `ml-matrix`
 * import.
 */

import { parseColor } from "./color.js";

const GRADIENT_PREFIXES = ["linear-gradient(", "radial-gradient(", "conic-gradient("];

export function isGradientString(v: string): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim().toLowerCase();
  return GRADIENT_PREFIXES.some((p) => s.startsWith(p));
}

export function parseGradient(value: string): GradientPaint | null {
  if (!isGradientString(value)) return null;
  const raw = value.trim();
  const fn = raw.substring(0, raw.indexOf("(")).toLowerCase();
  const inner = raw.substring(raw.indexOf("(") + 1, raw.lastIndexOf(")"));
  const parts = splitTopLevelComma(inner);

  if (fn === "linear-gradient") return toLinear(parts);
  if (fn === "radial-gradient") return toRadial(parts);
  if (fn === "conic-gradient")  return toConic(parts);
  return null;
}

// ---------------------------------------------------------------------------
// Stop parsing
// ---------------------------------------------------------------------------

function parseStops(parts: string[]): ColorStop[] {
  return parts.map((raw, i, arr) => {
    const { colorText, positionText } = splitTrailingPosition(raw);
    const { r, g, b, a } = parseColor(colorText);
    return {
      color: { r, g, b, a },
      position: positionText !== ""
        ? Math.max(0, Math.min(1, parseFloat(positionText) / 100))
        : arr.length <= 1 ? 0 : i / (arr.length - 1),
    } as ColorStop;
  });
}

/**
 * Splits "<color> <position>" where <color> may itself contain spaces and
 * parens (e.g. `rgba(0, 0, 0, .5) 100%`). Walks the string right-to-left and
 * grabs the final token only if it looks like a position (ends in `%` or is
 * numeric). Everything before that token is the color.
 */
function splitTrailingPosition(s: string): { colorText: string; positionText: string } {
  const trimmed = s.trim();
  let depth = 0;
  let lastSpace = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === " " && depth === 0) lastSpace = i;
  }
  if (lastSpace === -1) return { colorText: trimmed, positionText: "" };
  const tail = trimmed.slice(lastSpace + 1);
  if (tail.endsWith("%") || /^-?\d+(?:\.\d+)?$/.test(tail)) {
    return { colorText: trimmed.slice(0, lastSpace).trim(), positionText: tail.replace("%", "") };
  }
  return { colorText: trimmed, positionText: "" };
}

// Split CSS gradient arguments on top-level commas only (commas inside
// nested `rgba(…)` etc. are preserved).
function splitTopLevelComma(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start).trim());
  return out;
}

// ---------------------------------------------------------------------------
// Linear gradient — compute transform matrix from CSS angle / direction
// ---------------------------------------------------------------------------

function toLinear(parts: string[]): GradientPaint {
  let angleDeg = 180; // CSS default is `to bottom` = 180deg
  let stopParts = parts;

  if (parts.length > 0) {
    const head = parts[0];
    const angleMatch = head.match(/^(-?\d+(?:\.\d+)?)deg$/);
    const turnMatch = head.match(/^(-?\d+(?:\.\d+)?)turn$/);
    if (angleMatch) {
      angleDeg = parseFloat(angleMatch[1]);
      stopParts = parts.slice(1);
    } else if (turnMatch) {
      angleDeg = parseFloat(turnMatch[1]) * 360;
      stopParts = parts.slice(1);
    } else if (/^to\s+/i.test(head)) {
      angleDeg = directionToAngle(head.replace(/^to\s+/i, "").trim().toLowerCase());
      stopParts = parts.slice(1);
    }
  }

  // Figma gradient transform convention: rotates + positions the gradient
  // within the node's 0..1 uv space. Formula mirrors upstream TS's math so
  // angle semantics agree with CSS.
  const deg = -(angleDeg - 90);
  const rad = deg * (Math.PI / 180);
  let norm = Math.abs(rad) % (Math.PI / 2);
  if (norm > Math.PI / 4) norm = Math.PI / 2 - norm;
  const scale = Math.cos(norm);
  const c = Math.cos(rad) * scale;
  const s = Math.sin(rad) * scale;
  const tx = 0.5 - 0.5 * c + 0.5 * s;
  const ty = 0.5 - 0.5 * s - 0.5 * c;
  const transform: Transform = [
    [round(c), round(-s), round(tx)],
    [round(s), round(c),  round(ty)],
  ];
  return {
    type: "GRADIENT_LINEAR",
    gradientTransform: transform,
    gradientStops: parseStops(stopParts),
  };
}

function directionToAngle(dir: string): number {
  switch (dir) {
    case "top":          return 0;
    case "right":        return 90;
    case "bottom":       return 180;
    case "left":         return 270;
    case "top right":    return 45;
    case "bottom right": return 135;
    case "bottom left":  return 225;
    case "top left":     return 315;
    default:             return 180;
  }
}

// ---------------------------------------------------------------------------
// Radial / conic — positional/shape args parsed but rendered centred
// ---------------------------------------------------------------------------

function toRadial(parts: string[]): GradientPaint {
  // Strip a leading shape/size/position clause like "50% 50% at 50% 50%" or
  // "circle at center". Detection: the head doesn't look like a color.
  let stops = parts;
  if (parts.length > 0 && looksLikeShapeClause(parts[0])) stops = parts.slice(1);
  return {
    type: "GRADIENT_RADIAL",
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: parseStops(stops),
  };
}

function toConic(parts: string[]): GradientPaint {
  let stops = parts;
  let startAngleDeg = 0;
  if (parts.length > 0 && looksLikeShapeClause(parts[0])) {
    const m = parts[0].match(/from\s+(-?\d+(?:\.\d+)?)deg/i);
    if (m) startAngleDeg = parseFloat(m[1]);
    stops = parts.slice(1);
  }
  const rad = (startAngleDeg * Math.PI) / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  return {
    type: "GRADIENT_ANGULAR",
    gradientTransform: [
      [c, -s, 0.5 - 0.5 * c + 0.5 * s],
      [s,  c, 0.5 - 0.5 * s - 0.5 * c],
    ],
    gradientStops: parseStops(stops),
  };
}

/**
 * Radial / conic gradients take an optional shape/size/position clause as
 * their first argument (`50% 50% at 50% 50%`, `circle at center`, `ellipse
 * closest-side`…). This helper returns true when the arg looks like a shape
 * clause — meaning the caller should DROP it and treat remaining args as
 * stops. Any string that parses as a color (hex, rgb/rgba, hsl/hsla, or a
 * named colour keyword like `red`) returns false.
 */
function looksLikeShapeClause(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (/^(circle|ellipse|closest-|farthest-|from\s|at\s)/.test(t)) return true;
  if (/^-?\d/.test(t)) return true; // starts with a number/percentage
  if (t.includes(" at ")) return true;
  return false;
}

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 1e10) / 1e10;
}
