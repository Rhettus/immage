// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export async function folderMoveFixtures(dir, fixture) {
  const month = join(dir, '2026-05');
  const album = join(dir, 'archive');
  await mkdir(join(month, 'empty'), { recursive: true });
  await mkdir(album);
  await mkdir(join(dir, '2026-06'));
  await mkdir(join(dir, '2026-07', 'nested'), { recursive: true });
  await writeFile(join(dir, '2026-07', 'nested', 'notes.txt'), 'across drives');
  const ext = extname(fixture);
  await copyFile(fixture, join(dir, '2026-06', 'photo' + ext));
  for (let n = 0; n <= 5; n++) {
    const filename = n ? `photo_${String(n).padStart(2, '0')}${ext}` : `photo${ext}`;
    await writeFile(join(dir, '2026-06', filename + '.xmp'),
      `<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="${n}"/></rdf:RDF></x:xmpmeta>`);
  }
  await mkdir(join(dir, 'backup', '2026-05'), { recursive: true });
  await copyFile(fixture, join(month, 'photo' + extname(fixture)));
  await writeFile(join(month, '.hidden'), 'hidden file');
  await writeFile(join(month, 'notes.txt'), 'original notes');
  await writeFile(join(dir, 'backup', '2026-05', 'notes.txt'), 'old backup notes');
  await symlink('notes.txt', join(month, 'link-to-notes'));
}

const modal = '.modal[aria-labelledby="folder-move-title"]';
const row = (path) => `.folder-row[data-folder-path=${JSON.stringify(path)}]`;
const visible = (t, selector) => t.driver.observe((s) => Boolean(document.querySelector(s)), selector);
const confirm = (t) => until(() => visible(t, `${modal} button.primary:enabled`), 'folder transfer confirmation', 20000);
const fromTo = async (t, src, dest, copy = false) => {
  const from = await reveal(t, `${row(src)} .name`);
  const to = await reveal(t, `${row(dest)} .name`);
  if (copy) await t.driver.modifiedDrag("\uE00A", from, to);
  else await t.driver.drag(from, to);
};

export async function moveFolders(t) {
  const source = join(t.fixtureDir, '2026-05');
  const archive = join(t.fixtureDir, 'archive');
  const backup = join(t.fixtureDir, 'backup');
  const moved = join(archive, '2026-05');
  const copy = join(backup, '2026-05');
  const photo = 'photo' + extname(t.fixture.file);
  if (!await visible(t, '.folders-panel > .panel-title.open')) await click(t, '.folders-panel > .panel-title');
  await until(() => visible(t, row(t.fixtureDir)), 'fixture folder');
  if (!await visible(t, row(source))) await click(t, `${row(t.fixtureDir)} .twisty`);
  await until(() => visible(t, row(source)), 'month folder');
  await fromTo(t, source, t.fixtureDir);
  assert.equal(await visible(t, modal), false, 'the current parent refuses the drop');
  await click(t, `${row(source)} .twisty`);
  await until(() => visible(t, row(join(source, 'empty'))), 'source subfolder');
  await fromTo(t, source, join(source, 'empty'));
  assert.equal(await visible(t, modal), false, 'a descendant refuses the drop');

  await fromTo(t, source, backup);
  await confirm(t);
  const confirmation = await t.driver.observe((s) => document.querySelector(s).textContent, modal);
  await t.evidence('folder-move-title', `${modal} .modal-head`);
  await t.evidence('folder-move-counts', `${modal} .modal-body > p:nth-child(2)`);
  await t.evidence('folder-move-buttons', `${modal} .modal-foot`);
  assert.match(confirmation, /merged/);
  for (const label of ['1 photo', '2 other files', '1 subfolder', '1 symbolic link']) {
    assert(confirmation.includes(label), `confirmation displays ${label}`);
  }
  assert.doesNotMatch(confirmation, /dialogs\.folderMove\./i);
  const select = `${modal} select`;
  assert.equal(await t.driver.observe((s) => document.querySelector(s).value, select), 'skip');
  await textButton(t, `${modal} .modal-foot`, 'Cancel');
  assert.equal(await readFile(join(copy, 'notes.txt'), 'utf8'), 'old backup notes');

  await fromTo(t, source, backup, true);
  await confirm(t);
  assert.equal(await t.driver.observe((s) => document.querySelector(s).checked, `${modal} input[type="checkbox"]`), true);
  // Tab backwards from Cancel, past the copy checkbox, to the conflict.
  await t.driver.chord("\uE008", "\uE004");
  await t.driver.chord("\uE008", "\uE004");
  await t.driver.keys("\uE015");
  await until(() => t.driver.observe((s) => document.querySelector(s)?.value === 'overwrite', select), 'Overwrite selected');
  await t.evidence('folder-copy-buttons', `${modal} .modal-foot`);
  await textButton(t, `${modal} .modal-foot`, 'Copy');
  await until(async () => (await readFile(join(copy, 'notes.txt'), 'utf8')) === 'original notes', 'folder merged');
  assert.equal(await readFile(join(source, 'notes.txt'), 'utf8'), 'original notes');
  await until(() => visible(t, row(source)), 'source folder still listed');

  await click(t, row(source));
  await fromTo(t, source, archive);
  await confirm(t);
  await t.evidence('folder-move-confirmation');
  await textButton(t, `${modal} .modal-foot`, 'Move');
  await until(async () => (await readFile(join(moved, '.hidden'), 'utf8').catch(() => '')) === 'hidden file', 'hidden file transferred', 20000);
  await until(async () => !(await stat(join(source, photo)).catch(() => null)), 'original removed after verification', 20000);
  await until(() => t.driver.observe(() => [...document.querySelectorAll('.activity')]
    .some((el) => el.textContent.includes('Transferred 2026-05 with 1 item skipped.'))), 'localized skipped-item summary');
  assert.deepEqual(await readFile(join(moved, photo)), await readFile(join(t.fixtureDir, t.fixture.file)));
  assert((await stat(join(moved, 'empty'))).isDirectory(), 'empty directory transferred');
  assert((await stat(source)).isDirectory(), 'the link keeps the source folder in place');
  assert(!(await stat(join(moved, 'link-to-notes')).catch(() => null)), 'the link stayed behind');
  const june = join(t.fixtureDir, '2026-06');
  const newJune = join(archive, '2026-06');
  await click(t, row(june));
  const cells = '.filmstrip.grid .thumb[data-imgid]';
  const rendered = () => t.driver.observe((s) => [...document.querySelectorAll(s)].filter((el) => {
    const c = el.querySelector('canvas');
    return c && c.width > 0 && c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[3] > 0;
  }).length, cells);
  await until(async () => await rendered() === 6, 'original and five virtual-copy thumbnails');
  const inodes = (dir) => Promise.all(Array.from({ length: 6 }, (_, version) => t.thumbnailCacheEntry(join(dir, photo), version)));
  const before = await until(async () => {
    const entries = await inodes(june);
    return entries.every(Boolean) ? entries : null;
  }, 'all six source JPEGs stored on disk');
  const previous = await stat(june);
  await fromTo(t, june, archive);
  await confirm(t);
  assert.match(await t.driver.observe((s) => document.querySelector(s).textContent, modal), /same drive/);
  await textButton(t, `${modal} .modal-foot`, 'Move');
  await until(() => visible(t, `${row(newJune)}.active`), 'grid follows the moved folder', 20000);
  assert.equal((await stat(newJune)).ino, previous.ino, 'the folder was atomically renamed');
  assert(!(await stat(june).catch(() => null)), 'the old row path is gone from disk');
  await until(async () => await rendered() === 6, 'all six thumbnails after moving');
  assert.deepEqual(await inodes(newJune), before, 'all six cached JPEGs were reused');
  await t.evidence('moved-variant-thumbnails', '.filmstrip.grid');
  const opened = [];
  for (let n = 0; n < 6; n++) {
    const id = await t.driver.observe((s, i) => document.querySelectorAll(s)[i]?.dataset.imgid, cells, n);
    const at = await reveal(t, `${cells}[data-imgid="${id}"]`);
    await t.driver.point(at.x, at.y, 2);
    await settledPhoto(t);
    const version = await until(async () => {
      const settings = JSON.parse(await t.runtimeRead('settings.json'));
      const library = JSON.parse(settings['immage.library']);
      return library.image === join(newJune, photo) && !opened.includes(library.version)
        ? { number: library.version } : null;
    }, 'the selected version opened from the destination');
    opened.push(version.number);
    await click(t, row(newJune));
    await until(async () => await rendered() === 6, 'return to all moved variants');
  }
  assert.deepEqual(opened.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  if (t.crossFolderTarget) {
    const july = join(t.fixtureDir, '2026-07');
    const julyTarget = join(t.crossFolderTarget, '2026-07');
    assert.notEqual((await stat(july)).dev, (await stat(t.crossFolderTarget)).dev);
    await fromTo(t, july, t.crossFolderTarget);
    await confirm(t);
    assert.match(await t.driver.observe((s) => document.querySelector(s).textContent, modal), /verifies the copied files/);
    await textButton(t, `${modal} .modal-foot`, 'Move');
    await until(async () => !(await stat(july).catch(() => null)), 'cross-filesystem removal', 20000);
    assert.equal(await readFile(join(julyTarget, 'nested', 'notes.txt'), 'utf8'), 'across drives');
    await until(() => visible(t, row(julyTarget)), 'new folder on the second drive');
    t.measure({ name: 'cross-filesystem-move', covered: true });
  }
  await t.evidence('folder-move-complete');
}
