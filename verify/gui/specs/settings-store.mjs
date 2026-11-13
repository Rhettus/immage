// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { inspect, click } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { settledPhoto, startup } from './smoke.mjs';
import { SETTINGS, settingsFile, waitSettings } from '../support/settings.mjs';

// WebKitGTK's file for the release app's origin (tauri://localhost), as found in
// a real profile: <data>/app.immage/localstorage/tauri_localhost_0.localstorage
export const LOCAL_STORAGE_FILE = 'tauri_localhost_0.localstorage';
const MARKER = 'immage.settings-migrated';
const THEME_KEY = 'immage.themes.v1', SCROLL_KEY = 'immage.sliderScroll', PROBE_KEY = 'immage.seed-probe';
// what an older build left behind, non-default and visible in Preferences:
// the theme (Darktable Grey), Scroll adjusts sliders (on), Memory (Large) and
// Edit on the GPU (off). The probe key has no control; it must be copied as is.
export const SEED = {
  localStorage: {
    [THEME_KEY]: JSON.stringify({ custom: [], selected: 'grey' }),
    [SCROLL_KEY]: '1',
    [PROBE_KEY]: 'carried over from localStorage',
  },
  loose: { 'darktable-resources': 'large\n', 'gpu-edits': 'off' },
};

const THEME = n => `[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(n)}]`;
const SCROLL = '[data-pref-label="Scroll adjusts sliders"] input';
const GPU = '[data-pref-label="Edit on the GPU"] input';

async function openPreferences(t, tab) {
  if (!(await t.driver.observe(() => !!document.querySelector('.prefs')))) await click(t, 'button[data-tour="prefs"]');
  const at = await until(() => t.driver.observe(label => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === label);
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, tab), `Preferences ${tab} tab`);
  await t.driver.point(at.x, at.y);
  await until(() => t.driver.observe(label => document.querySelector('.prefs-tabs button.on')?.textContent.trim() === label, tab), `${tab} tab open`);
}
async function closePreferences(t) {
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}
const memoryActive = async t => (await t.driver.observe(() =>
  [...document.querySelectorAll('[data-pref-label="Memory"] .segmented button')].filter(b => b.classList.contains('active')).map(b => b.textContent.trim())));
const pressed = (t, name) => t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-pressed'), THEME(name));
const checked = (t, selector) => t.driver.observe(inspect, selector).then(c => c?.checked);

// the Preferences values, read back through the real controls
async function readPreferences(t) {
  await openPreferences(t, 'General');
  const general = await until(async () => {
    const theme = await t.driver.observe(() => document.documentElement.dataset.theme);
    const names = ['Dark', 'Darktable Grey', 'Light'];
    const swatches = {}; for (const n of names) swatches[n] = await pressed(t, n);
    const scroll = await checked(t, SCROLL);
    return Object.values(swatches).every(v => v !== undefined && v !== null) && typeof scroll === 'boolean' && { theme, swatches, scroll };
  }, 'General preference controls');
  await openPreferences(t, 'Performance');
  const performance = await until(async () => {
    const memory = await memoryActive(t), gpu = await checked(t, GPU);
    return memory.length === 1 && typeof gpu === 'boolean' && { memory: memory[0], gpu };
  }, 'Performance preference controls');
  return { ...general, ...performance };
}
const selectedSwatch = p => Object.entries(p.swatches).filter(([, v]) => v === 'true').map(([k]) => k);

const themeSelected = map => { try { return JSON.parse(map[THEME_KEY]).selected; } catch { return undefined; } };
const local = t => t.driver.observe((marker, ...keys) => ({
  marker: localStorage.getItem(marker), values: Object.fromEntries(keys.map(k => [k, localStorage.getItem(k)])) }), MARKER, THEME_KEY, SCROLL_KEY, PROBE_KEY);

export async function settingsStore(t) {
  await settledPhoto(t);

  // Launch 1: an upgrade from localStorage and the loose files
  const copied = await waitSettings(t, 'settings.json holding the copied localStorage and the loose files', m =>
    m[MARKER] === '1' && m[PROBE_KEY] !== undefined && m['native.darktable-resources'] !== undefined && m['native.gpu-edits'] !== undefined);
  assert.equal(copied[MARKER], '1', 'the migration marker is written to settings.json');
  assert.equal(copied[THEME_KEY], SEED.localStorage[THEME_KEY], 'theme copied verbatim');
  assert.equal(copied[SCROLL_KEY], '1');
  assert.equal(copied[PROBE_KEY], SEED.localStorage[PROBE_KEY], 'a key with no control is copied too');
  assert.equal(copied['native.darktable-resources'], 'large', 'loose darktable-resources moved in (trimmed)');
  assert.equal(copied['native.gpu-edits'], 'off', 'loose gpu-edits moved in');
  for (const name of ['darktable-resources', 'gpu-edits'])
    assert.equal(await t.runtimeRead(name), null, `loose file ${name} was deleted`);
  const ls1 = await local(t);
  assert.equal(ls1.marker, '1', 'the marker is also in localStorage');
  assert.deepEqual(ls1.values, SEED.localStorage, 'localStorage keeps its keys');
  const first = await readPreferences(t);
  assert.deepEqual(selectedSwatch(first), ['Darktable Grey'], 'seeded theme selected in Preferences');
  assert.equal(first.theme, 'grey', 'seeded theme applied to the page');
  assert.equal(first.scroll, true, 'seeded Scroll adjusts sliders is on');
  assert.equal(first.memory, 'Large', 'loose darktable-resources shown as Memory Large');
  assert.equal(first.gpu, false, 'loose gpu-edits shown as Edit on the GPU off');
  t.measure({ name: 'launch-1-upgrade', settingsKeys: Object.keys(copied), preferences: first, localStorage: ls1 });
  await t.evidence('launch-1-upgraded');

  // A change by real input reaches settings.json within the batch delay, with
  // the Rust-owned setting going through its own command
  await openPreferences(t, 'Performance');
  await textButton(t, '[data-pref-label="Memory"]', 'Small');
  await openPreferences(t, 'General');
  const clicked = Date.now();
  await click(t, THEME('Light'));
  const changed = await waitSettings(t, 'settings.json holding the changed theme and Memory', m =>
    themeSelected(m) === 'light' && m['native.darktable-resources'] === 'small', 5000);
  t.measure({ name: 'change-written', msAfterClick: Date.now() - clicked });
  assert.equal(changed[SCROLL_KEY], '1', 'untouched settings keep their values');
  assert.equal(changed[PROBE_KEY], SEED.localStorage[PROBE_KEY]);
  assert.equal(changed['native.gpu-edits'], 'off');
  await closePreferences(t);

  // Launch 2: the changes survive a relaunch of the same profile
  await t.restart();
  await startup(t);
  const second = await readPreferences(t);
  assert.deepEqual(selectedSwatch(second), ['Light'], 'changed theme survives relaunch');
  assert.equal(second.theme, 'light');
  assert.equal(second.memory, 'Small', 'changed Memory survives relaunch');
  assert.equal(second.scroll, true, 'seeded setting survives relaunch');
  assert.equal(second.gpu, false);
  const ls2 = await local(t);
  assert.equal(ls2.marker, '1');
  const file2 = await settingsFile(t);
  assert.equal(themeSelected(file2), 'light');
  assert.equal(file2['native.darktable-resources'], 'small');
  t.measure({ name: 'launch-2-relaunch', preferences: second });
  await t.evidence('launch-2-relaunched');
  await closePreferences(t);

  // Launch 3: a reset. With the app closed settings.json is moved away; the old
  // localStorage values, still in the web view with the marker, must not return
  await t.restart(async () => {
    await t.runtimeAside(SETTINGS, 'settings.json.aside');
    assert.equal(await t.runtimeRead(SETTINGS), null, 'settings.json moved away');
  });
  await startup(t);
  const third = await readPreferences(t);
  assert.deepEqual(selectedSwatch(third), ['Dark'], 'theme back to the default');
  assert.equal(third.theme, 'dark');
  assert.equal(third.scroll, false, 'Scroll adjusts sliders back to off');
  assert.equal(third.memory, 'Default', 'Memory back to Default');
  assert.equal(third.gpu, true, 'Edit on the GPU back to on');
  const ls3 = await local(t);
  assert.equal(ls3.marker, '1', 'localStorage still holds the marker');
  assert.equal(ls3.values[SCROLL_KEY], '1', 'localStorage still holds the old values');
  // startup's tour Skip writes the file again; the old values are not in it
  const fresh = await waitSettings(t, 'settings.json recreated', m => Object.keys(m).length > 0);
  for (const key of [MARKER, SCROLL_KEY, PROBE_KEY, THEME_KEY, 'native.darktable-resources', 'native.gpu-edits'])
    assert(!(key in fresh), `recreated settings.json does not hold ${key}`);
  t.measure({ name: 'launch-3-reset', preferences: third, settingsKeys: Object.keys(fresh), localStorage: ls3 });
  await t.evidence('launch-3-reset');
  await closePreferences(t);
  t.measure({ name: 'settings-store', coverage: ['localStorage copy and marker in both stores', 'loose files moved and deleted', 'UI shows migrated values', 'UI change reaches settings.json', 'persistence across relaunch', 'reset by removing settings.json'] });
}
