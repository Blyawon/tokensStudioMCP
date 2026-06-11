/// <reference types="@figma/plugin-typings" />

/**
 * Primitive property writer — the big switch over write `kind` for
 * color/spacing/size/radius/opacity. Pure: given a node and a write,
 * mutate the node in place. No async, no prefetch, no side effects
 * beyond the single property assignment.
 */

import { colorToPaints, numericValue, clampOpacity } from "../color.js";
import { unbindPaintColor, unbindNodeField, detachStyle } from "./unbind.js";

// Node-level variable fields keyed by write kind. Each entry is cleared via
// `setBoundVariable(field, null)` immediately before the raw assignment so a
// previously-bound Figma Variable can't override the new value.
const FIELD_FOR_KIND: Record<string, string | readonly string[]> = {
  spacing: "itemSpacing",
  horizontalPadding: ["paddingLeft", "paddingRight"],
  verticalPadding: ["paddingTop", "paddingBottom"],
  paddingTop: "paddingTop",
  paddingRight: "paddingRight",
  paddingBottom: "paddingBottom",
  paddingLeft: "paddingLeft",
  borderRadius: [
    "topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius",
  ],
  borderRadiusTopLeft: "topLeftRadius",
  borderRadiusTopRight: "topRightRadius",
  borderRadiusBottomLeft: "bottomLeftRadius",
  borderRadiusBottomRight: "bottomRightRadius",
  borderWidth: "strokeWeight",
  opacity: "opacity",
  "sizing-width": "width",
  "sizing-height": "height",
  maxWidth: "maxWidth",
  minWidth: "minWidth",
  maxHeight: "maxHeight",
  minHeight: "minHeight",
  rotation: "rotation",
};

function unbindForKind(node: BaseNode, kind: string): void {
  const f = FIELD_FOR_KIND[kind];
  if (!f) return;
  if (Array.isArray(f)) for (const field of f) unbindNodeField(node, field);
  else unbindNodeField(node, f as string);
}

export function applyPrimitiveWrite(
  node: BaseNode,
  kind: string,
  value: string | number | undefined
): "ok" | "skip" | string {
  // Tokens Studio "none" sentinel — clear whatever the enclosing write
  // kind sets. Mirrors upstream's removeValuesFromNode. Composition and
  // typography/shadow clear paths live elsewhere (typography.ts / batch.ts).
  if (kind.startsWith("clear-")) {
    return applyClearWrite(node, kind.slice("clear-".length));
  }
  // Unbind any pre-existing variable on this field BEFORE the raw assignment.
  // Without this, a bound Figma Variable keeps painting the node with its
  // old value and our raw write is visually invisible.
  unbindForKind(node, kind);
  switch (kind) {
    case "color-fill": {
      if (!("fills" in node)) return "skip";
      detachStyle(node, "fillStyleId");
      unbindPaintColor(node, "fills");
      (node as GeometryMixin).fills = colorToPaints(String(value));
      return "ok";
    }
    case "color-stroke": {
      if (!("strokes" in node)) return "skip";
      detachStyle(node, "strokeStyleId");
      unbindPaintColor(node, "strokes");
      (node as GeometryMixin).strokes = colorToPaints(String(value));
      return "ok";
    }
    case "spacing":
      if (!("itemSpacing" in node)) return "skip";
      (node as { itemSpacing: number }).itemSpacing = numericValue(value!);
      return "ok";
    case "horizontalPadding":
      if (!("paddingLeft" in node)) return "skip";
      (node as { paddingLeft: number; paddingRight: number }).paddingLeft = numericValue(value!);
      (node as { paddingLeft: number; paddingRight: number }).paddingRight = numericValue(value!);
      return "ok";
    case "verticalPadding":
      if (!("paddingTop" in node)) return "skip";
      (node as { paddingTop: number; paddingBottom: number }).paddingTop = numericValue(value!);
      (node as { paddingTop: number; paddingBottom: number }).paddingBottom = numericValue(value!);
      return "ok";
    case "paddingTop":
      if (!("paddingTop" in node)) return "skip";
      (node as { paddingTop: number }).paddingTop = numericValue(value!);
      return "ok";
    case "paddingRight":
      if (!("paddingRight" in node)) return "skip";
      (node as { paddingRight: number }).paddingRight = numericValue(value!);
      return "ok";
    case "paddingBottom":
      if (!("paddingBottom" in node)) return "skip";
      (node as { paddingBottom: number }).paddingBottom = numericValue(value!);
      return "ok";
    case "paddingLeft":
      if (!("paddingLeft" in node)) return "skip";
      (node as { paddingLeft: number }).paddingLeft = numericValue(value!);
      return "ok";
    case "borderRadius":
      if (!("cornerRadius" in node)) return "skip";
      (node as { cornerRadius: number }).cornerRadius = numericValue(value!);
      return "ok";
    case "borderRadiusTopLeft":
      if (!("topLeftRadius" in node)) return "skip";
      (node as { topLeftRadius: number }).topLeftRadius = numericValue(value!);
      return "ok";
    case "borderRadiusTopRight":
      if (!("topRightRadius" in node)) return "skip";
      (node as { topRightRadius: number }).topRightRadius = numericValue(value!);
      return "ok";
    case "borderRadiusBottomLeft":
      if (!("bottomLeftRadius" in node)) return "skip";
      (node as { bottomLeftRadius: number }).bottomLeftRadius = numericValue(value!);
      return "ok";
    case "borderRadiusBottomRight":
      if (!("bottomRightRadius" in node)) return "skip";
      (node as { bottomRightRadius: number }).bottomRightRadius = numericValue(value!);
      return "ok";
    case "borderWidth":
      if (!("strokeWeight" in node)) return "skip";
      (node as { strokeWeight: number }).strokeWeight = numericValue(value!);
      return "ok";
    case "opacity":
      if (!("opacity" in node)) return "skip";
      (node as { opacity: number }).opacity = clampOpacity(numericValue(value!));
      return "ok";
    case "sizing-width":
      if (!("resize" in node) || !("height" in node)) return "skip";
      (node as { resize(w: number, h: number): void; height: number }).resize(
        numericValue(value!), (node as { height: number }).height);
      return "ok";
    case "sizing-height":
      if (!("resize" in node) || !("width" in node)) return "skip";
      (node as { resize(w: number, h: number): void; width: number }).resize(
        (node as { width: number }).width, numericValue(value!));
      return "ok";
    case "maxWidth":
      if (!("maxWidth" in node)) return "skip";
      (node as { maxWidth: number | null }).maxWidth = numericValue(value!);
      return "ok";
    case "minWidth":
      if (!("minWidth" in node)) return "skip";
      (node as { minWidth: number | null }).minWidth = numericValue(value!);
      return "ok";
    case "maxHeight":
      if (!("maxHeight" in node)) return "skip";
      (node as { maxHeight: number | null }).maxHeight = numericValue(value!);
      return "ok";
    case "minHeight":
      if (!("minHeight" in node)) return "skip";
      (node as { minHeight: number | null }).minHeight = numericValue(value!);
      return "ok";
    case "rotation":
      if (!("rotation" in node)) return "skip";
      (node as { rotation: number }).rotation = numericValue(value!);
      return "ok";
    case "border-style": {
      // Figma expresses stroke style via `dashPattern`: [] = solid,
      // [n, n] = dashed / dotted pattern (approximated).
      if (!("dashPattern" in node)) return "skip";
      const s = String(value ?? "solid").toLowerCase();
      const pattern =
        s === "dashed" ? [6, 4] :
        s === "dotted" ? [1, 2] :
        [];
      (node as { dashPattern: readonly number[] }).dashPattern = pattern;
      return "ok";
    }
    case "stroke-align": {
      if (!("strokeAlign" in node)) return "skip";
      const s = String(value ?? "").toUpperCase();
      if (s !== "INSIDE" && s !== "OUTSIDE" && s !== "CENTER") return "skip";
      (node as { strokeAlign: "INSIDE" | "OUTSIDE" | "CENTER" }).strokeAlign = s;
      return "ok";
    }
    case "dash-pattern": {
      if (!("dashPattern" in node)) return "skip";
      // Accept comma/space separated list like "6,4" or "6 4".
      const nums = String(value ?? "")
        .split(/[,\s]+/)
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n));
      (node as { dashPattern: readonly number[] }).dashPattern = nums;
      return "ok";
    }
    case "visibility": {
      if (!("visible" in node)) return "skip";
      const s = String(value ?? "").toLowerCase();
      const visible = s === "true" || s === "1" || s === "visible" || s === "yes";
      (node as unknown as { visible: boolean }).visible = visible;
      return "ok";
    }
    case "stretch-width": {
      // `100%` width token: stretch on the parent's primary axis via
      // layoutAlign, then resize the node to match parent width as a
      // fallback when there is no auto-layout parent.
      if ("layoutAlign" in node) {
        (node as unknown as { layoutAlign: string }).layoutAlign = "STRETCH";
      }
      const parent = (node as unknown as { parent?: { width?: number } }).parent;
      if (parent && typeof parent.width === "number" && "resize" in node && "height" in node) {
        try {
          (node as unknown as { resize(w: number, h: number): void }).resize(parent.width, (node as unknown as { height: number }).height);
        } catch { /* node refused resize — layoutAlign still applied */ }
      }
      return "ok";
    }
    case "stretch-height": {
      if ("layoutAlign" in node) {
        (node as unknown as { layoutAlign: string }).layoutAlign = "STRETCH";
      }
      const parent = (node as unknown as { parent?: { height?: number } }).parent;
      if (parent && typeof parent.height === "number" && "resize" in node && "width" in node) {
        try {
          (node as unknown as { resize(w: number, h: number): void }).resize((node as unknown as { width: number }).width, parent.height);
        } catch { /* benign */ }
      }
      return "ok";
    }
    case "text-characters": {
      if (node.type !== "TEXT") return "skip";
      // Text character swaps require the node's current font to already be
      // loaded — the batch runner prefetches fonts referenced by typography
      // writes. If a text-characters write lands on a node whose font wasn't
      // prefetched, Figma will throw. Surface that as an error message.
      try {
        (node as TextNode).characters = String(value ?? "");
        return "ok";
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    default:
      return "skip";
  }
}

/**
 * Clear the value for a given underlying write kind. Used by the
 * Tokens Studio `"none"` sentinel to drop whatever the token previously
 * set (equivalent to removing the binding in the UI).
 */
function applyClearWrite(node: BaseNode, underlyingKind: string): "ok" | "skip" | string {
  switch (underlyingKind) {
    case "color-fill":
      if (!("fills" in node)) return "skip";
      (node as GeometryMixin).fills = [];
      return "ok";
    case "color-stroke":
      if (!("strokes" in node)) return "skip";
      (node as GeometryMixin).strokes = [];
      return "ok";
    case "spacing":
      if (!("itemSpacing" in node)) return "skip";
      (node as { itemSpacing: number }).itemSpacing = 0;
      return "ok";
    case "horizontalPadding":
      if (!("paddingLeft" in node)) return "skip";
      (node as { paddingLeft: number; paddingRight: number }).paddingLeft = 0;
      (node as { paddingLeft: number; paddingRight: number }).paddingRight = 0;
      return "ok";
    case "verticalPadding":
      if (!("paddingTop" in node)) return "skip";
      (node as { paddingTop: number; paddingBottom: number }).paddingTop = 0;
      (node as { paddingTop: number; paddingBottom: number }).paddingBottom = 0;
      return "ok";
    case "paddingTop":
    case "paddingRight":
    case "paddingBottom":
    case "paddingLeft":
      if (!(underlyingKind in node)) return "skip";
      (node as Record<string, number>)[underlyingKind] = 0;
      return "ok";
    case "borderRadius":
      if (!("cornerRadius" in node)) return "skip";
      (node as { cornerRadius: number }).cornerRadius = 0;
      return "ok";
    case "borderWidth":
      if (!("strokeWeight" in node)) return "skip";
      (node as { strokeWeight: number }).strokeWeight = 0;
      return "ok";
    case "opacity":
      if (!("opacity" in node)) return "skip";
      (node as { opacity: number }).opacity = 1;
      return "ok";
    case "dash-pattern":
    case "border-style":
      if (!("dashPattern" in node)) return "skip";
      (node as { dashPattern: readonly number[] }).dashPattern = [];
      return "ok";
    case "rotation":
      if (!("rotation" in node)) return "skip";
      (node as { rotation: number }).rotation = 0;
      return "ok";
    default:
      return "skip";
  }
}
