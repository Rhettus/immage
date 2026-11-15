// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click } from '../support/controls.mjs';
import { until } from '../support/webdriver.mjs';

const panel = '.immich-panel';
const searchBox = `${panel} input[type="search"]`;
const folderRow = path => `.folders [data-folder-path=${JSON.stringify(path)}]`;

export async function localSearch(t) {
  const filename = t.fixture.file;
  assert(filename, 'the runner copied a fixture photo');

  await until(() => t.driver.observe(s => !!document.querySelector(s), panel), 'Search photos panel');
  if (!await t.driver.observe(s => document.querySelector(`${s} > .panel-title`)?.classList.contains('open'), panel))
    await click(t, `${panel} > .panel-title`);
  const source = await until(() => t.driver.observe(s => {
    const select = document.querySelector(`${s} select[aria-label="Search source"]`);
    return select && { value: select.value, options: [...select.options].map(o => o.textContent.trim()) };
  }, panel), 'local search controls');
  assert.equal(source.value, 'local', 'the isolated profile has local search without Immich configuration');
  assert.deepEqual(source.options, ['Local photos'], 'no Immich service is required or offered');

  const filenameMode = `${panel} .segmented button`;
  await click(t, filenameMode + ':nth-child(2)');
  await until(() => t.driver.observe(s => document.querySelector(`${s}:nth-child(2)`)?.classList.contains('active'), filenameMode),
    'Filename mode selected');
  await click(t, searchBox);
  await t.driver.keys(...filename);
  await until(() => t.driver.observe((s, value) => document.querySelector(s)?.value === value, searchBox, filename),
    'sample filename entered');
  await click(t, `${panel} .immich-search button`);

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

  // Set a rating on the copied fixture, then filter the search through the
  // real toolbar. The local result should survive because its saved rating is
  // at the selected threshold.
  await click(t, `${cell} .thumb-stars button:nth-child(3)`);
  await until(() => t.driver.observe(s => document.querySelector(`${s} .thumb-stars button:nth-child(3)`)?.classList.contains('on'), cell),
    'the copied result is rated three stars');
  await click(t, '.toolbar .filter button[title="3 stars and up"]');
  const filtered = await until(() => t.driver.observe((s, value, name, panelSelector) => {
    const result = document.querySelector(s);
    const input = document.querySelector(value);
    return result && input?.value === name && document.querySelector('.toolbar .filter button[title="clear filters"]')
      ? { rating: result.querySelectorAll('.thumb-stars button.on').length, mode: document.querySelector(`${panelSelector} .segmented button.active`)?.textContent.trim() }
      : null;
  }, cell, searchBox, filename, panel), 'filename search retains its rating filter and result');
  assert.equal(filtered.rating, 3);
  assert.equal(filtered.mode, 'Filename');
  await t.evidence('local-search-filter');

  // Opening the fixture's folder leaves search mode and returns to its normal
  // library listing. It is the run's copied folder, never the configured source.
  if (!await t.driver.observe(() => document.querySelector('.folders-panel > .panel-title')?.classList.contains('open')))
    await click(t, '.folders-panel > .panel-title');
  await until(() => t.driver.observe(s => !!document.querySelector(s), folderRow(t.fixtureDir)), 'the disposable fixture folder row');
  await click(t, folderRow(t.fixtureDir));
  await until(() => t.driver.observe((s, value) => {
    const title = document.querySelector(s)?.title;
    return title === value && document.querySelector('.toolbar .filter button[title="no filters on"]')
      && (document.querySelector('.status')?.textContent ?? '').includes('images');
  }, `.filmstrip .thumb[data-imgid][title=${JSON.stringify(filename)}]`, filename), 'folder navigation leaves local search');
  await t.evidence('local-search-folder');
  t.measure({ name: 'local-search', filename, result: found, filtered, returnedToFolder: true });
}
