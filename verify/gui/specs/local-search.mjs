// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';
import { choose } from '../support/scenario.mjs';

// The Find popup (FindPanel.tsx): words to search for, the Search in choice and
// the filters, applied as they change. There is no Search button: Enter in the
// text field runs the search at once.
const pop = '.find-pop';
const searchBox = `${pop} .find-text`;
const searchIn = `${pop} select[aria-label="Search in"]`;
const mode = `${pop} .find-head .segmented button`;
const folderRow = path => `.folders [data-folder-path=${JSON.stringify(path)}]`;
const ENTER = '\uE007';

async function openFind(t) {
  if (!await t.driver.observe(s => !!document.querySelector(s), pop)) await click(t, '.find-button');
  await until(() => t.driver.observe(s => !!document.querySelector(s), searchBox), 'Find popup');
}

export async function localSearch(t) {
  const filename = t.fixture.file;
  assert(filename, 'the runner copied a fixture photo');

  await openFind(t);
  const source = await until(() => t.driver.observe(s => {
    const select = document.querySelector(s);
    return select && { value: select.value, options: [...select.options].map(o => o.textContent.trim()) };
  }, searchIn), 'Search in select');
  assert.deepEqual(source.options, ['This folder', 'All folders'], 'no Immich choice is offered without Immich configured');
  // all indexed folders, as the earlier Local photos source did
  await choose(t, searchIn, 'library');
  await until(() => t.driver.observe(s => document.querySelector(s)?.value === 'library', searchIn), 'All folders selected');

  // without the CLIP model Find has no Smart/Filename switch: it searches file names only
  const switchable = await t.driver.observe(s => !!document.querySelector(s), mode);
  if (switchable) {
    await click(t, `${mode}:nth-child(2)`);
    await until(() => t.driver.observe(s => document.querySelector(`${s}:nth-child(2)`)?.classList.contains('active'), mode),
      'Filename mode selected');
  }
  await click(t, searchBox);
  await t.driver.keys(...filename);
  await until(() => t.driver.observe((s, value) => document.querySelector(s)?.value === value, searchBox, filename),
    'sample filename entered');
  await t.driver.keys(ENTER);

  const cell = `.filmstrip.grid .thumb[data-imgid][title=${JSON.stringify(filename)}]`;
  const found = await until(() => t.driver.observe(s => {
    const e = document.querySelector(s);
    if (!e) return null;
    const id = Number(e.dataset.imgid);
    const canvas = e.querySelector('.thumb-image canvas');
    return { id, canvas: canvas && { width: canvas.width, height: canvas.height }, stars: e.querySelectorAll('.thumb-stars button').length };
  }, cell).then(x => x && x.id > 0 && x.canvas?.width > 0 && x.canvas?.height > 0 ? x : null),
  `indexed local result and cached thumbnail for ${filename}`, 60000);
  assert.equal(found.stars, 5, 'the local result exposes editable rating controls');
  await t.evidence('local-search-result');
  // Find is the grid's right-hand column: the result is in the grid, with the search and
  // its words kept. The column has no Show button; it stays while the grid is shown.
  assert(!await t.driver.observe(s => !!document.querySelector(s), `${pop} .find-show`), 'Find has no Show button');

  // Set a rating on the copied fixture, then filter the search through the
  // real toolbar. The local result should survive because its saved rating is
  // at the selected threshold.
  const hover = await t.driver.observe(s => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, cell);
  await t.driver.move(hover.x, hover.y);
  await click(t, `${cell} .thumb-stars button:nth-child(3)`);
  await until(() => t.driver.observe(s => document.querySelector(`${s} .thumb-stars button:nth-child(3)`)?.classList.contains('on'), cell),
    'the copied result is rated three stars');
  await click(t, '.toolbar .filter button[title="3 stars and up"]');
  await until(() => t.driver.observe(() => !!document.querySelector('.toolbar .filter button[title="clear filters"]')),
    'the toolbar shows filters on');
  // the search and its Filename mode live in the Find popup, reopened to read them (in the grid, the locked column)
  await openFind(t);
  const filtered = await until(() => t.driver.observe((s, value, name, modeSel) => {
    const result = document.querySelector(s);
    const input = document.querySelector(value);
    return result && input?.value === name
      ? { rating: result.querySelectorAll('.thumb-stars button.on').length, mode: document.querySelector(`${modeSel}.active`)?.textContent.trim(),
          on: [...document.querySelectorAll('.find-pop .fr-row.on .fr-title')].map(e => e.textContent.trim()) }
      : null;
  }, cell, searchBox, filename, mode), 'filename search retains its rating filter and result');
  assert.equal(filtered.rating, 3);
  if (switchable) assert.equal(filtered.mode, 'Filename');
  else assert.equal(filtered.mode ?? null, null, 'no mode switch without the CLIP model');
  assert(filtered.on.includes('Rating & flags'), `the rating filter is on in Find (${filtered.on})`);
  await t.evidence('local-search-filter');

  // Opening the copied folder returns to browsing and keeps the rating filter.
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  await until(() => t.driver.observe(s => !!document.querySelector(s), folderRow(t.fixtureDir)), 'the disposable fixture folder row');
  await click(t, folderRow(t.fixtureDir));
  await until(() => t.driver.observe((result, query, scope) => {
    const rating = [...document.querySelectorAll('.find-pop .fr-row.on .fr-title')]
      .some(row => row.textContent.trim() === 'Rating & flags');
    return !!document.querySelector(result) && document.querySelector(query)?.value === ''
      && document.querySelector(scope)?.value === 'folder' && rating;
  }, cell, searchBox, searchIn), 'folder navigation clears the filename query and preserves the rating filter');
  await t.evidence('local-search-folder');
  t.measure({ name: 'local-search', filename, result: found, filtered, returnedToFolder: true });
}
