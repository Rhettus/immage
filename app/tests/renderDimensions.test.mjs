import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRenderArgs, renderDimensions } from "../src/renderDimensions.ts";

test("fit dimensions round fractional viewport pixels and clamp to limits", () => {
  assert.deepEqual(renderDimensions(1168.52000004577637, 801.25, 2560), { width: 1169, height: 801 });
  assert.deepEqual(renderDimensions(0.2, -2, 2560), { width: 1, height: 1 });
  assert.deepEqual(renderDimensions(3000.2, 4000.8, 2560), { width: 2560, height: 2560 });
});

test("render requests normalize both dimensions and preserve other fields", () => {
  assert.deepEqual(normalizeRenderArgs({ width: 1168.52, height: 612.6, edits: "edit" }, 2560), {
    width: 1169, height: 613, edits: "edit",
  });
  assert.deepEqual(normalizeRenderArgs({ width: 3000, height: 4000 }, 0xFFFF_FFFF), { width: 3000, height: 4000 });
});
