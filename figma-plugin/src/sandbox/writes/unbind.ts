/// <reference types="@figma/plugin-typings" />

/**
 * Variable-binding removers.
 *
 * Figma nodes can carry `boundVariables` on almost every property: fills,
 * strokes, effects, numeric layout fields, text style fields, etc. A bound
 * variable takes visual precedence over the raw value — so `node.fills =
 * [newPaint]` does NOT override the color the user actually sees if the
 * original fill had its color bound to a Variable. The bound-variable record
 * survives the assignment and Figma keeps painting with the variable's value.
 *
 * These helpers clear any pre-existing binding immediately before a raw
 * write so our new value actually lands. Mirrors Tokens Studio's
 * `unbindVariableFromTarget` pattern, generalised for every property type.
 *
 * Safe to call on files with no variables at all — every helper guards the
 * API's presence and silently no-ops when bindings or APIs are absent.
 */

/**
 * Clear any Figma Variable bound to the color channel of the target node's
 * EXISTING paint, then return a cloned paint array with the binding removed
 * that the caller can further mutate / replace. Mirrors Tokens Studio's
 * `unbindVariableFromTarget`: the critical call is on the existing paint,
 * not on a fresh one — that's what actually tells Figma's renderer to drop
 * the binding. Subsequent `node.fills = [newPaint]` writes then render
 * correctly instead of being overridden by the stale variable.
 *
 * No-op if the runtime lacks `setBoundVariableForPaint` or the node doesn't
 * carry the given key.
 */
export function unbindPaintColor(
  node: BaseNode,
  key: "fills" | "strokes"
): void {
  const api = figma.variables?.setBoundVariableForPaint;
  if (typeof api !== "function") return;
  if (!(key in node)) return;
  const existing = (node as unknown as Record<string, readonly Paint[]>)[key];
  if (!Array.isArray(existing) || existing.length === 0) return;
  try {
    const copy = existing.map((p) => p); // shallow clone for safe reassignment
    copy[0] = figma.variables.setBoundVariableForPaint(copy[0], "color", null);
    (node as unknown as Record<string, readonly Paint[]>)[key] = copy;
  } catch {
    // Paint type doesn't support variable binding (e.g. IMAGE) — fine, the
    // subsequent raw assignment will land unmodified.
  }
}

/**
 * Unbind any variable bound to a node field (opacity, itemSpacing,
 * cornerRadius, strokeWeight, …). No-op if the node doesn't support
 * `setBoundVariable` or the field isn't bound.
 */
export function unbindNodeField(node: BaseNode, field: string): void {
  const api = (node as unknown as {
    setBoundVariable?(f: string, v: Variable | null): void;
  }).setBoundVariable;
  if (typeof api !== "function") return;
  try {
    api.call(node, field, null);
  } catch {
    // Field isn't bindable on this node type — fine, raw write will land.
  }
}

/**
 * Clear any Figma Variables bound to the existing effects on `node.effects`
 * before the caller replaces them. Same reason as `unbindPaintColor`: the
 * binding is retained through raw `effects = [...]` assignments unless we
 * explicitly unbind via `setBoundVariableForEffect` first.
 */
export function unbindEffectVariables(node: BaseNode): void {
  const api = figma.variables?.setBoundVariableForEffect;
  if (typeof api !== "function") return;
  if (!("effects" in node)) return;
  const existing = (node as unknown as { effects: readonly Effect[] }).effects;
  if (!Array.isArray(existing) || existing.length === 0) return;
  const fields = ["color", "offsetX", "offsetY", "radius", "spread"] as const;
  try {
    const copy = existing.map((e) => {
      let cur = e;
      for (const f of fields) {
        try { cur = figma.variables.setBoundVariableForEffect(cur, f, null); }
        catch { /* field not applicable to this effect type */ }
      }
      return cur;
    });
    (node as unknown as { effects: readonly Effect[] }).effects = copy;
  } catch {
    // Silent — raw assignment below will still run.
  }
}

/**
 * Clear all typography-field variable bindings on a TEXT node. Called by
 * applyTypography before it writes raw font values so a previously-bound
 * variable can't mask the new values.
 */
export function unbindTextStyleFields(text: TextNode): void {
  const fields = [
    "fontSize", "fontFamily", "fontWeight", "fontStyle",
    "lineHeight", "letterSpacing", "paragraphSpacing", "paragraphIndent",
  ];
  for (const f of fields) unbindNodeField(text, f);
}

/**
 * Detach an attached Figma Style from a node's style-id slot before a raw
 * write. In most cases Figma auto-detaches when you assign fills/strokes/
 * effects/text directly, but this defensive clear mirrors Tokens Studio's
 * behaviour and guards against edge cases where the style reference
 * persists (library-imported styles, certain instance-override states).
 *
 * Safe to call unconditionally — the check below ensures we only touch the
 * slot if it currently holds a non-empty string. We skip the `figma.mixed`
 * symbol, which can appear on TEXT nodes whose characters span multiple
 * text styles; detaching in that case would require per-range handling
 * that we don't attempt here.
 */
export function detachStyle(
  node: BaseNode,
  slot: "fillStyleId" | "strokeStyleId" | "effectStyleId" | "textStyleId"
): void {
  if (!(slot in node)) return;
  const current = (node as unknown as Record<string, unknown>)[slot];
  if (typeof current !== "string" || current === "") return;
  try {
    (node as unknown as Record<string, string>)[slot] = "";
  } catch {
    // Read-only or not supported on this node — benign.
  }
}
