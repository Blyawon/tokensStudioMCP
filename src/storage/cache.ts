/**
 * In-memory catalog cache. A typical multi-file pull (e.g. the Bosch
 * repo's 453 files) takes ~30s; without a cache, back-to-back
 * `apply_theme` / `list_themes` / `suggest_tokens` calls each repeat the
 * full fetch. 60-second TTL is short enough that authoring feedback
 * loops still see recent edits, long enough that one chat session shares
 * the work.
 *
 * Keyed by a stable signature of the storage config so two different
 * branches don't collide. The cache is invalidated explicitly after a
 * successful `commit_and_push` so the very next read picks up the new
 * commit instead of waiting out the TTL.
 */

import type { AnyStorageConfig, FetchedCatalog, FetchOptions } from "./types.js";

interface Entry {
  catalog: FetchedCatalog;
  expiresAt: number;
  /** The promise itself is cached so concurrent requests share the fetch. */
  pending?: Promise<FetchedCatalog>;
}

const TTL_MS = 60_000;
const cache = new Map<string, Entry>();

export function cacheKey(config: AnyStorageConfig, opts: FetchOptions = {}): string {
  const secretFingerprint = opts.secret ? "sec1" : "sec0";
  const c = config as unknown as Record<string, unknown>;
  const additionalHeaders = c.additionalHeaders && typeof c.additionalHeaders === "object"
    ? Object.entries(c.additionalHeaders as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
    : null;
  return JSON.stringify([
    config.provider,
    c.id ?? null,
    c.branch ?? null,
    c.filePath ?? null,
    c.baseUrl ?? null,
    c.orgId ?? null,
    c.designSystemUrl ?? null,
    additionalHeaders,
    secretFingerprint,
  ]);
}

export function getCachedCatalog(key: string): FetchedCatalog | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.catalog;
}

/**
 * Cache a freshly-fetched catalog. Returns the catalog so callers can
 * one-line: `return cacheCatalog(key, await fetcher.fetch(...))`.
 */
export function cacheCatalog(key: string, catalog: FetchedCatalog): FetchedCatalog {
  cache.set(key, { catalog, expiresAt: Date.now() + TTL_MS });
  return catalog;
}

/**
 * Invalidate every entry whose key matches the predicate. Used after
 * `commit_and_push` succeeds so the next `get_token_catalog` doesn't
 * serve a stale snapshot from before the commit.
 */
export function invalidateCache(predicate: (key: string) => boolean): void {
  for (const k of Array.from(cache.keys())) {
    if (predicate(k)) cache.delete(k);
  }
}

/**
 * Track an in-flight fetch so concurrent calls dedupe to a single round-
 * trip. Caller wraps the actual fetch in this so the cache holds the
 * promise during fetch + the resolved entry after.
 */
export async function dedupeFetch(
  key: string,
  fetcher: () => Promise<FetchedCatalog>
): Promise<FetchedCatalog> {
  const existing = cache.get(key);
  if (existing?.pending) return existing.pending;

  const promise = fetcher().then((catalog) => {
    cacheCatalog(key, catalog);
    return catalog;
  });
  // Park the promise on a placeholder entry so concurrent callers see it.
  cache.set(key, { catalog: existing?.catalog ?? ({} as FetchedCatalog), expiresAt: 0, pending: promise });
  try {
    return await promise;
  } finally {
    // Clear the pending marker — final entry is the resolved catalog.
    const e = cache.get(key);
    if (e) e.pending = undefined;
  }
}
