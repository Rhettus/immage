// SPDX-License-Identifier: GPL-3.0-or-later
// the chevron on each mask row folds the selected mask's shapes and Add /
// Subtract away and back, each mask keeps its fold, and a chevron on
// another mask selects that mask open. folding changes nothing in the photo
import assert from 'node:assert/strict';
import { click, reveal, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const row = i => `.mask-list > li:nth-child(${i})`;
const state = i => ({
  selected: !!document.querySelector(`.mask-list > li:nth-child(${i}).on`),
  parts: !!document.querySelector(`.mask-list > li:nth-child(${i}) .mask-parts`),
  chevronOpen: !!document.querySelector(`.mask-list > li:nth-child(${i}) .mask-fold .chevron.open`),
  title: document.querySelector(`.mask-list > li:nth-child(${i}) .mask-fold`)?.title ?? null,
  shapes: document.querySelectorAll(`.mask-list > li:nth-child(${i}) .shape-list > li`).length,
});
async function expect(t, i, want, what) {
  await until(async () => {
    const s = await t.driver.observe(state, i);
    return Object.entries(want).every(([k, v]) => s[k] === v) ? s : false;
  }, what, 10000).catch(async e => {
    throw Error(`${what}: ${JSON.stringify(await t.driver.observe(state, i))} ${e.message}`);
  });
}
async function drawOn(t) {
  const photo = await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: photo.x - photo.bounds.width * .15, y: photo.y },
                      { x: photo.x + photo.bounds.width * .15, y: photo.y + photo.bounds.height * .12 });
}
// the photo away from a mask row, whose hover shows that mask in red
async function settledAway(t, predicate) {
  const title = await reveal(t, '.masks-panel .panel-title span');
  await t.driver.move(title.x, title.y);
  return settledPhoto(t, predicate);
}

export async function maskFold(t) {
  await openTool(t, 'masks');
  const baseline = await settledPhoto(t);
  // a mask of two shapes, so its shape list shows
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Linear Gradient');
  await drawOn(t);
  await expect(t, 1, { selected: true, parts: true, chevronOpen: true }, 'new mask opens to its shapes');
  await click(t, `${row(1)} .shape-menu.add .mask-op`); await textButton(t, '.shape-menu-list', 'Radial Gradient');
  await drawOn(t);
  await expect(t, 1, { shapes: 2 }, 'second shape added');
  const g = await t.driver.observe(s => {
    const r = e => document.querySelector(e)?.getBoundingClientRect();
    const chev = r(`${s} .mask-fold`), rowBox = r(`${s} .mask-row`), thumb = r(`${s} .mask-thumb`), list = r(`${s} .shape-list`);
    const hit = document.elementFromPoint(chev.x + chev.width / 2, chev.y + chev.height / 2);
    return { chev: [chev.x, chev.y, chev.width, chev.height], row: [rowBox.x, rowBox.y, rowBox.width, rowBox.height],
             thumbLeft: thumb.x, listLeft: list.x, hit: !!hit?.closest(`${s} .mask-fold`) };
  }, row(1));
  t.measure({ name: 'mask-fold-geometry', ...g });
  assert(g.hit, 'the chevron takes its own clicks');
  assert(g.chev[0] >= g.row[0] && g.chev[0] + g.chev[2] <= g.row[0] + g.row[2], 'chevron inside its row');
  assert(Math.abs(g.listLeft - g.thumbLeft) <= 2, `shape list lines up with the thumbnail (${g.listLeft} vs ${g.thumbLeft})`);
  const open = await settledAway(t);
  await t.evidence('mask-open');

  // fold and unfold the selected mask
  await click(t, `${row(1)} .mask-fold`);
  await expect(t, 1, { selected: true, parts: false, chevronOpen: false, title: "show this mask's shapes" }, 'chevron folds the shapes');
  assert(!(await t.driver.observe(() => !!document.querySelector('.mask-ops'))), 'Add and Subtract fold away too');
  assert.equal((await settledAway(t)).hash, open.hash, 'folding leaves the photo as it was');
  await t.evidence('mask-folded');
  await click(t, `${row(1)} .mask-fold`);
  await expect(t, 1, { selected: true, parts: true, chevronOpen: true, shapes: 2, title: "hide this mask's shapes" }, 'chevron opens the shapes again');
  assert.equal((await settledAway(t)).hash, open.hash, 'unfolding leaves the photo as it was');

  // a second mask; the first keeps its fold while the other is selected
  await click(t, `${row(1)} .mask-fold`);
  await expect(t, 1, { parts: false }, 'first mask folded');
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Linear Gradient');
  await drawOn(t);
  await expect(t, 2, { selected: true, parts: true, chevronOpen: true }, 'second mask opens selected');
  await expect(t, 1, { selected: false, parts: false, chevronOpen: false }, 'first mask shut while not selected');
  await click(t, `${row(1)} .mask-thumb`);
  await expect(t, 1, { selected: true, parts: false, chevronOpen: false }, 'reselected mask stays folded');
  await expect(t, 2, { selected: false, parts: false, chevronOpen: false }, 'other mask shut');
  await t.evidence('reselected-folded');
  // the chevron on a mask not selected selects it open
  await click(t, `${row(2)} .mask-fold`);
  await expect(t, 2, { selected: true, parts: true, chevronOpen: true }, 'chevron selects another mask open');
  await click(t, `${row(1)} .mask-fold`);
  await expect(t, 1, { selected: true, parts: true, chevronOpen: true, shapes: 2 }, 'chevron selects the folded mask open');
  await t.evidence('chevron-selects');

  // clean up: both masks deleted, the photo as it started
  for (const n of [2, 1]) {
    await click(t, '.mask-list > li.on .mask-del');
    await until(() => t.driver.observe(k => document.querySelectorAll('.mask-list > li').length === k, n - 1), 'mask deleted');
    if (n === 2) await click(t, `${row(1)} .mask-thumb`);
  }
  await settledAway(t, p => p.hash === baseline.hash);
}
