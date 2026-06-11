/// <reference types="@figma/plugin-typings" />

/**
 * Structured node operations — the figma-cli feature set re-implemented as
 * typed sandbox ops, dispatched through a single `nodeOp` bridge method:
 *
 *   createNode    — frame/rect/ellipse/text/line/autolayout/instance, with
 *                   fills, strokes, radius, autolayout props, smart position
 *   setNodeProps  — batch property edits on existing nodes
 *   nodeAction    — delete / clone / select / group / to-component /
 *                   combine-variants / append / zoom
 *   getNodeTree   — depth-limited live tree with full layout metadata
 *   findNodes     — by name substring and/or type
 *   exportNode    — PNG/JPG/SVG base64 export
 *   variables     — list/create collections + variables, set values, bind
 *
 * Everything not covered here is reachable via the `evalCode` op.
 */

import { parseColor } from "./color.js";
import { sanitize } from "./eval.js";

export async function opNodeOp(params: unknown): Promise<unknown> {
  const p = (params ?? {}) as { op?: string; args?: Record<string, unknown> };
  const args = p.args ?? {};
  switch (p.op) {
    case "createNode": return createNode(args);
    case "setNodeProps": return setNodeProps(args);
    case "nodeAction": return nodeAction(args);
    case "getNodeTree": return getNodeTree(args);
    case "findNodes": return findNodes(args);
    case "exportNode": return exportNode(args);
    case "variables": return variablesOp(args);
    default:
      throw new Error(`Unknown nodeOp '${String(p.op)}'. Supported: createNode, setNodeProps, nodeAction, getNodeTree, findNodes, exportNode, variables.`);
  }
}

// ---------------------------------------------------------------------------
// createNode
// ---------------------------------------------------------------------------

async function createNode(args: Record<string, unknown>): Promise<unknown> {
  const type = String(args.type ?? "frame").toLowerCase();
  let node: SceneNode;

  switch (type) {
    case "frame":
    case "autolayout":
      node = figma.createFrame();
      break;
    case "rectangle":
    case "rect":
      node = figma.createRectangle();
      break;
    case "ellipse":
    case "circle":
      node = figma.createEllipse();
      break;
    case "line":
      node = figma.createLine();
      break;
    case "text": {
      const family = String(args.fontFamily ?? "Inter");
      const style = String(args.fontStyle ?? "Regular");
      await figma.loadFontAsync({ family, style });
      const text = figma.createText();
      text.fontName = { family, style };
      text.characters = String(args.characters ?? args.text ?? "");
      if (args.fontSize != null) text.fontSize = Number(args.fontSize);
      node = text;
      break;
    }
    case "instance": {
      const componentId = String(args.componentId ?? "");
      const comp = componentId ? await figma.getNodeByIdAsync(componentId) : null;
      if (!comp || comp.type !== "COMPONENT") throw new Error(`componentId '${componentId}' is not a COMPONENT`);
      node = (comp as ComponentNode).createInstance();
      break;
    }
    default:
      throw new Error(`Unsupported createNode type '${type}'`);
  }

  // Parent: explicit parentId, else current page.
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (typeof args.parentId === "string" && args.parentId) {
    const candidate = await figma.getNodeByIdAsync(args.parentId);
    if (!candidate || !("appendChild" in candidate)) throw new Error(`parentId '${args.parentId}' not found or can't hold children`);
    parent = candidate as BaseNode & ChildrenMixin;
  }
  parent.appendChild(node);

  // Geometry. Without explicit x, auto-position right of existing content
  // so new nodes never stack at 0,0 (figma-cli "smart positioning").
  const w = args.width != null ? Number(args.width) : undefined;
  const h = args.height != null ? Number(args.height) : undefined;
  if ("resize" in node && (w != null || h != null)) {
    (node as FrameNode).resize(w ?? (node as FrameNode).width, h ?? (node as FrameNode).height);
  }
  if (args.x != null) node.x = Number(args.x);
  else if (parent.type === "PAGE") node.x = nextFreeX(parent as PageNode);
  if (args.y != null) node.y = Number(args.y);

  if (typeof args.name === "string" && args.name) node.name = args.name;
  applySharedProps(node, args);

  if (args.select !== false && parent.type === "PAGE") {
    figma.currentPage.selection = [node];
  }
  figma.commitUndo();
  return { id: node.id, name: node.name, type: node.type, x: node.x, y: node.y, width: (node as FrameNode).width, height: (node as FrameNode).height };
}

function nextFreeX(page: PageNode): number {
  let maxX = 0;
  for (const child of page.children) {
    maxX = Math.max(maxX, child.x + child.width);
  }
  return page.children.length > 0 ? maxX + 100 : 0;
}

// ---------------------------------------------------------------------------
// setNodeProps
// ---------------------------------------------------------------------------

async function setNodeProps(args: Record<string, unknown>): Promise<unknown> {
  const ids = await resolveTargetIds(args);
  const props = (args.props ?? args) as Record<string, unknown>;
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const id of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || node.type === "PAGE" || node.type === "DOCUMENT") {
      results.push({ id, ok: false, error: "node not found" });
      continue;
    }
    try {
      if (props.characters != null && node.type === "TEXT") {
        const text = node as TextNode;
        if (typeof text.fontName === "object") await figma.loadFontAsync(text.fontName as FontName);
        text.characters = String(props.characters);
      }
      if (props.fontSize != null && node.type === "TEXT") {
        const text = node as TextNode;
        if (typeof text.fontName === "object") await figma.loadFontAsync(text.fontName as FontName);
        text.fontSize = Number(props.fontSize);
      }
      if (props.fontFamily != null && node.type === "TEXT") {
        const family = String(props.fontFamily);
        const style = String(props.fontStyle ?? "Regular");
        await figma.loadFontAsync({ family, style });
        (node as TextNode).fontName = { family, style };
      }
      applySharedProps(node as SceneNode, props);
      const w = props.width != null ? Number(props.width) : undefined;
      const h = props.height != null ? Number(props.height) : undefined;
      if ("resize" in node && (w != null || h != null)) {
        (node as FrameNode).resize(w ?? (node as FrameNode).width, h ?? (node as FrameNode).height);
      }
      if (props.x != null) (node as SceneNode).x = Number(props.x);
      if (props.y != null) (node as SceneNode).y = Number(props.y);
      if (typeof props.name === "string") node.name = props.name;
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  figma.commitUndo();
  return { applied: results.filter((r) => r.ok).length, results };
}

/** Properties shared by createNode and setNodeProps. */
function applySharedProps(node: SceneNode, props: Record<string, unknown>): void {
  if (props.fill != null && "fills" in node) {
    (node as GeometryMixin).fills = props.fill === "none" ? [] : [solidPaint(String(props.fill))];
  }
  if (props.stroke != null && "strokes" in node) {
    (node as GeometryMixin).strokes = props.stroke === "none" ? [] : [solidPaint(String(props.stroke))];
  }
  if (props.strokeWeight != null && "strokeWeight" in node) {
    (node as unknown as { strokeWeight: number }).strokeWeight = Number(props.strokeWeight);
  }
  if (props.cornerRadius != null && "cornerRadius" in node) {
    (node as unknown as { cornerRadius: number }).cornerRadius = Number(props.cornerRadius);
  }
  if (props.opacity != null && "opacity" in node) {
    (node as unknown as { opacity: number }).opacity = Number(props.opacity);
  }
  if (props.visible != null) node.visible = Boolean(props.visible);
  if (props.locked != null && "locked" in node) {
    (node as unknown as { locked: boolean }).locked = Boolean(props.locked);
  }
  if (props.rotation != null && "rotation" in node) {
    (node as unknown as { rotation: number }).rotation = Number(props.rotation);
  }
  applyAutoLayoutProps(node, props);
  if (props.constraints != null && "constraints" in node) {
    const c = props.constraints as { horizontal?: string; vertical?: string };
    const cur = (node as ConstraintMixin).constraints;
    (node as ConstraintMixin).constraints = {
      horizontal: (c.horizontal?.toUpperCase() ?? cur.horizontal) as ConstraintType,
      vertical: (c.vertical?.toUpperCase() ?? cur.vertical) as ConstraintType,
    };
  }
}

function applyAutoLayoutProps(node: SceneNode, props: Record<string, unknown>): void {
  const target = node as unknown as Record<string, unknown>;
  const layout = props.layout ?? props.layoutMode;
  if (layout != null && "layoutMode" in node) {
    const v = String(layout).toLowerCase();
    target.layoutMode = v === "row" || v === "horizontal" ? "HORIZONTAL"
      : v === "col" || v === "column" || v === "vertical" ? "VERTICAL"
      : "NONE";
    if (target.layoutMode !== "NONE") {
      // Default to hug like figma-cli; FIXED stays available via sizing props.
      if (props.primaryAxisSizing == null) target.primaryAxisSizingMode = "AUTO";
      if (props.counterAxisSizing == null) target.counterAxisSizingMode = "AUTO";
    }
  }
  if (props.gap != null && "itemSpacing" in node) target.itemSpacing = Number(props.gap);
  if (props.padding != null && "paddingTop" in node) {
    const pad = parsePadding(props.padding);
    target.paddingTop = pad[0]; target.paddingRight = pad[1];
    target.paddingBottom = pad[2]; target.paddingLeft = pad[3];
  }
  const justifyMap: Record<string, string> = { start: "MIN", center: "CENTER", end: "MAX", between: "SPACE_BETWEEN" };
  if (props.justify != null && "primaryAxisAlignItems" in node) {
    target.primaryAxisAlignItems = justifyMap[String(props.justify)] ?? String(props.justify).toUpperCase();
  }
  if (props.items != null && "counterAxisAlignItems" in node) {
    target.counterAxisAlignItems = justifyMap[String(props.items)] ?? String(props.items).toUpperCase();
  }
  if (props.sizingHorizontal != null && "layoutSizingHorizontal" in node) {
    target.layoutSizingHorizontal = String(props.sizingHorizontal).toUpperCase();
  }
  if (props.sizingVertical != null && "layoutSizingVertical" in node) {
    target.layoutSizingVertical = String(props.sizingVertical).toUpperCase();
  }
}

function parsePadding(v: unknown): [number, number, number, number] {
  if (typeof v === "number") return [v, v, v, v];
  const parts = String(v).trim().split(/[\s/]+/).map(Number);
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function solidPaint(color: string): SolidPaint {
  const rgb = parseColor(color);
  const paint: SolidPaint = { type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b } };
  return rgb.a < 1 ? { ...paint, opacity: rgb.a } : paint;
}

// ---------------------------------------------------------------------------
// nodeAction
// ---------------------------------------------------------------------------

async function nodeAction(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "");
  const ids = await resolveTargetIds(args);
  const nodes: SceneNode[] = [];
  for (const id of ids) {
    const n = await figma.getNodeByIdAsync(id);
    if (n && n.type !== "PAGE" && n.type !== "DOCUMENT") nodes.push(n as SceneNode);
  }
  if (nodes.length === 0) throw new Error("No matching nodes (pass nodeIds or make a selection in Figma).");

  switch (action) {
    case "delete":
      for (const n of nodes) n.remove();
      figma.commitUndo();
      return { ok: true, deleted: ids };
    case "clone": {
      const offset = args.offset != null ? Number(args.offset) : 20;
      const clones = nodes.map((n) => {
        const c = n.clone();
        c.x = n.x + offset; c.y = n.y + offset;
        return { id: c.id, name: c.name };
      });
      figma.commitUndo();
      return { ok: true, clones };
    }
    case "select":
      figma.currentPage.selection = nodes;
      figma.viewport.scrollAndZoomIntoView(nodes);
      return { ok: true, selected: nodes.map((n) => n.id) };
    case "zoom":
      figma.viewport.scrollAndZoomIntoView(nodes);
      return { ok: true };
    case "group": {
      const group = figma.group(nodes, nodes[0].parent ?? figma.currentPage);
      if (typeof args.name === "string") group.name = args.name;
      figma.commitUndo();
      return { ok: true, id: group.id, name: group.name };
    }
    case "to-component": {
      const comps = nodes.map((n) => {
        const c = figma.createComponentFromNode(n);
        return { id: c.id, name: c.name };
      });
      figma.commitUndo();
      return { ok: true, components: comps };
    }
    case "combine-variants": {
      const comps: ComponentNode[] = [];
      for (const n of nodes) {
        comps.push(n.type === "COMPONENT" ? (n as ComponentNode) : figma.createComponentFromNode(n));
      }
      for (const c of comps) {
        if (c.parent !== figma.currentPage) figma.currentPage.appendChild(c);
      }
      const set = figma.combineAsVariants(comps, figma.currentPage);
      if (typeof args.name === "string") set.name = args.name;
      figma.commitUndo();
      return { ok: true, id: set.id, name: set.name, variants: comps.length };
    }
    case "append": {
      const parentId = String(args.parentId ?? "");
      const parent = parentId ? await figma.getNodeByIdAsync(parentId) : null;
      if (!parent || !("appendChild" in parent)) throw new Error(`parentId '${parentId}' not found or can't hold children`);
      for (const n of nodes) (parent as BaseNode & ChildrenMixin).appendChild(n);
      figma.commitUndo();
      return { ok: true, moved: nodes.map((n) => n.id), parent: parent.id };
    }
    default:
      throw new Error(`Unknown action '${action}'. Supported: delete, clone, select, zoom, group, to-component, combine-variants, append.`);
  }
}

async function resolveTargetIds(args: Record<string, unknown>): Promise<string[]> {
  if (Array.isArray(args.nodeIds) && args.nodeIds.length > 0) return args.nodeIds.map(String);
  if (typeof args.nodeId === "string" && args.nodeId) return [args.nodeId];
  return figma.currentPage.selection.map((n) => n.id);
}

// ---------------------------------------------------------------------------
// getNodeTree — live tree with layout metadata (works in drafts / any tab,
// no REST API or fileKey needed).
// ---------------------------------------------------------------------------

async function getNodeTree(args: Record<string, unknown>): Promise<unknown> {
  const maxDepth = Math.min(Number(args.depth ?? 6), 12);
  let root: BaseNode = figma.currentPage;
  if (typeof args.nodeId === "string" && args.nodeId) {
    const n = await figma.getNodeByIdAsync(args.nodeId);
    if (!n) throw new Error(`Node '${args.nodeId}' not found`);
    root = n;
  } else if (figma.currentPage.selection.length === 1) {
    root = figma.currentPage.selection[0];
  }

  function serialize(node: BaseNode, depth: number): Record<string, unknown> {
    const out: Record<string, unknown> = { id: node.id, name: node.name, type: node.type };
    const scene = node as SceneNode & Partial<AutoLayoutMixin> & Partial<GeometryMixin> & Partial<CornerMixin>;
    if ("width" in scene) { out.w = r2(scene.width); out.h = r2(scene.height); out.x = r2(scene.x); out.y = r2(scene.y); }
    if ("layoutMode" in scene && scene.layoutMode && scene.layoutMode !== "NONE") {
      out.layout = {
        mode: scene.layoutMode, gap: scene.itemSpacing,
        padding: [scene.paddingTop, scene.paddingRight, scene.paddingBottom, scene.paddingLeft],
        justify: scene.primaryAxisAlignItems, items: scene.counterAxisAlignItems,
      };
    }
    if ("fills" in scene && Array.isArray(scene.fills) && scene.fills.length > 0) out.fills = sanitize(scene.fills, 3);
    if ("cornerRadius" in scene && typeof scene.cornerRadius === "number" && scene.cornerRadius > 0) out.r = scene.cornerRadius;
    if (node.type === "TEXT") {
      const t = node as TextNode;
      out.characters = t.characters.slice(0, 80);
      if (typeof t.fontName === "object") out.font = `${(t.fontName as FontName).family} ${(t.fontName as FontName).style}`;
      if (typeof t.fontSize === "number") out.fontSize = t.fontSize;
    }
    if ("visible" in scene && scene.visible === false) out.hidden = true;
    if ("children" in node && depth < maxDepth) {
      const children = (node as ChildrenMixin).children;
      out.children = children.slice(0, 100).map((c) => serialize(c, depth + 1));
      if (children.length > 100) out.childrenTruncated = children.length - 100;
    } else if ("children" in node && (node as ChildrenMixin).children.length > 0) {
      out.childCount = (node as ChildrenMixin).children.length;
    }
    return out;
  }
  return { tree: serialize(root, 0), page: figma.currentPage.name };
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

// ---------------------------------------------------------------------------
// findNodes
// ---------------------------------------------------------------------------

async function findNodes(args: Record<string, unknown>): Promise<unknown> {
  const name = typeof args.name === "string" ? args.name.toLowerCase() : null;
  const type = typeof args.type === "string" ? args.type.toUpperCase() : null;
  const max = Math.min(Number(args.max ?? 50), 200);
  const matches = figma.currentPage.findAll((n) => {
    if (type && n.type !== type) return false;
    if (name && !n.name.toLowerCase().includes(name)) return false;
    return true;
  });
  return {
    total: matches.length,
    nodes: matches.slice(0, max).map((n) => ({
      id: n.id, name: n.name, type: n.type,
      x: r2(n.x), y: r2(n.y), w: r2(n.width), h: r2(n.height),
    })),
  };
}

// ---------------------------------------------------------------------------
// exportNode
// ---------------------------------------------------------------------------

async function exportNode(args: Record<string, unknown>): Promise<unknown> {
  const ids = await resolveTargetIds(args);
  if (ids.length === 0) throw new Error("exportNode needs a nodeId or a selection.");
  const node = await figma.getNodeByIdAsync(ids[0]);
  if (!node || !("exportAsync" in node)) throw new Error(`Node '${ids[0]}' not found or not exportable`);
  const format = String(args.format ?? "PNG").toUpperCase() as "PNG" | "JPG" | "SVG";
  const scale = Math.min(Math.max(Number(args.scale ?? 1), 0.1), 4);
  const settings: ExportSettings = format === "SVG"
    ? { format: "SVG" }
    : { format, constraint: { type: "SCALE", value: scale } };
  const bytes = await (node as ExportMixin).exportAsync(settings);
  return {
    nodeId: node.id,
    name: node.name,
    format,
    bytes: bytes.length,
    base64: figma.base64Encode(bytes),
  };
}

// ---------------------------------------------------------------------------
// variables — Figma Variables CRUD + binding
// ---------------------------------------------------------------------------

async function variablesOp(args: Record<string, unknown>): Promise<unknown> {
  const sub = String(args.sub ?? "list");
  const vars = figma.variables;
  if (!vars) throw new Error("Figma Variables API not available in this runtime.");

  switch (sub) {
    case "listCollections": {
      const cols = await vars.getLocalVariableCollectionsAsync();
      return { collections: cols.map((c) => ({ id: c.id, name: c.name, modes: c.modes, variableCount: c.variableIds.length })) };
    }
    case "list": {
      const all = await vars.getLocalVariablesAsync();
      const filter = typeof args.name === "string" ? args.name.toLowerCase() : null;
      const filtered = filter ? all.filter((v) => v.name.toLowerCase().includes(filter)) : all;
      return {
        total: filtered.length,
        variables: filtered.slice(0, 300).map((v) => ({
          id: v.id, name: v.name, type: v.resolvedType,
          collectionId: v.variableCollectionId,
          values: sanitize(v.valuesByMode, 3),
        })),
      };
    }
    case "createCollection": {
      const col = vars.createVariableCollection(String(args.name ?? "Collection"));
      figma.commitUndo();
      return { id: col.id, name: col.name, defaultModeId: col.modes[0].modeId };
    }
    case "create": {
      const cols = await vars.getLocalVariableCollectionsAsync();
      const wanted = String(args.collection ?? "");
      let col = cols.find((c) => c.id === wanted || c.name === wanted);
      if (!col) col = wanted ? vars.createVariableCollection(wanted) : cols[0];
      if (!col) throw new Error("No variable collection found — pass { collection: name }.");
      const type = String(args.type ?? "COLOR").toUpperCase() as VariableResolvedDataType;
      const variable = vars.createVariable(String(args.name ?? "variable"), col, type);
      if (args.value != null) {
        variable.setValueForMode(col.modes[0].modeId, coerceVariableValue(type, args.value));
      }
      figma.commitUndo();
      return { id: variable.id, name: variable.name, type, collectionId: col.id };
    }
    case "setValue": {
      const variable = await vars.getVariableByIdAsync(String(args.variableId ?? ""));
      if (!variable) throw new Error(`Variable '${String(args.variableId)}' not found`);
      const col = await vars.getVariableCollectionByIdAsync(variable.variableCollectionId);
      const modeId = String(args.modeId ?? col?.modes[0].modeId ?? "");
      variable.setValueForMode(modeId, coerceVariableValue(variable.resolvedType, args.value));
      figma.commitUndo();
      return { ok: true, id: variable.id, modeId };
    }
    case "bind": {
      const ids = await resolveTargetIds(args);
      const all = await vars.getLocalVariablesAsync();
      const ref = String(args.variable ?? "");
      const variable = all.find((v) => v.id === ref || v.name === ref);
      if (!variable) throw new Error(`Variable '${ref}' not found (by id or name)`);
      const field = String(args.field ?? "fill");
      let bound = 0;
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node) continue;
        if (field === "fill" || field === "stroke") {
          const key = field === "fill" ? "fills" : "strokes";
          const geo = node as GeometryMixin;
          if (!(key in node)) continue;
          const paints = Array.isArray(geo[key as "fills"]) ? (geo[key as "fills"] as readonly Paint[]) : [];
          const base = paints[0] ?? { type: "SOLID" as const, color: { r: 0.5, g: 0.5, b: 0.5 } };
          const next = vars.setBoundVariableForPaint(base as SolidPaint, "color", variable);
          (node as unknown as Record<string, readonly Paint[]>)[key] = [next, ...paints.slice(1)];
          bound++;
        } else if ("setBoundVariable" in node) {
          (node as unknown as { setBoundVariable(f: string, v: Variable): void }).setBoundVariable(field, variable);
          bound++;
        }
      }
      figma.commitUndo();
      return { ok: true, bound, variable: variable.name, field };
    }
    default:
      throw new Error(`Unknown variables sub-op '${sub}'. Supported: listCollections, list, createCollection, create, setValue, bind.`);
  }
}

function coerceVariableValue(type: string, value: unknown): VariableValue {
  if (type === "COLOR") {
    const rgb = parseColor(String(value));
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a };
  }
  if (type === "FLOAT") return Number(value);
  if (type === "BOOLEAN") return value === true || value === "true";
  return String(value);
}
