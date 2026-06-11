/**
 * Score tokens from a catalog against the context of a Figma node so the
 * agent gets a "what tokens should I apply here?" answer without the user
 * spelling out the design system's naming convention.
 *
 * Scoring is intentionally crude — name overlap, variant-axis hits, type
 * compatibility, and whether siblings already use a token from the same
 * namespace. The agent picks among the top N; we return reasoning so it
 * can rationalise the choice in chat.
 */

import type { FigmaNode } from "../figma-client.js";
import { extractTokens } from "../tokens.js";

export interface SuggestionContext {
  /** The node we're suggesting tokens for. */
  node: FigmaNode;
  /** Variant axes parsed from a parent COMPONENT's name (`size=lg` → { size: "lg" }). */
  variantAxes: Record<string, string>;
  /** Tokens already applied to siblings — hints at the namespace prefix. */
  siblingTokens: string[];
  /** Optional Figma property key the user asked about (e.g. "fill"). */
  propertyKey?: string;
}

export interface CatalogTokenSummary {
  path: string;
  type: string;
  set?: string;
}

export interface Suggestion {
  token: string;
  type: string;
  set?: string;
  score: number;
  reasons: string[];
}

const TYPE_TO_PROPERTIES: Record<string, string[]> = {
  color: ["fill", "borderColor", "stroke"],
  spacing: ["spacing", "horizontalPadding", "verticalPadding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "itemSpacing"],
  borderRadius: ["borderRadius"],
  borderWidth: ["borderWidth"],
  opacity: ["opacity"],
  sizing: ["sizing", "width", "height"],
  composition: ["composition"],
  typography: ["typography"],
  boxShadow: ["boxShadow"],
};

/**
 * Inverse map: property key → expected token types. Used to filter the
 * catalog when the caller knows which property they're tokenising.
 */
const PROPERTY_TO_TYPES: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const [type, props] of Object.entries(TYPE_TO_PROPERTIES)) {
    for (const p of props) {
      if (!out[p]) out[p] = [];
      out[p].push(type);
    }
  }
  return out;
})();

export function suggestTokens(
  catalog: CatalogTokenSummary[],
  ctx: SuggestionContext,
  max = 10
): Suggestion[] {
  const expectedTypes = ctx.propertyKey ? PROPERTY_TO_TYPES[ctx.propertyKey] : null;
  const nodeName = (ctx.node.name || "").toLowerCase();
  const nodeType = ctx.node.type.toLowerCase();
  const axisValues = Object.values(ctx.variantAxes).map((v) => v.toLowerCase());

  // Sibling namespace hints: derive prefixes that appear in 2+ sibling tokens.
  const siblingPrefixes = derivePrefixes(ctx.siblingTokens);

  const out: Suggestion[] = [];
  for (const tok of catalog) {
    if (expectedTypes && !expectedTypes.includes(tok.type)) continue;
    let score = 0.05; // baseline for any type-compatible candidate
    const reasons: string[] = [];
    const tokPath = tok.path.toLowerCase();

    // Name overlap — highest signal.
    if (nodeName && tokPath.includes(nodeName)) {
      score += 0.4;
      reasons.push(`path contains node name "${ctx.node.name}"`);
    } else if (nodeName) {
      // Token-of-name heuristic: split on "/." and look for common stems.
      const stems = nodeName.split(/[\s/.\-_]+/).filter((s) => s.length >= 3);
      const hit = stems.find((s) => tokPath.includes(s));
      if (hit) {
        score += 0.15;
        reasons.push(`path contains stem "${hit}" from node name`);
      }
    }

    // Variant axis values — strong signal for variant components.
    let axisHits = 0;
    for (const v of axisValues) {
      if (v && tokPath.includes(v)) {
        axisHits += 1;
        reasons.push(`matches axis value "${v}"`);
      }
    }
    score += Math.min(0.4, axisHits * 0.2);

    // Sibling namespace prefix.
    for (const prefix of siblingPrefixes) {
      if (tok.path.startsWith(prefix)) {
        score += 0.1;
        reasons.push(`shares prefix "${prefix}" with sibling tokens`);
        break;
      }
    }

    // Node-type → token-type sanity bonus (e.g. VECTOR/RECTANGLE prefer color).
    if (
      (nodeType === "vector" || nodeType === "rectangle" || nodeType === "ellipse") &&
      tok.type === "color"
    ) {
      score += 0.05;
    }
    if (nodeType === "text" && (tok.type === "typography" || tok.type === "fontSizes")) {
      score += 0.1;
      reasons.push("typography token preferred for TEXT node");
    }

    if (score > 0.05 || reasons.length > 0) {
      out.push({
        token: tok.path,
        type: tok.type,
        set: tok.set,
        score: Math.round(score * 100) / 100,
        reasons,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, max);
}

/**
 * For each pair of sibling token paths, find their longest common dot-
 * delimited prefix. Prefixes that appear across 2+ siblings are returned —
 * those are the "namespace" the design system tends to bucket related
 * tokens under.
 */
function derivePrefixes(tokens: string[]): string[] {
  if (tokens.length < 2) return [];
  const prefixCounts = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      const prefix = longestDotPrefix(tokens[i], tokens[j]);
      if (!prefix) continue;
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
  }
  return Array.from(prefixCounts.entries())
    .filter(([, count]) => count >= 1)
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, 3)
    .map(([prefix]) => prefix);
}

function longestDotPrefix(a: string, b: string): string {
  const ap = a.split(".");
  const bp = b.split(".");
  let i = 0;
  while (i < ap.length && i < bp.length && ap[i] === bp[i]) i++;
  if (i === 0) return "";
  return ap.slice(0, i).join(".");
}

/**
 * Flatten a fetched catalog into a per-token summary that the scorer
 * needs. Mirrors the walk in the resolver but only collects the
 * (path, type, set) triple — no values needed for ranking.
 */
export function flattenCatalogToSummaries(
  values: unknown,
  enabledSets: string[] | null
): CatalogTokenSummary[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) return [];
  const out: CatalogTokenSummary[] = [];
  const sets = enabledSets ?? Object.keys(values as Record<string, unknown>);
  for (const setName of sets) {
    const tree = (values as Record<string, unknown>)[setName];
    if (!tree) continue;
    walk(tree, [], setName, out);
  }
  return out;
}

function walk(
  node: unknown,
  pathParts: string[],
  setName: string,
  out: CatalogTokenSummary[]
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if ("value" in obj || "$value" in obj) {
    const path = pathParts.join(".");
    if (!path) return;
    const type = String(obj.$type ?? obj.type ?? "");
    out.push({ path, type, set: setName });
    return;
  }
  for (const [k, child] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    walk(child, [...pathParts, k], setName, out);
  }
}

/**
 * Walk a subtree to find every applied token (excluding the target
 * node itself) — used to seed `siblingTokens` so the suggester knows
 * what namespace to bias toward. NOTE: "sibling" here is loose — this
 * walks the whole loaded subtree, not literal Figma siblings, since
 * the namespace prefix often hints from anywhere within the component.
 */
export function collectNearbyTokens(root: FigmaNode, excludeId: string): string[] {
  const out: string[] = [];
  function visit(n: FigmaNode): void {
    if (n.id !== excludeId) {
      const tokens = extractTokens(n);
      for (const v of Object.values(tokens)) out.push(v);
    }
    for (const c of n.children ?? []) visit(c);
  }
  visit(root);
  return out;
}

/**
 * Parse Figma's variant component name (`"size=lg, variant=default, ..."`)
 * into an axis dict. Tolerant of stray whitespace and missing separators.
 */
export function parseVariantAxesFromName(name: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const segment of (name || "").split(",")) {
    const eq = segment.indexOf("=");
    if (eq === -1) continue;
    const key = segment.slice(0, eq).trim();
    const val = segment.slice(eq + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}
