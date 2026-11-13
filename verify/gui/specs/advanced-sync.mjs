// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel, textButton, Blocked } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { addCard } from './advanced-exposure.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const TARGET = 'advanced-target.jpg';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);
const cell = name => `.filmstrip .thumb[title=${JSON.stringify(name)}]`;
const LOWPASS = '[data-panel-id="detail"] [data-module^="lowpass#"]';
const CB = '[data-panel-id="colorgrading"] [data-module^="colorbalancergb#"]';

// a card's controls, by field path
const controls = (t, sel) => t.driver.observe(s => {
  const c = document.querySelector(s);
  return c && Object.fromEntries([...c.querySelectorAll('[data-control-id^="adv:"]')].map(e =>
    [e.getAttribute('data-control-id').slice(4), e.querySelector('input[type=range]') ? +e.querySelector('input[type=range]').value : null]));
}, sel);
// Simple's badge in a group: its count, or null when the group shows none
const badge = (t, group) => t.driver.observe(g => {
  const b = document.querySelector(`[data-panel-id="${g}"] [data-advanced-edits]`);
  return b ? { count: +b.getAttribute('data-advanced-edits'), text: b.textContent.trim() } : null;
}, group);
const lowpassCards = t => t.driver.observe(s => document.querySelectorAll(s).length, LOWPASS);

async function copyAdvanced(t) {
  await click(t, '[data-action="copy-settings"]');
  await textButton(t, '.copy-settings', 'Check None');
  await click(t, '[data-copy-group="advanced"]');
  const ticked = await t.driver.observe(() => [...document.querySelectorAll('.copy-settings [data-copy-group]:checked')].map(e => e.getAttribute('data-copy-group')));
  assert.deepEqual(ticked, ['advanced'], `only Advanced modules ticked: ${ticked}`);
  await t.evidence('copy-advanced');
  await textButton(t, '.copy-settings .modal-foot', 'Copy');
  await until(() => t.driver.observe(() => !document.querySelector('.copy-settings')), 'Copy Settings closed');
}
async function paste(t) {
  await click(t, '[data-action="paste-settings"]');
  await until(() => t.driver.observe(() => !document.querySelector('[data-batch-paste="busy"]')), 'paste completed', 120000);
  return settledPhoto(t);
}

export async function advancedSync(t) {
  if (t.fixture.raw) throw new Blocked('advanced-sync needs the isolated JPEG fixture');
  await until(() => t.driver.observe(s => !!document.querySelector(s), cell(TARGET)), `imported ${TARGET}`, 60000);
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');

    // 1. color balance rgb's 4 ways: a click on the global wheel sets its hue
    // and chroma sliders together and tints the photo; undo returns it
    await panel(t, 'colorgrading');
    await addCard(t, 'colorgrading', 'colorbalancergb', CB);
    const head = await t.driver.observe(s => !!document.querySelector(`${s} > .collapse.open`), CB);
    if (!head) await click(t, `${CB} .module-card-head`);
    const wheel = `${CB} [data-wheel="global_H"] .wheel`;
    await until(() => t.driver.observe(s => !!document.querySelector(s), wheel), 'global wheel on the 4 ways tab');
    const plain = await settledPhoto(t);
    const before = await controls(t, CB);
    const w = await reveal(t, wheel);
    const box = await t.driver.observe(s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, wheel);
    // to the right of the center, 60% out: hue 0, chroma 60% of the slider
    await t.driver.point(box.x + box.w / 2 + box.w * .3, box.y + box.h / 2);
    const set = await until(async () => { const c = await controls(t, CB); return c.global_C > before.global_C + 1e-4 && c; }, 'global chroma set from the wheel');
    t.measure({ name: 'wheel-click', wheel: w, before: { H: before.global_H, C: before.global_C }, after: { H: set.global_H, C: set.global_C } });
    assert(set.global_H < 10 || set.global_H > 350, `a click right of center sets hue near 0: ${set.global_H}`);
    const tinted = await settledPhoto(t, p => meanError(p, plain) > .5);
    t.measure({ name: 'wheel-tint', meanAbsoluteError: meanError(tinted, plain) });
    await t.evidence('wheel-global');
    await undoRedo(t, 'undo');
    const untinted = await settledPhoto(t, p => meanError(p, plain) < 1);
    assert(meanError(untinted, plain) < 1, `undo of the wheel: photo mean pixel error ${meanError(untinted, plain)} exceeds 1/255`);

    // 2. an Advanced-only edit: lowpass, which no Simple slider shows
    await panel(t, 'detail');
    const added = await addCard(t, 'detail', 'lowpass', LOWPASS);
    assert(added, 'the photo starts without lowpass');
    const soft = await settledPhoto(t, p => meanError(p, plain) > .5);
    t.measure({ name: 'lowpass-added', meanAbsoluteError: meanError(soft, plain) });

    // 3. Simple: the Detail group counts it; the badge opens Preferences
    await setMode(t, 'Simple');
    await openTool(t, 'adjust');
    await panel(t, 'detail');
    const b = await until(async () => { const x = await badge(t, 'detail'); return x?.count === 1 && x; }, 'Detail badge counts one edit');
    assert.match(b.text, /1 advanced edit\b/, `badge text: ${b.text}`);
    const others = await t.driver.observe(() => [...document.querySelectorAll('[data-advanced-edits]')]
      .map(e => e.closest('[data-panel-id]')?.getAttribute('data-panel-id')).filter(g => g !== 'detail'));
    assert.deepEqual(others, [], `no other group shows a badge: ${others}`);
    t.measure({ name: 'badge', badge: b });
    await t.evidence('badge-detail');
    await click(t, '[data-panel-id="detail"] [data-advanced-edits]');
    await until(() => t.driver.observe(() => !!document.querySelector('[data-pref-label="Editing mode"]')), 'the badge opens Editing mode');
    await t.evidence('badge-prefs');
    await click(t, '.prefs-foot button');
    await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');

    // 4. Copy Settings' Advanced modules: the target photo gets the lowpass,
    // and its badge counts it
    await copyAdvanced(t);
    await click(t, cell(TARGET));
    const fresh = await settledPhoto(t);
    assert.equal(await badge(t, 'detail'), null, 'the target starts without a badge');
    const pasted = await paste(t);
    t.measure({ name: 'paste', meanAbsoluteError: meanError(pasted, fresh) });
    assert(meanError(pasted, fresh) > .5, `paste changed the photo: mean error ${meanError(pasted, fresh)}`);
    await until(async () => (await badge(t, 'detail'))?.count === 1, 'target Detail badge counts the pasted lowpass');
    await t.evidence('paste-target');

    // 5. pasting again replaces that instance: still one lowpass, same photo
    const again = await paste(t);
    t.measure({ name: 'paste-again', meanAbsoluteError: meanError(again, pasted) });
    assert(meanError(again, pasted) < 1, `a second paste changed the photo: ${meanError(again, pasted)}`);
    assert.equal((await badge(t, 'detail'))?.count, 1, 'a second paste adds no instance');
    await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'detail');
    assert.equal(await until(async () => { const n = await lowpassCards(t); return n > 0 && n; }, 'lowpass card on the target'), 1, 'one lowpass card after two pastes');
    await t.evidence('sync-done');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
