/// <reference types="@figma/plugin-typings" />

import { readTokensApplied } from "./discovery.js";

/**
 * Diagnostic RPC: dump the per-node state that would override raw writes.
 * Used to figure out WHY a theme-apply visually does nothing on a specific
 * layer even though the plugin reports the write as applied.
 *
 * The two main suspects are:
 *   1. `boundVariables` on fills / strokes / effects / numeric fields —
 *      a bound Figma Variable overrides raw values.
 *   2. Attached styles (`fillStyleId` / `strokeStyleId` / `effectStyleId` /
 *      `textStyleId`) — normally cleared by a raw fills write, but worth
 *      checking in case Figma retained them.
 *
 * Also reports whether the node sits inside an INSTANCE chain (via
 * `parent.type === "INSTANCE"` walk) — non-overridable instance sub-layers
 * silently reject writes.
 */

interface InspectedNode {
  id: string;
  name: string;
  type: string;
  insideInstance: boolean;
  locked?: boolean;
  /** Tokens Studio sharedPluginData entries (property → token path). */
  tokensApplied?: Record<string, string>;
  /** First paint in node.fills, stringified for quick diff. */
  fillsDescription?: string;
  /** First paint in node.strokes, stringified for quick diff. */
  strokesDescription?: string;
  boundVariables: Record<string, unknown> | null;
  fillsBindings: Array<Record<string, unknown>> | null;
  strokesBindings: Array<Record<string, unknown>> | null;
  effectsBindings: Array<Record<string, unknown>> | null;
  fillStyleId: string | null;
  strokeStyleId: string | null;
  effectStyleId: string | null;
  textStyleId: string | null;
}

export async function opInspectBoundVariables(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { nodeIds?: string[]; scope?: "selection" | "self-and-descendants" };
  const ids = Array.isArray(p.nodeIds) ? p.nodeIds : [];
  const scope = p.scope ?? "selection";

  const roots: BaseNode[] = [];
  if (ids.length > 0) {
    for (const id of ids) {
      const n = await figma.getNodeByIdAsync(id);
      if (n) roots.push(n);
    }
  } else {
    for (const n of figma.currentPage.selection) roots.push(n);
  }

  const out: InspectedNode[] = [];
  for (const root of roots) {
    if (scope === "self-and-descendants") {
      collect(root, out);
    } else {
      out.push(snapshot(root));
    }
  }
  return { nodes: out };
}

function collect(node: BaseNode, out: InspectedNode[]): void {
  out.push(snapshot(node));
  if ("children" in node) {
    for (const c of (node as ChildrenMixin).children) collect(c, out);
  }
}

function snapshot(node: BaseNode): InspectedNode {
  const asScene = node as SceneNode & {
    boundVariables?: Record<string, unknown>;
    fills?: readonly Paint[];
    strokes?: readonly Paint[];
    effects?: readonly Effect[];
    fillStyleId?: string | symbol;
    strokeStyleId?: string | symbol;
    effectStyleId?: string | symbol;
    textStyleId?: string | symbol;
    locked?: boolean;
  };
  const fills = Array.isArray(asScene.fills) ? asScene.fills : null;
  const strokes = Array.isArray(asScene.strokes) ? asScene.strokes : null;
  const effects = Array.isArray(asScene.effects) ? asScene.effects : null;
  const tokensApplied = readTokensApplied(node);
  // TEXT nodes with per-character fills return figma.mixed (a Symbol) from
  // `node.fills`. Detect that so inspect can show "MIXED" rather than null
  // (which is indistinguishable from "no fills"). Sample the first
  // character's fill via getRangeFills so we can see its colour too.
  let fillsDescription: string | undefined;
  if (fills && fills.length > 0) {
    fillsDescription = describePaint(fills[0]);
  } else if (asScene.fills !== undefined && !Array.isArray(asScene.fills) && node.type === "TEXT") {
    const text = node as TextNode;
    try {
      const ranged = text.getRangeFills(0, Math.min(1, text.characters.length));
      fillsDescription = `MIXED; [0..1)=${describePaint(Array.isArray(ranged) ? ranged[0] : undefined) ?? "?"}`;
    } catch {
      fillsDescription = "MIXED";
    }
  }
  return {
    id: node.id,
    name: node.name ?? "",
    type: node.type,
    insideInstance: isInsideInstance(node),
    locked: asScene.locked === true ? true : undefined,
    tokensApplied: Object.keys(tokensApplied).length > 0 ? tokensApplied : undefined,
    fillsDescription,
    strokesDescription: strokes && strokes.length > 0 ? describePaint(strokes[0]) : undefined,
    boundVariables: isPlainObject(asScene.boundVariables)
      ? (asScene.boundVariables as Record<string, unknown>)
      : null,
    fillsBindings: fills
      ? fills.map((p) => pickBindings(p as Paint & { boundVariables?: unknown }))
      : null,
    strokesBindings: strokes
      ? strokes.map((p) => pickBindings(p as Paint & { boundVariables?: unknown }))
      : null,
    effectsBindings: effects
      ? effects.map((e) => pickBindings(e as Effect & { boundVariables?: unknown }))
      : null,
    fillStyleId: stringId(asScene.fillStyleId),
    strokeStyleId: stringId(asScene.strokeStyleId),
    effectStyleId: stringId(asScene.effectStyleId),
    textStyleId: stringId(asScene.textStyleId),
  };
}

/**
 * Describe a paint compactly as "SOLID #rrggbb" / "GRADIENT_LINEAR 3 stops" /
 * etc. so we can eyeball whether Figma kept our write after apply.
 */
function describePaint(p: Paint | undefined): string | undefined {
  if (!p || typeof p !== "object") return undefined;
  if (p.type === "SOLID") {
    const c = (p as SolidPaint).color;
    const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
    return `SOLID #${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}${typeof p.opacity === "number" && p.opacity < 1 ? ` @${p.opacity.toFixed(2)}` : ""}`;
  }
  if (p.type.startsWith("GRADIENT")) {
    const stops = (p as GradientPaint).gradientStops?.length ?? 0;
    return `${p.type} ${stops} stops`;
  }
  return p.type;
}

function pickBindings(obj: { boundVariables?: unknown }): Record<string, unknown> {
  if (!obj || typeof obj !== "object") return {};
  const bv = (obj as { boundVariables?: unknown }).boundVariables;
  if (!isPlainObject(bv)) return {};
  return bv as Record<string, unknown>;
}

function stringId(v: string | symbol | undefined): string | null {
  if (typeof v !== "string") return null;
  return v === "" ? null : v;
}

function isInsideInstance(node: BaseNode): boolean {
  let p: BaseNode | null = (node as unknown as { parent: BaseNode | null }).parent ?? null;
  while (p) {
    if (p.type === "INSTANCE") return true;
    p = (p as unknown as { parent: BaseNode | null }).parent ?? null;
  }
  return false;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}
