// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { panel, expandSections } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { inAdvanced, openCard, turnOn, meanError, undoRedo, count, exists, pick, choice, type, readout, readoutOf, typeInto, colorButton, pointAt } from '../support/cards.mjs';

// an acquired preview's swatches take the clusters' colors; with none they are all one neutral
const empty0n = v => v.split('|')[1];
const HEX = /^#[0-9a-f]{6}$/;

export async function advancedColorCards(t) {
  await inAdvanced(t, async () => {
    // 1. White balance: the Settings menu lists darktable's four standard
    // choices (a photo without camera presets has no others, so no Finetune),
    // and while the module sets the white balance with color calibration off
    // the card says so; Camera reference ends that and As shot brings it back
    const wb = await openCard(t, 'basic', 'temperature');
    await turnOn(t, wb.sel);
    const note = () => t.driver.observe(s => [...document.querySelectorAll(`${s} .note`)].some(n => /color calibration is off/.test(n.textContent)), wb.sel);
    await until(note, 'the color calibration note on the white balance card');
    const menu = await choice(t, wb.sel, 'adv:wb_setting');
    const labels = menu.options.map(o => o.label);
    t.measure({ name: 'wb-settings', labels, current: menu.current });
    for (const l of ['As shot', 'User modified', 'Camera reference', 'As shot to reference'])
      assert(labels.includes(l), `the Settings menu lists ${l}: ${labels}`);
    assert.equal(await exists(t, `${wb.sel} [data-control-id="adv:wb_tune"]`), false, 'a photo without camera presets shows no Finetune');
    await t.evidence('wb-note');
    // choosing a setting is checked on a raw photo (advanced-raw-cards): a JPEG
    // has no camera matrix, so the engine keeps it as shot
    assert.equal(menu.current, 'As shot');

    // 2. Framing: the border color and frame line color buttons show their
    // colors; the frame line one greys out with its reason when the border
    // size is 0 and comes back with undo. The color chooser is a native dialog
    // (outside the suite's boundary), so a chosen color is not exercised
    const fr = await openCard(t, 'effects', 'borders');
    const plain = await settledPhoto(t);
    await turnOn(t, fr.sel);
    const framed = await settledPhoto(t);   // the default border is as the photo shows it
    t.measure({ name: 'framing-on', meanAbsoluteError: meanError(framed, plain) });
    await t.evidence('framing-on');
    const border = await colorButton(t, fr.sel, 'color');
    const line = await colorButton(t, fr.sel, 'frame_color');
    t.measure({ name: 'framing-colors', border, line });
    assert(border && HEX.test(border.value), `the border color button: ${JSON.stringify(border)}`);
    assert(line && HEX.test(line.value), `the frame line color button: ${JSON.stringify(line)}`);
    assert.equal(border.disabled, false, 'the border color button is enabled');
    assert.equal(line.disabled, false, 'the frame line color button is enabled with a border');
    await t.evidence('framing-colors');
    await type(t, fr.sel, 'size', '0');
    await until(async () => (await colorButton(t, fr.sel, 'frame_color')).disabled, 'the frame line color greyed with no border');
    const why = (await colorButton(t, fr.sel, 'frame_color')).title;
    assert.match(why, /increase border size/, `greyed with its reason: ${why}`);
    await t.evidence('framing-line-greyed');
    await undoRedo(t, 'undo');
    await until(async () => !(await colorButton(t, fr.sel, 'frame_color')).disabled, 'the frame line color back after undo');
    // the watermark card's color button
    const wm = await openCard(t, 'effects', 'watermark');
    const wmColor = await colorButton(t, wm.sel, 'color');
    t.measure({ name: 'watermark-color', wmColor });
    assert(wmColor && HEX.test(wmColor.value) && !wmColor.disabled, `the watermark color button: ${JSON.stringify(wmColor)}`);
    await t.evidence('watermark-color');

    // 3. Color look up table: the patch grid. A click selects a patch, a
    // typed lightness offset alters it (outlined) and changes the frame, undo
    // returns both, a double-click resets it and a right-click deletes it
    const cc = await openCard(t, 'hsl', 'colorchecker');
    await turnOn(t, cc.sel);
    const grid = `${cc.sel} [data-patches="colorchecker"] svg.patches-area`;
    await until(() => exists(t, grid), 'patch grid');
    const patches = () => t.driver.observe(s => document.querySelector(`${s} [data-control-id="adv:colorchecker:patch"] select`).options.length, cc.sel);
    const selected = () => t.driver.observe(s => document.querySelector(`${s} [data-control-id="adv:colorchecker:patch"] select`).value, cc.sel);
    const altered = () => count(t, `${grid} rect[stroke="rgb(204,204,204)"]`);
    assert.equal(await patches(), 24, 'darktable\'s 24 color checker patches');
    const ccBase = await settledPhoto(t);
    // patch 21 is the 4th gray of the bottom row (6 wide, 4 high)
    const P21 = [3.5 / 6, 3.5 / 4];
    await pointAt(t, grid, ...P21);
    await until(async () => (await selected()) === '21', 'a click selects patch 21');
    assert.equal(await altered(), 0, 'no patch altered yet');
    await typeInto(t, cc.sel, 'adv:colorchecker:L', '60');
    await until(async () => (await altered()) === 1, 'the altered patch outlined');
    const lit = await settledPhoto(t, p => meanError(p, ccBase) > .3);
    t.measure({ name: 'colorchecker-lightness', meanAbsoluteError: meanError(lit, ccBase) });
    assert((await readoutOf(t, cc.sel, 'adv:colorchecker:L')).shown === 60, 'the lightness slider reads 60');
    await t.evidence('colorchecker-edited');
    await undoRedo(t, 'undo');
    await until(async () => (await altered()) === 0, 'undo takes the outline off');
    const undone = await settledPhoto(t, p => meanError(p, ccBase) < 1);
    assert(meanError(undone, ccBase) < 1, `undo of the patch: photo mean pixel error ${meanError(undone, ccBase)} exceeds 1/255`);
    // double-click resets an altered patch
    await typeInto(t, cc.sel, 'adv:colorchecker:L', '60');
    await until(async () => (await altered()) === 1, 'patch altered again');
    await pointAt(t, grid, ...P21, 'double');
    await until(async () => (await altered()) === 0, 'a double-click resets the patch');
    assert.equal((await readoutOf(t, cc.sel, 'adv:colorchecker:L')).shown, 0, 'the lightness slider back at 0');
    // right-click deletes it
    await pointAt(t, grid, ...P21, 'right');
    await until(async () => (await patches()) === 23, 'a right-click deletes the patch');
    await t.evidence('colorchecker-deleted');
    await undoRedo(t, 'undo');
    await until(async () => (await patches()) === 24, 'undo restores the patch');

    // 4. Color mapping: acquire as source fills its preview, brightening the
    // photo and acquiring as target fills the other and changes the frame, and
    // changing the cluster count clears both
    const cm = await openCard(t, 'hsl', 'colormapping');
    await turnOn(t, cm.sel);
    // a preview is its swatches' colors, so it is read as them
    const swatches = side => t.driver.observe((s, d) => [...document.querySelectorAll(`${s} [data-clusters="colormapping"] svg[data-side="${d}"] rect`)].map(r => r.getAttribute('fill')).join('|'), cm.sel, side);
    const NEUTRAL = empty0n(await swatches('source'));
    const empty0 = { source: await swatches('source'), target: await swatches('target') };
    t.measure({ name: 'colormapping-initial', empty0 });
    await click(t, `${cm.sel} [data-control-id="adv:acquire-source"]`);
    await until(async () => (await swatches('source')) !== empty0.source, 'the source preview filled');
    assert.equal(await swatches('target'), empty0.target, 'the target preview still empty');
    await t.evidence('colormapping-source');
    // a brighter version of the photo to acquire the target from
    const ex = await openCard(t, 'basic', 'exposure');
    await turnOn(t, ex.sel);
    await type(t, ex.sel, 'exposure', '1.5');
    const bright = await settledPhoto(t, p => meanError(p, ccBase) > 2);
    await openCard(t, 'hsl', 'colormapping');
    await click(t, `${cm.sel} [data-control-id="adv:acquire-target"]`);
    await until(async () => (await swatches('target')) !== empty0.target, 'the target preview filled');
    const mapped = await settledPhoto(t, p => meanError(p, bright) > .3);
    t.measure({ name: 'colormapping-target', meanAbsoluteError: meanError(mapped, bright) });
    await t.evidence('colormapping-target');
    const n0 = await readout(t, cm.sel, 'n');
    await type(t, cm.sel, 'n', String(n0.shown === 3 ? 4 : 3));
    await until(async () => [await swatches('source'), await swatches('target')].every(v => v.split('|').slice(1).every(f => f === NEUTRAL)), 'both previews cleared by the cluster count');
    await t.evidence('colormapping-cleared');

    // 5. Simple's White Balance section carries the same note while the
    // module sets the white balance (as shot, color calibration off)
    await setMode(t, 'Simple');
    await openTool(t, 'adjust');
    const simple = await panel(t, 'basic');
    await expandSections(t, simple);
    await until(() => t.driver.observe(s => [...document.querySelectorAll(`${s} .note`)].some(n => /white balance comes from the white balance module/.test(n.textContent)), simple), 'the note in Simple\'s White Balance section');
    await t.evidence('simple-wb-note');
    await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
  });
}
