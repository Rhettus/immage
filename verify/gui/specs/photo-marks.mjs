// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { category, openFind } from './find.mjs';
import { dismissTour } from './smoke.mjs';

const grid = '.filmstrip.grid';
const tiles = `${grid} .thumb[data-imgid]`;
const a = `${tiles}[title^="mark-a."]`;
const b = `${tiles}[title^="mark-b."]`;
const marks = '.mark-selection';
const popup = '.photo-mark-menu';
const find = '.find-pop';
const star = (scope, n) => `${scope} button.mark-star[aria-label="${n} stars"]`;
const pick = scope => `${scope} button.mark-pick`;
const reject = scope => `${scope} button.thumb-reject`;
const red = scope => `${scope} .swatch[aria-label="Red"]`;
const has = (t, selector) => t.driver.observe(s => !!document.querySelector(s), selector);
const pressed = (t, selector, expected) => until(() => t.driver.observe((s, value) =>
  document.querySelector(s)?.getAttribute('aria-pressed') === value, selector, String(expected)), `${selector} is ${expected}`);
const selection = t => t.driver.observe(s => [...document.querySelectorAll(s)]
  .filter(tile => tile.matches('.active, .selected')).map(tile => tile.title), tiles);
const hoverTile = async (t, tile) => {
  const { x, y } = await reveal(t, `${tile} .thumb-image`);
  await t.driver.move(x, y);
};
const focused = (t, selector) => until(() => t.driver.observe(s => document.activeElement?.matches(s), selector), `focus at ${selector}`);

export async function photoMarks(t) {
  await until(() => has(t, `${a.replace(grid, '.filmstrip')} .thumb-image`), 'disposable photos are listed', 120000);
  assert(await has(t, marks), 'editor shows the marking controls');
  assert.equal(await t.driver.observe(() => document.querySelector('.mark-selection-label')?.textContent.trim()), 'Mark');
  assert(!await has(t, '.toolbar .find-button, .toolbar .clear-filters'), 'the bottom bar is for assignment and view controls');
  await click(t, '.rail .library-toggle');
  await until(() => has(t, a), 'grid with mark-a');
  await until(() => has(t, b), 'grid with mark-b');
  const toolbar = await t.driver.observe(() => {
    const bar = document.querySelector('.toolbar');
    const center = selector => {
      const r = bar.querySelector(selector).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };
    const bounds = bar.getBoundingClientRect();
    return { verticalSpread: Math.abs(center('.mark-selection').y - center('.view-tools').y),
      zoomOffset: Math.abs(center('.zoom-bar input').x - (bounds.left + bounds.width / 2)),
      overflow: bar.scrollWidth - bar.clientWidth };
  });
  assert(toolbar.verticalSpread < 2, 'the bottom bar stays on a single row');
  assert(toolbar.overflow <= 1, 'the bottom bar fits at the test viewport');
  assert(toolbar.zoomOffset <= 1, 'the zoom slider is centered in the toolbar');


  // Mark two photos from the toolbar, then edit one tile inside the selection.
  await click(t, `${a} .thumb-image`);
  await click(t, star(marks, 2));
  await pressed(t, star(`${a} .thumb-stars`, 2), true);
  await pressed(t, star(`${b} .thumb-stars`, 2), false);
  await t.driver.chord('\uE009', 'a');
  await pressed(t, star(marks, 2), 'mixed');
  await click(t, star(marks, 3));
  await pressed(t, star(marks, 3), true);
  const selected = await selection(t);
  assert(selected.some(name => name.startsWith('mark-a.')) && selected.some(name => name.startsWith('mark-b.')));
  await hoverTile(t, a);
  await click(t, reject(a));
  await pressed(t, reject(marks), 'mixed');
  await pressed(t, reject(b), false);
  assert.deepEqual(await selection(t), selected, 'a tile action preserves the multi-selection');

  // Starting a drag on a control cannot begin a photo drag. Releasing on the
  // image cannot select it via a click retargeted to the tile.
  const from = await reveal(t, `${a} .mark-menu-trigger`);
  const to = await reveal(t, `${a} .thumb-image`);
  await t.driver.hold(from, to);
  try {
    assert(!await has(t, 'body.dragging-photos, .photo-drag'), 'marking controls cannot start a photo drag');
  } finally {
    await t.driver.release();
  }
  assert.deepEqual(await selection(t), selected, 'releasing on a tile leaves selection unchanged');
  await hoverTile(t, a);
  await click(t, reject(a), 2);
  assert(await has(t, grid), 'double-clicking a mark keeps the grid open');
  assert.deepEqual(await selection(t), selected);
  await click(t, star(marks, 3));
  await pressed(t, reject(marks), false);
  await pressed(t, star(marks, 3), true);

  await hoverTile(t, a);
  await click(t, pick(a));
  await pressed(t, pick(marks), 'mixed');
  await click(t, pick(marks));
  await pressed(t, pick(marks), true);
  await click(t, pick(marks));
  await pressed(t, pick(marks), false);

  // Keep a filter active while hiding its panel. Clearing the selected rating
  // must affect every member even as the tiles disappear.
  await openFind(t);
  await category(t, 'Rating & flags');
  const rows = await t.driver.observe(() => {
    const editor = document.querySelector('#find-row-rating + .fr-editor') ?? document.querySelector('.find-pop .fr-editor');
    const yPositions = selector => [...editor.querySelectorAll(selector)].map(button => button.getBoundingClientRect().top);
    const headings = ['.fe-stars', '.fe-swatches'].filter(selector =>
      editor.querySelector(selector).closest('.fe-sec').querySelector('.fe-label')).length;
    return { stars: yPositions('.fe-stars button'), colors: yPositions('.fe-swatches button'), headings };
  });
  assert.equal(rows.stars.length, 5, 'five rating choices');
  assert.equal(new Set(rows.stars).size, 1, 'stars share one row');
  assert.equal(rows.colors.length, 6, 'five colors and the no-label option');
  assert.equal(new Set(rows.colors).size, 1, 'colors share one row');
  assert.equal(rows.headings, 0, 'the controls have no text headings');
  await click(t, `${find} .fe-pick-filter`);
  await until(async () => !await has(t, tiles), 'Picked hides unpicked photos');
  await click(t, `${find} .fe-pick-filter`);
  await until(() => has(t, a), 'turning Picked off restores photos');
  // When Picked hid every tile, the grid dropped the selection. Re-select
  // the restored photos before the separate bulk-rating check.
  await t.driver.chord('\uE009', 'a');
  await pressed(t, star(marks, 3), true);

  await click(t, `${find} .fe-stars button[aria-label="3 stars and up"]`);
  await click(t, `${find} .find-save`);
  await click(t, '.save-filter input[type="text"]');
  await t.driver.keys(...'Rated photos', '\uE007');
  const saved = '.saved-filter-name[title="Rated photos"]';
  await until(() => has(t, saved), 'the saved filter is listed in the sidebar');
  await click(t, '[data-panel-toggle="find"]');
  await until(() => has(t, '.right-slot.closed'), 'Find hidden');
  await click(t, star(marks, 3));
  await until(async () => !await has(t, tiles), 'rating change empties the filtered grid');
  await until(() => has(t, `${marks} button:disabled`), 'marking disabled without eligible photos');
  await openFind(t);
  const resultCount = `${find} .find-count-text`;
  const countIs = value => until(() => t.driver.observe((s, text) =>
    document.querySelector(s)?.textContent.trim() === text, resultCount, value), `Find shows ${value}`);
  await countIs('0 of 3');
  const clear = `${find} .find-clear`;
  await click(t, clear);
  await until(() => has(t, a), 'Find reset restores the hidden photos');
  await countIs('3 of 3');
  await pressed(t, star(`${a} .thumb-stars`, 3), false);
  await pressed(t, star(`${b} .thumb-stars`, 3), false);
  await click(t, saved);
  await countIs('0 of 3');
  await click(t, clear);
  await until(() => has(t, a), 'Find reset restores the grid after recalling a saved filter');

  // At the minimum zoom, keyboard focus reaches the single menu. Escape
  // returns to its trigger without opening the photo or exiting the grid.
  const zoom = '.toolbar input[aria-label="thumbnail size"]';
  await click(t, zoom);
  await t.driver.keys('\uE011'); // Home
  await until(() => t.driver.observe(s => document.querySelector(s)?.value === '0', zoom), 'minimum thumbnail size');
  await click(t, `${a} .thumb-image`);
  await t.driver.keys('\uE036'); // F6
  await focused(t, `${a} .mark-menu-trigger`);
  await t.driver.keys('\uE007');
  await focused(t, star(popup, 1));
  await t.driver.keys('\uE00C');
  await focused(t, `${a} .mark-menu-trigger`);
  assert(!await has(t, popup));
  await t.driver.keys('\uE007', '\uE004', '\uE004', '\uE004', '\uE004', '\uE007');
  await until(() => has(t, `${a} .thumb-mark-rating`), 'five stars are visible on the compact tile');
  await t.driver.chord('\uE008', '\uE036'); // Shift+F6
  await focused(t, star(marks, 1));
  await click(t, red(marks));
  await pressed(t, red(marks), true);
  await click(t, pick(marks));
  await pressed(t, pick(marks), true);
  await t.evidence('compact-marked-tile');

  await t.restart();
  await dismissTour(t);
  if (!await has(t, grid)) await click(t, '.rail .library-toggle');
  await until(() => has(t, a), 'photo after isolated restart', 120000);
  await until(() => has(t, `${a} .thumb-mark-status .mark-pick.on`), 'Pick restored');
  await until(() => has(t, `${a} .labels .dot[title="Red"]`), 'red label restored');
  const rating = await t.driver.observe(s => document.querySelectorAll(`${s} .thumb-mark-rating .on`).length, a);
  assert.equal(rating, 5, 'rating restored');
  assert(!await has(t, `${b} .labels .dot[title="Red"]`), 'the other tile stayed unchanged');
  t.measure({ name: 'visual-marking', smallestThumbnail: true, persisted: ['stars', 'red label', 'Pick'] });
}
