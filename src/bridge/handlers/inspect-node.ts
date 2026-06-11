/**
 * Plugin-initiated node inspect. Resolves every applied token on a node
 * (or a subtree), flags broken references, and attaches remap suggestions
 * so the UI's Inspect tab can show fix buttons.
 *
 * All heavy lifting lives server-side so the plugin sandbox stays thin:
 *   1. Fetch catalog via the active storage config (cached).
 *   2. Build a resolver against the named theme's enabled sets.
 *   3. Load the node from Figma REST — `scope: "subtree"` pulls descendants
 *      via the same `loadNode` path that apply-theme uses.
 *   4. For each applied token, resolve → row; null → run scoreCandidates.
 *   5. For each style gap, run scoreCandidates too so the UI can suggest
 *      *starter* tokens for properties that have visuals but no token.
 */

import { fetchCatalog, ProviderError } from "../../storage/index.js";
import { resolveStorageConfig } from "../../resolve-storage.js";
import { getClient, loadNode, findEnclosingVariantName, walkVisible } from "../../figma-helpers.js";
import {
  makeResolver,
  looksLikeInlineCompositionJson,
  type ResolvedValue,
} from "../../remap/resolver.js";
import { ingestTokenSet } from "../../remap/ingest.js";
import { scoreCandidates } from "../../remap/matcher.js";
import { parseVariantAxesFromName } from "../../remap/suggest.js";
import { extractTokens, reportableGaps, collapseInstancePath } from "../../tokens.js";
import type { FigmaNode } from "../../figma-client.js";
import type { CatalogToken, TokenCatalog } from "../../remap/types.js";

/** Upper bound on nodes walked in subtree mode — keeps big frames snappy. */
const MAX_SUBTREE_NODES = 500;

interface InspectParams {
  fileKey: string;
  nodeId: string;
  scope?: "node" | "subtree";
  themeName?: string;
  maxSuggestions?: number;
}

export async function handleInspectNodeRequest(params: unknown): Promise<unknown> {
  const args = (params ?? {}) as InspectParams;
  if (!args.fileKey || !args.nodeId) {
    throw new Error("inspectNode requires { fileKey, nodeId }");
  }
  const scope = args.scope ?? "node";
  const maxSuggestions = Math.min(10, Math.max(1, args.maxSuggestions ?? 3));

  const config = await resolveStorageConfig(undefined);
  let fetched;
  try {
    fetched = await fetchCatalog(config);
  } catch (err) {
    if (err instanceof ProviderError) {
      throw new Error(err.message + (err.hint ? ` (${err.hint})` : ""));
    }
    throw err;
  }
  const catalog = ingestTokenSet(fetched.values);

  const themeInfo = pickTheme(fetched.themes, catalog, args.themeName);
  const enabledSets = themeInfo.enabledSets;
  const { resolve, resolveInline } = makeResolver(
    (fetched.values && typeof fetched.values === "object" ? fetched.values : {}) as Record<string, unknown>,
    enabledSets,
    themeInfo.selectedTokenSets
  );

  const client = getClient();
  // Depth 1 for single-node inspect avoids pulling children we won't use.
  const depth = scope === "subtree" ? undefined : 1;
  const root = await loadNode(client, { fileKey: args.fileKey, nodeId: args.nodeId }, depth);

  const variantName = findEnclosingVariantName(root, args.nodeId);
  const variantAxes = variantName ? parseVariantAxesFromName(variantName) : undefined;

  const preferredSets = new Set(enabledSets);
  const rows: InspectRowOut[] = [];
  const gaps: InspectGapOut[] = [];
  let nodesInspected = 0;
  let tokenCount = 0;
  let brokenCount = 0;

  const visit = (node: FigmaNode): void => {
    if (nodesInspected >= MAX_SUBTREE_NODES) return;
    nodesInspected += 1;

    const applied = extractTokens(node, { includeComposition: true });
    for (const [property, tokenPath] of Object.entries(applied)) {
      tokenCount += 1;
      const row = buildRow({
        node,
        property,
        tokenPath,
        resolve,
        resolveInline,
        catalog,
        preferredSets,
        maxSuggestions,
      });
      if (row.broken) brokenCount += 1;
      rows.push(row);
    }

    for (const property of reportableGaps(node)) {
      const suggestions = scoreCandidates(
        `${node.name || property}.${property}`,
        property,
        catalog.tokens,
        preferredSets.size > 0 ? preferredSets : null
      )
        .slice(0, maxSuggestions)
        .map((c) => ({ newToken: c.newToken, score: c.score, reason: c.reason, set: tokenSet(catalog, c.newToken) }));
      gaps.push({
        nodeId: collapseInstancePath(node.id),
        nodeName: node.name || "",
        property,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      });
    }
  };

  if (scope === "subtree") {
    walkVisible(root, true, visit);
  } else {
    visit(root);
  }

  return {
    rootNodeId: collapseInstancePath(root.id),
    rootNodeName: root.name || "",
    rootNodeType: root.type,
    summary: {
      tokens: tokenCount,
      broken: brokenCount,
      gaps: gaps.length,
      nodesInspected,
    },
    themeName: themeInfo.themeName,
    enabledSets,
    variantAxes,
    rows,
    gaps,
  };
}

// --------------------------------------------------------------------------
// Per-token row building
// --------------------------------------------------------------------------

interface InspectRowOut {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  property: string;
  /** Catalog path for referenced tokens, or "(inline)" for inline-JSON composition. */
  tokenPath: string;
  /** True when the applied value is inline JSON rather than a catalog reference. */
  inline?: boolean;
  tokenType?: string;
  set?: string;
  /**
   * Full nested resolved tree — primitive | composition | typography | shadow.
   * The plugin UI walks this to render breakdowns for composites. Kept
   * alongside the legacy `resolvedValue` / `resolvedKind` so older clients
   * that only read the primitive case keep working.
   */
  resolved?: ResolvedValue;
  resolvedValue?: string | number;
  resolvedKind?: "primitive" | "composition" | "typography" | "shadow";
  trail?: string[];
  broken: boolean;
  failureReason?: string;
  suggestions?: Array<{ newToken: string; score: number; reason: string; set?: string }>;
}

interface InspectGapOut {
  nodeId: string;
  nodeName: string;
  property: string;
  suggestions?: Array<{ newToken: string; score: number; reason: string; set?: string }>;
}

export function buildRow(args: {
  node: FigmaNode;
  property: string;
  tokenPath: string;
  resolve: (path: string) => ResolvedValue | null;
  resolveInline: (raw: unknown, assumedType?: string) => ResolvedValue | null;
  catalog: TokenCatalog;
  preferredSets: Set<string>;
  maxSuggestions: number;
}): InspectRowOut {
  const { node, property, tokenPath, resolve, resolveInline, catalog, preferredSets, maxSuggestions } = args;

  // Inline-JSON composition values (e.g. the `composition` key on a node
  // can carry a stringified object instead of a catalog reference). Route
  // those through resolveInline so the breakdown surfaces — before, the
  // `^{...}$` strip mangled the JSON into an unreadable fake path.
  if (looksLikeInlineCompositionJson(tokenPath)) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(tokenPath);
    } catch {
      parsed = null;
    }
    const inlineResolved = parsed != null ? resolveInline(parsed, "composition") : null;
    const base: InspectRowOut = {
      nodeId: collapseInstancePath(node.id),
      nodeName: node.name || "",
      nodeType: node.type,
      property,
      tokenPath: "(inline)",
      inline: true,
      tokenType: "composition",
      broken: false,
    };
    if (!inlineResolved) {
      return {
        ...base,
        broken: true,
        failureReason: "inline composition couldn't be resolved against this theme",
      };
    }
    return {
      ...base,
      resolved: inlineResolved,
      resolvedKind: inlineResolved.kind,
      trail: inlineResolved.trail,
    };
  }

  const cleaned = tokenPath.replace(/^\{|\}$/g, "");
  const resolved = resolve(cleaned);
  const base: InspectRowOut = {
    nodeId: collapseInstancePath(node.id),
    nodeName: node.name || "",
    nodeType: node.type,
    property,
    tokenPath: cleaned,
    broken: false,
  };
  // Literal "none" string is Tokens Studio's placeholder for "no token" —
  // surface it as broken so the user can clear or replace it.
  if (cleaned === "none" || cleaned === "") {
    return {
      ...base,
      broken: true,
      failureReason: "literal placeholder (no token assigned)",
      suggestions: runSuggestions(cleaned, property, catalog, preferredSets, maxSuggestions),
    };
  }
  if (!resolved) {
    return {
      ...base,
      broken: true,
      failureReason: failureReasonFor(cleaned, catalog),
      suggestions: runSuggestions(cleaned, property, catalog, preferredSets, maxSuggestions),
    };
  }
  // Token resolved — surface the full ResolvedValue tree so the UI can
  // render breakdowns for composites. Keep the primitive-only legacy fields
  // populated for older consumers that only read resolvedValue/resolvedKind.
  const catalogToken = catalog.tokens.find((t) => t.path === cleaned);
  const trail = resolved.trail;
  const common = {
    ...base,
    tokenType: resolved.kind === "primitive" ? resolved.type || catalogToken?.type : catalogToken?.type,
    set: catalogToken?.set ?? trail?.[0],
    resolved,
    resolvedKind: resolved.kind,
    trail,
  };
  if (resolved.kind === "primitive") {
    return { ...common, resolvedValue: resolved.value };
  }
  return common;
}

function runSuggestions(
  oldToken: string,
  property: string,
  catalog: TokenCatalog,
  preferredSets: Set<string>,
  maxSuggestions: number
): Array<{ newToken: string; score: number; reason: string; set?: string }> | undefined {
  const candidates = scoreCandidates(
    oldToken,
    property,
    catalog.tokens,
    preferredSets.size > 0 ? preferredSets : null
  );
  if (candidates.length === 0) return undefined;
  return candidates.slice(0, maxSuggestions).map((c) => ({
    newToken: c.newToken,
    score: c.score,
    reason: c.reason,
    set: tokenSet(catalog, c.newToken),
  }));
}

function tokenSet(catalog: TokenCatalog, path: string): string | undefined {
  return catalog.tokens.find((t) => t.path === path)?.set;
}

function failureReasonFor(path: string, catalog: TokenCatalog): string {
  const allSets = catalog.tokens.find((t) => t.path === path);
  if (allSets) return `token exists in set "${allSets.set ?? "?"}" but not in this theme's enabled sets`;
  return "token path not found in catalog";
}

// --------------------------------------------------------------------------
// Theme resolution
// --------------------------------------------------------------------------

interface ThemePick {
  themeName?: string;
  enabledSets: string[];
  selectedTokenSets: Record<string, string>;
}

function pickTheme(
  rawThemes: unknown,
  catalog: TokenCatalog,
  requested: string | undefined
): ThemePick {
  const themes = Array.isArray(rawThemes)
    ? (rawThemes as Array<{
        name?: string;
        selectedTokenSets?: Record<string, string>;
      }>)
    : catalog.themes.map((t) => ({ name: t.name, selectedTokenSets: t.selectedTokenSets }));

  if (themes.length === 0) {
    // No themes at all — treat every discoverable set as enabled so the
    // resolver can still answer for single-set catalogs.
    const sets = Array.from(new Set(catalog.tokens.map((t) => t.set).filter((s): s is string => !!s)));
    const selectedTokenSets: Record<string, string> = {};
    for (const s of sets) selectedTokenSets[s] = "enabled";
    return { enabledSets: sets, selectedTokenSets };
  }

  const pick = requested
    ? themes.find((t) => (t.name ?? "").toLowerCase() === requested.toLowerCase())
    : null;
  const chosen = pick ?? themes[0];
  const selectedTokenSets = chosen.selectedTokenSets ?? {};
  let enabledSets = Object.entries(selectedTokenSets)
    .filter(([, status]) => status === "enabled" || status === "source")
    .map(([name]) => name);
  if (enabledSets.length === 0) enabledSets = Object.keys(selectedTokenSets);

  return { themeName: chosen.name, enabledSets, selectedTokenSets };
}
