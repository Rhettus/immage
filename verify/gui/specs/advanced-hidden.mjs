// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { Blocked, panel, textButton } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const MODE = 'immage.editMode';
const HIDDEN = 'immage.hiddenModules';
const BOX = '.advanced-search input';
const FOLD = 'button.module-prefs-fold[aria-controls="module-prefs-advanced"]';
const ESCAPE = '';

const list = v => { try { const l = JSON.parse(v ?? '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
const hiddenNow = (t, ok, label) => waitSetting(t, HIDDEN, v => ok(list(v)), label).then(list);

// Preferences > Modules with the Advanced modules fold open and the filter empty
async function openModules(t) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Modules');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Modules tab');
  await t.driver.point(tab.x, tab.y);
  await until(() => t.driver.observe(f => !!document.querySelector(f), FOLD), 'Advanced modules fold');
  if (await t.driver.observe(f => document.querySelector(f).getAttribute('aria-expanded') !== 'true', FOLD)) await click(t, FOLD);
  await until(() => t.driver.observe(() => !!document.querySelector('#module-prefs-advanced .module-prefs-tools input[type=search]')), 'Advanced modules open');
}
async function closePrefs(t) {
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
  await openTool(t, 'adjust');
}
async function filter(t, text) {
  await click(t, '#module-prefs-advanced .module-prefs-tools input[type=search]');
  await t.driver.keys(...text);
  await until(() => t.driver.observe(x => document.querySelector('#module-prefs-advanced .module-prefs-tools input[type=search]').value === x, text), `filter holds ${text}`);
}
const rowSwitch = label => `#module-prefs-advanced [data-pref-label=${JSON.stringify(label)}] input.switch`;
const rowOn = (t, label) => until(() => t.driver.observe(s => document.querySelector(s)?.checked ?? null, rowSwitch(label)).then(v => v === null ? false : { v }), `${label} row`).then(b => b.v);
async function toggleRow(t, label, want) {
  assert.notEqual(await rowOn(t, label), want, `${label} starts ${want ? 'off' : 'on'}`);
  await click(t, rowSwitch(label));
  await until(async () => (await rowOn(t, label)) === want, `${label} switch ${want ? 'on' : 'off'}`);
}
// the search rows for a query (empty when no list), then the box is cleared again
async function hits(t, query) {
  await click(t, BOX);
  await t.driver.keys(...query);
  await until(() => t.driver.observe(q => document.querySelector('.advanced-search input').value === q, query), `box holds ${query}`);
  const found = await t.driver.observe(() => [...document.querySelectorAll('.advanced-search-results [data-search-hit]')]
    .map(b => ({ op: b.getAttribute('data-search-hit'), text: b.textContent.trim() })));
  await t.driver.keys(ESCAPE);
  await until(() => t.driver.observe(() => document.querySelector('.advanced-search input').value === '' && !document.querySelector('.advanced-search-results')), 'search cleared');
  return found;
}
// Show all in every group, with the filter empty: one card per group, a Show all in each
async function showEverything(t) {
  const n = await t.driver.observe(() => document.querySelectorAll('#module-prefs-advanced section.pref-card').length);
  for (let k = 1; k <= n; k++) await click(t, `#module-prefs-advanced section.pref-card:nth-of-type(${k}) .module-prefs-bulk button:first-child`);
}

export async function advancedHidden(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalMode = await waitSetting(t, MODE, () => true, 'settings file readable');
  const original = originalMode === 'advanced' ? 'Advanced' : 'Simple';
  // restoring goes through Show all in every group, so it only fits a profile that starts with nothing hidden
  const originalHidden = await waitSetting(t, HIDDEN, () => true, 'settings file readable');
  if (list(originalHidden).length) throw new Blocked(`immage.hiddenModules starts non-empty (${originalHidden}); the case restores by showing everything`);
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    // a module that is not hidden is found: the later "gone" checks are not vacuous
    assert((await hits(t, 'bloom')).some(h => h.op === 'bloom'), 'bloom is found before anything is hidden');

    // 1. hide Lowpass in Detail: it leaves search and Add module
    await openModules(t);
    await filter(t, 'lowpass');
    await toggleRow(t, 'Lowpass', false);
    await t.evidence('advanced-hidden-prefs');
    await closePrefs(t);
    assert((await hiddenNow(t, l => l.includes('detail:lowpass'), 'detail:lowpass stored')).includes('detail:lowpass'));
    const lowpass = await hits(t, 'lowpass');
    assert(!lowpass.some(h => h.op === 'lowpass'), `no Lowpass hit once hidden: ${JSON.stringify(lowpass)}`);
    await panel(t, 'detail');
    await click(t, '[data-panel-id="detail"] .add-module-button');
    await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-add-module]')), 'Detail Add module menu');
    const offered = await t.driver.observe(() => [...document.querySelectorAll('.context-menu [data-add-module]')].map(b => b.getAttribute('data-add-module')));
    t.measure({ name: 'detail-add-module', offered });
    assert(offered.length > 0 && !offered.includes('lowpass'), `Add module lists Detail modules but not lowpass: ${JSON.stringify(offered)}`);
    await t.driver.keys(ESCAPE);
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu [data-add-module]')), 'Add module menu closed');

    // 2. hidden but used: the photo has an Exposure card, so it stays, tagged hidden
    await openModules(t);
    await filter(t, 'exposure');
    await toggleRow(t, 'Exposure', false);
    await closePrefs(t);
    await hiddenNow(t, l => l.includes('basic:exposure'), 'basic:exposure stored');
    await panel(t, 'basic');
    const tag = await until(() => t.driver.observe(() => document.querySelector('[data-panel-id="basic"] [data-module^="exposure#"] .module-card-tag')?.textContent.trim() || false), 'hidden tag on the Exposure card');
    assert.equal(tag, 'hidden', 'the Exposure card carries the hidden tag');
    assert(!(await hits(t, 'exposure')).some(h => h.op === 'exposure'), 'hidden Exposure is not offered by search');
    await t.evidence('advanced-hidden-tag');

    // 3. Essentials only: bloom goes, exposure (essential) stays, the tag on Exposure clears
    await openModules(t);
    await textButton(t, '#module-prefs-advanced .module-prefs-tools:has(input[type=search])', 'Essentials only');
    await closePrefs(t);
    const essential = await hiddenNow(t, l => l.includes('effects:bloom') && !l.includes('basic:exposure'), 'Essentials only stored');
    t.measure({ name: 'essentials-hidden-count', count: essential.length });
    assert(!(await hits(t, 'bloom')).some(h => h.op === 'bloom'), 'bloom is hidden by Essentials only');
    assert(!(await hits(t, 'lowpass')).some(h => h.op === 'lowpass'), 'lowpass is hidden by Essentials only');
    assert((await hits(t, 'exposure')).some(h => h.op === 'exposure'), 'exposure is still found under Essentials only');
    await panel(t, 'basic');
    assert(!await t.driver.observe(() => !!document.querySelector('[data-panel-id="basic"] [data-module^="exposure#"] .module-card-tag')), 'the Exposure card no longer says hidden');
    await t.evidence('advanced-hidden-essentials');

    // 4. Show all in Detail brings its modules back and leaves other groups alone
    await openModules(t);
    await filter(t, 'lowpass');
    await textButton(t, '#module-prefs-advanced .module-prefs-bulk', 'Show all');
    await closePrefs(t);
    await hiddenNow(t, l => !l.includes('detail:lowpass') && l.includes('effects:bloom'), 'Detail shown, Effects still hidden');
    assert((await hits(t, 'lowpass')).some(h => h.op === 'lowpass'), 'lowpass is found again after Show all');
    assert(!(await hits(t, 'bloom')).some(h => h.op === 'bloom'), 'bloom stays hidden: Show all acts on one group');
  } finally {
    try {
      // leave nothing hidden, as the profile started
      if (!await t.driver.observe(() => !!document.querySelector('.prefs'))) await openModules(t);
      await showEverything(t);
      await closePrefs(t);
    } catch { /* the failure above is the one to report */ }
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
