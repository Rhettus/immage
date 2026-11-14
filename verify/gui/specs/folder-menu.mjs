// SPDX-License-Identifier: GPL-3.0-or-later
// A Folders row's right-click menu (FolderTree.tsx FolderMenu, create_folder in
// library_cmds.rs): New Folder…, Show in the file manager, Remove from List.
// Every folder made stays inside this run's copied fixture folder. Show in the
// file manager is checked as offered only: clicking it opens another
// application, outside the app-only boundary
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Blocked, textButton } from '../support/scenario.mjs';
import { click, inspect, reveal } from '../support/controls.mjs';
import { until, pause } from '../support/webdriver.mjs';

const ENTER = '', ESC = '';
const row = (path) => `.folders [data-folder-path=${JSON.stringify(path)}]`;
const menu = '.context-menu';
const isDir = (p) => stat(p).then((s) => s.isDirectory(), () => false);
const present = (t, selector) => t.driver.observe((s) => !!document.querySelector(s), selector);

// observed in the page, so self-contained: null until the menu shows
const menuItems = () => {
  const list = [...document.querySelectorAll('.context-menu button')]
    .map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }));
  return list.length ? list : null;
};
const nameField = () => {
  const e = document.querySelector('.folders .name-edit');
  if (!e) return null;
  return { value: e.value, focused: document.activeElement === e,
           selected: e.selectionStart === 0 && e.selectionEnd === e.value.length };
};

async function foldersCard(t) {
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  await until(() => present(t, row(t.fixtureDir)), 'the fixture folder in Folders');
}

async function openMenu(t, path) {
  const r = await reveal(t, row(path));
  await t.driver.rightClick(r.x, r.y);
  return until(() => t.driver.observe(menuItems), `the menu of ${path}`);
}

// New Folder… on `parent`, then `name` typed over the selected default and Enter
async function newFolder(t, parent, name) {
  await openMenu(t, parent);
  await textButton(t, menu, 'New Folder…');
  const field = await until(() => t.driver.observe(nameField), 'the new folder name field');
  assert.equal(field.value, 'New Folder', 'the field starts with New Folder');
  assert(field.focused && field.selected, `the default name is selected for typing (${JSON.stringify(field)})`);
  await t.driver.keys(...name, ENTER);
  await until(() => t.driver.observe(nameField).then((f) => !f), 'the name field closed');
}

export async function folderMenu(t) {
  const root = t.fixtureDir;
  if (!root) throw new Blocked('no fixture folder');
  await foldersCard(t);

  // the menu: its three items, Show offered for a connected folder; Esc closes it
  const items = await openMenu(t, root);
  t.measure({ name: 'menu', items });
  await t.evidence('menu');
  assert.deepEqual(items.map((i) => i.text.replace(/^Show in .*/, 'Show in')),
                   ['New Folder…', 'Show in', 'Remove from List'], `the menu items (${JSON.stringify(items)})`);
  assert(items.every((i) => !i.disabled), 'all items enabled on a connected folder');
  assert(/^Show in (Finder|Explorer|File Manager)$/.test(items[1].text), `names the file manager (${items[1].text})`);
  await t.driver.keys(ESC);
  await until(() => present(t, menu).then((p) => !p), 'Esc closes the menu');

  // Esc in the name field makes nothing
  await openMenu(t, root);
  await textButton(t, menu, 'New Folder…');
  await until(() => t.driver.observe(nameField), 'the name field');
  await t.driver.keys(ESC);
  await until(() => t.driver.observe(nameField).then((f) => !f), 'Esc closes the name field');
  await pause(500);
  assert(!await isDir(join(root, 'New Folder')), 'Esc made no folder');

  // a new subfolder: made on disk and listed under its parent
  // lowercase names: the WebDriver keystrokes arrive without Shift, so a capital would be typed small
  const picks = join(root, 'picks');
  await newFolder(t, root, 'picks');
  await until(() => present(t, row(picks)), 'Picks listed under the fixture folder');
  assert(await isDir(picks), 'Picks made on disk');
  await t.evidence('created');

  // the same name again is refused, with the reason in the status line
  await newFolder(t, root, 'picks');
  const status = await until(() => t.driver.observe(() => {
    const s = document.querySelector('.status')?.textContent ?? '';
    return s.includes('already exists') ? s : null;
  }), 'the refusal in the status line');
  t.measure({ name: 'refused', status });
  await t.evidence('refused');
  assert.equal(await t.driver.observe(() => document.querySelectorAll('.folders [data-folder-path$="picks"]').length), 1,
               'still one Picks row');

  // inside a subfolder with no subfolders of its own: it opens to show the new one
  const inner = join(picks, 'inner');
  await newFolder(t, picks, 'inner');
  await until(() => present(t, row(inner)), 'Inner listed under Picks');
  assert(await isDir(inner), 'Inner made on disk');
  assert(await t.driver.observe((s) => document.querySelector(s)?.classList.contains('open'), `${row(picks)} .twisty`),
         'Picks shows open');
  await t.evidence('nested');

  // Remove from List takes the row off the tree and leaves the folder on disk
  await openMenu(t, inner);
  await textButton(t, menu, 'Remove from List');
  await until(() => present(t, row(inner)).then((p) => !p), 'Inner off the tree');
  assert(await isDir(inner), 'Inner stays on disk');
  assert(await present(t, row(picks)), 'Picks stays listed');
  await t.evidence('removed');
  // the Folders panel is left with no menu open
  assert(!await t.driver.observe(inspect, menu), 'no menu left open');
}
