/// <reference types="@figma/plugin-typings" />

/**
 * Storage operations — reading/writing token source config, secrets,
 * preferences, and Tokens Studio file metadata.
 */

import {
  TOKENS_NAMESPACE,
  OVERRIDE_KEY,
  APPLY_PREFS_KEY,
  APPLY_PREFS_DEFAULTS,
  secretKey,
  type NodeRemap,
} from "./types.js";

// ---------------------------------------------------------------------------
// Storage config (Tokens Studio's sync provider settings)
// ---------------------------------------------------------------------------

export function opGetStorageConfig(): unknown {
  const storageType = readJson(figma.root, "storageType");
  const themes = readJson(figma.root, "themes");
  const usedTokenSet = readJson(figma.root, "usedTokenSet");
  const activeTheme = readJson(figma.root, "activeTheme");
  const tokenFormat = readJson(figma.root, "tokenFormat");
  const version = figma.root.getSharedPluginData("tokens", "version") || null;
  const updatedAt = figma.root.getSharedPluginData("tokens", "updatedAt") || null;
  return {
    storageType, themes, usedTokenSet, activeTheme, tokenFormat,
    version, updatedAt,
    fileName: figma.root.name ?? null,
    fileKey: figma.fileKey ?? null,
  };
}

export function opGetLocalCatalog(): unknown {
  const raw = figma.root.getSharedPluginData("tokens", "values");
  const isCompressed = figma.root.getSharedPluginData("tokens", "isCompressed") === "true";
  let values: unknown = null;
  let parseError: string | null = null;
  if (raw) {
    try { values = JSON.parse(raw); }
    catch (err) { parseError = err instanceof Error ? err.message : String(err); }
  }
  return { hasLocalValues: !!raw, isCompressed, values, parseError };
}

function readJson(node: BaseNode, key: string): unknown {
  const raw = node.getSharedPluginData("tokens", key);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return raw; }
}

// ---------------------------------------------------------------------------
// Storage override (per-user, persisted in clientStorage)
// ---------------------------------------------------------------------------

export async function opGetStorageOverride(): Promise<unknown> {
  const override = await figma.clientStorage.getAsync(OVERRIDE_KEY);
  return { override: override ?? null };
}

export async function opSetStorageOverride(params: unknown): Promise<unknown> {
  const next = (params as { override?: unknown } | null)?.override;
  if (next == null) {
    await figma.clientStorage.deleteAsync(OVERRIDE_KEY);
  } else {
    await figma.clientStorage.setAsync(OVERRIDE_KEY, next);
  }
  figma.ui.postMessage({ type: "set-storage-override", override: next ?? null });
  return { ok: true as const };
}

// ---------------------------------------------------------------------------
// Secrets (per-user credentials for token providers)
// ---------------------------------------------------------------------------

export async function opGetSecret(params: unknown): Promise<unknown> {
  const provider = (params as { provider?: string } | null)?.provider;
  if (typeof provider !== "string" || !provider) {
    throw new Error("getSecret needs { provider }");
  }
  const value = await figma.clientStorage.getAsync(secretKey(provider));
  return {
    provider,
    secret: typeof value === "string" && value.length > 0 ? value : null,
  };
}

export function sendSecretStatus(provider: string): void {
  figma.clientStorage.getAsync(secretKey(provider)).then((value) => {
    figma.ui.postMessage({
      type: "secret-status",
      provider,
      configured: typeof value === "string" && value.length > 0,
    });
  });
}

// ---------------------------------------------------------------------------
// Apply preferences
// ---------------------------------------------------------------------------

export async function opGetApplyPrefs(): Promise<unknown> {
  const stored = await figma.clientStorage.getAsync(APPLY_PREFS_KEY);
  const merged = Object.assign({}, APPLY_PREFS_DEFAULTS, stored ?? {});
  return { prefs: merged };
}

// ---------------------------------------------------------------------------
// Node tokens
// ---------------------------------------------------------------------------

export async function opGetNodeTokens(params: unknown): Promise<unknown> {
  const nodeId = (params as { nodeId?: string } | null)?.nodeId;
  if (typeof nodeId !== "string") throw new Error("getNodeTokens needs { nodeId }");
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) throw new Error(`Node ${nodeId} not found`);
  const keys = node.getSharedPluginDataKeys(TOKENS_NAMESPACE);
  const tokens: Record<string, string> = {};
  for (const key of keys) {
    tokens[key] = node.getSharedPluginData(TOKENS_NAMESPACE, key);
  }
  return { nodeId, tokens };
}

// ---------------------------------------------------------------------------
// Token remap (update applied-token metadata on nodes)
// ---------------------------------------------------------------------------

export async function opApplyRemap(params: unknown): Promise<unknown> {
  const nodes = (params as { nodes?: NodeRemap[] } | null)?.nodes;
  const planId = (params as { planId?: string } | null)?.planId;
  if (!Array.isArray(nodes)) throw new Error("applyRemap needs { nodes: [...] }");

  let applied = 0;
  const skipped: Array<{ nodeId: string; reason: string }> = [];
  const errors: Array<{ nodeId: string; property?: string; message: string }> = [];

  for (const entry of nodes) {
    if (!entry || typeof entry.nodeId !== "string") {
      skipped.push({ nodeId: String(entry?.nodeId ?? "?"), reason: "missing nodeId" });
      continue;
    }
    let node: BaseNode | null;
    try {
      node = await figma.getNodeByIdAsync(entry.nodeId);
    } catch (err) {
      errors.push({
        nodeId: entry.nodeId,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!node) {
      skipped.push({ nodeId: entry.nodeId, reason: "node no longer exists" });
      continue;
    }

    for (const [prop, newValue] of Object.entries(entry.set ?? {})) {
      try {
        node.setSharedPluginData(TOKENS_NAMESPACE, prop, JSON.stringify(newValue));
        applied += 1;
      } catch (err) {
        errors.push({
          nodeId: entry.nodeId, property: prop,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const prop of entry.clear ?? []) {
      try {
        node.setSharedPluginData(TOKENS_NAMESPACE, prop, "");
        applied += 1;
      } catch (err) {
        errors.push({
          nodeId: entry.nodeId, property: prop,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  figma.commitUndo();

  if (applied > 0 || errors.length > 0) {
    const parts: string[] = [];
    if (applied > 0) parts.push(`Remapped ${applied} prop${applied === 1 ? "" : "s"} on ${nodes.length} node${nodes.length === 1 ? "" : "s"}`);
    if (errors.length > 0) parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
    figma.notify(parts.join(" · "));
  }

  return { applied, skipped, errors, planId };
}
