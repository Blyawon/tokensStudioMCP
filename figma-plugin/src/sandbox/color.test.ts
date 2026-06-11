// Color-parsing tests. Runs standalone (no Figma runtime dependency) —
// parseColor and numeric helpers are pure.
//
// Run with: npx tsx --test figma-plugin/src/sandbox/color.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseColor, numericValue, numericOrUndefined, clampOpacity } from "./color.js";

function approx(a: number, b: number, epsilon = 1e-6): void {
  assert.ok(Math.abs(a - b) < epsilon, `expected ${a} ≈ ${b} (±${epsilon})`);
}

test("parseColor: #RGB short hex", () => {
  const c = parseColor("#f00");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
  assert.equal(c.a, 1);
});

test("parseColor: #RRGGBB", () => {
  const c = parseColor("#ff0000");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
  assert.equal(c.a, 1);
});

test("parseColor: #RRGGBBAA with alpha", () => {
  const c = parseColor("#ff000080");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
  approx(c.a, 128 / 255);
});

test("parseColor: uppercase hex", () => {
  const c = parseColor("#FFFFFF");
  approx(c.r, 1);
  approx(c.g, 1);
  approx(c.b, 1);
});

test("parseColor: whitespace tolerance", () => {
  const c = parseColor("  #ff0000  ");
  approx(c.r, 1);
});

test("parseColor: rgb(255, 0, 0)", () => {
  const c = parseColor("rgb(255, 0, 0)");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
  assert.equal(c.a, 1);
});

test("parseColor: rgba(255, 0, 0, 0.5)", () => {
  const c = parseColor("rgba(255, 0, 0, 0.5)");
  approx(c.r, 1);
  approx(c.a, 0.5);
});

test("parseColor: rgb(255 0 0) — modern space-separated syntax", () => {
  const c = parseColor("rgb(255 0 0)");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
});

test("parseColor: hsl(0, 100%, 50%) = red", () => {
  const c = parseColor("hsl(0, 100%, 50%)");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
});

test("parseColor: hsla with percent alpha", () => {
  const c = parseColor("hsla(0, 100%, 50%, 50%)");
  approx(c.a, 0.5);
});

test("parseColor: hsl(120, 100%, 50%) = green", () => {
  const c = parseColor("hsl(120, 100%, 50%)");
  approx(c.r, 0);
  approx(c.g, 1);
  approx(c.b, 0);
});

test("parseColor: bad hex length throws", () => {
  // 5 chars is neither #rgb, #rrggbb, nor #rrggbbaa.
  assert.throws(() => parseColor("#12345"), /Bad hex/);
});

test("parseColor: unsupported format throws with descriptive message", () => {
  assert.throws(() => parseColor("banana"), /Unsupported color format/);
});

test("parseColor: named color 'transparent' → fully transparent", () => {
  const c = parseColor("transparent");
  assert.equal(c.a, 0);
});

test("parseColor: named color 'red'", () => {
  const c = parseColor("red");
  approx(c.r, 1);
  approx(c.g, 0);
  approx(c.b, 0);
});

test("parseColor: named color is case-insensitive", () => {
  const c = parseColor("WHITE");
  approx(c.r, 1);
  approx(c.g, 1);
  approx(c.b, 1);
});

test("parseColor: rgb(255 0 0 / 0.5) — modern slash-alpha syntax", () => {
  const c = parseColor("rgb(255 0 0 / 0.5)");
  approx(c.r, 1);
  approx(c.a, 0.5);
});

test("parseColor: rgba with percent alpha", () => {
  const c = parseColor("rgba(255, 0, 0, 50%)");
  approx(c.a, 0.5);
});

test("numericValue: strips px", () => {
  assert.equal(numericValue("16px"), 16);
});

test("numericValue: rem converts to px using base 16", () => {
  assert.equal(numericValue("1.5rem"), 24);
  assert.equal(numericValue("1rem"), 16);
});

test("numericValue: em converts to px using base 16", () => {
  assert.equal(numericValue("2em"), 32);
});

test("numericValue: rem with explicit base font size", () => {
  assert.equal(numericValue("1.5rem", 10), 15);
});

test("numericValue: raw number passthrough", () => {
  assert.equal(numericValue(42), 42);
});

test("numericValue: throws on non-numeric", () => {
  assert.throws(() => numericValue("abc"), /Not a number/);
});

test("numericOrUndefined: returns undefined for nullish", () => {
  assert.equal(numericOrUndefined(null), undefined);
  assert.equal(numericOrUndefined(undefined), undefined);
});

test("numericOrUndefined: returns number for valid input", () => {
  assert.equal(numericOrUndefined("8px"), 8);
});

test("clampOpacity: >1 values interpreted as percentages", () => {
  // Token catalogs sometimes store opacity as 0–100.
  approx(clampOpacity(50), 0.5);
  approx(clampOpacity(100), 1);
});

test("clampOpacity: already 0–1 range passes through", () => {
  approx(clampOpacity(0.5), 0.5);
  approx(clampOpacity(0), 0);
  approx(clampOpacity(1), 1);
});

test("clampOpacity: negative clamps to 0", () => {
  assert.equal(clampOpacity(-0.5), 0);
});
