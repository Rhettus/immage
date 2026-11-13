// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';

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
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
