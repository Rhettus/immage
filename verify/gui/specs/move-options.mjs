// SPDX-License-Identifier: GPL-3.0-or-later
// The Move and Copy confirmation's newer options (MoveDialog.tsx, photoDrag.ts,
// FileMenu.tsx, menu.ts), all inside this run's own fixture folder:
//  - move-companions: a collapsed RAW+JPEG stack dragged onto a folder offers
//    "Include the stacked JPEG, HEIF or ORI file(s)", unticked when the File
//    type filter is RAW
//  - move-subfolders: "Sort into subfolders" with its pattern field, example
//    line and the debounce that keeps Confirm disabled while a typed pattern
//    is pending
//  - move-menu-items: Move to Folder... and Copy to Folder... exist in the photo
//    right-click menu and the Photo menu. They open a NATIVE folder picker,
//    which the app-only boundary forbids, so they are never clicked: the picker
//    flow is manual-only
// Not live-validated: written without a launch.
import assert from 'node:assert/strict';
import { readdir, writeFile, mkdir, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocked, textButton } from '../support/scenario.mjs';
import { click, inspect, reveal } from '../support/controls.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { cell, row, dialog, dialogText, sha, exists, foldersCard, grip, rowAt } from './move-photos.mjs';

const ESC = '', ALT = '';
const PAIRS = ['pair-a', 'pair-b', 'pair-c'];
// capture times written into the dated JPEGs; the subfolders follow from them
const DATED = { 'sort-a.jpg': '2021:03:14 09:26:53', 'sort-b.jpg': '2022:11:05 17:02:11' };
const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);

// a JPEG with an Exif DateTimeOriginal, written after SOI (and after JFIF APP0 when present)
export function datedJpeg(bytes, when) {
  const text = Buffer.from(when + '\0', 'latin1');
  assert.equal(text.length, 20, 'Exif date is "YYYY:MM:DD HH:MM:SS"');
  const tiff = Buffer.alloc(44 + 20);
  tiff.write('II', 0, 'latin1'); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);                                              // IFD0: one entry, the Exif IFD
  tiff.writeUInt16LE(0x8769, 10); tiff.writeUInt16LE(4, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(1, 26);                                             // Exif IFD: DateTimeOriginal
  tiff.writeUInt16LE(0x9003, 28); tiff.writeUInt16LE(2, 30); tiff.writeUInt32LE(20, 32); tiff.writeUInt32LE(44, 36);
  text.copy(tiff, 44);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]); head.writeUInt16BE(body.length + 2, 2);
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, 'a JPEG');
  let at = 2;
  if (bytes[2] === 0xff && bytes[3] === 0xe0) at = 4 + bytes.readUInt16BE(4);
  return Buffer.concat([bytes.subarray(0, at), head, body, bytes.subarray(at)]);
}

// laid out by run.mjs before launch. Returns null for a missing prerequisite so the
// runner can report it; the cases themselves then block.
//  companions: three raw+JPEG pairs (raw from benchmarking/corpus, JPEG from app/sample) and pair-dest/
//  subfolders: two JPEGs with known capture dates and sort-dest/
//  menu: nothing extra
export async function moveOptionFixtures(fixtures, root, { companions, subfolders }) {
  const report = {};
  const sample = await readFile(join(root, 'app/sample/stairs-to-mountain.jpg'));
  if (companions) {
    const corpus = join(root, 'benchmarking/corpus');
    const names = await readdir(corpus).catch(() => []);
    const source = names.includes('P6060404.ORF') ? 'P6060404.ORF' : names.find(n => /\.(orf|arw|cr2|rw2)$/i.test(n));
    if (!source) report.companions = 'blocked: no RAW (*.ORF, *.ARW, *.CR2 or *.RW2) in benchmarking/corpus';
    else {
      const ext = source.match(/\.[^.]+$/)[0];
      for (const stem of PAIRS) {
        await copyFile(join(corpus, source), join(fixtures, stem + ext));
        await writeFile(join(fixtures, `${stem}.jpg`), sample);
      }
      await mkdir(join(fixtures, 'pair-dest'));
      report.companions = { raw: source, pairs: PAIRS.map(s => s + ext) };
    }
  }
  if (subfolders) {
    for (const [name, when] of Object.entries(DATED)) await writeFile(join(fixtures, name), datedJpeg(sample, when));
    await mkdir(join(fixtures, 'sort-dest'));
    report.subfolders = DATED;
  }
  return report;
}

async function openFixtureFolder(t, dest) {
  await foldersCard(t);
  if (!await present(t, row(dest))) {
    const twisty = await reveal(t, `${row(t.fixtureDir)} .twisty`);
    await t.driver.point(twisty.x, twisty.y);
  }
  await until(() => present(t, row(dest)), `${dest} listed in Folders`);
}

// the confirmation's checkbox by a part of its label, with a point to click
const checkbox = (t, text) => t.driver.observe((w, d) => {
  const l = [...document.querySelectorAll(`${d} label`)].find(x => x.textContent.includes(w));
  const i = l?.querySelector('input[type=checkbox]');
  if (!i) return null;
  i.scrollIntoView({ block: 'nearest' });
  const r = i.getBoundingClientRect();
  return { checked: i.checked, x: r.x + r.width / 2, y: r.y + r.height / 2 };
}, text, dialog);
const primary = t => t.driver.observe(d => {
  const b = document.querySelector(`${d} .btn.primary`);
  return b ? { text: b.textContent.trim(), disabled: b.disabled } : null;
}, dialog);

async function dragOnto(t, name, dest, alt = false) {
  await until(() => present(t, cell(name)), `${name} in the filmstrip`, 120000);
  const from = await grip(t, name), to = await rowAt(t, dest);
  if (alt) await t.driver.modifiedDrag(ALT, from, to); else await t.driver.drag(from, to);
  await until(() => primary(t), 'the confirmation with its plan', 30000);
}

async function ratedSidecar(t, name) {
  const g = await grip(t, name);
  await t.driver.move(g.x, g.y);
  const star = await until(() => t.driver.observe(inspect, `${cell(name)} .thumb-stars button:nth-child(3)`), `${name} stars`);
  await t.driver.point(star.x, star.y);
  const xmp = join(t.fixtureDir, `${name}.xmp`);
  await until(async () => (await readFile(xmp, 'utf8').catch(() => '')).match(/xmp:Rating="3"|<xmp:Rating>3</), `${name} sidecar rated`);
  return xmp;
}

// the File type filter through Find's real UI: RAW on or off
async function rawFilter(t, on) {
  const pop = '.find-pop';
  if (!await present(t, pop)) await click(t, '.find-button');
  await until(() => present(t, pop), 'Find column');
  const rowOpen = n => t.driver.observe(w => [...document.querySelectorAll('.find-pop .fr-row')]
    .find(c => c.querySelector('.fr-title')?.textContent === w)?.getAttribute('aria-expanded') === 'true', n);
  if (!on) {
    if (await present(t, `${pop} .fr-x[aria-label="Remove File type"]`)) await click(t, `${pop} .fr-x[aria-label="Remove File type"]`);
    await until(async () => !await present(t, `${pop} .fr-x[aria-label="Remove File type"]`), 'the File type filter removed');
    return;
  }
  if (!await rowOpen('File type')) {
    const p = await until(() => t.driver.observe(w => {
      const e = [...document.querySelectorAll('.find-pop .fr-row')].find(c => c.querySelector('.fr-title')?.textContent === w);
      if (!e) return null;
      e.scrollIntoView({ block: 'nearest' });
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, 'File type'), 'File type row');
    await t.driver.point(p.x, p.y);
    await until(() => rowOpen('File type'), 'File type editor');
  }
  // the "All RAW" tick
  const tick = await until(() => t.driver.observe(() => {
    const b = [...document.querySelectorAll('.find-pop .fr-editor .filter-ticks button')].find(x => /All RAW/.test(x.textContent));
    if (!b) return null;
    b.scrollIntoView({ block: 'nearest' });
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }), 'the All RAW tick');
  await t.driver.point(tick.x, tick.y);
  await until(() => present(t, `${pop} .fr-x[aria-label="Remove File type"]`), 'the File type row shows a value');
}

export async function moveCompanions(t) {
  const fixtures = t.fixtureDir;
  const raw = (await readdir(fixtures)).find(n => /^pair-a\.(orf|arw|cr2|rw2)$/i.test(n));
  if (!raw) throw new Blocked('pair fixtures were not laid out (needs a RAW in benchmarking/corpus)');
  const ext = raw.match(/\.[^.]+$/)[0], dest = join(fixtures, 'pair-dest');
  const original = await sha(join(fixtures, 'pair-a.jpg'));
  await until(() => present(t, cell(raw)), `${raw} in the filmstrip`, 120000);
  await openFixtureFolder(t, dest);
  // the premise: the pair is one collapsed stack (Stack RAW+JPEG pairs is seeded on)
  await until(() => present(t, `${cell(raw)} .thumb-stack-toggle`), `${raw} shows a stack badge`);
  assert(!await present(t, cell('pair-a.jpg')), 'the stacked JPEG has no cell of its own');
  const xmp = await ratedSidecar(t, raw);

  // 1. the filter shows only raws: the box is there, unticked, and only the raw goes
  await rawFilter(t, true);
  await until(() => present(t, cell(raw)), `${raw} still listed under the RAW filter`);
  await dragOnto(t, raw, dest);
  let box = await checkbox(t, 'stacked JPEG, HEIF or ORI');
  t.measure({ name: 'companions-filtered', box, text: await t.driver.observe(dialogText) });
  await t.evidence('companions-filtered');
  assert(box, 'the confirmation offers to include the stacked JPEG');
  assert.equal(box.checked, false, 'the companion box is unticked while the filter shows only raws');
  assert(/Include the stacked JPEG, HEIF or ORI file(?!s)/.test(await t.driver.observe(dialogText)), 'the singular label for one companion');
  assert.match((await primary(t)).text, /^Move 1 photo$/, 'one photo to move');
  await textButton(t, `${dialog} .modal-foot`, 'Move 1 photo');
  await until(() => exists(join(dest, raw)), `${raw} arrives in pair-dest`, 60000);
  await until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'the confirmation closed');
  assert(await exists(join(dest, `${raw}.xmp`)), 'the raw sidecar arrived');
  assert(!await exists(xmp), 'the raw sidecar left the source');
  assert(await exists(join(fixtures, 'pair-a.jpg')), 'the JPEG stayed at the source');
  assert(!await exists(join(dest, 'pair-a.jpg')), 'the JPEG did not arrive');
  assert.equal(await sha(join(fixtures, 'pair-a.jpg')), original, 'the stayed JPEG is untouched');
  assert.deepEqual((await readdir(dest)).filter(n => n.endsWith('.immage-part')), [], 'no part files left');

  // 2. same filter, box ticked by hand: the plan is made again and both go
  await dragOnto(t, `pair-b${ext}`, dest);
  box = await checkbox(t, 'stacked JPEG, HEIF or ORI');
  assert(box && !box.checked, 'pair-b: unticked under the RAW filter');
  await t.driver.point(box.x, box.y);
  await until(async () => (await checkbox(t, 'stacked JPEG, HEIF or ORI'))?.checked === true, 'the companion box ticked');
  await until(async () => /^Move 2 photos$/.test((await primary(t))?.text ?? ''), 'two photos to move after ticking', 30000);
  await t.evidence('companions-ticked');
  await textButton(t, `${dialog} .modal-foot`, 'Move 2 photos');
  for (const n of [`pair-b${ext}`, 'pair-b.jpg']) await until(() => exists(join(dest, n)), `${n} arrives in pair-dest`, 60000);
  await until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'the confirmation closed');
  assert(!await exists(join(fixtures, 'pair-b.jpg')) && !await exists(join(fixtures, `pair-b${ext}`)), 'both left the source');
  assert.equal(await sha(join(dest, 'pair-b.jpg')), original, 'the moved JPEG has the original bytes');

  // 3. no filter: ticked by default, and both go
  await rawFilter(t, false);
  await until(() => present(t, cell(`pair-c${ext}`)), 'pair-c listed without the filter');
  await dragOnto(t, `pair-c${ext}`, dest);
  box = await checkbox(t, 'stacked JPEG, HEIF or ORI');
  t.measure({ name: 'companions-unfiltered', box });
  await t.evidence('companions-unfiltered');
  assert(box?.checked === true, 'the companion box is ticked without a filter');
  await until(async () => /^Move 2 photos$/.test((await primary(t))?.text ?? ''), 'two photos to move');
  await textButton(t, `${dialog} .modal-foot`, 'Move 2 photos');
  for (const n of [`pair-c${ext}`, 'pair-c.jpg']) await until(() => exists(join(dest, n)), `${n} arrives in pair-dest`, 60000);
  assert.deepEqual((await readdir(dest)).filter(n => n.endsWith('.immage-part')), [], 'no part files left');
}

export async function moveSubfolders(t) {
  const fixtures = t.fixtureDir, dest = join(fixtures, 'sort-dest');
  if (!await exists(join(fixtures, 'sort-a.jpg'))) throw new Blocked('sort fixtures were not laid out');
  const original = await sha(join(fixtures, 'sort-a.jpg'));
  await until(() => present(t, cell('sort-a.jpg')), 'sort-a.jpg in the filmstrip', 120000);
  await openFixtureFolder(t, dest);
  const xmp = await ratedSidecar(t, 'sort-a.jpg');

  // Alt copy of the 2021-03-14 photo, sorted by the default pattern
  await dragOnto(t, 'sort-a.jpg', dest, true);
  assert.match(await t.driver.observe(dialogText), /Copy Photos/, 'Alt makes it a copy');
  let sort = await checkbox(t, 'Sort into subfolders');
  assert(sort, 'the confirmation has Sort into subfolders');
  if (!sort.checked) await t.driver.point(sort.x, sort.y);
  await until(async () => (await checkbox(t, 'Sort into subfolders'))?.checked === true, 'Sort into subfolders ticked');
  const field = `${dialog} .move-pattern input.field`;
  await until(() => present(t, field), 'the pattern field');
  assert.equal(await t.driver.observe(s => document.querySelector(s).value, field), '{year}/{month}/{day}', 'the default pattern');
  const text = () => t.driver.observe(d => document.querySelector(`${d} .move-pattern`)?.textContent ?? '', dialog);
  await until(async () => /Into 1 folder: /.test(await text()), 'the example line', 30000);
  assert(/\{year\}/.test(await text()), 'the hint names the tokens');
  assert(/Into 1 folder: 2021\/03\/14/.test(await text()), `the example is the capture date's folder (${await text()})`);
  await t.evidence('subfolders-default');
  t.measure({ name: 'subfolders-default', text: await text() });

  // a typed edit leaves Confirm disabled until the plan is made again. The window is
  // the 400 ms debounce, so a slow input round trip may miss it: that is recorded,
  // and the end state (enabled, new example) is asserted either way
  await click(t, field);
  await t.driver.chord('', 'a');
  await t.driver.keys(...'{year}-{month}'.split(''));
  const during = await primary(t);
  t.measure({ name: 'pending-confirm', duringTyping: during });
  await until(async () => /Into 1 folder: 2021-03/.test(await text()) && (await primary(t))?.disabled === false,
    'the plan follows the typed pattern and Confirm enables', 30000);
  if (!during?.disabled) t.measure({ name: 'pending-window-missed', note: 'Confirm was already enabled when sampled' });
  else assert.equal(during.disabled, true, 'Confirm is disabled while the typed pattern is pending');
  await t.evidence('subfolders-edited');

  // back to the default pattern, then copy
  await click(t, field);
  await t.driver.chord('', 'a');
  await t.driver.keys(...'{year}/{month}/{day}'.split(''));
  await until(async () => /Into 1 folder: 2021\/03\/14/.test(await text()) && (await primary(t))?.disabled === false,
    'the default pattern is planned again', 30000);
  await textButton(t, `${dialog} .modal-foot`, 'Copy 1 photo');
  const landed = join(dest, '2021', '03', '14');
  await until(() => exists(join(landed, 'sort-a.jpg')), 'sort-a.jpg arrives in sort-dest/2021/03/14', 60000);
  await until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'the confirmation closed');
  assert.equal(await sha(join(landed, 'sort-a.jpg')), original, 'the copy has the original bytes');
  assert(await exists(join(landed, 'sort-a.jpg.xmp')), 'its sidecar is in the same subfolder');
  assert(/xmp:Rating="3"|<xmp:Rating>3</.test(await readFile(join(landed, 'sort-a.jpg.xmp'), 'utf8')), 'the sidecar carries the rating');
  assert(await exists(join(fixtures, 'sort-a.jpg')) && await exists(xmp), 'a copy leaves the source and its sidecar');
  assert.deepEqual((await readdir(landed)).filter(n => n.endsWith('.immage-part')), [], 'no part files left');
  assert.deepEqual((await readdir(dest)).sort(), ['2021'], 'nothing else landed in the destination root');

  // the other photo: the subfolder choice is remembered, so the box is ticked and the example follows its own date
  await dragOnto(t, 'sort-b.jpg', dest, true);
  sort = await checkbox(t, 'Sort into subfolders');
  assert(sort?.checked === true, 'the subfolder choice is remembered for the next confirmation');
  await until(async () => /Into 1 folder: 2022\/11\/05/.test(await text()), `the example for sort-b (${await text()})`, 30000);
  // Cancel creates nothing; unticking first leaves the remembered choice off for later cases
  await t.driver.point(sort.x, sort.y);
  await until(async () => (await checkbox(t, 'Sort into subfolders'))?.checked === false, 'Sort into subfolders unticked');
  await textButton(t, `${dialog} .modal-foot`, 'Cancel');
  await until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'the confirmation closed');
  assert(!await exists(join(dest, '2022')), 'Cancel created no subfolder');
}

const MENU_ITEMS = ['Move to Folder…', 'Copy to Folder…'];
export async function moveMenuItems(t) {
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip .thumb[data-imgid]')), 'a photo in the filmstrip', 120000);
  // the photo right-click menu. A right-click leaves later left-button drags without their
  // press under WebKitWebDriver, so this case runs after the drag cases or in its own launch
  const name = await t.driver.observe(() => document.querySelector('.filmstrip .thumb[data-imgid]').title);
  const c = await reveal(t, cell(name));
  await t.driver.rightClick(c.x, c.y);
  await until(() => present(t, '.context-menu'), 'the photo menu');
  const items = await t.driver.observe(() => [...document.querySelectorAll('.context-menu:not(.submenu) > button')].map(b => {
    const r = b.getBoundingClientRect();
    return { name: b.textContent.trim(), disabled: b.disabled,
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
  }));
  t.measure({ name: 'photo-menu', items });
  await t.evidence('photo-menu-move-copy');
  for (const label of MENU_ITEMS) {
    const it = items.find(i => i.name === label);
    assert(it, `the photo menu lists ${label} (${items.map(i => i.name).join(' | ')})`);
    assert(it.inside && !it.disabled, `${label} is visible and enabled`);
  }
  assert(items.findIndex(i => i.name === MENU_ITEMS[0]) + 1 === items.findIndex(i => i.name === MENU_ITEMS[1]), 'Move and Copy are adjacent');
  await t.driver.keys(ESC);
  await until(async () => !await present(t, '.context-menu'), 'the photo menu closed');

  // the Photo menu in the title strip (drawn on Windows and Linux)
  if (!await present(t, '[data-menu="Photo"]')) throw new Blocked('no in-window menu strip on this platform');
  await click(t, '[data-menu="Photo"]');
  await until(() => t.driver.observe(() => document.querySelector('[data-menu="Photo"]')?.getAttribute('aria-expanded') === 'true'), 'the Photo menu open');
  const menu = await t.driver.observe(() => [...document.querySelectorAll('.menubar-menu > button[data-menu-item]')].map(b => ({
    id: b.dataset.menuItem, label: b.querySelector('span')?.textContent ?? '', disabled: b.disabled })));
  t.measure({ name: 'photo-strip-menu', menu });
  await t.evidence('photo-strip-menu-move-copy');
  for (const [id, label] of [['move-to-folder', MENU_ITEMS[0]], ['copy-to-folder', MENU_ITEMS[1]]]) {
    const it = menu.find(m => m.id === id);
    assert(it, `the Photo menu lists ${id}`);
    assert.equal(it.label, label, `${id} is labelled ${label}`);
  }
  await t.driver.keys(ESC);
  await until(async () => !await present(t, '.menubar-menu'), 'the Photo menu closed');
  // never clicked: both open a native folder picker, outside the app-only boundary (manual check only)
  await pause(200);
}
