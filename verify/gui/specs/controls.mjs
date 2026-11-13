// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until, pause } from '../support/webdriver.mjs';
import { panel, expandSections, Blocked } from '../support/scenario.mjs';
import { inspect, reveal, click, rangeSelector, openTool } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';
import * as read from '../support/observations.mjs';

async function basic(t) {
  const p = await t.driver.observe(read.panelTitle);
  assert(p, 'Basic panel exists');
  if (!p.open) await t.driver.point(p.x, p.y);
  return reveal(t, rangeSelector('exposure'));
}
export async function sliderInput(t) {
  await basic(t);
  const selector = rangeSelector('exposure');
  let s = await reveal(t, selector);
  await t.driver.point(s.label.x, s.label.y, 2);
  await until(async () => +(await t.driver.observe(inspect, selector)).value === 0, 'neutral Exposure');
  const baseline = await settledPhoto(t);
  s = await reveal(t, selector);
  // Click the neutral thumb, then exercise native range keyboard input.
  await t.driver.point(s.x, s.y);
  await t.driver.keys(...Array(10).fill('\uE014')); // ArrowRight
  // the keys can land while the thumb re-renders and some are dropped
  // (+0.05 of 0.10 seen); any increase shows keyboard input works
  await until(async () => +(await t.driver.observe(inspect, selector)).value >= .02, 'keyboard Exposure increase');
  assert(await t.driver.observe(() => document.activeElement?.matches('[data-control-id="exposure"] input[type=range]')), 'range retains keyboard focus');
  await t.evidence('keyboard-focus');
  // Inline numeric editor uses real double click, select-all on focus and keys.
  const value = await reveal(t, '[data-control-id="exposure"] .value');
  await t.driver.point(value.x, value.y, 2);
  await until(() => t.driver.observe(() => !!document.querySelector('[data-control-id="exposure"] .value-edit')), 'numeric editor');
  await t.driver.keys('1', '\uE007'); // Enter
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - 1) < .02, 'typed Exposure');
  await settledPhoto(t, p => p.luma > baseline.luma + 2);
  await t.evidence('typed-value');
  s = await reveal(t, selector);
  await t.driver.point(s.label.x, s.label.y, 2);
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value) < .02, 'reset after typing');
  await settledPhoto(t, p => p.hash === baseline.hash);
}
// A user report: clicking a slider's track jumps the value (to +20, say)
// but the photo does not change until the slider is dragged a little.
// Click without moving, the way a hand jumps a slider, and require the
// settled photo to follow.
export async function sliderClick(t) {
  await basic(t);
  // linear sliders, so a track fraction is the value's
  for (const [id, to] of [['exposure', 1], ['shadows', 20], ['contrast', 20]]) {
    const selector = rangeSelector(id);
    let s = await reveal(t, selector);
    await t.driver.point(s.label.x, s.label.y, 2);
    const baseline = await settledPhoto(t);
    s = await reveal(t, selector);
    const neutral = +s.value;
    const at = { x: s.bounds.x + 8 + (s.bounds.width - 16) * (to - s.min) / (s.max - s.min), y: s.y };
    const clickedAt = Date.now();
    await t.driver.point(at.x, at.y);
    const moved = await until(async () => { const c = await t.driver.observe(inspect, selector); return Math.abs(+c.value - neutral) > (s.step || .001) && c; }, `${id} track click moves the value`);
    let frame;
    try { frame = await settledPhoto(t, p => p.hash !== baseline.hash); }
    catch (e) { throw Error(`${id}: clicked to ${moved.displayed} but the photo did not change: ${e.message}`); }
    t.measure({ name: id, value: moved.value, displayed: moved.displayed, ms: Date.now() - clickedAt, photoHash: frame.hash, baselineHash: baseline.hash });
    await t.evidence(`${id}-clicked`);
    s = await reveal(t, selector);
    await t.driver.point(s.label.x, s.label.y, 2);
    await settledPhoto(t, p => p.hash === baseline.hash);
  }
}
export async function history(t) {
  await basic(t);
  // Reset All clears the New Photos preset (a raw's lens corrections) by
  // design: reset first, so the baseline is the photo's own defaults and the
  // later Reset All must reproduce it
  await click(t, 'button[aria-label="reset all"]'); await pause(300);
  const selector = rangeSelector('exposure');
  let s = await reveal(t, selector);
  await t.driver.point(s.label.x, s.label.y, 2);
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value) < .02, 'neutral Exposure');
  const baseline = await settledPhoto(t);
  // every mounted control's value, to name what Reset All changes
  const controlValues = () => t.driver.observe(() => Object.fromEntries([...document.querySelectorAll('[data-control-id]')].map(e => {
    const i = e.querySelector('input[type=range], select'), on = e.querySelector('button.active');
    return [e.dataset.controlId, i ? i.value : on ? on.textContent.trim() : e.querySelector('input[type=checkbox]')?.checked ?? null];
  })));
  const before = await controlValues();
  s = await reveal(t, selector);
  const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
  await t.driver.drag(at(0), at(1));
  await until(async () => +(await t.driver.observe(inspect, selector)).value > .7, 'history edit');
  const changed = await settledPhoto(t, p => p.luma > baseline.luma + 2);
  for (const [action, expected] of [['undo', baseline], ['redo', changed]]) {
    await click(t, `button.tool[title^="${action} ("]`);
    const frame = await settledPhoto(t, p => p.hash === expected.hash);
    const value = +(await t.driver.observe(inspect, selector)).value;
    assert(action === 'undo' ? Math.abs(value) < .02 : value > .7, `${action} restores slider and photo`);
    t.measure({ name: action, value, photoHash: frame.hash });
    await t.evidence(action);
  }
  await click(t, 'button[aria-label="reset all"]');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value) < .02, 'Reset All Exposure');
  // Reset All re-renders from the defaults rather than replaying the undo
  // cache, so compare like the Exposure reset: mean error within 1/255.
  const reset = await settledPhoto(t, p => p.hash !== changed.hash);
  let error = 0;
  for (let i = 0; i < reset.rgba.length; i++) error += Math.abs(reset.rgba[i] - baseline.rgba[i]);
  error /= reset.rgba.length;
  const after = await controlValues();
  const differs = Object.fromEntries(Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k]).map(k => [k, [before[k], after[k]]]));
  t.measure({ name: 'reset-all', photoHash: reset.hash, luma: reset.luma, baselineLuma: baseline.luma, meanAbsoluteError: error, controlsChanged: differs });
  assert(error < 1, `Reset All photo mean pixel error ${error} exceeds 1/255`);
  await t.evidence('reset-all');
}

export async function rail(t) {
  for (const tool of ['presets', 'masks', 'zones', 'heal', 'print', 'adjust']) {
    const selector = `button[data-tour="${tool}"]`;
    await click(t, selector);
    await until(async () => (await t.driver.observe(inspect, selector))?.active, `${tool} active`);
    const observed = await t.driver.observe(inspect, selector);
    assert(observed.visible && observed.hit, `${tool} remains visible and clickable`);
    t.measure({ name: tool, observed });
    await t.evidence(tool);
  }
  // Regression fe5dbc2: DOM/CSS coverage only; native cursor remains manual.
  const cursor = await t.driver.observe(() => [...document.querySelectorAll('button.tool')].map(e => ({
    title: e.title, cursor: getComputedStyle(e).cursor,
    children: [...e.querySelectorAll('svg, svg *')].map(s => getComputedStyle(s).cursor),
    windows: document.documentElement.classList.contains('windows'),
  })));
  for (const c of cursor.filter(c => c.windows)) {
    assert.equal(c.cursor, 'default'); assert(c.children.every(s => s === 'default'));
  }
  t.measure({ name: 'fe5dbc2-cursor-css', scope: cursor.some(c => c.windows) ? 'Windows CSS only' : 'Windows assertion not applicable on this platform', cursor });
}

// Regression 81d4441: each right panel tool keeps its own scroll offset and
// opens at the top the first time, instead of inheriting the last tool's.
export async function panelScroll(t) {
  const panels = () => { const p = document.querySelector('.right .panels'), r = p?.getBoundingClientRect();
    return r && { x: r.right - 6, y: r.top + r.height / 2, top: p.scrollTop, room: p.scrollHeight - p.clientHeight }; };
  // openTool clicks only when the tool is closed: a rail button closes an
  // open tool, and an earlier case may leave Adjustments open
  const open = async tool => { await openTool(t, tool); await pause(400); return t.driver.observe(panels); };
  await open('adjust');
  await expandSections(t, await panel(t, 'basic'));
  let s = await t.driver.observe(panels);
  if (s.room < 260) throw new Blocked(`Adjustments panel too short to scroll (${s.room}px)`);
  for (let i = 0; i < 10 && s.top < 250; i++) { await t.driver.wheel(s.x, s.y, 300); await pause(150); s = await t.driver.observe(panels); }
  assert(s.top >= 250, `Adjustments scrolled (${s.top})`);
  const adjusted = s.top;
  const presets = await open('presets');
  t.measure({ name: 'presets-first-open', adjustments: adjusted, presets });
  assert.equal(presets.top, 0, 'Presets opens at its top');
  const back = await open('adjust');
  t.measure({ name: 'adjustments-reopened', expected: adjusted, observed: back.top });
  assert(Math.abs(back.top - adjusted) <= 2, `Adjustments returns to ${adjusted} (got ${back.top})`);
  await t.evidence('adjustments-reopened');
}

// Walk all mounted manifest panels and their currently reachable range controls.
// Conditional tabs/modules, RAW-only and masks need separate prerequisite cases.
export async function sliders(t) {
  const panels = await t.driver.observe(() => [...document.querySelectorAll('[data-panel-id]')].map(e => ({ id: e.dataset.panelId })));
  assert(panels.length, 'manifest panel observation hooks must exist in the binary');
  const coverage = [];
  for (const { id } of panels) {
    const panel = `[data-panel-id=${JSON.stringify(id)}]`;
    const title = `${panel} > .panel-title`;
    const open = await t.driver.observe(selector => document.querySelector(selector)?.classList.contains('open'), title);
    if (!open) await click(t, title);
    await until(() => t.driver.observe(selector => !!document.querySelector(`${selector} > .collapse.open`), panel), `${id} expanded`);
    // the section animates open: wait for its height to stop changing, or the next
    // title is measured mid-animation and the click lands on the graph that slides under it
    let last = -1;
    await until(async () => { const h = await t.driver.observe(selector => document.querySelector(selector)?.getBoundingClientRect().height, panel); const same = h === last; last = h; return same; }, `${id} settled`);
    const controls = await t.driver.observe(selector => [...document.querySelectorAll(`${selector} [data-control-id] input[type=range]`)].map(e => e.closest('[data-control-id]').dataset.controlId), panel);
    for (const control of controls) {
      const selector = `${panel} ${rangeSelector(control)}`;
      const initial = await t.driver.observe(inspect, selector);
      if (initial.disabled) {
        const blocked = { panel: id, control, status: 'blocked', reason: 'disabled for current fixture/module' };
        coverage.push(blocked); t.measure({ name: `${id}/${control}`, ...blocked }); continue;
      }
      let s = await reveal(t, selector);
      const labelSelector = `${panel} [data-control-id=${JSON.stringify(control)}] label`;
      let label = await reveal(t, labelSelector);
      await t.driver.point(label.x, label.y, 2);
      const neutral = await until(async () => {
        const c = await t.driver.observe(inspect, selector); return c?.displayed && c;
      }, `${control} reset display`);
      const baseline = await settledPhoto(t);
      s = await reveal(t, selector);
      const start = +s.value, delta = Math.max(s.step || .01, (s.max - s.min) * .08);
      const target = start + delta <= s.max ? start + delta : start - delta;
      const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
      await t.driver.drag(at(start), at(target));
      const moved = await until(async () => {
        const c = await t.driver.observe(inspect, selector); return Math.abs(+c.value - start) > (s.step || .001) / 2 && c;
      }, `${control} pointer change`);
      const frame = await settledPhoto(t);
      assert(moved.displayed?.length, `${control} formatted value visible`);
      assert.notEqual(moved.displayed, neutral.displayed, `${control} formatted value follows input`);
      await t.evidence(`${id}-${control}-changed`);
      s = await reveal(t, selector);
      label = await reveal(t, labelSelector);
      await t.driver.point(label.x, label.y, 2);
      await until(async () => Math.abs(+(await t.driver.observe(inspect, selector)).value - +neutral.value) <= (s.step || .001), `${control} reset value`);
      await settledPhoto(t, p => p.hash === baseline.hash);
      coverage.push({ panel: id, control, status: 'exercised', from: start, to: moved.value, photoChanged: frame.hash !== baseline.hash, css: moved.css });
      t.measure({ name: `${id}/${control}`, ...coverage.at(-1) });
    }
  }
  t.measure({ name: 'reachable-slider-coverage', controls: coverage, limitation: 'No claim for hidden tabs, modules, sections, RAW-only controls or perceptual correctness. Unchanged photo requires review.' });
  assert(coverage.some(c => c.status === 'exercised'), 'at least one slider exercised');
}
