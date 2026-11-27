// SPDX-License-Identifier: GPL-3.0-or-later
// Export's "Inside a new folder" name takes file-name tokens per photo
// (ExportDialog.tsx, exportTokens.ts folderPath, export_cmds.rs item_dir):
// {year}/{month}/{day} nests a folder per capture date, and a part with no value
// (a missing camera model) is dropped. Everything stays inside this run's fixture
// folder. The native folder chooser is never operated: run.mjs seeds the
// destination (export-dest/) into the isolated profile's saved export settings.
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocked } from '../support/scenario.mjs';
import { click, reveal } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { datedJpeg } from './move-options.mjs';

const DATED = { 'dated-a.jpg': '2021:03:14 09:26:53', 'dated-b.jpg': '2022:11:05 17:02:11' };
const FOLDERS = { 'dated-a.jpg': '2021/03/14', 'dated-b.jpg': '2022/11/05' };
const ctrl = '';
const dialog = '.modal.export';
const toggle = `${dialog} [data-export-section="destination"] label.row.check input[type=checkbox]`;
const field = `${dialog} [data-export-section="destination"] label.row.check input.field`;
const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);

// laid out by run.mjs before launch: two JPEGs with known capture dates beside the
// fixture (which has none) and the empty destination the profile is seeded with
export async function exportSubfolderFixtures(fixtures, root) {
  const sample = await readFile(join(root, 'app/sample/stairs-to-mountain.jpg'));
  for (const [name, when] of Object.entries(DATED)) await writeFile(join(fixtures, name), datedJpeg(sample, when));
  const dest = join(fixtures, 'export-dest');
  await mkdir(dest);
  return dest;
}

// every file under dir, relative, with its size
async function tree(dir) {
  const out = {};
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) for (const [k, v] of Object.entries(await tree(p))) out[join(e.name, k)] = v;
    else out[e.name] = (await stat(p)).size;
  }
  return out;
}

async function openExport(t) {
  await click(t, 'button[data-tour="export"]');
  await until(() => present(t, dialog), 'the export dialog');
  if (!await t.driver.observe(s => document.querySelector(s)?.classList.contains('open'), `${dialog} [data-export-section="destination"]`))
    await click(t, `${dialog} [data-export-section="destination"] > .export-section-head`);
  await until(() => present(t, field), 'the subfolder field');
  // all shown photos: the last scope button
  await click(t, `${dialog} .modal-foot .scope button:last-child`);
}

async function typePattern(t, text) {
  await click(t, field);
  await t.driver.chord(ctrl, 'a');
  await t.driver.keys(...text);
  await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, field, text), 'the field holds the pattern');
}

async function runExport(t, dest, total) {
  const button = `${dialog} .modal-foot .btn.primary`;
  await until(() => t.driver.observe(s => document.querySelector(s)?.disabled === false, button), 'Export enabled', 30000);
  await click(t, button);
  await until(async () => { const f = await tree(dest); return Object.keys(f).length === total && Object.entries(f).every(([k, n]) => n > 0 && !k.endsWith('.part')); },
    `${total} finished files under the destination (no .part left)`, 120000);
  await until(async () => !await present(t, dialog), 'the export dialog closed', 60000);
}

const note = t => t.driver.observe(s => document.querySelector(s)?.textContent ?? '', `${dialog} [data-export-section="destination"] p.note-plain`);

export async function exportSubfolders(t) {
  const fixtures = t.fixtureDir, dest = join(fixtures, 'export-dest');
  if (!await stat(join(fixtures, 'dated-a.jpg')).catch(() => null)) throw new Blocked('export fixtures were not laid out');
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb[data-imgid]').length >= 3), 'three photos in the folder', 120000);
  const names = await t.driver.observe(() => [...document.querySelectorAll('.filmstrip .thumb[data-imgid]')].map(e => e.title));
  assert.equal(names.length, 3, `three photos listed (${names})`);
  // the fixture has no capture date in its file: the library gives it the file's own date (today), so
  // its folder is checked by shape only. The dated copies carry theirs in Exif.
  const dated = names.filter(n => FOLDERS[n]), other = names.filter(n => !FOLDERS[n]);
  assert.equal(dated.length, 2, 'two dated photos');

  await openExport(t);
  const box = await reveal(t, toggle);
  if (!box.checked) await click(t, toggle);
  await until(() => t.driver.observe(s => document.querySelector(s)?.checked === true, toggle), 'Inside a new folder ticked');
  await typePattern(t, '{year}/{month}/{day}');
  // the example line names the first listed photo's folder
  const first = FOLDERS[names[0]] ?? /\d{4}\/\d\d\/\d\d\s*$/;
  await until(async () => typeof first === 'string' ? (await note(t)).includes(first) : first.test(await note(t)),
    `the example follows the first photo ${names[0]}`, 30000);
  t.measure({ name: 'example', first: names[0], note: await note(t) });
  await t.evidence('export-subfolders-pattern');
  await runExport(t, dest, 3);

  const done = await tree(dest);
  t.measure({ name: 'first-export', files: done });
  const keys = Object.keys(done).sort();
  for (const n of dated) assert(keys.includes(join(FOLDERS[n], n)), `${n} is in ${FOLDERS[n]} (${keys})`);
  for (const n of other) assert(keys.some(k => new RegExp(`^\\d{4}/\\d\\d/\\d\\d/${n.replace('.', '\\.')}$`).test(k)), `${n} is in a year/month/day folder (${keys})`);
  assert.equal(keys.length, 3, `exactly three files (${keys})`);
  for (const [file, size] of Object.entries(done)) assert(size > 0, `${file} is not empty`);
  assert.deepEqual((await readdir(fixtures)).filter(n => /^\d{4}$/.test(n)), [], 'no date folder was made outside the destination');

  // a part with no value is dropped: no photo has a camera model, so {camera} leaves no folder
  await openExport(t);
  assert.equal(await t.driver.observe(s => document.querySelector(s)?.value, field), '{year}/{month}/{day}', 'the pattern was remembered');
  await typePattern(t, '{year}/{camera}/{month}');
  await until(async () => /\d{4}\/\d\d\s*$/.test(await note(t)), 'the example drops the empty camera part');
  await runExport(t, dest, 6);
  let now = await tree(dest);
  const second = Object.keys(now).filter(k => !(k in done)).sort();
  t.measure({ name: 'dropped-part', files: second });
  assert.equal(second.length, 3, `three new files (${second})`);
  for (const n of dated) assert(second.includes(join(FOLDERS[n].split('/').slice(0, 2).join('/'), n)), `${n} is in year/month without a camera folder (${second})`);

  // a plain name still makes one folder, and shows no example
  await openExport(t);
  await typePattern(t, 'Export');
  await until(async () => !/\d{4}\/\d\d\s*$/.test(await note(t)), 'a plain name shows no example folder');
  await runExport(t, dest, 9);
  now = await tree(dest);
  assert.deepEqual(Object.keys(now).filter(k => k.startsWith('Export/')).sort(), names.map(n => join('Export', n)).sort(), 'the plain name puts every photo in dest/Export');
  assert.deepEqual(Object.keys(now).filter(k => k in done).sort(), keys, 'the first export is untouched');
  await t.evidence('export-subfolders-done');
}
