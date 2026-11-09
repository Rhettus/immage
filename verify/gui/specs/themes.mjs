// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click } from '../support/controls.mjs';
import { settledPhoto, exposure, startup } from './smoke.mjs';

const palettes = {
  Dark: { id: 'dark', panel: '#181818', graph: [24, 24, 24], grid: '#262626', filmstrip: 'rgb(20, 20, 20)', scheme: 'dark' },
  'Darktable Grey': { id: 'grey', panel: '#656565', graph: [94, 94, 94], grid: '#777777', filmstrip: 'rgb(106, 106, 106)', scheme: 'dark' },
  Light: { id: 'light', panel: '#f4f4f4', graph: [238, 238, 238], grid: '#cccccc', filmstrip: 'rgb(229, 229, 229)', scheme: 'light' },
};

async function preferences(t) {
  if (!(await t.driver.observe(() => !!document.querySelector('.prefs')))) await click(t, 'button[data-tour="prefs"]');
  const general = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'General');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Preferences General tab');
  await t.driver.point(general.x, general.y);
  await until(() => t.driver.observe(() => !!document.querySelector('[role="group"][aria-label="Theme"] button[aria-label="Dark"]')), 'theme swatches');
  const layout = await t.driver.observe(() => {
    const row = document.querySelector('[data-pref-label="Theme"]');
    const card = row.closest('.pref-card');
    const swatches = row.querySelector('.pref-swatches').getBoundingClientRect();
    const actions = row.querySelector('.theme-prefs-actions').getBoundingClientRect();
    const buttons = [...row.querySelectorAll('.swatch, .theme-prefs-actions button')];
    const hittable = buttons.every(button => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit === button || button.contains(hit);
    });
    const canvas = card.querySelector('[data-pref-label="Canvas"] .pref-swatches').getBoundingClientRect();
    return { hittable, labels: [...card.querySelectorAll('.pref-row')].map(e => e.dataset.prefLabel),
      aligned: Math.abs(swatches.right - canvas.right) <= 1,
      separated: actions.top >= swatches.bottom,
      contained: actions.right <= row.getBoundingClientRect().right + 1 };
  });
  assert(layout.hittable && layout.aligned && layout.separated && layout.contained, 'theme swatches align right with actions below');
  assert.deepEqual(layout.labels.filter(label => label !== 'Scroll amount'), [
    'Theme', 'Canvas', 'Overlay color', 'Overlay opacity', 'Guide color',
    'Focus mode', 'Auto-hide panels', 'Scroll adjusts sliders', 'Open generated photos',
    'Generated positive format', 'Warn before converting a negative',
  ]);
  if (layout.labels.includes('Scroll amount')) assert.equal(layout.labels.indexOf('Scroll amount'), layout.labels.indexOf('Scroll adjusts sliders') + 1);

}

async function closePreferences(t) {
  const close = await t.driver.observe(() => {
    const e = document.querySelector('.prefs-foot button');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  assert(close, 'Preferences close button is present');
  await t.driver.point(close.x, close.y);
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}

async function observation(t, name, expected, baseline) {
  return until(() => t.driver.observe((n, e, baselineHash) => {
    const button = document.querySelector(`[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(n)}]`);
    const canvas = document.querySelector('.histogram canvas');
    if (!button || !canvas?.width || !canvas.height) return null;
    const rgba = [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data];
    const root = getComputedStyle(document.documentElement);
    const filmstrip = document.querySelector('.filmstrip');
    if (!filmstrip) return null;
    const photoCanvas = document.querySelector('canvas.layer.sharp');
    const sample = document.createElement('canvas'); sample.width = sample.height = 64;
    const ctx = sample.getContext('2d'); ctx.drawImage(photoCanvas, 0, 0, 64, 64);
    const pixels = [...ctx.getImageData(0, 0, 64, 64).data];
    let hash = 2166136261; for (const x of pixels) hash = Math.imul(hash ^ x, 16777619);
    const result = { selected: button.getAttribute('aria-pressed'), id: document.documentElement.dataset.theme,
      panel: root.getPropertyValue('--panel').trim(), graph: rgba.slice(0, 3), grid: root.getPropertyValue('--graph-grid').trim(),
      filmstrip: getComputedStyle(filmstrip).backgroundColor,
      scheme: document.documentElement.style.colorScheme, photoHash: hash >>> 0, canvas: [canvas.width, canvas.height] };
    return result.selected === 'true' && result.id === e.id && result.panel === e.panel
      && JSON.stringify(result.graph) === JSON.stringify(e.graph) && result.grid === e.grid
      && result.filmstrip === e.filmstrip && result.scheme === e.scheme && result.photoHash === baselineHash ? result : null;
  }, name, expected, baseline.hash), `${name} theme and histogram graph colors`);
}

async function exposureWithEvidence(t, theme) {
  await exposure({ ...t, evidence: name => t.evidence(`exposure-${theme}-${name}`) });
}

export async function themes(t) {
  const baseline = await settledPhoto(t);
  await preferences(t);
  let selected = await observation(t, 'Dark', palettes.Dark, baseline);
  assert.equal(selected.selected, 'true', 'Dark is the first-launch default');
  assert.equal(selected.id, 'dark');
  assert.deepEqual(selected.graph, palettes.Dark.graph);
  assert.equal(selected.photoHash, baseline.hash, 'theme does not change photo pixels');
  await t.evidence('theme-dark');

  await closePreferences(t);
  await exposureWithEvidence(t, 'dark');
  await preferences(t);

  for (const name of ['Darktable Grey', 'Light']) {
    await click(t, `[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(name)}]`);
    selected = await observation(t, name, palettes[name], baseline);
    assert.equal(selected.selected, 'true', `${name} swatch is selected for accessibility`);
    assert.equal(selected.id, palettes[name].id);
    assert.equal(selected.panel, palettes[name].panel);
    assert.deepEqual(selected.graph, palettes[name].graph, `${name} histogram canvas background`);
    assert.equal(selected.grid, palettes[name].grid);
    assert.equal(selected.scheme, palettes[name].scheme);
    assert.equal(selected.photoHash, baseline.hash, `${name} leaves photo pixels unchanged`);
    t.measure({ name, ...selected });
    await t.evidence(`theme-${palettes[name].id}`);
    await closePreferences(t);
    await exposureWithEvidence(t, palettes[name].id);
    await preferences(t);
  }

  // A real app restart keeps the chosen theme in the isolated WebView profile.
  await closePreferences(t);
  await t.restart();
  await startup(t);
  const afterRestart = await settledPhoto(t);
  assert.equal(afterRestart.hash, baseline.hash, 'restart and theme persistence do not alter photo pixels');
  await preferences(t);
  selected = await observation(t, 'Light', palettes.Light, baseline);
  assert.equal(selected.selected, 'true', 'Light selection survives app restart');
  assert.equal(selected.id, 'light');
  assert.deepEqual(selected.graph, palettes.Light.graph);
  assert.equal(selected.photoHash, baseline.hash);
  await t.evidence('theme-light-restart');
  await click(t, '[role="group"][aria-label="Theme"] button[aria-label="Dark"]');
  selected = await observation(t, 'Dark', palettes.Dark, baseline);
  assert.equal(selected.selected, 'true', 'Dark can be restored after restart');
  await closePreferences(t);
  t.measure({ name: 'themes', initialPhoto: baseline.hash, restartTheme: 'light', finalTheme: 'dark',
    coverage: ['accessible swatch selection', 'panel and graph colors', 'photo pixel invariance', 'Exposure in each theme', 'restart persistence'] });
}

// Focused layout regression: stay within General > Workspace.
export async function workspaceLayout(t) {
  await preferences(t);
  for (const name of ['Darktable Grey', 'Light', 'Dark']) {
    await click(t, `[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(name)}]`);
    await preferences(t);
    assert.equal(await t.driver.observe(n => document.querySelector(`[role="group"][aria-label="Theme"] button[aria-label=${JSON.stringify(n)}]`).getAttribute('aria-pressed'), name), 'true');
    await t.evidence(`workspace-${name.toLowerCase().replaceAll(' ', '-')}`);
  }
  const scroll = '[data-pref-label="Scroll adjusts sliders"] input';
  const original = await t.driver.observe(s => document.querySelector(s).checked, scroll);
  try {
    await click(t, scroll);
    const labels = await t.driver.observe(() => [...document.querySelector('[data-pref-label="Theme"]').closest('.pref-card').querySelectorAll('.pref-row')].map(e => e.dataset.prefLabel));
    if (!original) assert.equal(labels.indexOf('Scroll amount'), labels.indexOf('Scroll adjusts sliders') + 1);
    assert.equal(await t.driver.observe(() => !!document.querySelector('[data-pref-label="Scroll amount"]')), !original);
  } finally {
    await click(t, scroll);
  }
  await closePreferences(t);
  t.measure({ name: 'workspace-layout', coverage: ['Workspace row order', 'conditional scroll amount order', 'right aligned theme swatches', 'theme actions below swatches', 'theme selection'] });
}
