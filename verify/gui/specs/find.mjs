// SPDX-License-Identifier: GPL-3.0-or-later
// The Find popup (FindPanel.tsx, findLayout.ts, SavedFilterMenus.tsx): filters
// that apply as they change, the Minimize / Dock / Fill sizes with a draggable
// strip and dock, and saved filters (Alt+1 to Alt+9). Everything is driven by
// WebDriver pointer and key actions inside the test webview. The popup opens
// at its stored size, Dock by default, so each case sets the size it needs.
// In the grid view Find is not a popup but the right-hand column, locked in
// place (`.find-pop.locked`: Dock's body, no size buttons, grip or closing), so
// the helpers below accept both and the popup-only cases leave the grid first.
import assert from 'node:assert/strict';
import { click } from '../support/controls.mjs';
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
const chips = t => t.driver.observe(() => [...document.querySelectorAll('.find-chip')].map(c => ({
  category: c.querySelector('.find-chip-cat')?.textContent.trim(), text: c.querySelector('.find-chip-text')?.textContent.trim() ?? '' })));
const findClass = (t, name) => t.driver.observe(n => document.querySelector('.find-button')?.classList.contains(n), name);

async function openFind(t) {
  if (!await present(t, pop)) await click(t, '.find-button');
  await until(() => present(t, pop), 'Find popup');
}
const isLocked = t => present(t, `${pop}.locked`);
async function closeFind(t) {
  if (await isLocked(t)) return;   // the column cannot be closed
  if (await present(t, pop)) await t.driver.keys(ESC);
  await until(async () => !await present(t, pop), 'Find popup closes');
}
async function setSize(t, size) {
  if (await isLocked(t)) {
    assert.equal(size, 'dock', 'the locked column is only ever the Dock body');
    assert(!await present(t, `${pop} .find-size`), 'the locked column has no size buttons');
    return settle(t);
  }
  await click(t, `${pop} .find-size-${size}`);
  await until(() => t.driver.observe(s => document.querySelector('.find-pop')?.dataset.size === s, size), `${size} size`);
  return settle(t);
}
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
async function category(t, name) {
  const point = await until(() => t.driver.observe(n => {
    const e = [...document.querySelectorAll('.find-cat')].find(c => c.querySelector('.name')?.textContent === n);
    if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, name), `${name} row`);
  await t.driver.point(point.x, point.y);
  await until(() => t.driver.observe(n => document.querySelector('.find-pane h3')?.textContent === n, name), `${name} pane`);
}
async function center(t, selector) {
  return until(() => t.driver.observe(s => {
    const e = document.querySelector(s);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, selector), `${selector} on screen`);
}
const stars = n => `${pop} .find-stars button[title="${n} stars and up"]`;

// Ticking a value adds a chip and narrows the grid with nothing pressed; the
// chip's x removes it; in the grid Find is the locked right-hand column, which
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
  await setSize(t, 'dock');
  assert.equal((await chips(t)).length, 0, 'no filter chips before anything is set');
  assert(!await findClass(t, 'on'), 'the toolbar Find button is not on without filters');

  // 1. a rating, from the Rating & flags pane (the first shown)
  await click(t, stars(3));
  await until(async () => (await chips(t)).some(c => c.category === 'Rating & flags'), 'a Rating & flags chip appears');
  await until(async () => await count(t, cells) < all, 'the grid narrows without pressing Show');
  assert.equal(await count(t, cells), 1, 'only the rated photo remains');
  assert(await findClass(t, 'on'), 'the toolbar Find button is on');
  await t.evidence('find-live-rating');

  // the chip's x removes it and the grid is whole again
  await click(t, `${pop} .find-chip button[aria-label="Remove Rating & flags"]`);
  await until(async () => (await chips(t)).length === 0, 'the chip is removed');
  await until(async () => await count(t, cells) === all, 'the grid is restored');

  // 2. a File type value: a chip, the same photos (the copies are one type)
  await category(t, 'File type');
  await click(t, `${pop} .find-pane .filter-ticks button`);
  await until(async () => (await chips(t)).some(c => c.category === 'File type'), 'a File type chip appears');
  assert.equal(await count(t, cells), all, 'the copies all match their own file type');
  await click(t, `${pop} .find-chip button[aria-label="Remove File type"]`);
  await until(async () => (await chips(t)).length === 0, 'the File type chip is removed');

  // 3. the column is locked: no Show N, grip or close, and the grid still shows beside it
  await category(t, 'Rating & flags');
  await click(t, stars(3));
  await until(async () => await count(t, cells) === 1, 'rating filter on again');
  assert(await isLocked(t), 'in the grid Find is the locked column');
  assert(!await present(t, `${pop} .find-show`), 'no Show N in the column');
  assert(!await present(t, `${pop} .find-grip`), 'no grip in the column');
  const col = await rectOf(t, pop), strip = await rectOf(t, '.filmstrip.grid');
  assert(col && strip && strip.left + strip.width <= col.left + col.width && (strip.left + strip.width <= col.left + 1 || col.left + col.width <= strip.left + 1),
    'the grid and the column do not overlap');
  await t.evidence('find-live-column');

  // 4. Escape in the search box leaves the box; the column and the filter stay
  await click(t, `${pop} .find-text`);
  await t.driver.keys(ESC);
  assert(await isLocked(t) && await present(t, '.filmstrip.grid'), 'Escape in the box keeps the column and the grid');
  assert(await findClass(t, 'on'), 'the Find button stays on');
  assert.equal(await count(t, cells), 1, 'Escape keeps the filter');
  await click(t, '.toolbar .clear-filters');
  await until(async () => await count(t, cells) === all, 'clearing the filters restores the grid');

  // the toolbar's Find button focuses the box of the column that is already there
  await click(t, '.toolbar .find-button');
  await until(() => t.driver.observe(() => document.activeElement?.classList.contains('find-text')), 'the Find button focuses the search box');
  assert(await isLocked(t), 'no popup opens in the grid');

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
  assert(!await present(t, `${pop}.locked`), 'the locked Find column is gone outside the grid');
  assert(await present(t, 'aside.right .panels'), 'the normal right panel is back');
  assert(!await present(t, 'button.culling-open'), 'no magnifier outside the grid');
  assert(!await t.driver.observe(s => document.querySelector(s).disabled, library), 'the Library button is enabled with a photo open');
  await click(t, library);
  await until(() => present(t, '.filmstrip.grid'), 'the Library button returns to the grid');
  await until(() => isLocked(t), 'Find is the column again');
  // and back out with the same button
  await click(t, library);
  await until(async () => !await present(t, '.filmstrip.grid'), 'the Library button leaves the grid');
  assert(await present(t, 'aside.right .panels'), 'the right panel is restored');
  t.measure({ name: 'find-live', photos: all });
}

// Minimize, Dock and Fill by their buttons; the strip and the dock follow the
// grip and keep their own places; a reopened popup is where it was; a double
// click on the grip puts it back
export async function findSizes(t) {
  await until(() => present(t, cells), 'a photo in the library', 120000);
  // the popup is the filmstrip view's: the grid has the locked column instead
  if (await present(t, '.filmstrip.grid')) await t.driver.keys('g');
  await until(async () => !await present(t, '.filmstrip.grid'), 'filmstrip view');
  await openFind(t);
  assert(!await isLocked(t), 'outside the grid Find is the floating popup');

  const rects = {};
  for (const size of ['minimize', 'dock', 'fill']) {
    rects[size] = await setSize(t, size);
    assert.equal(await t.driver.observe(s => document.querySelector(`.find-size-${s}`)?.getAttribute('aria-pressed'), size), 'true',
      `${size} button is pressed`);
    await t.evidence(`find-size-${size}`);
  }
  assert(rects.minimize.height < rects.dock.height, 'the strip is shorter than the dock');
  assert(rects.minimize.width > rects.dock.width, 'the strip is wider than the dock');
  assert(rects.fill.width > rects.dock.width && rects.fill.height >= rects.dock.height, 'Fill covers more than the dock');
  assert(!await present(t, '.find-pop .find-cat'), 'Fill lists every pane rather than a category list');

  // Fill never moves
  let grip = await center(t, `${pop} .find-grip`);
  await t.driver.drag(grip, { x: grip.x - 120, y: grip.y + 40 });
  near(await settle(t), rects.fill, 'Fill after a drag');

  // the strip: dragged up and to the left
  await setSize(t, 'minimize');
  grip = await center(t, `${pop} .find-grip`);
  await t.driver.drag(grip, { x: grip.x - 120, y: grip.y - 100 });
  const movedStrip = await settle(t);
  assert(movedStrip.left < rects.minimize.left - 40, `the strip moved left (${movedStrip.left} from ${rects.minimize.left})`);
  assert(movedStrip.top < rects.minimize.top - 40, `the strip moved up (${movedStrip.top} from ${rects.minimize.top})`);
  await t.evidence('find-strip-dragged');

  // the dock: it fills the height, so only across
  await setSize(t, 'dock');
  grip = await center(t, `${pop} .find-grip`);
  await t.driver.drag(grip, { x: grip.x - 150, y: grip.y + 60 });
  const movedDock = await settle(t);
  assert(movedDock.left < rects.dock.left - 40, `the dock moved left (${movedDock.left} from ${rects.dock.left})`);
  await t.evidence('find-dock-dragged');

  // each size keeps its own place
  near(await setSize(t, 'minimize'), movedStrip, 'the strip keeps its place');
  near(await setSize(t, 'dock'), movedDock, 'the dock keeps its place');

  // closed and opened again: the same size and place
  await closeFind(t);
  await openFind(t);
  assert.equal(await t.driver.observe(() => document.querySelector('.find-pop').dataset.size), 'dock', 'reopened at the last size');
  near(await settle(t), movedDock, 'reopened at the same place');

  // a double click on the grip puts the size back
  grip = await center(t, `${pop} .find-grip`);
  await t.driver.point(grip.x, grip.y, 2);
  near(await settle(t), rects.dock, 'the dock after a double click on the grip');
  await setSize(t, 'minimize');
  grip = await center(t, `${pop} .find-grip`);
  await t.driver.point(grip.x, grip.y, 2);
  near(await settle(t), rects.minimize, 'the strip after a double click on the grip');

  // leave the default size for later cases
  await setSize(t, 'dock');
  await closeFind(t);
  t.measure({ name: 'find-sizes', rects, movedStrip, movedDock });
}

// Save filter… and its name line, "changed" and Update, Alt+1 on a cleared
// filter, and the Manage dialog's rename and delete
export async function findSaved(t) {
  await until(() => present(t, cells), 'a photo in the library', 120000);
  await openFind(t);
  await setSize(t, 'dock');
  const dialogName = async name => {
    const input = '.save-filter input[type="text"]';
    await until(() => present(t, input), 'name field');
    await click(t, input);
    await t.driver.chord(CONTROL, 'a');
    await t.driver.keys(...name);
    await until(() => t.driver.observe((s, v) => document.querySelector(s)?.value === v, input, name), 'name typed');
  };

  // a filter to keep: three stars and up
  await click(t, stars(3));
  await until(async () => (await chips(t)).some(c => c.category === 'Rating & flags'), 'rating chip');
  assert(!await present(t, `${pop} .saved-line`), 'no saved filter is in use yet');
  await click(t, `${pop} .find-save`);
  await dialogName('Find test');
  await t.evidence('find-saved-dialog');
  await t.driver.keys(ENTER);
  await until(() => present(t, `${pop} .saved-line`), 'the saved filter line');
  assert.equal(await t.driver.observe(() => document.querySelector('.find-pop .saved-line .saved-name').textContent), 'Find test');
  assert(!await present(t, `${pop} .saved-changed`), 'not changed straight after saving');

  // change it: changed and Update, and Update takes the change in
  await click(t, `${pop} .find-edited button:nth-child(2)`);
  await until(() => present(t, `${pop} .saved-changed`), 'the line says changed');
  await t.evidence('find-saved-changed');
  await textButton(t, `${pop} .saved-line`, 'Update');
  await until(async () => !await present(t, `${pop} .saved-changed`), 'Update takes the change in');

  // clear everything, close, and Alt+1 re-applies it
  await click(t, `${pop} .find-clear-all`);
  await until(async () => (await chips(t)).length === 0, 'cleared');
  await closeFind(t);
  assert(!await findClass(t, 'on'), 'no filter is on once cleared');
  await t.driver.chord(ALT, '1');
  await until(() => findClass(t, 'on'), 'Alt+1 applies the saved filter');
  await openFind(t);
  const back = await chips(t);
  const rating = back.find(c => c.category === 'Rating & flags');
  assert(rating, 'the rating chip is back');
  assert(rating.text.includes('3 stars and up') && rating.text.includes('Edited'), `the updated filter was applied (${rating.text})`);
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
  await until(() => isLocked(t), 'the locked Find column');
  const all = await count(t, cells);
  const head = `${pop} .find-head > .find-row:first-child`;

  // file names only: no Smart/Filename switch, and the box says so
  assert(!await present(t, `${head} .segmented`), 'no Smart/Filename switch without the model');
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
    const column = document.querySelector('.find-pop.locked').getBoundingClientRect();
    const box = r.getBoundingClientRect();
    const items = [...r.children].map(e => { const b = e.getBoundingClientRect(); return { cls: e.className, left: b.left, right: b.right, top: b.top, bottom: b.bottom, cy: (b.top + b.bottom) / 2, h: b.height }; })
      .filter(i => i.h > 0 && i.right > i.left);
    return { column: { left: column.left, right: column.right }, box: { top: box.top, bottom: box.bottom }, items };
  }, head);
  assert(row.items.length >= 2, 'the search box and the Saved menu are in the row');
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
  await until(() => isLocked(t), 'the grid again');
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
