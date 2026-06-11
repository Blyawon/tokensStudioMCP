import { test } from "node:test";
import assert from "node:assert/strict";

import { modifyColor, parseRgba } from "./color-modify.js";

test("parseRgba: #RRGGBB", () => {
  const r = parseRgba("#ff0000");
  assert.deepEqual(r, { r: 1, g: 0, b: 0, a: 1 });
});

test("parseRgba: #RGB expands", () => {
  const r = parseRgba("#f00");
  assert.deepEqual(r, { r: 1, g: 0, b: 0, a: 1 });
});

test("parseRgba: #RRGGBBAA", () => {
  const r = parseRgba("#ff000080");
  assert.ok(r);
  assert.ok(Math.abs(r!.a - 0x80 / 255) < 0.01);
});

test("parseRgba: rgba()", () => {
  const r = parseRgba("rgba(255, 0, 0, 0.5)");
  assert.ok(r);
  assert.equal(r!.r, 1);
  assert.equal(r!.a, 0.5);
});

test("parseRgba: hsl() red", () => {
  const r = parseRgba("hsl(0, 100%, 50%)");
  assert.ok(r);
  assert.ok(Math.abs(r!.r - 1) < 0.01 && r!.g < 0.01 && r!.b < 0.01);
});

test("modifyColor: alpha sets channel", () => {
  assert.equal(modifyColor("#ff0000", { type: "alpha", value: 0.5 }), "#ff000080");
});

test("modifyColor: darken srgb scales channel", () => {
  // Red darkened 50% in srgb → channel * (1 - 0.5) = 0.5 → #800000
  const result = modifyColor("#ff0000", { type: "darken", value: 0.5, space: "srgb" });
  assert.equal(result.toLowerCase(), "#800000");
});

test("modifyColor: lighten srgb interpolates toward 1", () => {
  // Black lightened 50% in srgb → 0 + 0.5*(1-0) = 0.5 → #808080
  const result = modifyColor("#000000", { type: "lighten", value: 0.5, space: "srgb" });
  assert.equal(result.toLowerCase(), "#808080");
});

test("modifyColor: darken hsl scales lightness", () => {
  // Red hsl(0,100%,50%) darkened 50% in hsl → L = 50% - 50%*50% = 25% → dark red
  const result = modifyColor("#ff0000", { type: "darken", value: 0.5, space: "hsl" });
  const parsed = parseRgba(result)!;
  // L should be roughly 25% — red channel around 0.5, others around 0
  assert.ok(parsed.r > 0.4 && parsed.r < 0.6, `expected dark red r ~0.5, got ${parsed.r}`);
  assert.ok(parsed.g < 0.05 && parsed.b < 0.05, "g/b should stay near 0");
});

test("modifyColor: mix blends 50%", () => {
  const result = modifyColor("#ff0000", { type: "mix", value: 0.5, color: "#0000ff" });
  // Midpoint between red and blue → #800080
  assert.equal(result.toLowerCase(), "#800080");
});

test("modifyColor: unknown modifier returns base", () => {
  // @ts-expect-error invalid modifier type
  assert.equal(modifyColor("#ff0000", { type: "unknown", value: 0.5 }), "#ff0000");
});

test("modifyColor: non-color input returns input", () => {
  assert.equal(modifyColor("not a color", { type: "darken", value: 0.5 }), "not a color");
});
