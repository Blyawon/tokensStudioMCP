/**
 * Supernova provider — pulls a token export from the Supernova design
 * system platform. Supernova exposes a typed SDK; we use their public
 * REST endpoint directly to avoid pulling a multi-MB SDK into the MCP
 * server bundle.
 *
 * The exact endpoint shape varies by deployment — we accept a
 * `designSystemUrl` from Tokens Studio's config and call it as a
 * bearer-authed GET. If your Supernova export needs a different shape,
 * use the URL provider with an explicit endpoint instead.
 */

import type {
  SupernovaConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

export const supernovaFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "supernova") {
      throw new ProviderError("supernova", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as SupernovaConfig;
    const token = opts.secret ?? getSecret("supernova");
    if (!token) {
      throw new ProviderError(
        "supernova",
        "Missing API key",
        "Set TOKENS_STUDIO_SUPERNOVA_KEY to a Supernova access token."
      );
    }
    const res = await fetch(config.designSystemUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new ProviderError(
        "supernova",
        `Supernova ${res.status} ${res.statusText} for ${config.designSystemUrl}`
      );
    }
    return {
      values: await res.json(),
      source: {
        provider: "supernova",
        description: `supernova://${config.designSystemUrl}`,
        filesFetched: 1,
      },
    };
  },
};
