import type { FigmaNode } from "./figma-client.js";
import {
  collapseInstancePath,
  extractDisplayTokens,
  reportableGaps,
  subtreeHasStyleGaps,
  subtreeHasTokens,
} from "./tokens.js";

export interface RenderOptions {
  onlyWithTokens?: boolean;
  /** Keep only branches with at least one style gap anywhere in them. */
  onlyGaps?: boolean;
  /**
   * Emit `x`, `y`, `w`, `h` attributes on every node. Defaults to `false` —
   * coordinates are noise for codegen and inflate the payload. Turn it on
   * only when the consumer actually needs layout info.
   */
  layout?: boolean;
  /**
   * Emit the `untokenized="…"` attribute on the `<tokens>` line when a
   * node has visual styling without a covering token. Default on.
   */
  warnStyleGaps?: boolean;
  /** Config-driven predicate that hides entire subtrees (components, empty vectors). */
  skipNode?: (node: FigmaNode) => boolean;
  /** Include `composition` tokens in the rendered output. Default false. */
  includeComposition?: boolean;
}

export interface RenderResult {
  xml: string;
  withTokens: number;
  total: number;
  gaps: number;
}

/**
 * Render a Figma node subtree as a Figma-MCP-style `get_metadata` XML tree
 * decorated with the Tokens Studio applied tokens on every node.
 *
 * The outermost element gets a `token-coverage="<withTokens>/<total>"`
 * attribute. If the whole subtree is untokenized, a leading HTML comment
 * makes the absence loud: `<!-- no Tokens Studio tokens applied in this subtree -->`.
 */
export function renderMetadataXml(
  root: FigmaNode,
  options: RenderOptions = {}
): RenderResult {
  const counts = { withTokens: 0, total: 0, gaps: 0 };
  const body = renderNode(root, options, counts, 0, true);
  const xml =
    counts.withTokens === 0
      ? `<!-- no Tokens Studio tokens applied in this subtree -->\n${body}`
      : body;
  return { xml, withTokens: counts.withTokens, total: counts.total, gaps: counts.gaps };
}

/**
 * Render a single node as a `<tokens>`-only snippet with the node identity.
 * Used by `get_node_tokens` where children/layout aren't wanted.
 */
export function renderSingleNodeTokens(
  node: FigmaNode,
  options: RenderOptions = {}
): string {
  const tokens = extractDisplayTokens(node, {
    includeComposition: options.includeComposition,
  });
  const attrs = baseAttributes(node, {});
  const openAttrs = [...attrs, `type="${escapeXml(node.type.toLowerCase())}"`].join(" ");
  const typeTag = node.type.toLowerCase();
  const inner =
    Object.keys(tokens).length === 0
      ? `  <!-- no Tokens Studio tokens applied on this node -->\n  <tokens applied="none"/>`
      : `  <tokens ${tokensAttrs(tokens)}/>`;
  return `<${typeTag} ${openAttrs}>\n${inner}\n</${typeTag}>`;
}

function renderNode(
  node: FigmaNode,
  options: RenderOptions,
  counts: { withTokens: number; total: number; gaps: number },
  depth: number,
  isRoot: boolean
): string {
  // Config-driven filter: hide entire subtrees matching skipNode (applied
  // to descendants only, never to the root the caller explicitly asked for).
  if (!isRoot && options.skipNode?.(node)) return "";

  const extractOpts = { includeComposition: options.includeComposition };

  // Prune branches based on `onlyWithTokens` / `onlyGaps` (OR-composed when
  // both are set). Counts are still based on the *unpruned* tree so the
  // caller can see what was filtered.
  const keep =
    (!options.onlyWithTokens && !options.onlyGaps) ||
    (options.onlyWithTokens &&
      subtreeHasTokens(node, options.skipNode, extractOpts)) ||
    (options.onlyGaps && subtreeHasStyleGaps(node, options.skipNode));
  const pruned = !keep;

  const tokens = extractDisplayTokens(node, extractOpts);
  const hasTokens = Object.keys(tokens).length > 0;
  const warn = options.warnStyleGaps ?? true;
  const gaps = warn ? reportableGaps(node) : [];

  counts.total += 1;
  if (hasTokens) counts.withTokens += 1;
  if (gaps.length > 0) counts.gaps += 1;

  // Recurse into children first so counters reflect the whole subtree
  // before we stamp `token-coverage` on the root element.
  let childrenXml = "";
  const children = node.children ?? [];
  for (const child of children) {
    const childXml = renderNode(child, options, counts, depth + 1, false);
    if (childXml) childrenXml += childXml;
  }

  if (pruned) return "";

  const tag = node.type.toLowerCase();
  const indent = "  ".repeat(depth);
  const childIndent = "  ".repeat(depth + 1);

  const attrParts = baseAttributes(node, options);
  if (isRoot) {
    attrParts.push(`token-coverage="${counts.withTokens}/${counts.total}"`);
    if (counts.gaps > 0) attrParts.push(`untokenized-count="${counts.gaps}"`);
  }

  const openTag = `${indent}<${tag}${attrParts.length ? " " + attrParts.join(" ") : ""}>`;
  const gapAttr = gaps.length > 0 ? ` untokenized="${escapeXml(gaps.slice().sort().join(","))}"` : "";
  const tokensLine = hasTokens
    ? `${childIndent}<tokens ${tokensAttrs(tokens)}${gapAttr}/>`
    : `${childIndent}<tokens applied="none"${gapAttr}/>`;
  const closeTag = `${indent}</${tag}>`;

  return `${openTag}\n${tokensLine}\n${childrenXml}${closeTag}\n`;
}

/**
 * Build the attribute list shared by every rendered node: collapsed id,
 * optional name, optional `x/y/w/h` (gated by `options.layout`), and text
 * characters preview for TEXT nodes.
 *
 * Exported so the compact-tree renderer can reuse the same id/name logic
 * without diverging.
 */
export function baseAttributes(node: FigmaNode, options: RenderOptions): string[] {
  // collapseInstancePath strips the instance-path prefix for display only;
  // the original node.id is still what went into loadNode / FigmaClient.
  const parts: string[] = [`id="${escapeXml(collapseInstancePath(node.id))}"`];
  if (node.name) parts.push(`name="${escapeXml(node.name)}"`);

  if (options.layout) {
    const box = node.absoluteBoundingBox;
    if (box) {
      parts.push(`x="${round(box.x)}"`);
      parts.push(`y="${round(box.y)}"`);
      parts.push(`w="${round(box.width)}"`);
      parts.push(`h="${round(box.height)}"`);
    }
  }

  if (node.type === "TEXT" && typeof node.characters === "string") {
    parts.push(`characters="${escapeXml(truncate(node.characters, 40))}"`);
  }

  return parts;
}

function tokensAttrs(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([k, v]) => `${escapeXml(k)}="${escapeXml(v)}"`)
    .join(" ");
}

export function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
