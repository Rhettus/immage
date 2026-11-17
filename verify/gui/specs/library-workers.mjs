// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';

export async function libraryWorkers(t) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Performance');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Performance preferences tab');
  await t.driver.point(tab.x, tab.y);
  const row = '[data-pref-label="Library workers"]';
  await until(() => t.driver.observe(s => !!document.querySelector(s), row), 'Library workers preference');
  const initial = await t.driver.observe(s => ({
    options: [...document.querySelectorAll(`${s} .segmented button`)].map(e => e.textContent.trim()),
    active: document.querySelector(`${s} .segmented button.active`)?.textContent.trim() ?? null,
  }), row);
  assert.deepEqual(initial.options, ['1', '2', '3', '4', '6', '8']);
  for (const value of ['6', '2']) {
    await textButton(t, row, value);
    await until(() => t.driver.observe((s, v) => document.querySelector(`${s} .segmented button.active`)?.textContent.trim() === v, row, value),
      `${value} workers selected`);
    await until(async () => JSON.parse(await t.runtimeRead('settings.json'))['immage.thumbThreads'] === value,
      `${value} worker setting saved`);
  }
  await textButton(t, row, '6');
  await until(async () => JSON.parse(await t.runtimeRead('settings.json'))['immage.thumbThreads'] === '6',
    'six worker setting saved for the next transfer');
  await t.evidence('library-workers');
  t.measure({ name: 'library-workers', initial, selected: '6', nextTransfer: true, persisted: true });
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}
