import type { FigmaNode } from "./figma-client.js";
import type { FtConfig } from "./config.js";

/**
 * Tokens Studio keys that the official plugin writes. Anything else in the
 * `tokens` namespace is plugin-extension noise (`hash`, `version` from
 * custom forks) and gets stripped unconditionally.
 */
const NOISE_KEYS = new Set(["hash", "version"]);

/**
 * The `composition` key is hidden by default because on most files it
 * expands to individual fill/spacing/border tokens that ALSO appear on the
 * same node, so including it doubles the output for no new signal. Some
 * files use composition as the *only* carrier of design intent though, in
 * which case callers should pass `includeComposition: true` (CLI:
 * `--with-composition`; config: `includeComposition: true`).
 *
 * `renderTokensList` auto-detects the composition-only case and prints a
 * one-line hint so users never get silently empty output.
 */
const COMPOSITION_KEY = "composition";

export interface ExtractTokenOptions {
  /** Include `composition` tokens in the returned map. Default: false. */
  includeComposition?: boolean;
}

/**
 * Pulls the Tokens Studio applied tokens off a Figma node.
 *
 * Tokens Studio writes applied tokens via:
 *   node.setSharedPluginData("tokens", <propertyKey>, <stringifiedValue>)
 *
 * When the Figma REST API is called with ?plugin_data=shared, those keys
 * come back on node.sharedPluginData.tokens as a map of strings. The values
 * are typically JSON-stringified (e.g. "\"colors.primary.500\"") because
 * setSharedPluginData only accepts strings and the plugin JSON-encodes them.
 * We parse them where possible so callers see a clean reference path.
 *
 * Returns an empty object when the node has no applied tokens. Callers use
 * the emptiness as the signal to emit `<tokens applied="none"/>`.
 *
 * Composition tokens are ignored by default. They're redundant with the
 * individual property tokens they expand to and make the output ~2× bigger
 * for no extra signal.
 */
export function extractTokens(
  node: FigmaNode,
  opts: ExtractTokenOptions = {}
): Record<string, string> {
  const raw = node.sharedPluginData?.tokens;
  if (!raw || typeof raw !== "object") return {};

  const includeComposition = opts.includeComposition === true;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NOISE_KEYS.has(key)) continue;
    if (key === COMPOSITION_KEY && !includeComposition) continue;
    if (typeof value !== "string") continue;
    out[key] = parseTokenValue(value);
  }
  return out;
}

/** True if the node has a `composition` key in its Tokens Studio data. */
export function hasCompositionToken(node: FigmaNode): boolean {
  const raw = node.sharedPluginData?.tokens;
  if (!raw || typeof raw !== "object") return false;
  return typeof raw[COMPOSITION_KEY] === "string";
}

/**
 * Sentinel value placed in the display token map when a composition token
 * exists on a node but `includeComposition` is off. Renderers use this so
 * composition-only nodes aren't silently labelled `applied="none"` — a
 * composition IS a token, we just don't unpack the multi-property value.
 */
export const COMPOSITION_PLACEHOLDER = "…";

/**
 * Like `extractTokens` but adds a `composition: "…"` placeholder when the
 * node has a composition token and `includeComposition` is off. This is the
 * function display code should use — it keeps composition-only nodes from
 * rendering as untokenized while still letting `collectTokenUsage` (which
 * calls plain `extractTokens`) skip them from the dictionary.
 */
export function extractDisplayTokens(
  node: FigmaNode,
  opts: ExtractTokenOptions = {}
): Record<string, string> {
  const tokens = extractTokens(node, opts);
  if (!opts.includeComposition && hasCompositionToken(node)) {
    tokens[COMPOSITION_KEY] = COMPOSITION_PLACEHOLDER;
  }
  return tokens;
}

/**
 * Walks the subtree (respecting skipNode) and counts how many nodes carry a
 * composition token. Used by `renderTokensList` to print the "N composition
 * tokens hidden" hint when composition is being stripped — without this
 * hint, composition-only files silently produce empty output.
 */
export function countCompositionTokens(
  root: FigmaNode,
  skipNode?: (node: FigmaNode) => boolean
): number {
  let count = 0;
  function walk(node: FigmaNode, isRoot: boolean): void {
    if (!isRoot && skipNode?.(node)) return;
    if (hasCompositionToken(node)) count += 1;
    for (const child of node.children ?? []) walk(child, false);
  }
  walk(root, true);
  return count;
}

function parseTokenValue(value: string): string {
  // Most Tokens Studio values are JSON-stringified primitives — a token
  // reference path like "colors.primary.500". Strip the wrapping quotes
  // when we can, otherwise return the raw string so nothing is lost.
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    // Composite tokens (e.g. typography) may parse to an object. Keep the
    // original string — we render it as an attribute and don't want to lose
    // detail by over-flattening here.
    return value;
  } catch {
    return value;
  }
}

/**
 * True if this node OR any descendant has at least one applied Tokens Studio
 * token. Used for onlyWithTokens pruning and coverage counting.
 *
 * `skipNode` lets callers suppress config-ignored subtrees so we don't
 * "find" tokens inside a COMPONENT that's being hidden.
 */
export function subtreeHasTokens(
  node: FigmaNode,
  skipNode?: (n: FigmaNode) => boolean,
  opts: ExtractTokenOptions = {}
): boolean {
  // Composition counts as "tokens applied" regardless of whether the caller
  // is displaying composition values. A composition token bundles multiple
  // property styles — pruning composition-only branches as "untokenized"
  // was the user-reported bug that motivated this path.
  if (hasCompositionToken(node)) return true;
  if (Object.keys(extractTokens(node, opts)).length > 0) return true;
  const children = node.children;
  if (!children) return false;
  for (const child of children) {
    if (skipNode?.(child)) continue;
    if (subtreeHasTokens(child, skipNode, opts)) return true;
  }
  return false;
}

/**
 * Figma instance descendants carry 15-segment instance-path ids like
 * `I94:774;93:4034;…;214:7220`. The leading `I` marks them as instance
 * clones and the `;`-separated list is the full parent chain. For display
 * we only need the leaf segment — the stuff before it is just bloat.
 *
 * DISPLAY ONLY — never pass a collapsed id back to the Figma REST API.
 * FigmaClient.fetchNodes needs the full instance-path id to resolve the
 * clone; stripping the prefix turns it into the component-scope id, which
 * the REST layer will either miss or resolve to the wrong node.
 */
export function collapseInstancePath(id: string): string {
  if (!id.startsWith("I")) return id;
  const semi = id.lastIndexOf(";");
  if (semi === -1) return id;
  return id.slice(semi + 1);
}

/**
 * Stable signature of an applied-tokens map. Used as the token fingerprint
 * inside subtree content hashes, so two nodes with the same tokens applied
 * in a different key order still collapse.
 */
export function tokensSignature(tokens: Record<string, string>): string {
  const entries = Object.entries(tokens).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

// --------------------------------------------------------------------------
// Style gap detection — "has visual styling but no Tokens Studio token"
// --------------------------------------------------------------------------

/**
 * Mapping from Figma's shared-style keys to the Tokens Studio property they
 * would be covered by. Figma returns keys on `node.styles` like `fill`,
 * `fills`, `stroke`, `strokes`, `effect`, `effects`, `text`, `grid`.
 */
const STYLE_KEY_TO_TOKEN_PROP: Record<string, string> = {
  fill: "fill",
  fills: "fill",
  stroke: "borderColor",
  strokes: "borderColor",
  effect: "boxShadow",
  effects: "boxShadow",
  text: "typography",
  grid: "sizing",
};

interface FigmaNodeVisuals {
  styles?: Record<string, string>;
  fills?: Array<{ visible?: boolean; type?: string } | null>;
  strokes?: Array<{ visible?: boolean; type?: string } | null>;
  effects?: Array<{ visible?: boolean; type?: string } | null>;
}

/**
 * Returns the list of visual properties this node has concrete styling for
 * but NO Tokens Studio token covering. Empty list means "no gap".
 *
 * Signals considered:
 * 1. Shared Figma styles (`node.styles`) — strongest signal, every entry
 *    without a matching token is a gap.
 * 2. Raw visible fills/strokes/effects not covered by either a shared
 *    style or a Tokens Studio token.
 *
 * TEXT nodes' implicit typography (font family, size, weight on a plain
 * text node without a shared text style) is NOT flagged — that would
 * trigger on literally every text node in the file.
 */
export function styleGaps(node: FigmaNode): string[] {
  // Composition tokens bundle an opaque set of property styles (fill,
  // border, padding, typography, …). We can't statically expand them to
  // the individual properties they cover without resolving the token set,
  // which is explicitly out of scope. The safe policy is: if the node
  // carries a composition token, trust it covers every visual property
  // and emit no gaps. Any other outcome produces a firehose of false
  // positives on files where composition is the primary design surface.
  if (hasCompositionToken(node)) return [];

  const tokens = extractTokens(node);
  const visuals = node as unknown as FigmaNodeVisuals;
  const styles = visuals.styles;
  const gaps = new Set<string>();

  // 1) Shared Figma styles without a covering token.
  if (styles && typeof styles === "object") {
    for (const [styleKey, styleId] of Object.entries(styles)) {
      if (!styleId) continue;
      const tokenProp = STYLE_KEY_TO_TOKEN_PROP[styleKey] ?? styleKey;
      if (!(tokenProp in tokens) && !(styleKey in tokens)) {
        gaps.add(tokenProp);
      }
    }
  }

  // 2) Raw visible fills with no fill token and no shared fill style.
  //
  // TEXT nodes are excluded here: a text node's "fill" array is the text
  // colour, not a background. Tokens Studio stores text colour under
  // `typography` (composite) or a separate colour key — never under `fill`
  // — so flagging raw TEXT fills as fill gaps produces a firehose of false
  // positives ("every text node is untokenized") that buries real signal.
  // Shared fill styles assigned to TEXT are still flagged by rule #1 above,
  // because that IS explicit design intent worth tokenizing.
  if (
    node.type !== "TEXT" &&
    !("fill" in tokens) &&
    !styles?.fill &&
    !styles?.fills &&
    hasVisibleEntry(visuals.fills)
  ) {
    gaps.add("fill");
  }

  // 3) Raw visible strokes with no border/stroke token and no shared stroke style.
  if (
    !("borderColor" in tokens) &&
    !("stroke" in tokens) &&
    !styles?.stroke &&
    !styles?.strokes &&
    hasVisibleEntry(visuals.strokes)
  ) {
    gaps.add("borderColor");
  }

  // 4) Raw visible effects with no shadow/effect token and no shared effect style.
  if (
    !("boxShadow" in tokens) &&
    !("effect" in tokens) &&
    !styles?.effect &&
    !styles?.effects &&
    hasVisibleEntry(visuals.effects)
  ) {
    gaps.add("boxShadow");
  }

  return Array.from(gaps);
}

function hasVisibleEntry(
  arr: Array<{ visible?: boolean } | null> | undefined
): boolean {
  if (!Array.isArray(arr)) return false;
  return arr.some((item) => item && item.visible !== false);
}

/**
 * Returns the gaps we actually want to *surface* to humans — i.e.
 * `styleGaps` minus the noise classes.
 *
 * Current noise class: vector nodes (icon paths, decorative shapes) that
 * carry no applied Tokens Studio token. A real design file has hundreds
 * of these — `Icon VECTOR fill`, `path VECTOR fill`, `Rectangle VECTOR
 * fill` — and none of them are the right layer to tokenize. The design
 * intent lives on the wrapper (the Icon component, the Card frame), not
 * on the geometry primitive beneath it.
 *
 * If someone explicitly attached a Tokens Studio token to a vector node,
 * that IS a clear signal of intent and any remaining gaps on that vector
 * are legitimate — so tokenized vectors stay in the report.
 *
 * This function is the single source of truth for "is this a gap worth
 * showing?" — the tree renderer, XML renderer, and gap report all call
 * through it so they agree.
 */
export function reportableGaps(node: FigmaNode): string[] {
  const gaps = styleGaps(node);
  if (gaps.length === 0) return gaps;
  // Composition presence already makes styleGaps return []; the additional
  // check here is belt-and-suspenders for the vector-leaf rule: a tokenized
  // vector (fill or composition) keeps its remaining gaps, an untokenized
  // one stays silent.
  const hasAnyToken =
    hasCompositionToken(node) || Object.keys(extractTokens(node)).length > 0;
  if (isVectorNode(node) && !hasAnyToken) return [];
  return gaps;
}

/**
 * True if this node OR any descendant has at least one style gap. Feeds
 * the `--gaps` CLI flag's subtree pruning. Skips over nodes the config
 * tells us to ignore so we don't surface gaps inside hidden subtrees.
 */
export function subtreeHasStyleGaps(
  node: FigmaNode,
  skipNode?: (n: FigmaNode) => boolean
): boolean {
  // Use reportableGaps here so `--gaps` pruning matches what the user
  // actually sees in the output — pruning to a branch whose only "gaps"
  // are untokenized vector leaves would be a confusing empty result.
  if (reportableGaps(node).length > 0) return true;
  for (const child of node.children ?? []) {
    if (skipNode?.(child)) continue;
    if (subtreeHasStyleGaps(child, skipNode)) return true;
  }
  return false;
}

// --------------------------------------------------------------------------
// Config-driven node filtering
// --------------------------------------------------------------------------

/**
 * Figma node types that represent vector geometry primitives — typically
 * icon paths, strokes, decorative shapes. These rarely benefit from design
 * tokens directly; the parent FRAME/INSTANCE is where the token applies.
 */
const VECTOR_TYPES = new Set([
  "VECTOR",
  "LINE",
  "ELLIPSE",
  "REGULAR_POLYGON",
  "STAR",
  "BOOLEAN_OPERATION",
]);

export function isVectorNode(node: FigmaNode): boolean {
  return VECTOR_TYPES.has(node.type);
}

/**
 * True if the node has at least one visible fill paint. Empty or
 * all-invisible `fills` arrays return false.
 */
export function hasVisibleFill(node: FigmaNode): boolean {
  const fills = (node as unknown as { fills?: Array<{ visible?: boolean } | null> }).fills;
  if (!Array.isArray(fills) || fills.length === 0) return false;
  return fills.some((p) => p && p.visible !== false);
}

/** COMPONENT / COMPONENT_SET — Figma's master component definitions. */
const COMPONENT_TYPES = new Set(["COMPONENT", "COMPONENT_SET"]);

export function isComponentDefinition(node: FigmaNode): boolean {
  return COMPONENT_TYPES.has(node.type);
}

/**
 * Apply the config-driven node filters. Returns true if this node (and
 * therefore its whole subtree) should be skipped by renderers and
 * collectors. The root of an explicit query is exempt — callers should
 * only test descendants, not the root itself.
 */
export function isIgnoredByConfig(node: FigmaNode, config: FtConfig): boolean {
  if (config.ignoreComponents && isComponentDefinition(node)) return true;
  if (config.ignoreVectorsWithoutFill && isVectorNode(node) && !hasVisibleFill(node)) {
    return true;
  }
  return false;
}

/**
 * Convenience — make a `skipNode` predicate from a config. Returns
 * `undefined` if every filter is off so callers can skip predicate
 * invocation in the hot path.
 */
export function makeSkipPredicate(
  config: FtConfig
): ((node: FigmaNode) => boolean) | undefined {
  if (!config.ignoreComponents && !config.ignoreVectorsWithoutFill) return undefined;
  return (node) => isIgnoredByConfig(node, config);
}

// --------------------------------------------------------------------------
// Gap report — `ft tokens` bottom section
// --------------------------------------------------------------------------

export interface LayerGapReport {
  name: string;
  type: string;
  id: string;
  gaps: string[];
}

/**
 * Walk the subtree and return one entry per node that has at least one
 * style gap, respecting the caller-supplied `skipNode` predicate. The
 * root itself is always visited so direct queries on a COMPONENT still
 * return something.
 */
export function collectGapReport(
  root: FigmaNode,
  skipNode?: (node: FigmaNode) => boolean
): LayerGapReport[] {
  const out: LayerGapReport[] = [];

  function walk(node: FigmaNode, isRoot: boolean): void {
    if (!isRoot && skipNode?.(node)) return;
    const gaps = reportableGaps(node);
    if (gaps.length > 0) {
      out.push({
        name: node.name || "(unnamed)",
        type: node.type,
        id: collapseInstancePath(node.id),
        gaps,
      });
    }
    for (const child of node.children ?? []) walk(child, false);
  }
  walk(root, true);
  return out;
}

// --------------------------------------------------------------------------
// Token usage collection — `ft tokens` / `list_tokens`
// --------------------------------------------------------------------------

export interface TokenLayerUsage {
  name: string;
  type: string;
  count: number;
}

/**
 * Per-property, per-value usage map:
 *   property → value → list of (layerName, layerType, count) tuples.
 *
 * Feeds `renderTokensList` so every token answer also tells the caller
 * *where* that token is applied, not just that it exists.
 */
export type TokenUsageMap = Map<string, Map<string, TokenLayerUsage[]>>;

/**
 * Walk a subtree once, group applied tokens by property and value, and
 * record every layer (name + type) that applies each value. Layer entries
 * with the same `(name, type)` pair are counted rather than duplicated.
 *
 * Insertion order on the outer map reflects first-seen property; inner
 * values are sorted alphabetically by the caller before rendering.
 */
export function collectTokenUsage(
  root: FigmaNode,
  skipNode?: (node: FigmaNode) => boolean,
  opts: ExtractTokenOptions = {}
): TokenUsageMap {
  // Build with inner map keyed by `${name}|${type}` so repeated layers
  // with the same label/type count up cleanly.
  const build = new Map<string, Map<string, Map<string, TokenLayerUsage>>>();

  function walk(node: FigmaNode, isRoot: boolean): void {
    if (!isRoot && skipNode?.(node)) return;
    const tokens = extractTokens(node, opts);
    for (const [prop, value] of Object.entries(tokens)) {
      let byValue = build.get(prop);
      if (!byValue) {
        byValue = new Map();
        build.set(prop, byValue);
      }
      let usages = byValue.get(value);
      if (!usages) {
        usages = new Map();
        byValue.set(value, usages);
      }
      const name = node.name || "(unnamed)";
      const layerKey = `${name}|${node.type}`;
      const existing = usages.get(layerKey);
      if (existing) {
        existing.count += 1;
      } else {
        usages.set(layerKey, { name, type: node.type, count: 1 });
      }
    }
    for (const child of node.children ?? []) walk(child, false);
  }
  walk(root, true);

  // Flatten inner usages to arrays, highest-count first (stable).
  const result: TokenUsageMap = new Map();
  for (const [prop, byValue] of build) {
    const outByValue = new Map<string, TokenLayerUsage[]>();
    for (const [value, usages] of byValue) {
      const list = Array.from(usages.values());
      list.sort((a, b) =>
        b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)
      );
      outByValue.set(value, list);
    }
    result.set(prop, outByValue);
  }
  return result;
}
