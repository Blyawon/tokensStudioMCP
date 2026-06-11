import { test } from "node:test";
import assert from "node:assert/strict";

import { renderDesignContext, rgbaToHex } from "./design-context.js";
import type { FigmaNode } from "./figma-client.js";

function node(partial: Partial<FigmaNode> & { id: string; type: string }): FigmaNode {
  return { name: "", ...partial } as FigmaNode;
}

const card: FigmaNode = node({
  id: "1:1",
  name: "Card",
  type: "FRAME",
  absoluteBoundingBox: { x: 100, y: 200, width: 320, height: 180 },
  layoutMode: "VERTICAL",
  itemSpacing: 12,
  paddingTop: 16, paddingRight: 24, paddingBottom: 16, paddingLeft: 24,
  primaryAxisSizingMode: "AUTO",
  counterAxisAlignItems: "CENTER",
  cornerRadius: 8,
  fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
  effects: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 4 }, radius: 12 }],
  sharedPluginData: { tokens: { fill: JSON.stringify("colors.surface") } },
  children: [
    node({
      id: "1:2",
      name: "Title",
      type: "TEXT",
      absoluteBoundingBox: { x: 124, y: 216, width: 272, height: 24 },
      characters: "Hello world",
      style: { fontFamily: "Inter", fontWeight: 600, fontSize: 18, lineHeightPx: 24 },
      fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.1 } }],
    }),
  ],
});

test("renderDesignContext carries layout, visual, typography and tokens", () => {
  const md = renderDesignContext(card);
  assert.match(md, /# Card — frame 1:1/);
  assert.match(md, /flex-col gap=12/);
  assert.match(md, /p=16\/24/);
  assert.match(md, /items=center/);
  assert.match(md, /main=hug/);
  assert.match(md, /fill=#FFFFFF/);
  assert.match(md, /r=8/);
  assert.match(md, /shadow=0,4,12 #00000040/);
  assert.match(md, /tokens\{fill:colors\.surface\}/);
  // Child text node: relative position, font shorthand, content.
  assert.match(md, /\*\*Title\*\* \(text 1:2\) \[24,16 272×24\]/);
  assert.match(md, /font=Inter 600 18\/24/);
  assert.match(md, /"Hello world"/);
});

test("renderDesignContext truncates at maxDepth", () => {
  const md = renderDesignContext(card, { maxDepth: 0 });
  assert.match(md, /1 children truncated/);
  assert.doesNotMatch(md, /Title/);
});

test("rgbaToHex handles alpha", () => {
  assert.equal(rgbaToHex({ r: 1, g: 0, b: 0 }), "#FF0000");
  assert.equal(rgbaToHex({ r: 0, g: 0, b: 0, a: 0.5 }), "#00000080");
});
