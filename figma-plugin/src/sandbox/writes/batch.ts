/// <reference types="@figma/plugin-typings" />

/**
 * Visual-write batch orchestration.
 *
 *   1. Dedupe identical writes (same node+kind+payload).
 *   2. Prefetch: nodes by id, fonts, variables, styles — all in parallel.
 *   3. Capture before-state for each write (drives the undo log).
 *   4. Apply each write synchronously (async work is already done).
 *   5. Commit undo + persist the undo record to clientStorage.
 *
 * Split from a previous 522-line visual-writes.ts into focused modules:
 * batch.ts (this file), primitive.ts, typography.ts, shadow.ts.
 */

import type { VisualWriteIn, ApplyVisualWritesParams, TypographyPayload } from "../types.js";
import { UNDO_INDEX_KEY, UNDO_OP_PREFIX, UNDO_RING_SIZE } from "../types.js";
import { clearPaintCache, readFirstSolidColor } from "../color.js";
import { applyPrimitiveWrite } from "./primitive.js";
import { applyTypography, collectFontsFromWrites } from "./typography.js";
import { shadowPayloadToEffects } from "./shadow.js";
import { unbindEffectVariables, detachStyle } from "./unbind.js";

export async function opApplyVisualWrites(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as ApplyVisualWritesParams;
  const rawWrites = p.writes;
  const opSummary = p.opSummary;
  const skipUndoLog = !!p.skipUndoLog;
  const themeContext = p.themeContext ?? null;
  const deferUndo = !!p.deferUndo;
  if (!Array.isArray(rawWrites)) throw new Error("applyVisualWrites needs { writes: [...] }");

  const writes = dedupeWrites(rawWrites);
  clearPaintCache();

  let applied = 0;
  const skipped: Array<{ nodeId: string; kind: string; reason: string }> = [];
  const errors: Array<{ nodeId: string; kind: string; message: string }> = [];
  // Readback diagnostic — samples the first N color-fill writes and reports
  // what Figma retained after the write. Lets the server tell a user
  // "your writes aren't landing" vs "your writes land but the theme's
  // value isn't what you expected". Capped so this diagnostic doesn't
  // balloon the response size on large applies.
  const READBACK_CAP = 30;
  const readback: Array<{
    nodeId: string;
    kind: string;
    nodeType: string;
    nodeName: string;
    intended: string;
    actual: string;
    match: boolean;
  }> = [];

  // Parallel prefetch all external references before the per-node loop.
  const uniqueIds = Array.from(new Set(writes.map((w) => w.nodeId)));
  const nodeMap = new Map<string, BaseNode | null>();
  const fontsToLoad = collectFontsFromWrites(writes);
  const fontLoadErrors = new Map<string, string>();
  const variableMap = new Map<string, Variable | null>();
  const styleMap = new Map<string, BaseStyle | null>();

  const variableIds = collectVariableIds(writes);
  const styleIds = collectStyleIds(writes);
  const varsApi = (figma as unknown as {
    variables?: { getVariableByIdAsync?(id: string): Promise<Variable | null> };
  }).variables;
  const stylesApi = figma as unknown as { getStyleByIdAsync?(id: string): Promise<BaseStyle | null> };

  await Promise.all([
    ...uniqueIds.map(async (id) => {
      try { nodeMap.set(id, await figma.getNodeByIdAsync(id)); }
      catch { nodeMap.set(id, null); }
    }),
    ...fontsToLoad.map(async (font) => {
      try { await figma.loadFontAsync(font); }
      catch (err) {
        fontLoadErrors.set(`${font.family}|${font.style}`, err instanceof Error ? err.message : String(err));
      }
    }),
    ...(varsApi?.getVariableByIdAsync
      ? variableIds.map(async (id) => {
          try { variableMap.set(id, await varsApi.getVariableByIdAsync!(id)); }
          catch { variableMap.set(id, null); }
        })
      : []),
    ...(stylesApi.getStyleByIdAsync
      ? styleIds.map(async (id) => {
          try { styleMap.set(id, await stylesApi.getStyleByIdAsync!(id)); }
          catch { styleMap.set(id, null); }
        })
      : []),
  ]);

  // Secondary font prefetch for text-characters writes: swapping a TEXT
  // node's `characters` requires its CURRENT font to be loaded, not a font
  // named in the payload. We can only know which fonts those are after the
  // node fetch above resolved.
  const textCharFonts = collectTextCharacterFonts(writes, nodeMap);
  if (textCharFonts.length > 0) {
    await Promise.all(textCharFonts.map(async (font) => {
      try { await figma.loadFontAsync(font); }
      catch (err) {
        fontLoadErrors.set(`${font.family}|${font.style}`, err instanceof Error ? err.message : String(err));
      }
    }));
  }

  // Capture before-state for undo log.
  const beforeWrites: VisualWriteIn[] = [];
  if (!skipUndoLog) {
    for (const w of writes) {
      const node = nodeMap.get(w.nodeId);
      if (!node) continue;
      const prior = capturePriorState(node, w.kind);
      if (prior) beforeWrites.push(...prior);
    }
  }

  // Apply writes synchronously (all async refs already prefetched).
  for (const w of writes) {
    const node = nodeMap.get(w.nodeId) ?? null;
    if (!node) {
      skipped.push({ nodeId: w.nodeId, kind: w.kind, reason: "node no longer exists" });
      continue;
    }
    try {
      const ok = applyOneWriteSync(node, w.kind, w.value, w.payload, fontLoadErrors, variableMap, styleMap);
      if (ok === "ok") {
        applied += 1;
        // Readback for color-fill — did Figma actually retain our paint?
        if (w.kind === "color-fill" && readback.length < READBACK_CAP) {
          const actual = readFillDescription(node);
          const intended = `SOLID ${String(w.value ?? "")}`;
          readback.push({
            nodeId: w.nodeId,
            kind: w.kind,
            nodeType: node.type,
            nodeName: (node as SceneNode).name ?? "",
            intended,
            actual,
            match: actual.toLowerCase().includes(String(w.value ?? "").toLowerCase().replace("#", "")),
          });
        }
      } else if (ok === "skip") {
        skipped.push({ nodeId: w.nodeId, kind: w.kind, reason: "node type doesn't support this property" });
      } else {
        skipped.push({ nodeId: w.nodeId, kind: w.kind, reason: ok });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remote/read-only nodes (from linked libraries) silently become skips
      // rather than errors. These writes genuinely can't land — there's
      // nothing the caller can do about it and errors_SAMPLES noise buries
      // the real failures.
      if (/read-only|internal and read-only|remote style or component/i.test(msg)) {
        skipped.push({ nodeId: w.nodeId, kind: w.kind, reason: "remote / read-only node (library-imported)" });
      } else {
        errors.push({ nodeId: w.nodeId, kind: w.kind, message: msg });
      }
    }
  }

  if (!deferUndo) figma.commitUndo();

  if (!skipUndoLog && (beforeWrites.length > 0 || themeContext) && applied > 0) {
    saveUndoRecord({
      summary: opSummary ?? `applyVisualWrites · ${applied} writes`,
      before: beforeWrites,
      themeContext,
    }).catch(() => {});
  }

  return { applied, skipped, errors, readback };
}

/**
 * Compact fill description for post-write readback. Handles SOLID arrays,
 * `figma.mixed` (range-based text) by sampling the first character range,
 * and empty / missing fills.
 */
function readFillDescription(node: BaseNode): string {
  if (!("fills" in node)) return "<no fills>";
  const fills = (node as GeometryMixin).fills;
  if (Array.isArray(fills)) {
    if (fills.length === 0) return "<empty>";
    const p = fills[0];
    if (p.type === "SOLID") {
      const c = (p as SolidPaint).color;
      const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
      return `SOLID #${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
    }
    return p.type;
  }
  // fills is figma.mixed (Symbol) — sample first character range on TEXT nodes.
  if (node.type === "TEXT") {
    const text = node as TextNode;
    try {
      const ranged = text.getRangeFills(0, Math.min(1, text.characters.length));
      if (Array.isArray(ranged) && ranged.length > 0 && ranged[0].type === "SOLID") {
        const c = (ranged[0] as SolidPaint).color;
        const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
        return `MIXED; [0..1)=SOLID #${toHex(c.r)}${toHex(c.g)}${toHex(c.b)}`;
      }
    } catch {
      return "MIXED (getRangeFills threw)";
    }
  }
  return "MIXED";
}

// ---------------------------------------------------------------------------
// Sync write applier — dispatches by kind to primitive / typography / shadow.
// ---------------------------------------------------------------------------

function applyOneWriteSync(
  node: BaseNode,
  kind: string,
  value: string | number | undefined,
  payload: unknown,
  fontLoadErrors: Map<string, string>,
  variableMap: Map<string, Variable | null>,
  styleMap: Map<string, BaseStyle | null>
): "ok" | "skip" | string {
  if ("locked" in node && (node as { locked: boolean }).locked) {
    return "locked (unlock the node in Figma to apply)";
  }
  if (kind === "bind-variable") {
    const p = payload as { variableId?: string; field?: string } | undefined;
    if (!p?.variableId || !p?.field) return "missing variableId/field";
    const variable = variableMap.get(p.variableId);
    if (!variable) return `variable ${p.variableId} not found in this file`;
    if (!("setBoundVariable" in node)) return "skip";
    try {
      (node as unknown as { setBoundVariable(field: string, v: Variable): void }).setBoundVariable(p.field, variable);
      return "ok";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (kind === "bind-style") {
    const p = payload as { styleId?: string; slot?: string } | undefined;
    if (!p?.styleId || !p?.slot) return "missing styleId/slot";
    if (styleMap.size > 0 && !styleMap.get(p.styleId)) {
      return `style ${p.styleId} not found in this file`;
    }
    if (!(p.slot in node)) return "skip";
    try {
      (node as unknown as Record<string, string>)[p.slot] = p.styleId;
      return "ok";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (kind === "typography") {
    return applyTypography(node, payload as TypographyPayload, fontLoadErrors);
  }
  if (kind === "shadow") {
    if (!("effects" in node)) return "skip";
    // Detach any attached Figma Effect Style before the raw write.
    detachStyle(node, "effectStyleId");
    // Unbind any Figma Variables on the EXISTING effects before replacing —
    // without this, bound variables override our raw values. Same pattern
    // as unbindPaintColor for fills/strokes.
    unbindEffectVariables(node);
    (node as { effects: readonly Effect[] }).effects = shadowPayloadToEffects(payload);
    return "ok";
  }
  return applyPrimitiveWrite(node, kind, value);
}

// ---------------------------------------------------------------------------
// Dedup & id-collection helpers
// ---------------------------------------------------------------------------

function dedupeWrites(writes: VisualWriteIn[]): VisualWriteIn[] {
  const map = new Map<string, VisualWriteIn>();
  for (const w of writes) {
    const payloadKey = w.payload ? JSON.stringify(w.payload) : "";
    const key = `${w.nodeId}::${w.kind}::${payloadKey}`;
    map.set(key, w);
  }
  return Array.from(map.values());
}

function collectVariableIds(writes: VisualWriteIn[]): string[] {
  const seen = new Set<string>();
  for (const w of writes) {
    if (w.kind !== "bind-variable") continue;
    const id = (w.payload as { variableId?: string } | undefined)?.variableId;
    if (id) seen.add(id);
  }
  return Array.from(seen);
}

function collectStyleIds(writes: VisualWriteIn[]): string[] {
  const seen = new Set<string>();
  for (const w of writes) {
    if (w.kind !== "bind-style") continue;
    const id = (w.payload as { styleId?: string } | undefined)?.styleId;
    if (id) seen.add(id);
  }
  return Array.from(seen);
}

function collectTextCharacterFonts(
  writes: VisualWriteIn[],
  nodeMap: Map<string, BaseNode | null>
): FontName[] {
  const seen = new Set<string>();
  const out: FontName[] = [];
  for (const w of writes) {
    if (w.kind !== "text-characters") continue;
    const node = nodeMap.get(w.nodeId);
    if (!node || node.type !== "TEXT") continue;
    const fontName = (node as TextNode).fontName;
    // fontName can be the symbol figma.mixed — skip those; a "text-characters"
    // write on a mixed-font text would need per-range loads, out of scope here.
    if (typeof fontName !== "object" || fontName === null) continue;
    const key = `${fontName.family}|${fontName.style}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(fontName);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Before-state capture (for undo log)
// ---------------------------------------------------------------------------

function capturePriorState(node: BaseNode, kind: string): VisualWriteIn[] | undefined {
  const single = (k: string, v: string | number | undefined): VisualWriteIn[] | undefined =>
    v === undefined ? undefined : [{ nodeId: node.id, kind: k, value: v }];

  switch (kind) {
    case "color-fill":
      return single(kind, readFirstSolidColor((node as GeometryMixin).fills));
    case "color-stroke":
      return single(kind, readFirstSolidColor((node as GeometryMixin).strokes));
    case "spacing":
      return single(kind, "itemSpacing" in node ? (node as { itemSpacing: number }).itemSpacing : undefined);
    case "horizontalPadding":
    case "paddingLeft":
      return single(kind, "paddingLeft" in node ? (node as { paddingLeft: number }).paddingLeft : undefined);
    case "verticalPadding":
    case "paddingTop":
      return single(kind, "paddingTop" in node ? (node as { paddingTop: number }).paddingTop : undefined);
    case "paddingRight":
      return single(kind, "paddingRight" in node ? (node as { paddingRight: number }).paddingRight : undefined);
    case "paddingBottom":
      return single(kind, "paddingBottom" in node ? (node as { paddingBottom: number }).paddingBottom : undefined);
    case "borderRadius": {
      if (!("cornerRadius" in node)) return undefined;
      const c = (node as { cornerRadius: number | symbol }).cornerRadius;
      if (typeof c === "number") return single(kind, c);
      return readMixedCornerRadii(node);
    }
    case "borderWidth": {
      if (!("strokeWeight" in node)) return undefined;
      const w = (node as { strokeWeight: number | symbol }).strokeWeight;
      if (typeof w === "number") return single(kind, w);
      return readMixedStrokeWeights(node);
    }
    case "opacity":
      return single(kind, "opacity" in node ? (node as { opacity: number }).opacity : undefined);
    case "sizing-width":
      return single(kind, "width" in node ? (node as { width: number }).width : undefined);
    case "sizing-height":
      return single(kind, "height" in node ? (node as { height: number }).height : undefined);
    default:
      return undefined;
  }
}

function readMixedCornerRadii(node: BaseNode): VisualWriteIn[] | undefined {
  if (!("topLeftRadius" in node)) return undefined;
  const n = node as {
    topLeftRadius: number; topRightRadius: number;
    bottomLeftRadius: number; bottomRightRadius: number;
  };
  return [
    { nodeId: node.id, kind: "borderRadiusTopLeft", value: n.topLeftRadius },
    { nodeId: node.id, kind: "borderRadiusTopRight", value: n.topRightRadius },
    { nodeId: node.id, kind: "borderRadiusBottomLeft", value: n.bottomLeftRadius },
    { nodeId: node.id, kind: "borderRadiusBottomRight", value: n.bottomRightRadius },
  ];
}

function readMixedStrokeWeights(node: BaseNode): VisualWriteIn[] | undefined {
  if (!("strokeTopWeight" in node)) return undefined;
  const n = node as {
    strokeTopWeight: number; strokeRightWeight: number;
    strokeBottomWeight: number; strokeLeftWeight: number;
  };
  const avg = (n.strokeTopWeight + n.strokeRightWeight + n.strokeBottomWeight + n.strokeLeftWeight) / 4;
  return [{ nodeId: node.id, kind: "borderWidth", value: avg }];
}

// ---------------------------------------------------------------------------
// Undo log persistence — writes a ring in figma.clientStorage.
// ---------------------------------------------------------------------------

async function saveUndoRecord(args: {
  summary: string;
  before: VisualWriteIn[];
  themeContext: ApplyVisualWritesParams["themeContext"];
}): Promise<void> {
  const id = "op-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const record = {
    id,
    timestamp: new Date().toISOString(),
    summary: args.summary,
    writeCount: args.before.length,
    before: args.before,
    themeContext: args.themeContext ?? null,
  };
  await figma.clientStorage.setAsync(UNDO_OP_PREFIX + id, record);

  const indexRaw = await figma.clientStorage.getAsync(UNDO_INDEX_KEY);
  const index = Array.isArray(indexRaw) ? (indexRaw as string[]) : [];
  index.unshift(id);
  while (index.length > UNDO_RING_SIZE) {
    const dropId = index.pop();
    if (dropId) await figma.clientStorage.deleteAsync(UNDO_OP_PREFIX + dropId);
  }
  await figma.clientStorage.setAsync(UNDO_INDEX_KEY, index);
}
