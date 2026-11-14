// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from './webdriver.mjs';
import { click, openTool, reveal } from './controls.mjs';
import { panel, choose } from './scenario.mjs';
import { settledPhoto } from '../specs/smoke.mjs';
import { setMode } from '../specs/editing-mode.mjs';
import { addCard } from '../specs/advanced-exposure.mjs';
import { waitSetting } from './settings.mjs';

// What the Advanced cards' cases share: opening a card in its group, reading
// and driving its controls through pointer and keyboard input, and the mode
// bookkeeping (the case starts in whichever editing mode the profile has and
// puts it back).

export const KEY = 'immage.editMode';
export const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
export const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);
export const count = (t, sel) => t.driver.observe(s => document.querySelectorAll(s).length, sel);
export const exists = (t, sel) => t.driver.observe(s => !!document.querySelector(s), sel);

// runs body in Advanced mode with the photo settled, and restores the mode
export async function inAdvanced(t, body) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await body(original);
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}

// adds the card when the group has none, and opens it
export async function openCard(t, group, op) {
  const sel = `[data-panel-id="${group}"] [data-module^="${op}#"]`;
  await panel(t, group);
  const added = await addCard(t, group, op, sel);
  const open = () => t.driver.observe(s => !!document.querySelector(`${s} > .collapse.open`), sel);
  await until(() => exists(t, sel), `${op} card`);
  if (!await open()) await click(t, `${sel} .module-card-head`);
  await until(open, `${op} card open`);
  // the card slides open: let it settle before aiming at its controls
  await until(() => t.driver.observe(() => !document.getAnimations().some(a => a.playState === 'running' && a.effect?.target?.closest?.('.collapse'))), `${op} settled`);
  return { sel, added };
}
export const cardOn = (t, sel) => t.driver.observe(s => document.querySelector(`${s} input.switch`).checked, sel);
export async function turnOn(t, sel) {
  if (!await cardOn(t, sel)) await click(t, `${sel} input.switch`);
  await until(() => cardOn(t, sel), `${sel} on`);
}

export const box = (t, sel) => t.driver.observe(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
export async function pointAt(t, sel, fx, fy, how = 'click') {
  await reveal(t, sel);
  const b = await box(t, sel);
  const x = b.x + b.w * fx, y = b.y + b.h * fy;
  if (how === 'right') await t.driver.rightClick(x, y);
  else await t.driver.point(x, y, how === 'double' ? 2 : 1);
}

// a choice field's options, drawn as a select or as buttons
export async function choice(t, sel, id) {
  return t.driver.observe((s, i) => {
    const e = document.querySelector(`${s} [data-control-id="${i}"]`);
    const select = e?.querySelector('select');
    if (select) return { select: true, current: select.selectedOptions[0]?.textContent.trim(), options: [...select.options].map(o => ({ value: o.value, label: o.textContent.trim() })) };
    return e && { select: false, current: e.querySelector('button.active, button[aria-pressed=true]')?.textContent.trim(), options: [...e.querySelectorAll('button')].map(b => ({ label: b.textContent.trim() })) };
  }, sel, id);
}
export async function pick(t, sel, id, label) {
  const c = await until(() => choice(t, sel, id), `${id} choice`);
  const o = c.options.find(x => label.test(x.label));
  assert(o, `${id} lists ${label}: ${JSON.stringify(c.options)}`);
  if (c.select) await choose(t, `${sel} [data-control-id="${id}"] select`, o.value);
  else await click(t, `${sel} [data-control-id="${id}"] button:nth-of-type(${c.options.indexOf(o) + 1})`);
  return o;
}

// types a value into a slider through its numeric editor (id is the control's full data-control-id)
export async function typeInto(t, sel, id, text) {
  const slider = `${sel} [data-control-id="${id}"]`;
  const v = await reveal(t, `${slider} .value`);
  await t.driver.point(v.x, v.y, 2);
  await until(() => exists(t, `${slider} .value-edit`), `${id} numeric editor`);
  await t.driver.keys(...text, '');
}
export const type = (t, sel, id, text) => typeInto(t, sel, `adv:${id}`, text);
// a slider's readout as a number, and its position
export const readoutOf = (t, sel, controlId) => t.driver.observe((s, i) => {
  const e = document.querySelector(`${s} [data-control-id="${i}"]`);
  const x = e?.querySelector('.value')?.textContent.replace(/[^0-9.\-]/g, '');
  return e && x ? { shown: parseFloat(x), slider: e.querySelector('input[type=range]') ? +e.querySelector('input[type=range]').value : null } : null;
}, sel, controlId);
export const readout = (t, sel, id) => readoutOf(t, sel, `adv:${id}`);

// a card's color button: its hex value, whether it is greyed and its tooltip
export const colorButton = (t, sel, id) => t.driver.observe((s, i) => {
  const b = document.querySelector(`${s} [data-control-id="adv:${i}"] input[type=color]`);
  return b && { value: b.value, disabled: b.disabled, title: b.closest('[data-control-id]').title };
}, sel, id);

// a pointer drag between two fractions of an element's box
export async function dragAt(t, sel, from, to) {
  await reveal(t, sel);
  const b = await box(t, sel);
  await t.driver.drag({ x: b.x + b.w * from[0], y: b.y + b.h * from[1] }, { x: b.x + b.w * to[0], y: b.y + b.h * to[1] });
}
