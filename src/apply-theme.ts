/**
 * Theme application orchestrator. Resolves every applied token in a
 * subtree to its concrete value under a named theme and ships the
 * visual writes to the plugin.
 *
 * Includes:
 * - Fingerprint-based re-apply caching (5 min TTL)
 * - Composition / typography / shadow expansion
 * - Figma Variable / Style binding support
 * - Parallel chunked write dispatch
 */

import type { FigmaNode } from "./figma-client.js";
import { getBridge } from "./bridge/server.js";
import { fetchCatalog, type AnyStorageConfig } from "./storage/index.js";
import { makeResolver, looksLikeInlineCompositionJson, type ResolvedValue } from "./remap/resolver.js";
import { extractTokens } from "./tokens.js";
import { resolveStorageConfig } from "./resolve-storage.js";
import { getClient, loadNode, walkVisible } from "./figma-helpers.js";

// --------------------------------------------------------------------------
// Fingerprint cache — avoids redundant plugin round-trips on repeated applies.
// --------------------------------------------------------------------------

const APPLY_FINGERPRINT_CACHE = new Map<string, ApplyThemeResult>();
const FINGERPRINT_TTL_MS = 5 * 60_000;
const FINGERPRINT_TIMES = new Map<string, number>();

// Identity counter per catalog `values` object. A refetched catalog (TTL
// expiry, invalidation, external push) is a NEW object → new generation →
// fingerprint cache miss. Fixes re-applies of a theme returning stale cached
// results after the underlying token values changed upstream.
const CATALOG_GENERATION = new WeakMap<object, number>();
let NEXT_CATALOG_GENERATION = 1;
function catalogGeneration(values: object): number {
  let g = CATALOG_GENERATION.get(values);
  if (g === undefined) {
    g = NEXT_CATALOG_GENERATION++;
    CATALOG_GENERATION.set(values, g);
  }
  return g;
}

function fingerprintApply(
  themeName: string,
  nodes: Array<{ id: string; tokens: Record<string, string> }>,
  catalogSource: { provider: string; description: string } | undefined,
  generation: number
): string {
  const parts = [themeName, String(generation), catalogSource?.provider ?? "", catalogSource?.description ?? ""];
  const sortedNodes = [...nodes].sort((a, b) => a.id < b.id ? -1 : 1);
  for (const n of sortedNodes) {
    parts.push(n.id);
    const entries = Object.entries(n.tokens).sort(([a], [b]) => a < b ? -1 : 1);
    for (const [k, v] of entries) parts.push(`${k}=${v}`);
  }
  let h = 5381;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

function lookupFingerprintCache(key: string): ApplyThemeResult | null {
  const t = FINGERPRINT_TIMES.get(key);
  if (!t || Date.now() - t > FINGERPRINT_TTL_MS) {
    APPLY_FINGERPRINT_CACHE.delete(key);
    FINGERPRINT_TIMES.delete(key);
    return null;
  }
  return APPLY_FINGERPRINT_CACHE.get(key) ?? null;
}

function rememberFingerprint(key: string, result: ApplyThemeResult): void {
  APPLY_FINGERPRINT_CACHE.set(key, result);
  FINGERPRINT_TIMES.set(key, Date.now());
}

/** Clear the fingerprint cache (e.g. after commit_and_push). */
export function clearFingerprintCache(): void {
  APPLY_FINGERPRINT_CACHE.clear();
  FINGERPRINT_TIMES.clear();
}

// --------------------------------------------------------------------------
// Resolver memoization — flattening a large catalog into the token index is
// O(token count) and used to run on EVERY apply. Cache per catalog `values`
// object (the catalog cache returns the same object within its TTL) keyed by
// the theme's set signature, so re-applies and theme A/B switches skip the
// rebuild entirely.
// --------------------------------------------------------------------------

type Resolver = ReturnType<typeof makeResolver>;
const RESOLVER_CACHE = new WeakMap<object, Map<string, Resolver>>();
const RESOLVER_CACHE_MAX_PER_CATALOG = 8;

function getMemoizedResolver(
  values: Record<string, unknown>,
  enabledSets: string[],
  selectedTokenSets: Record<string, string>
): Resolver {
  const key = JSON.stringify([enabledSets, selectedTokenSets]);
  let perCatalog = RESOLVER_CACHE.get(values);
  if (!perCatalog) {
    perCatalog = new Map();
    RESOLVER_CACHE.set(values, perCatalog);
  }
  const hit = perCatalog.get(key);
  if (hit) return hit;
  const resolver = makeResolver(values, enabledSets, selectedTokenSets);
  if (perCatalog.size >= RESOLVER_CACHE_MAX_PER_CATALOG) {
    const oldest = perCatalog.keys().next().value;
    if (oldest !== undefined) perCatalog.delete(oldest);
  }
  perCatalog.set(key, resolver);
  return resolver;
}

// --------------------------------------------------------------------------
// Property → write-kind mappings
// --------------------------------------------------------------------------

/**
 * One row per Tokens Studio applied property. Consolidates what was previously
 * three parallel `PROP_TO_*` tables so adding a new property means updating
 * one row instead of remembering to touch all three in sync.
 *
 *   writeKind          — the plugin-side write kind dispatched to visual-writes
 *   variableField      — Figma variable binding field (for `setBoundVariable`)
 *   variableExpanded   — for props that bind to multiple fields (e.g. padding)
 *   styleSlot          — Figma style-id slot for style-mode binding
 */
interface PropertyConfig {
  writeKind?: string;
  variableField?: string;
  variableExpanded?: string[];
  styleSlot?: string;
}

const PROPERTY_CONFIG: Record<string, PropertyConfig> = {
  fill: { writeKind: "color-fill", variableField: "fills", styleSlot: "fillStyleId" },
  borderColor: { writeKind: "color-stroke", variableField: "strokes", styleSlot: "strokeStyleId" },
  spacing: { writeKind: "spacing", variableField: "itemSpacing" },
  itemSpacing: { writeKind: "spacing", variableField: "itemSpacing" },
  horizontalPadding: {
    writeKind: "horizontalPadding",
    variableField: "paddingLeft",
    variableExpanded: ["paddingLeft", "paddingRight"],
  },
  verticalPadding: {
    writeKind: "verticalPadding",
    variableField: "paddingTop",
    variableExpanded: ["paddingTop", "paddingBottom"],
  },
  paddingTop: { writeKind: "paddingTop", variableField: "paddingTop" },
  paddingRight: { writeKind: "paddingRight", variableField: "paddingRight" },
  paddingBottom: { writeKind: "paddingBottom", variableField: "paddingBottom" },
  paddingLeft: { writeKind: "paddingLeft", variableField: "paddingLeft" },
  borderRadius: {
    writeKind: "borderRadius",
    variableField: "topLeftRadius",
    variableExpanded: ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"],
  },
  borderRadiusTopLeft: { writeKind: "borderRadius", variableField: "topLeftRadius" },
  borderRadiusTopRight: { writeKind: "borderRadius", variableField: "topRightRadius" },
  borderRadiusBottomLeft: { writeKind: "borderRadius", variableField: "bottomLeftRadius" },
  borderRadiusBottomRight: { writeKind: "borderRadius", variableField: "bottomRightRadius" },
  borderWidth: {
    writeKind: "borderWidth",
    variableField: "strokeWeight",
    variableExpanded: ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"],
  },
  borderWidthTop: { writeKind: "borderWidth", variableField: "strokeTopWeight" },
  borderWidthRight: { writeKind: "borderWidth", variableField: "strokeRightWeight" },
  borderWidthBottom: { writeKind: "borderWidth", variableField: "strokeBottomWeight" },
  borderWidthLeft: { writeKind: "borderWidth", variableField: "strokeLeftWeight" },
  opacity: { writeKind: "opacity", variableField: "opacity" },
  sizing: { writeKind: "sizing-width", variableField: "width" },
  width: { writeKind: "sizing-width", variableField: "width" },
  height: { writeKind: "sizing-height", variableField: "height" },
  maxWidth: { writeKind: "maxWidth", variableField: "maxWidth" },
  minWidth: { writeKind: "minWidth", variableField: "minWidth" },
  maxHeight: { writeKind: "maxHeight", variableField: "maxHeight" },
  minHeight: { writeKind: "minHeight", variableField: "minHeight" },
  typography: { styleSlot: "textStyleId" },
  boxShadow: { styleSlot: "effectStyleId" },
  rotation: { writeKind: "rotation", variableField: "rotation" },
  borderStyle: { writeKind: "border-style" },
  strokeAlign: { writeKind: "stroke-align" },
  dashPattern: { writeKind: "dash-pattern" },
  characters: { writeKind: "text-characters" },
  visibility: { writeKind: "visibility" },
};

/**
 * Tokens Studio composition values frequently carry CSS-only inner
 * properties that have no Figma analogue (transitions, filters, flex
 * keywords, insets, etc.). Silently drop these when expanding a
 * composition so they don't drown the `skippedTokens` report in noise.
 * Typography-related keys (fontFamilies / fontSizes / etc.) are NOT in
 * this set — the resolver routes them through the typography code path.
 */
const IGNORED_COMPOSITION_INNER_PROPS = new Set<string>([
  // CSS-only keys with no Figma analogue. Keep this narrow — anything Figma
  // has an API for should live in PROPERTY_CONFIG so composition expansion
  // can emit a real write rather than silently dropping it.
  "transitionDuration", "transitionEasing", "transitionProperty",
  "filter", "transform", "cursor", "hyphens", "textWrap", "objectFit",
  "aspectRatio", "backgroundSize", "backgroundPosition", "backgroundBlur",
  "backdropFilter", "maskImage", "scale",
  "textDecorationColor", "textDecorationThickness", "textUnderlineOffset",
  "textTransform",
  "outline", "outlineWidth", "outlineColor", "outlineStyle", "outlineOffset",
  "insetBlockStart", "insetBlockEnd", "insetInlineStart", "insetInlineEnd",
  "alignItems", "justifyContent", "flexDirection",
  // Typography-only extensions: text-case / decoration / alignment. These
  // have Figma APIs, but they live on TEXT nodes and have to ride along with
  // a typography write. The typography expansion in generateWrites folds them
  // into the typography payload there, so we quietly drop them at the
  // primitive level instead of reporting "no Figma analogue".
  "textCase", "textDecoration", "textAlign",
]);

/**
 * Write kinds whose value is an enum string, not a color hex or a number.
 * generateWrites skips the Number() coercion for these and passes the
 * string through as-is.
 */
const STRING_ENUM_WRITE_KINDS = new Set<string>([
  "border-style",
  "stroke-align",
  "text-characters",
  "dash-pattern",
  "visibility",
]);

const PROP_TO_WRITE_KIND: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTY_CONFIG)
    .filter(([, c]) => c.writeKind !== undefined)
    .map(([k, c]) => [k, c.writeKind!])
);

const PROP_TO_VARIABLE_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTY_CONFIG)
    .filter(([, c]) => c.variableField !== undefined)
    .map(([k, c]) => [k, c.variableField!])
);

const EXPANDED_VARIABLE_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(PROPERTY_CONFIG)
    .filter(([, c]) => c.variableExpanded !== undefined)
    .map(([k, c]) => [k, c.variableExpanded!])
);

const PROP_TO_STYLE_SLOT: Record<string, string> = Object.fromEntries(
  Object.entries(PROPERTY_CONFIG)
    .filter(([, c]) => c.styleSlot !== undefined)
    .map(([k, c]) => [k, c.styleSlot!])
);

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface ApplyThemeOpts {
  themeName: string;
  skipHidden: boolean;
  onlyColor: boolean;
  dryRun: boolean;
  bindingMode: "auto" | "always" | "never";
  setActive: boolean;
  scope: "auto" | "currentPage" | "selection" | "document";
}

export interface ApplyThemeResult {
  themeName: string;
  enabledSets: string[];
  source: { provider: string; description: string };
  scope: { fileKey: string; nodeId?: string; description: string };
  scanned: number;
  withTokens: number;
  writesByKind: Record<string, number>;
  skippedTokens: Array<{ token: string; property: string; reason: string }>;
  /** Nodes filtered out up-front because they were locked in Figma. */
  lockedSkipped?: number;
  apply?: {
    applied: number;
    skipped: number;
    errors: number;
    /** First few error / skip details so callers can diagnose without re-running. */
    errorSamples?: Array<{ nodeId: string; kind: string; message: string }>;
    skipSamples?: Array<{ nodeId: string; kind: string; reason: string }>;
    /**
     * Per-write readback: for up to N color-fill writes per batch the plugin
     * reports the node type/name, the color we intended to write, and the
     * color Figma actually retained after the write. Useful for diagnosing
     * "write succeeded but visually nothing changed" — any entry where
     * `match: false` is a hint that Figma silently rejected the value.
     */
    readback?: Array<{
      nodeId: string;
      kind: string;
      nodeType: string;
      nodeName: string;
      intended: string;
      actual: string;
      match: boolean;
    }>;
  };
  dryRun: boolean;
}

export interface ProgressContext {
  progress: (info: { current: number; total: number; message?: string }) => void;
}

// --------------------------------------------------------------------------
// Main orchestrator
// --------------------------------------------------------------------------

export async function applyTheme(
  target: { fileKey: string; nodeId?: string },
  opts: ApplyThemeOpts,
  ctx?: ProgressContext
): Promise<ApplyThemeResult> {
  // 1. Pull catalog + locate the theme.
  const config = await resolveStorageConfig(undefined);
  const catalog = await fetchCatalog(config);
  const themes = (catalog.themes as Array<{
    name: string;
    selectedTokenSets?: Record<string, string>;
  }>) ?? [];
  const themeWithBindings = themes.find(
    (t) => t.name.toLowerCase() === opts.themeName.toLowerCase()
  ) as
    | (typeof themes[number] & {
        $figmaVariableReferences?: Record<string, string>;
        $figmaStyleReferences?: Record<string, string>;
      })
    | undefined;
  if (!themeWithBindings) {
    throw new Error(
      `Theme '${opts.themeName}' not found. Available: ${themes.map((t) => t.name).join(", ") || "(none)"}`
    );
  }
  const theme = themeWithBindings;
  const selectedTokenSets = theme.selectedTokenSets ?? {};
  const variableRefs = (theme.$figmaVariableReferences ?? {}) as Record<string, string>;
  const styleRefs = (theme.$figmaStyleReferences ?? {}) as Record<string, string>;

  // 2. Build the resolver.
  const values = (catalog.values && typeof catalog.values === "object")
    ? (catalog.values as Record<string, unknown>)
    : {};

  let enabledSets = Object.entries(selectedTokenSets)
    .filter(([, v]) => v === "enabled" || v === "source")
    .map(([k]) => k);

  // Fallback: if no sets are explicitly enabled, treat ALL sets as enabled.
  // This matches Tokens Studio's behavior when a theme has no set statuses.
  if (enabledSets.length === 0) {
    enabledSets = Object.keys(selectedTokenSets);
    if (enabledSets.length === 0) {
      enabledSets = Object.keys(values).filter(k => !k.startsWith("$"));
    }
  }

  // Re-order enabled sets to match the catalog's canonical `$metadata.tokenSetOrder`.
  // Later sets in that list override earlier ones, so precedence depends on this
  // being accurate. `selectedTokenSets` is an unordered map in the theme JSON —
  // without this re-order, brand override sets (e.g. `brands/bsh/light/semantic`)
  // can be walked BEFORE the base sets they're supposed to override, so their
  // entries get overwritten by the base's and the theme looks like it didn't
  // apply the brand skin. Mirrors TS's precedence handling.
  const metadata = catalog.metadata as { tokenSetOrder?: string[] } | undefined;
  const canonicalOrder = Array.isArray(metadata?.tokenSetOrder) ? metadata!.tokenSetOrder : null;
  if (canonicalOrder && canonicalOrder.length > 0) {
    const orderIndex = new Map(canonicalOrder.map((name, i) => [name, i]));
    enabledSets.sort((a, b) => {
      const ai = orderIndex.has(a) ? orderIndex.get(a)! : Number.MAX_SAFE_INTEGER;
      const bi = orderIndex.has(b) ? orderIndex.get(b)! : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }

  // 3 + 4 run concurrently with the resolver build: the plugin round-trips
  // (setActiveTheme write + full-document enumeration walk) are I/O-bound in
  // the sandbox, while flattening the catalog into the token index is
  // CPU-bound here. Kicking the bridge requests off FIRST means the sandbox
  // walks the document while we build (or fetch the memoized) resolver,
  // instead of the two phases running back-to-back.
  const bridge = getBridge();
  if (!bridge.isConnected()) {
    throw new Error(
      "Plugin not connected — open the Tokens Studio MCP Bridge plugin in Figma."
    );
  }
  const themeId = (theme as { id?: string }).id;
  const themeGroup = (theme as { group?: string }).group ?? "";

  const setActivePromise: Promise<{
    previousActiveTheme?: string | null;
    previousUsedTokenSet?: string | null;
  } | null> = (!opts.dryRun && opts.setActive)
    ? (bridge.request("setActiveTheme", {
        themeName: opts.themeName,
        themeId,
        themeGroup,
        enabledSets,
        selectedTokenSets,
      }) as Promise<{ previousActiveTheme?: string | null; previousUsedTokenSet?: string | null }>)
    : Promise.resolve(null);

  const usePlugin =
    opts.scope === "currentPage" ||
    opts.scope === "selection" ||
    opts.scope === "document" ||
    (opts.scope === "auto" && !target.fileKey);

  const enumPromise = usePlugin
    ? (bridge.request("enumerateTokenizedNodes", {
        scope: opts.scope === "auto" ? "currentPage" : opts.scope,
        skipHidden: opts.skipHidden,
      }, { timeoutMs: 3_600_000 }) as Promise<{
        nodes: Array<{ id: string; name: string; type: string; tokens: Record<string, string>; locked?: boolean }>;
        scopeDescription: string;
      }>)
    : null;
  const restRootPromise = usePlugin ? null : loadNode(getClient(), target);

  const { resolve, resolveInline } = getMemoizedResolver(values, enabledSets, selectedTokenSets);

  const setActiveResult = await setActivePromise;
  const previousActiveTheme = setActiveResult?.previousActiveTheme ?? null;
  const previousUsedTokenSet = setActiveResult?.previousUsedTokenSet ?? null;

  // Collect nodes with applied tokens from whichever source we started.
  const nodesWithTokens: Array<{ id: string; tokens: Record<string, string> }> = [];
  let scanned = 0;
  let scopeDescription: string;

  let lockedSkipped = 0;
  if (enumPromise) {
    const enumResult = await enumPromise;
    for (const n of enumResult.nodes) {
      // Pre-filter locked nodes so we don't generate writes the plugin will
      // have to reject one-by-one. Counted separately from write-level skips
      // so users can tell "50 nodes locked" from "50 writes failed".
      if (n.locked) {
        lockedSkipped += 1;
        continue;
      }
      nodesWithTokens.push({ id: n.id, tokens: n.tokens });
    }
    scanned = enumResult.nodes.length;
    scopeDescription = enumResult.scopeDescription;
  } else {
    const root = await restRootPromise!;
    walkVisible(root, opts.skipHidden, (n) => {
      scanned += 1;
      // Include composition tokens — they're how Tokens Studio bundles
      // fill/padding/radius into one applied key. Dropping them silently
      // loses any property that's defined only via the composition.
      const t = extractTokens(n, { includeComposition: true });
      if (Object.keys(t).length > 0) {
        nodesWithTokens.push({ id: n.id, tokens: t });
      }
    });
    scopeDescription = target.nodeId
      ? `subtree · ${target.nodeId}`
      : `file · ${target.fileKey}`;
  }

  // PERF: re-apply short-circuit.
  const fingerprintKey = fingerprintApply(
    opts.themeName, nodesWithTokens, catalog.source, catalogGeneration(values)
  );
  if (opts.setActive && !opts.dryRun) {
    const cached = lookupFingerprintCache(fingerprintKey);
    if (cached) {
      ctx?.progress({
        current: cached.scanned,
        total: cached.scanned,
        message: "no changes since last apply",
      });
      return { ...cached, scope: { ...cached.scope, description: scopeDescription } };
    }
  }

  // 5. Resolve each (node, property, tokenPath) → visual write(s).
  const writes: Array<{ nodeId: string; kind: string; value?: string | number; payload?: unknown }> = [];
  const skippedTokens: ApplyThemeResult["skippedTokens"] = [];
  const writesByKind: Record<string, number> = {};
  let withTokens = 0;

  for (const n of nodesWithTokens) {
    let nodeContributed = false;
    for (const [prop, tokenPath] of Object.entries(n.tokens)) {
      const bindings =
        opts.bindingMode !== "never"
          ? resolveBinding(prop, tokenPath, variableRefs, styleRefs)
          : null;
      if (bindings && bindings.length > 0) {
        for (const b of bindings) {
          writes.push({ nodeId: n.id, kind: b.kind, payload: b.payload });
          writesByKind[b.kind] = (writesByKind[b.kind] ?? 0) + 1;
        }
        nodeContributed = true;
        continue;
      }
      if (opts.bindingMode === "always") {
        skippedTokens.push({
          token: tokenPath,
          property: prop,
          reason: "bindingMode='always' but no $figmaVariableReferences / $figmaStyleReferences mapping",
        });
        continue;
      }

      // Literal "none" applied as the token reference — treat as a clear.
      // Upstream Tokens Studio behaves the same way (see `removeValuesFromNode`);
      // without this we'd pass "none" to resolve(), miss, and report it as a
      // reference gap — leaving the previous value stuck on the node.
      if (tokenPath.trim().toLowerCase() === "none") {
        const noneResolved: ResolvedValue = { kind: "primitive", value: "none", type: "other", trail: [] };
        const generatedNone = generateWrites(n.id, prop, noneResolved, tokenPath, opts, skippedTokens);
        for (const w of generatedNone) {
          writes.push(w);
          writesByKind[w.kind] = (writesByKind[w.kind] ?? 0) + 1;
        }
        if (generatedNone.length > 0) nodeContributed = true;
        continue;
      }

      // Inline-composition case: some exports bake the composition object
      // directly onto the node's tokens pluginData as a JSON string instead
      // of a catalog path. Route those through the composition machinery
      // before attempting the index lookup.
      let resolved: ResolvedValue | null = null;
      if (looksLikeInlineCompositionJson(tokenPath)) {
        resolved = resolveInline(tokenPath, "composition");
      }
      if (!resolved) resolved = resolve(tokenPath);
      if (!resolved) {
        skippedTokens.push({ token: tokenPath, property: prop, reason: "token not found in theme's enabled sets" });
        continue;
      }
      const generated = generateWrites(n.id, prop, resolved, tokenPath, opts, skippedTokens);
      if (generated.length > 0) {
        for (const w of generated) {
          writes.push(w);
          writesByKind[w.kind] = (writesByKind[w.kind] ?? 0) + 1;
        }
        nodeContributed = true;
      }
    }
    if (nodeContributed) withTokens += 1;
  }

  const out: ApplyThemeResult = {
    themeName: opts.themeName,
    enabledSets,
    source: { provider: catalog.source.provider, description: catalog.source.description },
    scope: { fileKey: target.fileKey, nodeId: target.nodeId, description: scopeDescription },
    scanned,
    withTokens,
    writesByKind,
    skippedTokens,
    dryRun: opts.dryRun,
    ...(lockedSkipped > 0 ? { lockedSkipped } : {}),
  };

  if (opts.dryRun) return out;

  // 6. Ship writes in chunks with bounded parallelism.
  const CHUNK = 500;
  const PARALLEL = 4;
  let applied = 0;
  let skippedW = 0;
  let errors = 0;

  const slices: Array<{ writes: typeof writes; index: number }> = [];
  for (let i = 0; i < writes.length; i += CHUNK) {
    slices.push({ writes: writes.slice(i, i + CHUNK), index: i });
  }
  const lastIndex = slices.length - 1;

  ctx?.progress({ current: 0, total: writes.length, message: "applying writes" });

  let nextSlice = 0;
  let completed = 0;
  const errorSamples: Array<{ nodeId: string; kind: string; message: string }> = [];
  const readbackSamples: Array<{
    nodeId: string; kind: string; nodeType: string; nodeName: string;
    intended: string; actual: string; match: boolean;
  }> = [];
  const skipSamples: Array<{ nodeId: string; kind: string; reason: string }> = [];
  const SAMPLE_CAP = 10;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextSlice++;
      if (i > lastIndex) return;
      const slice = slices[i];
      const params: Record<string, unknown> = {
        writes: slice.writes,
        deferUndo: i !== lastIndex,
      };
      if (i === 0 && opts.setActive) {
        params.opSummary = `apply_theme · ${opts.themeName} · ${writes.length} writes`;
        params.themeContext = {
          themeId: themeId ?? null,
          themeGroup,
          themeName: opts.themeName,
          previousActiveTheme,
          previousUsedTokenSet,
        };
      }
      const res = (await bridge.request("applyVisualWrites", params, { timeoutMs: 3_600_000 })) as {
        applied: number;
        skipped: Array<{ nodeId: string; kind: string; reason: string }>;
        errors: Array<{ nodeId: string; kind: string; message: string }>;
        readback?: Array<{
          nodeId: string; kind: string; nodeType: string; nodeName: string;
          intended: string; actual: string; match: boolean;
        }>;
      };
      applied += res.applied;
      skippedW += res.skipped.length;
      errors += res.errors.length;
      // Collect up to SAMPLE_CAP examples each so the caller can diagnose.
      for (const e of res.errors) {
        if (errorSamples.length < SAMPLE_CAP) errorSamples.push(e);
      }
      for (const s of res.skipped) {
        if (skipSamples.length < SAMPLE_CAP) skipSamples.push(s);
      }
      for (const r of res.readback ?? []) {
        if (readbackSamples.length < 30) readbackSamples.push(r);
      }
      completed += slice.writes.length;
      ctx?.progress({
        current: Math.min(completed, writes.length),
        total: writes.length,
        message: `${Math.min(completed, writes.length)} / ${writes.length}`,
      });
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, slices.length) }, worker)
  );

  out.apply = {
    applied,
    skipped: skippedW,
    errors,
    errorSamples: errorSamples.length > 0 ? errorSamples : undefined,
    skipSamples: skipSamples.length > 0 ? skipSamples : undefined,
    readback: readbackSamples.length > 0 ? readbackSamples : undefined,
  };
  if (opts.setActive && errors === 0) {
    rememberFingerprint(fingerprintKey, out);
  }
  return out;
}

// --------------------------------------------------------------------------
// Binding resolution
// --------------------------------------------------------------------------

function variableFieldsFor(prop: string): string[] | null {
  const expanded = EXPANDED_VARIABLE_FIELDS[prop];
  if (expanded) return expanded;
  const single = PROP_TO_VARIABLE_FIELD[prop];
  return single ? [single] : null;
}

function resolveBinding(
  prop: string,
  tokenPath: string,
  variableRefs: Record<string, string>,
  styleRefs: Record<string, string>
): Array<{ kind: "bind-variable" | "bind-style"; payload: unknown }> | null {
  const variableId = variableRefs[tokenPath];
  if (variableId) {
    const fields = variableFieldsFor(prop);
    if (fields) {
      return fields.map((field) => ({
        kind: "bind-variable" as const,
        payload: { variableId, field },
      }));
    }
  }
  const styleId = styleRefs[tokenPath];
  if (styleId) {
    const slot = PROP_TO_STYLE_SLOT[prop];
    if (slot) {
      return [{ kind: "bind-style", payload: { styleId, slot } }];
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Write generation
// --------------------------------------------------------------------------

// Exported for unit tests only. Callers inside this module use the
// unexported form; the export doesn't add a public surface — consumers
// still go through `applyTheme`.
export function generateWrites(
  nodeId: string,
  prop: string,
  resolved: ResolvedValue,
  tokenPathForReporting: string,
  opts: ApplyThemeOpts,
  skippedTokens: ApplyThemeResult["skippedTokens"]
): Array<{ nodeId: string; kind: string; value?: string | number; payload?: unknown }> {
  const out: Array<{ nodeId: string; kind: string; value?: string | number; payload?: unknown }> = [];

  if (resolved.kind === "composition") {
    for (const [innerProp, innerValue] of Object.entries(resolved.entries)) {
      if (IGNORED_COMPOSITION_INNER_PROPS.has(innerProp)) continue;
      // Synthesize stroke sub-writes from a `border: { color, width, style }`
      // inner object, matching Tokens Studio's mapValuesToTokens behaviour.
      // Without this, the outer composition only gets a generic nested
      // composition for `border` — which has no `borderColor` inner key, so
      // stroke color never lands. Applies only when border is itself a
      // composition (plain color strings still fall through to the generic
      // path and write as `borderColor` via PROP_TO_WRITE_KIND).
      if (innerProp === "border" && innerValue.kind === "composition") {
        const color = innerValue.entries.color;
        const width = innerValue.entries.width;
        if (color) {
          out.push(...generateWrites(nodeId, "borderColor", color, tokenPathForReporting, opts, skippedTokens));
        }
        if (width) {
          out.push(...generateWrites(nodeId, "borderWidth", width, tokenPathForReporting, opts, skippedTokens));
        }
        continue;
      }
      out.push(...generateWrites(nodeId, innerProp, innerValue, tokenPathForReporting, opts, skippedTokens));
    }
    return out;
  }

  if (resolved.kind === "typography") {
    if (opts.onlyColor) return out;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(resolved.props)) {
      if (v.kind === "primitive") props[k] = v.value;
    }
    // 9-field parity: Tokens Studio typography tokens can carry textCase,
    // textDecoration, paragraphIndent, textAlign in addition to the
    // fontFamily/Size/Weight/LineHeight/LetterSpacing/ParagraphSpacing core.
    // Nothing special to do server-side — the resolver already put whatever
    // primitive fields existed on the value into `resolved.props`; the
    // plugin writer handles all supported keys. Pass them all through.
    const family = String(props.fontFamily ?? props.fontFamilies ?? "Inter");
    const style = mapWeightToFigmaStyle(props.fontWeight ?? props.fontWeights);
    props.__resolvedFontName = { family, style };
    out.push({ nodeId, kind: "typography", payload: props });
    return out;
  }

  if (resolved.kind === "shadow") {
    if (opts.onlyColor) return out;
    out.push({ nodeId, kind: "shadow", payload: resolved.layers });
    return out;
  }

  // 100% size → stretch. Tokens Studio's applySizing handles `"100%"` as
  // a special sentinel that sets the node's `layoutAlign = "STRETCH"` (so
  // it fills the parent on its main axis) and resizes to the parent's
  // dimension on that axis. Route those through dedicated write kinds so
  // the plugin handles the auto-layout semantics; a naive numeric write
  // of 100 would make every such node 100px wide.
  if (resolved.kind === "primitive" && typeof resolved.value === "string"
      && resolved.value.trim() === "100%") {
    if ((prop === "width" || prop === "sizing")) {
      out.push({ nodeId, kind: "stretch-width" });
      return out;
    }
    if (prop === "height") {
      out.push({ nodeId, kind: "stretch-height" });
      return out;
    }
  }

  // CSS-shorthand expansion for border-radius and padding. Tokens Studio
  // catalogs sometimes use space-separated strings ("4 8", "4 8 12", "4 8
  // 12 16") that match CSS shorthand rules. Expand into the per-side /
  // per-corner write kinds BEFORE the single-prop mapping below so the
  // plugin doesn't receive one malformed numeric blob.
  if (resolved.kind === "primitive" && typeof resolved.value === "string") {
    const expanded = expandShorthand(prop, resolved.value);
    if (expanded) {
      for (const { prop: subProp, value: subValue } of expanded) {
        const sub: ResolvedValue = {
          kind: "primitive",
          value: subValue,
          type: resolved.type,
          trail: [...resolved.trail, `shorthand[${subProp}]`],
        };
        out.push(...generateWrites(nodeId, subProp, sub, tokenPathForReporting, opts, skippedTokens));
      }
      return out;
    }
  }

  const writeKind = PROP_TO_WRITE_KIND[prop];
  if (!writeKind) {
    skippedTokens.push({
      token: tokenPathForReporting,
      property: prop,
      reason: `property '${prop}' has no Figma analogue (skipped)`,
    });
    return out;
  }

  // Tokens Studio sentinel: a resolved value of the literal string "none"
  // means "remove the bound value for this property" — clear fills, clear
  // strokes, zero out spacing, etc. Matches the upstream plugin's
  // removeValuesFromNode path. Without this the string "none" would reach
  // the numeric branch below, fail coercion, and be reported as a
  // non-numeric skip — leaving the previous value stuck on the node.
  if (resolved.kind === "primitive" && typeof resolved.value === "string"
      && resolved.value.trim().toLowerCase() === "none") {
    if (opts.onlyColor && !writeKind.startsWith("color-")) return out;
    out.push({ nodeId, kind: `clear-${writeKind}` });
    return out;
  }
  if (opts.onlyColor && !writeKind.startsWith("color-")) return out;
  if (writeKind.startsWith("color-")) {
    if (typeof resolved.value !== "string") {
      skippedTokens.push({
        token: tokenPathForReporting,
        property: prop,
        reason: "expected color string, got non-string",
      });
      return out;
    }
  } else if (STRING_ENUM_WRITE_KINDS.has(writeKind)) {
    // Enum / raw-string write kinds bypass numeric coercion. Plugin-side
    // writer validates / normalises the string.
    out.push({ nodeId, kind: writeKind, value: String(resolved.value) });
    return out;
  } else {
    const numeric = typeof resolved.value === "number"
      ? resolved.value
      : Number(String(resolved.value).replace(/(px|rem|em|%)\s*$/i, ""));
    if (!Number.isFinite(numeric)) {
      skippedTokens.push({
        token: tokenPathForReporting,
        property: prop,
        reason: `non-numeric value: ${String(resolved.value)}`,
      });
      return out;
    }
    out.push({ nodeId, kind: writeKind, value: numeric });
    return out;
  }
  out.push({ nodeId, kind: writeKind, value: resolved.value });
  return out;
}

/**
 * CSS shorthand expansion for border-radius and padding tokens. Returns
 * null for non-shorthand inputs (single token, non-string, not a shorthand-
 * applicable prop). Returned list is (prop, value) pairs that feed back
 * through `generateWrites` as individual per-side / per-corner writes.
 *
 * Follows standard CSS rules:
 * - border-radius: top-left / top-right-and-bottom-left / bottom-right
 *   diagonals on 2 and 3 values; clockwise on 4.
 * - padding: vertical/horizontal on 2; top/horizontal/bottom on 3;
 *   clockwise on 4.
 */
function expandShorthand(prop: string, value: string): Array<{ prop: string; value: string }> | null {
  const parts = value.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return null;

  if (prop === "borderRadius") {
    const sides = radiusShorthand(parts);
    if (sides.length !== 4) return null;
    return [
      { prop: "borderRadiusTopLeft", value: sides[0] },
      { prop: "borderRadiusTopRight", value: sides[1] },
      { prop: "borderRadiusBottomRight", value: sides[2] },
      { prop: "borderRadiusBottomLeft", value: sides[3] },
    ];
  }

  // Padding shorthand. Our resolver uses `spacing` / `horizontalPadding` /
  // `verticalPadding` names for TS's padding concept. A multi-part value
  // on any of these is treated as CSS padding shorthand.
  if (prop === "spacing" || prop === "padding") {
    const sides = paddingShorthand(parts);
    if (sides.length !== 4) return null;
    return [
      { prop: "paddingTop", value: sides[0] },
      { prop: "paddingRight", value: sides[1] },
      { prop: "paddingBottom", value: sides[2] },
      { prop: "paddingLeft", value: sides[3] },
    ];
  }

  return null;
}

function paddingShorthand(p: string[]): string[] {
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];          // v h
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];          // t h b
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];          // t r b l
  return [];
}

function radiusShorthand(p: string[]): string[] {
  if (p.length === 2) return [p[0], p[1], p[0], p[1]];          // tl=br, tr=bl
  if (p.length === 3) return [p[0], p[1], p[2], p[1]];          // tl, tr=bl, br
  if (p.length === 4) return [p[0], p[1], p[2], p[3]];          // tl tr br bl
  return [];
}

// Mirrors figma-plugin/src/sandbox/visual-writes.ts:mapWeightToStyle.
// Kept in sync manually — runs in Node (server) while the plugin copy runs in Figma sandbox.
function mapWeightToFigmaStyle(weight: unknown): string {
  if (weight == null) return "Regular";
  if (typeof weight === "string" && /[a-z]/i.test(weight)) return weight;
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
