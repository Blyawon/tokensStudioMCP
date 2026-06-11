/**
 * Markdown "design context" renderer — a token-efficient, agent-friendly
 * view of a Figma subtree that carries EVERYTHING needed to rebuild the
 * component in code: auto-layout, sizing, constraints, fills/strokes/
 * effects with resolved colors, corner radius, typography, opacity,
 * component relationships, text content — plus the Tokens Studio tokens
 * applied to each node.
 *
 * All of this data is already present in the Figma REST response the MCP
 * fetches; previous renderers simply dropped it. One line per node, CSS-ish
 * shorthand, defaults omitted. Typically 50–70% smaller than the equivalent
 * XML/JSON while carrying strictly more information.
 */

import type { FigmaNode } from "./figma-client.js";
import { collapseInstancePath, extractDisplayTokens } from "./tokens.js";
import { truncate } from "./xml.js";

export interface DesignContextOptions {
  /** Max tree depth rendered (root = 0). Default 12. */
  maxDepth?: number;
  /** Include Tokens Studio applied tokens per node. Default true. */
  withTokens?: boolean;
  /** Config-driven subtree filter (vectors without fill, components, …). */
  skipNode?: (node: FigmaNode) => boolean;
  /** Include absolute x/y (relative to root) in addition to w/h. Default true. */
  withPosition?: boolean;
}

interface Paint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  gradientStops?: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }>;
  imageRef?: string;
}

interface Effect {
  type?: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  color?: { r: number; g: number; b: number; a?: number };
  offset?: { x: number; y: number };
}

interface TypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  letterSpacing?: number;
  textCase?: string;
  textDecoration?: string;
  textAlignHorizontal?: string;
}

export function renderDesignContext(root: FigmaNode, options: DesignContextOptions = {}): string {
  const maxDepth = options.maxDepth ?? 12;
  const lines: string[] = [];
  const originBox = root.absoluteBoundingBox;
  const origin = originBox ? { x: originBox.x, y: originBox.y } : { x: 0, y: 0 };

  function walk(node: FigmaNode, depth: number, isRoot: boolean): void {
    if (!isRoot && options.skipNode?.(node)) return;
    if (depth > maxDepth) return;
    lines.push("  ".repeat(depth) + "- " + describeNode(node, origin, options));
    const children = node.children ?? [];
    if (depth === maxDepth && children.length > 0) {
      lines.push("  ".repeat(depth + 1) + `- … ${children.length} children truncated (maxDepth=${maxDepth})`);
      return;
    }
    for (const child of children) walk(child, depth + 1, false);
  }
  walk(root, 0, true);

  const header = `# ${root.name || "(unnamed)"} — ${root.type.toLowerCase()} ${collapseInstancePath(root.id)}`;
  const legend =
    "_One node per line: `name (type id) [x,y w×h] layout | visual | text | tokens{…}`. " +
    "Sizes in px; colors resolved to hex; defaults omitted._";
  return `${header}\n${legend}\n\n${lines.join("\n")}`;
}

function describeNode(
  node: FigmaNode,
  origin: { x: number; y: number },
  options: DesignContextOptions
): string {
  const segments: string[] = [];
  const id = collapseInstancePath(node.id);
  segments.push(`**${node.name || "(unnamed)"}** (${node.type.toLowerCase()} ${id})`);

  // Geometry — position relative to the rendered root keeps numbers small.
  const box = node.absoluteBoundingBox;
  if (box) {
    const pos = (options.withPosition ?? true) ? `${round(box.x - origin.x)},${round(box.y - origin.y)} ` : "";
    segments.push(`[${pos}${round(box.width)}×${round(box.height)}]`);
  }

  const facts: string[] = [];
  pushLayoutFacts(node, facts);
  pushVisualFacts(node, facts);
  pushTextFacts(node, facts);
  pushComponentFacts(node, facts);
  if (facts.length > 0) segments.push(facts.join(" "));

  if (options.withTokens ?? true) {
    const tokens = extractDisplayTokens(node, { includeComposition: true });
    const entries = Object.entries(tokens);
    if (entries.length > 0) {
      segments.push(`tokens{${entries.map(([k, v]) => `${k}:${v}`).join(", ")}}`);
    }
  }
  return segments.join(" ");
}

function pushLayoutFacts(node: FigmaNode, out: string[]): void {
  const layoutMode = str(node.layoutMode);
  if (layoutMode === "HORIZONTAL" || layoutMode === "VERTICAL") {
    out.push(layoutMode === "HORIZONTAL" ? "flex-row" : "flex-col");
    const gap = num(node.itemSpacing);
    if (gap) out.push(`gap=${round(gap)}`);
    if (str(node.layoutWrap) === "WRAP") out.push("wrap");

    const pt = num(node.paddingTop) ?? 0;
    const pr = num(node.paddingRight) ?? 0;
    const pb = num(node.paddingBottom) ?? 0;
    const pl = num(node.paddingLeft) ?? 0;
    if (pt || pr || pb || pl) out.push(`p=${cssShorthand(pt, pr, pb, pl)}`);

    const justify = alignWord(str(node.primaryAxisAlignItems));
    const align = alignWord(str(node.counterAxisAlignItems));
    if (justify && justify !== "start") out.push(`justify=${justify}`);
    if (align && align !== "start") out.push(`items=${align}`);
    if (str(node.primaryAxisSizingMode) === "AUTO") out.push("main=hug");
    if (str(node.counterAxisSizingMode) === "AUTO") out.push("cross=hug");
  }
  // Child-side sizing inside an auto-layout parent.
  const sh = str(node.layoutSizingHorizontal);
  const sv = str(node.layoutSizingVertical);
  if (sh && sh !== "FIXED") out.push(`w=${sh.toLowerCase()}`);
  if (sv && sv !== "FIXED") out.push(`h=${sv.toLowerCase()}`);
  if (num(node.layoutGrow) === 1) out.push("grow");
  if (str(node.layoutPositioning) === "ABSOLUTE") out.push("absolute");

  const constraints = node.constraints as { horizontal?: string; vertical?: string } | undefined;
  if (constraints && typeof constraints === "object") {
    const h = constraints.horizontal ?? "LEFT";
    const v = constraints.vertical ?? "TOP";
    if (h !== "LEFT" || v !== "TOP") {
      out.push(`constraints=${h.toLowerCase()}/${v.toLowerCase()}`);
    }
  }
  if (node.clipsContent === true) out.push("clip");
  const rotation = num(node.rotation);
  if (rotation && Math.abs(rotation) > 0.01) out.push(`rotate=${round(rotation)}°`);
}

function pushVisualFacts(node: FigmaNode, out: string[]): void {
  const fills = paintList(node.fills);
  if (fills.length > 0) out.push(`fill=${fills.join(",")}`);
  const strokes = paintList(node.strokes);
  if (strokes.length > 0) {
    const weight = num(node.strokeWeight);
    out.push(`stroke=${strokes.join(",")}${weight ? `/${round(weight)}` : ""}`);
    const align = str(node.strokeAlign);
    if (align && align !== "INSIDE") out.push(`stroke-align=${align.toLowerCase()}`);
  }

  const radii = node.rectangleCornerRadii as number[] | undefined;
  const radius = num(node.cornerRadius);
  if (Array.isArray(radii) && radii.length === 4 && new Set(radii).size > 1) {
    out.push(`r=${radii.map(round).join("/")}`);
  } else if (radius) {
    out.push(`r=${round(radius)}`);
  }

  const opacity = num(node.opacity);
  if (opacity != null && opacity < 1) out.push(`opacity=${round(opacity * 100) / 100}`);
  const blend = str(node.blendMode);
  if (blend && blend !== "NORMAL" && blend !== "PASS_THROUGH") out.push(`blend=${blend.toLowerCase()}`);
  if (node.visible === false) out.push("hidden");

  const effects = (Array.isArray(node.effects) ? (node.effects as Effect[]) : []).filter(
    (e) => e.visible !== false
  );
  for (const e of effects) {
    if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
      const inner = e.type === "INNER_SHADOW" ? "inner-" : "";
      const c = e.color ? rgbaToHex(e.color) : "";
      out.push(`${inner}shadow=${round(e.offset?.x ?? 0)},${round(e.offset?.y ?? 0)},${round(e.radius ?? 0)}${e.spread ? `,${round(e.spread)}` : ""} ${c}`.trim());
    } else if (e.type === "LAYER_BLUR" || e.type === "BACKGROUND_BLUR") {
      out.push(`${e.type === "BACKGROUND_BLUR" ? "bg-blur" : "blur"}=${round(e.radius ?? 0)}`);
    }
  }
}

function pushTextFacts(node: FigmaNode, out: string[]): void {
  if (node.type !== "TEXT") return;
  const style = node.style as unknown as TypeStyle | undefined;
  if (style && typeof style === "object") {
    const family = style.fontFamily ?? "?";
    const weight = style.fontWeight ?? 400;
    const size = style.fontSize ?? 0;
    const lh = style.lineHeightPx != null ? `/${round(style.lineHeightPx)}` : "";
    out.push(`font=${family} ${weight} ${round(size)}${lh}`);
    if (style.letterSpacing) out.push(`tracking=${round(style.letterSpacing * 100) / 100}`);
    if (style.textCase && style.textCase !== "ORIGINAL") out.push(`case=${style.textCase.toLowerCase()}`);
    if (style.textDecoration && style.textDecoration !== "NONE") out.push(style.textDecoration.toLowerCase());
    if (style.textAlignHorizontal && style.textAlignHorizontal !== "LEFT") {
      out.push(`align=${style.textAlignHorizontal.toLowerCase()}`);
    }
  }
  if (typeof node.characters === "string" && node.characters.length > 0) {
    out.push(`"${truncate(node.characters, 60)}"`);
  }
}

function pushComponentFacts(node: FigmaNode, out: string[]): void {
  const componentId = str(node.componentId);
  if (node.type === "INSTANCE" && componentId) out.push(`of=${componentId}`);
  const props = node.componentProperties as unknown as Record<string, { value?: unknown }> | undefined;
  if (props && typeof props === "object") {
    const entries = Object.entries(props)
      .slice(0, 6)
      .map(([k, v]) => `${k.split("#")[0]}=${String(v?.value ?? "")}`);
    if (entries.length > 0) out.push(`props{${entries.join(", ")}}`);
  }
}

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------

function paintList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const p of raw as Paint[]) {
    if (p.visible === false) continue;
    if (p.type === "SOLID" && p.color) {
      out.push(rgbaToHex({ ...p.color, a: p.opacity ?? p.color.a ?? 1 }));
    } else if (p.type?.startsWith("GRADIENT") && Array.isArray(p.gradientStops)) {
      const stops = p.gradientStops.slice(0, 4).map((s) => rgbaToHex(s.color));
      out.push(`${p.type.replace("GRADIENT_", "").toLowerCase()}-gradient(${stops.join(",")})`);
    } else if (p.type === "IMAGE") {
      out.push("image");
    } else if (p.type) {
      out.push(p.type.toLowerCase());
    }
  }
  return out;
}

export function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0").toUpperCase();
  const base = `#${to(c.r)}${to(c.g)}${to(c.b)}`;
  const a = c.a ?? 1;
  return a >= 0.999 ? base : `${base}${to(a)}`;
}

function cssShorthand(t: number, r: number, b: number, l: number): string {
  if (t === r && r === b && b === l) return String(round(t));
  if (t === b && r === l) return `${round(t)}/${round(r)}`;
  return `${round(t)}/${round(r)}/${round(b)}/${round(l)}`;
}

function alignWord(v: string | undefined): string | null {
  switch (v) {
    case "MIN": return "start";
    case "CENTER": return "center";
    case "MAX": return "end";
    case "SPACE_BETWEEN": return "between";
    case "BASELINE": return "baseline";
    case undefined: return null;
    default: return v.toLowerCase();
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
