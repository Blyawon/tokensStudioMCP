/// <reference types="@figma/plugin-typings" />

/**
 * Shadow payload → Figma Effect[] conversion. Called from the main
 * write applier when kind === "shadow".
 */

import { parseColor } from "../color.js";

interface ShadowLayerPayload {
  type?: string;
  color?: string;
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
}

export function shadowPayloadToEffects(payload: unknown): Effect[] {
  if (!Array.isArray(payload)) return [];
  const out: Effect[] = [];
  for (const layer of payload as ShadowLayerPayload[]) {
    const { r, g, b, a } = parseColor(String(layer.color ?? "#000000"));
    const isInner = layer.type === "innerShadow";
    out.push({
      type: isInner ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r, g, b, a },
      offset: { x: layer.x ?? 0, y: layer.y ?? 0 },
      radius: layer.blur ?? 0,
      spread: layer.spread ?? 0,
      visible: true,
      blendMode: "NORMAL",
    });
  }
  // Figma paints effects from the bottom of `effects` upward, whereas
  // Tokens Studio (and CSS) express shadow stacks top-first. Reverse so
  // the first payload layer is the visually-topmost effect — matches the
  // upstream Tokens Studio plugin and avoids z-order flips on multi-layer
  // shadows. Variable-unbinding for effects happens on the NODE before the
  // caller assigns this new array — see batch.ts and unbindEffectVariables.
  return out.reverse();
}
