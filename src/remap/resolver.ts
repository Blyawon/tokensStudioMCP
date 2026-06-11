/**
 * Resolve a Tokens Studio reference path to a concrete value, using a
 * theme's enabled token sets in priority order.
 *
 * Returns a DISCRIMINATED `ResolvedValue` so callers can branch on shape:
 *   - primitive  → color / spacing / dimension / borderRadius / opacity / ...
 *   - composition → bag of property-keyed inner ResolvedValues
 *   - typography  → composite of font props (already individually resolved)
 *   - shadow      → array of layer objects (each color/offset/blur resolved)
 *
 * Reference + math handling:
 *   - "{a.b.c}" → resolve recursively (cycle-protected at depth 16)
 *   - "{a} * 2 + 4" → recursively resolve refs to numbers, then evaluate
 *     a tiny safe expression (operators + - * / and parens; no functions)
 *   - "16px" → strip unit, return as number
 */

export type ResolvedValue =
  | { kind: "primitive"; value: string | number; type: string; trail: string[] }
  | { kind: "composition"; entries: Record<string, ResolvedValue>; trail: string[] }
  | { kind: "typography"; props: Record<string, ResolvedValue>; trail: string[] }
  | { kind: "shadow"; layers: ShadowLayer[]; trail: string[] };

export interface ShadowLayer {
  type: "dropShadow" | "innerShadow";
  color: string;          // resolved hex/rgba string
  x: number;
  y: number;
  blur: number;
  spread: number;
}

export type SetMap = Record<string, unknown>;

import { modifyColor, type ColorModifier } from "./color-modify.js";

interface Leaf {
  /** Raw value as stored in the catalog — string, number, object, or array. */
  value: unknown;
  type: string;
  set: string;
  /** Whether this leaf came from an "enabled" or "source" set. */
  status: "enabled" | "source";
  /**
   * Tokens Studio color-modifier extension, when present on the token:
   * `$extensions["studio.tokens"].modify = { type, value, space, color? }`.
   * Captured during the flatten walk so `resolveLeaf` can apply it after
   * the base value has been resolved.
   */
  modifier?: ColorModifier;
}

// Cycle-guard: applies to every hop (composition property, reference,
// typography sub-field, math-embedded ref). Each hop appends an entry to
// `trail`, so this doubles as a composition-depth limiter — but at a value
// (16) that real-world catalogs never legitimately reach, unlike the prior
// hard cap of 3 which silently dropped correctly-authored deep compositions.
const MAX_REF_DEPTH = 16;

/**
 * Build a resolver bound to a theme's enabled sets. The set index is
 * pre-flattened so each `resolve()` call is O(reference-depth) instead
 * of O(file-size).
 */
export function makeResolver(values: SetMap, enabledSets: string[], setStatuses?: Record<string, string>) {
  const index = flattenSets(values, enabledSets, setStatuses);

  function resolve(path: string, trail: string[] = []): ResolvedValue | null {
    if (trail.length > MAX_REF_DEPTH) return null;
    const leaf = index.get(path);
    if (!leaf) return null;
    return resolveLeaf(leaf, [...trail, `{${path}}`]);
  }

  function resolveLeaf(leaf: Leaf, trail: string[]): ResolvedValue | null {
    const type = leaf.type;
    const v = leaf.value;

    // Composition tokens — value is usually an object whose keys are
    // property names (fill, spacing, ...) and values are token refs OR
    // literals. But real-world applied compositions can also store the
    // value as a STRING on the node: either a single reference to another
    // composition token ("{my.other.comp}") or an inline JSON-stringified
    // object ('{"fill":"{color.bg}",...}'). Mirror the native Tokens
    // Studio plugin by accepting all three shapes.
    if (type === "composition") {
      if (trail.length > MAX_REF_DEPTH) return null;
      const obj = asCompositionObject(v);
      if (obj) {
        const entries: Record<string, ResolvedValue> = {};
        for (const [propKey, propValue] of Object.entries(obj)) {
          const resolved = resolveAnyValue(propValue, trail, type);
          if (resolved) entries[propKey] = resolved;
        }
        return { kind: "composition", entries, trail };
      }
      if (typeof v === "string") {
        const ref = parseSingleReference(v);
        if (ref) {
          if (trail.length > MAX_REF_DEPTH) return null;
          const target = index.get(ref);
          if (!target) return null;
          return resolveLeaf(target, [...trail, `{${ref}}`]);
        }
      }
      // String didn't parse to an object or a reference — fall through to
      // primitive handling so the raw string surfaces instead of being lost.
    }

    // Typography tokens — value is an object of font properties.
    if (type === "typography" && isPlainObject(v)) {
      const props: Record<string, ResolvedValue> = {};
      for (const [propKey, propValue] of Object.entries(v as Record<string, unknown>)) {
        const resolved = resolveAnyValue(propValue, trail, "typography");
        if (resolved) props[propKey] = resolved;
      }
      return { kind: "typography", props, trail };
    }

    // Shadow tokens — value is array of layer objects.
    if (type === "boxShadow" && Array.isArray(v)) {
      const layers = v.map((layer) => resolveShadowLayer(layer)).filter(
        (l): l is ShadowLayer => l !== null
      );
      return { kind: "shadow", layers, trail };
    }

    // Primitive — string or number, possibly a ref or math.
    const resolved = resolvePrimitive(v, type, trail);
    // Apply a Tokens Studio color modifier if the leaf declares one. The
    // modifier operates on a resolved color string (hex or rgb/rgba/hsl)
    // — if the resolved primitive isn't a color-like string we leave it
    // alone to avoid corrupting non-color leaves that happened to carry
    // a stray `$extensions.studio.tokens.modify` block.
    if (resolved?.kind === "primitive" && leaf.modifier && typeof resolved.value === "string") {
      const modified = modifyColor(resolved.value, leaf.modifier);
      if (modified !== resolved.value) {
        return { ...resolved, value: modified, trail: [...resolved.trail, `modify:${leaf.modifier.type}`] };
      }
    }
    return resolved;
  }

  function resolveAnyValue(
    value: unknown,
    trail: string[],
    parentType: string
  ): ResolvedValue | null {
    if (typeof value === "string") {
      const ref = parseSingleReference(value);
      if (ref) {
        if (trail.length > MAX_REF_DEPTH) return null;
        const leaf = index.get(ref);
        if (!leaf) return null;
        return resolveLeaf(leaf, [...trail, `{${ref}}`]);
      }
      // Math? expression with embedded refs.
      if (/\{[^}]+\}/.test(value)) {
        const evaluated = tryEvaluateExpression(value, index, trail);
        if (evaluated !== null) {
          return {
            kind: "primitive",
            value: evaluated,
            type: parentType,
            trail: [...trail, value, String(evaluated)],
          };
        }
        // Couldn't evaluate — return raw so caller can decide what to do.
        return { kind: "primitive", value, type: parentType, trail: [...trail, value] };
      }
      // Plain string literal (color, named value).
      return { kind: "primitive", value, type: parentType, trail: [...trail, value] };
    }
    if (typeof value === "number") {
      return { kind: "primitive", value, type: parentType, trail: [...trail, String(value)] };
    }
    if (isPlainObject(value)) {
      // Some composite values nest — best-effort: resolve as composition-ish.
      if (trail.length > MAX_REF_DEPTH) return null;
      const entries: Record<string, ResolvedValue> = {};
      for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
        const r = resolveAnyValue(child, [...trail, k], parentType);
        if (r) entries[k] = r;
      }
      return { kind: "composition", entries, trail };
    }
    return null;
  }

  function resolvePrimitive(
    raw: unknown,
    type: string,
    trail: string[]
  ): ResolvedValue | null {
    if (typeof raw === "number") {
      return { kind: "primitive", value: raw, type, trail: [...trail, String(raw)] };
    }
    if (typeof raw !== "string") return null;
    const ref = parseSingleReference(raw);
    if (ref) {
      if (trail.length > MAX_REF_DEPTH) return null;
      const leaf = index.get(ref);
      if (!leaf) return null;
      return resolveLeaf(leaf, [...trail, `{${ref}}`]);
    }
    // Math expression?
    if (/\{[^}]+\}/.test(raw)) {
      const evaluated = tryEvaluateExpression(raw, index, trail);
      if (evaluated !== null) {
        return {
          kind: "primitive",
          value: evaluated,
          type,
          trail: [...trail, raw, String(evaluated)],
        };
      }
      return { kind: "primitive", value: raw, type, trail: [...trail, raw] };
    }
    return { kind: "primitive", value: raw, type, trail: [...trail, raw] };
  }

  /**
   * Resolve a shadow layer object into the wire shape. Color is the only
   * field that may be a reference; offsets/blur/spread are typically
   * numeric literals or simple math.
   */
  function resolveShadowLayer(layer: unknown): ShadowLayer | null {
    if (!isPlainObject(layer)) return null;
    const obj = layer as Record<string, unknown>;
    const colorRaw = obj.color;
    const colorResolved =
      typeof colorRaw === "string"
        ? resolveAnyValue(colorRaw, [], "color")
        : null;
    const color =
      colorResolved && colorResolved.kind === "primitive"
        ? String(colorResolved.value)
        : typeof colorRaw === "string"
        ? colorRaw
        : "#000000";
    const x = numericResolve(obj.x);
    const y = numericResolve(obj.y);
    const blur = numericResolve(obj.blur);
    const spread = numericResolve(obj.spread);
    const t = String(obj.type ?? "dropShadow");
    const type: ShadowLayer["type"] = t === "innerShadow" ? "innerShadow" : "dropShadow";
    return { type, color, x, y, blur, spread };
  }

  function numericResolve(v: unknown): number {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return 0;
    const ref = parseSingleReference(v);
    if (ref) {
      const inner = resolve(ref);
      if (inner?.kind === "primitive" && typeof inner.value === "number") return inner.value;
      if (inner?.kind === "primitive" && typeof inner.value === "string") {
        const n = stripUnits(inner.value);
        if (Number.isFinite(n)) return n;
      }
      return 0;
    }
    if (/\{[^}]+\}/.test(v)) {
      const r = tryEvaluateExpression(v, index, []);
      if (r !== null) return r;
    }
    const n = stripUnits(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * Resolve a raw applied-token value that may not be a path — covers
   * the two non-path shapes Tokens Studio occasionally bakes onto a
   * node's `tokens` pluginData entry for composition tokens:
   *   1. An inline JSON-stringified composition object:
   *      `'{"fill":"{color.bg}","paddingTop":"16px"}'`
   *   2. An inline composition object (plain object, not a path string).
   * For plain paths, fall back to `resolve(path)`.
   */
  function resolveInline(raw: unknown, assumedType = "composition"): ResolvedValue | null {
    const obj = asCompositionObject(raw);
    if (obj) {
      const entries: Record<string, ResolvedValue> = {};
      for (const [propKey, propValue] of Object.entries(obj)) {
        const r = resolveAnyValue(propValue, [], assumedType);
        if (r) entries[propKey] = r;
      }
      return { kind: "composition", entries, trail: [] };
    }
    return null;
  }

  return { resolve, resolveInline, index };
}

/**
 * Does this string look like an inline JSON-stringified composition object?
 * Used by callers (apply-theme) to route applied-token values that aren't
 * catalog paths through the composition machinery instead of the index.
 * Intentionally narrow: starts + ends with braces and parses as an object.
 */
export function looksLikeInlineCompositionJson(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(t);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/**
 * Accept the two shapes a composition value can take: a real object, or
 * a JSON-stringified object (some older Tokens Studio exports bake the
 * composition inline as a string on the applied node instead of as a
 * reference). Returns null if the input isn't convertible to a plain
 * object — callers then decide whether to try the reference path.
 */
function asCompositionObject(v: unknown): Record<string, unknown> | null {
  if (isPlainObject(v)) return v;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function flattenSets(values: SetMap, enabledSets: string[], setStatuses?: Record<string, string>): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  // Phase 1: SOURCE sets (lower precedence — get overwritten by ENABLED)
  for (const setName of enabledSets) {
    if (setStatuses?.[setName] !== "source") continue;
    const tree = lookupSet(values, setName);
    if (!tree) continue;
    walk(tree, [], setName, "source", out);
  }
  // Phase 2: ENABLED sets (higher precedence — overwrite SOURCE)
  for (const setName of enabledSets) {
    if (setStatuses?.[setName] === "source") continue;
    const tree = lookupSet(values, setName);
    if (!tree) continue;
    walk(tree, [], setName, "enabled", out);
  }
  return out;
}

function lookupSet(values: SetMap, setName: string): unknown {
  if (setName in values) return values[setName];
  return null;
}

function walk(
  node: unknown,
  pathParts: string[],
  setName: string,
  status: "enabled" | "source",
  out: Map<string, Leaf>
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  if ("value" in obj || "$value" in obj) {
    const path = pathParts.join(".");
    if (!path) return;
    const value = (obj.$value ?? obj.value) as unknown;
    const type = String(obj.$type ?? obj.type ?? "");
    // Tokens Studio color-modifier extension, if present.
    const modifier = extractModifier(obj.$extensions);
    // Tokens Studio precedence: ENABLED always wins over SOURCE.
    // A SOURCE set can fill empty slots or overwrite other SOURCE entries,
    // but must never overwrite an ENABLED entry.
    const existing = out.get(path);
    if (existing && existing.status === "enabled" && status === "source") return;
    // Composition tokens MERGE across set overrides rather than replacing.
    // Tokens Studio's own plugin does this: the base set defines e.g.
    // `{fill, typography, opacity}` on a composition, and a brand override
    // only redeclares `{typography}`. If we treated the override as a full
    // replacement (as we would for a scalar token) the `fill` entry vanishes
    // and downstream raw writes lose the text-colour etc. Matching TS means
    // the override's entries shadow the base's entries at the INNER-PROP
    // level, not the whole-value level.
    if (
      existing &&
      existing.type === "composition" &&
      type === "composition" &&
      isPlainObject(existing.value) &&
      isPlainObject(value)
    ) {
      const merged: Record<string, unknown> = {
        ...(existing.value as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
      const leaf: Leaf = { value: merged, type, set: setName, status };
      if (modifier) leaf.modifier = modifier;
      out.set(path, leaf);
      return;
    }
    const leaf: Leaf = { value, type, set: setName, status };
    if (modifier) leaf.modifier = modifier;
    out.set(path, leaf);
    return;
  }
  for (const [k, child] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    walk(child, [...pathParts, k], setName, status, out);
  }
}

function parseSingleReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const inner = trimmed.slice(1, -1);
  if (inner.includes("{") || inner.includes("}")) return null;
  return inner;
}

/**
 * Pull a `ColorModifier` out of a token's `$extensions` block if present.
 * Shape per Tokens Studio: `{ "studio.tokens": { modify: { type, value,
 * space, color? } } }`. Returns null if absent or malformed.
 */
function extractModifier(extensions: unknown): ColorModifier | undefined {
  if (!extensions || typeof extensions !== "object") return undefined;
  const ts = (extensions as Record<string, unknown>)["studio.tokens"];
  if (!ts || typeof ts !== "object") return undefined;
  const m = (ts as Record<string, unknown>).modify;
  if (!m || typeof m !== "object") return undefined;
  const mm = m as Record<string, unknown>;
  const type = typeof mm.type === "string" ? mm.type.toLowerCase() : "";
  if (type !== "darken" && type !== "lighten" && type !== "alpha" && type !== "mix") return undefined;
  return {
    type: type as ColorModifier["type"],
    value: mm.value as number | string,
    space: (typeof mm.space === "string" ? mm.space.toLowerCase() : undefined) as ColorModifier["space"],
    color: typeof mm.color === "string" ? mm.color : undefined,
  };
}

/**
 * Strip Tokens-Studio-style unit suffixes ("16px", "1.25rem") and
 * coerce to a finite number. Returns NaN on failure so callers can
 * distinguish "couldn't parse" from "zero".
 */
function stripUnits(s: string): number {
  return Number(String(s).trim().replace(/(px|rem|em|%)\s*$/i, ""));
}

/**
 * Evaluate a math expression that may contain `{path}` references.
 * Substitutes refs first (each must resolve to a number), then runs a
 * tiny RPN evaluator over the result. Returns null if anything fails
 * (unresolvable ref, syntax error, division by zero, non-finite result)
 * — caller surfaces the original string as a skipped token.
 */
function tryEvaluateExpression(
  expr: string,
  index: Map<string, Leaf>,
  trail: string[]
): number | null {
  // Substitute refs.
  const REF = /\{([^}]+)\}/g;
  let subbed = expr;
  let m: RegExpExecArray | null;
  while ((m = REF.exec(expr)) !== null) {
    const path = m[1];
    if (trail.length > MAX_REF_DEPTH) return null;
    const leaf = index.get(path);
    if (!leaf) return null;
    let n: number;
    if (typeof leaf.value === "number") n = leaf.value;
    else if (typeof leaf.value === "string") {
      const innerRef = parseSingleReference(leaf.value);
      if (innerRef) {
        const inner = tryEvaluateExpression(`{${innerRef}}`, index, [...trail, leaf.value]);
        if (inner === null) return null;
        n = inner;
      } else if (/\{[^}]+\}/.test(leaf.value)) {
        const inner = tryEvaluateExpression(leaf.value, index, [...trail, leaf.value]);
        if (inner === null) return null;
        n = inner;
      } else {
        const stripped = stripUnits(leaf.value);
        if (!Number.isFinite(stripped)) return null;
        n = stripped;
      }
    } else return null;
    subbed = subbed.replace(m[0], String(n));
  }
  return safeEval(subbed);
}

/**
 * Tiny safe arithmetic evaluator. Tokenize → shunting-yard → eval.
 * Refuses anything that isn't number/operator/paren so we never run
 * untrusted code.
 */
function safeEval(expr: string): number | null {
  // Tokenize
  type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "lp" } | { t: "rp" };
  const tokens: Tok[] = [];
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === " " || c === "\t") { i++; continue; }
    if (c === "(") { tokens.push({ t: "lp" }); i++; continue; }
    if (c === ")") { tokens.push({ t: "rp" }); i++; continue; }
    if ("+-*/".includes(c)) {
      // Unary minus: treat as 0 - x by inserting a 0 if at start or after operator/lp.
      if (c === "-" && (tokens.length === 0 || tokens[tokens.length - 1].t === "op" || tokens[tokens.length - 1].t === "lp")) {
        tokens.push({ t: "num", v: 0 });
      }
      tokens.push({ t: "op", v: c });
      i++; continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
      const n = Number(expr.slice(i, j));
      if (!Number.isFinite(n)) return null;
      tokens.push({ t: "num", v: n });
      i = j; continue;
    }
    return null; // unexpected character
  }

  // Shunting-yard → RPN
  const out: Tok[] = [];
  const ops: Tok[] = [];
  const prec: Record<string, number> = { "+": 1, "-": 1, "*": 2, "/": 2 };
  for (const tok of tokens) {
    if (tok.t === "num") out.push(tok);
    else if (tok.t === "op") {
      while (ops.length) {
        const top = ops[ops.length - 1];
        if (top.t === "op" && prec[top.v] >= prec[tok.v]) {
          out.push(ops.pop()!);
        } else break;
      }
      ops.push(tok);
    } else if (tok.t === "lp") ops.push(tok);
    else if (tok.t === "rp") {
      while (ops.length && ops[ops.length - 1].t !== "lp") out.push(ops.pop()!);
      if (!ops.length) return null;
      ops.pop(); // discard lp
    }
  }
  while (ops.length) {
    const t = ops.pop()!;
    if (t.t === "lp" || t.t === "rp") return null;
    out.push(t);
  }

  // Evaluate
  const stack: number[] = [];
  for (const tok of out) {
    if (tok.t === "num") stack.push(tok.v);
    else if (tok.t === "op") {
      const b = stack.pop();
      const a = stack.pop();
      if (a === undefined || b === undefined) return null;
      let r: number;
      switch (tok.v) {
        case "+": r = a + b; break;
        case "-": r = a - b; break;
        case "*": r = a * b; break;
        case "/":
          if (b === 0) return null;
          r = a / b; break;
        default: return null;
      }
      stack.push(r);
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) return null;
  return stack[0];
}
