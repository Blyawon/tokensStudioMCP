import { createHash } from "node:crypto";

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
  tokensSignature,
  type LayerGapReport,
  type TokenLayerUsage,
} from "./tokens.js";
import { truncate } from "./xml.js";

export interface CompactTreeOptions {
  /** Keep only branches with at least one applied token anywhere in them. */
  onlyWithTokens?: boolean;
  /** Keep only branches with at least one style gap anywhere in them. */
  onlyGaps?: boolean;
  /** Append `[x,y w×h]` after the node id. Default off — codegen doesn't need it. */
  layout?: boolean;
  /** Collapse runs of ≥2 adjacent siblings with the same subtree content. Default on. */
  dedupe?: boolean;
  /** Render the ⚠ untokenized=… marker on flagged nodes. Default on. */
  warnStyleGaps?: boolean;
  /**
   * Config-driven subtree filter (ignore vectors without fill, ignore
   * component definitions). Applied to descendants only — the root node
   * is always shown because the caller asked for it explicitly.
   */
  skipNode?: (node: FigmaNode) => boolean;
  /** Include `composition` tokens. Default false — they're noisy and redundant on most files. */
  includeComposition?: boolean;
}

export interface CompactTreeResult {
  text: string;
  withTokens: number;
  total: number;
  gaps: number;
}

/**
 * Render a Figma subtree as a single-line-per-node ASCII tree using
 * box-drawing prefixes.
 */
export function renderCompactTree(
  root: FigmaNode,
  options: CompactTreeOptions = {}
): CompactTreeResult {
  const dedupe = options.dedupe ?? true;
  const warn = options.warnStyleGaps ?? true;
  const extractOpts = { includeComposition: options.includeComposition };
  const counts = { withTokens: 0, total: 0, gaps: 0 };

  // First pass: walk the (config-filtered) tree for coverage + gap numbers.
  function countAll(node: FigmaNode, isRoot: boolean): void {
    if (!isRoot && options.skipNode?.(node)) return;
    counts.total += 1;
    if (Object.keys(extractDisplayTokens(node, extractOpts)).length > 0) {
      counts.withTokens += 1;
    }
    if (reportableGaps(node).length > 0) counts.gaps += 1;
    for (const child of node.children ?? []) countAll(child, false);
  }
  countAll(root, true);

  const rootLine = formatRootLine(root, counts, warn, extractOpts);
  const body = renderChildren(root.children ?? [], "", options, dedupe, warn);

  const text = rootLine + (body ? "\n" + body : "");
  return { text, withTokens: counts.withTokens, total: counts.total, gaps: counts.gaps };
}

function formatRootLine(
  node: FigmaNode,
  counts: { withTokens: number; total: number; gaps: number },
  warn: boolean,
  extractOpts: { includeComposition?: boolean }
): string {
  const name = node.name || "(unnamed)";
  const id = collapseInstancePath(node.id);
  const tokens = extractDisplayTokens(node, extractOpts);
  const gaps = reportableGaps(node);
  const tokenCluster = formatTokenCluster(tokens);
  const gapCluster = warn ? formatGapCluster(gaps) : "";
  const summary =
    `coverage=${counts.withTokens}/${counts.total}` +
    (counts.gaps > 0 ? ` untokenized=${counts.gaps}` : "");
  return `${name}  ${node.type} ${id}  ${summary}${tokenCluster}${gapCluster}`;
}

function shouldKeepSubtree(node: FigmaNode, options: CompactTreeOptions): boolean {
  if (!options.onlyWithTokens && !options.onlyGaps) return true;
  const extractOpts = { includeComposition: options.includeComposition };
  // Filters compose as OR — "show me anything interesting" is the most
  // useful mental model when both flags are passed.
  if (
    options.onlyWithTokens &&
    subtreeHasTokens(node, options.skipNode, extractOpts)
  ) {
    return true;
  }
  if (options.onlyGaps && subtreeHasStyleGaps(node, options.skipNode)) return true;
  return false;
}

function renderChildren(
  children: FigmaNode[],
  prefix: string,
  options: CompactTreeOptions,
  dedupe: boolean,
  warn: boolean
): string {
  // First strip config-ignored subtrees, then apply token/gap filters.
  const configFiltered = options.skipNode
    ? children.filter((c) => !options.skipNode!(c))
    : children;
  const filtered = configFiltered.filter((c) => shouldKeepSubtree(c, options));
  const entries = dedupe
    ? dedupeChildren(filtered, options.includeComposition)
    : filtered.map((node) => ({ node, repeat: 1 }));

  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└─ " : "├─ ";
    const nextPrefix = prefix + (isLast ? "   " : "│  ");

    lines.push(
      prefix + branch + formatNodeLine(entry.node, entry.repeat, options, warn)
    );

    const subChildren = entry.node.children ?? [];
    if (subChildren.length > 0) {
      const sub = renderChildren(subChildren, nextPrefix, options, dedupe, warn);
      if (sub) lines.push(sub);
    }
  }
  return lines.join("\n");
}

function formatNodeLine(
  node: FigmaNode,
  repeat: number,
  options: CompactTreeOptions,
  warn: boolean
): string {
  const repeatMark = repeat > 1 ? `(×${repeat}) ` : "";
  const name = node.name || "(unnamed)";
  const id = collapseInstancePath(node.id);

  let layoutMark = "";
  if (options.layout && node.absoluteBoundingBox) {
    const box = node.absoluteBoundingBox;
    layoutMark = ` [${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}]`;
  }

  let textMark = "";
  if (node.type === "TEXT" && typeof node.characters === "string") {
    textMark = `  "${truncate(node.characters, 40)}"`;
  }

  const tokens = extractDisplayTokens(node, {
    includeComposition: options.includeComposition,
  });
  const gaps = warn ? reportableGaps(node) : [];
  const tokenCluster = formatTokenCluster(tokens);
  const gapCluster = formatGapCluster(gaps);

  return `${repeatMark}${name}  ${node.type} ${id}${layoutMark}${textMark}${tokenCluster}${gapCluster}`;
}

function formatTokenCluster(tokens: Record<string, string>): string {
  const entries = Object.entries(tokens);
  if (entries.length === 0) return "";
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const parts = entries.map(([k, v]) => `${k}=${truncate(v, 80)}`);
  return "  " + parts.join(" ");
}

function formatGapCluster(gaps: string[]): string {
  if (gaps.length === 0) return "";
  return `  ⚠ untokenized=${gaps.slice().sort().join(",")}`;
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(0);
}

// --------------------------------------------------------------------------
// Adjacent-sibling content-hash dedup
// --------------------------------------------------------------------------

interface DedupeEntry {
  node: FigmaNode;
  repeat: number;
}

export function dedupeChildren(
  children: FigmaNode[],
  includeComposition?: boolean
): DedupeEntry[] {
  const entries: DedupeEntry[] = [];
  let i = 0;
  while (i < children.length) {
    const head = children[i];
    const headHash = contentHash(head, includeComposition);
    let run = 1;
    while (
      i + run < children.length &&
      contentHash(children[i + run], includeComposition) === headHash
    ) {
      run += 1;
    }
    entries.push({ node: head, repeat: run });
    i += run;
  }
  return entries;
}

/**
 * Deterministic sha1 over the structural + token-visible content of a
 * subtree. Excludes id, bounding box, and characters so instance clones
 * collapse. Includes type, name, tokens signature, and recursive child
 * hashes — safety net: two instances that differ only in a deep leaf
 * token override hash differently.
 *
 * The `includeComposition` flag must match whatever the renderer is
 * showing, otherwise dedup would collapse nodes that *display* different
 * composition values.
 */
export function contentHash(
  node: FigmaNode,
  includeComposition?: boolean
): string {
  const h = createHash("sha1");
  h.update(node.type);
  h.update("\x00");
  h.update(node.name ?? "");
  h.update("\x00");
  // Use display tokens so dedup groups match what the user sees: two
  // otherwise-identical siblings where one carries a composition token
  // (placeholder present) must NOT collapse into the other.
  h.update(tokensSignature(extractDisplayTokens(node, { includeComposition })));
  h.update("\x00");
  for (const child of node.children ?? []) {
    h.update(contentHash(child, includeComposition));
    h.update("\x00");
  }
  return h.digest("hex");
}

// --------------------------------------------------------------------------
// Token dictionary — `ft tokens` / `list_tokens`
// --------------------------------------------------------------------------

/** How many distinct layers to list per token value before collapsing the rest. */
const LAYERS_PER_TOKEN = 5;
/** How many gap-report entries to list inline before truncating. */
const GAP_REPORT_LIMIT = 15;

export interface TokensListOptions {
  /** Config filter for descendants (ignore components, vectors w/o fill). */
  skipNode?: (node: FigmaNode) => boolean;
  /** Append a "⚠ untokenized layers" section at the bottom. Default on. */
  warnStyleGaps?: boolean;
  /** Include `composition` tokens in the dictionary. Default false. */
  includeComposition?: boolean;
}

/**
 * Render the token dictionary — every applied token grouped by property,
 * with the layers that use each token value listed after. When
 * `warnStyleGaps` is enabled (default) a bottom section lists the layers
 * that have visible styling but no covering token.
 */
export function renderTokensList(
  root: FigmaNode,
  options: TokensListOptions = {}
): string {
  const warn = options.warnStyleGaps ?? true;
  const includeComposition = options.includeComposition === true;
  const extractOpts = { includeComposition };
  const usage = collectTokenUsage(root, options.skipNode, extractOpts);

  const totalProps = usage.size;
  let totalValues = 0;
  for (const byValue of usage.values()) totalValues += byValue.size;

  // Always count hidden compositions so we can surface the "silent empty"
  // trap: a file whose only design intent lives in composition tokens
  // would otherwise report zero tokens with no explanation.
  const hiddenCompositions = includeComposition
    ? 0
    : countCompositionTokens(root, options.skipNode);

  const sections: string[] = [];

  if (totalProps === 0) {
    if (hiddenCompositions > 0) {
      sections.push(
        `No Tokens Studio tokens applied (other than ${hiddenCompositions} composition token${hiddenCompositions === 1 ? "" : "s"}).\n` +
          `Run with --with-composition to include them.`
      );
    } else {
      sections.push("No Tokens Studio tokens applied in this subtree.");
    }
  } else {
    const headerLines: string[] = [
      `${totalValues} unique tokens across ${totalProps} propert${totalProps === 1 ? "y" : "ies"}`,
    ];
    if (hiddenCompositions > 0) {
      headerLines.push(
        `ⓘ ${hiddenCompositions} composition token${hiddenCompositions === 1 ? "" : "s"} hidden — run with --with-composition to include`
      );
    }
    const groupSections: string[] = [];
    for (const [prop, byValue] of usage) {
      const sortedValues = Array.from(byValue.keys()).sort();
      const lines: string[] = [`${prop} (${sortedValues.length})`];
      for (const value of sortedValues) {
        const usages = byValue.get(value)!;
        lines.push(`  ${value}`);
        lines.push(`    → ${formatUsageList(usages)}`);
      }
      groupSections.push(lines.join("\n"));
    }
    sections.push(`${headerLines.join("\n")}\n\n${groupSections.join("\n")}`);
  }

  if (warn) {
    const gapReport = collectGapReport(root, options.skipNode);
    if (gapReport.length > 0) {
      sections.push(formatGapReport(gapReport));
    }
  }

  return sections.join("\n\n");
}

function formatUsageList(usages: TokenLayerUsage[]): string {
  if (usages.length === 0) return "(no layers)";
  const head = usages.slice(0, LAYERS_PER_TOKEN);
  const tail = usages.length - head.length;
  const rendered = head.map((u) => {
    const countMark = u.count > 1 ? ` ×${u.count}` : "";
    return `${u.name} (${u.type}${countMark})`;
  });
  if (tail > 0) rendered.push(`…and ${tail} more`);
  return rendered.join(", ");
}

function formatGapReport(entries: LayerGapReport[]): string {
  const nameWidth = Math.min(
    30,
    Math.max(...entries.map((e) => e.name.length), 4)
  );
  const typeWidth = Math.max(...entries.map((e) => e.type.length), 4);
  const header = `⚠ ${entries.length} untokenized layer${entries.length === 1 ? "" : "s"} with visual styling:`;
  const shown = entries.slice(0, GAP_REPORT_LIMIT);
  const rows = shown.map((e) => {
    const nm = truncate(e.name, nameWidth).padEnd(nameWidth);
    const tp = e.type.padEnd(typeWidth);
    const gapList = e.gaps.slice().sort().join(", ");
    return `  ${nm}  ${tp}  ${e.id.padEnd(12)}  ${gapList}`;
  });
  const tail = entries.length - shown.length;
  if (tail > 0) rows.push(`  …and ${tail} more`);
  return [header, ...rows].join("\n");
}
