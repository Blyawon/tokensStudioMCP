/**
 * Provider router. Single entry point: `fetchCatalog(config, opts)`.
 *
 * The agent doesn't pick a fetcher — it passes the storage config (either
 * the one auto-discovered via `get_token_storage_config`, or a hand-built
 * override) and we dispatch to the matching provider.
 */

import type {
  AnyStorageConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
  StorageProvider,
} from "./types.js";
import { ProviderError } from "./types.js";

import { githubFetcher } from "./github.js";
import { gitlabFetcher } from "./gitlab.js";
import { urlFetcher } from "./url.js";
import { jsonbinFetcher } from "./jsonbin.js";
import { bitbucketFetcher } from "./bitbucket.js";
import { adoFetcher } from "./ado.js";
import { supernovaFetcher } from "./supernova.js";
import { tokensStudioFetcher } from "./tokens-studio.js";
import { localFetcher } from "./local.js";
import { resolveSecret } from "./secrets.js";
import { cacheCatalog, cacheKey, dedupeFetch, getCachedCatalog, invalidateCache } from "./cache.js";

const FETCHERS: Record<StorageProvider, ProviderFetcher> = {
  github: githubFetcher,
  gitlab: gitlabFetcher,
  url: urlFetcher,
  jsonbin: jsonbinFetcher,
  bitbucket: bitbucketFetcher,
  ado: adoFetcher,
  supernova: supernovaFetcher,
  tokensStudio: tokensStudioFetcher,
  tokensStudioOAuth: tokensStudioFetcher,
  local: localFetcher,
  file: localFetcher,
};

export async function fetchCatalog(
  config: AnyStorageConfig,
  opts: FetchOptions = {}
): Promise<FetchedCatalog> {
  const fetcher = FETCHERS[config.provider];
  if (!fetcher) {
    const supported = Object.keys(FETCHERS).join(", ");
    throw new ProviderError(
      config.provider as StorageProvider,
      `Unknown storage provider: ${config.provider}.`,
      `Supported providers: ${supported}.`
    );
  }
  // Resolve the secret once at the router so each fetcher stays sync-shape
  // and only ever receives the resolved value via opts.secret.
  const secret = await resolveSecret(config.provider, opts.secret);

  // Cache + dedupe. Skip cache when caller passes onProgress because
  // they're explicitly asking for live progress and a cache hit would
  // skip the progress events.
  const key = cacheKey(config, opts);
  if (!opts.onProgress) {
    const cached = getCachedCatalog(key);
    if (cached) return cached;
    return dedupeFetch(key, () => fetcher.fetch(config, { ...opts, secret }));
  }
  return fetcher.fetch(config, { ...opts, secret }).then((c) => cacheCatalog(key, c));
}

/** Drop every cached entry that matches the same source as `config`. */
export function invalidateCatalogCache(config: AnyStorageConfig): void {
  const targetProvider = config.provider;
  const c = config as unknown as Record<string, unknown>;
  invalidateCache((key) => {
    const parsed = JSON.parse(key) as unknown[];
    return (
      parsed[0] === targetProvider &&
      parsed[1] === (c.id ?? null) &&
      parsed[2] === (c.branch ?? null)
    );
  });
}

/**
 * Sniff a raw `storageType` blob (as Tokens Studio writes it on the file)
 * and coerce it into one of our typed configs. Tokens Studio uses both
 * "github"/"gitlab"/... and uppercase enums historically — we normalise
 * to the lowercase string union our fetchers expect.
 */
export function normaliseStorageConfig(raw: unknown): AnyStorageConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const provider = String(obj.provider ?? "").toLowerCase() as StorageProvider;
  if (!provider) return null;
  // Spread provider-specific fields through; types are validated by each
  // fetcher when it pulls what it needs.
  return { ...obj, provider } as AnyStorageConfig;
}

export type { AnyStorageConfig, FetchedCatalog, FetchOptions, StorageProvider } from "./types.js";
export { ProviderError } from "./types.js";
