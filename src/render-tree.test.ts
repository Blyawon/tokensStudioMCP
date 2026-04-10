import { test } from "node:test";
import assert from "node:assert/strict";

import type { FigmaNode } from "./figma-client.js";
import {
  contentHash,
  dedupeChildren,
  renderCompactTree,
  renderTokensList,
} from "./render-tree.js";
import { renderMetadataXml } from "./xml.js";

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
// contentHash + dedupeChildren
// --------------------------------------------------------------------------

test("dedupeChildren collapses 4 identical adjacent siblings into repeat=4", () => {
  const mk = () =>
    node({
      id: Math.random().toString(36),
      type: "INSTANCE",
      name: "item",
      sharedPluginData: tokens({ fill: "colors.surface.default" }),
      children: [
        node({
          id: Math.random().toString(36),
          type: "TEXT",
          name: "label",
          sharedPluginData: tokens({ typography: "text.body.md" }),
        }),
      ],
    });

  const children = [mk(), mk(), mk(), mk()];
  const out = dedupeChildren(children);
  assert.equal(out.length, 1);
  assert.equal(out[0].repeat, 4);
});

test("dedupeChildren does NOT collapse siblings whose deep leaf tokens differ", () => {
  const mk = (leafToken: string) =>
    node({
      id: "x",
      type: "INSTANCE",
      name: "item",
      sharedPluginData: tokens({ fill: "colors.surface.default" }),
      children: [
        node({
          id: "y",
          type: "TEXT",
          name: "label",
          sharedPluginData: tokens({ typography: leafToken }),
        }),
      ],
    });

  const children = [mk("text.body.md"), mk("text.body.lg")];
  const out = dedupeChildren(children);
  assert.equal(out.length, 2);
  assert.equal(out[0].repeat, 1);
  assert.equal(out[1].repeat, 1);
});

test("dedupeChildren does NOT collapse non-adjacent repetitions", () => {
  const a = () =>
    node({ id: "a", type: "FRAME", name: "A", sharedPluginData: tokens({ fill: "red" }) });
  const b = () =>
    node({ id: "b", type: "FRAME", name: "B", sharedPluginData: tokens({ fill: "blue" }) });

  // A B A — the two As bracket a B. We should see three entries, not a
  // merged one, because dedup is adjacent-only.
  const out = dedupeChildren([a(), b(), a()]);
  assert.equal(out.length, 3);
  assert.equal(out[0].repeat, 1);
  assert.equal(out[1].repeat, 1);
  assert.equal(out[2].repeat, 1);
});

test("contentHash ignores id and bounding box but depends on name and tokens", () => {
  const base = () =>
    node({
      id: "ignore-me",
      type: "FRAME",
      name: "Card",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      sharedPluginData: tokens({ fill: "bg" }),
    });
  const sameStructureDifferentId = () =>
    node({
      id: "also-ignore-me",
      type: "FRAME",
      name: "Card",
      absoluteBoundingBox: { x: 999, y: 999, width: 50, height: 50 },
      sharedPluginData: tokens({ fill: "bg" }),
    });
  const differentToken = () =>
    node({
      id: "ignore-me",
      type: "FRAME",
      name: "Card",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      sharedPluginData: tokens({ fill: "different" }),
    });

  assert.equal(contentHash(base()), contentHash(sameStructureDifferentId()));
  assert.notEqual(contentHash(base()), contentHash(differentToken()));
});

// --------------------------------------------------------------------------
// renderCompactTree
// --------------------------------------------------------------------------

test("renderCompactTree emits root coverage line and no x/y/w/h by default", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    sharedPluginData: tokens({ fill: "a" }),
    children: [
      node({
        id: "0:2",
        type: "TEXT",
        name: "Title",
        absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 20 },
        characters: "Hello",
      }),
    ],
  });

  const result = renderCompactTree(tree);
  assert.match(result.text, /Root\s+FRAME 0:1\s+coverage=1\/2/);
  // No coordinate bracket on any line.
  assert.ok(!/\[\d+/.test(result.text));
  // Fill token on the root.
  assert.match(result.text, /fill=a/);
  // Text node characters appear in quotes.
  assert.match(result.text, /"Hello"/);
});

test("renderCompactTree omits trailing token cluster for untokenized nodes", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [
      node({ id: "0:2", type: "FRAME", name: "Empty" }),
    ],
  });
  const result = renderCompactTree(tree);
  // No "applied=none" sentinel — absence is the default in tree format.
  assert.ok(!result.text.includes("applied"));
  assert.match(result.text, /Empty\s+FRAME 0:2$/m);
});

test("renderCompactTree marks deduped runs with (×N)", () => {
  const mk = () =>
    node({
      id: "x",
      type: "INSTANCE",
      name: "Item",
      sharedPluginData: tokens({ fill: "c" }),
    });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [mk(), mk(), mk()],
  });
  const result = renderCompactTree(tree);
  assert.match(result.text, /\(×3\)\s+Item/);
});

test("renderCompactTree --layout appends [x,y w×h]", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [
      node({
        id: "0:2",
        type: "FRAME",
        name: "Card",
        absoluteBoundingBox: { x: 10, y: 20, width: 300, height: 200 },
      }),
    ],
  });
  const result = renderCompactTree(tree, { layout: true });
  assert.match(result.text, /\[10,20 300×200\]/);
});

// --------------------------------------------------------------------------
// renderTokensList
// --------------------------------------------------------------------------

test("renderTokensList groups by property, sorts values, and lists layer usage with types", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ fill: "colors.b" }),
    children: [
      node({
        id: "0:2",
        type: "FRAME",
        name: "Card",
        sharedPluginData: tokens({ fill: "colors.a" }),
      }),
      node({
        id: "0:3",
        type: "INSTANCE",
        name: "Button",
        sharedPluginData: tokens({ spacing: "spacing.md" }),
      }),
    ],
  });
  const out = renderTokensList(tree);
  assert.match(out, /3 unique tokens across 2 properties/);
  const fillIdx = out.indexOf("fill (2)");
  const spacingIdx = out.indexOf("spacing (1)");
  assert.ok(fillIdx >= 0 && spacingIdx >= 0 && fillIdx < spacingIdx);
  // Each token value is followed by a "→ layerName (TYPE)" line.
  assert.match(out, /colors\.a\n\s+→ Card \(FRAME\)/);
  assert.match(out, /colors\.b\n\s+→ Root \(FRAME\)/);
  assert.match(out, /spacing\.md\n\s+→ Button \(INSTANCE\)/);
});

test("renderTokensList counts repeated (name,type) layers as ×N", () => {
  const mkCard = () =>
    node({
      id: "x",
      type: "INSTANCE",
      name: "Card",
      sharedPluginData: tokens({ fill: "colors.a" }),
    });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [mkCard(), mkCard(), mkCard()],
  });
  const out = renderTokensList(tree);
  assert.match(out, /→ Card \(INSTANCE ×3\)/);
});

test("renderTokensList handles the empty case", () => {
  const tree = node({ id: "0:1", type: "FRAME" });
  assert.match(renderTokensList(tree), /No Tokens Studio tokens applied/);
});

test("renderTokensList appends a ⚠ untokenized layers section when gaps are found", () => {
  const gap = node({
    id: "0:2",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ fill: "colors.a" }),
    children: [gap],
  });
  const out = renderTokensList(tree);
  assert.match(out, /⚠ 1 untokenized layer with visual styling:/);
  assert.match(out, /Card\s+FRAME\s+0:2\s+fill/);
});

test("renderTokensList suppresses the gap section when warnStyleGaps=false", () => {
  const gap = node({
    id: "0:2",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    sharedPluginData: tokens({ fill: "colors.a" }),
    children: [gap],
  });
  const out = renderTokensList(tree, { warnStyleGaps: false });
  assert.ok(!out.includes("untokenized"));
});

// --------------------------------------------------------------------------
// Style gap rendering + -g filter
// --------------------------------------------------------------------------

test("renderCompactTree flags nodes with style gaps and no tokens", () => {
  const gap = node({
    id: "0:2",
    type: "FRAME",
    name: "Styled",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [gap],
  });
  const result = renderCompactTree(tree);
  assert.match(result.text, /Styled\s+FRAME 0:2\s+⚠ untokenized=fill/);
  assert.equal(result.gaps, 1);
});

test("renderCompactTree does NOT flag an untokenized VECTOR icon as a gap", () => {
  // The whole point of the vector-suppression rule: an Icon path with a
  // default fill should be silent in the tree, not a ⚠ line.
  const icon = node({
    id: "0:2",
    type: "VECTOR",
    name: "Icon",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [icon],
  });
  const result = renderCompactTree(tree, { onlyWithTokens: false });
  assert.ok(
    !/⚠ untokenized/.test(result.text),
    `expected no ⚠ marker on an untokenized vector, got:\n${result.text}`
  );
  assert.equal(result.gaps, 0);
});

test("renderCompactTree DOES flag a tokenized vector with leftover gaps", () => {
  const icon = node({
    id: "0:2",
    type: "VECTOR",
    name: "iconBase",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
    sharedPluginData: tokens({ fill: "colors.primary.500" }),
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [icon],
  });
  const result = renderCompactTree(tree, { onlyWithTokens: false });
  assert.match(result.text, /iconBase\s+VECTOR 0:2.*⚠ untokenized=borderColor/);
});

test("renderCompactTree onlyGaps filter prunes everything without gaps", () => {
  const leafGap = node({
    id: "0:3",
    type: "FRAME",
    name: "HasGap",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const leafClean = node({ id: "0:4", type: "FRAME", name: "Clean" });
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [
      node({ id: "0:2", type: "FRAME", name: "A", children: [leafGap] }),
      node({ id: "0:5", type: "FRAME", name: "B", children: [leafClean] }),
    ],
  });
  const result = renderCompactTree(tree, { onlyGaps: true });
  assert.match(result.text, /HasGap/);
  assert.ok(!result.text.includes("Clean"), "Clean branch should be pruned");
  // The B branch has no gap so it should be filtered out entirely.
  assert.ok(!result.text.includes("B "));
});

test("renderCompactTree hides composition values by default but leaves a placeholder so the node reads as tokenized", () => {
  const n = node({
    id: "0:1",
    type: "FRAME",
    name: "Card",
    sharedPluginData: tokens({ composition: "some.comp", fill: "colors.a" }),
  });
  const result = renderCompactTree(n);
  // The literal value "some.comp" is hidden…
  assert.ok(!result.text.includes("some.comp"));
  // …but the placeholder keeps the cluster honest: a composition token
  // IS applied, we're just not unpacking its multi-property value.
  assert.match(result.text, /composition=…/);
  assert.match(result.text, /fill=colors\.a/);
});

test("renderCompactTree counts a composition-only node as tokenized in coverage", () => {
  // Regression: composition-only nodes used to be labelled `applied="none"`
  // and dropped from `withTokens`. They're legitimate tokenized layers.
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ composition: "ecom.root" }),
    children: [
      node({
        id: "0:2",
        type: "INSTANCE",
        name: "Card",
        sharedPluginData: tokens({ composition: "ecom.card" }),
      }),
    ],
  });
  const result = renderCompactTree(tree);
  assert.equal(result.withTokens, 2);
  assert.equal(result.total, 2);
  assert.match(result.text, /coverage=2\/2/);
});

test("renderCompactTree onlyWithTokens keeps a composition-only branch", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    children: [
      node({
        id: "0:2",
        type: "INSTANCE",
        name: "Composed",
        sharedPluginData: tokens({ composition: "some.c" }),
      }),
    ],
  });
  const result = renderCompactTree(tree, { onlyWithTokens: true });
  assert.match(result.text, /Composed/);
});

test("renderCompactTree does NOT flag gaps on a composition-bearing node with raw fills", () => {
  // Composition tokens bundle multiple property styles; we can't expand
  // them without resolving the token set, so we trust them to cover all
  // visuals. A node with composition + raw fills should come out clean.
  const card = node({
    id: "0:2",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
    sharedPluginData: tokens({ composition: "ecom.card.base" }),
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const result = renderCompactTree(card, { onlyWithTokens: false });
  assert.ok(!result.text.includes("⚠"));
  assert.equal(result.gaps, 0);
});

test("renderCompactTree shows composition tokens when includeComposition=true", () => {
  const n = node({
    id: "0:1",
    type: "FRAME",
    name: "Card",
    sharedPluginData: tokens({ composition: "some.comp", fill: "colors.a" }),
  });
  const result = renderCompactTree(n, { includeComposition: true });
  assert.match(result.text, /composition=some\.comp/);
  assert.match(result.text, /fill=colors\.a/);
});

test("renderTokensList surfaces hidden composition count in the header", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ composition: "c.r" }),
    children: [
      node({
        id: "0:2",
        type: "INSTANCE",
        name: "Card",
        sharedPluginData: tokens({ composition: "c.card", fill: "colors.a" }),
      }),
    ],
  });
  const out = renderTokensList(tree);
  // Hidden composition hint is present and the opt-in flag is mentioned.
  assert.match(out, /2 composition tokens hidden/);
  assert.match(out, /--with-composition/);
  // Non-composition tokens still show up normally.
  assert.match(out, /fill \(1\)/);
  assert.match(out, /colors\.a/);
});

test("renderTokensList with includeComposition=true hides the hint and lists compositions", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ composition: "c.r" }),
  });
  const out = renderTokensList(tree, { includeComposition: true });
  assert.ok(!out.includes("hidden"));
  assert.match(out, /composition \(1\)/);
  assert.match(out, /c\.r/);
});

test("renderTokensList on a composition-only subtree tells the user instead of going silent", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: tokens({ composition: "only.this" }),
  });
  const out = renderTokensList(tree);
  // Must not be the bare "No Tokens Studio tokens applied" message — the
  // user needs to know composition was the carrier and how to opt in.
  assert.match(out, /1 composition token/);
  assert.match(out, /--with-composition/);
});

test("renderMetadataXml emits untokenized attribute on the tokens element", () => {
  const n = node({
    id: "0:1",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const { xml } = renderMetadataXml(n);
  // Both gaps sorted alphabetically: borderColor,fill
  assert.match(xml, /<tokens applied="none" untokenized="borderColor,fill"\/>/);
});

// --------------------------------------------------------------------------
// renderMetadataXml (legacy) — verify new behaviour
// --------------------------------------------------------------------------

test("renderMetadataXml strips hash/version and collapses instance-path ids", () => {
  const tree = node({
    id: "I94:774;93:4034;214:7220",
    type: "INSTANCE",
    name: "Card",
    sharedPluginData: {
      tokens: {
        fill: '"colors.primary.500"',
        hash: '"abcdef"',
        version: '"2"',
      },
    },
  });
  const result = renderMetadataXml(tree);
  assert.ok(!result.xml.includes("hash="));
  assert.ok(!result.xml.includes("version="));
  // Collapsed id, not the full instance path.
  assert.ok(result.xml.includes('id="214:7220"'));
  assert.ok(!result.xml.includes("I94:774;"));
});

test("renderMetadataXml omits x/y/w/h by default and includes them with layout=true", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
  });
  const noLayout = renderMetadataXml(tree);
  assert.ok(!noLayout.xml.includes('x="10"'));
  const withLayout = renderMetadataXml(tree, { layout: true });
  assert.ok(withLayout.xml.includes('x="10"'));
  assert.ok(withLayout.xml.includes('w="100"'));
});
