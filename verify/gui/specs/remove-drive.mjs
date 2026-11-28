// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { click, reveal } from '../support/controls.mjs';
import { waitSetting } from '../support/settings.mjs';
import { until } from '../support/webdriver.mjs';

const paths = fixtureDir => {
  const share = join(dirname(fixtureDir), 'offline-photos');
  return { share, roots: ['first', 'second'].map(name => join(share, name)) };
};
const photo = (root, fixture) => join(root, `photo${extname(fixture)}`);
const sidecar = path => `${path}.xmp`;

export async function driveFixtures(fixtureDir, fixture) {
  const { share, roots } = paths(fixtureDir);
  for (const root of roots) {
    await mkdir(root, { recursive: true });
    const file = photo(root, fixture);
    await copyFile(fixture, file);
    await writeFile(sidecar(file), '<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');
  }
  return { share, roots };
}

export async function removeDrive(t) {
  const { share, roots } = paths(t.fixtureDir);
  const files = roots.flatMap(root => {
    const path = photo(root, t.fixture.file);
    return [path, sidecar(path)];
  });
  const snapshot = () => Promise.all(files.map(file => readFile(file)));
  const original = await snapshot();
  const heading = `.folder-volume[title=${JSON.stringify(share)}]`;
  const row = path => `.folders [data-folder-path=${JSON.stringify(path)}]`;
  const dialog = '.remove-drive-dialog[open]';
  const present = selector => t.driver.observe(s => !!document.querySelector(s), selector);

  if (!await present('.folders-panel > .panel-title.open')) await click(t, '.folders-panel > .panel-title');
  await until(() => present(`${heading} .drive-dot.off`), 'the offline drive heading', 30000);
  for (const root of roots) assert(!await present(row(root)), 'the drive starts collapsed');

  const openConfirmation = async () => {
    const h = await reveal(t, `${heading} .name`);
    await t.driver.move(h.x, h.y);
    await click(t, `${heading} button.remove`);
    await until(() => present(dialog), 'drive removal confirmation');
  };
  await openConfirmation();
  const message = await t.driver.observe(s => document.querySelector(s)?.textContent, `${dialog} .modal-body`);
  assert(message?.includes(basename(share)), 'confirmation identifies the drive');
  assert.match(message, /Photos and sidecars stay on the drive/);
  const cancelFocused = await t.driver.observe(s => {
    const d = document.querySelector(s);
    return d?.contains(document.activeElement) && document.activeElement.textContent === 'Cancel';
  }, dialog);
  assert(cancelFocused, 'Cancel receives focus when the confirmation opens');
  await t.driver.keys('\uE007');
  await until(async () => !await present(dialog), 'cancel closes the dialog');
  assert(await present(`${heading} .drive-dot.off`), 'cancel keeps the drive');
  const stored = expected => waitSetting(t, 'immage.library', value =>
    value && JSON.stringify(JSON.parse(value).folders) === JSON.stringify(expected), 'the expected saved Library folders');
  await stored([t.fixtureDir, ...roots]);

  await openConfirmation();
  // The dialog is in the browser's top layer, outside its ancestors' clips.
  const confirm = await until(() => t.driver.observe(s => {
    const button = [...document.querySelectorAll(`${s} button`)].find(b => b.textContent === 'Remove from List');
    if (!button || button.disabled) return null;
    const r = button.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return button.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  }, dialog), 'the confirmation button takes pointer input');
  await t.driver.point(confirm.x, confirm.y);
  await until(async () => !await present(heading) && await present(row(t.fixtureDir)), 'only the other drive’s folder remains');
  await stored([t.fixtureDir]);
  assert.deepEqual(await snapshot(), original, 'photos and sidecars are byte-for-byte unchanged');
  await t.evidence('drive-removed', '.folders-panel');
}
