/**
 * Walk a Figma subtree and collect, for every applied token, the list of
 * NODE IDs that carry it (not just the layer names — apply needs the
 * actual node ids to pass back through the bridge).
 *
 * This complements `collectTokenUsage` in src/tokens.ts, which is the
 * read-side dictionary used by `list_tokens`. We keep this collector
 * separate so the existing tool's signature doesn't have to change.
 */

import type { FigmaNode } from "../figma-client.js";
import { extractTokens, collapseInstancePath } from "../tokens.js";

export interface NodeUse {
  /** Display id (instance path collapsed for readability). */
  id: string;
  /** Raw Figma id (full instance path) — required for setSharedPluginData. */
  rawId: string;
  name: string;
  type: string;
}

/**
 * `property → oldToken → NodeUse[]` — every node that currently carries
 * `oldToken` for `property`. Order is deterministic (depth-first, left
 * to right) so plans diff cleanly across runs.
 */
export type NodeUseMap = Map<string, Map<string, NodeUse[]>>;

export function collectNodeUses(
  root: FigmaNode,
  skipNode?: (node: FigmaNode) => boolean
): NodeUseMap {
  const out: NodeUseMap = new Map();

  function walk(node: FigmaNode, isRoot: boolean): void {
    if (!isRoot && skipNode?.(node)) return;
    const tokens = extractTokens(node);
    for (const [prop, value] of Object.entries(tokens)) {
      let byToken = out.get(prop);
      if (!byToken) {
        byToken = new Map();
        out.set(prop, byToken);
      }
      let uses = byToken.get(value);
      if (!uses) {
        uses = [];
        byToken.set(value, uses);
      }
      uses.push({
        id: collapseInstancePath(node.id),
        rawId: node.id,
        name: node.name || "(unnamed)",
        type: node.type,
      });
    }
    for (const child of node.children ?? []) walk(child, false);
  }
  walk(root, true);
  return out;
}

/** Convert a NodeUseMap to the shape proposeRemap expects (display ids only). */
export function toDisplayNodes(
  uses: NodeUseMap
): Map<string, Map<string, Array<{ id: string; name: string; type: string }>>> {
  const out = new Map<
    string,
    Map<string, Array<{ id: string; name: string; type: string }>>
  >();
  for (const [prop, byToken] of uses) {
    const inner = new Map<string, Array<{ id: string; name: string; type: string }>>();
    for (const [token, list] of byToken) {
      inner.set(
        token,
        list.map(({ id, name, type }) => ({ id, name, type }))
      );
    }
    out.set(prop, inner);
  }
  return out;
}
