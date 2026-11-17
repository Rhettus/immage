// SPDX-License-Identifier: GPL-3.0-or-later
// The photo right-click menu's Rating, Color Label, Reject and Keywords group
// (FileMenu.tsx): the same paths as the 0-9 and X keys, on the right-clicked
// photo or the selection that includes it. Runs on three copies of the fixture
import assert from 'node:assert/strict';
import { Blocked, textButton } from '../support/scenario.mjs';
import { reveal } from '../support/controls.mjs';
import { until, pause } from '../support/webdriver.mjs';

const cells = '.filmstrip.grid .thumb[data-imgid]';
const MENU = '.context-menu';
const SUB = '.context-menu.submenu';

let group = [];
const everything = t => t.driver.observe((sel) => [...document.querySelectorAll(sel)].map(e => ({
  title: e.title, selected: e.classList.contains('selected'), rejected: e.classList.contains('rejected'),
  stars: e.querySelectorAll('.thumb-stars button.on').length,
  labels: [...e.querySelectorAll('.labels .dot')].map(d => d.style.background),
})), cells);
// the three selected photos; the fourth must never change
const state = async t => (await everything(t)).filter(x => group.includes(x.title));
const fourth = async t => (await everything(t)).find(x => !group.includes(x.title));

// each menu button as { own text, check, hint, disabled, inside the window }
const buttons = (t, scope) => t.driver.observe((sel) => [...document.querySelectorAll(sel === '.context-menu' ? '.context-menu:not(.submenu) > button, .context-menu:not(.submenu) > .has-sub > button' : `${sel} button`)]
  .filter(b => sel === '.context-menu' || b.offsetParent !== null).map(b => {
  const r = b.getBoundingClientRect(), q = c => b.querySelector(c)?.textContent ?? null;
  return { name: q('.name') ?? b.textContent.trim(), check: q('.check'), hint: q('.hint'), dot: !!b.querySelector('.dot'),
    inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight };
}), scope);

async function openMenu(t, title) {
  const c = await reveal(t, `.filmstrip.grid .thumb[title=${JSON.stringify(title)}]`);
  await t.driver.rightClick(c.x, c.y);
  await until(() => t.driver.observe(() => !!document.querySelector('.context-menu')), 'the photo menu');
}
// hover a submenu's parent so it opens, then pick a row by its own text
async function pick(t, parent, row, rowSelector) {
  const p = await reveal(t, `${MENU} .has-sub > button`, parent);
  await t.driver.move(p.x, p.y);
  await until(() => t.driver.observe(() => [...document.querySelectorAll('.context-menu.submenu')]
    .some(e => getComputedStyle(e).display !== 'none')), `${parent} submenu`);
  return rowSelector ? rowSelector : row;
}

export async function libraryMenuRate(t) {
  if (!t.fixtureDir) throw new Blocked('no fixture folder');
  await until(() => t.driver.observe((s) => document.querySelectorAll(s).length >= 3, '.filmstrip .thumb[data-imgid]'), 'three photos', 120000);
  if (!await t.driver.observe(() => !!document.querySelector('.filmstrip.grid'))) await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  await pause(1500);
  const names = (await everything(t)).map(c => c.title);
  group = names.slice(0, 3);
  assert(names.length >= 3, `grid lists three photos (${names.length})`);
  // select all three: click the first, Shift-click the third
  const a = await reveal(t, `.filmstrip.grid .thumb[title=${JSON.stringify(names[0])}]`);
  await t.driver.point(a.x, a.y);
  const c = await reveal(t, `.filmstrip.grid .thumb[title=${JSON.stringify(names[2])}]`);
  await t.driver.modifiedPoint('\uE008', c.x, c.y);
  await until(async () => (await state(t)).filter(x => x.selected).length === 3, 'three photos selected');
  assert(!(await fourth(t)).selected, 'the fourth photo is not selected');

  // the menu on the middle photo, which is in the selection
  await openMenu(t, names[1]);
  const top = await buttons(t, MENU);
  t.measure({ name: 'menu', top });
  const labelsOf = top.map(b => b.name);
  assert.deepEqual(labelsOf.slice(0, 4), ['Rating', 'Color Label', 'Reject', 'Keywords…'], `group leads the menu: ${labelsOf}`);
  assert.equal(top.find(b => b.name === 'Reject').hint, 'X');
  assert.equal(top.find(b => b.name === 'Keywords…').hint, 'K');
  assert(top.every(b => b.inside), 'every menu button is inside the window');
  await t.evidence('library-menu-open');

  // Rating > 3 stars
  await pick(t, 'Rating');
  const rows = await buttons(t, SUB);
  assert.deepEqual(rows.map(r => r.name), ['★★★★★', '★★★★☆', '★★★☆☆', '★★☆☆☆', '★☆☆☆☆', 'No Rating'], 'rating rows');
  assert.deepEqual(rows.map(r => r.hint), ['5', '4', '3', '2', '1', '0'], 'rating hints');
  assert(rows.every(r => r.inside), 'rating submenu inside the window');
  await t.evidence('library-menu-rating');
  await textButton(t, SUB, '★★★☆☆');
  await until(async () => (await state(t)).every(x => x.stars === 3 && !x.rejected), 'all three rated 3 stars');

  // the check mark on 3 stars, then the label submenu
  await openMenu(t, names[1]);
  await pick(t, 'Rating');
  const checked = (await buttons(t, SUB)).filter(r => r.check === '✓').map(r => r.name);
  assert.deepEqual(checked, ['★★★☆☆'], 'a check on the rating all three share');
  // choosing the same rating again leaves it as it was and closes the menu
  await textButton(t, SUB, '★★★☆☆');
  await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu closed');
  await until(async () => (await state(t)).every(x => x.stars === 3), 'still three stars');

  // Color Label > Red, then Purple
  await openMenu(t, names[1]);
  await pick(t, 'Color Label');
  const lab = await buttons(t, SUB);
  assert.deepEqual(lab.map(r => r.name), ['Red', 'Yellow', 'Green', 'Blue', 'Purple'], 'label rows');
  assert.deepEqual(lab.map(r => r.hint), ['6', '7', '8', '9', ''], 'label hints');
  assert(lab.every(r => r.dot), 'each label has a dot');
  assert(lab.every(r => r.inside), 'label submenu inside the window');
  await t.evidence('library-menu-labels');
  await textButton(t, SUB, 'Red');
  await until(async () => (await state(t)).every(x => x.labels.length === 1), 'red on all three');
  await openMenu(t, names[1]);
  await pick(t, 'Color Label');
  assert.deepEqual((await buttons(t, SUB)).filter(r => r.check === '✓').map(r => r.name), ['Red'], 'check on Red');
  await textButton(t, SUB, 'Purple');
  await until(async () => (await state(t)).every(x => x.labels.length === 2), 'purple added on all three');
  await openMenu(t, names[1]);
  await pick(t, 'Color Label');
  await textButton(t, SUB, 'Red');
  await until(async () => (await state(t)).every(x => x.labels.length === 1), 'red toggled off on all three');
  await openMenu(t, names[1]);
  await pick(t, 'Color Label');
  await textButton(t, SUB, 'Purple');
  await until(async () => (await state(t)).every(x => x.labels.length === 0), 'labels cleared');

  // Reject, then Unreject
  await openMenu(t, names[1]);
  await textButton(t, MENU, 'Reject');
  await until(async () => (await state(t)).every(x => x.rejected), 'all three rejected');
  await openMenu(t, names[1]);
  const un = (await buttons(t, MENU)).map(b => b.name);
  assert(un.includes('Unreject') && !un.includes('Reject'), `the item reads Unreject: ${un}`);
  await t.evidence('library-menu-unreject');
  await textButton(t, MENU, 'Unreject');
  await until(async () => (await state(t)).every(x => !x.rejected), 'all three unrejected');

  // No Rating clears the stars
  await openMenu(t, names[1]);
  await pick(t, 'Rating');
  await textButton(t, SUB, 'No Rating');
  await until(async () => (await state(t)).every(x => x.stars === 0), 'no stars');
  const other = await fourth(t);
  assert(other.stars === 0 && !other.rejected && !other.labels.length, 'the unselected photo never changed');

  // Keywords… opens the keyword dialog for the three selected photos
  await openMenu(t, names[1]);
  await textButton(t, MENU, 'Keywords…');
  const heading = await until(() => t.driver.observe(() => document.querySelector('[aria-label="Grid keywords"] h2')?.textContent ?? null),
    'the keyword dialog');
  assert.match(heading, /^Keywords · 3 photos$/, 'Keywords… acts on the whole selection');
}
