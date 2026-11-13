// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { addCard } from './advanced-exposure.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);

// a card as the page shows it: its switch, tabs, and the controls drawn
const card = (t, sel) => t.driver.observe(s => {
  const c = document.querySelector(s);
  if (!c) return null;
  return {
    on: c.querySelector('input.switch').checked,
    title: c.querySelector('.module-card-title')?.textContent.trim(),
    open: !!c.querySelector(':scope > .collapse.open'),
    tabs: [...c.querySelectorAll('.module-card-tabs [role=tab]')].map(b => ({ name: b.textContent.trim(), on: b.getAttribute('aria-selected') === 'true' })),
    controls: [...c.querySelectorAll('[data-control-id^="adv:"]')].map(e => ({
      id: e.getAttribute('data-control-id').slice(4), value: e.querySelector('input[type=range]') ? +e.querySelector('input[type=range]').value : null,
      shown: e.querySelector('.value')?.textContent.trim() ?? null })),
  };
}, sel);

// adds a module from the group's Add module (or finds its card), checks the
// card, and that adding it changed the photo when `changes`; undo of the add
// returns the photo
async function addAndCheck(t, group, op, title, expect, changes) {
  const sel = `[data-panel-id="${group}"] [data-module^="${op}#"]`;
  await panel(t, group);
  const before = await settledPhoto(t);
  const added = await addCard(t, group, op, sel);
  const c = await until(async () => { const x = await card(t, sel); return x?.open && x.controls.length && x; }, `${title} card open with its controls`);
  assert.match(c.title, new RegExp(`^${title}\\b`), `the card is titled ${title}`);
  for (const id of expect.controls) assert(c.controls.some(x => x.id === id), `${title} shows ${id}: ${JSON.stringify(c.controls)}`);
  if (expect.tabs) assert.deepEqual(c.tabs.map(x => x.name), expect.tabs, `${title} tabs`);
  t.measure({ name: `${op}-card`, group, added, card: c });
  await t.evidence(`${op}-card`);
  let after = before;
  if (added) {
    assert(c.on, `${title} is on after Add module`);
    if (changes) {
      after = await settledPhoto(t, p => meanError(p, before) > .5);
      t.measure({ name: `${op}-added`, meanAbsoluteError: meanError(after, before) });
    }
  }
  return { sel, before, after, added, card: c };
}

// types a value into a card's slider through its numeric editor
async function type(t, sel, id, text) {
  const slider = `${sel} [data-control-id="adv:${id}"]`;
  const v = await reveal(t, `${slider} .value`);
  await t.driver.point(v.x, v.y, 2);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .value-edit`), slider), `${id} numeric editor`);
  await t.driver.keys(text, '\uE007'); // Enter
}

export async function advancedGroups(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');

    // 1. Tone Curve: the tone equalizer card with darktable's three pages;
    // raising the -4 EV band brightens the photo, undo returns it
    const te = await addAndCheck(t, 'tonecurve', 'toneequal', 'Tone equalizer',
      { controls: ['noise', 'shadows', 'speculars'], tabs: ['Simple', 'Advanced', 'Masking'] }, false);
    const base = await settledPhoto(t);
    await type(t, te.sel, 'shadows', '1');
    const raised = await until(async () => { const c = await card(t, te.sel); const s = c.controls.find(x => x.id === 'shadows'); return Math.abs(s.value - 1) < .02 && c; }, '-4 EV band typed as +1');
    assert(raised.on, 'the tone equalizer is on after an edit');
    const bright = await settledPhoto(t, p => meanError(p, base) > .5);
    t.measure({ name: 'toneequal-band', meanAbsoluteError: meanError(bright, base), luma: [base.luma, bright.luma] });
    assert(bright.luma > base.luma, `raising -4 EV: luma ${bright.luma} not above ${base.luma}`);
    await t.evidence('toneequal-band');
    // the Masking page swaps the controls for its own
    await click(t, `${te.sel} .module-card-tabs [role=tab]:nth-child(3)`);
    const masking = await until(async () => { const c = await card(t, te.sel); return c.tabs[2]?.on && c.controls.some(x => x.id === 'method') && c; }, 'Masking tab shown');
    assert(!masking.controls.some(x => x.id === 'shadows'), 'the Simple page bands hide on the Masking tab');
    t.measure({ name: 'toneequal-masking', controls: masking.controls.map(x => x.id) });
    await t.evidence('toneequal-masking');
    await undoRedo(t, 'undo');
    const undone = await settledPhoto(t, p => meanError(p, base) < 1);
    const undoError = meanError(undone, base);
    t.measure({ name: 'toneequal-undo', meanAbsoluteError: undoError });
    assert(undoError < 1, `undo: photo mean pixel error ${undoError} exceeds 1/255`);

    // 2. Tone Curve: shadows and highlights, all eight controls, no tabs;
    // adding it with darktable's defaults (shadows +50) changes the photo
    await addAndCheck(t, 'tonecurve', 'shadhi', 'Shadows and highlights',
      { controls: ['shadows', 'highlights', 'whitepoint', 'shadhi_algo', 'radius', 'compress', 'shadows_ccorrect', 'highlights_ccorrect'], tabs: [] }, true);

    // 3. Color: velvia (strength 25 by default) changes the photo when added;
    // undo returns it
    const v = await addAndCheck(t, 'hsl', 'velvia', 'Velvia', { controls: ['strength', 'bias'], tabs: [] }, true);
    if (v.added) {
      await undoRedo(t, 'undo');
      const back = await settledPhoto(t, p => meanError(p, v.before) < 1);
      const backError = meanError(back, v.before);
      t.measure({ name: 'velvia-undo', meanAbsoluteError: backError });
      assert(backError < 1, `undo of Add velvia: photo mean pixel error ${backError} exceeds 1/255`);
    }

    // 4. Color: rgb primaries, a hue slider shown in degrees
    const pr = await addAndCheck(t, 'hsl', 'primaries', 'RGB primaries', { controls: ['red_hue', 'red_purity'], tabs: [] }, false);
    const hue = pr.card.controls.find(x => x.id === 'red_hue');
    t.measure({ name: 'primaries-hue', shown: hue.shown });
    assert.match(hue.shown, /°$/, `red hue shows degrees: ${hue.shown}`);

    // 5. B&W: listed though the photo is in color. Add module's color
    // calibration turns on Simple's Black & White, so the card is that
    // instance, Gray page first, and the photo loses its color; undo returns it
    const bwSel = '[data-panel-id="bw"] [data-module^="channelmixerrgb#"]';
    await panel(t, 'bw');
    const title = await t.driver.observe(() => document.querySelector('[data-panel-id="bw"] .panel-title span')?.textContent.trim());
    assert.equal(title, 'B&W', 'the B&W group shows, titled B&W');
    const color = await settledPhoto(t);
    const cal = await addAndCheck(t, 'bw', 'channelmixerrgb', 'Color calibration',
      { controls: ['grey[0]', 'grey[1]', 'grey[2]', 'normalize_grey'] }, false);
    assert.equal(cal.card.tabs[0]?.name, 'Gray', `Gray page first: ${JSON.stringify(cal.card.tabs)}`);
    assert(cal.card.on, 'the B&W calibration is on after Add module');
    const gray = await settledPhoto(t, p => meanError(p, color) > .5);
    t.measure({ name: 'bw-calibration', meanAbsoluteError: meanError(gray, color) });
    await t.evidence('bw-calibration');
    // only the B&W group shows that instance; Basic keeps the photo's first
    const basicCal = await t.driver.observe(() => document.querySelectorAll('[data-panel-id="basic"] [data-module^="channelmixerrgb#"]').length);
    assert(basicCal <= 1, `Basic shows ${basicCal} color calibration cards`);
    await undoRedo(t, 'undo');
    const colorBack = await settledPhoto(t, p => meanError(p, color) < 1);
    t.measure({ name: 'bw-undo', meanAbsoluteError: meanError(colorBack, color) });
    assert(meanError(colorBack, color) < 1, `undo of B&W: photo mean pixel error ${meanError(colorBack, color)} exceeds 1/255`);

    // 6. B&W: monochrome's one slider
    await addAndCheck(t, 'bw', 'monochrome', 'Monochrome', { controls: ['highlights'], tabs: [] }, true);
    await t.evidence('groups-done');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
