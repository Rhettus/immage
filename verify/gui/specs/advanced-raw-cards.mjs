// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import { Blocked } from '../support/scenario.mjs';
import { click } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { meanError, inAdvanced, openCard, turnOn, exists, choice, pick, type, readoutOf } from '../support/cards.mjs';
import { bandsCase } from './advanced-curve-cards.mjs';

// the cards that need a raw photo: Raw denoise's wavelet curves, and white
// balance's Finetune for a camera preset when the photo's camera has any
export async function advancedRawCards(t) {
  if (!t.fixture.raw) throw new Blocked('advanced-raw-cards needs a raw fixture (verify/gui/hotpixels-fixture.py)');
  await settledPhoto(t);
  await panel(t, 'basic');
  const simpleTemp = () => readoutOf(t, '[data-panel-id="basic"]', 'temp');
  const tempBefore = await until(simpleTemp, 'Simple Temp reads');
  await inAdvanced(t, async () => {
    // 1. Raw denoise: the all, R, G and B wavelet curves
    const rd = await openCard(t, 'detail', 'rawdenoise');
    await turnOn(t, rd.sel);
    await type(t, rd.sel, 'threshold', '0.03');
    await bandsCase(t, rd, 'rawdenoise', 'rawdenoise', .001);

    // 2. White balance Finetune: shown for a camera preset with a range
    const wb = await openCard(t, 'basic', 'temperature');
    await turnOn(t, wb.sel);
    // Settings: a raw starts as shot, and color calibration takes its illuminant
    // from this module, so Camera reference changes the frame and As shot
    // brings it back
    const base = await settledPhoto(t);
    await pick(t, wb.sel, 'adv:wb_setting', /^Camera reference$/);
    await until(async () => (await choice(t, wb.sel, 'adv:wb_setting')).current === 'Camera reference', 'Settings reads Camera reference');
    const ref = await settledPhoto(t, p => meanError(p, base) > 1);
    t.measure({ name: 'wb-camera-reference', meanAbsoluteError: meanError(ref, base) });
    assert.equal((await choice(t, wb.sel, 'adv:wb_setting')).current, 'Camera reference', 'camera reference stays chosen');
    await t.evidence('wb-camera-reference');
    await pick(t, wb.sel, 'adv:wb_setting', /^As shot$/);
    await until(async () => (await choice(t, wb.sel, 'adv:wb_setting')).current === 'As shot', 'Settings reads As shot');
    const asShot = await settledPhoto(t, p => meanError(p, ref) > 1);
    t.measure({ name: 'wb-as-shot', meanAbsoluteError: meanError(asShot, ref), fromStart: meanError(asShot, base) });
    assert(meanError(asShot, base) < 1, 'As shot returns to the frame the photo opened with');
    await t.evidence('wb-as-shot');
    const menu = await choice(t, wb.sel, 'adv:wb_setting');
    const presets = menu.options.slice(3);
    t.measure({ name: 'wb-presets', presets: presets.map(p => p.label), current: menu.current });
    assert.equal(await exists(t, `${wb.sel} [data-control-id="adv:wb_tune"]`), false, 'no Finetune for as shot');
    if (presets.length) {
      await pick(t, wb.sel, 'adv:wb_setting', new RegExp(`^${presets[0].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      await t.evidence('wb-preset');
    }

    // 3. "Prepare data for color calibration": on every setting but camera
    // reference, where darktable hides it; the box changes the rendered photo
    const prepare = `${wb.sel} [data-control-id="adv:late_correction"]`;
    const checked = () => t.driver.observe(s => document.querySelector(`${s} input`)?.checked, prepare);
    await pick(t, wb.sel, 'adv:wb_setting', /^As shot$/);
    await until(() => exists(t, prepare), 'the preparation checkbox shows for as shot');
    const was = await checked();
    const before = await settledPhoto(t);
    await click(t, `${prepare} input`);
    await until(async () => await checked() !== was, 'the preparation checkbox changes');
    const toggled = await settledPhoto(t, p => meanError(p, before) > .2);
    t.measure({ name: 'wb-preparation', meanAbsoluteError: meanError(toggled, before) });
    await t.evidence('wb-preparation');
    await click(t, `${prepare} input`);
    await until(async () => await checked() === was, 'the preparation checkbox returns');
    await settledPhoto(t);
    await pick(t, wb.sel, 'adv:wb_setting', /^Camera reference$/);
    await until(async () => !await exists(t, prepare), 'camera reference hides the preparation checkbox');
    const labels = (await choice(t, wb.sel, 'adv:wb_setting')).options.map(o => o.label);
    assert(!labels.includes('As shot to reference'), `the Settings menu no longer lists As shot to reference: ${labels}`);

    // 4. color calibration's illuminant: from the white balance module follows
    // it, and any other illuminant locks the controls it overrides
    const cc = await openCard(t, 'basic', 'channelmixerrgb');
    await turnOn(t, cc.sel);
    const fromWb = /^From the white balance module$/;
    await pick(t, cc.sel, 'adv:illuminant', fromWb);
    await until(async () => fromWb.test((await choice(t, cc.sel, 'adv:illuminant')).current), 'the illuminant follows the white balance module');
    await settledPhoto(t);
    const lockNote = () => t.driver.observe(s => [...document.querySelectorAll(`${s} .note`)].some(n => /controlled in the color calibration module/.test(n.textContent)), wb.sel);
    const tempLocked = () => t.driver.observe(s => !!document.querySelector(`${s} [data-control-id="adv:temp_k"] input:disabled`), wb.sel);
    assert.equal(await lockNote(), false, 'following the white balance module does not lock it');
    assert.equal(await tempLocked(), false, 'Temperature is free while color calibration follows it');
    await pick(t, cc.sel, 'adv:illuminant', /^D \(daylight\)$/);
    await until(lockNote, 'its own illuminant locks the white balance card');
    await until(tempLocked, 'Temperature is greyed while locked');
    await t.evidence('wb-locked');
    await pick(t, cc.sel, 'adv:illuminant', fromWb);
    await until(async () => !await lockNote(), 'following the white balance module unlocks the card');
    await until(async () => !await tempLocked(), 'Temperature is free again');
    await settledPhoto(t);
  });

  // 5. Simple's Temp shows the illuminant taken from the white balance module,
  // left at camera reference above
  await panel(t, 'basic');
  const tempAfter = await until(simpleTemp, 'Simple Temp reads again');
  t.measure({ name: 'simple-temp', before: tempBefore.shown, after: tempAfter.shown });
  assert.notEqual(tempAfter.shown, tempBefore.shown, 'Simple Temp follows the white balance module');
}
