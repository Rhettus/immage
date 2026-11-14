// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import { Blocked } from '../support/scenario.mjs';
import { meanError, inAdvanced, openCard, turnOn, exists, choice, pick, type } from '../support/cards.mjs';
import { bandsCase } from './advanced-curve-cards.mjs';

// the cards that need a raw photo: Raw denoise's wavelet curves, and white
// balance's Finetune for a camera preset when the photo's camera has any
export async function advancedRawCards(t) {
  if (!t.fixture.raw) throw new Blocked('advanced-raw-cards needs a raw fixture (verify/gui/hotpixels-fixture.py)');
  await inAdvanced(t, async () => {
    // 1. Raw denoise: the all, R, G and B wavelet curves
    const rd = await openCard(t, 'detail', 'rawdenoise');
    await turnOn(t, rd.sel);
    await type(t, rd.sel, 'threshold', '0.03');
    await bandsCase(t, rd, 'rawdenoise', 'rawdenoise', .001);

    // 2. White balance Finetune: shown for a camera preset with a range
    const wb = await openCard(t, 'basic', 'temperature');
    await turnOn(t, wb.sel);
    // Settings: with color calibration on, the module's defaults are the camera
    // reference coefficients (as darktable has them), so Camera reference leaves
    // the frame and As shot, the coefficients the camera recorded, changes it
    const base = await settledPhoto(t);
    await pick(t, wb.sel, 'adv:wb_setting', /^Camera reference$/);
    await until(async () => (await choice(t, wb.sel, 'adv:wb_setting')).current === 'Camera reference', 'Settings reads Camera reference');
    const ref = await settledPhoto(t);
    t.measure({ name: 'wb-camera-reference', meanAbsoluteError: meanError(ref, base) });
    assert.equal((await choice(t, wb.sel, 'adv:wb_setting')).current, 'Camera reference', 'camera reference stays chosen');
    await t.evidence('wb-camera-reference');
    await pick(t, wb.sel, 'adv:wb_setting', /^As shot$/);
    await until(async () => (await choice(t, wb.sel, 'adv:wb_setting')).current === 'As shot', 'Settings reads As shot');
    const asShot = await settledPhoto(t, p => meanError(p, ref) > 1);
    t.measure({ name: 'wb-as-shot', meanAbsoluteError: meanError(asShot, ref) });
    await t.evidence('wb-as-shot');
    const menu = await choice(t, wb.sel, 'adv:wb_setting');
    const presets = menu.options.slice(4);
    t.measure({ name: 'wb-presets', presets: presets.map(p => p.label), current: menu.current });
    assert.equal(await exists(t, `${wb.sel} [data-control-id="adv:wb_tune"]`), false, 'no Finetune for as shot');
    if (presets.length) {
      await pick(t, wb.sel, 'adv:wb_setting', new RegExp(`^${presets[0].label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      await t.evidence('wb-preset');
    }
  });
}
