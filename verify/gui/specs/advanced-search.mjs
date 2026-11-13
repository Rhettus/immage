// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const BASIC = '[data-panel-id="basic"]';
const TONE_OPS = ['agx', 'sigmoid', 'filmicrgb', 'basecurve'];
const BOX = '.advanced-search input';
const ENTER = '\uE007', ESCAPE = '\uE00C', DOWN = '\uE015', UP = '\uE013';
const undo = t => click(t, 'button.tool[title^="undo ("]');

// the search rows now: op, active, disabled and text, or null with the list closed
const rows = t => t.driver.observe(() => {
  const list = document.querySelector('.advanced-search-results');
  return list ? [...list.querySelectorAll('[data-search-hit]')].map(b => ({
    op: b.getAttribute('data-search-hit'), active: b.classList.contains('active'), disabled: b.disabled, text: b.textContent.trim(),
  })) : null;
});
const boxState = t => t.driver.observe(() => ({ value: document.querySelector('.advanced-search input').value, list: !!document.querySelector('.advanced-search-results') }));
// type a query into an empty box and wait for the list
async function search(t, query) {
  await click(t, BOX);
  await t.driver.keys(...query);
  await until(() => t.driver.observe(q => document.querySelector('.advanced-search input').value === q, query), `box holds ${query}`);
  return until(async () => (await rows(t)) || false, `search list for ${query}`);
}
// a card in a group: present, flashing (`fresh`) and open
const cardState = (t, group, op) => t.driver.observe((g, o) => {
  const c = document.querySelector(`[data-panel-id="${g}"] [data-module^="${o}#"]`);
  return {
    panelOpen: !!document.querySelector(`[data-panel-id="${g}"] > .panel-title.open`),
    card: !!c, fresh: !!c?.classList.contains('fresh'), open: !!c?.querySelector('.collapse.open'),
  };
}, group, op);
// the tone mapper cards the Basic group shows
const toneCards = t => t.driver.observe((basic, ops) => ops.flatMap(op =>
  [...document.querySelectorAll(`${basic} [data-module^="${op}#"]`)].map(c => ({ op, title: c.querySelector('.module-card-title')?.textContent.trim() }))), BASIC, TONE_OPS);

export async function advancedSearch(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    // typing "lowpass" lists the module; picking it opens Detail and shows its card
    await click(t, '.advanced-search input');
    await t.driver.keys('lowpass');
    await until(() => t.driver.observe(() => !!document.querySelector('[data-search-hit="lowpass"]:not(:disabled)')), 'lowpass search hit');
    await click(t, '[data-search-hit="lowpass"]');
    const title = await until(() => t.driver.observe(() =>
      document.querySelector('[data-panel-id="detail"] [data-module^="lowpass#"] .module-card-title')?.textContent.trim() || false),
      'Lowpass card in Detail');
    assert.match(title, /lowpass/i);
    const cleared = await t.driver.observe(() => document.querySelector('.advanced-search input').value === '' && !document.querySelector('.advanced-search-results'));
    assert(cleared, 'the box clears and the list closes after a pick');
    await t.evidence('advanced-search-lowpass');

    // 1. keys: ArrowDown moves the active row, ArrowUp returns, Enter picks the active one
    await panel(t, 'basic');
    let list = await search(t, 'ex');
    const enabled = list.filter(r => !r.disabled);
    assert(enabled.length >= 2, `"ex" lists at least two enabled hits, got ${JSON.stringify(list)}`);
    assert.equal(list.findIndex(r => r.active), 0, 'the first row starts active');
    assert.equal(list[0].op, 'exposure', 'the first "ex" hit is Basic Exposure (title matches come first)');
    await t.driver.keys(DOWN);
    list = await until(async () => { const l = await rows(t); return l && l.findIndex(r => r.active) > 0 && l; }, 'ArrowDown moves the active row');
    t.measure({ name: 'arrow-down', active: list.find(r => r.active).op });
    assert(!list.find(r => r.active).disabled, 'ArrowDown never lands on a disabled row');
    await t.evidence('advanced-search-keys');
    await t.driver.keys(UP);
    await until(async () => { const l = await rows(t); return l && l.findIndex(r => r.active) === 0; }, 'ArrowUp returns to the first row');
    await t.driver.keys(ENTER);
    await until(async () => { const b = await boxState(t); return !b.list && b.value === '' && b; }, 'Enter picks the row and clears the box');
    let c = await until(async () => { const s = await cardState(t, 'basic', 'exposure'); return s.fresh && s; }, 'Enter flashes the Exposure card');
    assert(c.panelOpen && c.open, `Enter opens Basic and the card: ${JSON.stringify(c)}`);

    // 2. Escape clears the box and closes the list
    list = await search(t, 'ex');
    assert(list.length > 0, 'the list is open before Escape');
    await t.driver.keys(ESCAPE);
    const gone = await until(async () => { const b = await boxState(t); return b.value === '' && !b.list && b; }, 'Escape clears the box and closes the list');
    t.measure({ name: 'escape', ...gone });

    // 3. a card the photo has: with Basic folded, picking its hit opens Basic, opens the card and flashes it
    await until(() => t.driver.observe(() => !document.querySelector('[data-panel-id="basic"] [data-module^="exposure#"].fresh')), 'earlier flash over', 6000);
    await click(t, `${BASIC} > .panel-title`);
    await until(() => t.driver.observe(() => !document.querySelector('[data-panel-id="basic"] > .panel-title.open')), 'Basic folded');
    await search(t, 'exposure');
    await click(t, '[data-search-hit="exposure"]:not(:disabled)');
    c = await until(async () => { const s = await cardState(t, 'basic', 'exposure'); return s.panelOpen && s.fresh && s; }, 'Exposure card flashes in Basic');
    assert(c.card && c.open, `the Exposure card is open: ${JSON.stringify(c)}`);
    await t.evidence('advanced-search-exposure');

    // 4. tone mapper: picking another family member switches the shared card; undo returns it
    await panel(t, 'basic');
    const before = await until(async () => { const l = await toneCards(t); return l.length && l; }, 'a tone mapper card in Basic');
    assert.equal(before.length, 1, `one shared tone mapper card, found ${JSON.stringify(before)}`);
    const first = before[0].op, target = first === 'sigmoid' ? 'agx' : 'sigmoid';
    t.measure({ name: 'tonemapper-before', op: first, title: before[0].title, target });
    list = await search(t, target === 'agx' ? 'agx' : 'sigmoid');
    const hit = list.find(r => r.op === target);
    assert(hit && !hit.disabled, `the ${target} hit is listed and enabled: ${JSON.stringify(list)}`);
    await click(t, `[data-search-hit="${target}"]:not(:disabled)`);
    const switched = await until(async () => { const l = await toneCards(t); return l.length === 1 && l[0].op === target && l; }, `the shared card now shows ${target}`);
    t.measure({ name: 'tonemapper-switched', op: target, title: switched[0].title });
    await t.evidence('advanced-search-tonemapper');
    await undo(t);
    await until(async () => { const l = await toneCards(t); return l.length === 1 && l[0].op === first && l; }, `undo returns the ${first} card`);

    // 5. a setting match: a label with no title match lists its module with the setting
    list = await search(t, 'soften');
    const byLabel = list.find(r => r.op === 'lowpass');
    assert(byLabel && /Lowpass/.test(byLabel.text) && /Soften with/.test(byLabel.text), `a row shows Lowpass with the setting: ${JSON.stringify(list)}`);
    await t.evidence('advanced-search-setting');
    await t.driver.keys(ESCAPE);
    await until(async () => !(await boxState(t)).list, 'list closed after Escape');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
