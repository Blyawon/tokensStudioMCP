import { test } from "node:test";
import assert from "node:assert/strict";

import { buildRow } from "./inspect-node.js";
import { makeResolver, type SetMap } from "../../remap/resolver.js";
import type { FigmaNode } from "../../figma-client.js";
import type { TokenCatalog } from "../../remap/types.js";

function makeNode(overrides: Partial<FigmaNode> = {}): FigmaNode {
  return {
    id: "1:2",
    name: "Node",
    type: "FRAME",
    ...overrides,
  } as FigmaNode;
}

function makeCatalog(tokens: Array<{ path: string; type: string; set: string }>): TokenCatalog {
  return {
    tokens: tokens.map((t) => ({ path: t.path, type: t.type, set: t.set })),
    themes: [],
    warnings: [],
  };
}

test("buildRow: primitive color token carries nested resolved tree + legacy fields", () => {
  const values: SetMap = {
    base: {
      colors: {
        brand: { value: "{colors.blue}", type: "color" },
        blue: { value: "#3B82F6", type: "color" },
      },
    },
  };
  const { resolve, resolveInline } = makeResolver(values, ["base"]);
  const catalog = makeCatalog([
    { path: "colors.brand", type: "color", set: "base" },
    { path: "colors.blue", type: "color", set: "base" },
  ]);

  const row = buildRow({
    node: makeNode(),
    property: "fill",
    tokenPath: "{colors.brand}",
    resolve,
    resolveInline,
    catalog,
    preferredSets: new Set(["base"]),
    maxSuggestions: 3,
  });

  assert.equal(row.broken, false);
  assert.equal(row.tokenPath, "colors.brand");
  assert.equal(row.resolvedValue, "#3B82F6", "primitive value mirrored for legacy clients");
  assert.ok(row.resolved, "resolved tree populated");
  assert.equal(row.resolved?.kind, "primitive");
  assert.ok(Array.isArray(row.trail) && row.trail.length >= 2, "trail has a chain");
});

test("buildRow: composition token exposes every inner entry resolved", () => {
  const values: SetMap = {
    base: {
      colors: { surface: { value: "#ffffff", type: "color" } },
      spacing: { md: { value: "16px", type: "spacing" } },
      card: {
        default: {
          value: {
            fill: "{colors.surface}",
            paddingAll: "{spacing.md}",
          },
          type: "composition",
        },
      },
    },
  };
  const { resolve, resolveInline } = makeResolver(values, ["base"]);
  const catalog = makeCatalog([
    { path: "card.default", type: "composition", set: "base" },
    { path: "colors.surface", type: "color", set: "base" },
    { path: "spacing.md", type: "spacing", set: "base" },
  ]);

  const row = buildRow({
    node: makeNode(),
    property: "composition",
    tokenPath: "{card.default}",
    resolve,
    resolveInline,
    catalog,
    preferredSets: new Set(["base"]),
    maxSuggestions: 3,
  });

  assert.equal(row.broken, false);
  assert.equal(row.resolved?.kind, "composition");
  if (row.resolved?.kind === "composition") {
    const entries = row.resolved.entries;
    assert.ok(entries.fill, "fill entry present");
    assert.equal(entries.fill.kind, "primitive");
    if (entries.fill.kind === "primitive") {
      assert.equal(entries.fill.value, "#ffffff");
    }
    assert.ok(entries.paddingAll, "paddingAll entry present");
    assert.equal(entries.paddingAll.kind, "primitive");
    if (entries.paddingAll.kind === "primitive") {
      assert.equal(entries.paddingAll.value, 16);
    }
  }
  // Must NOT populate resolvedValue for composites — that field is primitive-only.
  assert.equal(row.resolvedValue, undefined);
});

test("buildRow: inline composition JSON resolves to (inline) with breakdown", () => {
  const values: SetMap = {
    base: {
      colors: { surface: { value: "#fff", type: "color" } },
    },
  };
  const { resolve, resolveInline } = makeResolver(values, ["base"]);
  const catalog = makeCatalog([
    { path: "colors.surface", type: "color", set: "base" },
  ]);

  const inlineJson = JSON.stringify({ fill: "{colors.surface}", paddingAll: "12px" });
  const row = buildRow({
    node: makeNode(),
    property: "composition",
    tokenPath: inlineJson,
    resolve,
    resolveInline,
    catalog,
    preferredSets: new Set(["base"]),
    maxSuggestions: 3,
  });

  assert.equal(row.broken, false);
  assert.equal(row.tokenPath, "(inline)");
  assert.equal(row.inline, true);
  assert.equal(row.tokenType, "composition");
  assert.equal(row.resolved?.kind, "composition");
  if (row.resolved?.kind === "composition") {
    assert.equal(row.resolved.entries.fill?.kind, "primitive");
    assert.equal(row.resolved.entries.paddingAll?.kind, "primitive");
  }
});

test("buildRow: typography token exposes each font prop resolved", () => {
  const values: SetMap = {
    base: {
      fontFamilies: { inter: { value: "Inter", type: "fontFamilies" } },
      typography: {
        heading: {
          value: {
            fontFamily: "{fontFamilies.inter}",
            fontSize: "32px",
            lineHeight: "40px",
            fontWeight: "700",
          },
          type: "typography",
        },
      },
    },
  };
  const { resolve, resolveInline } = makeResolver(values, ["base"]);
  const catalog = makeCatalog([
    { path: "typography.heading", type: "typography", set: "base" },
    { path: "fontFamilies.inter", type: "fontFamilies", set: "base" },
  ]);

  const row = buildRow({
    node: makeNode({ type: "TEXT" }),
    property: "typography",
    tokenPath: "{typography.heading}",
    resolve,
    resolveInline,
    catalog,
    preferredSets: new Set(["base"]),
    maxSuggestions: 3,
  });

  assert.equal(row.broken, false);
  assert.equal(row.resolved?.kind, "typography");
  if (row.resolved?.kind === "typography") {
    assert.equal(row.resolved.props.fontFamily?.kind, "primitive");
    if (row.resolved.props.fontFamily?.kind === "primitive") {
      assert.equal(row.resolved.props.fontFamily.value, "Inter");
    }
    assert.equal(row.resolved.props.fontSize?.kind, "primitive");
  }
});

test("buildRow: unknown token path is broken with failure reason", () => {
  const values: SetMap = { base: { colors: { red: { value: "#f00", type: "color" } } } };
  const { resolve, resolveInline } = makeResolver(values, ["base"]);
  const catalog = makeCatalog([{ path: "colors.red", type: "color", set: "base" }]);

  const row = buildRow({
    node: makeNode(),
    property: "fill",
    tokenPath: "{colors.does-not-exist}",
    resolve,
    resolveInline,
    catalog,
    preferredSets: new Set(["base"]),
    maxSuggestions: 3,
  });

  assert.equal(row.broken, true);
  assert.ok(row.failureReason && row.failureReason.length > 0);
  assert.equal(row.resolved, undefined);
});
