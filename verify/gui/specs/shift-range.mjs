// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { reveal } from '../support/controls.mjs';
import { Blocked } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export const shiftRangeFixtures = Array.from({ length: 8 }, (_, i) => `shift-${i + 1}.jpg`);
const cell = name => `.filmstrip.grid .thumb[title=${JSON.stringify(name)}]`;
const selectedNames = t => t.driver.observe(() =>
  [...document.querySelectorAll('.filmstrip.grid .thumb.selected')].map(e => e.title));
// mulberry32: a seed in the report reproduces a failing sequence
const prng = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// Five random ranges in the grid, alternating rightward and leftward, at least three photos apart: a plain click on one photo, then (after a
// random pause, from none to a second or two) a Shift-click on another. The
// selection must be exactly the photos between them, in either direction.
export async function shiftRange(t) {
  if (t.fixture.raw) throw new Blocked('shift-range needs the isolated JPEG fixture');
  for (const name of shiftRangeFixtures)
    await until(() => t.driver.observe(s => !!document.querySelector(s), `.filmstrip .thumb[title="${name}"]`), `imported ${name}`, 60000);
  await settledPhoto(t);
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  await pause(1500);
  const seed = Number(process.env.SHIFT_SEED) || Date.now() % 1e9, rnd = prng(seed);
  const order = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip.grid .thumb')].map(e => e.title));
  assert(order.length >= 8, `grid lists the fixtures (${order.length})`);
  const runs = [];
  for (let n = 1; n <= 5; n++) {
    let a, b;
    // alternate right and left, at least three photos apart
    const right = n % 2 === 1;
    do { a = Math.floor(rnd() * order.length); b = Math.floor(rnd() * order.length); } while (right ? b - a < 2 : a - b < 2);
    const delay = [0, 100, 400, 1500][Math.floor(rnd() * 4)];
    const first = await reveal(t, cell(order[a]));
    await t.driver.point(first.x, first.y);
    await pause(delay);
    const last = await reveal(t, cell(order[b]));
    await t.driver.modifiedPoint('', last.x, last.y);
    await pause(300);
    const want = order.slice(Math.min(a, b), Math.max(a, b) + 1).sort();
    const got = (await selectedNames(t)).sort();
    runs.push({ n, direction: right ? 'right' : 'left', from: order[a], to: order[b], delay, want: want.length, got: got.length });
    t.measure({ name: 'shift-range', seed, ...runs.at(-1) });
    await t.evidence(`shift-range-${n}`);
    assert.deepEqual(got, want, `range ${n} (seed ${seed}): ${order[a]} then Shift-click ${order[b]} after ${delay}ms`);
    assert(await t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), `range ${n}: still in the grid`);
  }
}
