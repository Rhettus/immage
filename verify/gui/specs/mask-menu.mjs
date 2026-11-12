// SPDX-License-Identifier: GPL-3.0-or-later
// a mask row's "..." menu: Duplicate Mask Only and Duplicate and Invert Mask
// Only copy the shapes and Invert without the adjustments and leave the photo
// as it was; Reset Mask Adjustments is greyed out on a neutral mask and sets
// an adjusted one back to neutral, undoably; Duplicate Mask still copies them
import assert from 'node:assert/strict';
import { click, reveal, openTool, inspect, rangeSelector } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const RIGHT = '';
const EXPOSURE = 'l_exposure';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const names = () => [...document.querySelectorAll('.mask-list > li .name')].map(n => n.textContent.trim());
const selectedName = () => document.querySelector('.mask-list > li.on .name')?.textContent.trim() ?? null;
const invertOn = () => [...document.querySelectorAll('label.toggle')].find(l => l.textContent.trim() === 'Invert')?.querySelector('input')?.checked ?? null;
const exposure = id => +(document.querySelector(`[data-control-id="${id}"] input[type=range]`)?.value ?? NaN);
// a mask of one shape lists none, only its Add and Subtract; the thumbnail's gradient is its shape
const shapeCount = () => document.querySelectorAll('.mask-list > li.on .mask-ops').length;
const itemDisabled = text => [...document.querySelectorAll('.mask-more-list button')].find(b => b.textContent.trim() === text)?.disabled;

async function settledAway(t, predicate) {
  const title = await reveal(t, '.masks-panel .panel-title span');
  await t.driver.move(title.x, title.y);
  return settledPhoto(t, predicate);
}
// focus mode keeps one group open: bring up Tone (the sliders) or Mask settings (Invert)
async function showTone(t) {
  if (!(await t.driver.observe(() => !!document.querySelector('[data-control-id="l_exposure"] input[type=range]'))))
    await click(t, '[data-mask-group="Tone"]');
  await until(() => t.driver.observe(() => !!document.querySelector('[data-control-id="l_exposure"] input[type=range]')), 'Tone open');
}
async function readInvert(t) {
  if ((await t.driver.observe(invertOn)) === null) {
    await click(t, 'h3.fold:not([data-mask-group])');
    await until(async () => (await t.driver.observe(invertOn)) !== null, 'Mask settings open');
  }
  return t.driver.observe(invertOn);
}
async function nudge(t, n) {
  await showTone(t);
  const slider = await reveal(t, rangeSelector(EXPOSURE));
  const before = +slider.value;
  await t.driver.point(slider.bounds.x + slider.bounds.width * (before - slider.min) / (slider.max - slider.min), slider.y);
  await t.driver.keys(...Array(n).fill(RIGHT));
  await until(async () => +(await t.driver.observe(inspect, rangeSelector(EXPOSURE))).value > before + .05, 'exposure raised');
}
const rowOf = async (t, name) => 1 + (await t.driver.observe(names)).indexOf(name);
async function menu(t, name, item) {
  const i = await rowOf(t, name);
  assert(i > 0, `mask ${name} listed`);
  // the row's buttons show on hover
  const nm = await reveal(t, `.mask-list > li:nth-child(${i}) .name`);
  await t.driver.move(nm.x, nm.y);
  await click(t, `.mask-list > li:nth-child(${i}) .more-btn`);
  await reveal(t, '.mask-more-list button', item);
  return i;
}
async function pick(t, name, item) {
  await menu(t, name, item);
  await textButton(t, '.mask-more-list', item);
}
async function selected(t, name) {
  await until(async () => (await t.driver.observe(selectedName)) === name, `${name} selected`);
}
async function exposureIs(t, want, what) {
  await showTone(t);
  await until(async () => {
    const v = await t.driver.observe(exposure, EXPOSURE);
    return want === 0 ? Math.abs(v) < .005 : (want > 0 ? v > .05 : Math.abs(v - want) < .005);
  }, what);
}

export async function maskMenu(t) {
  await openTool(t, 'masks');
  const baseline = await settledPhoto(t);
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Linear Gradient');
  const photo = await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: photo.x, y: photo.y - photo.bounds.height * .2 }, { x: photo.x, y: photo.y + photo.bounds.height * .2 });
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length === 1), 'mask created');
  const [orig] = await t.driver.observe(names);
  await settledAway(t, p => p.hash === baseline.hash);
  await nudge(t, 50);
  const adjustedValue = await t.driver.observe(exposure, EXPOSURE);
  const adjusted = await settledAway(t, p => p.hash !== baseline.hash);
  assert(meanError(adjusted, baseline) > 3, 'the mask exposure changes the photo');
  await t.evidence('adjusted');

  // Duplicate Mask Only: a neutral copy, selected, same shape, photo unchanged
  await pick(t, orig, 'Duplicate Mask Only');
  const copy = `${orig} copy`;
  await until(async () => (await t.driver.observe(names)).includes(copy), 'copy listed');
  await selected(t, copy);
  await exposureIs(t, 0, 'the copy starts neutral');
  assert.equal(await readInvert(t), false, 'the copy is not inverted');
  assert.equal(await t.driver.observe(shapeCount), 1, 'the copy has the shape');
  const afterOnly = await settledAway(t);
  assert(meanError(afterOnly, adjusted) < 1, `Duplicate Mask Only leaves the photo as it was (${meanError(afterOnly, adjusted)})`);
  await t.evidence('duplicate-only');

  // Reset is greyed out on the neutral copy
  await menu(t, copy, 'Reset Mask Adjustments');
  assert.equal(await t.driver.observe(itemDisabled, 'Reset Mask Adjustments'), true, 'Reset is disabled on a neutral mask');
  await click(t, `.mask-list > li:nth-child(${await rowOf(t, copy)}) .more-btn`);   // close
  await until(() => t.driver.observe(() => !document.querySelector('.mask-more-list')), 'menu closed');

  // Duplicate and Invert Mask Only on the original
  await pick(t, orig, 'Duplicate and Invert Mask Only');
  const copy2 = `${orig} copy 2`;
  await until(async () => (await t.driver.observe(names)).length === 3, 'second copy listed');
  const second = (await t.driver.observe(names)).filter(n => n !== orig && n !== copy)[0];
  await selected(t, second);
  await exposureIs(t, 0, 'the inverted copy starts neutral');
  assert.equal(await readInvert(t), true, 'the copy is inverted');
  assert.equal(await t.driver.observe(shapeCount), 1, 'the inverted copy has the shape');
  const afterInv = await settledAway(t);
  assert(meanError(afterInv, adjusted) < 1, `Duplicate and Invert Mask Only leaves the photo as it was (${meanError(afterInv, adjusted)})`);
  await t.evidence('duplicate-invert-only');
  t.measure({ name: 'mask-menu-names', orig, copy, second, copy2 });

  // Reset Mask Adjustments on the original
  await click(t, `.mask-list > li:nth-child(${await rowOf(t, orig)}) .mask-thumb`);
  await selected(t, orig);
  await pick(t, orig, 'Reset Mask Adjustments');
  await exposureIs(t, 0, 'reset returns the slider to neutral');
  const reset = await settledAway(t, p => p.hash !== adjusted.hash);
  assert(meanError(reset, baseline) < 1, `reset matches a render without the adjustment (${meanError(reset, baseline)})`);
  assert((await t.driver.observe(names)).includes(orig), 'the mask still exists');
  assert.equal(await t.driver.observe(shapeCount), 1, 'the mask keeps its shape');
  await t.evidence('reset');

  // undo restores the adjustment
  await click(t, 'button[title^="undo ("]');
  await exposureIs(t, adjustedValue, 'undo restores the exposure');
  const undone = await settledAway(t, p => meanError(p, adjusted) < 1);
  assert(meanError(undone, adjusted) < 1, 'undo restores the adjusted render');
  await t.evidence('undone');

  // Duplicate Mask still copies the adjustment
  await pick(t, orig, 'Duplicate Mask');
  await until(async () => (await t.driver.observe(names)).length === 4, 'full copy listed');
  const full = (await t.driver.observe(names)).find(n => ![orig, copy, second].includes(n));
  await selected(t, full);
  await exposureIs(t, adjustedValue, 'Duplicate Mask copies the adjustment');
  await t.evidence('duplicate-full');

  // clean up: all masks deleted, the photo as it started
  for (let n = 4; n > 0; n--) {
    const nm = await reveal(t, '.mask-list > li:nth-child(1) .name');
    await t.driver.move(nm.x, nm.y);
    await click(t, '.mask-list > li:nth-child(1) .mask-del');
    await until(() => t.driver.observe(k => document.querySelectorAll('.mask-list > li').length === k, n - 1), 'mask deleted');
  }
  await settledAway(t, p => meanError(p, baseline) < 1);
}
