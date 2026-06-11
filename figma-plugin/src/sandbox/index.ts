/// <reference types="@figma/plugin-typings" />

/**
 * Plugin sandbox entry point. Shows the UI, registers event listeners,
 * and routes messages between the UI iframe, the Figma Plugin API, and
 * the MCP bridge (via WebSocket relay through the UI).
 *
 * This file is intentionally thin — business logic lives in sibling modules:
 *   - types.ts       — constants, interfaces, frame type guards
 *   - discovery.ts   — node enumeration (findAllWithCriteria + walk fallback)
 *   - storage.ts     — storage config, secrets, preferences, remap
 *   - visual-writes.ts — batched visual write application + undo
 *   - color.ts       — color parsing, paint caching, numeric helpers
 */

import {
  PLUGIN_VERSION,
  OVERRIDE_KEY,
  APPLY_PREFS_KEY,
  APPLY_PREFS_DEFAULTS,
  UNDO_INDEX_KEY,
  UNDO_OP_PREFIX,
  secretKey,
  isRequestFrame,
  type RequestFrame,
  type ResponseFrame,
  type VisualWriteIn,
  type ApplyVisualWritesParams,
} from "./types.js";
import { opEnumerateTokenizedNodes } from "./discovery.js";
import { opInspectBoundVariables } from "./inspect.js";
import {
  opGetStorageConfig,
  opGetLocalCatalog,
  opGetStorageOverride,
  opSetStorageOverride,
  opGetSecret,
  opGetApplyPrefs,
  opGetNodeTokens,
  opApplyRemap,
  sendSecretStatus,
} from "./storage.js";
import { opApplyVisualWrites } from "./visual-writes.js";
import { opEvalCode } from "./eval.js";
import { opNodeOp } from "./node-ops.js";

// ---------------------------------------------------------------------------
// UI initialization
// ---------------------------------------------------------------------------

figma.showUI(__html__, {
  width: 400,
  height: 600,
  title: "Tokens Studio MCP Bridge",
});

// ---------------------------------------------------------------------------
// Live target: push selection changes to the UI
// ---------------------------------------------------------------------------

function buildLiveTarget(): {
  fileKey: string;
  nodeId: string | null;
  name: string | null;
  url: string;
} | null {
  // figma.fileKey requires `enablePrivatePluginApi: true` in manifest.json
  // AND a private/dev-installed plugin context. Without both, figma.fileKey
  // is undefined and the UI can't build URLs or call REST-based server
  // tools — so we drop the live-target update rather than ship half-valid
  // data that protocol schemas would reject downstream.
  const fileKey = figma.fileKey;
  if (!fileKey) return null;
  // In dynamic-page mode `figma.currentPage` access can throw transiently
  // while Figma swaps pages — return null instead of crashing the
  // selectionchange/currentpagechange listeners.
  try {
    const sel = figma.currentPage.selection;
    const nodeId = sel.length > 0 ? sel[0].id : null;
    const name = sel.length > 0 ? sel[0].name : figma.currentPage.name;
    const nodeParam = nodeId ? `?node-id=${nodeId.replaceAll(":", "-")}` : "";
    const url = `https://www.figma.com/design/${fileKey}/${encodeURIComponent(figma.root.name || "file")}${nodeParam}`;
    return { fileKey, nodeId, name, url };
  } catch {
    return null;
  }
}

function pushLiveTarget(): void {
  figma.ui.postMessage({ type: "live-target", target: buildLiveTarget() });
}

figma.on("selectionchange", pushLiveTarget);
figma.on("currentpagechange", pushLiveTarget);

// ---------------------------------------------------------------------------
// Theme switching
// ---------------------------------------------------------------------------

async function opSetActiveTheme(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as {
    themeName?: string;
    themeId?: string;
    themeGroup?: string;
    enabledSets?: string[];
    selectedTokenSets?: Record<string, string>;
  };
  if (!p.themeName) throw new Error("setActiveTheme needs { themeName }");

  const previousActiveTheme = figma.root.getSharedPluginData("tokens", "activeTheme") || null;
  const previousUsedTokenSet = figma.root.getSharedPluginData("tokens", "usedTokenSet") || null;

  if (p.themeId) {
    const group = p.themeGroup ?? "";
    figma.root.setSharedPluginData(
      "tokens", "activeTheme",
      JSON.stringify({ [group]: p.themeId })
    );
  } else {
    figma.root.setSharedPluginData("tokens", "activeTheme", JSON.stringify(p.themeName));
  }

  let usedTokenSet: Record<string, string>;
  if (p.selectedTokenSets && typeof p.selectedTokenSets === "object") {
    usedTokenSet = { ...p.selectedTokenSets };
  } else {
    usedTokenSet = {};
    for (const s of p.enabledSets ?? []) usedTokenSet[s] = "enabled";
  }
  figma.root.setSharedPluginData("tokens", "usedTokenSet", JSON.stringify(usedTokenSet));

  figma.notify(`Active theme set to '${p.themeName}'.`);
  return {
    ok: true as const,
    themeName: p.themeName,
    previousActiveTheme,
    previousUsedTokenSet,
  };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

async function handleRequest(req: RequestFrame): Promise<ResponseFrame> {
  try {
    const result = await dispatch(req.method, req.params);
    return { kind: "response", id: req.id, result };
  } catch (err) {
    return {
      kind: "response",
      id: req.id,
      error: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "ping":
      return {
        ok: true as const,
        fileKey: figma.fileKey ?? null,
        fileName: figma.root.name ?? null,
        currentPage: figma.currentPage?.name ?? null,
      };
    case "getSelection":
      return {
        selection: figma.currentPage.selection.map((n) => ({
          id: n.id, name: n.name, type: n.type,
        })),
      };
    case "getNodeTokens":
      return await opGetNodeTokens(params);
    case "applyRemap":
      return await opApplyRemap(params);
    case "getStorageConfig":
      return opGetStorageConfig();
    case "getLocalCatalog":
      return opGetLocalCatalog();
    case "getStorageOverride":
      return await opGetStorageOverride();
    case "setStorageOverride":
      return await opSetStorageOverride(params);
    case "getSecret":
      return await opGetSecret(params);
    case "setActiveTheme":
      return await opSetActiveTheme(params);
    case "applyVisualWrites":
      return await opApplyVisualWrites(params);
    case "getApplyPrefs":
      return await opGetApplyPrefs();
    case "enumerateTokenizedNodes":
      return await opEnumerateTokenizedNodes(params);
    case "inspectBoundVariables":
      return await opInspectBoundVariables(params);
    case "getLiveTarget":
      return { target: buildLiveTarget() };
    case "evalCode":
      return await opEvalCode(params);
    case "nodeOp":
      return await opNodeOp(params);
    default:
      throw new Error(
        `Bridge RPC "${method}" isn't implemented by this plugin build. ` +
          `Your MCP server (ft) and the installed Figma plugin may be on different versions — ` +
          `update the plugin by re-installing the latest build from figma-plugin/dist, or downgrade the MCP server to match.`
      );
  }
}

// ---------------------------------------------------------------------------
// Undo log helpers
// ---------------------------------------------------------------------------

async function sendUndoLog(): Promise<void> {
  try {
    await sendUndoLogInner();
  } catch (err) {
    // clientStorage can fail (quota, transient) — surface instead of an
    // unhandled rejection that kills the message handler silently.
    figma.ui.postMessage({ type: "set-undo-log", entries: [] });
    console.error("sendUndoLog failed:", err);
  }
}

async function sendUndoLogInner(): Promise<void> {
  const indexRaw = await figma.clientStorage.getAsync(UNDO_INDEX_KEY);
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  const records = await Promise.all(
    index.map(async (id) => {
      const r = await figma.clientStorage.getAsync(UNDO_OP_PREFIX + id);
      if (!r || typeof r !== "object") return null;
      return {
        id,
        timestamp: (r as { timestamp?: string }).timestamp ?? "",
        summary: (r as { summary?: string }).summary ?? "(no summary)",
        writeCount: (r as { writeCount?: number }).writeCount ?? 0,
      };
    })
  );
  figma.ui.postMessage({ type: "set-undo-log", entries: records.filter(Boolean) });
}

async function revertOp(id: string): Promise<void> {
  const r = await figma.clientStorage.getAsync(UNDO_OP_PREFIX + id);
  if (!r || typeof r !== "object") {
    figma.notify("Couldn't find that operation in the undo log.", { error: true });
    return;
  }
  const rec = r as {
    summary?: string;
    before?: VisualWriteIn[];
    themeContext?: ApplyVisualWritesParams["themeContext"];
  };
  const before = rec.before;
  const themeCtx = rec.themeContext ?? null;

  if (themeCtx) {
    if (themeCtx.previousActiveTheme != null) {
      figma.root.setSharedPluginData("tokens", "activeTheme", themeCtx.previousActiveTheme);
    } else {
      figma.root.setSharedPluginData("tokens", "activeTheme", "");
    }
    if (themeCtx.previousUsedTokenSet != null) {
      figma.root.setSharedPluginData("tokens", "usedTokenSet", themeCtx.previousUsedTokenSet);
    } else {
      figma.root.setSharedPluginData("tokens", "usedTokenSet", "");
    }
  }

  if (Array.isArray(before) && before.length > 0) {
    await opApplyVisualWrites({
      writes: before,
      opSummary: `revert: ${rec.summary ?? id}`,
      skipUndoLog: true,
    } as unknown);
  }

  const indexRaw = await figma.clientStorage.getAsync(UNDO_INDEX_KEY);
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  const filtered = index.filter((x) => x !== id);
  await figma.clientStorage.setAsync(UNDO_INDEX_KEY, filtered);
  await figma.clientStorage.deleteAsync(UNDO_OP_PREFIX + id);
  sendUndoLog();
  figma.notify(`Reverted: ${rec.summary ?? id}`);
}

// ---------------------------------------------------------------------------
// UI message handler — routes all postMessage traffic
// ---------------------------------------------------------------------------

figma.ui.onmessage = async (msg: unknown) => {
  if (!msg || typeof msg !== "object") return;
  const tag = (msg as { type?: string }).type;

  if (tag === "ws-frame") {
    const frame = (msg as { frame: unknown }).frame;
    if (isRequestFrame(frame)) {
      const response = await handleRequest(frame);
      figma.ui.postMessage({ type: "ws-send", frame: response });
    }
    return;
  }

  if (tag === "ui-ready" || tag === "refresh-storage-config") {
    if (tag === "ui-ready") {
      figma.ui.postMessage({
        type: "set-hello",
        hello: {
          kind: "hello",
          fileKey: figma.fileKey ?? null,
          fileName: figma.root.name ?? null,
          pluginVersion: PLUGIN_VERSION,
        },
      });
      pushLiveTarget();
    }
    figma.ui.postMessage({
      type: "set-storage-config",
      storage: opGetStorageConfig(),
    });
    figma.clientStorage.getAsync(OVERRIDE_KEY).then((override) => {
      figma.ui.postMessage({ type: "set-storage-override", override: override ?? null });
    });
    return;
  }

  if (tag === "save-storage-override") {
    const m = msg as {
      override?: unknown;
      secret?: string | null;
      secretProvider?: string;
    };
    const override = m.override;

    const overridePromise: Promise<unknown> =
      override == null
        ? figma.clientStorage.deleteAsync(OVERRIDE_KEY)
        : figma.clientStorage.setAsync(OVERRIDE_KEY, override);

    let secretPromise: Promise<unknown> = Promise.resolve();
    if (m.secret !== undefined && m.secretProvider) {
      const key = secretKey(m.secretProvider);
      if (m.secret === null) {
        secretPromise = figma.clientStorage.deleteAsync(key);
      } else if (m.secret !== "") {
        secretPromise = figma.clientStorage.setAsync(key, m.secret);
      }
    }

    Promise.all([overridePromise, secretPromise]).then(
      () => {
        figma.ui.postMessage({
          type: "saved-storage-override",
          override: override ?? null,
        });
        if (m.secretProvider) sendSecretStatus(m.secretProvider);
        figma.notify(
          override == null
            ? "Token source override cleared."
            : "Token source override saved."
        );
      },
      (err) => {
        figma.ui.postMessage({
          type: "save-storage-override-error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    );
    return;
  }

  if (tag === "request-secret-status") {
    const provider = (msg as { provider?: string }).provider;
    if (provider) sendSecretStatus(provider);
    return;
  }

  if (tag === "clear-secret") {
    const provider = (msg as { provider?: string }).provider;
    if (!provider) return;
    figma.clientStorage.deleteAsync(secretKey(provider)).then(() => {
      sendSecretStatus(provider);
      figma.notify(`Cleared saved ${provider} access token.`);
    });
    return;
  }

  if (tag === "request-apply-prefs") {
    figma.clientStorage.getAsync(APPLY_PREFS_KEY).then((stored) => {
      const merged = Object.assign({}, APPLY_PREFS_DEFAULTS, stored ?? {});
      figma.ui.postMessage({ type: "set-apply-prefs", prefs: merged });
    });
    return;
  }

  if (tag === "save-apply-prefs") {
    const next = (msg as { prefs?: unknown }).prefs;
    if (!next || typeof next !== "object") return;
    const sanitised = {
      skipHidden: !!(next as { skipHidden?: unknown }).skipHidden,
      useVariables: !!(next as { useVariables?: unknown }).useVariables,
    };
    figma.clientStorage.setAsync(APPLY_PREFS_KEY, sanitised).then(() => {
      figma.ui.postMessage({ type: "set-apply-prefs", prefs: sanitised });
    });
    return;
  }

  if (tag === "request-undo-log") { void sendUndoLog(); return; }
  if (tag === "revert-op") {
    const id = (msg as { id?: string }).id;
    if (id) {
      revertOp(id).catch((err) => {
        figma.notify(`Revert failed: ${err instanceof Error ? err.message : String(err)}`, { error: true });
      });
    }
    return;
  }

  if (tag === "pin-target") {
    const target = (msg as { target?: unknown }).target ?? null;
    figma.ui.postMessage({ type: "pinned-target", target });
    figma.ui.postMessage({
      type: "ws-send",
      frame: {
        kind: "request",
        id: "ui-pin-" + Date.now(),
        method: "setPinnedTarget",
        params: { target },
      },
    });
    return;
  }

  if (tag === "clear-undo-log") {
    figma.clientStorage.getAsync(UNDO_INDEX_KEY)
      .then(async (raw) => {
        const index = Array.isArray(raw) ? (raw as string[]) : [];
        for (const id of index) await figma.clientStorage.deleteAsync(UNDO_OP_PREFIX + id);
        await figma.clientStorage.deleteAsync(UNDO_INDEX_KEY);
        await sendUndoLog();
      })
      .catch((err) => {
        figma.notify(`Couldn't clear history: ${err instanceof Error ? err.message : String(err)}`, { error: true });
      });
    return;
  }
};
