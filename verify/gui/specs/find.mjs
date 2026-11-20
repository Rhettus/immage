// SPDX-License-Identifier: GPL-3.0-or-later
// Find (FindPanel.tsx, SavedFilterMenus.tsx): filters that apply as they change, and
// saved filters (Alt+1 to Alt+9). Find lives only in the grid's right-hand column
// (`.find-pop` inside `aside.right`): the toolbar's Find button enters the grid and
// focuses the box, and leaving the grid (the Library button) hides it. Everything is
// driven by WebDriver pointer and key actions inside the test webview.
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';

const pop = '.find-pop';
const ESC = '', ENTER = '', ALT = '', CONTROL = '';
const cells = '.filmstrip .thumb[data-imgid]';
const present = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const count = (t, selector) => t.driver.observe(s => document.querySelectorAll(s).length, selector);
const rectOf = (t, selector) => t.driver.observe(s => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}, selector);
// the filters that are on: their rows (the accordion has no chips), with their summaries
const filtersOn = t => t.driver.observe(() => [...document.querySelectorAll('.find-pop .fr-row.on')].map(r => ({
  category: r.querySelector('.fr-title')?.textContent.trim(), text: r.querySelector('.fr-sum')?.textContent.trim() ?? '' })));
const findClass = (t, name) => t.driver.observe(n => document.querySelector('.find-button')?.classList.contains(n), name);

// flip a General preference switch by its row (PrefRow's data-pref-label)
async function preference(t, label, on) {
  // a click landing while an auto-hide column slides can go unanswered: try again
  for (let i = 0; i < 3 && !await present(t, '.prefs'); i++) {
    await click(t, 'button[data-tour="prefs"]');
    try { await until(() => present(t, '.prefs'), 'Preferences', 3000); } catch (e) { if (i === 2) throw e; }
  }
  const row = `.prefs [data-pref-label="${label}"] input.switch`;
  if (!await present(t, row)) await textButton(t, '.prefs-tabs', 'General');
  await until(() => present(t, row), `the ${label} switch`);
  if (await t.driver.observe(s => document.querySelector(s).checked, row) !== on) await click(t, row);
  await until(async () => await t.driver.observe(s => document.querySelector(s).checked, row) === on, `${label} ${on ? 'on' : 'off'}`);
  await textButton(t, '.prefs-foot', 'Done');
  await until(async () => !await present(t, '.prefs'), 'Preferences closes');
}

// the toolbar's Find button enters the grid and shows the column (it stays open there)
async function openFind(t) {
  if (!await present(t, pop)) await click(t, '.find-button');
  await until(() => present(t, pop), 'Find column');
}
// Find lives in the grid only: leaving the grid (the Library button) hides it
async function closeFind(t) {
  if (await present(t, '.filmstrip.grid')) await click(t, '.rail .library-toggle');
  await until(async () => !await present(t, pop), 'Find leaves with the grid');
}
// the Adjustments panel is in the page while the grid shows Find in its place
const adjustmentsVisible = t => t.driver.observe(() => {
  const p = document.querySelector('aside.right .panels');
  return !!p && p.getBoundingClientRect().height > 0;
});
// the popup's rectangle once it has stopped moving
async function settle(t) {
  let last = await rectOf(t, pop);
  for (let i = 0; i < 20; i++) {
    await pause(120);
    const next = await rectOf(t, pop);
    if (next && last && ['left', 'top', 'width', 'height'].every(k => Math.abs(next[k] - last[k]) < 0.5)) return next;
    last = next;
  }
  return last;
}
const near = (a, b, label, tolerance = 1.5) => {
  for (const k of ['left', 'top', 'width', 'height'])
    assert(Math.abs(a[k] - b[k]) <= tolerance, `${label}: ${k} ${a[k]} vs ${b[k]}`);
};
// open a filter's editor under its row (a no-op when it is open already)
// observe() sends only the callback's source to the page, so each callback finds its row itself
async function category(t, name) {
  if (await t.driver.observe(n => [...document.querySelectorAll('.find-pop .fr-row')]
    .find(c => c.querySelector('.fr-title')?.textContent === n)?.getAttribute('aria-expanded') === 'true', name)) return;
  const point = await until(() => t.driver.observe(n => {
    const e = [...document.querySelectorAll('.find-pop .fr-row')].find(c => c.querySelector('.fr-title')?.textContent === n);
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name), `${name} row`);
  await t.driver.point(point.x, point.y);
  await until(() => t.driver.observe(n => [...document.querySelectorAll('.find-pop .fr-row')]
    .find(c => c.querySelector('.fr-title')?.textContent === n)?.getAttribute('aria-expanded') === 'true', name), `${name} editor`);
}
const stars = n => `${pop} .fe-stars button[aria-label="${n} stars and up"]`;

// Setting a value turns its filter row on and narrows the grid with nothing pressed; the
// row's x removes it; in the grid Find is the locked right-hand column, which
// has no Show N, grip, size buttons or close, and Escape in its box only leaves
// the box. Needs three or more photos (find-NN copies), one of which the case rates
export async function findLive(t) {
  await until(() => t.driver.observe(s => document.querySelectorAll(s).length >= 3, cells), 'three photos in the folder', 120000);
  // the rail's Library button enters the grid, and is never disabled
  const library = '.rail .library-toggle';
  assert(!await t.driver.observe(s => document.querySelector(s)?.disabled, library), 'the Library button is enabled');
  if (!await present(t, '.filmstrip.grid')) await click(t, library);
  await until(() => present(t, '.filmstrip.grid'), 'grid view');
  assert(await t.driver.observe(s => document.querySelector(s).classList.contains('on'), library), 'the Library button is on in the grid');
  const all = await count(t, cells);

  // rate one copy three stars through its hover footer, so a rating filter has something to keep
  const target = await t.driver.observe(s => {
    const r = document.querySelectorAll(s)[1].getBoundingClientRect();
    return { id: document.querySelectorAll(s)[1].dataset.imgid, x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, cells);
  await t.driver.move(target.x, target.y);
  const cell = `.filmstrip.grid .thumb[data-imgid="${target.id}"]`;
  await click(t, `${cell} .thumb-stars button:nth-child(3)`);
  await until(() => t.driver.observe(s => document.querySelector(`${s} .thumb-stars button:nth-child(3)`)?.classList.contains('on'), cell),
    'one photo rated three stars');

  await openFind(t);
  await settle(t);
  assert.equal((await filtersOn(t)).length, 0, 'no filter is on before anything is set');
  assert(!await present(t, `${pop} .find-chip`), 'there are no chips');
  assert(!await findClass(t, 'on'), 'the toolbar Find button is not on without filters');

  // 1. a rating, from the Rating & flags editor (open first)
  await category(t, 'Rating & flags');
  await click(t, stars(3));
  await until(async () => (await filtersOn(t)).some(c => c.category === 'Rating & flags' && c.text === '3+ stars'), 'the Rating & flags row shows 3+ stars');
  await until(async () => await count(t, cells) < all, 'the grid narrows without pressing Show');
  assert.equal(await count(t, cells), 1, 'only the rated photo remains');
  assert(await findClass(t, 'on'), 'the toolbar Find button is on');
  await t.evidence('find-live-rating');

  // the row's x removes it and the grid is whole again
  await click(t, `${pop} .fr-x[aria-label="Remove Rating & flags"]`);
  await until(async () => (await filtersOn(t)).length === 0, 'the filter is removed');
  await until(async () => await count(t, cells) === all, 'the grid is restored');

  // 2. a File type value: its row on, the same photos (the copies are one type)
  await category(t, 'File type');
  assert(!await present(t, `${pop} #find-ed-rating`), 'opening File type closes the Rating & flags editor');
  await click(t, `${pop} .fr-editor .filter-ticks button`);
  await until(async () => (await filtersOn(t)).some(c => c.category === 'File type'), 'the File type row shows a value');
  assert.equal(await count(t, cells), all, 'the copies all match their own file type');
  await click(t, `${pop} .fr-x[aria-label="Remove File type"]`);
  await until(async () => (await filtersOn(t)).length === 0, 'the File type filter is removed');

  // 3. the column is locked: no Show N, grip or close, and the grid still shows beside it
  await category(t, 'Rating & flags');
  await click(t, stars(3));
  await until(async () => await count(t, cells) === 1, 'rating filter on again');
  assert(await present(t, pop), 'in the grid Find is the locked column');
  assert(!await present(t, `${pop} .find-show`), 'no Show N in the column');
  assert(!await present(t, `${pop} .find-grip`), 'no grip in the column');
  const col = await rectOf(t, pop), strip = await rectOf(t, '.filmstrip.grid');
  assert(col && strip && strip.left + strip.width <= col.left + col.width && (strip.left + strip.width <= col.left + 1 || col.left + col.width <= strip.left + 1),
    'the grid and the column do not overlap');
  await t.evidence('find-live-column');

  // 4. Escape in the search box leaves the box; the column and the filter stay
  await click(t, `${pop} .find-text`);
  await t.driver.keys(ESC);
  assert(await present(t, pop) && await present(t, '.filmstrip.grid'), 'Escape in the box keeps the column and the grid');
  assert(await findClass(t, 'on'), 'the Find button stays on');
  assert.equal(await count(t, cells), 1, 'Escape keeps the filter');
  await click(t, '.toolbar .clear-filters');
  await until(async () => await count(t, cells) === all, 'clearing the filters restores the grid');

  // 5. the title bar's reset icon clears the search words and every filter; it is disabled
  // only with no filter on and the box empty, so words alone enable it. Search in and the
  // Smart/Filename mode stay as they were
  const clearButton = () => t.driver.observe(() => {
    const b = document.querySelector('.find-pop .find-clear');
    return { inTitle: !!b?.closest('.panel-head'), disabled: !!b?.disabled, label: b?.getAttribute('aria-label'), title: b?.title,
      inFilters: !!document.querySelector('.find-pop .find-filters-head .find-clear') };
  });
  const before = await clearButton();
  assert(before.disabled, 'Clear is disabled with no filter on and no words');
  assert(before.inTitle, 'Clear is in the panel title bar');
  assert.equal(before.label, 'Clear search and filters', 'Clear has its label');
  assert.equal(before.title, 'Clear search and filters', 'Clear has its title');
  assert(!before.inFilters, 'the Filters header has no Clear');
  await click(t, `${pop} .find-text`);
  await t.driver.keys(...'zzznomatch', ENTER);
  await until(async () => await count(t, cells) === 0, 'words that match nothing empty the grid');
  assert(!(await clearButton()).disabled, 'Clear is enabled with search words alone');
  await category(t, 'Rating & flags');
  await click(t, stars(3));
  await until(async () => (await filtersOn(t)).length === 1, 'a filter is on');
  assert.equal(await t.driver.observe(s => document.querySelector(s).textContent, `${pop} .find-active`), '1 active', 'the header counts one active filter');
  const kept = () => t.driver.observe(() => ({
    searchIn: document.querySelector('.find-pop .find-where')?.textContent.trim(),
    mode: document.querySelector('.find-pop .find-modewhere .segmented button.active')?.textContent.trim() }));
  const scope = await kept();
  await click(t, `${pop} .find-clear`);
  await until(async () => (await filtersOn(t)).length === 0, 'Clear turns the filters off');
  await until(async () => await t.driver.observe(s => document.querySelector(s).value, `${pop} .find-text`) === '', 'Clear empties the search words');
  await until(async () => await count(t, cells) === all, 'Clear shows every photo again');
  assert.deepEqual(await kept(), scope, 'Clear keeps Search in and the mode');
  assert((await clearButton()).disabled, 'Clear is disabled again once the filters and words are empty');
  await t.evidence('find-clear-all');
  // the words, typed and cleared, leave the grid whole
  await click(t, `${pop} .find-text`);
  await t.driver.keys(...'zzznomatch', ENTER);
  await until(async () => await count(t, cells) === 0, 'words that match nothing empty the grid again');
  await click(t, `${pop} .find-clear`);
  await until(async () => await count(t, cells) === all, 'clearing the words restores the grid');

  // With auto-hide, the Find pin sits beside Reset in the title row.
  assert.equal(await t.driver.observe(s => document.querySelector(`${s} .panel-head h1`)?.textContent, pop), 'Find', 'the column is titled Find');
  await preference(t, 'Auto-hide panels', true);
  try {
    await until(() => present(t, `${pop} .panel-head .pin`), 'the pin in the Find title row');
    const g = await t.driver.observe(s => {
      const box = q => document.querySelector(`${s} ${q}`).getBoundingClientRect();
      const head = document.querySelector(`${s} .panel-head`), cs = getComputedStyle(head);
      const pin = box('.panel-head .pin'), title = box('.panel-head h1'), reset = box('.panel-head .find-clear');
      return { pinMid: pin.top + pin.height / 2, titleMid: title.top + title.height / 2, pinRight: pin.right,
               resetLeft: reset.left, resetRight: reset.right,
               end: head.getBoundingClientRect().right - parseFloat(cs.paddingRight), inRow: !document.querySelector(`${s} .find-head .pin`) };
    }, pop);
    assert(g.inRow, 'the pin is not in the search row');
    assert(Math.abs(g.pinMid - g.titleMid) <= 2, `the pin is centered on the title (${g.pinMid} vs ${g.titleMid})`);
    assert(g.pinRight <= g.resetLeft && Math.abs(g.resetRight - g.end) <= 1, 'the pin precedes Reset at the end of the title row');
    // pinned, the column stays shown for the picture: rest on the rail to bring it in first
    // the reveal is a hover, so the pointer rests on the rail until the column is in view
    // (one move can land before the rail has its hover, and nothing else would re-send it)
    const rail = await rectOf(t, '.rail');
    const restOnRail = async () => {
      await t.driver.move(rail.left + rail.width / 2, rail.top + rail.height * 0.6);
      return t.driver.observe(s => document.querySelector(s).getBoundingClientRect().right <= innerWidth, `${pop} .panel-head .pin`);
    };
    await until(restOnRail, 'the column comes in from the rail', 8000);
    await click(t, `${pop} .panel-head .pin`);
    await until(() => present(t, `${pop} .panel-head .pin.on`), 'the right column pinned');
    await pause(400);
    await t.evidence('find-live-pin');
    await click(t, `${pop} .panel-head .pin`);
    await until(async () => !await present(t, `${pop} .panel-head .pin.on`), 'the right column unpinned');
  } finally {
    await preference(t, 'Auto-hide panels', false);
  }

  // the toolbar's Find button focuses the box of the column that is already there
  await click(t, '.toolbar .find-button');
  await until(() => t.driver.observe(() => document.activeElement?.classList.contains('find-text')), 'the Find button focuses the search box');
  assert(await present(t, pop), 'no popup opens in the grid');

  // the magnifier: only in the grid, and it opens the culling lightbox
  const lightbox = '.modal-backdrop[aria-label="Culling preview"]';
  // nothing is selected or hovered here: it opens the first photo
  await click(t, '.toolbar button.culling-open');
  await until(() => present(t, lightbox), 'the magnifier opens the culling preview');
  await t.driver.keys(ESC);
  await until(async () => !await present(t, lightbox), 'the preview closes');

  // opening a photo for editing from the grid, then the Library button comes back to it
  const first = await t.driver.observe(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, `.filmstrip.grid .thumb[data-imgid]`);
  await t.driver.point(first.x, first.y, 2);
  await until(async () => !await present(t, '.filmstrip.grid'), 'a double-click opens the photo and leaves the grid');
  assert(!await present(t, pop), 'Find is gone outside the grid');
  assert(await present(t, 'aside.right .panels'), 'the normal right panel is back');
  assert(!await present(t, 'button.culling-open'), 'no magnifier outside the grid');
  assert(!await t.driver.observe(s => document.querySelector(s).disabled, library), 'the Library button is enabled with a photo open');
  await click(t, library);
  await until(() => present(t, '.filmstrip.grid'), 'the Library button returns to the grid');
  await until(() => present(t, pop), 'Find is the column again');
  // and back out with the same button
  await click(t, library);
  await until(async () => !await present(t, '.filmstrip.grid'), 'the Library button leaves the grid');
  assert(await present(t, 'aside.right .panels'), 'the right panel is restored');
  t.measure({ name: 'find-live', photos: all });
}

// Find is only the grid's right-hand column, entered and left with the grid (see findSizes)
// Find is only the grid's right-hand column: outside the grid there is no column, and the
// toolbar's Find button enters the grid, shows it in aside.right and focuses its box. From
// the Print panel the same button brings Find back in place of Print. Leaving the grid
// removes the column and brings the Adjustments panel back
export async function findSizes(t) {
  await until(() => present(t, cells), 'a photo in the library', 120000);
  // start in the filmstrip view, the editing view
  if (await present(t, '.filmstrip.grid')) await click(t, '.rail .library-toggle');
  await until(async () => !await present(t, '.filmstrip.grid'), 'filmstrip view');
  assert(!await present(t, pop), 'there is no Find column in the filmstrip view');
  assert(await adjustmentsVisible(t), 'the Adjustments panel shows in the filmstrip view');

  // the toolbar's Find button enters the grid and shows Find in the right column
  await click(t, '.find-button');
  await until(() => present(t, pop), 'Find column');
  assert(await t.driver.observe(() => !!document.querySelector('aside.right .find-pop')), 'Find is in the right-hand column');
  await until(() => t.driver.observe(() => document.activeElement?.classList.contains('find-text')), 'the Find button focuses the search box');
  assert(await present(t, '.filmstrip.grid'), 'the grid is shown');
  assert(!await adjustmentsVisible(t), 'the Adjustments panel is not visible while Find is');
  const shape = await t.driver.observe(() => {
    const e = document.querySelector('.find-pop');
    return { position: getComputedStyle(e).position, grip: !!e.querySelector('.find-grip'), show: !!e.querySelector('.find-show') };
  });
  assert.notEqual(shape.position, 'fixed', 'Find is not a floating popup');
  assert(!shape.grip, 'Find has no grip');
  assert(!shape.show, 'Find has no Show N');
  await t.evidence('find-column');

  // from the Print panel, the same button brings Find back in place of Print
  await click(t, 'button[data-tour="print"]');
  await until(async () => !await present(t, pop), 'Print replaces Find in the column');
  await click(t, '.find-button');
  await until(() => present(t, pop), 'Find comes back from Print');
  assert(!await adjustmentsVisible(t), 'Find is shown, not Print or Adjustments, after Print');

  // pressing the button again in the grid keeps Find open
  await click(t, '.find-button');
  assert(await present(t, pop), 'the Find button keeps Find open in the grid');

  // leaving the grid removes the column and brings the Adjustments panel back
  await closeFind(t);
  assert(await adjustmentsVisible(t), 'the Adjustments panel is back outside the grid');
  t.measure({ name: 'find-sizes' });
}

export async function findPanelMemory(t) {
  const toggle = kind => `.view-tools button[data-panel-toggle="${kind}"]`;
  const adjust = toggle('right');
  const find = toggle('find');
  const library = '.rail .library-toggle';
  const waitForPanel = async (active, inactive, content, grid, open, expectedWidth) => {
    const state = await until(() => t.driver.observe((a, other, panel, inGrid, isOpen, width) => {
      const button = document.querySelector(a);
      const slot = document.querySelector('.right-slot');
      const aside = slot?.querySelector('aside.right');
      if (!button || document.querySelector(other) || !aside || !!document.querySelector('.filmstrip.grid') !== inGrid) return null;
      const visible = !slot.classList.contains('closed') && !!aside.querySelector(panel)?.getBoundingClientRect().height;
      const panelWidth = aside.getBoundingClientRect().width;
      const slotWidth = slot.getBoundingClientRect().width;
      return visible === isOpen && button.getAttribute('aria-pressed') === String(isOpen)
        && Math.abs(slotWidth - (isOpen ? panelWidth : 0)) <= 1
        && (!isOpen || width === null || Math.abs(panelWidth - width) <= 1)
        ? { width: panelWidth, title: button.title } : null;
    }, active, inactive, content, grid, open, expectedWidth ?? null),
    `${grid ? 'Find' : 'Adjustments'} ${open ? 'open' : 'closed'}${expectedWidth === undefined ? '' : ` at ${expectedWidth}px`}`);
    assert(state.title.trim(), 'panel toggle has a tooltip');
    return state;
  };
  const adjustments = (open, width) => waitForPanel(adjust, find, '.panels', false, open, width);
  const findPanel = (open, width) => waitForPanel(find, adjust, pop, true, open, width);
  const resize = async (width, readPanel) => {
    const before = await readPanel(true);
    const handle = await reveal(t, '.splitter.x:has(+ .right-slot)');
    const from = { x: Math.round(handle.x), y: Math.round(handle.y) };
    await t.driver.drag(from, { x: from.x + Math.round(before.width - width), y: from.y });
    await readPanel(true, width);
  };

  await until(() => present(t, cells), 'a photo in the library', 120000);
  await preference(t, 'Auto-hide panels', false);
  if (await present(t, '.filmstrip.grid')) await click(t, library);
  const adjustRail = 'button[data-tour="adjust"]';
  if (!await present(t, `${adjustRail}.on`)) await click(t, adjustRail);
  const editPanel = await adjustments(true);
  await resize(390, adjustments);
  assert(!await present(t, pop), 'Find is absent in editing view');
  await t.evidence('adjustments-resized');

  await click(t, '.toolbar .find-button');
  const gridPanel = await findPanel(true);
  assert.notEqual(gridPanel.title, editPanel.title, 'Find and Adjustments have distinct tooltips');
  assert(!await adjustmentsVisible(t), 'Adjustments is hidden in the grid');
  await resize(500, findPanel);
  await t.evidence('find-resized');

  await click(t, find);
  await findPanel(false);
  await click(t, library);
  await adjustments(true, 390);
  await click(t, library);
  await findPanel(false);
  await click(t, find);
  await findPanel(true, 500);

  await click(t, library);
  await adjustments(true, 390);
  await click(t, adjust);
  await adjustments(false);
  await click(t, library);
  await findPanel(true, 500);
  await click(t, adjustRail);
  await adjustments(false);
  await click(t, adjust);
  await adjustments(true, 390);
  await click(t, library);
  await findPanel(true, 500);
  await click(t, find);
  await findPanel(false);
  await preference(t, 'Auto-hide panels', true);
  await click(t, find);
  const search = await reveal(t, `${pop} .find-text`);
  await t.driver.move(search.x, search.y);
  await pause(750);
  assert(await present(t, '.right-slot.floating.revealed'), 'Find stays open while the pointer is inside');
  await t.driver.move(550, search.y);
  await until(async () => !await present(t, '.right-slot.revealed'), 'Find auto-hides after the pointer leaves');
  const rail = await rectOf(t, '.rail');
  await t.driver.move(rail.left + rail.width / 2, rail.top + rail.height * 0.6);
  await reveal(t, `${pop} .find-text`);
  await preference(t, 'Auto-hide panels', false);
  t.measure({ name: 'find-panel-memory', adjustmentsWidth: 390, findWidth: 500 });
}

// Save filter… and its name line, "changed" and Update, Alt+1 on a cleared
// filter, and the Manage dialog's rename and delete
export async function findSaved(t) {
  await until(() => present(t, cells), 'a photo in the library', 120000);
  await openFind(t);
  await settle(t);
  const dialogName = async name => {
    const input = '.save-filter input[type="text"]';
    await until(() => present(t, input), 'name field');
    await click(t, input);
    await t.driver.chord(CONTROL, 'a');
    await t.driver.keys(...name);
    await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, input, name), 'name typed');
  };

  // a filter to keep: three stars and up
  await category(t, 'Rating & flags');
  await click(t, stars(3));
  await until(async () => (await filtersOn(t)).some(c => c.category === 'Rating & flags'), 'the rating row is on');
  assert(!await present(t, `${pop} .saved-line`), 'no saved filter is in use yet');
  await click(t, `${pop} .find-save`);
  await dialogName('Find test');
  await t.evidence('find-saved-dialog');
  await t.driver.keys(ENTER);
  await until(() => present(t, `${pop} .saved-line`), 'the saved filter line');
  assert.equal(await t.driver.observe(() => document.querySelector('.find-pop .saved-line .saved-name').textContent), 'Find test');
  assert(!await present(t, `${pop} .saved-changed`), 'not changed straight after saving');

  // change it: changed and Update, and Update takes the change in
  await category(t, 'Edit status');
  await click(t, `${pop} .fr-editor .segmented button:nth-child(2)`);
  await until(() => present(t, `${pop} .saved-changed`), 'the line says changed');
  await t.evidence('find-saved-changed');
  await textButton(t, `${pop} .saved-line`, 'Update');
  await until(async () => !await present(t, `${pop} .saved-changed`), 'Update takes the change in');

  // clear everything, close, and Alt+1 re-applies it. Escape folds an open editor before it
  // closes the popup, and Edit status's editor is still open here: fold it first
  await click(t, `${pop} .find-clear`);
  await until(async () => (await filtersOn(t)).length === 0, 'cleared');
  if (await t.driver.observe(() => [...document.querySelectorAll('.find-pop .fr-row')].some(r => r.getAttribute('aria-expanded') === 'true')))
    await t.driver.keys(ESC);
  await closeFind(t);
  assert(!await findClass(t, 'on'), 'no filter is on once cleared');
  await t.driver.chord(ALT, '1');
  await until(() => findClass(t, 'on'), 'Alt+1 applies the saved filter');
  await openFind(t);
  const back = await filtersOn(t);
  const rating = back.find(c => c.category === 'Rating & flags');
  assert(rating, 'the rating row is on again');
  const edits = back.find(c => c.category === 'Edit status');
  assert(rating.text.includes('3+ stars') && edits?.text.includes('Edited'),
    `the updated filter was applied (${rating.text}; ${edits?.text})`);
  assert.equal(await t.driver.observe(() => document.querySelector('.find-pop .saved-line .saved-name')?.textContent), 'Find test',
    'the saved name shows');
  await t.evidence('find-saved-applied');
  await closeFind(t);

  // the menu on the toolbar's Find split button lists it with its shortcut, and opens Manage
  await click(t, '.find-saved .saved-menu-button');
  const item = await until(() => t.driver.observe(() => {
    const e = document.querySelector('.saved-list .saved-item');
    return e && { name: e.querySelector('.name').textContent, tag: e.querySelector('.tag')?.textContent ?? '', checked: e.getAttribute('aria-checked') };
  }), 'the saved list');
  assert.equal(item.name, 'Find test');
  assert(item.tag.includes('1'), `its Alt+1 shortcut is shown (${item.tag})`);
  assert.equal(item.checked, 'true', 'the applied filter is checked');
  await textButton(t, '.saved-list', 'Manage saved filters…');
  await until(() => present(t, '.saved-manage'), 'Manage dialog');
  await t.evidence('find-saved-manage');

  // rename
  await textButton(t, '.saved-manage', 'Rename');
  const input = '.saved-manage input[type="text"]';
  await until(() => present(t, input), 'rename field');
  await click(t, input);
  await t.driver.chord(CONTROL, 'a');
  await t.driver.keys(...'Renamed filter', ENTER);
  await until(() => t.driver.observe(() => document.querySelector('.saved-manage .row .name')?.textContent === 'Renamed filter'), 'the new name shows');

  // delete, with its confirmation
  await textButton(t, '.saved-manage', 'Delete');
  await until(() => t.driver.observe(() => document.querySelector('.saved-manage')?.textContent.includes('Delete this filter?')), 'delete asks first');
  await textButton(t, '.saved-manage', 'Delete');
  await until(async () => await count(t, '.saved-manage .saved-rows .row') === 0, 'the saved filter is deleted');
  await textButton(t, '.saved-manage .modal-foot', 'Done');
  await until(async () => !await present(t, '.saved-manage'), 'Manage closes');

  // leave the filter off
  if (await findClass(t, 'on')) await click(t, '.toolbar .clear-filters');
  t.measure({ name: 'find-saved' });
}

// Find with no CLIP model (the isolated profile has none) and no Immich: the
// grid's locked column offers file names only, with the tip about the model.
// Needs three or more photos (find-NN copies). The right-click, which can
// leave later left-button drags without their press, comes last
export async function findNoClip(t) {
  await until(() => t.driver.observe(s => document.querySelectorAll(s).length >= 3, cells), 'three photos in the folder', 120000);
  const library = '.rail .library-toggle';
  if (!await present(t, '.filmstrip.grid')) await click(t, library);
  await until(() => present(t, '.filmstrip.grid'), 'grid view');
  await until(() => present(t, pop), 'the locked Find column');
  const all = await count(t, cells);
  const head = `${pop} .find-head > .find-row:first-child`;

  // file names only: Filename shows as active, Smart is there but unavailable, and the box says so
  const modes = await t.driver.observe(() => [...document.querySelectorAll('.find-pop .find-modewhere .segmented button')]
    .map(b => ({ text: b.textContent.trim(), on: b.classList.contains('active'), disabled: b.getAttribute('aria-disabled') === 'true', title: b.title })));
  assert.equal(modes.length, 2, 'the Smart/Filename switch stays without the model');
  assert(modes[0].disabled && !modes[0].on && /CLIP/.test(modes[0].title), `Smart is unavailable and says why (${JSON.stringify(modes[0])})`);
  assert(modes[1].on, 'Filename shows as active');
  await click(t, `${pop} .find-modewhere .segmented button`);
  assert(await t.driver.observe(() => document.querySelectorAll('.find-pop .find-modewhere .segmented button')[1].classList.contains('active')), 'clicking Smart changes nothing');
  // the mode row and the search row each stay on one line
  const oneLine = await t.driver.observe(() => [...document.querySelectorAll('.find-pop .find-modewhere, .find-pop .find-head > .find-row:first-child')]
    .map(r => { const tops = [...r.children].map(e => e.getBoundingClientRect()).filter(b => b.height > 0).map(b => Math.round(b.top + b.height / 2)); return Math.max(...tops) - Math.min(...tops); }));
  assert(oneLine.every(d => d <= 2), `search row and mode row are single lines (${oneLine})`);
  // the analysis indicator shows, dimmed, without the model
  const indicator = await t.driver.observe(() => { const e = document.querySelector('.find-pop .analysis-status'); return e && { off: e.dataset.state === 'off', disabled: e.getAttribute('aria-disabled') === 'true', label: e.getAttribute('aria-label') }; });
  assert(indicator && indicator.off && indicator.disabled && /CLIP/.test(indicator.label), `the analysis indicator is dimmed and says the model is missing (${JSON.stringify(indicator)})`);
  const placeholder = await t.driver.observe(s => document.querySelector(s)?.placeholder, `${pop} .find-text`);
  assert(placeholder && placeholder !== 'sunset on a beach' && /file name/i.test(placeholder), `the box says it searches file names (${placeholder})`);

  // the tip appears once the status is known, with its two buttons
  await until(() => present(t, `${pop} .find-tip`), 'the CLIP tip', 30000);
  const tip = await t.driver.observe(() => {
    const e = document.querySelector('.find-pop .find-tip');
    return { text: e.querySelector('.find-tip-text').textContent.trim(), setup: !!e.querySelector('.find-tip-setup'),
      label: e.querySelector('.find-tip-close')?.getAttribute('aria-label') ?? '' };
  });
  assert(/CLIP/.test(tip.text) && tip.setup && tip.label, `tip text, Set up button and labeled close button (${JSON.stringify(tip)})`);
  await t.evidence('find-no-clip-column');

  // every control of the head's first row on one centre line, none outside the column
  const row = await t.driver.observe(sel => {
    const r = document.querySelector(sel);
    const column = document.querySelector('.find-pop').getBoundingClientRect();
    const box = r.getBoundingClientRect();
    const items = [...r.children].map(e => { const b = e.getBoundingClientRect(); return { cls: e.className, left: b.left, right: b.right, top: b.top, bottom: b.bottom, cy: (b.top + b.bottom) / 2, h: b.height }; })
      .filter(i => i.h > 0 && i.right > i.left);
    return { column: { left: column.left, right: column.right }, box: { top: box.top, bottom: box.bottom }, items };
  }, head);
  // saved filters live in the footer (Load filter); the pin joins this row only with auto-hide
  assert(row.items.some(i => /find-text/.test(i.cls)), 'the search box is in the row');
  assert(row.items.some(i => /analysis-status/.test(i.cls)), 'the analysis indicator is in the row');
  // a wrapped row has one centre line per line: group by line, and each line must agree within 1px
  const lines = [];
  for (const i of row.items) {
    const line = lines.find(l => Math.abs(l.cy - i.cy) < i.h / 2);
    if (line) line.items.push(i); else lines.push({ cy: i.cy, items: [i] });
  }
  for (const line of lines) {
    const cys = line.items.map(i => i.cy);
    assert(Math.max(...cys) - Math.min(...cys) <= 1, `controls share a vertical centre: ${JSON.stringify(line.items.map(i => [i.cls, i.cy]))}`);
    if (line.items.length > 1) {
      const hs = line.items.map(i => i.h);
      assert(Math.max(...hs) - Math.min(...hs) <= 1, `controls share a height: ${JSON.stringify(line.items.map(i => [i.cls, i.h]))}`);
    }
  }
  for (const i of row.items) {
    assert(i.left >= row.column.left - 0.5 && i.right <= row.column.right + 0.5, `${i.cls} stays inside the column`);
    assert(i.top >= row.box.top - 0.5 && i.bottom <= row.box.bottom + 0.5, `${i.cls} stays inside its row`);
  }
  t.measure({ name: 'find-no-clip-head-row', lines: lines.length, items: row.items });

  // a file-name fragment narrows the grid
  const name = await t.driver.observe(s => document.querySelectorAll(s)[1].title, `.filmstrip.grid .thumb[data-imgid]`);
  const fragment = name.replace(/\.[^.]+$/, '');
  await click(t, `${pop} .find-text`);
  await t.driver.keys(...fragment, ENTER);
  await until(async () => await count(t, cells) < all, 'a file-name fragment narrows the grid', 60000);
  assert(await count(t, cells) >= 1, 'the fragment matches a photo');
  await t.evidence('find-no-clip-filename');
  await t.driver.chord(CONTROL, 'a');
  await t.driver.keys('', ENTER);
  await until(async () => await count(t, cells) === all, 'clearing the words restores the grid', 60000);

  // the tip's button opens Preferences on General, at the CLIP controls
  await click(t, `${pop} .find-tip-setup`);
  await until(() => present(t, '[data-pref-card="local-search"]'), 'Preferences shows the local photo cache card');
  const shown = await t.driver.observe(() => {
    const tab = document.querySelector('.prefs-tabs button.on')?.textContent.trim();
    const r = document.querySelector('[data-pref-card="local-search"]').getBoundingClientRect();
    return { tab, visible: r.height > 0 && r.top < window.innerHeight && r.bottom > 0, model: !!document.querySelector('[data-pref-card="local-search"] .btn') };
  });
  assert.equal(shown.tab, 'General', 'Preferences opens on General');
  assert(shown.visible && shown.model, 'the CLIP controls are on screen');
  await t.evidence('find-no-clip-preferences');
  await textButton(t, '.prefs-foot', 'Done');
  await until(async () => !await present(t, '.prefs-foot'), 'Preferences closes');
  assert(await present(t, `${pop} .find-tip`), 'the tip stays until it is dismissed');

  // dismissing hides it, and it stays hidden when the grid is entered again
  await click(t, `${pop} .find-tip-close`);
  await until(async () => !await present(t, `${pop} .find-tip`), 'the tip is dismissed');
  await click(t, library);
  await until(async () => !await present(t, '.filmstrip.grid'), 'leave the grid');
  await click(t, library);
  await until(() => present(t, pop), 'the grid again');
  await pause(2500); // the status is asked again on entering; the tip must not come back
  assert(!await present(t, `${pop} .find-tip`), 'the dismissed tip stays hidden');

  // no similar-photos entry without the model
  const cell = await t.driver.observe(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, '.filmstrip.grid .thumb[data-imgid]');
  await t.driver.rightClick(cell.x, cell.y);
  await until(() => present(t, '.context-menu'), 'the photo menu');
  const items = await t.driver.observe(() => [...document.querySelectorAll('.context-menu button')].map(b => b.textContent.trim()));
  assert(items.length > 0 && !items.some(i => /more like this/i.test(i)), `no Show more like this without the model (${items.join(' | ')})`);
  await t.driver.keys(ESC);
  t.measure({ name: 'find-no-clip', photos: all });
}
