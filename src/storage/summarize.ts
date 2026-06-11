/**
 * Compact summaries of a fetched token catalog for plugin/UI consumption.
 * Used by bridge handlers and the get_token_catalog / list_themes tools.
 */

export interface CatalogSummary {
  sets: string[];
  tokenCount: number;
  themeCount: number;
}

export function summariseCatalog(catalog: { values: unknown; themes?: unknown }): CatalogSummary {
  const sets: string[] = [];
  let tokenCount = 0;
  const values = catalog.values;
  if (values && typeof values === "object" && !Array.isArray(values)) {
    const top = values as Record<string, unknown>;
    const dataKeys = Object.keys(top).filter((k) => !k.startsWith("$"));
    const looksMultiSet =
      dataKeys.length > 0 &&
      dataKeys.every((k) => {
        const v = top[k];
        if (!v || typeof v !== "object" || Array.isArray(v)) return false;
        return !isTokenLeaf(v as Record<string, unknown>);
      });
    if (looksMultiSet) {
      for (const k of dataKeys) {
        sets.push(k);
        tokenCount += countTokenLeaves(top[k]);
      }
    } else {
      tokenCount += countTokenLeaves(values);
    }
  }
  const themeCount = Array.isArray(catalog.themes) ? catalog.themes.length : 0;
  return { sets, tokenCount, themeCount };
}

export function isTokenLeaf(obj: Record<string, unknown>): boolean {
  return "value" in obj || "$value" in obj;
}

export function countTokenLeaves(node: unknown): number {
  if (!node || typeof node !== "object" || Array.isArray(node)) return 0;
  const obj = node as Record<string, unknown>;
  if (isTokenLeaf(obj)) return 1;
  let count = 0;
  for (const v of Object.values(obj)) count += countTokenLeaves(v);
  return count;
}
