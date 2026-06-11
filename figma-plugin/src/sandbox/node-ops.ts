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
    case "a11y": return a11yOp(args);
    case "analyze": return analyzeOp(args);
    case "devResources": return devResourcesOp(args);
    default:
      throw new Error(`Unknown nodeOp '${String(p.op)}'. Supported: createNode, setNodeProps, nodeAction, getNodeTree, findNodes, exportNode, variables, a11y, analyze, devResources.`);
  }
}

// ---------------------------------------------------------------------------
// createNode
// ---------------------------------------------------------------------------

async function createNode(args: Record<string, unknown>): Promise<unknown> {
  // Parent: explicit parentId, else current page.
  let parent: BaseNode & ChildrenMixin = figma.currentPage;
  if (typeof args.parentId === "string" && args.parentId) {
    const candidate = await figma.getNodeByIdAsync(args.parentId);
    if (!candidate || !("appendChild" in candidate)) throw new Error(`parentId '${args.parentId}' not found or can't hold children`);
    parent = candidate as BaseNode & ChildrenMixin;
  }

  const node = await createOne(args, parent, true);

  if (args.select !== false && parent.type === "PAGE") {
    figma.currentPage.selection = [node];
  }
  figma.commitUndo();
  return { id: node.id, name: node.name, type: node.type, x: node.x, y: node.y, width: (node as FrameNode).width, height: (node as FrameNode).height };
}

/**
 * Build one node (plus its `children` specs, recursively). This is the
 * figma-cli "render JSX" equivalent: one call constructs a whole tree —
 * fonts loaded per text node, auto-layout props applied parent-first so
 * child HUG/FILL sizing works.
 */
async function createOne(
  args: Record<string, unknown>,
  parent: BaseNode & ChildrenMixin,
  isRoot: boolean
): Promise<SceneNode> {
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
    case "svg": {
      const svg = String(args.svg ?? "");
      if (!svg.includes("<svg")) throw new Error("type='svg' needs { svg: '<svg …>' } markup");
      node = figma.createNodeFromSvg(svg);
      // Recolor every vector fill when a color is given (icon tinting).
      if (args.fill != null && args.fill !== "none") {
        const paint = solidPaint(String(args.fill));
        const tint = (n: SceneNode): void => {
          if ("fills" in n && Array.isArray((n as GeometryMixin).fills) && ((n as GeometryMixin).fills as readonly Paint[]).length > 0) {
            (n as GeometryMixin).fills = [paint];
          }
          if ("children" in n) for (const c of (n as ChildrenMixin).children) tint(c as SceneNode);
        };
        tint(node);
      }
      break;
    }
    case "image": {
      const base64 = String(args.base64 ?? "");
      if (!base64) throw new Error("type='image' needs { base64 } (raw image bytes, base64-encoded)");
      const image = figma.createImage(figma.base64Decode(base64));
      const { width, height } = await image.getSizeAsync();
      const rect = figma.createRectangle();
      rect.resize(
        args.width != null ? Number(args.width) : width,
        args.height != null ? Number(args.height) : height
      );
      rect.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: image.hash }];
      node = rect;
      break;
    }
    case "section": {
      const section = figma.createSection();
      node = section as unknown as SceneNode;
      break;
    }
    case "sticky": {
      requireFigJam("sticky");
      const sticky = figma.createSticky();
      await figma.loadFontAsync(sticky.text.fontName as FontName);
      sticky.text.characters = String(args.characters ?? args.text ?? "");
      node = sticky as unknown as SceneNode;
      break;
    }
    case "connector": {
      requireFigJam("connector");
      const connector = figma.createConnector();
      const startId = String(args.startNodeId ?? "");
      const endId = String(args.endNodeId ?? "");
      if (startId) connector.connectorStart = { endpointNodeId: startId, magnet: "AUTO" };
      if (endId) connector.connectorEnd = { endpointNodeId: endId, magnet: "AUTO" };
      node = connector as unknown as SceneNode;
      break;
    }
    case "shape": {
      requireFigJam("shape");
      const shape = figma.createShapeWithText();
      const shapeType = String(args.shapeType ?? "ROUNDED_RECTANGLE").toUpperCase();
      shape.shapeType = shapeType as ShapeWithTextNode["shapeType"];
      if (args.characters != null || args.text != null) {
        await figma.loadFontAsync(shape.text.fontName as FontName);
        shape.text.characters = String(args.characters ?? args.text ?? "");
      }
      node = shape as unknown as SceneNode;
      break;
    }
    default:
      throw new Error(`Unsupported createNode type '${type}'`);
  }

  parent.appendChild(node);

  // Geometry. Without explicit x, top-level nodes auto-position right of
  // existing content so they never stack at 0,0 (figma-cli "smart position").
  const w = args.width != null ? Number(args.width) : undefined;
  const h = args.height != null ? Number(args.height) : undefined;
  if ("resize" in node && (w != null || h != null) && type !== "image") {
    (node as FrameNode).resize(w ?? (node as FrameNode).width, h ?? (node as FrameNode).height);
  }
  if (args.x != null) node.x = Number(args.x);
  else if (isRoot && parent.type === "PAGE") node.x = nextFreeX(parent as PageNode);
  if (args.y != null) node.y = Number(args.y);

  if (typeof args.name === "string" && args.name) node.name = args.name;
  applySharedProps(node, args);

  // Recursive children — applied AFTER this node's auto-layout props so
  // child HUG/FILL sizing resolves against a live auto-layout parent.
  if (Array.isArray(args.children) && "appendChild" in node) {
    for (const childSpec of args.children as Array<Record<string, unknown>>) {
      const child = await createOne(childSpec ?? {}, node as BaseNode & ChildrenMixin, false);
      // Child-side sizing props need the child to already be parented.
      if (childSpec.sizingHorizontal != null && "layoutSizingHorizontal" in child) {
        (child as unknown as Record<string, unknown>).layoutSizingHorizontal = String(childSpec.sizingHorizontal).toUpperCase();
      }
      if (childSpec.sizingVertical != null && "layoutSizingVertical" in child) {
        (child as unknown as Record<string, unknown>).layoutSizingVertical = String(childSpec.sizingVertical).toUpperCase();
      }
    }
  }

  return node;
}

function requireFigJam(what: string): void {
  if (figma.editorType !== "figjam") {
    throw new Error(`'${what}' nodes need a FigJam file (this plugin is open in a ${figma.editorType} file).`);
  }
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
    case "arrange": {
      // Grid-arrange (figma-cli `arrange`): row-major, equal gap.
      const gap = args.gap != null ? Number(args.gap) : 40;
      const columns = args.columns != null ? Math.max(1, Number(args.columns)) : Math.ceil(Math.sqrt(nodes.length));
      const startX = Math.min(...nodes.map((n) => n.x));
      const startY = Math.min(...nodes.map((n) => n.y));
      const colWidth = Math.max(...nodes.map((n) => n.width));
      const rowHeight = Math.max(...nodes.map((n) => n.height));
      nodes.forEach((n, i) => {
        n.x = startX + (i % columns) * (colWidth + gap);
        n.y = startY + Math.floor(i / columns) * (rowHeight + gap);
      });
      figma.commitUndo();
      return { ok: true, arranged: nodes.length, columns, gap };
    }
    default:
      throw new Error(`Unknown action '${action}'. Supported: delete, clone, select, zoom, group, to-component, combine-variants, append, arrange.`);
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
    case "exportCss":
    case "exportTailwind": {
      const all = await vars.getLocalVariablesAsync();
      const collectionFilter = typeof args.collection === "string" ? args.collection : null;
      const cols = await vars.getLocalVariableCollectionsAsync();
      const wanted = collectionFilter
        ? cols.find((c) => c.id === collectionFilter || c.name === collectionFilter)
        : null;
      const filtered = wanted ? all.filter((v) => v.variableCollectionId === wanted.id) : all;
      const hexOf = (val: unknown): string | null => {
        const c = val as { r?: number; g?: number; b?: number };
        if (typeof c?.r !== "number") return null;
        return rgbToHex({ r: c.r, g: c.g!, b: c.b! });
      };
      if (sub === "exportCss") {
        const lines = filtered.map((v) => {
          const val = Object.values(v.valuesByMode)[0];
          const css = v.resolvedType === "COLOR" ? hexOf(val)
            : v.resolvedType === "FLOAT" ? `${String(val)}px`
            : String(val);
          return `  --${v.name.replace(/[/.]/g, "-")}: ${css ?? String(val)};`;
        });
        return { css: `:root {\n${lines.join("\n")}\n}`, count: filtered.length };
      }
      const colors: Record<string, unknown> = {};
      for (const v of filtered) {
        if (v.resolvedType !== "COLOR") continue;
        const hex = hexOf(Object.values(v.valuesByMode)[0]);
        if (!hex) continue;
        const parts = v.name.split("/");
        if (parts.length === 2) {
          const group = (colors[parts[0]] ??= {}) as Record<string, string>;
          group[parts[1]] = hex;
        } else {
          colors[v.name.replace(/\//g, "-")] = hex;
        }
      }
      return { tailwind: { theme: { extend: { colors } } }, count: Object.keys(colors).length };
    }
    default:
      throw new Error(`Unknown variables sub-op '${sub}'. Supported: listCollections, list, createCollection, create, setValue, bind, exportCss, exportTailwind.`);
  }
}

// ---------------------------------------------------------------------------
// a11y — WCAG contrast / touch target / text size audit (figma-cli `a11y`)
// ---------------------------------------------------------------------------

async function a11yOp(args: Record<string, unknown>): Promise<unknown> {
  const check = String(args.check ?? "all");
  const root = await resolveScopeRoot(args);
  const level = String(args.level ?? "AA").toUpperCase();
  const minTouch = args.minTouch != null ? Number(args.minTouch) : 44;
  const minFontSize = args.minFontSize != null ? Number(args.minFontSize) : 12;

  const texts: TextNode[] = [];
  const interactive: SceneNode[] = [];
  const walk = (n: BaseNode): void => {
    if ("visible" in n && (n as SceneNode).visible === false) return;
    if (n.type === "TEXT") texts.push(n as TextNode);
    const scene = n as SceneNode;
    if (
      "reactions" in scene && Array.isArray((scene as FrameNode).reactions) && (scene as FrameNode).reactions.length > 0
    ) {
      interactive.push(scene);
    } else if (/\b(button|btn|link|input|checkbox|switch|tab|chip|icon-?button)\b/i.test(n.name)) {
      if ("width" in scene) interactive.push(scene);
    }
    if ("children" in n) for (const c of (n as ChildrenMixin).children) walk(c);
  };
  walk(root);

  const out: Record<string, unknown> = { scope: { id: root.id, name: root.name }, level };

  if (check === "contrast" || check === "all") {
    const issues: Array<Record<string, unknown>> = [];
    let checked = 0;
    for (const t of texts) {
      const fg = firstSolidRGB(t.fills);
      if (!fg) continue;
      const bg = findBackgroundRGB(t);
      if (!bg) continue;
      checked++;
      const ratio = contrastRatio(fg, bg);
      const fontSize = typeof t.fontSize === "number" ? t.fontSize : 16;
      const weight = typeof t.fontWeight === "number" ? t.fontWeight : 400;
      const isLarge = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const required = level === "AAA" ? (isLarge ? 4.5 : 7) : (isLarge ? 3 : 4.5);
      if (ratio < required) {
        issues.push({
          id: t.id, name: t.name, text: t.characters.slice(0, 40),
          fontSize, ratio: Math.round(ratio * 100) / 100, required,
          fg: rgbToHex(fg), bg: rgbToHex(bg),
        });
      }
    }
    out.contrast = { checked, failing: issues.length, issues: issues.slice(0, 50) };
  }

  if (check === "touch" || check === "all") {
    const issues = interactive
      .filter((n) => "width" in n && (n.width < minTouch || n.height < minTouch))
      .map((n) => ({ id: n.id, name: n.name, type: n.type, width: Math.round(n.width), height: Math.round(n.height) }));
    out.touch = { minSize: minTouch, checked: interactive.length, failing: issues.length, issues: issues.slice(0, 50) };
  }

  if (check === "text" || check === "all") {
    const issues = texts
      .filter((t) => typeof t.fontSize === "number" && t.fontSize < minFontSize)
      .map((t) => ({ id: t.id, name: t.name, fontSize: t.fontSize, text: t.characters.slice(0, 40) }));
    out.text = { minSize: minFontSize, checked: texts.length, failing: issues.length, issues: issues.slice(0, 50) };
  }

  return out;
}

function firstSolidRGB(paints: unknown): RGB | null {
  if (!Array.isArray(paints)) return null;
  for (const p of paints as Paint[]) {
    if (p.type === "SOLID" && p.visible !== false) return (p as SolidPaint).color;
  }
  return null;
}

/** Walk up parents to the nearest visible solid fill — the effective background. */
function findBackgroundRGB(node: BaseNode): RGB | null {
  let cur: BaseNode | null = node.parent;
  while (cur && cur.type !== "PAGE" && cur.type !== "DOCUMENT") {
    if ("fills" in cur) {
      const rgb = firstSolidRGB((cur as GeometryMixin).fills);
      if (rgb) return rgb;
    }
    cur = cur.parent;
  }
  return null;
}

function relativeLuminance(c: RGB): number {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function contrastRatio(a: RGB, b: RGB): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function rgbToHex(c: RGB): string {
  const to = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${to(c.r)}${to(c.g)}${to(c.b)}`;
}

// ---------------------------------------------------------------------------
// analyze — usage stats for colors / typography / spacing (figma-cli `analyze`)
// ---------------------------------------------------------------------------

async function analyzeOp(args: Record<string, unknown>): Promise<unknown> {
  const kind = String(args.kind ?? "all");
  const root = await resolveScopeRoot(args);

  const colorCounts = new Map<string, number>();
  const typoCounts = new Map<string, number>();
  const gapCounts = new Map<number, number>();
  const padCounts = new Map<number, number>();

  const walk = (n: BaseNode): void => {
    if ("visible" in n && (n as SceneNode).visible === false) return;
    if ("fills" in n && Array.isArray((n as GeometryMixin).fills)) {
      for (const p of (n as GeometryMixin).fills as readonly Paint[]) {
        if (p.type === "SOLID" && p.visible !== false) {
          const hex = rgbToHex((p as SolidPaint).color);
          colorCounts.set(hex, (colorCounts.get(hex) ?? 0) + 1);
        }
      }
    }
    if (n.type === "TEXT") {
      const t = n as TextNode;
      const font = typeof t.fontName === "object" ? (t.fontName as FontName) : null;
      const size = typeof t.fontSize === "number" ? t.fontSize : null;
      if (font && size != null) {
        const key = `${font.family}/${font.style}/${size}`;
        typoCounts.set(key, (typoCounts.get(key) ?? 0) + 1);
      }
    }
    const f = n as FrameNode;
    if ("layoutMode" in f && f.layoutMode !== "NONE") {
      gapCounts.set(f.itemSpacing, (gapCounts.get(f.itemSpacing) ?? 0) + 1);
      for (const pad of [f.paddingTop, f.paddingRight, f.paddingBottom, f.paddingLeft]) {
        if (pad > 0) padCounts.set(pad, (padCounts.get(pad) ?? 0) + 1);
      }
    }
    if ("children" in n) for (const c of (n as ChildrenMixin).children) walk(c);
  };
  walk(root);

  const top = <K>(m: Map<K, number>, n: number) =>
    Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([value, count]) => ({ value, count }));

  const out: Record<string, unknown> = { scope: { id: root.id, name: root.name } };
  if (kind === "colors" || kind === "all") out.colors = top(colorCounts, 20);
  if (kind === "typography" || kind === "all") out.typography = top(typoCounts, 15);
  if (kind === "spacing" || kind === "all") out.spacing = { gaps: top(gapCounts, 10), paddings: top(padCounts, 10) };
  return out;
}

/** Common scope resolution for audits: nodeId → selection → current page. */
async function resolveScopeRoot(args: Record<string, unknown>): Promise<BaseNode> {
  if (typeof args.nodeId === "string" && args.nodeId) {
    const n = await figma.getNodeByIdAsync(args.nodeId);
    if (!n) throw new Error(`Node '${args.nodeId}' not found`);
    return n;
  }
  if (figma.currentPage.selection.length === 1) return figma.currentPage.selection[0];
  return figma.currentPage;
}

// ---------------------------------------------------------------------------
// devResources — link nodes to Storybook / GitHub / docs (figma-cli `dev`)
// ---------------------------------------------------------------------------

async function devResourcesOp(args: Record<string, unknown>): Promise<unknown> {
  const action = String(args.action ?? "list");
  const ids = await resolveTargetIds(args);
  if (ids.length === 0) throw new Error("devResources needs a nodeId or selection.");
  const node = await figma.getNodeByIdAsync(ids[0]);
  if (!node) throw new Error(`Node '${ids[0]}' not found`);
  type DevNode = BaseNode & {
    addDevResourceAsync?(url: string, name?: string): Promise<void>;
    getDevResourcesAsync?(): Promise<Array<{ name: string; url: string }>>;
    deleteDevResourceAsync?(url: string): Promise<void>;
  };
  const dev = node as DevNode;
  if (action === "add") {
    if (!dev.addDevResourceAsync) throw new Error("Dev resources not supported on this node/runtime.");
    await dev.addDevResourceAsync(String(args.url ?? ""), args.name != null ? String(args.name) : undefined);
    return { ok: true, nodeId: node.id };
  }
  if (action === "delete") {
    if (!dev.deleteDevResourceAsync) throw new Error("Dev resources not supported on this node/runtime.");
    await dev.deleteDevResourceAsync(String(args.url ?? ""));
    return { ok: true, nodeId: node.id };
  }
  if (!dev.getDevResourcesAsync) throw new Error("Dev resources not supported on this node/runtime.");
  const resources = await dev.getDevResourcesAsync();
  return { nodeId: node.id, resources };
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
