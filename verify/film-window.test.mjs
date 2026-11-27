// SPDX-License-Identifier: GPL-3.0-or-later
// The filmstrip and grid draw only the cells in view (app/src/filmWindow.ts):
// which cells, the spacers standing for the rest, and the scroll that
// reveals a cell
import test from "node:test";
import assert from "node:assert/strict";
import { cellStart, filmGeometry, filmWindow, revealAt } from "../app/src/filmWindow.ts";

// the grid as styles.css lays it out: 10px padding, 6px gaps, 230px columns, 200px rows
const grid = (width) => filmGeometry(true, 200, 230, 6, 10, 10, width);

test("the grid fits the columns CSS auto-fill does", () => {
  assert.equal(grid(20 + 230).cols, 1);
  assert.equal(grid(20 + 230 * 2 + 6).cols, 2);
  assert.equal(grid(20 + 230 * 2 + 5).cols, 1);
  assert.equal(grid(10).cols, 1);
  assert.equal(filmGeometry(false, 150, 0, 3, 6, 6, 5000).cols, 1);
});

test("140,000 photos draw a screenful, and the spacers keep the full length", () => {
  const g = grid(20 + 230 * 5 + 6 * 4); // 5 columns
  const count = 140000, lines = count / 5;
  const full = 2 * g.pad + lines * g.step - g.gap;
  for (const pos of [0, 5000, 2_000_000, full - 800, full + 100]) {
    const w = filmWindow(g, count, pos, 800, 3);
    assert.ok(w.last - w.first <= 5 * (Math.ceil(800 / g.step) + 1 + 6), `${w.last - w.first} cells at ${pos}`);
    assert.ok(w.first < w.last && w.first % 5 === 0);
    const drawnLines = Math.ceil((w.last - w.first) / 5);
    const gapAfterBefore = w.before ? g.gap : 0, gapBeforeAfter = w.after ? g.gap : 0;
    const length = 2 * g.pad + w.before + gapAfterBefore + drawnLines * g.step - g.gap + gapBeforeAfter + w.after;
    assert.equal(length, full, `length at ${pos}`);
    // the drawn cells cover the view
    if (pos <= full - 800) {
      assert.ok(cellStart(g, w.first) <= Math.max(pos, g.pad) &&cellStart(g, w.last - 1) + g.cell >= Math.min(full - g.pad, pos + 800));
    }
  }
});

test("a short folder draws every cell", () => {
  const g = filmGeometry(false, 150, 0, 3, 6, 6, 1200);
  assert.deepEqual(filmWindow(g, 4, 0, 1200, 12), { first: 0, last: 4, before: 0, after: 0 });
  assert.deepEqual(filmWindow(g, 0, 0, 1200, 12), { first: 0, last: 0, before: 0, after: 0 });
});

test("the strip's first drawn cell sits where the spacer leaves it", () => {
  const g = filmGeometry(false, 150, 0, 3, 6, 6, 1200);
  const w = filmWindow(g, 1000, 50000, 1200, 12);
  assert.equal(g.pad + w.before + g.gap, cellStart(g, w.first));
});

test("revealing a cell scrolls the least, or centers it", () => {
  const g = filmGeometry(false, 150, 0, 3, 6, 6, 1200);
  assert.equal(revealAt(g, 2, 0, 1200, false), null);
  assert.equal(revealAt(g, 100, 0, 1200, false), cellStart(g, 100) + 150 - 1200);
  assert.equal(revealAt(g, 10, 5000, 1200, false), cellStart(g, 10));
  assert.equal(revealAt(g, 100, 0, 1200, true), cellStart(g, 100) + 75 - 600);
});
