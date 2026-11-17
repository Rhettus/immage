// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';

export async function photoFilter(t) {
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip .thumb[data-imgid]')),
    'fixture photo in the library', 60000);
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  const state = await t.driver.observe(() => ({
    cells: [...document.querySelectorAll('.filmstrip.grid .thumb')].map(e => e.title),
    files: [...document.querySelectorAll('.filmstrip.grid .thumb[data-imgid]')].map(e => e.title),
    names: [...document.querySelectorAll('.filmstrip.grid .thumb-name')].map(e => e.textContent),
  }));
  assert.deepEqual(state.files, [t.fixture.file], `only supported photos appear as photo cells (${state.files})`);
  for (const name of ['notes.txt', 'bad-image.jpg.xmp', 'partial.immage-part', 'document.pdf'])
    assert(!state.cells.some(cell => cell.includes(name)), `${name} does not appear in the grid`);
  await t.evidence('photo-filter');
  t.measure({ name: 'photo-filter', ...state });
}
