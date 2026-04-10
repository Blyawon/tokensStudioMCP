import { test } from "node:test";
import assert from "node:assert/strict";

import type { FigmaNode } from "./figma-client.js";
import {
  collapseInstancePath,
  collectGapReport,
  collectTokenUsage,
  countCompositionTokens,
  extractDisplayTokens,
  extractTokens,
  hasCompositionToken,
  hasVisibleFill,
  isComponentDefinition,
  isIgnoredByConfig,
  isVectorNode,
  makeSkipPredicate,
  reportableGaps,
  styleGaps,
  subtreeHasStyleGaps,
  subtreeHasTokens,
  tokensSignature,
} from "./tokens.js";
import { DEFAULT_CONFIG } from "./config.js";

function node(partial: Partial<FigmaNode> & { id: string; type: string }): FigmaNode {
  return {
    name: "",
    ...partial,
  } as FigmaNode;
}

// --------------------------------------------------------------------------
// extractTokens noise + composition handling
// --------------------------------------------------------------------------

test("extractTokens strips hash and version noise keys", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    sharedPluginData: {
      tokens: {
        fill: '"colors.primary.500"',
        hash: '"deadbeef"',
        version: '"5"',
      },
    },
  });
  assert.deepEqual(extractTokens(n), { fill: "colors.primary.500" });
});

test("extractTokens ignores composition tokens by default", () => {
  const n = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: {
      tokens: {
        fill: '"colors.primary.500"',
        composition: '"ecommerce.container.base.size:lg"',
      },
    },
  });
  assert.deepEqual(extractTokens(n), { fill: "colors.primary.500" });
});

test("extractTokens returns empty when only noise/composition keys are present", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    sharedPluginData: {
      tokens: {
        hash: '"abc"',
        version: '"1"',
        composition: '"some.composition"',
      },
    },
  });
  assert.deepEqual(extractTokens(n), {});
});

test("extractTokens includes composition when includeComposition=true", () => {
  const n = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: {
      tokens: {
        fill: '"colors.primary.500"',
        composition: '"ecommerce.container.base.size:lg"',
      },
    },
  });
  assert.deepEqual(extractTokens(n, { includeComposition: true }), {
    fill: "colors.primary.500",
    composition: "ecommerce.container.base.size:lg",
  });
});

test("hasCompositionToken detects the raw composition key", () => {
  const withComp = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: { tokens: { composition: '"x.y.z"' } },
  });
  const withoutComp = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: { tokens: { fill: '"colors.a"' } },
  });
  assert.equal(hasCompositionToken(withComp), true);
  assert.equal(hasCompositionToken(withoutComp), false);
});

test("extractDisplayTokens adds a composition placeholder when composition is hidden", () => {
  const n = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: {
      tokens: { composition: '"ecommerce.container.base.size:lg"' },
    },
  });
  // Dictionary-side extract stays empty — we don't pollute `collectTokenUsage`.
  assert.deepEqual(extractTokens(n), {});
  // Display-side extract emits a placeholder so the renderer stops labelling
  // the node `applied="none"`. The value is a sentinel, not the real path.
  const display = extractDisplayTokens(n);
  assert.equal(display.composition, "…");
});

test("extractDisplayTokens does not add a placeholder when includeComposition=true", () => {
  const n = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: {
      tokens: { composition: '"ecommerce.container.base.size:lg"' },
    },
  });
  const display = extractDisplayTokens(n, { includeComposition: true });
  assert.equal(display.composition, "ecommerce.container.base.size:lg");
});

test("subtreeHasTokens counts a composition-only node as tokenized", () => {
  // Bug that motivated this path: files whose entire design surface lives
  // in composition tokens were being pruned as "untokenized" under
  // `onlyWithTokens` and undercounted in coverage.
  const n = node({
    id: "1:2",
    type: "INSTANCE",
    sharedPluginData: { tokens: { composition: '"c.x"' } },
  });
  assert.equal(subtreeHasTokens(n), true);
  // And even with includeComposition off — composition presence is
  // load-bearing for coverage regardless of display opts.
  assert.equal(subtreeHasTokens(n, undefined, { includeComposition: false }), true);
});

test("styleGaps suppresses all gap detection on a node with a composition token", () => {
  // Composition bundles an opaque set of property styles. Without
  // resolving the token set we can't know which properties it covers,
  // so the only safe move is to trust it covers everything and emit no
  // gaps — otherwise a file that styles everything via composition
  // would be buried under false positives.
  const n = node({
    id: "1:2",
    type: "FRAME",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
    effects: [{ type: "DROP_SHADOW", visible: true }],
    sharedPluginData: { tokens: { composition: '"ecom.card.base"' } },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), []);
  assert.deepEqual(reportableGaps(n), []);
});

test("styleGaps still flags visual gaps when composition is absent", () => {
  // Sanity check the negative: removing the composition token re-enables
  // the normal gap rules so the early-return above can't mask real gaps.
  const n = node({
    id: "1:2",
    type: "FRAME",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), ["fill"]);
});

test("countCompositionTokens walks the subtree and respects skipNode", () => {
  const leaf = node({
    id: "1:3",
    type: "INSTANCE",
    sharedPluginData: { tokens: { composition: '"x.y"' } },
  });
  const hidden = node({
    id: "1:4",
    type: "COMPONENT",
    sharedPluginData: { tokens: { composition: '"hidden"' } },
  });
  const root = node({
    id: "1:1",
    type: "FRAME",
    sharedPluginData: { tokens: { composition: '"r.s"' } },
    children: [leaf, hidden],
  });
  assert.equal(countCompositionTokens(root), 3);
  const skip = makeSkipPredicate(DEFAULT_CONFIG)!;
  // The COMPONENT child is skipped, so only root + leaf = 2.
  assert.equal(countCompositionTokens(root, skip), 2);
});

test("extractTokens passes composite typography values through unchanged", () => {
  const raw = '{"fontFamily":"Inter","fontSize":16}';
  const n = node({
    id: "1:2",
    type: "TEXT",
    sharedPluginData: { tokens: { typography: raw } },
  });
  assert.deepEqual(extractTokens(n), { typography: raw });
});

test("extractTokens handles missing / non-object sharedPluginData", () => {
  assert.deepEqual(extractTokens(node({ id: "1:2", type: "FRAME" })), {});
  assert.deepEqual(
    extractTokens(node({ id: "1:2", type: "FRAME", sharedPluginData: {} })),
    {}
  );
});

// --------------------------------------------------------------------------
// collapseInstancePath + tokensSignature
// --------------------------------------------------------------------------

test("collapseInstancePath strips everything before the last ';' for I-prefixed ids", () => {
  assert.equal(
    collapseInstancePath("I94:774;93:4034;212:7100;214:7220"),
    "214:7220"
  );
});

test("collapseInstancePath leaves plain ids unchanged", () => {
  assert.equal(collapseInstancePath("2007:102481"), "2007:102481");
  assert.equal(collapseInstancePath("0:1"), "0:1");
});

test("collapseInstancePath handles single-segment instance ids", () => {
  assert.equal(collapseInstancePath("I94:774"), "I94:774");
});

test("tokensSignature is stable regardless of key order", () => {
  const a = tokensSignature({ fill: "a", spacing: "b" });
  const b = tokensSignature({ spacing: "b", fill: "a" });
  assert.equal(a, b);
});

// --------------------------------------------------------------------------
// styleGaps
// --------------------------------------------------------------------------

test("styleGaps flags a shared Figma fill style with no fill token", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    styles: { fill: "S:fillStyleKey123" },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), ["fill"]);
});

test("styleGaps does NOT flag when the shared style is covered by a token", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    styles: { fill: "S:key" },
    sharedPluginData: { tokens: { fill: '"colors.bg"' } },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), []);
});

test("styleGaps flags raw visible fills with no fill token", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), ["fill"]);
});

test("styleGaps does NOT flag raw fills on TEXT nodes (text colour is not a fill gap)", () => {
  const textNode = node({
    id: "1:2",
    type: "TEXT",
    characters: "Hello",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(textNode), []);
});

test("styleGaps still flags a shared fill style on a TEXT node", () => {
  // Assigning a shared fill style to a TEXT node IS explicit design intent,
  // so we keep flagging it — only the raw-fill heuristic is exempted.
  const textNode = node({
    id: "1:2",
    type: "TEXT",
    characters: "Hello",
    styles: { fill: "S:textColorStyle" },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(textNode), ["fill"]);
});

test("styleGaps does not flag an invisible fill", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    fills: [{ type: "SOLID", visible: false }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), []);
});

test("styleGaps flags raw strokes as borderColor gap", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    strokes: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n).sort(), ["borderColor"]);
});

test("styleGaps flags effects as boxShadow gap", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    effects: [{ type: "DROP_SHADOW", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n), ["boxShadow"]);
});

test("styleGaps combines shared style + raw effect gaps", () => {
  const n = node({
    id: "1:2",
    type: "FRAME",
    styles: { fill: "S:abc" },
    effects: [{ type: "DROP_SHADOW", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(n).sort(), ["boxShadow", "fill"]);
});

test("reportableGaps suppresses untokenized VECTOR leaves", () => {
  // VECTOR nodes (icon paths, decorative shapes) flood the gap report
  // with `fill` gaps because every path has a paint and the design
  // intent actually lives on the wrapper. With no applied token, the
  // gap should be suppressed from what the user sees.
  const v = node({
    id: "1:2",
    type: "VECTOR",
    name: "Icon",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(styleGaps(v), ["fill"]); // raw rule still fires
  assert.deepEqual(reportableGaps(v), []); // but we don't surface it
});

test("reportableGaps KEEPS gaps on a vector that has an applied token", () => {
  // Attaching a token to a vector is an explicit statement of intent —
  // any leftover uncovered properties are real gaps worth flagging.
  const v = node({
    id: "1:2",
    type: "VECTOR",
    name: "iconBase",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
    sharedPluginData: { tokens: { fill: '"colors.primary.500"' } },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  // fill is covered by the token, but the raw stroke should still surface
  // because this vector has an explicit token → gaps matter here.
  assert.deepEqual(reportableGaps(v), ["borderColor"]);
});

test("reportableGaps passes non-vector nodes through unchanged", () => {
  const frame = node({
    id: "1:2",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.deepEqual(reportableGaps(frame), ["fill"]);
});

test("reportableGaps suppresses all vector types, not just VECTOR", () => {
  for (const type of [
    "VECTOR",
    "LINE",
    "ELLIPSE",
    "REGULAR_POLYGON",
    "STAR",
    "BOOLEAN_OPERATION",
  ]) {
    const v = node({
      id: "1:2",
      type,
      name: "shape",
      fills: [{ type: "SOLID", visible: true }],
    } as unknown as Partial<FigmaNode> & { id: string; type: string });
    assert.deepEqual(
      reportableGaps(v),
      [],
      `expected ${type} without a token to not surface gaps`
    );
  }
});

test("collectGapReport omits untokenized vector leaves", () => {
  const untokenizedIcon = node({
    id: "1:3",
    type: "VECTOR",
    name: "Icon",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const realGap = node({
    id: "1:4",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const root = node({
    id: "1:1",
    type: "FRAME",
    name: "Root",
    children: [untokenizedIcon, realGap],
  });
  const report = collectGapReport(root);
  assert.equal(report.length, 1);
  assert.equal(report[0].name, "Card");
  assert.equal(report[0].type, "FRAME");
});

test("collectGapReport keeps tokenized vectors that still have gaps", () => {
  const tokenizedIcon = node({
    id: "1:3",
    type: "VECTOR",
    name: "Icon",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
    sharedPluginData: { tokens: { fill: '"colors.primary.500"' } },
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const root = node({
    id: "1:1",
    type: "FRAME",
    name: "Root",
    children: [tokenizedIcon],
  });
  const report = collectGapReport(root);
  assert.equal(report.length, 1);
  assert.equal(report[0].name, "Icon");
  assert.deepEqual(report[0].gaps, ["borderColor"]);
});

test("subtreeHasStyleGaps bubbles up from a leaf", () => {
  const leaf = node({
    id: "0:3",
    type: "FRAME",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const mid = node({ id: "0:2", type: "FRAME", children: [leaf] });
  const root = node({ id: "0:1", type: "FRAME", children: [mid] });
  assert.equal(subtreeHasStyleGaps(root), true);
});

// --------------------------------------------------------------------------
// collectTokenUsage
// --------------------------------------------------------------------------

// --------------------------------------------------------------------------
// Config-driven filters
// --------------------------------------------------------------------------

test("isVectorNode matches VECTOR/LINE/ELLIPSE/STAR/POLYGON/BOOLEAN_OPERATION", () => {
  for (const type of ["VECTOR", "LINE", "ELLIPSE", "REGULAR_POLYGON", "STAR", "BOOLEAN_OPERATION"]) {
    assert.equal(isVectorNode(node({ id: "x", type })), true);
  }
  assert.equal(isVectorNode(node({ id: "x", type: "FRAME" })), false);
  assert.equal(isVectorNode(node({ id: "x", type: "INSTANCE" })), false);
});

test("hasVisibleFill returns true only when at least one fill is visible", () => {
  assert.equal(
    hasVisibleFill(
      node({
        id: "x",
        type: "VECTOR",
        fills: [{ visible: true, type: "SOLID" }],
      } as unknown as Partial<FigmaNode> & { id: string; type: string })
    ),
    true
  );
  assert.equal(
    hasVisibleFill(
      node({
        id: "x",
        type: "VECTOR",
        fills: [{ visible: false, type: "SOLID" }],
      } as unknown as Partial<FigmaNode> & { id: string; type: string })
    ),
    false
  );
  assert.equal(
    hasVisibleFill(
      node({ id: "x", type: "VECTOR", fills: [] } as unknown as Partial<FigmaNode> & { id: string; type: string })
    ),
    false
  );
  assert.equal(hasVisibleFill(node({ id: "x", type: "VECTOR" })), false);
});

test("isComponentDefinition matches COMPONENT and COMPONENT_SET", () => {
  assert.equal(isComponentDefinition(node({ id: "x", type: "COMPONENT" })), true);
  assert.equal(isComponentDefinition(node({ id: "x", type: "COMPONENT_SET" })), true);
  assert.equal(isComponentDefinition(node({ id: "x", type: "INSTANCE" })), false);
  assert.equal(isComponentDefinition(node({ id: "x", type: "FRAME" })), false);
});

test("isIgnoredByConfig: fill-less vector is ignored under default config", () => {
  const vec = node({ id: "1:2", type: "VECTOR" });
  assert.equal(isIgnoredByConfig(vec, DEFAULT_CONFIG), true);
});

test("isIgnoredByConfig: vector WITH a visible fill is kept", () => {
  const vec = node({
    id: "1:2",
    type: "VECTOR",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  assert.equal(isIgnoredByConfig(vec, DEFAULT_CONFIG), false);
});

test("isIgnoredByConfig: COMPONENT subtree is ignored under default config", () => {
  assert.equal(isIgnoredByConfig(node({ id: "1:2", type: "COMPONENT" }), DEFAULT_CONFIG), true);
});

test("makeSkipPredicate returns undefined when both filter flags are off", () => {
  const predicate = makeSkipPredicate({
    ...DEFAULT_CONFIG,
    ignoreComponents: false,
    ignoreVectorsWithoutFill: false,
  });
  assert.equal(predicate, undefined);
});

test("subtreeHasTokens respects skipNode predicate (tokens inside a skipped subtree don't count)", () => {
  const hiddenTokenLeaf = node({
    id: "1:3",
    type: "FRAME",
    sharedPluginData: { tokens: { fill: '"colors.a"' } },
  });
  const ignoredParent = node({
    id: "1:2",
    type: "COMPONENT",
    children: [hiddenTokenLeaf],
  });
  const root = node({ id: "1:1", type: "FRAME", children: [ignoredParent] });
  const skip = makeSkipPredicate(DEFAULT_CONFIG)!;
  assert.equal(subtreeHasTokens(root, skip), false);
  // Without the skip predicate the leaf is still reachable.
  assert.equal(subtreeHasTokens(root), true);
});

test("collectGapReport returns flattened entries with id, type, and sorted gap list", () => {
  const gap = node({
    id: "1:2",
    type: "FRAME",
    name: "Card",
    fills: [{ type: "SOLID", visible: true }],
    strokes: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const root = node({ id: "1:1", type: "FRAME", children: [gap] });
  const report = collectGapReport(root);
  assert.equal(report.length, 1);
  assert.equal(report[0].name, "Card");
  assert.equal(report[0].type, "FRAME");
  assert.deepEqual(report[0].gaps.slice().sort(), ["borderColor", "fill"]);
});

test("collectGapReport skips subtrees hidden by the skipNode predicate", () => {
  const hiddenGap = node({
    id: "1:3",
    type: "VECTOR",
    name: "Deco",
    fills: [{ type: "SOLID", visible: true }],
  } as unknown as Partial<FigmaNode> & { id: string; type: string });
  const wrapper = node({ id: "1:2", type: "COMPONENT", name: "Icon", children: [hiddenGap] });
  const root = node({ id: "1:1", type: "FRAME", children: [wrapper] });
  const skip = makeSkipPredicate(DEFAULT_CONFIG)!;
  const report = collectGapReport(root, skip);
  assert.equal(report.length, 0);
});

test("collectTokenUsage groups by property/value and records layer usage with counts", () => {
  const tree = node({
    id: "0:1",
    type: "FRAME",
    name: "Root",
    sharedPluginData: { tokens: { fill: '"colors.a"' } },
    children: [
      node({
        id: "0:2",
        type: "FRAME",
        name: "Card",
        sharedPluginData: { tokens: { fill: '"colors.a"' } },
      }),
      node({
        id: "0:3",
        type: "FRAME",
        name: "Card",
        sharedPluginData: { tokens: { fill: '"colors.a"' } },
      }),
      node({
        id: "0:4",
        type: "TEXT",
        name: "Title",
        sharedPluginData: { tokens: { fill: '"colors.b"' } },
      }),
    ],
  });

  const usage = collectTokenUsage(tree);
  const fill = usage.get("fill");
  assert.ok(fill, "expected fill bucket");

  const aUsages = fill.get("colors.a");
  assert.ok(aUsages);
  // Card×2 + Root×1 — Card should come first (count=2) then Root (count=1).
  assert.deepEqual(
    aUsages.map((u) => ({ name: u.name, type: u.type, count: u.count })),
    [
      { name: "Card", type: "FRAME", count: 2 },
      { name: "Root", type: "FRAME", count: 1 },
    ]
  );

  const bUsages = fill.get("colors.b");
  assert.deepEqual(bUsages, [{ name: "Title", type: "TEXT", count: 1 }]);
});
