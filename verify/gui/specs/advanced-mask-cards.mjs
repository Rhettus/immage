// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { click, openTool, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const card = op => `.mask-advanced-cards [data-module^="${op}#"]`;
const mode = async t => (await waitSetting(t, KEY, () => true, 'editing mode setting')) === 'advanced' ? 'Advanced' : 'Simple';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };

export async function advancedMaskCards(t) {
  await settledPhoto(t);
  await openTool(t, 'masks');
  const original = await mode(t);
  try {
    // Create a real mask so the Advanced cards are attached to a live shape.
    await click(t, '.create-mask');
    await textButton(t, '.shape-menu-list', 'Linear Gradient');
    const photo = await reveal(t, 'svg.mask-svg');
    await t.driver.drag({ x: photo.x, y: photo.y - photo.bounds.height * .2 },
                        { x: photo.x, y: photo.y + photo.bounds.height * .2 });
    await until(() => t.driver.observe(() => document.querySelector('.mask-list > li.on .mask-ops') !== null), 'mask created');
    const maskName = await t.driver.observe(() => document.querySelector('.mask-list > li.on .name')?.textContent.trim());
    assert(maskName, 'created mask is selected');

    if (original !== 'Advanced') await setMode(t, 'Advanced');
    await openTool(t, 'masks');
    await until(() => t.driver.observe(() => !!document.querySelector('.mask-advanced-cards')), 'mask Advanced adjustments shown');
    const maskControls = await t.driver.observe(() => ({
      settings: [...document.querySelectorAll('.masks-panel h3.fold')].some(h => h.textContent.includes('Mask settings')),
      shapeControls: !!document.querySelector('.mask-list > li.on .mask-ops'),
    }));
    assert(maskControls.settings && maskControls.shapeControls, 'mask settings and shape controls remain available in Advanced');

    // An Advanced Exposure edit belongs to the selected gradient: it changes
    // rendered pixels, survives undo/redo and mask visibility, and reads back
    // through Simple's Exposure slider.
    const baseline = await settledPhoto(t);
    await click(t, '.mask-advanced-cards .add-module-button');
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-add-module="exposure"]')), 'allowlisted Exposure choice');
    await click(t, '.context-menu [data-add-module="exposure"]');
    const exposureCard = card('exposure');
    await until(() => t.driver.observe(sel => !!document.querySelector(sel), exposureCard), 'mask Exposure card');
    const exposure = `${exposureCard} [data-control-id="adv:exposure"]`;
    if (!await t.driver.observe(sel => !!document.querySelector(`${sel} > .collapse.open`), exposureCard)) {
      await click(t, `${exposureCard} .module-card-head`);
    }
    const neutral = await reveal(t, `${exposure} .value`);
    await t.driver.point(neutral.x, neutral.y, 2);
    await until(() => t.driver.observe(sel => !!document.querySelector(`${sel} .value-edit`), exposure), 'mask Exposure numeric editor');
    await t.driver.keys('1', '');
    const changed = await settledPhoto(t, p => p.hash !== baseline.hash);
    const exposureError = meanError(changed, baseline);
    assert(exposureError > 1, `mask Exposure changes rendered pixels (mean absolute error ${exposureError})`);
    t.measure({ name: 'mask-exposure', meanAbsoluteError: exposureError });
    await t.evidence('mask-exposure');

    await click(t, 'button.tool[title^="undo ("]');
    await settledPhoto(t, p => p.hash === baseline.hash);
    await click(t, 'button.tool[title^="redo ("]');
    await settledPhoto(t, p => p.hash === changed.hash);

    const exposureSwitch = `${exposureCard} input.switch`;
    await click(t, exposureSwitch);
    await until(() => t.driver.observe(sel => !document.querySelector(sel)?.checked, exposureSwitch), 'mask Exposure off');
    await settledPhoto(t, p => p.hash === baseline.hash);
    await click(t, exposureSwitch);
    await until(() => t.driver.observe(sel => !!document.querySelector(sel)?.checked, exposureSwitch), 'mask Exposure on');
    await settledPhoto(t, p => p.hash === changed.hash);

    await click(t, '.mask-list > li.on .eye');
    await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on.off')), 'gradient hidden');
    await settledPhoto(t, p => p.hash === baseline.hash);
    await click(t, '.mask-list > li.on .eye');
    await until(() => t.driver.observe(() => !document.querySelector('.mask-list > li.on.off')), 'gradient shown');
    await settledPhoto(t, p => p.hash === changed.hash);

    await setMode(t, 'Simple');
    await openTool(t, 'masks');
    const toneFold = '[data-mask-group="Tone"]';
    if (!await t.driver.observe(sel => !!document.querySelector(sel)?.parentElement.querySelector('.collapse.open'), toneFold)) {
      await click(t, toneFold);
    }
    const simpleExposure = await until(() => t.driver.observe(() => document.querySelector('[data-control-id="l_exposure"] input[type="range"]')?.value), 'Simple mask Exposure readback');
    assert(Math.abs(+simpleExposure - 1) < .02, `Simple mask Exposure reads back +1 EV (got ${simpleExposure})`);
    await setMode(t, 'Advanced');
    await openTool(t, 'masks');

    await click(t, '.mask-advanced-cards .add-module-button');
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-add-module="colorzones"]')), 'allowlisted Color zones choice');
    assert.equal(await t.driver.observe(() => !!document.querySelector('.context-menu [data-add-module="sigmoid"]')), false,
      'a module outside the mask allowlist is absent');
    await click(t, '.context-menu [data-add-module="colorzones"]');
    const colorZonesSelector = card('colorzones');
    const colorZones = await until(() => t.driver.observe(sel => !!document.querySelector(sel), colorZonesSelector), 'Color zones mask card added');
    assert(colorZones, 'the added module has a full card');
    assert.equal(await t.driver.observe(() => !!document.querySelector('.mask-advanced-cards [data-module^="colorzones#"] .preset-menu')), false,
      'mask cards do not show darktable presets');

    const cardMenu = `${card('colorzones')} .instance-menu .module-card-menu`;
    await click(t, cardMenu);
    const actions = await until(() => t.driver.observe(() => {
      const m = document.querySelector('.context-menu');
      return m && [...m.querySelectorAll('[data-instance-action]')].map(x => x.getAttribute('data-instance-action'));
    }), 'mask card menu');
    assert.deepEqual(actions, ['reset', 'remove'], 'mask card menu only offers Reset and Remove from mask');
    await click(t, '.context-menu [data-instance-action="remove"]');
    await until(() => t.driver.observe(sel => !document.querySelector(sel), colorZonesSelector), 'module removed from mask');
    await click(t, 'button[title^="undo ("]');
    await until(() => t.driver.observe(sel => !!document.querySelector(sel), colorZonesSelector), 'undo restores the mask module');

    await setMode(t, 'Simple');
    await openTool(t, 'masks');
    const badge = await until(() => t.driver.observe(() => Number(document.querySelector('.masks-panel .adj-title [data-advanced-edits]')?.dataset.advancedEdits) > 0), 'Simple advanced-edits badge');
    assert(badge, 'an advanced-only mask module is counted in Simple');
    t.measure({ name: 'advanced-mask-card', mask: maskName, module: 'colorzones', badge: true });
    await t.evidence('advanced-mask-card');
  } finally {
    if (original === 'Advanced') await setMode(t, 'Advanced');
    else if (await mode(t) !== 'Simple') await setMode(t, 'Simple');
  }
}
