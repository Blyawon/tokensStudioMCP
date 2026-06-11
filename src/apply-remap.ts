/**
 * Token remap application — translates a RemapPlan into per-node
 * NodeRemap ops and ships them to the plugin in chunks.
 *
 * Also contains apply-to-variants logic for bulk-applying tokens
 * across component variants using template placeholders.
 */

import { getBridge } from "./bridge/server.js";
import type { NodeRemap } from "./bridge/protocol.js";
import type { RemapPlan } from "./remap/types.js";
import type { FigmaNode } from "./figma-client.js";
import { parseVariantAxesFromName } from "./remap/suggest.js";

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface ApplyOptions {
  dryRun: boolean;
  planId?: string;
}

export interface ApplyResult {
  applied: number;
  skipped: Array<{ nodeId: string; reason: string }>;
  errors: Array<{ nodeId: string; property?: string; message: string }>;
  dryRun: boolean;
  nodesAffected: number;
  propertiesAffected: number;
}

// --------------------------------------------------------------------------
// applyTokenRemap
// --------------------------------------------------------------------------

/**
 * Translate a `RemapPlan` into per-node `NodeRemap` ops and ship them to
 * the plugin. Plans group by property → entries; we pivot to nodes →
 * { property: newToken } so each node is touched exactly once on the wire.
 */
export async function applyTokenRemap(
  plan: RemapPlan,
  opts: ApplyOptions
): Promise<ApplyResult> {
  const perNode = new Map<string, NodeRemap>();
  for (const [property, entries] of Object.entries(plan.byProperty)) {
    for (const entry of entries) {
      if (entry.chosen === undefined) continue;
      for (const n of entry.nodes ?? []) {
        if (!n.id) continue;
        let op = perNode.get(n.id);
        if (!op) {
          op = { nodeId: n.id, set: {}, clear: [] };
          perNode.set(n.id, op);
        }
        if (entry.chosen === null) {
          if (!op.clear.includes(property)) op.clear.push(property);
        } else {
          op.set[property] = entry.chosen;
        }
      }
    }
  }

  const nodes = Array.from(perNode.values());
  const propertiesAffected = nodes.reduce(
    (acc, n) => acc + Object.keys(n.set).length + n.clear.length,
    0
  );

  if (opts.dryRun) {
    return {
      applied: 0,
      skipped: [],
      errors: [],
      dryRun: true,
      nodesAffected: nodes.length,
      propertiesAffected,
    };
  }

  if (nodes.length === 0) {
    return {
      applied: 0,
      skipped: [],
      errors: [],
      dryRun: false,
      nodesAffected: 0,
      propertiesAffected: 0,
    };
  }

  const bridge = getBridge();
  await bridge.start();

  const CHUNK = 50;
  let applied = 0;
  const skipped: ApplyResult["skipped"] = [];
  const errors: ApplyResult["errors"] = [];
  for (let i = 0; i < nodes.length; i += CHUNK) {
    const slice = nodes.slice(i, i + CHUNK);
    const res = (await bridge.request("applyRemap", {
      nodes: slice,
      planId: opts.planId,
    })) as { applied: number; skipped: typeof skipped; errors: typeof errors };
    applied += res.applied;
    skipped.push(...res.skipped);
    errors.push(...res.errors);
  }

  return {
    applied,
    skipped,
    errors,
    dryRun: false,
    nodesAffected: nodes.length,
    propertiesAffected,
  };
}

// --------------------------------------------------------------------------
// apply-to-variants
// --------------------------------------------------------------------------

export interface ApplyToVariantsOpts {
  property: string;
  template: string;
  layerName: string;
  layerType?: string;
  clearProperties: string[];
  dryRun: boolean;
}

interface ApplyToVariantsEntry {
  variantId: string;
  variantName: string;
  axes: Record<string, string>;
  resolvedToken: string;
  targets: Array<{ id: string; name: string; type: string }>;
  warnings: string[];
}

export interface ApplyToVariantsResult {
  componentSet: { id: string; name: string };
  template: string;
  property: string;
  layerName: string;
  layerType?: string;
  clearProperties: string[];
  variants: ApplyToVariantsEntry[];
  unmappedAxes: string[];
  apply?: ApplyResult;
  dryRun: boolean;
}

export async function applyToVariants(
  root: FigmaNode,
  opts: ApplyToVariantsOpts
): Promise<ApplyToVariantsResult> {
  const placeholders = parsePlaceholders(opts.template);
  const variantNodes = collectVariantComponents(root);
  if (variantNodes.length === 0) {
    throw new Error(
      "No variant components found under root. Pass a COMPONENT_SET (or a single COMPONENT)."
    );
  }

  const entries: ApplyToVariantsEntry[] = [];
  const unmappedAxes = new Set<string>();

  for (const v of variantNodes) {
    const axes = parseVariantAxesFromName(v.name);
    const warnings: string[] = [];
    let resolvedToken = opts.template;
    for (const ph of placeholders) {
      const value = axes[ph] ?? axes[ph.toLowerCase()];
      if (value === undefined) {
        unmappedAxes.add(ph);
        warnings.push(`No variant axis '${ph}' on '${v.name}'.`);
        resolvedToken = resolvedToken.replace(`{${ph}}`, `{${ph}}`);
      } else {
        resolvedToken = resolvedToken.replace(`{${ph}}`, value);
      }
    }

    const targets = findDescendantTargets(v, opts.layerName, opts.layerType);
    if (targets.length === 0) {
      warnings.push(
        `No descendants matching name="${opts.layerName}"` +
          (opts.layerType ? ` type="${opts.layerType}"` : "") +
          ` under '${v.name}'.`
      );
    }

    entries.push({
      variantId: v.id,
      variantName: v.name,
      axes,
      resolvedToken,
      targets,
      warnings,
    });
  }

  if (unmappedAxes.size === placeholders.length && placeholders.length > 0) {
    throw new Error(
      `Template references axes [${Array.from(unmappedAxes).join(", ")}] but none of the variants expose them. Variant names look like: '${variantNodes[0]?.name ?? "?"}'`
    );
  }

  const unresolved = entries.filter(
    (e) => e.targets.length > 0 && e.resolvedToken.includes("{")
  );
  if (unresolved.length > 0) {
    const lines = unresolved.map((e) => {
      const missing = placeholders.filter((ph) => e.axes[ph] === undefined && e.axes[ph.toLowerCase()] === undefined);
      return `  - '${e.variantName}': missing axes [${missing.join(", ")}] (got axes: {${Object.entries(e.axes).map(([k, v]) => `${k}=${v}`).join(", ")}})`;
    });
    throw new Error(
      `Template '${opts.template}' cannot be fully resolved for ${unresolved.length} variant(s):\n${lines.join("\n")}`
    );
  }

  const setEntries = entries
    .filter((e) => e.targets.length > 0 && !e.resolvedToken.includes("{"))
    .map((e) => ({
      oldToken: `__variant__:${e.variantId}`,
      chosen: e.resolvedToken,
      nodes: e.targets,
    }));

  const allTargetNodes = entries.flatMap((e) => e.targets);
  const clearEntries: Array<{ oldToken: string; chosen: null; nodes: typeof allTargetNodes }> =
    opts.clearProperties.length > 0 && allTargetNodes.length > 0
      ? [{ oldToken: "__clear__", chosen: null as null, nodes: allTargetNodes }]
      : [];

  const byProperty: Record<
    string,
    Array<{ oldToken: string; chosen: string | null; nodes: typeof allTargetNodes }>
  > = {};
  if (setEntries.length > 0) byProperty[opts.property] = setEntries;
  for (const clearProp of opts.clearProperties) {
    byProperty[clearProp] = clearEntries;
  }

  const out: ApplyToVariantsResult = {
    componentSet: { id: root.id, name: root.name },
    template: opts.template,
    property: opts.property,
    layerName: opts.layerName,
    layerType: opts.layerType,
    clearProperties: opts.clearProperties,
    variants: entries,
    unmappedAxes: Array.from(unmappedAxes),
    dryRun: opts.dryRun,
  };

  if (opts.dryRun) return out;

  out.apply = await applyTokenRemap(
    { byProperty } as unknown as RemapPlan,
    { dryRun: false }
  );
  return out;
}

// --------------------------------------------------------------------------
// Variant helpers
// --------------------------------------------------------------------------

const VARIANT_TYPES = new Set(["COMPONENT", "COMPONENT_SET"]);

export function collectVariantComponents(root: FigmaNode): FigmaNode[] {
  if (root.type === "COMPONENT_SET") {
    return (root.children ?? []).filter((c) => c.type === "COMPONENT");
  }
  if (root.type === "COMPONENT") return [root];
  const found: FigmaNode[] = [];
  function walk(n: FigmaNode): void {
    if (n.type === "COMPONENT_SET") {
      for (const c of n.children ?? []) {
        if (c.type === "COMPONENT") found.push(c);
      }
      return;
    }
    if (VARIANT_TYPES.has(n.type)) return;
    for (const c of n.children ?? []) walk(c);
  }
  walk(root);
  return found;
}

function parsePlaceholders(template: string): string[] {
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

function findDescendantTargets(
  variant: FigmaNode,
  layerName: string,
  layerType: string | undefined
): Array<{ id: string; name: string; type: string }> {
  const out: Array<{ id: string; name: string; type: string }> = [];
  function walk(n: FigmaNode): void {
    if (n.name === layerName && (!layerType || n.type === layerType)) {
      out.push({ id: n.id, name: n.name, type: n.type });
      return;
    }
    for (const c of n.children ?? []) walk(c);
  }
  for (const c of variant.children ?? []) walk(c);
  return out;
}
