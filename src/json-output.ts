// JSON serialisers for `--json` output and any future programmatic consumer.
//
// These mirror the text renderers in `render-tree.ts` / `xml.ts` but produce
// structured data instead of formatted strings. Every shape carries a
// `format` discriminator so one consumer can tell tree / tokens / coverage /
// node apart by looking at a single field.

import type { FigmaNode } from "./figma-client.js";
import {
  collapseInstancePath,
  collectGapReport,
  collectTokenUsage,
  countCompositionTokens,
  extractDisplayTokens,
  reportableGaps,
  subtreeHasStyleGaps,
  subtreeHasTokens,
  type LayerGapReport,
} from "./tokens.js";

// --------------------------------------------------------------------------
// Tree JSON — `ft <url> --json`
// --------------------------------------------------------------------------

export interface JsonTreeOptions {
  onlyWithTokens?: boolean;
  onlyGaps?: boolean;
  layout?: boolean;
  warnStyleGaps?: boolean;
  includeComposition?: boolean;
  skipNode?: (node: FigmaNode) => boolean;
}

export interface JsonLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface JsonTreeNode {
  id: string;
  name: string;
  type: string;
  /** Applied Tokens Studio tokens on this node. Omitted when empty. */
  tokens?: Record<string, string>;
  /** Style-gap properties on this node. Omitted when empty. */
  gaps?: string[];
  /** Text content for TEXT nodes. Omitted otherwise. */
  characters?: string;
  /** Absolute bounding box, only when `layout: true` is requested. */
  layout?: JsonLayout;
  /** Children left after filtering. Omitted when none. */
  children?: JsonTreeNode[];
}

export interface JsonTreeResult {
  format: "tree";
  coverage: { withTokens: number; total: number; gaps: number };
  root: JsonTreeNode;
}

/**
 * Serialise a Figma subtree to the JSON tree shape. Respects the same
 * filters as the text renderer (`onlyWithTokens`, `onlyGaps`, `skipNode`),
 * so JSON consumers get the same slice of the tree they'd see in ASCII.
 */
export function buildTreeJson(
  root: FigmaNode,
  options: JsonTreeOptions = {}
): JsonTreeResult {
  const warn = options.warnStyleGaps ?? true;
  const extractOpts = { includeComposition: options.includeComposition };
  const counts = { withTokens: 0, total: 0, gaps: 0 };

  function walk(node: FigmaNode, isRoot: boolean): JsonTreeNode | null {
    if (!isRoot && options.skipNode?.(node)) return null;

    // OR-composed pruning — same policy as the text renderer.
    if (!isRoot && (options.onlyWithTokens || options.onlyGaps)) {
      const keep =
        (options.onlyWithTokens &&
          subtreeHasTokens(node, options.skipNode, extractOpts)) ||
        (options.onlyGaps && subtreeHasStyleGaps(node, options.skipNode));
      if (!keep) return null;
    }

    counts.total += 1;
    const tokens = extractDisplayTokens(node, extractOpts);
    if (Object.keys(tokens).length > 0) counts.withTokens += 1;
    const gaps = warn ? reportableGaps(node) : [];
    if (gaps.length > 0) counts.gaps += 1;

    const out: JsonTreeNode = {
      id: collapseInstancePath(node.id),
      name: node.name || "",
      type: node.type,
    };
    if (Object.keys(tokens).length > 0) out.tokens = tokens;
    if (gaps.length > 0) out.gaps = gaps;
    if (node.type === "TEXT" && typeof node.characters === "string") {
      out.characters = node.characters;
    }
    if (options.layout && node.absoluteBoundingBox) {
      const b = node.absoluteBoundingBox;
      out.layout = { x: b.x, y: b.y, w: b.width, h: b.height };
    }

    const childNodes: JsonTreeNode[] = [];
    for (const child of node.children ?? []) {
      const c = walk(child, false);
      if (c) childNodes.push(c);
    }
    if (childNodes.length > 0) out.children = childNodes;
    return out;
  }

  const rootNode = walk(root, true);
  // walk() only returns null for filtered children — the root is always
  // included because we pass isRoot=true on the first call.
  if (!rootNode) {
    throw new Error("buildTreeJson: root node unexpectedly filtered out");
  }
  return { format: "tree", coverage: { ...counts }, root: rootNode };
}

// --------------------------------------------------------------------------
// Tokens JSON — `ft tokens <url> --json`
// --------------------------------------------------------------------------

export interface JsonTokensOptions {
  skipNode?: (node: FigmaNode) => boolean;
  warnStyleGaps?: boolean;
  includeComposition?: boolean;
}

export interface JsonTokenUsage {
  name: string;
  type: string;
  count: number;
}

export interface JsonTokensResult {
  format: "tokens";
  totalUnique: number;
  totalProperties: number;
  /**
   * How many composition tokens were found but hidden (not in
   * `properties` and not counted in `totalUnique`). Zero when
   * `includeComposition` is on or when there aren't any.
   */
  compositionHidden: number;
  /**
   * property → value → list of layer usages.
   * Example: `{ fill: { "colors.brand.primary": [{name, type, count}, …] } }`
   */
  properties: Record<string, Record<string, JsonTokenUsage[]>>;
  /** Layers with visual styling and no covering token. */
  gaps: LayerGapReport[];
}

export function buildTokensJson(
  root: FigmaNode,
  options: JsonTokensOptions = {}
): JsonTokensResult {
  const warn = options.warnStyleGaps ?? true;
  const includeComposition = options.includeComposition === true;
  const usage = collectTokenUsage(root, options.skipNode, { includeComposition });

  let totalUnique = 0;
  const properties: Record<string, Record<string, JsonTokenUsage[]>> = {};
  for (const [prop, byValue] of usage) {
    const byValObj: Record<string, JsonTokenUsage[]> = {};
    // Sorted keys inside each group so JSON consumers see a stable order.
    const sortedValues = Array.from(byValue.keys()).sort();
    for (const value of sortedValues) {
      const usages = byValue.get(value)!;
      byValObj[value] = usages.map((u) => ({
        name: u.name,
        type: u.type,
        count: u.count,
      }));
    }
    properties[prop] = byValObj;
    totalUnique += byValue.size;
  }

  const compositionHidden = includeComposition
    ? 0
    : countCompositionTokens(root, options.skipNode);
  const gaps = warn ? collectGapReport(root, options.skipNode) : [];

  return {
    format: "tokens",
    totalUnique,
    totalProperties: usage.size,
    compositionHidden,
    properties,
    gaps,
  };
}

// --------------------------------------------------------------------------
// Coverage JSON — `ft coverage <url> --json`
// --------------------------------------------------------------------------

export interface JsonCoverageResult {
  format: "coverage";
  withTokens: number;
  total: number;
  percent: number;
}

export function buildCoverageJson(
  withTokens: number,
  total: number
): JsonCoverageResult {
  const percent = total === 0 ? 0 : Math.round((withTokens / total) * 100);
  return { format: "coverage", withTokens, total, percent };
}

// --------------------------------------------------------------------------
// Node JSON — `ft node <url> --json`
// --------------------------------------------------------------------------

export interface JsonNodeResult {
  format: "node";
  id: string;
  name: string;
  type: string;
  tokens: Record<string, string>;
}

export function buildNodeJson(
  node: FigmaNode,
  opts: { includeComposition?: boolean } = {}
): JsonNodeResult {
  return {
    format: "node",
    id: collapseInstancePath(node.id),
    name: node.name || "",
    type: node.type,
    tokens: extractDisplayTokens(node, opts),
  };
}
