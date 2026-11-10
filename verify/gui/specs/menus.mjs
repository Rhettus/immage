// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// The drawn File/Edit/Photo/View/Help menus (Windows and Linux). Quit, Add Folder
// (native dialog) and User Guide (opens a browser) are outside the app-only
// boundary and are never clicked.
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool, rangeSelector } from '../support/controls.mjs';
import { textButton, panel, Blocked } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto, startup } from './smoke.mjs';

const ESC = '';
const MENU_NAMES = ['File', 'Edit', 'Photo', 'View', 'Help'];
// styles.css .titlebar { height: 34px }
const TITLEBAR_HEIGHT = 34;

// the platform's notation of a Mac shortcut, copied from keys() in app/src/keys.ts
// for a non-Mac platform (importing it would need a browser's navigator)
const NAMES = [['⌘', 'Ctrl'], ['⌃', 'Ctrl'], ['⌥', 'Alt'], ['⇧', 'Shift']];
const keys = s => s.replace(/[⇧⌥⌘⌃]+(-(?=[a-z])|)/g, (m, dash, at) => {
  const names = NAMES.filter(([g]) => m.includes(g)).map(([, n]) => n).join('+');
  if (dash) return `${names}-`;
  const next = s[at + m.length];
  return next === undefined || next === ' ' || next === ')' ? names : `${names}+`;
});

// the menus as the app builds them for Windows and Linux, from app/src/menu.ts
async function expectedMenus() {
  let mod;
  try { mod = await import(new URL('../../../app/src/menu.ts', import.meta.url)); }
  catch (e) { throw new Blocked(`cannot load app/src/menu.ts (Node >= 22.18 strips types): ${e.message}`); }
  return mod.forPlatform(mod.MENUS, false);
}

const isOpen = t => t.driver.observe(() => !!document.querySelector('.menubar-menu'));
const expanded = (t, name) => t.driver.observe(n => document.querySelector(`[data-menu="${n}"]`)?.getAttribute('aria-expanded') === 'true', name);

async function openMenu(t, name) {
  if (!await expanded(t, name)) await click(t, `[data-menu="${name}"]`);
  await until(() => expanded(t, name), `${name} menu open`);
}
// choose a menu entry with real clicks: the title, then (for a submenu) its row, then the item
async function pick(t, menu, id, sub) {
  await openMenu(t, menu);
  if (sub) await click(t, `[data-menu-sub="${sub}"]`);
  await click(t, `[data-menu-item="${id}"]`);
  await until(async () => !(await isOpen(t)), `${menu} menu closed after ${id}`);
}
const readItems = (t, subSelector) => t.driver.observe(selector => [...document.querySelectorAll(selector)].map(b => ({
  id: b.dataset.menuItem, label: b.querySelector('span')?.textContent ?? '', keys: b.querySelector('.menubar-keys')?.textContent ?? null,
  visible: b.getBoundingClientRect().width > 0 })), subSelector);
const thumbs = t => t.driver.observe(() => document.querySelectorAll('.filmstrip .thumb:not(.ghost)').length);
const selectedThumbs = t => t.driver.observe(() => [...document.querySelectorAll('.filmstrip .thumb.selected')].map(e => e.dataset.imgid).sort());
const viewerZoom = t => t.driver.observe(() => document.querySelector('main.viewer').classList.contains('zoom-in') ? 'in' : 'fit');
const exposureValue = async t => +(await t.driver.observe(inspect, rangeSelector('exposure'))).value;

async function closePreferences(t) {
  await textButton(t, '.prefs-foot', 'Done');
  await until(() => t.driver.observe(() => !document.querySelector('.prefs')), 'Preferences closed');
}

// a settled Exposure edit, with the baseline photo; leaves Adjustments > Basic open
async function editExposure(t) {
  await openTool(t, 'adjust');
  await panel(t, 'basic');
  const selector = rangeSelector('exposure');
  let s = await reveal(t, selector);
  await t.driver.point(s.label.x, s.label.y, 2);
  await until(async () => Math.abs(await exposureValue(t)) < .02, 'neutral Exposure');
  const baseline = await settledPhoto(t);
  s = await reveal(t, selector);
  const at = v => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
  await t.driver.drag(at(0), at(1));
  await until(async () => (await exposureValue(t)) > .7, 'Exposure edit');
  const changed = await settledPhoto(t, p => p.luma > baseline.luma + 2);
  return { baseline, changed };
}
async function resetExposure(t, baseline) {
  const s = await reveal(t, rangeSelector('exposure'));
  await t.driver.point(s.label.x, s.label.y, 2);
  await until(async () => Math.abs(await exposureValue(t)) < .02, 'Exposure reset');
  await settledPhoto(t, p => p.hash === baseline.hash);
}

export async function menus(t) {
  const expected = await expectedMenus();
  assert.deepEqual(expected.map(m => m.label), MENU_NAMES, 'menu.ts gives File, Edit, Photo, View, Help on this platform');

  // 1. the strip: five titles inside .titlebar, whose height is the CSS value
  const strip = await t.driver.observe(names => {
    const bar = document.querySelector('.titlebar'), r = bar.getBoundingClientRect(), cs = getComputedStyle(bar);
    const nav = bar.querySelector('nav.menubar');
    return { bar: { height: r.height, css: cs.height, top: r.top, bottom: r.bottom }, nav: !!nav, role: nav?.getAttribute('role'),
      titles: names.map(n => {
        const b = bar.querySelector(`[data-menu="${n}"]`), br = b?.getBoundingClientRect();
        return b && { name: n, text: b.textContent.trim(), width: br.width, top: br.top, bottom: br.bottom, hit: document.elementFromPoint(br.x + br.width / 2, br.y + br.height / 2) === b };
      }) };
  }, MENU_NAMES);
  assert(strip.nav && strip.role === 'menubar', 'nav.menubar[role=menubar] is inside .titlebar');
  assert.equal(strip.bar.height, TITLEBAR_HEIGHT, `title bar is ${TITLEBAR_HEIGHT}px high`);
  assert.equal(strip.bar.css, `${TITLEBAR_HEIGHT}px`, 'computed title bar height equals the CSS value');
  for (const [i, n] of MENU_NAMES.entries()) {
    const title = strip.titles[i];
    assert(title, `${n} title exists inside .titlebar`);
    assert.equal(title.text, n);
    assert(title.width > 0 && title.top >= strip.bar.top && title.bottom <= strip.bar.bottom, `${n} fits inside the title bar`);
    assert(title.hit, `${n} receives hit testing`);
  }
  t.measure({ name: 'strip', titlebar: strip.bar, titles: strip.titles });
  await t.evidence('strip');

  // 2. opening, hover switching, Escape and outside click
  await click(t, '[data-menu="File"]');
  await until(() => expanded(t, 'File'), 'File opens on click');
  assert(await isOpen(t), 'a dropdown is shown');
  let edit = await reveal(t, '[data-menu="Edit"]');
  await t.driver.move(edit.x, edit.y);
  await until(async () => await expanded(t, 'Edit') && !await expanded(t, 'File'), 'hovering Edit switches the open menu');
  assert.equal((await t.driver.observe(() => document.querySelectorAll('.menubar-menu:not(.sub)').length)), 1, 'one dropdown at a time');
  await t.driver.keys(ESC);
  await until(async () => !(await isOpen(t)), 'Escape closes the menu');
  assert.equal(await t.driver.observe(() => document.querySelectorAll('[data-menu][aria-expanded="true"]').length), 0);
  await openMenu(t, 'File');
  const outside = await reveal(t, '.titlebar > span');
  await t.driver.point(outside.x, outside.y);
  await until(async () => !(await isOpen(t)), 'a click outside closes the menu');
  // hovering a title with no menu open opens nothing
  edit = await reveal(t, '[data-menu="Edit"]');
  await t.driver.move(edit.x, edit.y);
  await pause(300);
  assert(!await isOpen(t), 'hover alone does not open a closed menu bar');

  // 3. every item's label and shortcut text, for each menu and the submenus
  const seen = [];
  for (const menu of expected) {
    await openMenu(t, menu.label);
    const flat = menu.items.filter(i => i.kind === 'item'), subs = menu.items.filter(i => i.kind === 'submenu');
    const items = await readItems(t, '.menubar-menu:not(.sub) > [data-menu-item]');
    assert.deepEqual(items.map(i => i.id), flat.map(i => i.id), `${menu.label}: items in order`);
    for (const [i, it] of flat.entries()) {
      assert(items[i].visible, `${menu.label}/${it.id} is shown`);
      assert.equal(items[i].label, it.label, `${it.id} label`);
      assert.equal(items[i].keys, it.shortcut ? keys(it.shortcut) : null, `${it.id} shortcut text`);
      seen.push({ menu: menu.label, id: it.id, label: items[i].label, keys: items[i].keys });
    }
    for (const sub of subs) {
      await click(t, `[data-menu-sub="${sub.label}"]`);
      await until(() => t.driver.observe(() => !!document.querySelector('.menubar-menu.sub')), `${sub.label} submenu opens`);
      const rows = await readItems(t, '.menubar-menu.sub > [data-menu-item]');
      const want = sub.items.filter(i => i.kind === 'item');
      assert.deepEqual(rows.map(r => r.id), want.map(r => r.id), `${sub.label}: items in order`);
      for (const [i, it] of want.entries()) {
        assert.equal(rows[i].label, it.label);
        assert.equal(rows[i].keys, it.shortcut ? keys(it.shortcut) : null, `${it.id} shortcut text`);
        seen.push({ menu: `${menu.label}/${sub.label}`, id: it.id, label: rows[i].label, keys: rows[i].keys });
      }
      await t.evidence(`submenu-${sub.label.toLowerCase()}`);
    }
    if (menu.label === 'View') await t.evidence('view-menu-open');
    if (menu.label === 'Edit') await t.evidence('edit-menu-open');
    // Esc steps out of an open submenu first, then closes the menu
    if (subs.length) {
      await t.driver.keys(ESC);
      await until(() => t.driver.observe(() => !document.querySelector('.menubar-menu.sub')), `${menu.label} submenu closed`);
      assert(await isOpen(t), `Esc in a submenu leaves ${menu.label} open`);
    }
    await t.driver.keys(ESC);
    await until(async () => !(await isOpen(t)), `${menu.label} closed`);
  }
  t.measure({ name: 'shortcut-text', items: seen });

  // 4. effects, with real clicks on the menu items
  // Export... opens the export dialog
  await pick(t, 'File', 'export');
  await until(() => t.driver.observe(() => !!document.querySelector('.modal.export')), 'File > Export opens the export dialog');
  await t.evidence('export-from-menu');
  await textButton(t, '.export .modal-foot', 'Cancel');
  await until(() => t.driver.observe(() => !document.querySelector('.modal.export')), 'export dialog closed');

  // Print... shows the Print panel
  await pick(t, 'File', 'print');
  await until(async () => (await t.driver.observe(inspect, 'button[data-tour="print"]'))?.active, 'File > Print opens the Print panel');
  await t.evidence('print-from-menu');

  // Keyboard Shortcuts opens the sheet
  await pick(t, 'Help', 'shortcuts');
  await reveal(t, '.shortcuts');
  await t.evidence('shortcuts-from-menu');
  await textButton(t, '.shortcuts .modal-foot', 'Done');
  await until(() => t.driver.observe(() => !document.querySelector('.shortcuts')), 'shortcut sheet closed');

  // Preferences... opens Preferences
  await pick(t, 'Edit', 'preferences');
  await reveal(t, '.prefs');
  await t.evidence('preferences-from-menu');
  await closePreferences(t);

  // Import Photos... opens the importer
  await pick(t, 'File', 'import');
  await until(() => t.driver.observe(() => !!document.querySelector('.import-view')), 'File > Import Photos opens the importer');
  await t.evidence('import-from-menu');
  await textButton(t, '.import-head', 'Close');
  await until(() => t.driver.observe(() => !document.querySelector('.import-view')), 'importer closed');

  // Undo and Redo step the photo's history
  const { baseline, changed } = await editExposure(t);
  await pick(t, 'Edit', 'undo');
  await until(async () => Math.abs(await exposureValue(t)) < .02, 'Edit > Undo restores the slider');
  await settledPhoto(t, p => p.hash === baseline.hash);
  await t.evidence('undo-from-menu');
  await pick(t, 'Edit', 'redo');
  await until(async () => (await exposureValue(t)) > .7, 'Edit > Redo restores the edit');
  await settledPhoto(t, p => p.hash === changed.hash);
  await t.evidence('redo-from-menu');
  t.measure({ name: 'undo-redo', baselineHash: baseline.hash, changedHash: changed.hash });
  await resetExposure(t, baseline);

  // View > Zoom In zooms; Fit / Zoom returns
  assert.equal(await viewerZoom(t), 'fit', 'the photo starts fitted');
  await pick(t, 'View', 'zoom-in');
  await until(async () => await viewerZoom(t) === 'in', 'View > Zoom In changes the zoom');
  await t.evidence('zoomed-from-menu');
  await pick(t, 'View', 'zoom-toggle');
  await until(async () => await viewerZoom(t) === 'fit', 'View > Fit / Zoom returns to fit');

  // Grid View toggles the grid
  const grid = () => t.driver.observe(() => !!document.querySelector('.filmstrip.grid'));
  assert(!await grid(), 'the filmstrip starts as a strip');
  await pick(t, 'View', 'grid');
  await until(grid, 'View > Grid View shows the grid');
  await t.evidence('grid-from-menu');
  await pick(t, 'View', 'grid');
  await until(async () => !await grid(), 'View > Grid View again returns');

  // Show Clipping toggles the clipping layers
  const clipping = () => t.driver.observe(() => !!document.querySelector('canvas.layer.clip:not(.empty)'));
  assert(!await clipping(), 'clipping starts hidden');
  await pick(t, 'View', 'clipping');
  await until(clipping, 'View > Show Clipping shows the overlay');
  await t.evidence('clipping-from-menu');
  await pick(t, 'View', 'clipping');
  await until(async () => !await clipping(), 'View > Show Clipping again hides it');

  // Create Virtual Copy adds a filmstrip entry. Last, since it changes the library.
  // The copy lives in the run's own fixture folder; no case here deletes it.
  const before = await thumbs(t);
  await pick(t, 'Photo', 'virtual-copy');
  await until(async () => await thumbs(t) === before + 1, 'Photo > Create Virtual Copy adds a filmstrip entry');
  await t.evidence('virtual-copy-from-menu');
  t.measure({ name: 'virtual-copy', thumbsBefore: before, thumbsAfter: await thumbs(t) });
}

export async function menusGuards(t) {
  // markup: the strip is draggable, the menu buttons are not
  const drag = await t.driver.observe(() => {
    const bar = document.querySelector('.titlebar'), nav = bar.querySelector('nav.menubar');
    return { bar: bar.hasAttribute('data-tauri-drag-region'),
      label: bar.querySelector(':scope > span')?.hasAttribute('data-tauri-drag-region'),
      nav: nav.hasAttribute('data-tauri-drag-region'),
      inNav: [...nav.querySelectorAll('*')].filter(e => e.hasAttribute('data-tauri-drag-region')).map(e => e.tagName),
      buttons: [...nav.querySelectorAll('button')].length };
  });
  assert(drag.bar && drag.label, '.titlebar and its label keep data-tauri-drag-region');
  assert(!drag.nav && drag.inNav.length === 0, 'the menu bar and its buttons have no data-tauri-drag-region');
  assert(drag.buttons >= MENU_NAMES.length);
  t.measure({ name: 'drag-region', ...drag });

  // an edit to guard: undoing it from a text field must not step it
  const { baseline, changed } = await editExposure(t);

  // with a modal open (Preferences) the menus do nothing
  await click(t, 'button[data-tour="prefs"]');
  await reveal(t, '.prefs');
  const file = await t.driver.observe(() => {
    const b = document.querySelector('[data-menu="File"]'), r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, reachable: hit === b || b.contains(hit), hit: hit?.className };
  });
  t.measure({ name: 'menu-behind-modal', ...file });
  await t.evidence('modal-over-menu');
  if (file.reachable) {
    // the strip is above the backdrop: its items must still do nothing
    await openMenu(t, 'File');
    await click(t, '[data-menu-item="export"]');
    await pause(600);
    assert(!await t.driver.observe(() => !!document.querySelector('.modal.export')), 'Export does not open over Preferences');
  }
  assert(await t.driver.observe(() => !!document.querySelector('.prefs')), 'Preferences stays open');
  assert(!await t.driver.observe(() => !!document.querySelector('.modal.export')), 'no export dialog');
  if (await t.driver.observe(() => !!document.querySelector('.menubar-menu'))) await t.driver.keys(ESC);
  await closePreferences(t);

  // a focused text field keeps Select All and Undo
  // the Keywording card's field: always there, unlike the filter's find box
  // (shown only past 8 entries); it adds what it holds on blur, so it is
  // emptied before it loses focus
  const card = '.panel.keywording > .panel-title';
  const folded = !await t.driver.observe(sel => !!document.querySelector(sel)?.classList.contains('open'), card);
  if (folded) await click(t, card);
  const find = '.panel.keywording .kw-add input.field';
  const box = await reveal(t, find).catch(() => { throw new Blocked('the Keywording card has no field to type in'); });
  await t.driver.point(box.x, box.y);
  const text = t.fixture.file.replace(/\.[^.]+$/, '').slice(0, 4);
  await t.driver.keys(...text);
  const field = () => t.driver.observe(sel => {
    const e = document.querySelector(sel);
    return e && { value: e.value, start: e.selectionStart, end: e.selectionEnd, focused: document.activeElement === e };
  }, find);
  await until(async () => (await field()).value === text, 'typed text in the field');
  const selectionBefore = await selectedThumbs(t);

  await openMenu(t, 'Edit');
  const focus = await field();
  if (!focus.focused) throw Error('opening the Edit menu moved focus off the text field, so its Select All cannot act on the field (the page click lost the focus)');
  await t.evidence('field-edit-menu');
  await click(t, '[data-menu-item="select-all"]');
  await until(async () => { const f = await field(); return f.start === 0 && f.end === text.length; }, 'Edit > Select All selects the field text');
  assert.deepEqual(await selectedThumbs(t), selectionBefore, 'Select All with a field focused leaves the photo selection alone');

  // Undo with the field focused undoes typing, not the photo's history
  const exposureBefore = await exposureValue(t);
  await pick(t, 'Edit', 'undo');
  await pause(800);
  assert.equal(await exposureValue(t), exposureBefore, 'Undo in a text field does not step the photo history');
  const still = await settledPhoto(t);
  assert.equal(still.hash, changed.hash, 'the photo is still the edited one');
  t.measure({ name: 'field-guards', field: await field(), selectionBefore, exposure: exposureBefore });
  await t.evidence('field-undo');

  // clean up: empty the field so its blur adds nothing, fold the card, reset the edit
  await t.driver.point(box.x, box.y);
  await t.driver.chord('\uE009', 'a');
  await t.driver.keys('\uE003');
  await until(async () => (await field()).value === '', 'the field is empty again');
  if (folded) await click(t, card);
  assert.equal(await t.driver.observe(() => document.querySelectorAll('.kw-chip').length), 0, 'no keyword was added');
  await resetExposure(t, baseline);
}
