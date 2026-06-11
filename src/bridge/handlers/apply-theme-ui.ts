/**
 * Plugin-initiated theme apply. Holds the per-process serialization lock
 * so concurrent applies from the UI don't interleave their writes. The
 * lock also guards clearFingerprintCache() since that's a write to the
 * shared apply-theme cache.
 */

import { getBridge } from "../server.js";
import { applyTheme, clearFingerprintCache, type ProgressContext } from "../../apply-theme.js";

// Serialization lock — prevents concurrent theme applies from interleaving
// writes. Each call waits for the previous to finish before starting.
let applyThemeLock: Promise<unknown> = Promise.resolve();

export async function handleApplyThemeFromUIRequest(
  params: unknown,
  ctx: ProgressContext
): Promise<unknown> {
  const prev = applyThemeLock;
  let release!: () => void;
  applyThemeLock = new Promise<void>(r => { release = r; });
  await prev;

  const args = (params ?? {}) as {
    themeName?: string;
    nodeId?: string;
    scope?: "selection" | "currentPage" | "document";
    skipHidden?: boolean;
    bindingMode?: "auto" | "always" | "never";
    dryRun?: boolean;
  };
  if (!args.themeName) { release(); return { ok: false, error: { message: "themeName required" } }; }

  // Clear fingerprint cache before UI-initiated applies. The cache keys
  // include themeName but NOT resolved values — switching light→dark→light
  // would cache-hit on the first light result and skip re-applying.
  clearFingerprintCache();

  const prefs = await getApplyPrefsFromBridge();
  const status = getBridge().status();
  const fileKey = status.fileKey ?? "";

  try {
    const result = await applyTheme(
      { fileKey, nodeId: args.nodeId },
      {
        themeName: args.themeName,
        skipHidden: args.skipHidden ?? prefs.skipHidden,
        onlyColor: false,
        bindingMode: args.bindingMode ?? (prefs.useVariables ? "auto" : "never"),
        setActive: true,
        scope: args.scope ?? "currentPage",
        dryRun: args.dryRun ?? false,
      },
      ctx
    );
    return { ok: true, result };
  } catch (err) {
    return {
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    release();
  }
}

async function getApplyPrefsFromBridge(): Promise<{ skipHidden: boolean; useVariables: boolean }> {
  const bridge = getBridge();
  if (!bridge.isConnected()) return { skipHidden: true, useVariables: true };
  try {
    const r = (await bridge.request("getApplyPrefs", {})) as {
      prefs: { skipHidden?: boolean; useVariables?: boolean };
    };
    return {
      skipHidden: r.prefs?.skipHidden ?? true,
      useVariables: r.prefs?.useVariables ?? true,
    };
  } catch {
    return { skipHidden: true, useVariables: true };
  }
}
