/**
 * Plugin-initiated catalog pull. The plugin UI calls this to refresh its
 * local copy of the token catalog — either via the server's resolved
 * storage config or via an inline override passed from the UI.
 */

import { fetchCatalog, normaliseStorageConfig, ProviderError, type AnyStorageConfig } from "../../storage/index.js";
import { resolveStorageConfig } from "../../resolve-storage.js";
import { summariseCatalog } from "../../storage/summarize.js";

export async function handlePullCatalogRequest(
  params: unknown,
  ctx: { progress: (info: { current: number; total: number; message?: string }) => void }
): Promise<unknown> {
  const args = (params ?? {}) as { config?: unknown; secret?: string };
  const fetchedAt = new Date().toISOString();
  try {
    let config: AnyStorageConfig;
    if (args.config) {
      const cfg = normaliseStorageConfig(args.config);
      if (!cfg) {
        return {
          ok: false,
          fetchedAt,
          error: { message: "Override config could not be parsed — needs at least { provider }." },
        };
      }
      config = cfg;
    } else {
      config = await resolveStorageConfig(undefined);
    }
    const catalog = await fetchCatalog(config, {
      secret: args.secret,
      onProgress: (info) => ctx.progress(info),
    });
    return {
      ok: true,
      fetchedAt,
      source: catalog.source,
      summary: summariseCatalog(catalog),
    };
  } catch (err) {
    if (err instanceof ProviderError) {
      return {
        ok: false,
        fetchedAt,
        error: { message: err.message, hint: err.hint },
      };
    }
    return {
      ok: false,
      fetchedAt,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}
