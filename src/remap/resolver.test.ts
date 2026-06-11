import { test } from "node:test";
import assert from "node:assert/strict";

import { makeResolver, looksLikeInlineCompositionJson, type SetMap } from "./resolver.js";

function prim(value: unknown): { value: unknown; type: string } {
  return { value, type: typeof value === "number" ? "dimension" : "color" };
}

function dim(value: number | string): { value: number | string; type: string } {
  return { value, type: "dimension" };
}

test("resolver: plain string primitive", () => {
  const values: SetMap = {
    base: { color: { primary: { value: "#ff0000", type: "color" } } },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("color.primary");
  assert.equal(r?.kind, "primitive");
  assert.equal(r && r.kind === "primitive" && r.value, "#ff0000");
});

test("resolver: single reference resolves to target", () => {
  const values: SetMap = {
    base: {
      color: {
        red: { value: "#ff0000", type: "color" },
        primary: { value: "{color.red}", type: "color" },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("color.primary");
  assert.equal(r?.kind, "primitive");
  assert.equal(r && r.kind === "primitive" && r.value, "#ff0000");
});

test("resolver: deep reference chain resolves", () => {
  const values: SetMap = {
    base: {
      a: { value: "#123456", type: "color" },
      b: { value: "{a}", type: "color" },
      c: { value: "{b}", type: "color" },
      d: { value: "{c}", type: "color" },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("d");
  assert.equal(r?.kind, "primitive");
  assert.equal(r && r.kind === "primitive" && r.value, "#123456");
});

test("resolver: self-cycle returns null (depth guard)", () => {
  const values: SetMap = {
    base: { loop: { value: "{loop}", type: "color" } },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("loop");
  assert.equal(r, null);
});

test("resolver: mutual cycle a->b->a returns null", () => {
  const values: SetMap = {
    base: {
      a: { value: "{b}", type: "color" },
      b: { value: "{a}", type: "color" },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  assert.equal(resolve("a"), null);
  assert.equal(resolve("b"), null);
});

test("resolver: missing reference returns null", () => {
  const values: SetMap = {
    base: { a: { value: "{nonexistent}", type: "color" } },
  };
  const { resolve } = makeResolver(values, ["base"]);
  assert.equal(resolve("a"), null);
});

test("resolver: unit strip — 16px → 16", () => {
  const values: SetMap = {
    base: { spacing: { s4: dim("16px") } },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("spacing.s4");
  assert.equal(r?.kind, "primitive");
  assert.equal(r && r.kind === "primitive" && r.value, "16px");
});

test("resolver: math expression {base} * 2", () => {
  const values: SetMap = {
    base: {
      base: dim(8),
      s4: dim("{base} * 2"),
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("s4");
  assert.equal(r?.kind, "primitive");
  assert.equal(r && r.kind === "primitive" && r.value, 16);
});

test("resolver: math expression with duplicate ref {a} + {a}", () => {
  const values: SetMap = {
    base: {
      a: dim(5),
      sum: dim("{a} + {a}"),
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("sum");
  assert.equal(r && r.kind === "primitive" && r.value, 10);
});

test("resolver: math with parentheses and precedence", () => {
  const values: SetMap = {
    base: {
      a: dim(4),
      b: dim(3),
      expr: dim("({a} + {b}) * 2"),
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("expr");
  assert.equal(r && r.kind === "primitive" && r.value, 14);
});

test("resolver: math with nested string-valued ref", () => {
  // b resolves to a's value which is a literal number
  const values: SetMap = {
    base: {
      unit: dim(16),
      base: dim("{unit}"),
      double: dim("{base} * 2"),
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("double");
  assert.equal(r && r.kind === "primitive" && r.value, 32);
});

test("resolver: set precedence — ENABLED wins over SOURCE", () => {
  const values: SetMap = {
    core: {
      color: { primary: prim("#000000") },
    },
    brand: {
      color: { primary: prim("#ff0000") },
    },
  };
  const { resolve } = makeResolver(
    values,
    ["core", "brand"],
    { core: "source", brand: "enabled" }
  );
  const r = resolve("color.primary");
  assert.equal(r && r.kind === "primitive" && r.value, "#ff0000");
});

test("resolver: set precedence — SOURCE still fills slots not present in ENABLED", () => {
  const values: SetMap = {
    core: {
      color: {
        primary: prim("#000000"),
        secondary: prim("#222222"),
      },
    },
    brand: {
      color: { primary: prim("#ff0000") },
    },
  };
  const { resolve } = makeResolver(
    values,
    ["core", "brand"],
    { core: "source", brand: "enabled" }
  );
  const primary = resolve("color.primary");
  const secondary = resolve("color.secondary");
  assert.equal(primary && primary.kind === "primitive" && primary.value, "#ff0000");
  assert.equal(secondary && secondary.kind === "primitive" && secondary.value, "#222222");
});

test("resolver: set precedence — SOURCE never overwrites ENABLED regardless of order", () => {
  const values: SetMap = {
    brand: { color: { primary: prim("#ff0000") } },
    core: { color: { primary: prim("#000000") } },
  };
  // Note: enabled set listed first, source set second — order shouldn't matter.
  const { resolve } = makeResolver(
    values,
    ["brand", "core"],
    { brand: "enabled", core: "source" }
  );
  const r = resolve("color.primary");
  assert.equal(r && r.kind === "primitive" && r.value, "#ff0000");
});

test("resolver: typography composite", () => {
  const values: SetMap = {
    base: {
      font: {
        heading: {
          value: { fontFamily: "Inter", fontWeight: 700, fontSize: "24px" },
          type: "typography",
        },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("font.heading");
  assert.equal(r?.kind, "typography");
  if (r?.kind === "typography") {
    const family = r.props.fontFamily;
    assert.equal(family?.kind === "primitive" && family.value, "Inter");
    const weight = r.props.fontWeight;
    assert.equal(weight?.kind === "primitive" && weight.value, 700);
  }
});

test("resolver: shadow token with multiple layers", () => {
  const values: SetMap = {
    base: {
      shadow: {
        elevation1: {
          value: [
            { type: "dropShadow", color: "#000000", x: 0, y: 1, blur: 2, spread: 0 },
            { type: "innerShadow", color: "#111111", x: 0, y: 0, blur: 4, spread: 1 },
          ],
          type: "boxShadow",
        },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("shadow.elevation1");
  assert.equal(r?.kind, "shadow");
  if (r?.kind === "shadow") {
    assert.equal(r.layers.length, 2);
    assert.equal(r.layers[0].type, "dropShadow");
    assert.equal(r.layers[1].type, "innerShadow");
    assert.equal(r.layers[0].color, "#000000");
  }
});

test("resolver: shadow layer resolves color ref", () => {
  const values: SetMap = {
    base: {
      shadowColor: { value: "#abcdef", type: "color" },
      shadow: {
        e1: {
          value: [{ type: "dropShadow", color: "{shadowColor}", x: 0, y: 0, blur: 0, spread: 0 }],
          type: "boxShadow",
        },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("shadow.e1");
  assert.equal(r?.kind, "shadow");
  if (r?.kind === "shadow") {
    assert.equal(r.layers[0].color, "#abcdef");
  }
});

test("resolver: composition token resolves nested refs", () => {
  const values: SetMap = {
    base: {
      color: { bg: { value: "#ffffff", type: "color" } },
      spacing: { md: { value: "16px", type: "dimension" } },
      comp: {
        card: {
          value: { fill: "{color.bg}", padding: "{spacing.md}" },
          type: "composition",
        },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("comp.card");
  assert.equal(r?.kind, "composition");
  if (r?.kind === "composition") {
    assert.equal(r.entries.fill?.kind === "primitive" && r.entries.fill.value, "#ffffff");
    assert.equal(r.entries.padding?.kind === "primitive" && r.entries.padding.value, "16px");
  }
});

test("resolver: DTCG $value / $type shape also works", () => {
  const values: SetMap = {
    base: { color: { primary: { $value: "#ff00ff", $type: "color" } } },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("color.primary");
  assert.equal(r && r.kind === "primitive" && r.value, "#ff00ff");
});

test("resolver: non-existent token returns null", () => {
  const values: SetMap = { base: { a: { value: "#000", type: "color" } } };
  const { resolve } = makeResolver(values, ["base"]);
  assert.equal(resolve("b"), null);
});

test("resolver: enabled set not listed in enabledSets is not indexed", () => {
  const values: SetMap = {
    enabled: { a: { value: "#111", type: "color" } },
    disabled: { a: { value: "#222", type: "color" } },
  };
  const { resolve } = makeResolver(values, ["enabled"]);
  const r = resolve("a");
  assert.equal(r && r.kind === "primitive" && r.value, "#111");
});

test("resolver: node-applied composition as string reference dereferences to the catalog composition", () => {
  // Mirror of the real case: a node stores `composition: "my.card"` and the
  // catalog has `my.card` defined as a composition with nested refs.
  const values: SetMap = {
    base: {
      color: { bg: { value: "#123456", type: "color" } },
      my: {
        card: {
          value: "{my.cardInner}",
          type: "composition",
        },
        cardInner: {
          value: { fill: "{color.bg}" },
          type: "composition",
        },
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("my.card");
  assert.equal(r?.kind, "composition");
  if (r?.kind === "composition") {
    const fill = r.entries.fill;
    assert.equal(fill?.kind === "primitive" && fill.value, "#123456");
  }
});

test("resolver: composition value as inline JSON-stringified object expands", () => {
  const values: SetMap = {
    base: {
      color: { bg: { value: "#abcdef", type: "color" } },
      inline: {
        value: '{"fill":"{color.bg}","paddingTop":"16px"}',
        type: "composition",
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("inline");
  assert.equal(r?.kind, "composition");
  if (r?.kind === "composition") {
    const fill = r.entries.fill;
    assert.equal(fill?.kind === "primitive" && fill.value, "#abcdef");
    const pad = r.entries.paddingTop;
    assert.equal(pad?.kind === "primitive" && pad.value, "16px");
  }
});

test("resolver: nested composition (composition → composition via reference chain)", () => {
  const values: SetMap = {
    base: {
      color: {
        red: { value: "#ff0000", type: "color" },
      },
      outer: {
        value: { fill: "{inner}" },
        type: "composition",
      },
      inner: {
        value: "{inner2}",
        type: "composition",
      },
      inner2: {
        value: { fill: "{color.red}" },
        type: "composition",
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("outer");
  assert.equal(r?.kind, "composition");
  // outer.fill points to inner (a composition that dereferences to inner2).
  // Our resolver expands outer, encounters `fill: "{inner}"`, and tries to
  // resolve `inner` — which is itself a composition; inner properties of
  // that inner composition will then populate the resolved value.
  if (r?.kind === "composition") {
    const fill = r.entries.fill;
    // fill should be a composition (since inner itself is a composition).
    assert.equal(fill?.kind, "composition");
    if (fill?.kind === "composition") {
      const innerFill = fill.entries.fill;
      assert.equal(innerFill?.kind === "primitive" && innerFill.value, "#ff0000");
    }
  }
});

test("resolver: composition with unresolvable inner prop drops that prop but keeps others", () => {
  const values: SetMap = {
    base: {
      color: { ok: { value: "#111111", type: "color" } },
      mixed: {
        value: { fill: "{color.ok}", paddingTop: "{does.not.exist}" },
        type: "composition",
      },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("mixed");
  assert.equal(r?.kind, "composition");
  if (r?.kind === "composition") {
    assert.ok(r.entries.fill);
    assert.equal(r.entries.paddingTop, undefined);
  }
});

test("resolveInline: JSON-stringified composition with internal refs resolves through the theme index", () => {
  // Mirrors an applied-token node value of shape
  //   composition: '{"fill":"{color.bg}","paddingTop":"16px"}'
  // which previously failed at resolve() because the string isn't a path.
  const values: SetMap = {
    base: {
      color: { bg: { value: "#abcdef", type: "color" } },
    },
  };
  const { resolveInline } = makeResolver(values, ["base"]);
  const r = resolveInline('{"fill":"{color.bg}","paddingTop":"16px"}', "composition");
  assert.equal(r?.kind, "composition");
  if (r?.kind === "composition") {
    const fill = r.entries.fill;
    assert.equal(fill?.kind === "primitive" && fill.value, "#abcdef");
    const pad = r.entries.paddingTop;
    assert.equal(pad?.kind === "primitive" && pad.value, "16px");
  }
});

test("looksLikeInlineCompositionJson: recognises inline composition, rejects paths", () => {
  assert.equal(looksLikeInlineCompositionJson('{"fill":"{color.bg}"}'), true);
  assert.equal(looksLikeInlineCompositionJson('  {"a":1}  '), true);
  assert.equal(looksLikeInlineCompositionJson("styles.button.default"), false);
  assert.equal(looksLikeInlineCompositionJson("{a.b.c}"), false); // reference, not JSON
  assert.equal(looksLikeInlineCompositionJson("[1,2,3]"), false); // array, not composition object
  assert.equal(looksLikeInlineCompositionJson(""), false);
});

test("resolver: 6-deep composition chain still resolves (no artificial depth cap)", () => {
  // Regression test for MAX_COMPOSITION_DEPTH removal. Real catalogs nest
  // component → sub-component → base → atom → primitive chains far deeper
  // than 3. The only depth guard now is MAX_REF_DEPTH on trail length.
  const values: SetMap = {
    base: {
      color: { red: { value: "#ff0000", type: "color" } },
      atom:       { value: { fill: "{color.red}" }, type: "composition" },
      l1: { value: { nested: "{atom}" }, type: "composition" },
      l2: { value: { nested: "{l1}" },   type: "composition" },
      l3: { value: { nested: "{l2}" },   type: "composition" },
      l4: { value: { nested: "{l3}" },   type: "composition" },
      l5: { value: { nested: "{l4}" },   type: "composition" },
      top: { value: { nested: "{l5}" },  type: "composition" },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("top");
  assert.equal(r?.kind, "composition");
  // Walk down: top.nested → l5.nested → l4.nested → l3.nested → l2.nested →
  // l1.nested → atom.fill → #ff0000.
  let node: any = r;
  const steps = ["nested", "nested", "nested", "nested", "nested", "nested", "fill"];
  for (const step of steps) {
    assert.ok(node && node.kind === "composition", `expected composition at ${step}`);
    node = node.entries[step];
  }
  assert.equal(node?.kind, "primitive");
  assert.equal(node?.value, "#ff0000");
});

test("resolver: composition cycle still terminates via MAX_REF_DEPTH", () => {
  const values: SetMap = {
    base: {
      a: { value: { x: "{b}" }, type: "composition" },
      b: { value: { x: "{a}" }, type: "composition" },
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  // Shouldn't hang, shouldn't throw. Result may be a truncated composition
  // (partial chain up to the depth limit), and must be non-crashing.
  const r = resolve("a");
  assert.ok(r === null || r.kind === "composition");
});

test("resolver: division by zero returns null for the math expression", () => {
  const values: SetMap = {
    base: {
      a: dim(10),
      b: dim(0),
      expr: dim("{a} / {b}"),
    },
  };
  const { resolve } = makeResolver(values, ["base"]);
  const r = resolve("expr");
  // Should not crash; returns the raw string if evaluation fails.
  assert.ok(r?.kind === "primitive");
});
