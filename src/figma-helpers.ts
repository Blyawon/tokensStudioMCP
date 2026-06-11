/**
 * Shared Figma client helpers used by both CLI commands and MCP tools.
 * Centralises client creation, node loading, config caching, and target
 * resolution so each consumer imports a thin, testable API.
 */

import { FigmaClient, type FigmaNode } from "./figma-client.js";
import { parseFigmaTarget, type FigmaTarget } from "./parse-url.js";
import { getBridge } from "./bridge/server.js";
import { loadConfig, type LoadedConfig } from "./config.js";
import { withSpinner } from "./cli-ui.js";

// --------------------------------------------------------------------------
// Figma client — lazily instantiated from env vars.
// --------------------------------------------------------------------------

export function getClient(): FigmaClient {
  const apiKey = process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
  if (!apiKey) {
    throw new Error(
      "FIGMA_API_KEY is not set.\n" +
        "  Run:  ft setup\n" +
        "to store a Figma personal access token in .env."
    );
  }
  return new FigmaClient({ apiKey });
}

// --------------------------------------------------------------------------
// Node loading
// --------------------------------------------------------------------------

export async function loadNode(
  client: FigmaClient,
  target: { fileKey: string; nodeId?: string },
  depth?: number
): Promise<FigmaNode> {
  if (target.nodeId) {
    const res = await client.fetchNodes(target.fileKey, [target.nodeId], { depth });
    const entry = res.nodes[target.nodeId];
    if (!entry || !entry.document) {
      throw new Error(
        `Figma returned no document for node ${target.nodeId} in file ${target.fileKey}.`
      );
    }
    return entry.document;
  }
  const file = await client.fetchFile(target.fileKey, { depth });
  return file.document;
}

export async function loadNodeWithSpinner(
  client: FigmaClient,
  target: { fileKey: string; nodeId?: string },
  depth?: number
): Promise<FigmaNode> {
  const label = target.nodeId
    ? `fetching node ${target.nodeId} from Figma`
    : `fetching file from Figma`;
  return withSpinner(label, async (sp) => {
    const node = await loadNode(client, target, depth);
    sp.update("rendering");
    return node;
  });
}

// --------------------------------------------------------------------------
// Target resolution
// --------------------------------------------------------------------------

export function targetFromInput(input: string): { fileKey: string; nodeId?: string } {
  return parseFigmaTarget({
    url: input.startsWith("http") ? input : undefined,
    fileKey: input.startsWith("http") ? undefined : input,
  });
}

/**
 * Like `parseFigmaTarget`, but falls back to the bridge's pinned target
 * when no url/fileKey/nodeId args are given. This lets MCP tool calls
 * omit the URL when the designer has pinned a selection in the plugin.
 */
export function parseFigmaTargetOrPinned(
  args: { url?: string; fileKey?: string; nodeId?: string }
): FigmaTarget {
  if (args.url || args.fileKey || args.nodeId) return parseFigmaTarget(args);
  const pinned = getBridge().pinnedTarget;
  if (pinned) {
    return {
      fileKey: pinned.fileKey,
      nodeId: pinned.nodeId ?? undefined,
    };
  }
  return parseFigmaTarget(args);
}

// --------------------------------------------------------------------------
// Config — lazy singleton (loaded once per process)
// --------------------------------------------------------------------------

let CACHED_CONFIG: LoadedConfig | null = null;
export function getLoadedConfig(): LoadedConfig {
  if (!CACHED_CONFIG) CACHED_CONFIG = loadConfig();
  return CACHED_CONFIG;
}

// --------------------------------------------------------------------------
// Tree traversal helpers (shared by MCP tools and apply-theme)
// --------------------------------------------------------------------------

export function findNodeById(root: FigmaNode, id: string): FigmaNode | null {
  if (root.id === id) return root;
  for (const c of root.children ?? []) {
    const r = findNodeById(c, id);
    if (r) return r;
  }
  return null;
}

/**
 * Walk down the tree from root looking for `targetId`; return the name of
 * the nearest ancestor of type COMPONENT (Figma's variant child names
 * carry the axis assignments). Returns null when the target isn't inside
 * a variant context.
 */
export function findEnclosingVariantName(
  root: FigmaNode,
  targetId: string
): string | null {
  function walk(n: FigmaNode, ancestorVariant: string | null): string | null {
    if (n.id === targetId) return ancestorVariant;
    const nextVariant = n.type === "COMPONENT" ? n.name : ancestorVariant;
    for (const c of n.children ?? []) {
      const r = walk(c, nextVariant);
      if (r !== null) return r;
    }
    return null;
  }
  return walk(root, root.type === "COMPONENT" ? root.name : null);
}

/**
 * Depth-first traversal that respects `visible !== false` when
 * `skipHidden` is on. Stops descending into hidden subtrees.
 */
export function walkVisible(
  node: FigmaNode,
  skipHidden: boolean,
  cb: (n: FigmaNode) => void
): void {
  if (skipHidden && (node as { visible?: boolean }).visible === false) return;
  cb(node);
  for (const child of node.children ?? []) walkVisible(child, skipHidden, cb);
}
