// SPDX-License-Identifier: GPL-3.0-or-later
// an adjustment made while a mask is hidden with its eye shows when the mask
// is shown again: a module the mask first uses while hidden, and a further
// change to one it already had
import assert from 'node:assert/strict';
import { click, reveal, openTool, inspect, rangeSelector } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const eye = '.mask-list > li:nth-child(1) .eye';
const hidden = () => !!document.querySelector('.mask-list > li:nth-child(1).off');
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
// the photo away from a mask row, whose hover shows that mask in red
async function settledAway(t, predicate) {
  const title = await reveal(t, '.masks-panel .panel-title span');
  await t.driver.move(title.x, title.y);
  return settledPhoto(t, predicate);
}
async function nudge(t, id, n) {
  const slider = await reveal(t, rangeSelector(id));
  const before = +slider.value;
  // focus it on its thumb: a click elsewhere on the track moves the value
  await t.driver.point(slider.bounds.x + slider.bounds.width * (before - slider.min) / (slider.max - slider.min), slider.y);
  await t.driver.keys(...Array(n).fill(''));
  await until(async () => +(await t.driver.observe(inspect, rangeSelector(id))).value > before + .05, `${id} raised`);
}
async function setHidden(t, want) {
  await click(t, eye);
  await until(async () => (await t.driver.observe(hidden)) === want, want ? 'mask hidden' : 'mask shown');
}

export async function maskHiddenEdit(t) {
  await openTool(t, 'masks');
  const baseline = await settledPhoto(t);
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Linear Gradient');
  const photo = await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: photo.x, y: photo.y - photo.bounds.height * .2 }, { x: photo.x, y: photo.y + photo.bounds.height * .2 });
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length === 1), 'mask created');
  assert.equal((await settledAway(t)).hash, baseline.hash, 'an unadjusted mask leaves the photo as it was');

  // a module first adjusted while hidden
  await setHidden(t, true);
  await nudge(t, 'l_exposure', 50);
  const hiddenFrame = await settledAway(t);
  assert.equal(hiddenFrame.hash, baseline.hash, 'a hidden mask\'s adjustment does not show');
  await t.evidence('adjusted-hidden');
  await setHidden(t, false);
  const shown = await settledAway(t, p => p.hash !== baseline.hash);
  const err = meanError(shown, baseline);
  t.measure({ name: 'mask-hidden-edit-shown', meanError: err });
  assert(err > 3, `showing the mask applies the adjustment made while hidden (mean error ${err})`);
  await t.evidence('shown-after-edit');

  // hidden and shown again without edits: the same photo both ways
  await setHidden(t, true);
  assert.equal((await settledAway(t, p => p.hash === baseline.hash)).hash, baseline.hash, 'hiding again removes it');
  await setHidden(t, false);
  assert.equal((await settledAway(t, p => p.hash === shown.hash)).hash, shown.hash, 'showing again restores it');

  // a further change to a module the mask already has, made while hidden
  await setHidden(t, true);
  await nudge(t, 'l_exposure', 50);
  assert.equal((await settledAway(t)).hash, baseline.hash, 'the further change does not show while hidden');
  await setHidden(t, false);
  const more = await settledAway(t, p => p.hash !== baseline.hash && p.hash !== shown.hash);
  t.measure({ name: 'mask-hidden-edit-more', meanError: meanError(more, shown) });
  assert(meanError(more, shown) > 2, 'showing the mask applies the further change');
  await t.evidence('shown-after-further-edit');

  // clean up: the mask deleted, the photo as it started
  await click(t, '.mask-list > li.on .mask-del');
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length === 0), 'mask deleted');
  await settledAway(t, p => p.hash === baseline.hash);
}
