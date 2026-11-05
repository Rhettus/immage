// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, inspect, reveal } from '../support/controls.mjs';
import { Blocked, textButton, choose, panel } from '../support/scenario.mjs';
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
  await choose(t, '.crop-aspect select', 'enter-custom', '.crop-custom');
  // 7 x 3 matches no preset: a ratio that does (7 x 5) picks the preset instead
  for (const [label, number] of [['width','7'], ['height','3']]) {
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
// the crop tool's Auto: Upright's Level fit, kept in Rotate alone. it
// needs a fixture with straight lines; one without them blocks the case
export async function cropAutoStraighten(t) {
  const baseline = await settledPhoto(t); await enter(t);
  const rotate = '.crop-angle [data-control-id="tf_rotate"] input[type=range]';
  const before = +(await t.driver.observe(inspect, rotate)).value;
  await textButton(t, '.crop-angle', 'Auto');
  const outcome = await until(() => t.driver.observe((s, b) => {
    const note = document.querySelector('.crop-angle + .note-plain')?.textContent;
    const v = +document.querySelector(s)?.value;
    return note ? { note } : v !== b ? { value: v } : false;
  }, rotate, before), 'Auto sets Rotate or reports why not', 30000);
  if (outcome.note) throw new Blocked(`fixture has no level fit: ${outcome.note}`);
  assert(Math.abs(outcome.value) <= 45, 'Rotate stays in its range');
  t.measure({ name: 'auto-straighten', before, after: outcome.value }); await t.evidence('auto-straighten');
  // Cancel keeps Rotate, which is not the crop's to undo; Done would add
  // a Crop step (an uncropped photo gains the Original aspect), and the
  // one undo below would take that instead of Auto's
  await textButton(t, '.crop-buttons', 'Cancel');
  const levelled = await settledPhoto(t, p => p.hash !== baseline.hash); await t.evidence('auto-straighten-applied');
  await click(t, 'button.tool[title^="undo ("]');
  await settledPhoto(t, p => p.hash === baseline.hash); await t.evidence('auto-straighten-undone');
  // with Upright on, the angle is Upright's: Auto is unavailable
  // Upright's buttons are icons, named by aria-label
  await panel(t, 'transform'); await click(t, '.upright-tools button[aria-label="Auto"]');
  await settledPhoto(t, p => p.hash !== baseline.hash && p.hash !== levelled.hash);
  await enter(t);
  assert((await t.driver.observe(inspect, '.crop-angle button', 'Auto')).disabled, 'Auto disabled while Upright is on');
  await t.evidence('auto-straighten-upright');
  await textButton(t, '.crop-buttons', 'Cancel');
  await click(t, 'button.tool[title^="undo ("]');
  await settledPhoto(t, p => p.hash === baseline.hash);
}
// undo and redo by keyboard inside the crop tool: a quarter turn undone
// turns the photo and the guide back, and Rotate undone and redone moves
// the slider and photo. after Done, one undo takes the rotation: a whole
// photo left at Original adds no Crop step of its own to undo first
export async function cropUndo(t) {
  const baseline = await settledPhoto(t);
  const modifier = await t.driver.observe(() => /Mac/.test(navigator.userAgent) ? '' : '');
  const close = (a, b) => ['width', 'height'].every(k => Math.abs(a.rect[k] - b.rect[k]) <= 3);
  await enter(t);
  const entered = await settledPhoto(t), guide = await t.driver.observe(geometry);
  await click(t, '.crop-turn button[title^="rotate right ("]');
  await settledPhoto(t, p => p.hash !== entered.hash);
  const turned = await until(async () => { const g = await t.driver.observe(geometry); return !close(g, guide) && g; }, 'guide turns');
  await t.evidence('turned');
  await t.driver.chord(modifier, 'z');
  await settledPhoto(t, p => p.hash === entered.hash);
  const back = await until(async () => { const g = await t.driver.observe(geometry); return close(g, guide) && g; }, 'undo turns the guide back');
  t.measure({ name: 'turn', guide, turned, back }); await t.evidence('turn-undone');
  const rotate = '.crop-angle [data-control-id="tf_rotate"] input[type=range]';
  const s = await reveal(t, rotate);
  const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
  await t.driver.drag(at(0), at(10));
  const angle = await until(async () => { const v = +(await t.driver.observe(inspect, rotate)).value; return Math.abs(v) > 3 && v; }, 'Rotate set');
  const rotated = await settledPhoto(t, p => p.hash !== entered.hash);
  for (const [action, value, photo] of [['undo', 0, entered], ['redo', angle, rotated]]) {
    if (action === 'undo') await t.driver.chord(modifier, 'z');
    else await click(t, 'button.tool[title^="redo ("]');
    await settledPhoto(t, p => p.hash === photo.hash);
    await until(async () => Math.abs(+(await t.driver.observe(inspect, rotate)).value - value) < .05, `${action} sets Rotate`);
    await t.evidence(`rotate-${action}`);
  }
  await textButton(t, '.crop-buttons', 'Done');
  await settledPhoto(t, p => p.hash !== baseline.hash);
  await t.driver.chord(modifier, 'z');
  await settledPhoto(t, p => p.hash === baseline.hash); await t.evidence('done-undone');
}
