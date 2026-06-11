/**
 * JSONBin provider — fetches the latest record from a bin.
 * https://jsonbin.io/
 *
 * Auth: `TOKENS_STUDIO_JSONBIN_KEY` (X-Master-Key for private bins).
 */

import type {
  JsonBinConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getSecret } from "./secrets.js";

const API_BASE = "https://api.jsonbin.io/v3";

export const jsonbinFetcher: ProviderFetcher = {
  async fetch(rawConfig, opts = {}): Promise<FetchedCatalog> {
    if (rawConfig.provider !== "jsonbin") {
      throw new ProviderError("jsonbin", `wrong provider: ${rawConfig.provider}`);
    }
    const config = rawConfig as JsonBinConfig;
    const token = opts.secret ?? getSecret("jsonbin");

    const url = `${API_BASE}/b/${config.id}/latest`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["X-Master-Key"] = token;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new ProviderError(
        "jsonbin",
        `JSONBin ${res.status} ${res.statusText} for bin ${config.id}`,
        res.status === 401
          ? "Auth failed — set TOKENS_STUDIO_JSONBIN_KEY to your master key."
          : undefined
      );
    }
    const body = (await res.json()) as { record?: unknown };
    return {
      values: body.record ?? null,
      source: {
        provider: "jsonbin",
        description: `jsonbin://${config.id}`,
        filesFetched: 1,
      },
    };
  },
};
