// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, inspect, openTool, rangeSelector, reveal } from '../support/controls.mjs';
import { expandSections, panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const BASIC = '[data-panel-id="basic"]';
const TM_OPS = ['agx', 'sigmoid', 'filmicrgb', 'basecurve'];
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };

async function typeSlider(t, id, value) {
  const sel = rangeSelector(id);
  const valEl = await reveal(t, `[data-control-id="${id}"] .value`);
  await t.driver.point(valEl.x, valEl.y, 2);
  await until(() => t.driver.observe(i => !!document.querySelector(`[data-control-id="${i}"] .value-edit`), id), `${id} numeric editor`);
  await t.driver.keys(...String(value), '\uE007');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, sel)).value - value) < 1, `${id} typed as ${value}`);
}

const historyOpen = t => t.driver.observe(() => !!document.querySelector('.panel.history .panel-title.open'));
const activeHistoryNames = t => t.driver.observe(() =>
  [...document.querySelectorAll('.panel.history .history-list li:not(:has(.off)) .name')].map(e => e.textContent.trim().toLowerCase()));

// Minimal visible-app check on a JPEG (LDR) fixture:
// - No tone mapper enabled on open; Profile lists None + Color Balance RGB only (no AgX / Load AgX Preset)
// - Contrast & Saturation ModuleSwitch omit AgX; Blacks has no switch (exposure only)
// - Moving Whites & Contrast changes the rendered photo without enabling AgX or Sigmoid
// - Advanced mode disables all four tone mappers in + Add module
export async function tonemapperLdr(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Advanced') await setMode(t, 'Simple');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    await expandSections(t, 'basic');

    // 1. Profile menu on JPEG has only None + Color Balance RGB (no AgX profiles or Load/Delete AgX Preset)
    const profileInfo = await t.driver.observe(() => {
      const sel = document.querySelector('[data-control-id="profile"] select');
      if (!sel) return null;
      const groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
      const options = [...sel.querySelectorAll('option')].map(o => ({ value: Number(o.value), label: o.textContent.trim() }));
      return { value: Number(sel.value), groups, options };
    });
    assert(profileInfo, 'Profile select exists');
    assert.equal(profileInfo.value, 0, 'JPEG Profile starts at None (0)');
    assert(!profileInfo.groups.includes('AgX'), `JPEG Profile must not list AgX group: ${JSON.stringify(profileInfo.groups)}`);
    assert(!profileInfo.options.some(o => o.value < 0 || o.value >= 11), `JPEG Profile must not list AgX or preset options: ${JSON.stringify(profileInfo.options)}`);
    t.measure({ name: 'jpeg-profile', groups: profileInfo.groups, count: profileInfo.options.length });

    // 2. ModuleSwitch on Contrast/Saturation omits AgX; Blacks has no switch
    const blacksHasSwitch = await t.driver.observe(() => !!document.querySelector('[data-control-id="blacks"] [data-module-switch]'));
    assert.equal(blacksHasSwitch, false, 'Blacks on JPEG has no ModuleSwitch (exposure only)');
    await click(t, '[data-control-id="contrast"] [data-module-switch="contrast"]');
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-module-option]')), 'Contrast module menu');
    const contrastOpts = await t.driver.observe(() => [...document.querySelectorAll('.context-menu [data-module-option]')]
      .map(o => ({ value: Number(o.getAttribute('data-module-option')), name: o.querySelector('.name')?.textContent.trim() })));
    assert(!contrastOpts.some(o => o.value === 0), `Contrast switch on JPEG must omit AgX: ${JSON.stringify(contrastOpts)}`);
    await t.driver.keys('\uE00C'); // Escape closes menu
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu closed');
    t.measure({ name: 'jpeg-contrast-modules', options: contrastOpts });

    // 3. Moving Whites (+50) and Contrast (+30) renders visibly without enabling any tone mapper
    const before = await settledPhoto(t);
    await typeSlider(t, 'whites', 50);
    await typeSlider(t, 'contrast', 30);
    const after = await settledPhoto(t, p => meanError(p, before) > 1);
    const err = meanError(after, before);
    assert(err > 1, `Whites + Contrast on JPEG changed photo by only ${err}/255`);
    if (!(await historyOpen(t))) {
      await click(t, '.panel.history .panel-title');
      await until(() => historyOpen(t), 'History panel open');
    }
    const hist = await activeHistoryNames(t);
    assert(!hist.some(n => /\b(agx|sigmoid|filmic|base curve)\b/.test(n)), `No tone mapper may be active in JPEG History: ${JSON.stringify(hist)}`);
    t.measure({ name: 'jpeg-simple-edit', meanAbsoluteError: err, history: hist });
    await t.evidence('tonemapper-ldr-simple');

    // 4. Advanced mode disables all four tone mappers in + Add module
    await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    await click(t, `${BASIC} .add-module-button`);
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-add-module]')), 'Add module menu');
    const tmStates = await t.driver.observe(ops => ops.map(op => {
      const b = document.querySelector(`.context-menu [data-add-module="${op}"]`);
      return { op, present: !!b, disabled: !!b?.disabled, title: b?.getAttribute('title') ?? '' };
    }), TM_OPS);
    for (const s of tmStates) {
      assert(s.present, `${s.op} listed in Basic Add module`);
      assert.equal(s.disabled, true, `${s.op} must be disabled on JPEG in Advanced mode`);
    }
    t.measure({ name: 'jpeg-advanced-add-module', tmStates });
    await t.evidence('tonemapper-ldr-advanced');
    await t.driver.keys('\uE00C');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* report main error */ }
  }
}

// Minimal visible-app check on a RAW fixture:
// - AgX starts on in Simple & Advanced mode
// - Duplicating active AgX in Advanced mode opens the Multiple tone mappers pop-up warning
// - Cancel dismisses cleanly leaving only AgX enabled
// - FamilySwitch switches cleanly to Sigmoid with no warning modal and visible pixel change
export async function tonemapperRawGuard(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    const cards = () => t.driver.observe((basic, ops) => ops.flatMap(op =>
      [...document.querySelectorAll(`${basic} [data-module^="${op}#"]`)].map(c => ({
        op, on: !!c.querySelector('input.switch')?.checked,
      }))), BASIC, TM_OPS);
    const initial = await until(async () => {
      const list = await cards();
      return list.length ? list : false;
    }, 'tone mapper card on RAW');
    assert.equal(initial.length, 1, `RAW starts with one tone mapper card: ${JSON.stringify(initial)}`);
    assert.equal(initial[0].on, true, `RAW starts with tone mapper enabled: ${JSON.stringify(initial)}`);
    const active = initial[0].op;
    const other = active === 'agx' ? 'sigmoid' : 'agx';
    t.measure({ name: 'raw-initial-tm', op: active, on: initial[0].on });
    const before = await settledPhoto(t);

    // 1. Trigger pop-up warning by duplicating active tone mapper
    await click(t, `${BASIC} [data-module^="${active}#"] .instance-menu .module-card-menu`);
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-instance-action="duplicate"]')), 'instance menu');
    await click(t, '.context-menu [data-instance-action="duplicate"]');
    const warning = await until(() => t.driver.observe(() => {
      const w = document.querySelector('[data-tonemapper-warning]');
      if (!w) return false;
      return {
        title: w.querySelector('h2')?.textContent.trim(),
        body: w.querySelector('.modal-body')?.textContent.trim(),
        buttons: [...w.querySelectorAll('.modal-foot button')].map(b => b.textContent.trim()),
      };
    }), 'Multiple tone mappers warning modal');
    assert.equal(warning.buttons.length, 3, `warning has Cancel, Enable anyway and Switch: ${JSON.stringify(warning.buttons)}`);
    t.measure({ name: 'raw-warning-modal', ...warning });
    await t.evidence('tonemapper-raw-warning');

    // 2. Cancel closes modal and keeps single tone mapper card
    await click(t, '[data-tonemapper-warning] .modal-foot button:first-child');
    await until(() => t.driver.observe(() => !document.querySelector('[data-tonemapper-warning]')), 'warning closed');
    const afterCancel = await cards();
    assert.equal(afterCancel.filter(c => c.on).length, 1, `only one tone mapper on after cancel: ${JSON.stringify(afterCancel)}`);

    // 3. FamilySwitch swaps cleanly to the other tone mapper without warning modal
    await click(t, `${BASIC} [data-module^="${active}#"] .module-switch-btn`);
    await until(() => t.driver.observe(op => !!document.querySelector(`.context-menu [data-family-option="${op}"]`), other), 'family menu');
    await click(t, `.context-menu [data-family-option="${other}"]`);
    await until(() => t.driver.observe((basic, op) => !!document.querySelector(`${basic} [data-module^="${op}#"] input.switch:checked`), BASIC, other), `${other} card active`);
    assert.equal(await t.driver.observe(() => !!document.querySelector('[data-tonemapper-warning]')), false, 'FamilySwitch does not trigger duplicate warning');
    const swapped = await settledPhoto(t, p => meanError(p, before) > 0.25);
    t.measure({ name: 'raw-family-switch', from: active, to: other, meanAbsoluteError: meanError(swapped, before) });
    await t.evidence('tonemapper-raw-switched');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* report main error */ }
  }
}
