/**
 * Tokens Studio (their hosted SaaS) provider. Same handler covers the
 * `tokensStudio` and `tokensStudioOAuth` provider variants — both fetch
 * from the same API surface, only the auth flow differs.
 *
 * Auth: `TOKENS_STUDIO_API_KEY` (a personal access token from
 * https://app.tokens.studio).
 */

import type {
  TokensStudioConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

const DEFAULT_API = "https://app.tokens.studio";

export const tokensStudioFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (
      rawConfig.provider !== "tokensStudio" &&
      rawConfig.provider !== "tokensStudioOAuth"
    ) {
      throw new ProviderError(
        rawConfig.provider as never,
        `wrong provider: ${rawConfig.provider}`
      );
    }
    const config = rawConfig as TokensStudioConfig;
    const token = opts.secret ?? getSecret("tokensStudio");
    if (!token) {
      throw new ProviderError(
        config.provider,
        "Missing API key",
        "Set TOKENS_STUDIO_API_KEY to a token from https://app.tokens.studio."
      );
    }
    const apiBase = (config.baseUrl?.replace(/\/$/, "")) || DEFAULT_API;
    const url = new URL(
      `/api/orgs/${encodeURIComponent(config.orgId)}/projects/${encodeURIComponent(config.id)}/tokens`,
      apiBase
    );
    if (config.branch) url.searchParams.set("branch", config.branch);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new ProviderError(
        config.provider,
        `Tokens Studio API ${res.status} ${res.statusText}`,
        res.status === 401 ? "Auth failed — check TOKENS_STUDIO_API_KEY." : undefined
      );
    }
    return {
      values: await res.json(),
      source: {
        provider: config.provider,
        description: `tokens-studio://${config.orgId}/${config.id}${
          config.branch ? "@" + config.branch : ""
        }`,
        filesFetched: 1,
      },
    };
  },
};
