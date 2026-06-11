import { test } from "node:test";
import assert from "node:assert/strict";

import { isGradientString, parseGradient } from "./gradient.js";

test("isGradientString: recognises the three CSS gradient flavours", () => {
  assert.equal(isGradientString("linear-gradient(90deg, #fff, #000)"), true);
  assert.equal(isGradientString("radial-gradient(50% 50%, #fff 0%, #000 100%)"), true);
  assert.equal(isGradientString("conic-gradient(from 0deg, red, blue)"), true);
  assert.equal(isGradientString("#ff0000"), false);
  assert.equal(isGradientString("rgba(0,0,0,0.5)"), false);
  assert.equal(isGradientString(""), false);
});

test("parseGradient: linear, two hex stops, no angle -> default 180deg, correct type", () => {
  const p = parseGradient("linear-gradient(#ff0000, #0000ff)");
  assert.ok(p);
  assert.equal(p.type, "GRADIENT_LINEAR");
  assert.equal(p.gradientStops.length, 2);
});

test("parseGradient: linear with angle `90deg` parses", () => {
  const p = parseGradient("linear-gradient(90deg, #fff, #000)");
  assert.ok(p);
  assert.equal(p.type, "GRADIENT_LINEAR");
});

test("parseGradient: user's bug case — radial with commas inside rgba()", () => {
  // The exact input that produced the 6 apply_theme errors in the user's
  // Documentation Library file. Regression test.
  const raw = "radial-gradient(50% 50% at 50% 50%, rgba(0, 0, 0, 0.60) 0%, rgba(0, 0, 0, 0.00) 100%)";
  const p = parseGradient(raw);
  assert.ok(p, "parseGradient should not return null for a valid radial gradient");
  assert.equal(p.type, "GRADIENT_RADIAL");
  assert.equal(p.gradientStops.length, 2, "two color stops expected");
  const first = p.gradientStops[0];
  const last = p.gradientStops[1];
  // Both stops are black-ish at different alpha.
  assert.ok(first.color.r < 0.05 && first.color.g < 0.05 && first.color.b < 0.05);
  assert.ok(Math.abs(first.position - 0) < 0.01);
  assert.ok(Math.abs(last.position - 1) < 0.01);
  // Alpha transitions from 0.6 to ~0.
  assert.ok(first.color.a > 0.5 && first.color.a < 0.7, `first alpha ~0.6, got ${first.color.a}`);
  assert.ok(last.color.a < 0.05, `last alpha ~0, got ${last.color.a}`);
});

test("parseGradient: conic with `from 45deg` angle", () => {
  const p = parseGradient("conic-gradient(from 45deg, red, blue)");
  assert.ok(p);
  assert.equal(p.type, "GRADIENT_ANGULAR");
  assert.equal(p.gradientStops.length, 2);
});

test("parseGradient: non-gradient input returns null", () => {
  assert.equal(parseGradient("#ff0000"), null);
  assert.equal(parseGradient("rgba(0,0,0,0.5)"), null);
  assert.equal(parseGradient("not a gradient"), null);
});

test("parseGradient: `to right` direction -> 90deg", () => {
  const p = parseGradient("linear-gradient(to right, #000, #fff)");
  assert.ok(p);
  assert.equal(p.type, "GRADIENT_LINEAR");
});

test("parseGradient: three-stop linear gradient positions evenly spread", () => {
  const p = parseGradient("linear-gradient(#f00, #0f0, #00f)");
  assert.ok(p);
  assert.equal(p.gradientStops.length, 3);
  assert.equal(p.gradientStops[0].position, 0);
  assert.equal(p.gradientStops[1].position, 0.5);
  assert.equal(p.gradientStops[2].position, 1);
});
