// SPDX-License-Identifier: GPL-3.0-or-later
// Opening a new raw (33fd400, cc7a28e, 29e89f6): Preferences' Profile wins over
// the New photos preset's, the lens correction method is written as Lensfun when
// the raw carries embedded data, a newly opened photo starts on Adjust with only
// Basic open (also from Presets), and a crop in progress is applied to the photo
// left. Needs a raw whose camera embeds lens correction data (a Sony ARW) and a
// second raw beside it; run.mjs seeds the isolated profile (Profile Standard,
// a New photos preset holding profile AgX Default) and copies the second raw.
import assert from 'node:assert/strict';
import { click, inspect, reveal } from '../support/controls.mjs';
import { Blocked, panel, expandSections } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export const SECOND_RAW = 'second-raw.ARW';

const filmstrip = () => [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')].map(c => c.title);
const activeTitle = () => document.querySelector('.filmstrip .thumb.active')?.title ?? null;
const openPanels = () => [...document.querySelectorAll('[data-panel-id] > .panel-title.open')].map(e => e.parentElement.dataset.panelId);
const allPanels = () => [...document.querySelectorAll('[data-panel-id]')].map(e => e.dataset.panelId);
const railOn = name => !!document.querySelector(`button[data-tour="${name}"]`)?.classList.contains('on');
const cropRect = () => { const e = document.querySelector('.crop-rect'); if (!e) return null; const r = e.getBoundingClientRect(); return { width: r.width, height: r.height }; };

async function openByName(t, prefix) {
  const cell = await until(() => t.driver.observe(p => {
    const e = [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')].find(c => c.title.startsWith(p));
    const r = e?.getBoundingClientRect();
    return r && r.width && r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
      ? { x: r.x + r.width / 2, y: r.y + r.height / 2, title: e.title } : null;
  }, prefix), `filmstrip thumbnail ${prefix}`);
  await t.driver.point(cell.x, cell.y, 2);
  await until(() => t.driver.observe((a) => document.querySelector('.filmstrip .thumb.active')?.title === a, cell.title), `${prefix} active`);
  return cell.title;
}

async function historyText(t) {
  if (!await t.driver.observe(() => !!document.querySelector('.history-list'))) await click(t, '.panel.history > .panel-title');
  await until(() => t.driver.observe(() => !!document.querySelector('.history-list')), 'history list');
  return t.driver.observe(() => [...document.querySelectorAll('.history-list li')].map(li => li.textContent.trim()));
}

async function profileValue(t) {
  await panel(t, 'basic');
  const c = await reveal(t, '[data-panel-id="basic"] [data-control-id="profile"] select');
  return { value: c.value, label: c.options.find(o => o.value === c.value)?.label };
}

export async function newPhotoDefaults(t) {
  if (!t.fixture.raw) throw new Blocked('needs a raw fixture whose camera embeds lens correction data');
  const names = await until(async () => { const n = await t.driver.observe(filmstrip); return n.length >= 2 && n; }, 'both raws listed', 60000);
  const first = names.find(n => !n.startsWith('second-raw')), second = names.find(n => n.startsWith('second-raw'));
  assert(first && second, `two raws listed (${names})`);
  await until(() => t.driver.observe(a => document.querySelector('.filmstrip .thumb.active')?.title === a, first), 'first raw active');
  const baseline1 = await settledPhoto(t);

  // 1. Preferences' Profile (Standard) beats the preset's AgX Default
  const profile = await profileValue(t);
  t.measure({ name: 'profile', ...profile });
  assert.equal(profile.value, '1', `Profile is Standard, not the preset's AgX Default (${profile.label})`);
  await t.evidence('profile-standard');

  // 2. lens correction method Lensfun, and its history step
  const lens = await panel(t, 'lens');
  await expandSections(t, lens);
  const method = await reveal(t, `${lens} [data-control-id="lens_method"] select`).catch(() => null);
  t.measure({ name: 'lens-method', present: !!method, value: method?.value, label: method?.options?.find(o => o.value === method.value)?.label });
  assert(method, 'Correction method is shown: the raw carries embedded data and Lensfun was written');
  assert.equal(method.value, '1', 'Correction method is Lensfun database');
  const history = await historyText(t);
  t.measure({ name: 'history', history });
  t.subcheck('history has a lens method step', history.some(h => /lens method/i.test(h)), { observed: history.join(' | ') });
  assert(history.some(h => /new photos preset/i.test(h)), 'history has the new photos preset step');
  await t.evidence('lens-method');

  // 3. a non-Basic panel (Lens Corrections) is open: opening the second photo leaves only Basic
  assert(await t.driver.observe(openPanels).then(p => p.includes('lens')), 'Lens Corrections is open before the switch');
  await openByName(t, 'second-raw');
  await settledPhoto(t, p => p.hash !== baseline1.hash);
  await until(async () => (await t.driver.observe(openPanels)).join() === 'basic', 'only Basic open after opening a photo');
  assert(await t.driver.observe(railOn, 'adjust'), 'Adjust is the open tool');
  t.measure({ name: 'after-open', open: await t.driver.observe(openPanels) });
  await t.evidence('only-basic-after-open');
  assert.equal((await profileValue(t)).value, '1', 'the second raw is on Standard too');

  // 4. from Presets mode: opening a photo returns to Adjust with only Basic open
  await click(t, 'button[data-tour="presets"]');
  await until(async () => (await t.driver.observe(allPanels)).length === 0 && await t.driver.observe(railOn, 'presets'), 'Presets mode');
  await t.evidence('presets-mode');
  await openByName(t, first);
  await until(async () => (await t.driver.observe(openPanels)).join() === 'basic', 'Adjust with only Basic open after leaving Presets');
  assert(await t.driver.observe(railOn, 'adjust'), 'Adjust is the open tool, not Presets');
  await t.evidence('adjust-from-presets');
  const before = await settledPhoto(t);

  // 5. a crop in progress is applied to the photo left
  await click(t, 'button[data-tour="crop"]');
  const rect0 = await until(() => t.driver.observe(cropRect), 'crop overlay');
  const handle = await reveal(t, '.crop-handle.nw');
  await t.driver.drag(handle, { x: handle.x + 90, y: handle.y + 60 });
  const rect1 = await until(async () => { const r = await t.driver.observe(cropRect); return r && r.width < rect0.width - 20 && r; }, 'crop rectangle shrinks');
  t.measure({ name: 'crop-drag', before: rect0, after: rect1 });
  await t.evidence('crop-in-progress');
  await openByName(t, 'second-raw');
  await until(() => t.driver.observe(() => !document.querySelector('.crop-rect')), 'crop tool left');
  await settledPhoto(t);
  await openByName(t, first);
  const after = await settledPhoto(t, p => p.hash !== before.hash);
  assert(!await t.driver.observe(() => !!document.querySelector('.crop-rect')), 'no crop in progress on return');
  const back = await historyText(t);
  t.measure({ name: 'crop-applied', beforeHash: before.hash, afterHash: after.hash, size: [before.width, before.height, after.width, after.height], history: back });
  assert(back.some(h => /crop/i.test(h)), `the crop is in the history (${back.join(' | ')})`);
  await t.evidence('crop-applied');
}
