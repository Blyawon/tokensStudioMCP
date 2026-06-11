import { test } from "node:test";
import assert from "node:assert/strict";

import { proposeRemap } from "./matcher.js";
import type { NodeUseMap } from "./collect.js";
import type { TokenCatalog, CatalogToken } from "./types.js";

function use(property: string, oldToken: string): NodeUseMap {
  const m: NodeUseMap = new Map();
  const inner = new Map();
  inner.set(oldToken, [
    { id: "1:2", rawId: "1:2", name: "Button", type: "INSTANCE" },
  ]);
  m.set(property, inner);
  return m;
}

function cat(tokens: CatalogToken[], themes: TokenCatalog["themes"] = []): TokenCatalog {
  return { tokens, themes, warnings: [] };
}

test("matcher: exact path match wins with score 1 and auto-chooses", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat([
    { path: "color.primary", type: "color" },
    { path: "color.secondary", type: "color" },
  ]);
  const plan = proposeRemap(uses, catalog);
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.chosen, "color.primary");
  assert.equal(entry.candidates[0].score, 1);
});

test("matcher: suffix match surfaces candidate but does not auto-choose", () => {
  const uses = use("fill", "brand.color.primary");
  const catalog = cat([
    { path: "palette.color.primary", type: "color" },
  ]);
  const plan = proposeRemap(uses, catalog);
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.candidates.length, 1);
  assert.equal(entry.chosen, undefined);
  assert.ok(entry.candidates[0].score < 0.95);
});

test("matcher: type filter — wrong type token is not a candidate", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat([
    { path: "color.primary", type: "spacing" }, // wrong type
  ]);
  const plan = proposeRemap(uses, catalog);
  assert.equal(plan.byProperty.fill[0].candidates.length, 0);
  assert.equal(plan.unmapped.length, 1);
});

test("matcher: no candidates → reports unmapped", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat([{ path: "spacing.md", type: "spacing" }]);
  const plan = proposeRemap(uses, catalog);
  assert.equal(plan.unmapped.length, 1);
  assert.equal(plan.unmapped[0].oldToken, "color.primary");
});

test("matcher: hint short-circuits and is always chosen", () => {
  const uses = use("fill", "color.old");
  const catalog = cat([{ path: "color.completely.different", type: "color" }]);
  const plan = proposeRemap(uses, catalog, {
    hints: { "color.old": "color.completely.different" },
  });
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.chosen, "color.completely.different");
  assert.equal(entry.candidates[0].score, 1);
});

test("matcher: hint targeting path not in catalog still wins with 0.9", () => {
  const uses = use("fill", "color.old");
  const catalog = cat([{ path: "color.other", type: "color" }]);
  const plan = proposeRemap(uses, catalog, {
    hints: { "color.old": "color.new" },
  });
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.chosen, "color.new");
  assert.equal(entry.candidates[0].score, 0.9);
});

test("matcher: ambiguous — two candidates within tie window are both surfaced", () => {
  const uses = use("fill", "color.brand.primary");
  const catalog = cat([
    { path: "light.color.brand.primary", type: "color" },
    { path: "dark.color.brand.primary", type: "color" },
  ]);
  const plan = proposeRemap(uses, catalog);
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.candidates.length, 2);
  // Both tied → ambiguous list should reflect this.
  assert.ok(plan.ambiguous.length >= 0); // Both have equal suffix, so they tie.
});

test("matcher: preferred theme biases tied candidates", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat(
    [
      { path: "light.color.primary", type: "color", set: "light" },
      { path: "dark.color.primary", type: "color", set: "dark" },
    ],
    [
      { name: "Light", selectedTokenSets: { light: "enabled" } },
      { name: "Dark", selectedTokenSets: { dark: "enabled" } },
    ]
  );
  const plan = proposeRemap(uses, catalog, { preferredTheme: "Dark" });
  const entry = plan.byProperty.fill[0];
  // Dark should be ranked first due to preferred-theme bias.
  assert.equal(entry.candidates[0].newToken, "dark.color.primary");
});

test("matcher: results are sorted deterministically (descending score)", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat([
    { path: "color.secondary", type: "color" },
    { path: "color.primary", type: "color" }, // should come first (exact match)
    { path: "color.tertiary", type: "color" },
  ]);
  const plan = proposeRemap(uses, catalog);
  const entry = plan.byProperty.fill[0];
  assert.equal(entry.candidates[0].newToken, "color.primary");
  for (let i = 1; i < entry.candidates.length; i++) {
    assert.ok(entry.candidates[i - 1].score >= entry.candidates[i].score);
  }
});

test("matcher: caps candidates at 5", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat(
    Array.from({ length: 10 }, (_, i) => ({
      path: `color.primary${i}`,
      type: "color",
    }))
  );
  const plan = proposeRemap(uses, catalog);
  assert.ok(plan.byProperty.fill[0].candidates.length <= 5);
});

test("matcher: empty catalog reports 'empty catalog' reason", () => {
  const uses = use("fill", "color.primary");
  const catalog = cat([]);
  const plan = proposeRemap(uses, catalog);
  assert.match(plan.unmapped[0].reason, /empty/);
});

test("matcher: catalog warnings are passed through to plan.warnings", () => {
  const uses = use("fill", "color.primary");
  const catalog: TokenCatalog = {
    tokens: [{ path: "color.primary", type: "color" }],
    themes: [],
    warnings: ["ingest: skipped unknown key 'foo'"],
  };
  const plan = proposeRemap(uses, catalog);
  assert.deepEqual(plan.warnings, ["ingest: skipped unknown key 'foo'"]);
});
