// SPDX-License-Identifier: GPL-3.0-or-later
// The grid's thumbnail size (App.tsx gridSize, Filmstrip.tsx): Ctrl+wheel
// (a pinch's events) zooms it continuously, keeping the photo under the
// pointer in place; Ctrl+- eases through intermediate sizes rather than
// jumping
import assert from 'node:assert/strict';
import { Blocked } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export const gridZoomFixtures = Array.from({ length: 24 }, (_, i) => `grid-${String(i + 1).padStart(2, '0')}`);

const state = (x, y) => {
  const root = document.querySelector('.filmstrip.grid');
  if (!root) return null;
  const cells = [...root.querySelectorAll('.thumb')];
  const first = cells[0]?.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  const under = x === undefined ? null : document.elementFromPoint(x, y)?.closest('.thumb');
  const columns = first ? cells.filter((c) => Math.abs(c.getBoundingClientRect().top - first.top) < 1).length : 0;
  return { height: first?.height ?? 0, columns, count: cells.length, scrollTop: root.scrollTop,
           scrollable: root.scrollHeight > root.clientHeight + 4,
           box: { x: r.x, y: r.y, width: r.width, height: r.height },
           under: under ? { title: under.title, top: under.getBoundingClientRect().top } : null };
};
const cellTop = (title) => {
  const el = [...document.querySelectorAll('.filmstrip.grid .thumb')].find((c) => c.title === title);
  return el ? el.getBoundingClientRect().top : null;
};

export async function gridZoom(t) {
  await until(async () => (await t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb').length)) >= 25,
              'the grid fixtures listed', 120000);
  await settledPhoto(t);
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  await pause(1500);
  const start = await t.driver.observe(state);
  t.measure({ name: 'start', ...start });
  assert(start.count >= 25, `grid lists the photos (${start.count})`);
  await t.evidence('grid-start');

  // make it small enough to scroll, then scroll partway down, so the
  // anchor has something to hold against
  for (let i = 0; i < 6 && !(await t.driver.observe(state)).scrollable; i++) {
    await t.driver.chord('', '=');
    await pause(400);
  }
  let s = await t.driver.observe(state);
  if (!s.scrollable) throw new Blocked(`the grid does not scroll at the largest size (${s.count} photos, ${s.columns} columns)`);
  await t.driver.wheel(s.box.x + s.box.width / 2, s.box.y + s.box.height / 2, 300);
  await pause(600);

  // Ctrl+wheel: a few small steps, the size changing by a fraction each
  // time (not a 160 → 200 style jump) and the photo under the pointer
  // keeping its place
  s = await t.driver.observe(state);
  const px = s.box.x + s.box.width * .5, py = s.box.y + s.box.height * .5;
  const anchor = (await t.driver.observe(state, px, py)).under;
  assert(anchor, 'a photo under the pointer');
  const steps = [];
  let before = s;
  for (const delta of [-20, -20, -20, 20, 20, 20, 20]) {
    await t.driver.modifiedWheel('', px, py, delta);
    await pause(250);
    const after = await t.driver.observe(state);
    const top = await t.driver.observe(cellTop, anchor.title);
    steps.push({ delta, height: after.height, columns: after.columns, anchorTop: top });
    before = after;
  }
  t.measure({ name: 'ctrl-wheel', anchor, steps, final: before });
  await t.evidence('grid-wheel');
  const heights = [s.height, ...steps.map((x) => x.height)];
  const changes = heights.slice(1).map((h, i) => h - heights[i]);
  assert(changes.some((c) => Math.abs(c) > .5), `Ctrl+wheel resizes the grid (${heights.join(', ')})`);
  assert(changes.every((c) => Math.abs(c) < 30), `each wheel step is a small change, not a jump (${changes.map((c) => c.toFixed(1)).join(', ')})`);
  assert(changes.slice(0, 3).every((c) => c >= -.5) && changes.slice(3).every((c) => c <= .5),
         `wheel up grows, wheel down shrinks (${changes.map((c) => c.toFixed(1)).join(', ')})`);
  const drift = steps.filter((x) => x.anchorTop !== null).map((x) => Math.abs(x.anchorTop - anchor.top));
  assert(drift.length && Math.max(...drift) < 6, `the photo under the pointer stays in place (drift ${drift.map((d) => d.toFixed(1)).join(', ')})`);

  // Ctrl+-: read straight after the keys, as fast as the driver answers,
  // the height passes through sizes between the start and the end of the
  // 150 ms step (a jump would show only the two)
  const from = (await t.driver.observe(state)).height;
  await t.driver.chord('\uE009', '-');
  const frames = [];
  for (let i = 0; i < 12; i++) frames.push((await t.driver.observe(state)).height);
  await pause(400);
  const to = (await t.driver.observe(state)).height;
  const between = [...new Set(frames)].filter((h) => h < Math.max(from, to) - .5 && h > Math.min(from, to) + .5);
  t.measure({ name: 'key-step', from, to, frames, between });
  await t.evidence('grid-key');
  assert(Math.abs(to - from) > 5, `Ctrl+- shrinks the grid (${from} → ${to})`);
  assert(between.length >= 1, `the step eases through intermediate sizes (frames ${frames.join(', ')})`);

  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'back to the loupe');
}
