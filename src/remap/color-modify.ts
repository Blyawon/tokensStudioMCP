/**
 * Tokens Studio color-modifier support: `darken` / `lighten` / `alpha` /
 * `mix`. Applied after base-color resolution on tokens that declare
 * `$extensions["studio.tokens"].modify`. Without this, a catalog that
 * derives hover / active / disabled states from a base color via modifiers
 * resolves to the BASE color — visually indistinguishable from "theme didn't
 * apply" on those nodes.
 *
 * Intentionally dependency-free. Upstream Tokens Studio uses colorjs.io to
 * handle LCH / P3 / OKLCH spaces; we support `srgb` and `hsl` directly (the
 * two spaces nearly every real catalog uses) and fall back to `srgb` for
 * anything else. If a future catalog needs LCH precision, the pluggable
 * space switch in `applyDarkenLighten` is the place to extend.
 */

export type ColorModifierType = "darken" | "lighten" | "alpha" | "mix";
export type ColorSpace = "srgb" | "hsl" | "lch" | "p3" | "oklch";

export interface ColorModifier {
  type: ColorModifierType;
  value: number | string;
  space?: ColorSpace;
  color?: string;
}

/**
 * Apply a modifier to `baseColor`, returning a hex-format color. Accepts
 * any input parseRgba can handle (hex, rgb/rgba, hsl/hsla). Returns the
 * original input unchanged on any parse or math failure — matches TS's
 * silent-fallback behaviour.
 */
export function modifyColor(baseColor: string, modifier: ColorModifier): string {
  try {
    const rgba = parseRgba(baseColor);
    if (!rgba) return baseColor;
    const amount = Number(modifier.value);
    if (!Number.isFinite(amount)) return baseColor;
    const space: ColorSpace = modifier.space ?? "srgb";

    switch (modifier.type) {
      case "alpha":
        return rgbaToHex({ ...rgba, a: clamp(amount, 0, 1) });

      case "darken":
        return rgbaToHex(applyDarkenLighten(rgba, space, amount, "darken"));

      case "lighten":
        return rgbaToHex(applyDarkenLighten(rgba, space, amount, "lighten"));

      case "mix": {
        if (!modifier.color) return baseColor;
        const other = parseRgba(modifier.color);
        if (!other) return baseColor;
        return rgbaToHex(mix(rgba, other, clamp(amount, 0, 1)));
      }
    }
  } catch {
    return baseColor;
  }
  return baseColor;
}

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

interface Rgba { r: number; g: number; b: number; a: number } // 0–1 channels

function applyDarkenLighten(
  c: Rgba,
  space: ColorSpace,
  amount: number,
  dir: "darken" | "lighten"
): Rgba {
  if (space === "hsl") {
    const { h, s, l } = rgbToHsl(c);
    const newL =
      dir === "darken"
        ? Math.max(0, l - l * amount)
        : Math.min(1, l + (1 - l) * amount);
    return { ...hslToRgb(h, s, newL), a: c.a };
  }
  // srgb, p3, lch, oklch, … — fall back to channel-wise scaling which
  // matches TS's srgb branch exactly and is a reasonable approximation
  // for the other spaces at typical amounts.
  const f =
    dir === "darken"
      ? (v: number) => Math.max(0, v - amount * v)
      : (v: number) => Math.min(1, v + amount * (1 - v));
  return { r: f(c.r), g: f(c.g), b: f(c.b), a: c.a };
}

function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return {
    r: a.r * (1 - t) + b.r * t,
    g: a.g * (1 - t) + b.g * t,
    b: a.b * (1 - t) + b.b * t,
    a: a.a * (1 - t) + b.a * t,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

// ---------------------------------------------------------------------------
// Color parsing / serialisation
// ---------------------------------------------------------------------------

/** Accepts #hex, rgb/rgba, hsl/hsla. Returns null on unknown format. */
export function parseRgba(input: string): Rgba | null {
  const s = String(input).trim().toLowerCase();
  if (!s) return null;

  // #RGB / #RRGGBB / #RGBA / #RRGGBBAA
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const expand = (h: string) =>
      h.length === 3 || h.length === 4
        ? h.split("").map((c) => c + c).join("")
        : h;
    const h = expand(hex);
    if (h.length !== 6 && h.length !== 8) return null;
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }

  // rgb(a)(...)
  const rgbMatch = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(",").map((x) => x.trim());
    if (parts.length < 3) return null;
    const toChan = (p: string) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p) / 255);
    const r = toChan(parts[0]);
    const g = toChan(parts[1]);
    const b = toChan(parts[2]);
    const a = parts[3] !== undefined
      ? (parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]))
      : 1;
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return { r: clamp(r, 0, 1), g: clamp(g, 0, 1), b: clamp(b, 0, 1), a: clamp(a, 0, 1) };
  }

  // hsl(a)(...)
  const hslMatch = s.match(/^hsla?\(([^)]+)\)$/);
  if (hslMatch) {
    const parts = hslMatch[1].split(",").map((x) => x.trim());
    if (parts.length < 3) return null;
    const h = parseFloat(parts[0]) / 360;
    const sat = parseFloat(parts[1].replace("%", "")) / 100;
    const l = parseFloat(parts[2].replace("%", "")) / 100;
    const a = parts[3] !== undefined
      ? (parts[3].endsWith("%") ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]))
      : 1;
    if ([h, sat, l, a].some((n) => Number.isNaN(n))) return null;
    return { ...hslToRgb(h, sat, l), a: clamp(a, 0, 1) };
  }

  return null;
}

function rgbaToHex({ r, g, b, a }: Rgba): string {
  const toHex = (v: number) => {
    const clamped = Math.round(clamp(v, 0, 1) * 255);
    return clamped.toString(16).padStart(2, "0");
  };
  const alpha = clamp(a, 0, 1);
  if (alpha >= 0.9999) return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${toHex(alpha)}`;
}

function rgbToHsl({ r, g, b }: { r: number; g: number; b: number }): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return {
    r: hue2rgb(h + 1 / 3),
    g: hue2rgb(h),
    b: hue2rgb(h - 1 / 3),
  };
}
