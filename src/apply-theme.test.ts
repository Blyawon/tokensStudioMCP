import { test } from "node:test";
import assert from "node:assert/strict";

import { generateWrites, type ApplyThemeOpts, type ApplyThemeResult } from "./apply-theme.js";
import type { ResolvedValue } from "./remap/resolver.js";

const DEFAULT_OPTS: ApplyThemeOpts = {
  themeName: "test",
  skipHidden: true,
  onlyColor: false,
  dryRun: false,
  bindingMode: "never",
  setActive: false,
  scope: "currentPage",
};

function prim(value: string | number, type = "color"): ResolvedValue {
  return { kind: "primitive", value, type, trail: [] };
}

function composition(entries: Record<string, ResolvedValue>): ResolvedValue {
  return { kind: "composition", entries, trail: [] };
}

test("generateWrites: composition expands mapped inner props into primitive writes", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    fill: prim("#ff0000", "color"),
    paddingTop: prim(16, "dimension"),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  const kinds = writes.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ["color-fill", "paddingTop"]);
  assert.equal(skipped.length, 0);
});

test("generateWrites: composition silently drops CSS-only inner props from IGNORED set", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    fill: prim("#ff0000", "color"),
    transitionDuration: prim("200ms", "dimension"),
    cursor: prim("pointer", "other"),
    filter: prim("blur(4px)", "other"),
    transform: prim("scale(1)", "other"),
    textCase: prim("UPPERCASE", "other"),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "color-fill");
  // None of the CSS-only keys should clutter the skipped-tokens report.
  assert.equal(skipped.length, 0);
});

test("generateWrites: composition with a truly unmapped inner prop (not in ignore set) reports it", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    fill: prim("#ff0000", "color"),
    someWeirdProp: prim("whatever", "other"),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "color-fill");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].property, "someWeirdProp");
  assert.match(skipped[0].reason, /no Figma analogue/);
});

test("generateWrites: composition with new sizing props produces maxWidth/minHeight writes", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    maxWidth: prim(320, "dimension"),
    minHeight: prim(120, "dimension"),
    minWidth: prim(200, "dimension"),
    maxHeight: prim(600, "dimension"),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  const kinds = writes.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ["maxHeight", "maxWidth", "minHeight", "minWidth"]);
  assert.equal(skipped.length, 0);
});

test("generateWrites: literal 'none' on a color-fill prop emits a clear-color-fill write", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved: ResolvedValue = { kind: "primitive", value: "none", type: "color", trail: [] };
  const writes = generateWrites("n1", "fill", resolved, "none", DEFAULT_OPTS, skipped);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "clear-color-fill");
  // No skipped-tokens noise for the "none" sentinel.
  assert.equal(skipped.length, 0);
});

test("generateWrites: composition with previously-ignored real Figma properties now emits writes", () => {
  // Regression for IGNORED_COMPOSITION_INNER_PROPS shrink: borderStyle,
  // textDecoration, textAlign, textCase used to be silently dropped; now
  // they either produce real writes (borderStyle) or are routed through
  // the typography path. Here we confirm borderStyle lands.
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    borderStyle: prim("dashed", "other"),
    rotation: prim(45, "dimension"),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  const kinds = writes.map((w) => w.kind).sort();
  assert.deepEqual(kinds, ["border-style", "rotation"]);
  assert.equal(skipped.length, 0);
});

test("generateWrites: composition with nested `border: { color, width, style }` emits stroke color AND width", () => {
  // Regression: Tokens Studio catalogs frequently express borders as a nested
  // composition. Previously the outer composition expansion would descend into
  // `border` as a generic nested composition — no `borderColor` key existed so
  // stroke colour never landed. Now we synthesize color-stroke + borderWidth
  // writes directly, matching the upstream plugin's mapValuesToTokens.
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    fill: prim("#ffffff", "color"),
    border: composition({
      color: prim("#333333", "color"),
      width: prim(2, "dimension"),
      // style is ignored for now — covered separately by the stroke-style kind
      style: prim("solid", "other"),
    }),
  });
  const writes = generateWrites("n1", "composition", resolved, "my.comp", DEFAULT_OPTS, skipped);
  const kinds = writes.map((w) => w.kind).sort();
  // color-fill from outer fill, color-stroke + borderWidth synthesized from border.
  assert.deepEqual(kinds, ["borderWidth", "color-fill", "color-stroke"]);
  const stroke = writes.find((w) => w.kind === "color-stroke");
  assert.equal(stroke?.value, "#333333");
  const width = writes.find((w) => w.kind === "borderWidth");
  assert.equal(width?.value, 2);
});

test("generateWrites: onlyColor suppresses non-color writes inside a composition", () => {
  const skipped: ApplyThemeResult["skippedTokens"] = [];
  const resolved = composition({
    fill: prim("#ff0000", "color"),
    paddingTop: prim(16, "dimension"),
  });
  const writes = generateWrites(
    "n1",
    "composition",
    resolved,
    "my.comp",
    { ...DEFAULT_OPTS, onlyColor: true },
    skipped
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, "color-fill");
});
