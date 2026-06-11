/// <reference types="@figma/plugin-typings" />

/**
 * Typography writer — font loading, weight→style mapping, and the
 * per-text-node assignment. `collectFontsFromWrites` exposes the
 * up-front list of fonts the batch needs so the batch runner can
 * `figma.loadFontAsync` them in parallel before entering the sync apply.
 */

import { numericValue, numericOrUndefined } from "../color.js";
import type { TypographyPayload, VisualWriteIn } from "../types.js";
import { unbindTextStyleFields, detachStyle } from "./unbind.js";

export function applyTypography(
  node: BaseNode,
  payload: TypographyPayload | undefined,
  fontLoadErrors: Map<string, string>
): "ok" | "skip" | string {
  if (node.type !== "TEXT") return "skip";
  if (!payload) return "no typography payload";
  const text = node as TextNode;

  // Style-id + variable-binding cascades live OUTSIDE this writer: when the
  // theme JSON has $figmaStyleReferences for the typography token, the
  // server emits a separate `bind-style` write that sets `textStyleId`.
  // This writer is the raw-values fallback Tokens Studio's applier falls
  // through to when no style is bound.
  //
  // Detach any attached Figma Text Style before the raw writes — a
  // library-bound text style can keep the old font rendering even after
  // we assign individual properties. Matches the defensive posture of
  // Tokens Studio's text applier.
  detachStyle(text, "textStyleId");
  // Clear any pre-existing variable bindings on typography fields before
  // the raw assignments below. Without this, a bound Figma Variable keeps
  // the old font size / line height / etc. painted even after we assign
  // the new value (variables win over raw writes in Figma's renderer).
  unbindTextStyleFields(text);
  const pre = payload.__resolvedFontName;
  const family = pre?.family ?? String(payload.fontFamily ?? payload.fontFamilies ?? "Inter");
  const style = pre?.style ?? mapWeightToStyle(payload.fontWeight ?? payload.fontWeights);
  const key = `${family}|${style}`;
  if (fontLoadErrors.has(key)) {
    return `font load failed: ${family} ${style} (${fontLoadErrors.get(key)})`;
  }
  text.fontName = { family, style };
  const size = numericOrUndefined(payload.fontSize ?? payload.fontSizes);
  if (size !== undefined) text.fontSize = size;
  const lh = payload.lineHeight ?? payload.lineHeights;
  if (lh !== undefined) text.lineHeight = parseLineHeight(lh);
  const ls = payload.letterSpacing ?? payload.letterSpacings;
  if (ls !== undefined) text.letterSpacing = parseLetterSpacing(ls);
  const ps = numericOrUndefined(payload.paragraphSpacing);
  if (ps !== undefined) text.paragraphSpacing = ps;

  // New 9-field parity extensions.
  const pi = numericOrUndefined(payload.paragraphIndent);
  if (pi !== undefined) text.paragraphIndent = pi;
  if (payload.textCase) {
    const tc = String(payload.textCase).toUpperCase();
    if (tc === "ORIGINAL" || tc === "UPPER" || tc === "LOWER" || tc === "TITLE" ||
        tc === "SMALL_CAPS" || tc === "SMALL_CAPS_FORCED") {
      text.textCase = tc as TextCase;
    }
  }
  if (payload.textDecoration) {
    const td = String(payload.textDecoration).toUpperCase();
    // Figma accepts NONE / UNDERLINE / STRIKETHROUGH; map common aliases.
    const mapped =
      td === "UNDERLINE" ? "UNDERLINE" :
      td === "STRIKETHROUGH" || td === "LINE-THROUGH" ? "STRIKETHROUGH" :
      td === "NONE" || td === "" ? "NONE" :
      null;
    if (mapped) text.textDecoration = mapped as TextDecoration;
  }
  if (payload.textAlign) {
    const ta = String(payload.textAlign).toUpperCase();
    if (ta === "LEFT" || ta === "RIGHT" || ta === "CENTER" || ta === "JUSTIFIED") {
      text.textAlignHorizontal = ta as TextNode["textAlignHorizontal"];
    }
  }

  return "ok";
}

export function collectFontsFromWrites(writes: VisualWriteIn[]): FontName[] {
  const seen = new Set<string>();
  const out: FontName[] = [];
  for (const w of writes) {
    if (w.kind !== "typography") continue;
    const p = (w.payload ?? {}) as TypographyPayload;
    const family = p.__resolvedFontName?.family
      ?? String(p.fontFamily ?? p.fontFamilies ?? "Inter");
    const style = p.__resolvedFontName?.style
      ?? mapWeightToStyle(p.fontWeight ?? p.fontWeights);
    const key = `${family}|${style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ family, style });
  }
  return out;
}

/**
 * CSS font-weight keyword → Figma font-style name, lowercase-keyed.
 * "bold" maps to 700-style etc., matching Tokens Studio's keyword handling.
 */
const WEIGHT_KEYWORDS: Record<string, string> = {
  thin: "Thin",
  hairline: "Thin",
  extralight: "ExtraLight",
  "ultra-light": "ExtraLight",
  light: "Light",
  normal: "Regular",
  regular: "Regular",
  book: "Regular",
  medium: "Medium",
  semibold: "SemiBold",
  demibold: "SemiBold",
  bold: "Bold",
  extrabold: "ExtraBold",
  "ultra-bold": "ExtraBold",
  black: "Black",
  heavy: "Black",
};

export function mapWeightToStyle(weight: string | number | undefined): string {
  if (weight == null) return "Regular";
  // Keyword pass: "bold"/"normal"/… → proper Figma style name.
  if (typeof weight === "string") {
    const kw = weight.trim().toLowerCase();
    if (kw in WEIGHT_KEYWORDS) return WEIGHT_KEYWORDS[kw];
    // If it's a non-keyword alphabetic value (e.g. "Semibold Italic"),
    // pass it through untouched so designers can name a specific style.
    if (/[a-z]/i.test(weight)) return weight;
  }
  const n = Number(weight);
  if (!Number.isFinite(n)) return "Regular";
  if (n <= 200) return "Thin";
  if (n <= 300) return "Light";
  if (n <= 400) return "Regular";
  if (n <= 500) return "Medium";
  if (n <= 600) return "SemiBold";
  if (n <= 700) return "Bold";
  if (n <= 800) return "ExtraBold";
  return "Black";
}

function parseLineHeight(v: string | number): LineHeight {
  if (typeof v === "string") {
    if (v.trim().toUpperCase() === "AUTO") return { unit: "AUTO" };
    if (v.trim().endsWith("%")) {
      const pct = Number(v.replace("%", "").trim());
      if (Number.isFinite(pct)) return { unit: "PERCENT", value: pct };
    }
  }
  return { unit: "PIXELS", value: numericValue(v) };
}

function parseLetterSpacing(v: string | number): LetterSpacing {
  if (typeof v === "string" && v.trim().endsWith("%")) {
    const pct = Number(v.replace("%", "").trim());
    if (Number.isFinite(pct)) return { unit: "PERCENT", value: pct };
  }
  return { unit: "PIXELS", value: numericValue(v) };
}
