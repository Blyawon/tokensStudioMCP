/**
 * Tolerant token-set ingester.
 *
 * The user pastes whatever JSON they have — Tokens Studio export, a single
 * set, a DTCG file, a flat list of paths, or a loose blob. We never throw
 * on unknown shape: anything we can't make sense of becomes a warning and
 * the matcher proceeds with whatever IS parseable.
 *
 * Output is a flat `TokenCatalog` so the matcher doesn't have to care
 * which input shape it came from.
 */

import type { CatalogToken, CatalogTheme, TokenCatalog } from "./types.js";

/** Top-level keys that Tokens Studio reserves for plugin-internal data. */
const META_KEYS = new Set(["$themes", "$metadata"]);

/**
 * Parse the raw input into a JS object. Strings get JSON.parse'd; objects
 * pass through. Anything else is ignored.
 */
function coerceToObject(input: unknown): { obj: unknown; warnings: string[] } {
  const warnings: string[] = [];
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) return { obj: null, warnings: ["Input was an empty string."] };
    try {
      return { obj: JSON.parse(trimmed), warnings };
    } catch (err) {
      warnings.push(
        `Could not JSON.parse the input — proceeding with no tokens. (${
          err instanceof Error ? err.message : String(err)
        })`
      );
      return { obj: null, warnings };
    }
  }
  return { obj: input, warnings };
}

export function ingestTokenSet(input: unknown): TokenCatalog {
  const { obj, warnings } = coerceToObject(input);
  const tokens: CatalogToken[] = [];
  const themes: CatalogTheme[] = [];

  if (obj == null) return { tokens, themes, warnings };

  // Flat array of paths — user pasted just names.
  if (Array.isArray(obj)) {
    for (const entry of obj) {
      if (typeof entry === "string") tokens.push({ path: entry });
    }
    return { tokens, themes, warnings };
  }

  if (typeof obj !== "object") {
    warnings.push(
      `Unsupported top-level input of type ${typeof obj} — expected an object, array, or JSON string.`
    );
    return { tokens, themes, warnings };
  }

  const top = obj as Record<string, unknown>;

  // `{ color: ["color.x.y"], spacing: ["..."] }` — flat list keyed by type.
  if (isFlatListByType(top)) {
    for (const [type, list] of Object.entries(top)) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry === "string") tokens.push({ path: entry, type });
      }
    }
    return { tokens, themes, warnings };
  }

  // Tokens Studio export — `$themes` / `$metadata` may be present.
  const themesRaw = top.$themes;
  if (Array.isArray(themesRaw)) {
    for (const t of themesRaw) {
      if (
        t &&
        typeof t === "object" &&
        typeof (t as Record<string, unknown>).name === "string" &&
        typeof (t as Record<string, unknown>).selectedTokenSets === "object"
      ) {
        themes.push({
          name: (t as { name: string }).name,
          selectedTokenSets: (t as { selectedTokenSets: Record<string, string> })
            .selectedTokenSets,
        });
      }
    }
  }

  // Decide whether the top-level keys look like SETS (Tokens Studio
  // multi-set export) or like a single set's groups. The cheap heuristic:
  // if EVERY non-meta top-level value is a plain object whose own values
  // are also plain objects (groups → tokens), AND none of those top-level
  // values are themselves token leaves (no `value`/`$value`), we treat the
  // top level as the set layer.
  const dataKeys = Object.keys(top).filter((k) => !META_KEYS.has(k));
  const looksLikeMultiSet = dataKeys.length > 0 && dataKeys.every((k) => {
    const v = top[k];
    if (!isPlainObject(v)) return false;
    if (isTokenLeaf(v)) return false;
    return true;
  });

  if (looksLikeMultiSet) {
    for (const setName of dataKeys) {
      walkTree(top[setName], [], setName, tokens);
    }
  } else {
    walkTree(top, [], undefined, tokens);
  }

  if (tokens.length === 0) {
    warnings.push(
      "No tokens were recognised in the input. Pasted shape didn't match Tokens " +
        "Studio export, DTCG, or a flat list of paths."
    );
  }

  return { tokens, themes, warnings };
}

/**
 * Recursively walk a tree of `{ group: { name: { value, type } } }`. The
 * traversal stops at any node that looks like a token leaf (has `value` or
 * `$value`). Anything else with object children is treated as a group.
 */
function walkTree(
  node: unknown,
  pathParts: string[],
  setName: string | undefined,
  out: CatalogToken[]
): void {
  if (!isPlainObject(node)) return;

  if (isTokenLeaf(node)) {
    const path = pathParts.join(".");
    if (!path) return;
    out.push({
      path,
      type: extractType(node),
      value: extractValue(node),
      set: setName,
    });
    return;
  }

  for (const [key, child] of Object.entries(node)) {
    if (META_KEYS.has(key)) continue;
    walkTree(child, [...pathParts, key], setName, out);
  }
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return (
    x != null &&
    typeof x === "object" &&
    !Array.isArray(x) &&
    Object.getPrototypeOf(x) !== null
      ? Object.getPrototypeOf(x) === Object.prototype || Object.getPrototypeOf(x) === null
      : true
  );
}

function isTokenLeaf(node: Record<string, unknown>): boolean {
  return "value" in node || "$value" in node;
}

function extractValue(node: Record<string, unknown>): unknown {
  if ("$value" in node) return node.$value;
  return node.value;
}

function extractType(node: Record<string, unknown>): string | undefined {
  const t = node.$type ?? node.type;
  return typeof t === "string" ? t : undefined;
}

/**
 * Detect the `{ color: [...], spacing: [...] }` shape: every value must be
 * a non-empty array of strings. Pure-string-array members win.
 */
function isFlatListByType(top: Record<string, unknown>): boolean {
  const entries = Object.entries(top).filter(([k]) => !META_KEYS.has(k));
  if (entries.length === 0) return false;
  return entries.every(
    ([, v]) =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((item) => typeof item === "string")
  );
}
