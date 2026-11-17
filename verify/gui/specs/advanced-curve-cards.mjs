// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';
import { inAdvanced, openCard, turnOn, meanError, undoRedo, count, exists, pick, pointAt, dragAt, type, readout } from '../support/cards.mjs';

// the wavelet curve editor's knots, as their heights in the graph's own units
export const knots = (t, sel) => t.driver.observe(s => [...document.querySelectorAll(`${s} circle.bands-knot`)].map(c => +c.getAttribute('cy')), sel);
const close = (a, b, d = .5) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= d);
const handles = (t, sel) => t.driver.observe(s => [...document.querySelectorAll(`${s} line.levels-line`)].map(l => +l.getAttribute('x1')), sel);

// drags a wavelet curve's middle up, checks the knot heights and the frame,
// undoes it, redoes it and resets the channel with a double-click
export async function bandsCase(t, card, op, name, minError) {
  const g = `${card.sel} [data-bands="${op}"]`;
  const svg = `${g} svg.bands-area`;
  await until(() => exists(t, svg), `${name} wavelet graph`);
  const tabs = await t.driver.observe(s => [...document.querySelectorAll(`${s} [data-bands-channel]`)].map(e => e.getAttribute('data-bands-channel')), g);
  assert(JSON.stringify(tabs) === JSON.stringify(['all', 'R', 'G', 'B']) || JSON.stringify(tabs) === JSON.stringify(['luma', 'chroma']), `${name} tabs: ${tabs}`);
  t.measure({ name: `${name}-tabs`, tabs });
  const flat = await knots(t, svg);
  assert(flat.length >= 5, `${name} knots: ${flat}`);
  const base = await settledPhoto(t);
  // the middle of the curve, up to near the top
  await dragAt(t, svg, [.5, .5], [.5, .1]);
  await until(async () => !close(await knots(t, svg), flat, 2), `${name} knots moved by the drag`);
  const edited = await settledPhoto(t);
  const up = await knots(t, svg);
  assert(Math.min(...up) < Math.min(...flat) - 5, `${name}: a knot rose: ${flat} to ${up}`);
  t.measure({ name: `${name}-drag`, knots: [flat, up], meanAbsoluteError: meanError(edited, base) });
  assert(meanError(edited, base) > minError, `${name}: the drag changed the photo by ${meanError(edited, base)}, at least ${minError} expected`);
  await t.evidence(`${name}-drag`);
  // another channel's tab shows its own, still flat, curve (R, or chroma)
  await click(t, `${g} [data-bands-channel="${tabs[1]}"]`);
  await until(() => t.driver.observe((s, c) => document.querySelector(`${s} [data-bands-channel="${c}"]`).getAttribute('aria-selected') === 'true', g, tabs[1]), `${tabs[1]} tab selected`);
  assert(close(await knots(t, svg), flat, 2), `${name}: the R curve is untouched: ${await knots(t, svg)}`);
  await click(t, `${g} [data-bands-channel="${tabs[0]}"]`);
  await until(async () => close(await knots(t, svg), up, 2), 'the all curve again');
  await undoRedo(t, 'undo');
  await until(async () => close(await knots(t, svg), flat, 2), `${name}: undo returns the knots`);
  const back = await settledPhoto(t, p => meanError(p, base) < 1);
  assert(meanError(back, base) < 1, `undo of the ${name} curve: photo mean pixel error ${meanError(back, base)} exceeds 1/255`);
  await undoRedo(t, 'redo');
  await until(async () => close(await knots(t, svg), up, 2), `${name}: redo moves the knots again`);
  await pointAt(t, svg, .5, .5, 'double');
  await until(async () => close(await knots(t, svg), flat, 2), `${name}: a double-click resets the curve`);
  await t.evidence(`${name}-reset`);
}

export async function advancedCurveCards(t) {
  await inAdvanced(t, async () => {
    // 1. RGB levels: the black, gray and white handles; dragging the white
    // one in brightens the frame, undo returns it, a double-click resets the
    // handles and independent channels show R, G and B tabs
    const lv = await openCard(t, 'tonecurve', 'rgblevels');
    await turnOn(t, lv.sel);
    const area = `${lv.sel} [data-levels="rgblevels"] svg.levels-area`;
    await until(() => exists(t, area), 'levels graph');
    const flat = await handles(t, area);
    assert.equal(flat.length, 3, `three handles: ${flat}`);
    assert(flat[0] < flat[1] && flat[1] < flat[2], `black, gray, white in order: ${flat}`);
    assert.equal(await count(t, `${lv.sel} [data-levels-channel]`), 0, 'linked channels show no channel tabs');
    const base = await settledPhoto(t);
    let tries = 0;
    for (; tries < 3; tries++) {
      await dragAt(t, area, [.95, .5], [.7, .5]);
      try { await until(async () => (await handles(t, area))[2] < flat[2] - 20, 'the white handle moved in', 8000); break; } catch (e) { if (tries === 2) throw e; }
    }
    t.measure({ name: 'levels-drag-tries', tries: tries + 1 });
    const moved = await handles(t, area);
    const bright = await settledPhoto(t, p => meanError(p, base) > .5);
    t.measure({ name: 'levels-white', handles: [flat, moved], meanAbsoluteError: meanError(bright, base), luma: [base.luma, bright.luma] });
    assert(bright.luma > base.luma, `a lower white point brightens: luma ${bright.luma} not above ${base.luma}`);
    assert.equal(moved[0], flat[0], 'the black handle stays');
    await t.evidence('levels-white');
    await undoRedo(t, 'undo');
    await until(async () => Math.abs((await handles(t, area))[2] - flat[2]) < 1, 'undo returns the white handle');
    const back = await settledPhoto(t, p => meanError(p, base) < 1);
    assert(meanError(back, base) < 1, `undo of the levels: photo mean pixel error ${meanError(back, base)} exceeds 1/255`);
    await undoRedo(t, 'redo');
    await until(async () => (await handles(t, area))[2] < flat[2] - 20, 'redo moves the white handle in again');
    await pointAt(t, area, .5, .5, 'double');
    await until(async () => (await handles(t, area)).every((v, i) => Math.abs(v - flat[i]) < 1), 'a double-click resets the handles');
    await pick(t, lv.sel, 'adv:autoscale', /independent/i);
    await until(async () => (await count(t, `${lv.sel} [data-levels-channel]`)) === 3, 'R, G and B tabs for independent channels');
    await t.evidence('levels-channels');

    // 2. Denoise (profiled): the wavelet curves show for the wavelets modes
    const dn = await openCard(t, 'detail', 'denoiseprofile');
    await turnOn(t, dn.sel);
    await pick(t, dn.sel, 'adv:mode', /^non-local means$/i);
    await until(async () => !(await exists(t, `${dn.sel} [data-bands="denoiseprofile"]`)), 'no wavelet curves for non-local means');
    await pick(t, dn.sel, 'adv:mode', /^wavelets$/i);
    await bandsCase(t, dn, 'denoiseprofile', 'denoiseprofile', .001);
  });
}
