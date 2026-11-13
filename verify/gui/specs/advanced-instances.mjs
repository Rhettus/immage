// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool, reveal } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const GROUP = '[data-panel-id="basic"]';
const CARDS = `${GROUP} [data-module^="exposure#"]`;
const MENU_ITEM = a => `.context-menu button[data-instance-action="${a}"]`;
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);

// every exposure card in DOM order, as the page shows it
const cards = t => t.driver.observe((sel) => [...document.querySelectorAll(sel)].map(c => ({
  id: c.getAttribute('data-module'),
  title: c.querySelector('.module-card-title')?.textContent.trim() ?? null,
  tag: c.querySelector('.module-card-tag')?.textContent.trim() ?? null,
  open: !!c.querySelector(':scope > .collapse.open'),
  value: (r => r ? +r.value : null)(c.querySelector('[data-control-id="adv:exposure"] input[type=range]')),
})), CARDS);
const ids = list => list.map(c => c.id);
const cardSel = id => `${GROUP} [data-module="${id}"]`;

// opens a card's instance menu and returns whether the item is disabled
async function openMenu(t, id) {
  await click(t, `${cardSel(id)} .instance-menu .module-card-menu`);
  await until(() => t.driver.observe(() => !!document.querySelector('.context-menu [data-instance-action]')), 'instance menu');
}
const itemDisabled = (t, a) => t.driver.observe(sel => document.querySelector(sel)?.disabled ?? null, MENU_ITEM(a));
async function pick(t, id, action) {
  await openMenu(t, id);
  await click(t, MENU_ITEM(action));
  await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'instance menu closed');
}
const errorText = t => t.driver.observe(() => {
  const s = document.querySelector('.status')?.textContent ?? '';
  return /error|fail|could not|unable/i.test(s) ? s : '';
});

export async function advancedInstances(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    const start = await until(async () => { const c = await cards(t); return c?.length === 1 && c; }, 'one Exposure card');
    const first = start[0].id;
    const baseline = await settledPhoto(t);

    // 1. New instance: a second card after the first, open; the first is tagged Simple
    await pick(t, first, 'new');
    const two = await until(async () => { const c = await cards(t); return c.length === 2 && c; }, 'a second Exposure card');
    assert.equal(two[0].id, first, 'the new card comes after the first');
    assert(two[1].open, 'the new card is open');
    assert.equal(two[0].tag, 'Simple', 'the first card is tagged Simple');
    const second = two[1].id;
    t.measure({ name: 'new-instance', cards: two });
    await t.evidence('instance-new');

    // 2. move the new card's Exposure slider: the frame changes
    const slider = `${cardSel(second)} [data-control-id="adv:exposure"]`;
    const value = await reveal(t, `${slider} .value`);
    await t.driver.point(value.x, value.y, 2);
    await until(() => t.driver.observe(s => !!document.querySelector(`${s} .value-edit`), slider), 'numeric editor');
    await t.driver.keys('1', '\uE007'); // Enter
    await until(async () => Math.abs(((await cards(t)).find(c => c.id === second)?.value ?? 0) - 1) < .02, 'new card Exposure typed as +1 EV');
    const bright = await settledPhoto(t, p => p.hash !== baseline.hash && p.luma > baseline.luma + 2);
    t.measure({ name: 'new-card-plus-one-ev', luma: bright.luma, baselineLuma: baseline.luma });
    await t.evidence('instance-plus-one');

    // 3. rename via the menu
    await pick(t, second, 'rename');
    await until(() => t.driver.observe(sel => !!document.querySelector(sel), `${cardSel(second)} .module-card-rename`), 'rename field');
    await t.driver.keys('l', 'i', 'f', 't', '\uE007'); // typed over the selected text; Enter commits
    const renamed = await until(async () => { const c = (await cards(t)).find(x => x.id === second); return /lift/.test(c?.title ?? '') && c; }, 'card renamed to lift');
    t.measure({ name: 'rename', title: renamed.title });

    // 4. duplicate the renamed card, then move the copy up in the pipe
    await pick(t, second, 'duplicate');
    const three = await until(async () => { const c = await cards(t); return c.length === 3 && c; }, 'a third Exposure card');
    const third = three.map(c => c.id).find(id => !ids(two).includes(id));
    assert(third, 'the duplicate has its own card id');
    assert(three.find(c => c.id === third).title.startsWith('Exposure'), `duplicate title starts with Exposure: ${three.find(c => c.id === third).title}`);
    t.measure({ name: 'duplicate', cards: three });
    await pick(t, third, 'up');
    const moved = await until(async () => { const c = await cards(t); return ids(c)[1] === third && c; }, 'the duplicate moved to second place');
    t.measure({ name: 'move-up', order: ids(moved) });
    await t.evidence('instance-moved');

    // 5. the first card cannot be deleted; deleting the third-created instance removes its card
    await openMenu(t, first);
    assert.equal(await itemDisabled(t, 'delete'), true, 'Delete is disabled on the first instance');
    await t.driver.keys('\uE00C'); // Escape dismisses the menu
    await until(() => t.driver.observe(() => !document.querySelector('.context-menu')), 'menu dismissed')
      .catch(async () => { await click(t, `${cardSel(first)} .module-card-menu`); });
    await pick(t, third, 'delete');
    const afterDelete = await until(async () => { const c = await cards(t); return c.length === 2 && !ids(c).includes(third) && c; }, 'deleted card gone');
    t.measure({ name: 'delete', order: ids(afterDelete) });

    // 6. undo brings the card back, redo removes it again
    await undoRedo(t, 'undo');
    await until(async () => (await cards(t)).length === 3, 'undo restores the deleted card');
    await t.evidence('instance-undone');
    await undoRedo(t, 'redo');
    await until(async () => (await cards(t)).length === 2, 'redo deletes the card again');

    // 7. nothing reported an error
    const err = await errorText(t);
    assert.equal(err, '', `no error notice: ${err}`);
  } finally {
    try {
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
