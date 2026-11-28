// SPDX-License-Identifier: GPL-3.0-or-later
// An unmounted share (commit 096c987): a folder under the local path of the
// Immich path mapping (immage.immichPathMap) is treated as a network share, and
// when that root is not on a network mount it is offline: volumes::answering
// refuses it, folder_volumes reports online:false, the Folders drive heading's
// dot gets `.off`, the folder row `.offline`, opening it says "not answering",
// and Find's analysis counter leaves its photos out. The scratch folders `nas`
// and `local` are plain directories on this machine, beside the run's fixture
// folder (run.mjs seeds them as library folders before the first launch).
//
// The mapping is set live through the real Preferences > Immich fields
// (External library path, Folder on this computer): both write
// immage.immichPathMap through settings.set, with no server contact and no
// native folder chooser (the Choose button, a native dialog, is not used).
// Typing is key by key, so a prefix such as the run folder is briefly the
// mapping's local path and everything under it reads offline until the next
// 10 s volume read; the case waits for the final state.
import { openFind } from './find.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { Blocked } from '../support/scenario.mjs';
import { click } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { readSetting, waitSetting } from '../support/settings.mjs';
import { startup } from './smoke.mjs';

const MAP_KEY = 'immage.immichPathMap';
const IMMICH_SIDE = '/photos';
export const PHOTOS = 3;
const cells = '.filmstrip.grid .thumb[data-imgid]';
const row = path => `.folder-row[data-folder-path=${JSON.stringify(path)}]`;
const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const count = (t, selector) => t.driver.observe(s => document.querySelectorAll(s).length, selector);

// the scratch folders sit beside the run's fixture folder, inside the run folder
export const sharePaths = fixtureDir => {
  const root = join(dirname(fixtureDir), 'unmounted-share-fixtures');
  return { root, nas: join(root, 'nas'), local: join(root, 'local') };
};

// run.mjs calls this before the first launch: copies of the fixture in each
// folder, and a sidecar (rating 3) beside one photo in nas, so there is a
// sidecar for the case to find untouched
export async function unmountedShareFixtures(fixtureDir, fixture) {
  const { nas, local } = sharePaths(fixtureDir);
  const ext = extname(fixture);
  for (const [dir, stem] of [[nas, 'nas'], [local, 'local']]) {
    await mkdir(dir, { recursive: true });
    for (let n = 1; n <= PHOTOS; n++) await copyFile(fixture, join(dir, `${stem}-${String(n).padStart(2, '0')}${ext}`));
  }
  await writeFile(join(nas, `nas-01${ext}.xmp`),
    '<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="3"/></rdf:RDF></x:xmpmeta>');
  return { nas, local, photos: PHOTOS };
}

// file name, size, mtime and SHA-256 of everything in a folder: a sidecar
// written, rewritten or removed shows as a difference
async function snapshot(dir) {
  const out = {};
  for (const name of (await readdir(dir)).sort()) {
    const path = join(dir, name), s = await stat(path);
    out[name] = { size: s.size, mtimeMs: s.mtimeMs, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  return out;
}

const heads = t => t.driver.observe(() => [...document.querySelectorAll('.folder-volume')].map(h => ({
  name: h.querySelector('.name')?.textContent.trim(), off: !!h.querySelector('.drive-dot.off'),
  title: h.querySelector('.drive-dot')?.getAttribute('title') ?? null })));
const offDots = t => t.driver.observe(() => document.querySelectorAll('.folders .drive-dot.off').length);
const rowState = (t, path) => t.driver.observe(s => { const e = document.querySelector(s);
  return e && { offline: e.classList.contains('offline'), title: e.getAttribute('title') }; }, row(path));

async function foldersCard(t, roots) {
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  for (const r of roots) await until(() => present(t, row(r)), `the Folders row ${basename(r)}`, 30000);
}

async function openFolderRow(t, path) {
  await click(t, `${row(path)} .name`);
}

// Find's analysis counter. Without the CLIP model (the isolated profile has
// none) it is dimmed with data-state "off" and shows no number.
async function analysis(t) {
  if (!await present(t, '.find-pop')) {
    if (!await present(t, '.filmstrip.grid')) await click(t, '.rail .library-toggle');
    await openFind(t);
    await until(() => present(t, '.find-pop'), 'the Find column');
  }
  const e = await until(() => t.driver.observe(() => { const x = document.querySelector('.find-pop .analysis-status');
    return x && { state: x.dataset.state, label: x.getAttribute('aria-label') ?? '' }; }), 'the analysis indicator');
  const m = /\d[\d.,   ]*/.exec(e.label);
  return { ...e, pending: m ? Number(m[0].replace(/\D/g, '')) : (e.state === 'idle' ? 0 : null) };
}
// the counter settles when two reads 2.5 s apart (the poll is every 2 s) agree
async function settledAnalysis(t) {
  let last = null;
  return until(async () => {
    const now = await analysis(t);
    const same = last && last.state === now.state && last.pending === now.pending;
    last = now;
    return same ? now : false;
  }, 'the analysis counter settling', 90000);
}

// real key input into the field the pointer click just focused (as immich-prefs)
async function typeInto(t, label, text) {
  const selector = `[data-pref-label=${JSON.stringify(label)}] input.field`;
  await click(t, selector);
  await t.driver.guard();
  const found = await t.driver.command('POST', '/element', { using: 'css selector', value: selector });
  await t.driver.command('POST', `/element/${Object.values(found)[0]}/value`, { text });
  await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, selector, text), `${label} holds ${text}`);
}

async function setMapping(t, local) {
  await click(t, 'button[data-tour="prefs"]');
  const tab = await until(() => t.driver.observe(() => {
    const e = [...document.querySelectorAll('.prefs-tabs button')].find(e => e.textContent.trim() === 'Immich');
    if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'Immich preferences tab');
  await t.driver.point(tab.x, tab.y);
  await until(() => present(t, '[data-pref-label="External library path"]'), 'the Immich tab');
  await typeInto(t, 'External library path', IMMICH_SIDE);
  await typeInto(t, 'Folder on this computer', local);
  // both sides are stored together; wait for the last keystroke to reach settings.json
  await waitSetting(t, MAP_KEY, v => { try { const m = JSON.parse(v); return m.immich === IMMICH_SIDE && m.local === local; } catch { return false; } },
    'the path mapping in settings.json');
  await click(t, '.prefs-foot button');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}

export async function unmountedShare(t) {
  if (!t.fixtureDir) throw new Blocked('no fixture folder');
  const { nas, local } = sharePaths(t.fixtureDir);
  if (!(await stat(nas).catch(() => null))?.isDirectory()) throw new Blocked('the nas and local scratch folders were not made by the runner');
  if (await readSetting(t, MAP_KEY)) throw new Blocked('the profile already holds an Immich path mapping');
  await foldersCard(t, [nas, local]);

  // 2. before the mapping: both open and list their photos, no drive is off
  await openFolderRow(t, nas);
  await until(async () => await count(t, cells) === PHOTOS, 'nas photos listed', 60000);
  await openFolderRow(t, local);
  await until(async () => await count(t, cells) === PHOTOS, 'local photos listed', 60000);
  assert.equal(await offDots(t), 0, 'no drive dot is off before the mapping');
  for (const p of [nas, local]) assert.equal((await rowState(t, p)).offline, false, `${basename(p)} is not offline before the mapping`);
  const before = await settledAnalysis(t);
  t.measure({ name: 'analysis-before', ...before });
  await t.evidence('before-mapping', '.folders-panel');
  const nasBefore = await snapshot(nas);
  assert(Object.keys(nasBefore).some(n => n.endsWith('.xmp')), 'nas holds a sidecar to compare');

  // 3. the mapping, live: Immich side /photos, local side nas/
  const mappedAt = Date.now();
  await setMapping(t, nas);

  // 4. nas goes offline within the volume read (every 10 s), local stays on
  const off = await until(async () => {
    const h = (await heads(t)).find(x => x.name === basename(nas));
    const r = await rowState(t, nas);
    return h?.off && r?.offline ? { head: h, row: r } : false;
  }, 'nas offline: drive dot off and row offline', 30000);
  const withinMs = Date.now() - mappedAt;
  t.measure({ name: 'nas-offline', withinMs, head: off.head, row: off.row });
  if (withinMs > 15000) t.subcheck('nas-offline-within-15s', false, { withinMs });
  assert.match(off.row.title, /not connected/, 'the offline row says it is not connected');
  assert.match(off.head.title ?? '', /not answering/, 'the offline dot says not answering');
  // a prefix of the typed path may have marked others offline for a moment; they read online again
  await until(async () => (await offDots(t)) === 1 && !(await rowState(t, local)).offline, 'only nas offline (local back online)', 40000);
  await t.evidence('nas-offline', '.folders-panel');

  // clicking the offline folder: the app clears the grid and says the drive is not answering
  await openFolderRow(t, nas);
  const notice = await until(() => t.driver.observe(() => { const e = document.querySelector('.status'); return e && /not answering/.test(e.textContent) ? e.textContent.trim() : null; }),
    'the "not answering" status for nas', 20000);
  const shown = await count(t, cells);
  t.measure({ name: 'nas-open-refused', notice, gridPhotos: shown });
  assert.equal(shown, 0, 'no nas photo is listed while it is offline');
  assert((await rowState(t, nas)).offline, 'nas stays offline after the click');
  await t.evidence('nas-open-refused');

  // local still opens and lists its photos
  await openFolderRow(t, local);
  await until(async () => await count(t, cells) === PHOTOS, 'local photos listed with nas offline', 60000);
  assert.equal(await offDots(t), 1, 'still only the nas dot is off');
  const after = await settledAnalysis(t);
  t.measure({ name: 'analysis-after', ...after });
  if (before.state === 'off' || before.pending === null || after.pending === null) {
    // no CLIP model in the isolated profile: the counter shows no number, so
    // the exclusion of nas photos is not observable here
    t.measure({ name: 'analysis-not-deterministic', reason: `state ${before.state}/${after.state}, pending ${before.pending}/${after.pending}` });
  } else assert(after.pending <= before.pending, `the counter does not increase (${before.pending} to ${after.pending})`);
  await t.evidence('local-open', '.folders-panel');

  // 5. nothing written to nas: same files, sizes, mtimes and hashes
  assert.deepEqual(await snapshot(nas), nasBefore, 'nas files and sidecars are unchanged');

  // 6. relaunch with the mapping saved: nas is offline at startup
  const saved = JSON.parse(await readSetting(t, MAP_KEY));
  assert.deepEqual([saved.immich, saved.local], [IMMICH_SIDE, nas], 'the mapping is saved');
  await t.restart();
  await startup(t);
  await foldersCard(t, [nas, local]);
  const again = await until(async () => {
    const h = (await heads(t)).find(x => x.name === basename(nas));
    const r = await rowState(t, nas);
    return h?.off && r?.offline ? { head: h, row: r } : false;
  }, 'nas offline after the relaunch', 30000);
  t.measure({ name: 'nas-offline-at-startup', ...again });
  assert.equal(await offDots(t), 1, 'only nas is off after the relaunch');
  assert.equal((await rowState(t, local)).offline, false, 'local is online after the relaunch');
  assert.deepEqual(await snapshot(nas), nasBefore, 'nas is unchanged after the relaunch');
  await t.evidence('relaunched', '.folders-panel');
  t.measure({ name: 'unmounted-share', mapping: saved });
}
