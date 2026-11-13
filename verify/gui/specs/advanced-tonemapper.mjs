// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { addCard } from './advanced-exposure.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const OPS = ['agx', 'sigmoid', 'filmicrgb', 'basecurve'];
const BASIC = '[data-panel-id="basic"]';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);

// the tone mapper cards the Basic group shows
const cards = t => t.driver.observe((basic, ops) => {
  const out = [];
  for (const op of ops) for (const c of document.querySelectorAll(`${basic} [data-module^="${op}#"]`))
    out.push({ op, title: c.querySelector('.module-card-title')?.textContent.trim(), on: !!c.querySelector('input.switch')?.checked });
  return out;
}, BASIC, OPS);

export async function advancedTonemapper(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    // a photo with no tone mapper on shows none until one is added
    let list = await until(async () => { const l = await cards(t); return l.length ? l : (await t.driver.observe(b => !!document.querySelector(`${b} .add-module-button`), BASIC)) && l; }, 'tone mapper card or Add module');
    let added = false;
    if (!list.length) {
      added = await addCard(t, 'basic', 'agx', `${BASIC} [data-module^="agx#"]`);
      list = await until(async () => { const l = await cards(t); return l.length && l; }, 'tone mapper card after Add module');
    }
    assert.equal(list.length, 1, `exactly one tone mapper card, found ${JSON.stringify(list)}`);
    const first = list[0];
    t.measure({ name: 'initial-card', op: first.op, title: first.title, on: first.on, added });
    await t.evidence('tonemapper-initial');
    const before = await settledPhoto(t);

    // 1. the switch menu lists the family with the current one checked
    const target = first.op === 'sigmoid' ? 'agx' : 'sigmoid';
    const open = async () => {
      await click(t, `${BASIC} [data-module^="${first.op}#"] .module-switch-btn`);
      await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-family-option]')), 'tone mapper menu');
    };
    await open();
    const menu = await t.driver.observe(() => [...document.querySelectorAll('.context-menu [data-family-option]')]
      .map(o => ({ op: o.getAttribute('data-family-option'), checked: o.getAttribute('aria-checked') === 'true' })));
    assert.equal(menu.find(o => o.checked)?.op, first.op, 'the current tone mapper is checked');
    assert(menu.some(o => o.op === target), `the menu offers ${target}`);
    t.measure({ name: 'switch-menu', menu });
    await t.evidence('tonemapper-menu');

    // 2. picking another switches the card and changes the photo
    await click(t, `.context-menu [data-family-option="${target}"]`);
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu closed');
    const switched = await until(async () => { const l = await cards(t); return l.length === 1 && l[0].op === target && l; }, `only the ${target} card remains`);
    assert.equal(switched[0].on, true, `the ${target} switch is on`);
    const changed = await settledPhoto(t, p => meanError(p, before) > 1);
    const changeError = meanError(changed, before);
    t.measure({ name: 'switched', op: target, title: switched[0].title, meanAbsoluteError: changeError });
    assert(changeError > 1, `switching tone mapper: photo mean pixel error ${changeError} is not above 1/255`);
    await t.evidence('tonemapper-switched');

    // 3. undo: the original card and frame return
    await undoRedo(t, 'undo');
    await until(async () => { const l = await cards(t); return l.length === 1 && l[0].op === first.op && l; }, `undo returns the ${first.op} card`);
    const afterUndo = await settledPhoto(t, p => meanError(p, before) < 1);
    const undoError = meanError(afterUndo, before);
    t.measure({ name: 'undo', op: first.op, meanAbsoluteError: undoError });
    assert(undoError < 1, `undo: photo mean pixel error ${undoError} exceeds 1/255`);
    await t.evidence('tonemapper-undone');

    // 4. redo switches again; undo once more leaves the photo as it started
    await undoRedo(t, 'redo');
    await until(async () => { const l = await cards(t); return l.length === 1 && l[0].op === target && l; }, `redo returns the ${target} card`);
    await settledPhoto(t, p => meanError(p, before) > 1);
    await undoRedo(t, 'undo');
    await until(async () => { const l = await cards(t); return l.length === 1 && l[0].op === first.op && l; }, `second undo returns the ${first.op} card`);
    const restored = await settledPhoto(t, p => meanError(p, before) < 1);
    const restoredError = meanError(restored, before);
    t.measure({ name: 'restored', meanAbsoluteError: restoredError });
    assert(restoredError < 1, `restore: photo mean pixel error ${restoredError} exceeds 1/255`);
    await t.evidence('tonemapper-restored');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
