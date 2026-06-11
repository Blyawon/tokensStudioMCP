/**
 * URL provider — plain HTTP GET to a JSON endpoint.
 *
 * Optional: `TOKENS_STUDIO_URL_TOKEN` is sent as a `Bearer` if set.
 * Tokens Studio also supports custom headers; the file's storageType blob
 * may carry them on `additionalHeaders` and we forward them.
 */

import type {
  UrlConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

export const urlFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "url") {
      throw new ProviderError("url", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as UrlConfig;
    const token = opts.secret ?? getSecret("url");

    const headers: Record<string, string> = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (config.additionalHeaders) {
      for (const [k, v] of Object.entries(config.additionalHeaders)) headers[k] = v;
    }

    const res = await fetch(config.id, { headers });
    if (!res.ok) {
      throw new ProviderError(
        "url",
        `URL fetch ${res.status} ${res.statusText} for ${config.id}`
      );
    }
    const json = await res.json();
    return {
      values: json,
      source: { provider: "url", description: `url://${config.id}`, filesFetched: 1 },
    };
  },
};
