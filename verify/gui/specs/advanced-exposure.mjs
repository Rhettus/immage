// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';
import * as read from '../support/observations.mjs';

const KEY = 'immage.editMode';
const CARD = '[data-panel-id="basic"] [data-module^="exposure#"]';
const SLIDER = `${CARD} [data-control-id="adv:exposure"]`;
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const summary = ({ rgba, ...rest }) => rest;

// the card's state as the page shows it
const card = t => t.driver.observe((sel, slider) => {
  const c = document.querySelector(sel);
  if (!c) return null;
  const range = c.querySelector(`${slider} input[type=range]`);
  return {
    on: c.querySelector('input.switch').checked,
    title: c.querySelector('.module-card-title')?.textContent.trim(),
    open: !!c.querySelector(':scope > .collapse.open'),
    value: range ? +range.value : null,
    displayed: c.querySelector(`${slider} .value`)?.textContent ?? null,
    reset: !!c.querySelector('.module-card-reset'),
  };
}, CARD, SLIDER);

const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);

// waits for a module's card in a group, adding it from + Add module when the
// group settles without it; true when it had to be added
export async function addCard(t, group, op, sel) {
  const where = await until(() => t.driver.observe((g, s) =>
    document.querySelector(s) ? 'card' : document.querySelector(`[data-panel-id="${g}"] .add-module-button`) ? 'add' : false,
  group, sel), `${op} card or Add module in ${group}`);
  if (where === 'card') return false;
  await click(t, `[data-panel-id="${group}"] .add-module-button`);
  await until(() => t.driver.observe(o => !!document.querySelector(`.context-menu [data-add-module="${o}"]`), op), 'Add module menu');
  await click(t, `.context-menu [data-add-module="${op}"]`);
  await until(() => t.driver.observe(s => !!document.querySelector(s), sel), `${op} card after Add module`);
  return true;
}

export async function advancedExposure(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    const baseline = await settledPhoto(t);

    // 1. the Basic group holds an Exposure card, whatever its switch says;
    // a photo that leaves exposure off and untouched has none until Add module
    await panel(t, 'basic');
    const added = await addCard(t, 'basic', 'exposure', CARD);
    t.measure({ name: 'add-module', used: added });
    const initial = await until(async () => { const c = await card(t); return c?.title ? c : false; }, 'Exposure card in the Basic group');
    assert.equal(initial.title, 'Exposure', 'the card is titled Exposure');
    assert(initial.reset, 'the card has a reset button');
    t.measure({ name: 'initial-card', on: initial.on, open: initial.open, value: initial.value });
    await t.evidence('card-initial');

    // 2. unfold, type +1 EV: the switch comes on and the frame brightens
    if (!initial.open) await click(t, `${CARD} .module-card-head .module-card-title`);
    await until(async () => (await card(t))?.open && (await card(t)).value !== null, 'Exposure card unfolded with its slider');
    const neutral = (await card(t)).value;
    const value = await reveal(t, `${SLIDER} .value`);
    await t.driver.point(value.x, value.y, 2);
    await until(() => t.driver.observe(s => !!document.querySelector(`${s} .value-edit`), SLIDER), 'numeric editor');
    await t.driver.keys('1', ''); // Enter
    const edited = await until(async () => { const c = await card(t); return Math.abs(c.value - 1) < .02 && c; }, 'Exposure typed as +1 EV');
    assert(edited.on, 'the card switch is on after setting Exposure');
    const bright = await settledPhoto(t, p => p.hash !== baseline.hash && p.luma > baseline.luma + 2);
    t.measure({ name: 'plus-one-ev', card: edited, photo: summary(bright), neutral });
    await t.evidence('card-plus-one');

    // 3. undo: the value and the frame return
    await undoRedo(t, 'undo');
    const undone = await until(async () => { const c = await card(t); return Math.abs(c.value - neutral) < .02 && c; }, 'undo returns the Exposure value');
    const afterUndo = await settledPhoto(t, p => meanError(p, baseline) < 1);
    const undoError = meanError(afterUndo, baseline);
    t.measure({ name: 'undo', card: undone, meanAbsoluteError: undoError });
    assert(undoError < 1, `undo: photo mean pixel error ${undoError} exceeds 1/255`);
    await t.evidence('card-undone');

    // 4. redo brings +1 EV back; reset returns darktable's defaults for the
    // whole module, which need not be the photo as it opened: a raw opened
    // with Immage's new-photos defaults differs in other exposure fields
    await undoRedo(t, 'redo');
    await until(async () => Math.abs((await card(t)).value - 1) < .02, 'redo returns +1 EV');
    const redone = await settledPhoto(t, p => p.hash !== baseline.hash && p.luma > baseline.luma + 2);
    await click(t, `${CARD} .module-card-reset`);
    const reset = await until(async () => { const c = await card(t); return Math.abs(c.value - neutral) < .02 && c; }, 'reset returns the default Exposure');
    assert(reset.on, 'reset leaves the module on, as darktable does');
    const afterReset = await settledPhoto(t, p => p.hash !== redone.hash && p.luma < redone.luma - 2);
    t.measure({ name: 'reset', card: reset, meanAbsoluteErrorToOpened: meanError(afterReset, baseline) });
    await t.evidence('card-reset');

    // 5. back to Simple: switching changes nothing in the photo
    await setMode(t, 'Simple');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    await reveal(t, '[data-control-id="exposure"] label');
    const simple = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && s; }, 'Simple Exposure slider');
    assert(!await t.driver.observe(() => document.querySelector('.module-card, .advanced-search')), 'Simple shows no module cards or search');
    const photoSimple = await settledPhoto(t);
    const simpleError = meanError(photoSimple, afterReset);
    t.measure({ name: 'simple-again', exposure: simple.value, meanAbsoluteError: simpleError });
    assert(simpleError < 1, `Simple again: photo mean pixel error ${simpleError} exceeds 1/255`);
    await t.evidence('simple-after');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
