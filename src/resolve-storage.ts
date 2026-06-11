/**
 * Storage config resolution — shared by MCP tools and apply-theme.
 * Priority:  explicit override → plugin-saved override → auto-discovered → local fallback.
 */

import { getBridge } from "./bridge/server.js";
import { normaliseStorageConfig, type AnyStorageConfig } from "./storage/index.js";

export async function resolveStorageConfig(
  override: Record<string, unknown> | undefined
): Promise<AnyStorageConfig> {
  if (override) {
    const cfg = normaliseStorageConfig(override);
    if (!cfg) {
      throw new Error(
        "override storage config could not be parsed — needs at least { provider }."
      );
    }
    return cfg;
  }
  const bridge = getBridge();
  await bridge.start();
  if (!bridge.isConnected()) {
    throw new Error(
      "Plugin not connected — open the Tokens Studio MCP Bridge plugin in Figma " +
        "to auto-discover the storage config, or pass `override` directly."
    );
  }
  const saved = (await bridge.request("getStorageOverride", {})) as {
    override: unknown;
  };
  if (saved.override) {
    const cfg = normaliseStorageConfig(saved.override);
    if (cfg) return cfg;
  }
  const result = (await bridge.request("getStorageConfig", {})) as {
    storageType: unknown;
  };
  const cfg = normaliseStorageConfig(result.storageType);
  if (!cfg) {
    return { provider: "local" };
  }
  return cfg;
}
