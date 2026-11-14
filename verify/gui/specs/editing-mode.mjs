// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const meanError = (a, b) => { let e = 0; for (let i = 0; i < a.rgba.length; i++) e += Math.abs(a.rgba[i] - b.rgba[i]); return e / a.rgba.length; };

// what the Adjustments list shows: group titles in order, the Advanced search
// box, and how many history rows exist
const layout = t => t.driver.observe(() => ({
  titles: [...document.querySelectorAll('[data-panel-id] > .panel-title > span:first-child')].map(e => e.textContent.trim()),
  ids: [...document.querySelectorAll('[data-panel-id]')].map(e => e.dataset.panelId),
  search: !!document.querySelector('.advanced-search input[type=search][aria-label="Search modules"]'),
  searchFirst: (() => {
    const s = document.querySelector('.advanced-search'), p = document.querySelector('[data-panel-id]');
    return !!s && !!p && !!(s.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
  })(),
  placeholders: document.querySelectorAll('.advanced-empty').length,
  // null when the History card's list is not mounted, so a count is never vacuous
  history: document.querySelector('.history-list') ? document.querySelectorAll('.history-list li').length : null,
}));

export async function setMode(t, label) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'General');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'General tab');
  await t.driver.point(tab.x, tab.y);
  await textButton(t, '[data-pref-label="Editing mode"] .segmented', label);
  await until(() => t.driver.observe((want) => [...document.querySelectorAll('[data-pref-label="Editing mode"] .segmented button.active')]
    .map(b => b.textContent.trim()).join() === want, label), `Editing mode ${label} active`);
  await t.evidence(`prefs-${label.toLowerCase()}`);
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}

export async function editingMode(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Advanced') await setMode(t, 'Simple');
    await openTool(t, 'adjust');
    // the History card (left column) must be open for its rows to be counted
    if (!await t.driver.observe(() => document.querySelector('.panel.history > .panel-title')?.classList.contains('open')))
      await click(t, '.panel.history > .panel-title');
    await until(() => t.driver.observe(() => !!document.querySelector('.history-list')), 'History list shown');
    // 1. Simple: baseline
    const baseline = await settledPhoto(t);
    const simple = await until(async () => { const l = await layout(t); return l.ids.length > 1 && l; }, 'Adjustments groups in Simple');
    assert(!simple.ids.includes('technical'), 'Simple has no Technical group');
    assert(!simple.search, 'Simple has no Advanced search box');
    assert.equal(simple.placeholders, 0, 'Simple shows no module placeholders');
    assert.notEqual(simple.history, null, 'History rows are counted');
    await t.evidence('simple-before');

    // 2-3. Advanced
    await setMode(t, 'Advanced');
    const advanced = await until(async () => { const l = await layout(t); return l.search && l; }, 'Advanced search box');
    assert(advanced.searchFirst, 'the search box is above the groups');
    assert.equal(advanced.ids.at(-1), 'technical', 'Technical is the last group');
    // Advanced shows B&W for every photo (2a1a44e); Simple only in black and white
    assert.deepEqual(advanced.ids.slice(0, -1).filter(id => id === 'bw' ? simple.ids.includes('bw') : true), simple.ids,
      'the groups keep their Simple order');
    assert(advanced.ids.includes('bw'), 'Advanced shows the B&W group for every photo');
    assert(advanced.placeholders > 0 || advanced.ids.length > 1, 'Advanced groups are drawn');
    assert.equal(advanced.history, simple.history, 'Advanced added no history entry');
    const photoAdvanced = await settledPhoto(t);
    const advancedError = meanError(photoAdvanced, baseline);
    t.measure({ name: 'advanced', ids: advanced.ids, titles: advanced.titles, meanAbsoluteError: advancedError, history: advanced.history });
    assert(advancedError <= 1, `Advanced changed the photo: mean pixel error ${advancedError} exceeds 1/255`);
    await t.evidence('advanced');

    // 4. stored
    assert.equal(await waitSetting(t, KEY, v => v === 'advanced', 'immage.editMode stored as advanced'), 'advanced');

    // 5. back to Simple
    await setMode(t, 'Simple');
    const back = await until(async () => { const l = await layout(t); return !l.search && l; }, 'Simple layout returns');
    assert(!back.ids.includes('technical'), 'Technical group gone in Simple');
    assert.deepEqual(back.ids, simple.ids, 'the Simple groups return in order');
    assert.equal(back.history, simple.history, 'no history entry added');
    const photoBack = await settledPhoto(t);
    const backError = meanError(photoBack, baseline);
    t.measure({ name: 'simple-again', meanAbsoluteError: backError });
    assert(backError <= 1, `Simple again changed the photo: mean pixel error ${backError} exceeds 1/255`);
    assert.equal(await waitSetting(t, KEY, v => v === 'simple', 'immage.editMode stored as simple'), 'simple');
    await t.evidence('simple-after');
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
