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

    // 7. Color Grading: color balance rgb is Basic's instance, 4 ways first;
    // color balance shows a factor and red, green and blue per range
    const cb = await addAndCheck(t, 'colorgrading', 'colorbalancergb', 'Color balance rgb',
      { controls: ['shadows_Y', 'highlights_H', 'midtones_C'], tabs: ['4 ways', 'Master', 'Masks'] }, false);
    assert(cb.card.tabs[0].on, `4 ways selected: ${JSON.stringify(cb.card.tabs)}`);
    const basicCb = await t.driver.observe(() => document.querySelectorAll('[data-panel-id="basic"] [data-module^="colorbalancergb#"]').length);
    t.measure({ name: 'colorbalancergb-basic-cards', count: basicCb });
    await addAndCheck(t, 'colorgrading', 'colorbalance', 'Color balance',
      { controls: ['mode', 'saturation', 'lift[0]', 'lift[1]', 'gain[3]'], tabs: [] }, false);
    // 8. Color Grading: colorize (saturation 50% by default) changes the photo
    await addAndCheck(t, 'colorgrading', 'colorize', 'Colorize',
      { controls: ['hue', 'saturation', 'lightness', 'source_lightness_mix'], tabs: [] }, true);

    // 9. Detail: Add diffuse or sharpen makes Simple's Sharpening instance,
    // which only the Detail card shows; Basic's card keeps the first
    const ds = await addAndCheck(t, 'detail', 'diffuse', 'Diffuse or sharpen',
      { controls: ['iterations', 'radius', 'regularization'], tabs: [] }, false);
    assert(ds.card.on, 'the Sharpening instance is on after Add module');
    const iter = ds.card.controls.find(x => x.id === 'iterations');
    t.measure({ name: 'diffuse-sharpen', iterations: iter.value });
    assert.equal(iter.value, 3, `Add module makes darktable's "sharpness | normal" 3 iterations: ${iter.value}`);
    const detailDs = await t.driver.observe(() => document.querySelectorAll('[data-panel-id="detail"] [data-module^="diffuse#"]').length);
    assert.equal(detailDs, 1, `Detail shows ${detailDs} diffuse or sharpen cards`);
    // 10. Detail: denoise (profiled) sliders, the wavelet mode's
    await addAndCheck(t, 'detail', 'denoiseprofile', 'Denoise',
      { controls: ['mode', 'strength', 'wavelet_color_mode'], tabs: [] }, false);
    // 11. Detail: lowpass (radius 10 by default) blurs the photo when added
    await addAndCheck(t, 'detail', 'lowpass', 'Lowpass',
      { controls: ['radius', 'lowpass_algo', 'saturation'], tabs: [] }, true);
    // 12. Lens Corrections: darktable renders the lens module's defaults
    // until an edit sets has_been_set, which the card sends with each edit:
    // typing a manual vignette strength changes the photo
    const lc = await addAndCheck(t, 'lens', 'lens', 'Lens correction',
      { controls: ['method', 'modify_flags', 'v_strength', 'v_radius', 'v_steepness'], tabs: [] }, false);
    const unvignetted = await settledPhoto(t);
    await type(t, lc.sel, 'v_strength', '0.8');
    await until(async () => { const c = await card(t, lc.sel); const s = c.controls.find(x => x.id === 'v_strength'); return Math.abs(s.value - .8) < .01 && c; }, 'vignette strength typed as 0.8');
    const vignetted = await settledPhoto(t, p => meanError(p, unvignetted) > .5);
    t.measure({ name: 'lens-vignette', meanAbsoluteError: meanError(vignetted, unvignetted) });
    await t.evidence('lens-vignette');
    // 13. Transform: a typed rotation turns the photo, and the card refits
    // the crop with it, as Simple's Rotate does: no black corners
    const rp = await addAndCheck(t, 'transform', 'ashift', 'Rotate and perspective',
      { controls: ['rotation', 'lensshift_v', 'lensshift_h', 'aspect'], tabs: [] }, false);
    const level = await settledPhoto(t);
    await type(t, rp.sel, 'rotation', '5');
    await until(async () => { const c = await card(t, rp.sel); const s = c.controls.find(x => x.id === 'rotation'); return Math.abs(s.value - 5) < .01 && c; }, 'rotation typed as 5');
    const rotated = await settledPhoto(t, p => meanError(p, level) > .5);
    const corner = (p, x, y) => Math.max(...p.rgba.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 3));
    const corners = [[0, 0], [63, 0], [0, 63], [63, 63]].map(([x, y]) => corner(rotated, x, y));
    t.measure({ name: 'ashift-rotation', meanAbsoluteError: meanError(rotated, level), corners });
    await t.evidence('ashift-rotation');
    assert(corners.every(c => c > 8), `black corners after a rotation: ${corners}`);
    // 14. Transform: the orientation card's buttons turn the photo as the
    // toolbar does; a quarter turn swaps the frame's sides, undo turns back
    const fsel = '[data-panel-id="transform"] [data-module^="flip#"]';
    const fc = await until(() => card(t, fsel), 'orientation card');
    if (!fc.open) await click(t, `${fsel} .module-card-head`);
    await until(() => t.driver.observe(s => !!document.querySelector(s), `${fsel} .module-card-turns button`), 'turn buttons shown');
    const wide = p => p.width > p.height;
    const unturned = await settledPhoto(t);
    await click(t, `${fsel} button[title="Rotate 90 degrees CW"]`);
    const turned = await settledPhoto(t, p => wide(p) !== wide(unturned));
    t.measure({ name: 'orientation-turn', before: [unturned.width, unturned.height], after: [turned.width, turned.height] });
    await t.evidence('orientation-turn');
    await undoRedo(t, 'undo');
    await settledPhoto(t, p => wide(p) === wide(unturned));
    await t.evidence('groups-done');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
