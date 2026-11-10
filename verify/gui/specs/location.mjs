// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

export async function locationMap(t) {
  if (!(await t.driver.observe(() => !!document.querySelector('.location-editor')))) await click(t, '.metadata .panel-title');
  await textButton(t, '.location-actions', 'Show map');
  const coordinates = await t.driver.observe(() => document.querySelector('.location-editor input.field').value);
  await click(t, 'button[aria-label="Expand map"]');
  const geometry = await t.driver.observe(() => {
    const viewer = document.querySelector('[data-tour="viewer"]').getBoundingClientRect();
    const map = document.querySelector('.location-map').getBoundingClientRect();
    return { width: map.width, height: map.height, viewerWidth: viewer.width, viewerHeight: viewer.height };
  });
  assert(geometry.width > geometry.viewerWidth * .8 && geometry.height > geometry.viewerHeight * .5, 'expanded map fills photo area');
  const map = await reveal(t, '.location-map');
  const before = await t.driver.observe(() => document.querySelector('.location-map').dataset.mapZoom);
  await t.driver.wheel(map.x, map.y, -240);
  await until(() => t.driver.observe(z => Number(document.querySelector('.location-map').dataset.mapZoom) > Number(z), before), 'wheel zooms map');
  await t.evidence('location-expanded');
  await click(t, 'button[data-tour="prefs"]');
  assert(await t.driver.observe(() => {
    const prefs = document.querySelector('.prefs');
    if (!prefs) return false;
    const r = prefs.getBoundingClientRect();
    return prefs.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }), 'Preferences renders above expanded map');
  await t.evidence('location-preferences-above-map');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Escape closes Preferences');
  assert(await t.driver.observe(() => !!document.querySelector('.location-map-region.expanded')), 'dialog Escape preserves expanded map');
  await t.driver.keys('\uE00C');
  await until(() => t.driver.observe(() => !!document.querySelector('button[aria-label="Expand map"]')), 'Escape collapses map');
  assert.equal(await t.driver.observe(() => document.querySelector('.location-editor input.field').value), coordinates, 'navigation does not edit coordinates');
  await textButton(t, '.location-actions', 'Hide map');
  t.measure({ name: 'location-map', geometry, coverage: ['expand', 'wheel zoom', 'Escape collapse', 'unchanged draft'], limitation: 'Provider search/keyring require separate credentials; no live provider request or metadata write in this case.' });
}
