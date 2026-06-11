/**
 * Re-export shim. The implementation has been split into focused modules
 * under `./writes/`:
 *   - writes/batch.ts      — dedupe, prefetch, before-state, undo log
 *   - writes/primitive.ts  — color/spacing/size/radius/opacity writes
 *   - writes/typography.ts — font loading + weight→style + per-node apply
 *   - writes/shadow.ts     — shadow payload → Effect[] conversion
 *
 * Kept so existing imports of `./visual-writes.js` continue to work.
 */
export { opApplyVisualWrites } from "./writes/batch.js";
