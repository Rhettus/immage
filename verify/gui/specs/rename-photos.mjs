// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';

const stems = ['rename-alpha', 'rename-bravo', 'rename-charlie'];
const dialog = '.modal.rename-photos';
const field = `${dialog} input.field`;
const footprint = `${dialog} .modal-foot`;
const grid = '.filmstrip.grid';
const cell = name => `${grid} .thumb[data-imgid][title=${JSON.stringify(name)}]`;
const ctrl = '\uE009';

export async function renameFixtures(dir, copied) {
  const ext = extname(copied);
  const filenames = stems.map(stem => stem + ext);
  for (const name of filenames) await copyFile(copied, join(dir, name));
  // Give the existing destination distinct bytes so the collision check can detect an overwrite.
  const data = await readFile(copied);
  await writeFile(join(dir, filenames[1]), Buffer.concat([data, Buffer.from([0])]));
  return filenames;
}

const exists = path => access(path).then(() => true, () => false);
const shown = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const example = t => t.driver.observe(s => document.querySelector(`${s} .rename-example bdi`)?.textContent, dialog);
const selected = t => t.driver.observe(s => [...document.querySelectorAll(`${s} .thumb.selected`)].map(thumb => thumb.title), grid);
const ready = t => t.driver.observe(s => document.querySelector(`${s} .btn.primary`)?.disabled === false, dialog);

async function openRename(t, photo) {
  const { x, y } = await reveal(t, cell(photo));
  await t.driver.rightClick(x, y);
  const menu = '.context-menu:not(.submenu)';
  await until(() => shown(t, menu), 'photo context menu');
  await textButton(t, menu, 'Rename…');
  await until(() => shown(t, field), 'rename dialog');
}

async function typePattern(t, text) {
  // The dialog selects its initial name; use a real Select All for every change.
  await click(t, field);
  await t.driver.chord(ctrl, 'a');
  await t.driver.keys(...text);
  await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, field, text),
    'rename field contains the entered pattern');
}

async function commit(t) {
  await until(() => ready(t), 'filesystem validation accepts the proposed names', 30000);
  await textButton(t, footprint, 'Rename');
  await until(async () => !await shown(t, dialog), 'rename completes and closes dialog', 60000);
}

export async function renamePhotos(t) {
  const ext = extname(t.fixture.file);
  const [alpha, bravo, charlie] = stems.map(stem => stem + ext);
  const path = name => join(t.fixtureDir, name);
  const contents = new Map();
  for (const name of [alpha, bravo, charlie]) contents.set(name, await readFile(path(name)));
  if (!await shown(t, grid)) await t.driver.keys('g');
  await until(() => shown(t, cell(alpha)), 'first rename fixture in Library grid', 60000);
  await click(t, `${cell(alpha)} .thumb-image`);
  await until(() => shown(t, `${cell(alpha)}.active`), 'first rename fixture is the open photo');
  const thumb = await reveal(t, `${cell(alpha)} .thumb-image`);
  await t.driver.move(thumb.x, thumb.y);
  await click(t, `${cell(alpha)} .thumb-stars button:nth-child(3)`);
  const rated = /xmp:Rating="3"|<xmp:Rating>3</;
  await until(async () => rated.test(await readFile(path(`${alpha}.xmp`), 'utf8').catch(() => '')),
    'three stars written to the disposable original sidecar');

  await openRename(t, alpha);
  assert.equal(await t.driver.observe(s => document.querySelector(s).value, field), stems[0]);
  await typePattern(t, stems[1]);
  const collision = await until(async () => {
    const message = await t.driver.observe(s => document.querySelector(`${s} [role="alert"]`)?.textContent, dialog);
    return message?.includes('Already exists') && message;
  }, 'existing photo shown as a filename conflict');
  assert(!await ready(t), 'Rename is disabled while the destination exists');
  assert.deepEqual(await readFile(path(bravo)), contents.get(bravo), 'the existing destination retains its bytes');
  t.measure({ name: 'rename-conflict', message: collision });
  await t.evidence('rename-conflict');

  const one = `renamed-single${ext}`;
  await typePattern(t, 'renamed-single');
  await until(async () => await example(t) === one, 'single-photo preview carries the extension');
  await commit(t);
  await until(() => shown(t, `${cell(one)}.active`), 'renamed photo is open in the refreshed grid');
  assert(!await exists(path(alpha)) && !await exists(path(`${alpha}.xmp`)), 'original file and sidecar names are gone');
  assert.deepEqual(await readFile(path(one)), contents.get(alpha), 'renaming preserves the photo bytes');
  assert.match(await readFile(path(`${one}.xmp`), 'utf8'), rated, 'the rating accompanies the renamed photo');
  await until(() => t.driver.observe(s => document.querySelectorAll(`${s} .thumb-stars button.on`).length === 3, cell(one)),
    'the refreshed photo still displays its stars');
  await t.evidence('renamed-single');

  await click(t, `${cell(bravo)} .thumb-image`);
  const other = await reveal(t, `${cell(charlie)} .thumb-image`);
  await t.driver.modifiedPoint(ctrl, other.x, other.y);
  const oldOrder = await until(async () => {
    const names = await selected(t);
    return names.length === 2 && names.includes(bravo) && names.includes(charlie) && names;
  }, 'two remaining test photos selected');
  await openRename(t, bravo);
  assert.equal(await t.driver.observe(s => document.querySelector(s).value, field), '{originalname}-{seq}');
  const newOrder = oldOrder.map((name, i) => `${name.slice(0, -ext.length)}-00${i + 1}${ext}`);
  assert.equal(await t.driver.observe(s => document.querySelector(`${s} h2`)?.textContent, dialog),
    '2 photos to be renamed');
  assert.equal(await t.driver.observe(s => document.querySelectorAll(`${s} .rename-example bdi`).length, dialog), 1);
  await until(async () => await example(t) === newOrder[0], 'example uses the first photo in grid order');
  t.measure({ name: 'rename-bulk-preview', before: oldOrder, after: newOrder });
  await t.evidence('rename-bulk-preview');
  await commit(t);
  await until(async () => JSON.stringify((await selected(t)).sort()) === JSON.stringify([...newOrder].sort()),
    'bulk rename keeps the selection on the renamed files', 60000);
  for (const [i, name] of newOrder.entries()) {
    assert(!await exists(path(oldOrder[i])), `${oldOrder[i]} is gone`);
    assert.deepEqual(await readFile(path(name)), contents.get(oldOrder[i]), `${name} has the original bytes`);
  }

  if (!await shown(t, '.find-pop .find-text')) await click(t, '.find-button');
  await until(() => shown(t, '.find-pop .find-text'), 'Find panel');
  await click(t, '.find-pop .find-text');
  await t.driver.chord(ctrl, 'a');
  await t.driver.keys(...newOrder[0], '\uE007');
  await until(() => t.driver.observe(s => {
    const thumb = document.querySelector(s);
    const canvas = thumb?.querySelector('.thumb-image canvas');
    return !!canvas?.width && !!canvas?.height && document.querySelectorAll('.filmstrip.grid .thumb').length === 1;
  }, cell(newOrder[0])), 'Find narrows to the renamed photo with its thumbnail', 60000);
  await t.evidence('renamed-find-result');
}
