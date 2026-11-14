// SPDX-License-Identifier: GPL-3.0-or-later
// Moving and copying photos by dragging a thumbnail onto a Folders row
// (photoDrag.ts, MoveDialog.tsx, move_cmds.rs). Everything happens inside this
// run's own copied fixture folder, which the runner lays out before launch
// (moveFixtures): three copies of the fixture beside it, dest/inner/ to move
// into, and clash/ holding one photo identical to move-c and one with move-b's
// name but other content
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocked, textButton } from '../support/scenario.mjs';
import { click, inspect, reveal } from '../support/controls.mjs';
import { until, pause } from '../support/webdriver.mjs';

const extOf = (file) => file.match(/\.[^.]+$/)?.[0] ?? '';

// laid out by run.mjs before the app starts, from the copied fixture
export async function moveFixtures(fixtures, copied) {
  const ext = extOf(copied);
  for (const n of ['move-a', 'move-b', 'move-c']) await copyFile(copied, join(fixtures, n + ext));
  await mkdir(join(fixtures, 'dest', 'inner'), { recursive: true });
  await mkdir(join(fixtures, 'clash'));
  await copyFile(copied, join(fixtures, 'clash', `move-c${ext}`));
  // the same name with other content: a byte after the end of the file
  await writeFile(join(fixtures, 'clash', `move-b${ext}`), Buffer.concat([await readFile(copied), Buffer.from([0])]));
  return ext;
}

const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
const exists = async (p) => readFile(p).then(() => true, () => false);
const cell = (name) => `.filmstrip .thumb[title=${JSON.stringify(name)}]`;
const row = (path) => `.folders [data-folder-path=${JSON.stringify(path)}]`;
const dialog = '.modal.move-photos';

const center = (selector) => {
  const e = document.querySelector(selector);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
const folderState = () => ({
  active: document.querySelector('.folders .folder-row.active')?.dataset.folderPath ?? null,
  target: document.querySelector('.folders .folder-row.drop-into')?.dataset.folderPath ?? null,
  ghost: !!document.querySelector('.photo-drag'),
  dialog: !!document.querySelector('.modal.move-photos'),
});
// the highlighted row stays a row of the Folders panel: no overlay over the window
const targetBox = () => {
  const r = document.querySelector('.folders .folder-row.drop-into');
  const panel = document.querySelector('.folders');
  if (!r || !panel) return null;
  const a = r.getBoundingClientRect(), b = panel.getBoundingClientRect();
  return { position: getComputedStyle(r).position, inside: a.left >= b.left - 1 && a.right <= b.right + 1 && a.height < 80 };
};
const dialogText = () => document.querySelector('.modal.move-photos')?.textContent ?? null;

async function foldersCard(t) {
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  await until(() => t.driver.observe(s => !!document.querySelector(s), row(t.fixtureDir)), 'the fixture folder in Folders');
}

// where to press a thumbnail: its photo, not the stars below it
async function grip(t, name) {
  await reveal(t, cell(name));
  const p = await t.driver.observe(center, `${cell(name)} .thumb-image`);
  assert(p, `${name} has a thumbnail`);
  return p;
}

async function rowAt(t, path) {
  const r = await reveal(t, row(path));
  return { x: r.x, y: r.y };
}

async function noDialog(t, what) {
  await pause(800);
  const s = await t.driver.observe(folderState);
  assert(!s.dialog, `${what}: no confirmation`);
  assert(!s.ghost, `${what}: the drag ghost is gone`);
  return s;
}

// the job's line under the photo, once it says what it did
const summary = (t, word) => until(() => t.driver.observe((w) =>
  [...document.querySelectorAll('.activity')].map((a) => a.textContent).find((x) => x.includes(w)) ?? null, word),
  `the job's summary (${word})`, 60000);

export async function movePhotos(t) {
  const fixtures = t.fixtureDir, ext = extOf(t.fixture.file);
  if (!ext || !await exists(join(fixtures, `move-a${ext}`))) throw new Blocked('move fixtures were not laid out');
  const a = `move-a${ext}`, dest = join(fixtures, 'dest'), inner = join(dest, 'inner');
  const original = await sha(join(fixtures, t.fixture.file));
  await until(() => t.driver.observe(s => !!document.querySelector(s), cell(a)), `${a} in the filmstrip`, 120000);
  await foldersCard(t);

  // three stars on move-a from its thumbnail, so it has a sidecar to carry
  const g = await grip(t, a);
  await t.driver.move(g.x, g.y);
  const star = await until(() => t.driver.observe(inspect, `${cell(a)} .thumb-stars button:nth-child(3)`), 'move-a stars');
  await t.driver.point(star.x, star.y);
  const xmp = join(fixtures, `${a}.xmp`);
  await until(async () => (await readFile(xmp, 'utf8').catch(() => '')).match(/xmp:Rating="3"|<xmp:Rating>3</), 'move-a sidecar rated 3');

  // the fixture folder shut, so a rest on it opens it (spring-loaded)
  if (await t.driver.observe(s => !!document.querySelector(s), row(dest))) {
    const twisty = await reveal(t, `${row(fixtures)} .twisty`);
    await t.driver.point(twisty.x, twisty.y);
    await until(() => t.driver.observe(s => !document.querySelector(s), row(dest)), 'the fixture folder shut');
  }
  const before = await t.driver.observe(folderState);
  const root = await rowAt(t, fixtures);
  await t.driver.hold(await grip(t, a), root);
  try {
    await until(() => t.driver.observe(folderState).then(s => s.ghost), 'the drag ghost');
    await until(() => t.driver.observe(s => !!document.querySelector(s), row(dest)), 'the fixture folder opens under the drag', 5000);
    t.measure({ name: 'spring-open', ...(await t.driver.observe(folderState)) });
    await t.evidence('spring-open');
    // Esc ends the drag where it is: nothing to confirm
    await t.driver.keys('');
  } finally { await t.driver.release(); }
  let s = await noDialog(t, 'Esc');
  assert.equal(s.active, before.active, 'the release did not open a folder');
  assert(await t.driver.observe(s => !!document.querySelector(s), row(dest)), 'a folder opened by the drag stays open');

  // the photo's own folder takes no drop
  await t.driver.drag(await grip(t, a), await rowAt(t, fixtures));
  s = await noDialog(t, 'own folder');
  assert.equal(s.active, before.active, 'dropping on the own folder does not open it');

  // a drop on dest asks first; Cancel leaves everything
  await t.driver.drag(await grip(t, a), await rowAt(t, dest));
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .btn.primary`), dialog), 'the move confirmation');
  const asked = await t.driver.observe(dialogText);
  t.measure({ name: 'confirmation', text: asked });
  await t.evidence('confirmation');
  assert(/Move Photos/.test(asked) && /Move 1 photo/.test(asked), `asks to move one photo (${asked})`);
  assert(asked.includes(dest), 'names the destination');
  await textButton(t, `${dialog} .modal-foot`, 'Cancel');
  await until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'the confirmation closed');
  assert(await exists(join(fixtures, a)) && !await exists(join(dest, a)), 'Cancel moves nothing');

  // into inner: a rest on the shut dest opens it, then the drop goes on to inner
  assert(!await t.driver.observe(s => !!document.querySelector(s), row(inner)), 'dest starts shut');
  const at = await rowAt(t, dest);
  await t.driver.hold(await grip(t, a), at);
  try {
    const box = await until(() => t.driver.observe(targetBox), 'dest highlighted under the drag', 5000);
    t.measure({ name: 'drop-highlight', ...box });
    await t.evidence('drop-highlight');
    assert(box.position !== 'fixed' && box.inside, `the highlight stays on the dest row (${JSON.stringify(box)})`);
    await until(() => t.driver.observe(s => !!document.querySelector(s), row(inner)), 'dest opens under the drag', 5000);
  } catch (e) { await t.driver.release(); throw e; }
  const to = await t.driver.observe(center, row(inner));
  await t.driver.dropAt(to, at);
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .btn.primary`), dialog), 'the move confirmation');
  await t.evidence('move-confirmation');
  await textButton(t, `${dialog} .modal-foot`, 'Move 1 photo');
  const done = await summary(t, 'Moved');
  t.measure({ name: 'moved', summary: done });
  await t.evidence('moved');
  assert(!/failed/.test(done), `the move did not fail (${done})`);
  await until(() => t.driver.observe(s => !document.querySelector(s), cell(a)), `${a} leaves the filmstrip`);

  // the files: verified copies in inner, nothing left at the source or half written
  assert.equal(await sha(join(inner, a)), original, 'the moved photo has the original bytes');
  assert(!await exists(join(fixtures, a)) && !await exists(xmp), 'the photo and its sidecar left the source');
  const moved = await readFile(join(inner, `${a}.xmp`), 'utf8');
  assert(/xmp:Rating="3"|<xmp:Rating>3</.test(moved), 'the sidecar arrived with the rating');
  const leftovers = (await readdir(inner)).filter(n => n.endsWith('.immage-part'));
  assert.deepEqual(leftovers, [], 'no part files left');

  // and the photo opens there with its stars
  await click(t, row(inner));
  await until(() => t.driver.observe(s => !!document.querySelector(s), cell(a)), `${a} listed in inner`, 60000);
  const stars = await until(() => t.driver.observe(s => document.querySelectorAll(`${s} .thumb-stars button.on`).length || null,
                                                   cell(a)), 'its rating shown');
  assert.equal(stars, 3, 'three stars came with it');
  await t.evidence('moved-folder');
}

export async function moveCopy(t) {
  const fixtures = t.fixtureDir, ext = extOf(t.fixture.file);
  if (!ext || !await exists(join(fixtures, 'clash', `move-b${ext}`))) throw new Blocked('move fixtures were not laid out');
  const b = `move-b${ext}`, c = `move-c${ext}`, clash = join(fixtures, 'clash');
  const original = await sha(join(fixtures, t.fixture.file));
  const other = await sha(join(clash, b));
  await foldersCard(t);
  if ((await t.driver.observe(folderState)).active !== fixtures) await click(t, row(fixtures));
  await until(() => t.driver.observe((x, y) => !!document.querySelector(x) && !!document.querySelector(y), cell(b), cell(c)),
              'move-b and move-c listed', 60000);
  if (!await t.driver.observe(s => !!document.querySelector(s), row(clash))) {
    const twisty = await reveal(t, `${row(fixtures)} .twisty`);
    await t.driver.point(twisty.x, twisty.y);
  }
  await reveal(t, row(clash));

  // both selected: a click, then ⌘/Ctrl-click
  await click(t, `${cell(b)} .thumb-image`);
  const second = await grip(t, c);
  const modifier = await t.driver.observe(() => /Mac/.test(navigator.userAgent) ? '' : '');
  await t.driver.modifiedPoint(modifier, second.x, second.y);
  await until(() => t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb.selected').length === 2), 'two selected');

  // Alt held through the drop: a copy
  await t.driver.modifiedDrag('', await grip(t, b), await rowAt(t, clash));
  await until(() => t.driver.observe(s => !!document.querySelector(`${s} .btn.primary`), dialog), 'the copy confirmation');
  let text = await t.driver.observe(dialogText);
  t.measure({ name: 'copy-confirmation', text });
  await t.evidence('copy-confirmation');
  assert(/Copy Photos/.test(text), `Alt makes it a copy (${text})`);
  assert(await t.driver.observe(s => document.querySelector(`${s} input[type=checkbox]`)?.checked, dialog), 'Keep the originals is ticked');
  assert(/already there, identical/.test(text), 'move-c is already there');
  assert(/Already there, with other content/.test(text) && text.includes(b), 'move-b clashes');
  assert(await t.driver.observe(s => document.querySelector(`${s} .btn.primary`)?.disabled, dialog), 'nothing to copy until a clash is kept');
  await textButton(t, dialog, 'Keep both for all');
  await until(async () => /Copy 1 photo/.test(await t.driver.observe(dialogText)), 'one photo to copy');
  await textButton(t, `${dialog} .modal-foot`, 'Copy 1 photo');
  const done = await summary(t, 'Copied');
  t.measure({ name: 'copied', summary: done });
  await t.evidence('copied');
  assert(!/failed/.test(done), `the copy did not fail (${done})`);

  // the incoming photo numbered beside the other file; nothing else touched
  assert.equal(await sha(join(clash, `move-b_1${ext}`)), original, 'Keep both wrote move-b_1 with the original bytes');
  assert.equal(await sha(join(clash, b)), other, 'the clashing file is untouched');
  assert.equal(await sha(join(clash, c)), original, 'the identical file is untouched');
  for (const n of [b, c]) assert.equal(await sha(join(fixtures, n)), original, `${n} stays at the source`);
  assert.deepEqual((await readdir(clash)).filter(n => n.endsWith('.immage-part')), [], 'no part files left');
  assert(await t.driver.observe((x, y) => !!document.querySelector(x) && !!document.querySelector(y), cell(b), cell(c)),
         'both stay in the filmstrip');
}
