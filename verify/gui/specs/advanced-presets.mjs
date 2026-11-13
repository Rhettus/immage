// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const CARD = '[data-panel-id="basic"] [data-module^="exposure#"]';
const PRESET = '[data-preset="_builtin_magic lantern defaults"]';
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);
// the deflicker page shows Percentile; the manual page shows Exposure
const page = t => t.driver.observe(sel => {
  const c = document.querySelector(sel);
  return c ? { deflicker: !!c.querySelector('[data-control-id="adv:deflicker_percentile"]'),
               on: c.querySelector('input.switch').checked } : null;
}, CARD);
const errorText = t => t.driver.observe(() => {
  const s = document.querySelector('.status')?.textContent ?? '';
  return /error|fail|could not|unable/i.test(s) ? s : '';
});

export async function advancedPresets(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    const start = await until(async () => { const p = await page(t); return p && p; }, 'Exposure card');
    const before = await settledPhoto(t);

    // 1. the presets menu lists darktable's presets, magic lantern defaults among them
    await click(t, `${CARD} .preset-menu .module-card-menu`);
    await until(() => t.driver.observe(sel => !!document.querySelector(`.context-menu ${sel}`), PRESET), 'presets menu lists magic lantern defaults');
    const label = await t.driver.observe(sel => document.querySelector(`.context-menu ${sel} .name`)?.textContent ?? '', PRESET);
    assert.equal(label, 'magic lantern defaults', 'the _builtin_ prefix is not shown');
    t.measure({ name: 'presets-menu', label });
    await t.evidence('presets-menu');

    // 2. applying it switches the card to the deflicker page and turns it on
    await click(t, `.context-menu ${PRESET}`);
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'presets menu closed');
    const applied = await until(async () => { const p = await page(t); return p?.deflicker && p; }, 'deflicker page after the preset');
    assert.equal(applied.on, true, 'the preset switches the module on');
    t.measure({ name: 'preset-applied', before: start, after: applied });
    await t.evidence('preset-applied');

    // 3. the applied preset is checked when the menu reopens
    await click(t, `${CARD} .preset-menu .module-card-menu`);
    await until(() => t.driver.observe(sel => document.querySelector(`.context-menu ${sel}`)?.getAttribute('aria-checked') === 'true', PRESET), 'applied preset checked');
    await t.driver.keys(''); // Escape
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu dismissed');

    // 4. undo returns to the manual page, redo to deflicker
    await undoRedo(t, 'undo');
    await until(async () => { const p = await page(t); return p && !p.deflicker; }, 'undo returns the manual page');
    await settledPhoto(t, p => p.hash === before.hash).catch(() => null);
    await undoRedo(t, 'redo');
    await until(async () => (await page(t))?.deflicker, 'redo applies the preset again');

    // 5. nothing reported an error
    const err = await errorText(t);
    assert.equal(err, '', `no error notice: ${err}`);
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
