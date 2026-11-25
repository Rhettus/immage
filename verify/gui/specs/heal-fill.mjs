// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Heal's Fill and Blur spots (HealPanel.tsx, FillSection.tsx): a fill spot
// changes the frame, the shared Fill and blur settings (Affects, Limit to
// color) change it again, a blur spot is made beside it, and the Before view
// takes both away. Selectors and labels come from fields.heal.* in en.json;
// the case runs in English, which the isolated profile defaults to.
import assert from 'node:assert/strict';
import { click, inspect, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { settledPhoto } from './smoke.mjs';

const CLEAR = '.heal-actions button:nth-child(2)';
const spotCount = () => {
  const m = /\((\d+)\)/.exec(document.querySelector('.heal-actions button:nth-child(2)')?.textContent ?? '');
  return m ? +m[1] : 0;
};
const on = (sel, label) => [...document.querySelectorAll(`${sel} button`)].some(b => b.textContent.trim() === label && b.classList.contains('on'));
const hasText = (sel, label) => [...document.querySelectorAll(sel)].some(e => e.textContent.trim() === label);

// the photo's hash once it has settled and differs from `from`
async function changed(t, from, what) {
  return until(async () => {
    const p = await settledPhoto(t);
    return p.hash !== from && p.hash;
  }, what, 30000);
}

async function overlay(t) {
  return until(async () => {
    const c = await t.driver.observe(inspect, 'svg.spot-svg');
    if (!c) throw Error('Heal overlay is not mounted');
    const { left, right, top, bottom } = c.clip;
    return c.hit && right - left > 100 && bottom - top > 100 && { x: (left + right) / 2, y: (top + bottom) / 2, w: right - left };
  }, 'visible Heal overlay', 15000);
}

async function mode(t, label) {
  await textButton(t, '.heal-mode', label);
  await until(() => t.driver.observe(on, '.heal-mode', label), `${label} on`);
}

export async function healFill(t) {
  await openTool(t, 'heal');
  if (await t.driver.observe(spotCount)) { await click(t, CLEAR); await until(async () => !await t.driver.observe(spotCount), 'spots cleared'); }
  const start = (await settledPhoto(t)).hash;
  const canvas = await overlay(t);
  const left = { x: canvas.x - canvas.w * .2, y: canvas.y }, right = { x: canvas.x + canvas.w * .2, y: canvas.y };

  // Fill, Color from the photo: the shared section shows, a click fills a spot
  await mode(t, 'Fill');
  await until(() => t.driver.observe(hasText, '.heal-sub', 'Fill and blur'), 'Fill and blur section shown');
  await until(() => t.driver.observe(on, '.heal-row', 'Color only'), 'Affects defaults to Color only');
  await until(() => t.driver.observe(on, '.heal-row', 'Off'), 'Limit to color defaults to Off');
  await t.driver.point(left.x, left.y);
  await until(async () => await t.driver.observe(spotCount) === 1, 'one fill spot');
  assert(!await t.driver.observe(() => !!document.querySelector('svg.spot-svg circle.spot-pin.source')), 'a fill spot draws no source');
  const filled = await changed(t, start, 'the fill spot changes the frame');
  await t.evidence('heal-fill-spot');

  // the shared settings apply to every fill and blur spot
  await textButton(t, '.heal-row', 'Color and tone');
  await until(() => t.driver.observe(on, '.heal-row', 'Color and tone'), 'Affects: Color and tone');
  const toned = await changed(t, filled, 'Color and tone changes the frame');
  await t.evidence('heal-fill-color-tone');

  // a color range limits the fill: the frame changes again; Off takes it back
  await textButton(t, '.heal-row', 'Range');
  await until(() => t.driver.observe(on, '.heal-row', 'Range'), 'Limit to color: Range');
  const ranged = await changed(t, toned, 'a color range limit changes the frame');
  await t.evidence('heal-fill-range');
  await textButton(t, '.heal-row', 'Off');
  await until(() => t.driver.observe(on, '.heal-row', 'Off'), 'Limit to color: Off');
  const unranged = await changed(t, ranged, 'Off removes the color limit');
  assert.equal(unranged, toned, 'Off returns the frame to the unlimited fill');

  // Blur: switching would make the selected fill spot a blur one (same kind),
  // so Escape lets it go first
  await t.driver.keys('');
  await mode(t, 'Blur');
  await t.driver.point(right.x, right.y);
  await until(async () => await t.driver.observe(spotCount) === 2, 'a blur spot beside the fill spot');
  const blurred = await changed(t, unranged, 'the blur spot changes the frame');
  await t.evidence('heal-blur-spot');

  // Before (backslash) takes both spots away, and back; Before is the photo
  // with no edits at all, which matches `start` only on an unedited fixture
  await t.driver.keys('\\');
  await changed(t, blurred, 'Before shows the photo without the spots');
  await t.driver.keys('\\');
  await until(async () => (await settledPhoto(t)).hash === blurred, 'After shows the spots again', 30000);

  t.measure({ name: 'heal-fill', start, filled, toned, ranged, blurred, photo: (await t.driver.observe(read.photo))?.hash });
  await click(t, CLEAR);
  await until(async () => !await t.driver.observe(spotCount), 'spots cleared');
  await changed(t, blurred, 'Clear all removes the fill and blur spots');
  await mode(t, 'Heal');
}
