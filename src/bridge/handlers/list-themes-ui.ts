/**
 * Plugin-initiated theme listing. Returns a light theme summary
 * (name + enabled set count) plus the currently active theme, so the
 * plugin UI can render the theme picker without re-fetching the whole
 * catalog.
 */

import { getBridge } from "../server.js";
import { fetchCatalog } from "../../storage/index.js";
import { resolveStorageConfig } from "../../resolve-storage.js";
import { debugLog } from "../../tools/shared.js";

export async function handleListThemesFromUIRequest(_params: unknown): Promise<unknown> {
  try {
    const config = await resolveStorageConfig(undefined);
    const catalog = await fetchCatalog(config);
    const themes = Array.isArray(catalog.themes)
      ? (catalog.themes as Array<{
          name: string;
          id?: string;
          group?: string;
          selectedTokenSets?: Record<string, string>;
        }>)
      : [];
    const summary = themes.map((t) => ({
      name: t.name,
      id: t.id,
      group: t.group,
      enabledSetCount: Object.values(t.selectedTokenSets ?? {}).filter(
        (v) => v === "enabled" || v === "source"
      ).length,
    }));

    let activeTheme: string | null = null;
    try {
      const cfg = (await getBridge().request("getStorageConfig", {})) as {
        activeTheme?: unknown;
      };
      if (typeof cfg.activeTheme === "string") activeTheme = cfg.activeTheme;
      else if (cfg.activeTheme && typeof cfg.activeTheme === "object") {
        const v = Object.values(cfg.activeTheme as Record<string, unknown>)[0];
        if (typeof v === "string") activeTheme = v;
      }
    } catch (err) {
      // Active theme is best-effort; themes still list if the lookup fails.
      debugLog("listThemesFromUI:getStorageConfig", err);
    }

    return { ok: true, themes: summary, activeTheme };
  } catch (err) {
    return {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}
