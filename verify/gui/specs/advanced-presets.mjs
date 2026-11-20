// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';
import { addCard } from './advanced-exposure.mjs';

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
    await addCard(t, 'basic', 'exposure', CARD);
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

    const name = 'GUI Exposure preset';
    const userPreset = `[data-preset="${name}"]`;
    const userRow = `.context-menu .module-preset-row:has(${userPreset})`;
    const openPresets = () => click(t, `${CARD} .preset-menu .module-card-menu`);
    const dialog = '.modal[role="dialog"].new-preset';
    const presetMatches = () => t.driver.observe(sel =>
      document.querySelector(`.context-menu ${sel}`)?.getAttribute('aria-checked') === 'true', userPreset);

    await undoRedo(t, 'undo');
    await until(async () => { const p = await page(t); return p && !p.deflicker; }, 'manual Exposure page');
    const slider = `${CARD} [data-control-id="adv:exposure"]`;
    const value = await reveal(t, `${slider} .value`);
    await t.driver.point(value.x, value.y, 2);
    await until(() => t.driver.observe(sel => !!document.querySelector(`${sel} .value-edit`), slider), 'Exposure numeric editor');
    await t.driver.keys('1', '\uE007');
    const exposure = () => t.driver.observe(sel => +document.querySelector(`${sel} input[type="range"]`)?.value, slider);
    await until(async () => Math.abs(await exposure() - 1) < .02, 'Exposure set to +1 EV');
    const savedPhoto = await settledPhoto(t);
    await openPresets();
    await click(t, '.context-menu > button:last-child');
    await click(t, `${dialog} input`);
    await t.driver.keys(...name);
    await click(t, `${dialog} button[type="submit"]`);
    await until(() => t.driver.observe(sel => !document.querySelector(sel), dialog), 'save dialog closed');
    await openPresets();
    await until(presetMatches, 'saved preset matches the current module');
    await t.evidence('user-preset-saved');
    await t.driver.keys('\uE00C'); // Escape
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu dismissed');

    await click(t, `${CARD} .module-card-reset`);
    await until(async () => Math.abs(await exposure()) < .02, 'module reset to 0 EV');
    await settledPhoto(t, p => p.hash !== savedPhoto.hash);
    await openPresets();
    await click(t, `.context-menu ${userPreset}`);
    await until(async () => Math.abs(await exposure() - 1) < .02, 'user preset restores Exposure to +1 EV');
    const restored = await settledPhoto(t, p => p.hash === savedPhoto.hash);
    t.measure({ name: 'user-preset-render', saved: savedPhoto.hash, restored: restored.hash });

    await openPresets();
    await until(presetMatches, 'applied user preset is checked');
    assert.equal(await t.driver.observe(sel =>
      !!document.querySelector(`.context-menu ${sel}`).closest('.module-preset-row').querySelector('.module-preset-delete'), PRESET), false,
    'there is no delete button for the built-in preset');
    await click(t, `${userRow} .module-preset-delete`);
    await t.evidence('user-preset-delete-confirmation');
    await click(t, `${dialog} button[type="submit"]`);
    await until(() => t.driver.observe(sel => !document.querySelector(sel), dialog), 'delete dialog closed');
    await openPresets();
    await until(() => t.driver.observe(sel => !!document.querySelector(`.context-menu ${sel}`), PRESET), 'preset list reloaded');
    assert.equal(await t.driver.observe(sel => !!document.querySelector(`.context-menu ${sel}`), userPreset), false);
    await t.driver.keys('\uE00C'); // Escape
    await settledPhoto(t, p => p.hash === savedPhoto.hash);
    assert.ok(Math.abs(await exposure() - 1) < .02, 'deleting a preset preserves the applied edit');
    await t.evidence('user-preset-deleted');

    // WebDriver selects the copied file on the webview's file input.
    // The native chooser stays outside the runner's app-only boundary.
    await openPresets();
    const fileInput = '.context-menu input[type=file][accept=".dtpreset"]';
    await until(() => t.driver.observe(sel => !!document.querySelector(sel), fileInput), 'darktable file input');
    await t.driver.guard();
    const selected = await t.driver.command('POST', '/element', { using: 'css selector', value: fileInput });
    const inputId = selected['element-6066-11e4-a52e-4f735466cecf'];
    const fixture = join(t.fixtureDir, 'exposure.dtpreset');
    await t.driver.command('POST', `/element/${inputId}/value`, { text: fixture });
    const importedPreset = '.context-menu [data-preset="Exported Exposure"]';
    await until(() => t.driver.observe(sel => !!document.querySelector(sel), importedPreset), 'imported darktable preset is listed');
    await t.evidence('darktable-preset-imported');
    await click(t, importedPreset);
    await until(async () => Math.abs(await exposure() - 1.25) < .02, 'darktable preset sets Exposure to +1.25 EV');
    const importedPhoto = await settledPhoto(t, p => p.hash !== savedPhoto.hash && p.luma > savedPhoto.luma);
    t.measure({ name: 'imported-darktable-preset', settings: await exposure(), before: savedPhoto.hash, after: importedPhoto.hash });
    await t.evidence('darktable-preset-applied');
    await undoRedo(t, 'undo');
    await until(async () => Math.abs(await exposure() - 1) < .02, 'undo restores +1 EV');
    await settledPhoto(t, p => p.hash === savedPhoto.hash);

    // nothing reported an error
    const err = await errorText(t);
    assert.equal(err, '', `no error notice: ${err}`);
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
