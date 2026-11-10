// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

const darkBox = '.location-map-toolbar input[type=checkbox]';

// Leaflet owns the map host's classes; toggling Dark must not strip them, or
// the tiles lose their clipping and cover the toolbar (and the Dark checkbox).
async function toggleDark(t, expected, label) {
  await click(t, darkBox);
  const state = await t.driver.observe(sel => {
    const box = document.querySelector(sel);
    const map = document.querySelector('.location-map');
    const region = document.querySelector('.location-map-region');
    const r = box.getBoundingClientRect();
    return {
      checked: box.checked,
      regionDark: region.classList.contains('dark'),
      leaflet: map.classList.contains('leaflet-container'),
      overflow: getComputedStyle(map).overflow,
      boxHit: box.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      filter: getComputedStyle(map.querySelector('.leaflet-tile-pane')).filter,
    };
  }, darkBox);
  assert.equal(state.checked, expected, `${label}: checkbox state`);
  assert.equal(state.regionDark, expected, `${label}: dark class on region`);
  assert(state.leaflet, `${label}: map keeps leaflet-container`);
  assert.equal(state.overflow, 'hidden', `${label}: map clips its tiles`);
  assert(state.boxHit, `${label}: Dark checkbox stays clickable`);
  assert.equal(state.filter !== 'none', expected, `${label}: tile filter matches Dark`);
  return state;
}

export async function locationMap(t) {
  if (!(await t.driver.observe(() => !!document.querySelector('.location-editor')))) await click(t, '.metadata .panel-title');
  await textButton(t, '.location-actions', 'Show map');
  const coordinates = await t.driver.observe(() => document.querySelector('.location-editor input.field').value);
  const dark = [];
  dark.push(await toggleDark(t, false, 'embedded Dark off'));
  await t.evidence('location-embedded-light');
  dark.push(await toggleDark(t, true, 'embedded Dark on'));
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
  dark.push(await toggleDark(t, false, 'expanded Dark off'));
  await t.evidence('location-expanded-light');
  dark.push(await toggleDark(t, true, 'expanded Dark on'));
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
  t.measure({ name: 'location-map', geometry, dark, coverage: ['Dark toggle embedded and expanded', 'expand', 'wheel zoom', 'Escape collapse', 'unchanged draft'], limitation: 'Provider search/keyring require separate credentials; no live provider request or metadata write in this case.' });
}
