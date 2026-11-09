// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool, rangeSelector } from '../support/controls.mjs';
import { textButton, openMaskGroup } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { startup, settledPhoto } from './smoke.mjs';

const ids = ['r_ch', 'r_cw', 'r_cc', 'r_cf'];
// Read actual overlay pixels, rather than assuming that a mounted canvas is visible.
const overlay = () => [...document.querySelectorAll('canvas.mask-tint')].some(c => {
  if (!c.width || !c.height) return false;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i]) return true;
  return false;
});
async function settings(t) {
  await openTool(t, 'masks');
  await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on')), 'selected saved mask');
  if (!await t.driver.observe(() => [...document.querySelectorAll('.masks-panel h3.fold')].find(e => e.textContent.includes('Mask settings'))?.querySelector('.chevron.open')))
    await click(t, '.masks-panel h3.fold');
  await until(() => t.driver.observe(() => !!document.querySelector('[data-control-id="r_ch"]')), 'color settings');
}
async function type(t, id, value, cancel = false) {
  const v = await reveal(t, `[data-control-id="${id}"] .value`);
  await t.driver.point(v.x, v.y, 2);
  await until(() => t.driver.observe(s => !!document.querySelector(`[data-control-id="${s}"] .value-edit`), id), 'numeric editor');
  await t.driver.keys(...String(value));
  await until(() => t.driver.observe(overlay), 'overlay during numeric editing');
  await t.driver.keys(cancel ? '\uE00C' : '\uE007');
  if (!cancel) await until(async () => Math.abs(+(await t.driver.observe(inspect, rangeSelector(id))).value - value) < .11, `${id} typed value`);
}
async function leave(t) {
  await click(t, '.masks-panel h3.fold');
  await until(async () => !await t.driver.observe(overlay), 'temporary overlay clears');
  await settledPhoto(t);
}
export async function colorRange(t) {
  await openTool(t, 'masks');
  await click(t, '.create-mask');
  await textButton(t, '.shape-menu-list', 'Color Range');
  const p = await reveal(t, 'svg.mask-svg');
  await t.driver.point(p.x, p.y);
  await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on')), 'picked color mask');
  await settings(t);
  // Make the band broad enough that all subsequent controls have visible coverage.
  await type(t, 'r_cw', 70);
  await type(t, 'r_cc', 0);
  for (const id of ids) {
    const s = await reveal(t, rangeSelector(id));
    const at = v => ({x:s.bounds.x+8+(s.bounds.width-16)*(v-s.min)/(s.max-s.min),y:s.y});
    const target = id === 'r_cc' ? 1 : Math.min(s.max - s.step, +s.value + (s.max-s.min)*.05);
    await t.driver.drag(at(+s.value), at(target));
    await until(async () => Math.abs(+(await t.driver.observe(inspect, rangeSelector(id))).value - +s.value) >= s.step, `${id} pointer edit`);
    await until(() => t.driver.observe(overlay), `${id} pointer overlay`);
    const current = +(await t.driver.observe(inspect, rangeSelector(id))).value;
    await t.driver.point(at(current).x, s.y);
    await t.driver.keys('\uE014');
    await until(() => t.driver.observe(overlay), `${id} keyboard overlay`);
    const before = +(await t.driver.observe(inspect, rangeSelector(id))).value;
    const typed = id === 'r_ch' ? 240 : id === 'r_cw' ? 80 : id === 'r_cc' ? 0 : 30;
    await type(t, id, typed);
    await type(t, id, 17, true);
    assert(Math.abs(+(await t.driver.observe(inspect, rangeSelector(id))).value - typed) < .11, 'Escape preserves committed value');
    t.measure({name:id, before, typed});
    await t.evidence(id);
  }
  await leave(t);
  await settings(t);
  await type(t, 'r_ch', 120);
  await leave(t);
  const edited = await settledPhoto(t);
  await click(t, 'button.tool[title^="undo ("]');
  await settings(t);
  await until(async () => Math.abs(+(await t.driver.observe(inspect, rangeSelector('r_ch'))).value - 240) < 1, 'undo restores hue');
  await click(t, 'button.tool[title^="redo ("]');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, rangeSelector('r_ch'))).value - 120) < 1, 'redo restores hue');
  await leave(t);
  await openMaskGroup(t, 'Tone');
  const e = await reveal(t, rangeSelector('l_exposure'));
  await t.driver.drag({x:e.x,y:e.y},{x:e.x+e.bounds.width*.15,y:e.y});
  const rendered = await settledPhoto(t);
  assert.notEqual(rendered.hash, edited.hash, 'color mask changes the rendered photo');
  await settings(t);
  const saved = await t.driver.observe(list => Object.fromEntries(list.map(id => [id, document.querySelector(`[data-control-id="${id}"] input[type=range]`).value])), ids);
  await until(async () => (await t.sidecars()).length > 0, 'sidecar saved');
  await pause(1800);
  await t.restart();
  await startup(t);
  await settings(t);
  for (const id of ids) assert.equal((await t.driver.observe(inspect, rangeSelector(id))).value, saved[id], `${id} survives restart`);
  assert.equal((await settledPhoto(t)).hash, rendered.hash, 'saved masked render survives restart');
  // Overlay toggle remains on after temporary adjustment ends.
  await t.driver.keys('o');
  await until(() => t.driver.observe(overlay), 'persistent overlay on');
  await type(t, 'r_ch', 130);
  await click(t, '.masks-panel h3.fold');
  await pause(2000);
  assert(await t.driver.observe(overlay), 'pre-existing overlay remains enabled');
  await t.driver.keys('o');
  await until(async () => !await t.driver.observe(overlay), 'persistent overlay off');
  await t.evidence('color-range-restored');
}
