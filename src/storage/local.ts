/**
 * "local" provider — there is no remote sync; the canonical token catalog
 * lives in the file's own shared plugin data (the `values` blob Tokens
 * Studio writes on every change). The bridge already exposes that via
 * `getLocalCatalog`, so this fetcher just calls back through.
 *
 * Used for both `provider: "local"` and `provider: "file"` configs.
 */

import type {
  AnyStorageConfig,
  FetchOptions,
  FetchedCatalog,
  ProviderFetcher,
} from "./types.js";
import { ProviderError } from "./types.js";
import { getBridge } from "../bridge/server.js";

export const localFetcher: ProviderFetcher = {
  async fetch(_config: AnyStorageConfig, _opts: FetchOptions = {}): Promise<FetchedCatalog> {
    const bridge = getBridge();
    if (!bridge.isConnected()) {
      throw new ProviderError(
        "local",
        "Plugin not connected — local catalog can only be read via the Figma plugin.",
        "Open the 'Tokens Studio MCP Bridge' plugin in Figma and retry."
      );
    }
    const result = (await bridge.request("getLocalCatalog", {})) as {
      hasLocalValues: boolean;
      values: unknown;
      isCompressed: boolean;
      parseError: string | null;
    };
    if (!result.hasLocalValues) {
      throw new ProviderError(
        "local",
        "This file has no Tokens Studio data on it.",
        "Has the Tokens Studio plugin ever been opened on this file?"
      );
    }
    if (result.parseError) {
      throw new ProviderError(
        "local",
        `Could not parse local values blob: ${result.parseError}`,
        result.isCompressed
          ? "The blob looks compressed — Tokens Studio sometimes gzips its `values` payload. Open Tokens Studio in Figma and disable compression in its settings, or push to a sync source."
          : undefined
      );
    }
    return {
      values: result.values,
      source: {
        provider: "local",
        description: "local://figma-shared-plugin-data",
        filesFetched: 1,
      },
    };
  },
};
