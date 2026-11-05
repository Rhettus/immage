// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { click, reveal, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const ROW = '.prefs [data-pref-label="Overlay opacity"]';
const HOME = '', END = '';

// the strongest alpha the mask overlay's canvases hold: read-only pixels
function overlayAlpha() {
  let max = -1;
  for (const c of document.querySelectorAll('canvas.mask-tint')) {
    if (!c.width || !c.height) continue;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i];
  }
  return max;
}
const alphaNear = async (t, want, label) => {
  let last;
  try {
    return await until(async () => {
      last = await t.driver.observe(overlayAlpha);
      return Math.abs(last - want) <= 1 && last;
    }, label, 20000);
  } catch (e) { e.message += ` (last alpha ${last})`; throw e; }
};

// Preferences > General > Overlay opacity: the slider changes a mask's
// overlay live (55% is alpha 140, 100% is 255), Reset restores 55%
export async function overlayOpacity(t) {
  await settledPhoto(t);
  await openTool(t, 'masks');
  await click(t, '.create-mask');
  await textButton(t, '.shape-menu-list', 'Linear Gradient');
  const photo = await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: photo.x, y: photo.bounds.y + photo.bounds.height * .08 },
    { x: photo.x, y: photo.bounds.y + photo.bounds.height * .42 });
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length > 0), 'created mask');
  // a new mask's overlay shows until the first adjustment: O brings it back
  if (!(await t.driver.observe(overlayAlpha) > 0)) await t.driver.keys('o');
  await alphaNear(t, 140, 'default overlay alpha 140 (55%)');
  await t.evidence('overlay-default');

  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'General');
  const slider = await reveal(t, `${ROW} input[type=range]`);
  assert(/55%/.test(await t.driver.observe(s => document.querySelector(s).textContent, ROW)), 'hint shows 55%');
  const reset = `${ROW} button`;
  assert((await reveal(t, reset)).disabled, 'Reset disabled at the default');

  await t.driver.point(slider.x, slider.y);
  await t.driver.keys(END);
  await alphaNear(t, 255, 'overlay alpha 255 at 100%');
  assert(/100%/.test(await t.driver.observe(s => document.querySelector(s).textContent, ROW)), 'hint shows 100%');
  assert(!(await reveal(t, reset)).disabled, 'Reset enabled off the default');
  await t.evidence('overlay-100');

  await t.driver.keys(HOME);
  await alphaNear(t, 26, 'overlay alpha 26 at 10%');
  await t.evidence('overlay-10');

  await click(t, reset);
  await alphaNear(t, 140, 'Reset restores alpha 140');
  assert((await reveal(t, reset)).disabled, 'Reset disabled again');
  await textButton(t, '.prefs-foot', 'Done');
  await click(t, '.mask-list > li.on .mask-del');
  await until(() => t.driver.observe(() => !document.querySelector('.mask-list > li')), 'mask deleted');
}
