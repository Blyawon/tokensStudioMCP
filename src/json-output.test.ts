import { test } from "node:test";
import assert from "node:assert/strict";

import type { FigmaNode } from "./figma-client.js";
import {
  buildCoverageJson,
  buildNodeJson,
  buildTokensJson,
  buildTreeJson,
} from "./json-output.js";

function node(partial: Partial<FigmaNode> & { id: string; type: string }): FigmaNode {
  return {
    name: "",
    ...partial,
  } as FigmaNode;
}

function tokens(map: Record<string, string>): FigmaNode["sharedPluginData"] {
  const wrapped: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) wrapped[k] = JSON.stringify(v);
  return { tokens: wrapped };
}

// --------------------------------------------------------------------------
// buildTreeJson
// --------------------------------------------------------------------------

test("buildTreeJson produces a nested tree with coverage counts", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    sharedPluginData: tokens({ fill: "page.bg" }),
    children: [
      node({
        id: "1:2",
        type: "TEXT",
        name: "title",
        sharedPluginData: tokens({ typography: "text.heading" }),
      }),
      node({
        id: "1:3",
        type: "FRAME",
        name: "inner",
        children: [],
      }),
    ],
  });

  const result = buildTreeJson(tree);
  assert.equal(result.format, "tree");
  assert.equal(result.coverage.withTokens, 2);
  assert.equal(result.coverage.total, 3);
  assert.equal(result.root.id, "1:1");
  assert.equal(result.root.name, "root");
  assert.deepEqual(result.root.tokens, { fill: "page.bg" });
  assert.ok(result.root.children);
  assert.equal(result.root.children!.length, 2);
  assert.deepEqual(result.root.children![0].tokens, { typography: "text.heading" });
  // Untokenized inner frame comes back with no `tokens` key.
  assert.equal(result.root.children![1].tokens, undefined);
});

test("buildTreeJson collapses instance-path ids for display", () => {
  const tree = node({
    id: "I94:774;93:4034;214:7220",
    type: "INSTANCE",
    name: "btn",
    sharedPluginData: tokens({ fill: "brand" }),
  });
  const result = buildTreeJson(tree);
  assert.equal(result.root.id, "214:7220");
});

test("buildTreeJson honours onlyWithTokens pruning", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    sharedPluginData: tokens({ fill: "page.bg" }),
    children: [
      node({
        id: "1:2",
        type: "FRAME",
        name: "noTokens",
        children: [node({ id: "1:3", type: "FRAME", name: "stillNone" })],
      }),
      node({
        id: "1:4",
        type: "FRAME",
        name: "withTokens",
        sharedPluginData: tokens({ spacing: "md" }),
      }),
    ],
  });

  const result = buildTreeJson(tree, { onlyWithTokens: true });
  assert.equal(result.root.children?.length, 1);
  assert.equal(result.root.children![0].name, "withTokens");
  // Total reflects what ends up in the JSON, not the pre-pruning tree.
  assert.equal(result.coverage.total, 2);
  assert.equal(result.coverage.withTokens, 2);
});

test("buildTreeJson emits layout only when requested", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
  } as Partial<FigmaNode> & { id: string; type: string });

  const without = buildTreeJson(tree);
  assert.equal(without.root.layout, undefined);

  const withLayout = buildTreeJson(tree, { layout: true });
  assert.deepEqual(withLayout.root.layout, { x: 0, y: 0, w: 100, h: 50 });
});

test("buildTreeJson carries text characters on TEXT nodes", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    children: [
      node({
        id: "1:2",
        type: "TEXT",
        name: "label",
        characters: "Hello world",
      } as Partial<FigmaNode> & { id: string; type: string }),
    ],
  });
  const result = buildTreeJson(tree);
  assert.equal(result.root.children![0].characters, "Hello world");
});

// --------------------------------------------------------------------------
// buildTokensJson
// --------------------------------------------------------------------------

test("buildTokensJson groups tokens by property with layer usages", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    sharedPluginData: tokens({ fill: "page.bg" }),
    children: [
      node({
        id: "1:2",
        type: "TEXT",
        name: "title",
        sharedPluginData: tokens({ typography: "text.heading" }),
      }),
      node({
        id: "1:3",
        type: "TEXT",
        name: "body",
        sharedPluginData: tokens({ typography: "text.body" }),
      }),
      node({
        id: "1:4",
        type: "TEXT",
        name: "body2",
        sharedPluginData: tokens({ typography: "text.body" }),
      }),
    ],
  });

  const result = buildTokensJson(tree);
  assert.equal(result.format, "tokens");
  assert.equal(result.totalProperties, 2);
  assert.equal(result.totalUnique, 3);
  assert.deepEqual(Object.keys(result.properties).sort(), ["fill", "typography"]);
  assert.deepEqual(result.properties.fill["page.bg"], [
    { name: "root", type: "FRAME", count: 1 },
  ]);
  // `text.body` appears twice on two TEXT nodes with different names → two usage entries.
  const bodyUsers = result.properties.typography["text.body"];
  assert.equal(bodyUsers.length, 2);
  assert.deepEqual(
    bodyUsers.map((u) => u.name).sort(),
    ["body", "body2"]
  );
});

test("buildTokensJson surfaces compositionHidden count", () => {
  const tree = node({
    id: "1:1",
    type: "FRAME",
    name: "root",
    children: [
      node({
        id: "1:2",
        type: "INSTANCE",
        name: "btn",
        sharedPluginData: tokens({ composition: "styles.button.primary" }),
      }),
    ],
  });
  const hidden = buildTokensJson(tree);
  assert.equal(hidden.compositionHidden, 1);
  assert.equal(hidden.totalUnique, 0);

  const shown = buildTokensJson(tree, { includeComposition: true });
  assert.equal(shown.compositionHidden, 0);
  assert.equal(shown.totalUnique, 1);
  assert.ok(shown.properties.composition);
});

// --------------------------------------------------------------------------
// buildCoverageJson
// --------------------------------------------------------------------------

test("buildCoverageJson rounds percent and handles zero total", () => {
  assert.deepEqual(buildCoverageJson(3, 4), {
    format: "coverage",
    withTokens: 3,
    total: 4,
    percent: 75,
  });
  assert.deepEqual(buildCoverageJson(0, 0), {
    format: "coverage",
    withTokens: 0,
    total: 0,
    percent: 0,
  });
});

// --------------------------------------------------------------------------
// buildNodeJson
// --------------------------------------------------------------------------

test("buildNodeJson returns a single node snapshot with display tokens", () => {
  const n = node({
    id: "I1:2;3:4",
    type: "INSTANCE",
    name: "btn",
    sharedPluginData: tokens({ fill: "brand.primary", composition: "styles.btn" }),
  });

  const hidden = buildNodeJson(n);
  assert.equal(hidden.format, "node");
  assert.equal(hidden.id, "3:4");
  assert.equal(hidden.name, "btn");
  assert.equal(hidden.type, "INSTANCE");
  assert.equal(hidden.tokens.fill, "brand.primary");
  // Composition shows up as the `…` placeholder when hidden.
  assert.equal(hidden.tokens.composition, "…");

  const shown = buildNodeJson(n, { includeComposition: true });
  assert.equal(shown.tokens.composition, "styles.btn");
});
