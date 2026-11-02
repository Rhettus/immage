// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { textButton, choose } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
function geometry() {
  const bounds = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
  const rect = document.querySelector('.crop-rect'), overlay = document.querySelector('.crop-overlay');
  if (!rect || !overlay) return null;
  return { rect: bounds(rect), overlay: bounds(overlay), grid: bounds(rect.querySelector('.crop-grid')),
    aspect: document.querySelector('.crop-aspect select')?.value,
    handles: Object.fromEntries([...rect.querySelectorAll('.crop-handle')].map(e => [e.className.split(' ').at(-1), bounds(e)])) };
}
const area = g => g.rect.width * g.rect.height;
const ratio = g => g.rect.width / g.rect.height;
async function enter(t) {
  await click(t, 'button[data-tour="crop"]');
  return until(() => t.driver.observe(geometry), 'crop overlay');
}
export async function cropGuides(t) {
  await enter(t);
  const g = await t.driver.observe(geometry);
  assert(g.rect.width > 50 && g.rect.height > 50);
  for (const k of ['x', 'y', 'width', 'height']) assert(Math.abs(g.rect[k] - g.grid[k]) <= 3, `initial guides align on ${k}`);
  assert.equal(Object.keys(g.handles).length, 8);
  t.measure({ name: '323cfa9-initial-guides', ...g });
  await t.evidence('initial-guides');
  await textButton(t, '.crop-buttons', 'Cancel');
}
export async function cropLocked(t) {
  await enter(t); await choose(t, '.crop-aspect select', '1:1');
  for (const corner of ['nw', 'ne', 'sw', 'se']) for (const axis of ['x', 'y']) {
    await textButton(t, '.crop-buttons', 'Reset');
    await choose(t, '.crop-aspect select', 'free'); await choose(t, '.crop-aspect select', '1:1');
    const before = await t.driver.observe(geometry), handle = await reveal(t, `.crop-handle.${corner}`);
    const end = { x: handle.x, y: handle.y };
    end[axis] += (axis === 'x' ? corner.includes('w') : corner.includes('n')) ? 25 : -25;
    await t.driver.drag(handle, end);
    const after = await until(async () => { const g = await t.driver.observe(geometry); return area(g) < area(before) - 20 && g; }, 'single-axis corner shrinks locked crop');
    assert(Math.abs(ratio(after) - 1) < .025, 'locked square aspect retained');
    t.measure({ name: `${corner}-${axis}`, before, after }); await t.evidence(`${corner}-${axis}`);
  }
  await textButton(t, '.crop-buttons', 'Cancel');
}
export async function cropPortrait(t) {
  const baseline = await settledPhoto(t);
  assert(baseline.height > baseline.width, 'portrait fixture must render portrait before crop (use --fixture portrait)');
  await enter(t); await choose(t, '.crop-aspect select', '3:2');
  const orientation = await t.driver.observe(() => document.querySelector('.crop-aspect button')?.textContent);
  if (!orientation.includes('Portrait')) await click(t, '.crop-aspect button');
  for (const edge of ['n', 's', 'e', 'w']) {
    const before = await t.driver.observe(geometry), h = await reveal(t, `.crop-handle.${edge}`);
    const to = { x: h.x, y: h.y }; to[['n','s'].includes(edge) ? 'y' : 'x'] += ['n','w'].includes(edge) ? 15 : -15;
    await t.driver.drag(h, to);
    const after = await until(async () => { const g = await t.driver.observe(geometry); return area(g) < area(before) && g; }, 'portrait edge shrinks');
    assert(Math.abs(ratio(after) - 2 / 3) < .025, 'portrait aspect stays portrait');
    await t.evidence(`portrait-${edge}`); t.measure({ name: edge, before, after });
  }
  await textButton(t, '.crop-buttons', 'Done');
  await settledPhoto(t, p => p.height > p.width);
}
export async function cropOptions(t) {
  const baseline = await settledPhoto(t); await enter(t);
  const options = await t.driver.observe(() => [...document.querySelector('.crop-aspect select').options].map(o => o.value));
  for (const value of options.filter(v => v !== 'enter-custom')) {
    await choose(t, '.crop-aspect select', value);
    const g = await t.driver.observe(geometry); assert(area(g) > 10); await t.evidence(`aspect-${value.replaceAll(':','-')}`);
  }
  await choose(t, '.crop-aspect select', 'enter-custom');
  for (const [label, number] of [['width','7'], ['height','5']]) {
    await click(t, `.crop-custom input[aria-label="${label}"]`);
    await t.driver.chord('\uE009', 'a'); await t.driver.keys(number);
  }
  await textButton(t, '.crop-custom', 'Set');
  assert((await t.driver.observe(geometry)).aspect.startsWith('custom:'));
  await t.evidence('custom-aspect');
  await textButton(t, '.crop-buttons', 'Cancel');
  await settledPhoto(t, p => p.hash === baseline.hash);
  await enter(t);
  for (const title of ['rotate left (', 'rotate right (', 'flip horizontal', 'flip vertical']) {
    await click(t, `.crop-turn button[title^=${JSON.stringify(title)}]`); await t.evidence(title.replace(/[^a-z]/g,'-'));
  }
  await textButton(t, '.crop-buttons', 'Cancel');
}
