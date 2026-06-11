/// <reference types="@figma/plugin-typings" />

/**
 * Node discovery — find nodes with Tokens Studio applied tokens.
 * Uses native findAllWithCriteria when available (5–10× faster),
 * falls back to manual walk on older Figma runtimes.
 */

import { TOKENS_NAMESPACE, TOKENS_NOISE_KEYS, VALID_NODE_TYPES } from "./types.js";

// ---------------------------------------------------------------------------
// Enumerate tokenized nodes
// ---------------------------------------------------------------------------

export async function opEnumerateTokenizedNodes(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { scope?: string; skipHidden?: boolean };
  const scope = p.scope === "selection" || p.scope === "document"
    ? p.scope
    : "currentPage";
  const skipHidden = p.skipHidden ?? true;

  // dynamic-page mode: pages aren't implicitly loaded. For document scope,
  // load every page before we walk or findAllWithCriteria can touch it.
  if (scope === "document" && typeof figma.loadAllPagesAsync === "function") {
    await figma.loadAllPagesAsync();
  }

  let scopeDescription: string;
  const previousSkipFlag = figma.skipInvisibleInstanceChildren;
  if (skipHidden) figma.skipInvisibleInstanceChildren = true;

  const out: Array<{
    id: string;
    name: string;
    type: string;
    tokens: Record<string, string>;
    locked?: boolean;
  }> = [];

  type Criteria = { types?: NodeType[]; sharedPluginData?: { namespace: string } };
  type SearchableNode = BaseNode & {
    findAllWithCriteria?(criteria: Criteria): SceneNode[];
  };
  const root: SearchableNode =
    scope === "currentPage" ? (figma.currentPage as unknown as SearchableNode)
    : scope === "document"  ? (figma.root        as unknown as SearchableNode)
    : (figma.currentPage    as unknown as SearchableNode);

  let candidates: BaseNode[] = [];

  if (scope === "selection") {
    const roots = figma.currentPage.selection.slice();
    scopeDescription = `selection · ${roots.length} root${roots.length === 1 ? "" : "s"} on ${figma.currentPage.name}`;
    const seen = new Set<string>();
    for (const r of roots) await collectByWalkWithMainComponents(r, candidates, seen);
  } else if (typeof root.findAllWithCriteria === "function") {
    try {
      // Pass the explicit type list matching Tokens Studio's ValidNodeTypes.
      // Without `types:`, findAllWithCriteria in some runtimes can omit SLOT
      // descendants — which causes deep layers inside slot-bearing components
      // to be invisible to discovery and therefore never re-themed.
      candidates = root.findAllWithCriteria({
        types: VALID_NODE_TYPES,
        sharedPluginData: { namespace: TOKENS_NAMESPACE },
      });
    } catch {
      collectByWalk(root, candidates);
    }
    scopeDescription = scope === "document"
      ? `document · ${figma.root.name}`
      : `current page · ${figma.currentPage.name}`;
  } else {
    collectByWalk(root, candidates);
    scopeDescription = scope === "document"
      ? `document · ${figma.root.name}`
      : `current page · ${figma.currentPage.name}`;
  }

  for (const node of candidates) {
    if (skipHidden && "visible" in node && (node as SceneNode).visible === false) continue;
    const tokens = readTokensApplied(node);
    if (Object.keys(tokens).length > 0) {
      // Carry a `locked` marker so the server can pre-filter + report lock
      // skips cleanly instead of conflating them with real apply failures.
      const locked = "locked" in node && (node as SceneNode & { locked: boolean }).locked === true;
      out.push({
        id: node.id,
        name: node.name || "(unnamed)",
        type: node.type,
        tokens,
        ...(locked ? { locked: true } : {}),
      });
    }
  }

  figma.skipInvisibleInstanceChildren = previousSkipFlag;
  return { nodes: out, scopeDescription };
}

function collectByWalk(root: BaseNode, out: BaseNode[]): void {
  out.push(root);
  if ("children" in root) {
    for (const c of (root as ChildrenMixin).children) collectByWalk(c, out);
  }
}

/**
 * Selection-scope walk that ALSO follows instance → mainComponent so
 * tokens applied on a main component's sublayers (but inherited-displayed
 * on instances nested inside the selected subtree) get discovered and
 * themed too.
 *
 * Figma's sharedPluginData is stored per-node and does NOT inherit across
 * instance boundaries — so when the designer has applied tokens on
 * `.buttonSource/.label` and the selected subtree contains an INSTANCE of
 * `.buttonSource`, the instance's sublayers have empty `sharedPluginData`.
 * Walking their main-component tree instead finds the authoritative
 * tokens. Writes to main-component sublayers then cascade visually to
 * every instance — nested or not. Matches what Tokens Studio achieves
 * with its default page-scope walk.
 */
async function collectByWalkWithMainComponents(
  root: BaseNode,
  out: BaseNode[],
  seen: Set<string>
): Promise<void> {
  if (seen.has(root.id)) return;
  seen.add(root.id);
  out.push(root);

  // Instance → also walk the main component's subtree, but ONLY when the
  // main component is LOCAL to this file. Remote (library-imported) main
  // components are marked read-only by Figma — walking them adds thousands
  // of nodes whose writes all fail with "Cannot write to internal and
  // read-only node". Local mains are walkable and writing to them cascades
  // to every instance in the file. Use async API when available
  // (getMainComponentAsync is preferred on dynamic-page files).
  if (root.type === "INSTANCE") {
    let mc: ComponentNode | null = null;
    try {
      const getAsync = (root as InstanceNode & {
        getMainComponentAsync?: () => Promise<ComponentNode | null>;
      }).getMainComponentAsync;
      mc = typeof getAsync === "function"
        ? await getAsync.call(root)
        : (root as InstanceNode).mainComponent ?? null;
    } catch {
      mc = null;
    }
    // `remote` is true when the component lives in a linked library file.
    // Skip it — writes to remote nodes throw.
    if (mc && !(mc as ComponentNode & { remote?: boolean }).remote) {
      await collectByWalkWithMainComponents(mc, out, seen);
    }
  }

  if ("children" in root) {
    for (const c of (root as ChildrenMixin).children) {
      await collectByWalkWithMainComponents(c, out, seen);
    }
  }
}

/** Read this node's applied tokens — matches src/tokens.ts semantics. */
export function readTokensApplied(node: BaseNode): Record<string, string> {
  let keys: string[];
  try {
    keys = node.getSharedPluginDataKeys(TOKENS_NAMESPACE);
  } catch {
    return {};
  }
  if (keys.length === 0) return {};
  const tokens: Record<string, string> = {};
  for (const k of keys) {
    if (TOKENS_NOISE_KEYS.has(k)) continue;
    const raw = node.getSharedPluginData(TOKENS_NAMESPACE, k);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      tokens[k] = typeof parsed === "string" ? parsed : raw;
    } catch {
      tokens[k] = raw;
    }
  }
  return tokens;
}
