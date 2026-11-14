// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { choose } from '../support/scenario.mjs';
import { waitSetting } from '../support/settings.mjs';
import { settledPhoto } from './smoke.mjs';
import { inAdvanced, openCard, turnOn, meanError, undoRedo, exists, type } from '../support/cards.mjs';

const selectOf = (t, sel) => t.driver.observe(s => {
  const e = document.querySelector(`${s} select`);
  return e && { disabled: e.disabled, current: e.selectedOptions[0]?.textContent.trim() ?? '', options: [...e.options].map(o => ({ value: o.value, label: o.textContent.trim() })) };
}, sel);

// Preferences > Modules > 3D LUT folder, typed into the row's text field
// (its Choose button opens a native folder dialog, outside the boundary)
async function setLutFolder(t, folder) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Modules');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Modules tab');
  await t.driver.point(tab.x, tab.y);
  // the row is in the Advanced modules fold
  const fold = 'button.module-prefs-fold[aria-controls="module-prefs-advanced"]';
  await until(() => exists(t, fold), 'Advanced modules fold');
  if (await t.driver.observe(f => document.querySelector(f).getAttribute('aria-expanded') !== 'true', fold)) await click(t, fold);
  const input = 'input[aria-label="3D LUT folder"]';
  await until(() => exists(t, input), '3D LUT folder row');
  await click(t, input);
  await t.driver.keys(...folder);
  await until(() => t.driver.observe((s, f) => document.querySelector(s).value === f, input, folder), 'the field holds the folder');
  const stored = await waitSetting(t, 'immage.lutFolder', v => v === folder, 'the folder stored');
  await t.evidence('lut-folder-pref');
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
  await openTool(t, 'adjust');
  return stored;
}

const aligned = (t, sel) => t.driver.observe(s => [...document.querySelectorAll(`${s} .module-align button[role=radio]`)]
  .filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.getAttribute('aria-label')), sel);
async function align(t, card, name) {
  await click(t, `${card.sel} .module-align button[aria-label="${name}"]`);
  await until(async () => (await aligned(t, card.sel)).join() === name, `${name} aligned`);
}

export async function advancedFileCards(t) {
  await inAdvanced(t, async () => {
    // 1. LUT 3D: the photo's sidecar already uses film/invert.cube (the file
    // dialog that chooses a first file is native and not exercised). With the
    // LUT folder at its default the file is missing, the card lists it as
    // invalid and the frame is unaffected; setting Preferences > Modules > 3D
    // LUT folder finds it and the card lists the folder's two cubes; picking the
    // dimming one darkens the frame, undo returns the inverting file
    const lut = await openCard(t, 'hsl', 'lut3d');
    const file = `${lut.sel} [data-control-id="adv:lut_file"]`;
    await until(async () => (await selectOf(t, file))?.current !== undefined, 'LUT file menu');
    const missing = await selectOf(t, file);
    t.measure({ name: 'lut-missing', missing });
    assert.match(missing.current, /^INVALID >> film\/invert\.cube$/, 'a missing LUT is listed as invalid');
    assert.equal(await exists(t, `${file} button[aria-label="Select LUT file"]`), true, 'the file button is there (its dialog is not opened)');
    const folderBase = await settledPhoto(t);
    await t.evidence('lut-invalid');
    const folder = join(t.fixtureDir, 'luts');
    await setLutFolder(t, folder);
    await openCard(t, 'hsl', 'lut3d');
    await until(async () => { const s = await selectOf(t, file); return s?.current === 'film/invert.cube' && s.options.length === 2; }, 'both cubes listed with the chosen one selected');
    const listed = await selectOf(t, file);
    assert.deepEqual(listed.options.map(o => o.label), ['film/dim.cube', 'film/invert.cube']);
    await t.evidence('lut-listed');
    // the folder reaches the engine at once and the frame follows the next edit,
    // here the other file: dim.cube halves the colors against the unaffected photo
    const dim = listed.options.find(o => o.label === 'film/dim.cube');
    await choose(t, `${file} select`, dim.value);
    await until(async () => (await selectOf(t, file)).current === 'film/dim.cube', 'dim.cube chosen');
    const dimmed = await settledPhoto(t, p => meanError(p, folderBase) > 10);
    t.measure({ name: 'lut-dim', meanAbsoluteError: meanError(dimmed, folderBase), luma: [folderBase.luma, dimmed.luma] });
    assert(dimmed.luma < folderBase.luma, `a dimming LUT darkens: luma ${dimmed.luma} not below ${folderBase.luma}`);
    await t.evidence('lut-dim');
    // the other cube inverts the colors; undo returns the dimming one
    const inv = listed.options.find(o => o.label === 'film/invert.cube');
    await choose(t, `${file} select`, inv.value);
    await until(async () => (await selectOf(t, file)).current === 'film/invert.cube', 'invert.cube chosen');
    const inverted = await settledPhoto(t, p => meanError(p, dimmed) > 10);
    t.measure({ name: 'lut-invert', meanAbsoluteError: meanError(inverted, dimmed), luma: [dimmed.luma, inverted.luma] });
    await t.evidence('lut-inverted');
    await undoRedo(t, 'undo');
    await until(async () => (await selectOf(t, file)).current === 'film/dim.cube', 'undo returns to dim.cube');
    const undone = await settledPhoto(t, p => meanError(p, dimmed) < 1);
    assert(meanError(undone, dimmed) < 1, `undo of the LUT file: photo mean pixel error ${meanError(undone, dimmed)} exceeds 1/255`);
    // the LUT is switched off for the rest, so the frames below start from the photo
    await click(t, `${lut.sel} input.switch`);
    await until(() => t.driver.observe(s => !document.querySelector(`${s} input.switch`).checked, lut.sel), 'LUT 3D off');
    const plain = await settledPhoto(t, p => meanError(p, undone) > 10);

    // 2. Watermark: the marker list and its refresh button; a marker added to
    // darktable's watermarks folder shows after a refresh; the 3x3 alignment grid
    const wm = await openCard(t, 'effects', 'watermark');
    const marks = `${wm.sel} [data-control-id="adv:wm_marker"]`;
    await turnOn(t, wm.sel);
    const marked = await settledPhoto(t, p => meanError(p, plain) > .3);
    t.measure({ name: 'watermark-on', meanAbsoluteError: meanError(marked, plain) });
    const list = await selectOf(t, marks);
    assert(list.options.length >= 2, `darktable ships markers: ${JSON.stringify(list.options)}`);
    const other = list.options.find(o => o.label !== list.current);
    await choose(t, `${marks} select`, other.value);
    await until(async () => (await selectOf(t, marks)).current === other.label, `${other.label} chosen`);
    const swapped = await settledPhoto(t, p => meanError(p, marked) > .1);
    t.measure({ name: 'watermark-marker', from: list.current, to: other.label, meanAbsoluteError: meanError(swapped, marked) });
    await t.evidence('watermark-marker');
    const dir = join(t.configDir, 'watermarks');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'zz-mine.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="#c00"/></svg>');
    await click(t, `${marks} button[aria-label="Refresh the marker list"]`);
    await until(async () => (await selectOf(t, marks)).options.length === list.options.length + 1, 'the refresh lists the new marker');
    assert((await selectOf(t, marks)).options.some(o => /zz-mine/.test(o.label)), 'zz-mine is listed');
    await t.evidence('watermark-refreshed');
    const nine = await t.driver.observe(s => document.querySelectorAll(`${s} .module-align button[role=radio]`).length, wm.sel);
    assert.equal(nine, 9, 'a 3x3 alignment grid');
    const first = await aligned(t, wm.sel);
    assert.equal(first.length, 1, `one cell on: ${first}`);
    const before = await settledPhoto(t);
    await align(t, wm, 'bottom right');
    const moved = await settledPhoto(t, p => meanError(p, before) > .1);
    t.measure({ name: 'watermark-align', from: first[0], to: 'bottom right', meanAbsoluteError: meanError(moved, before) });
    await t.evidence('watermark-align');
    await align(t, wm, 'top left');
    await settledPhoto(t, p => meanError(p, moved) > .1);
    await click(t, `${wm.sel} input.switch`);
    await until(() => t.driver.observe(s => !document.querySelector(`${s} input.switch`).checked, wm.sel), 'watermark off');

    // 3. Composite: Choose photo lists the folder's photos, a pick composites
    // it over this photo, Clear takes it off again, and the alignment grid moves it
    const co = await openCard(t, 'effects', 'overlay');
    await turnOn(t, co.sel);
    const photo = `${co.sel} .module-photo`;
    const name = () => t.driver.observe(s => document.querySelector(`${s} .photo-name`).textContent.trim(), photo);
    assert.equal(await name(), 'No photo chosen');
    const empty = await settledPhoto(t);
    await click(t, `${photo} button[title="choose the photo to put over this one"]`);
    const dialog = '[role=dialog][aria-label="Choose photo"]';
    await until(() => exists(t, dialog), 'the Choose photo modal');
    const names = await t.driver.observe(d => [...document.querySelectorAll(`${d} .photo-pick`)].map(b => b.getAttribute('title')), dialog);
    t.measure({ name: 'composite-picker', names });
    assert(names.includes('advanced-second.jpg'), `the picker lists the folder's photos: ${names}`);
    await t.evidence('composite-picker');
    // the picker's tiles are plainly visible, yet reveal() reads them clipped by an
    // ancestor of the modal's grid, so the click aims at the tile's own center
    const tile = await t.driver.observe(d => { const r = document.querySelector(`${d} .photo-pick[title="advanced-second.jpg"]`).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, dialog);
    await t.driver.point(tile.x, tile.y);
    await until(async () => !(await exists(t, dialog)), 'the modal closes on a pick');
    await until(async () => (await name()) === 'advanced-second.jpg', 'the card names the chosen photo');
    const composed = await settledPhoto(t, p => meanError(p, empty) > .3);
    t.measure({ name: 'composite-photo', meanAbsoluteError: meanError(composed, empty) });
    await t.evidence('composite-photo');
    // at full scale the photo covers this one, so a smaller one is moved
    await type(t, co.sel, 'scale', '40');
    const small = await settledPhoto(t, p => meanError(p, composed) > .3);
    await align(t, co, 'bottom right');
    const placed = await settledPhoto(t, p => meanError(p, small) > .3);
    t.measure({ name: 'composite-align', meanAbsoluteError: meanError(placed, small) });
    await t.evidence('composite-align');
    await click(t, `${photo} button[title="take the photo off the composite"]`);
    await until(async () => (await name()) === 'No photo chosen', 'Clear empties the card');
    const cleared = await settledPhoto(t, p => meanError(p, empty) < 1);
    assert(meanError(cleared, empty) < 1, `Clear: photo mean pixel error ${meanError(cleared, empty)} exceeds 1/255`);
  });
}
