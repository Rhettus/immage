// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { click, openTool } from '../support/controls.mjs';
import { panel } from '../support/scenario.mjs';
import { settledPhoto } from './smoke.mjs';
import { setMode } from './editing-mode.mjs';
import { waitSetting } from '../support/settings.mjs';

const KEY = 'immage.editMode';
const OPEN = '.advanced-search button.tool[aria-label="Module order"]';
const DIALOG = '.modal.module-order';
const ALT = '', UP = '', ESCAPE = '';
const undoRedo = (t, which) => click(t, `button.tool[title^="${which} ("]`);

// the dialog's rows top-down: key, number, locked and tooltip
const rows = t => t.driver.observe(sel => [...document.querySelectorAll(`${sel} .order-row`)].map(r => ({
  key: r.getAttribute('data-key'),
  num: r.querySelector('.order-num')?.textContent.trim() ?? null,
  locked: r.classList.contains('locked'),
  title: r.getAttribute('title') ?? '',
})), DIALOG);
const keysOf = list => list.map(r => r.key);
const dialogOpen = t => t.driver.observe(sel => !!document.querySelector(sel), DIALOG);
const applyDisabled = t => t.driver.observe(sel => document.querySelector(`${sel} .order-foot .btn.primary`)?.disabled ?? null, DIALOG);
const orderError = t => t.driver.observe(sel => document.querySelector(`${sel} .order-error`)?.textContent.trim() ?? '', DIALOG);
const noticeError = t => t.driver.observe(() => {
  const s = document.querySelector('.status')?.textContent ?? '';
  return /error|fail|could not|unable/i.test(s) ? s : '';
});

async function openDialog(t) {
  await click(t, OPEN);
  await until(() => dialogOpen(t), 'module order dialog');
  return until(async () => { const r = await rows(t); return r.length > 0 && r; }, 'module order rows');
}
async function closeByEscape(t) {
  await t.driver.keys(ESCAPE);
  await until(async () => !(await dialogOpen(t)), 'dialog closed by Escape');
}
// the current order, read through the dialog and closed again
async function readOrder(t) {
  const r = await openDialog(t);
  await closeByEscape(t);
  return keysOf(r);
}
// focus a row and press Alt+Arrow on it; the page moves focus back to the row afterwards
async function altKey(t, key, arrow) {
  await t.driver.observe((sel, k) => document.querySelector(`${sel} .order-row[data-key="${CSS.escape(k)}"]`)?.focus(), DIALOG, key);
  await t.driver.keys(ALT, arrow);
}

export async function advancedModuleOrder(t) {
  await settledPhoto(t);
  await openTool(t, 'adjust');
  const originalValue = await waitSetting(t, KEY, () => true, 'settings file readable');
  const original = originalValue === 'advanced' ? 'Advanced' : 'Simple';
  try {
    if (original === 'Simple') await setMode(t, 'Advanced');
    await openTool(t, 'adjust');
    await panel(t, 'basic');
    const baseline = await settledPhoto(t);

    // 1. the dialog: rows top-down from 1, a locked row with a tooltip, Apply disabled
    const initial = await openDialog(t);
    assert(initial.length >= 3, `at least three enabled modules are listed, got ${initial.length}`);
    initial.forEach((r, i) => assert.equal(r.num, String(i + 1), `row ${i} is numbered ${i + 1}, got ${r.num}`));
    assert.equal(new Set(keysOf(initial)).size, initial.length, 'row keys are unique');
    assert(initial.every(r => /^.+#\d+$/.test(r.key)), 'row keys are op#priority');
    const locked = initial.filter(r => r.locked);
    assert(locked.length >= 1, 'at least one locked row (a fixed pipe position)');
    assert(locked.every(r => r.title.length > 0), 'every locked row has a tooltip');
    assert.equal(await applyDisabled(t), true, 'Apply is disabled before any change');
    t.measure({ name: 'dialog-rows', count: initial.length, locked: locked.map(r => r.key) });
    await t.evidence('module-order-open');
    const original0 = keysOf(initial);

    // 2. Alt+ArrowUp on a movable row: find one the engine allows to move
    let moved = null, custom = null;
    const movable = [...initial].reverse().filter(r => !r.locked);
    assert(movable.length >= 1, 'at least one unlocked row');
    for (const r of movable) {
      await altKey(t, r.key, UP);
      const now = keysOf(await rows(t));
      if (now.join() !== original0.join()) { moved = r; custom = now; break; }
    }
    assert(moved, `Alt+ArrowUp moved one of ${movable.map(r => r.key).join(', ')}`);
    const before = original0.indexOf(moved.key), after = custom.indexOf(moved.key);
    assert(after < before, `${moved.key} moved up (${before} -> ${after})`);
    const afterRows = await rows(t);
    assert.equal(afterRows[after].num, String(after + 1), 'the moved row shows its new number');
    assert.equal(await applyDisabled(t), false, 'Apply is enabled once the order changes');
    t.measure({ name: 'moved', key: moved.key, from: before, to: after });
    await t.evidence('module-order-moved');

    // 3. Apply: the dialog closes, no error
    await click(t, `${DIALOG} .order-foot .btn.primary`);
    await until(async () => !(await dialogOpen(t)), 'Apply closes the dialog');
    const afterApply = await settledPhoto(t);
    t.measure({ name: 'apply', hash: afterApply.hash, baselineHash: baseline.hash, changed: afterApply.hash !== baseline.hash });
    assert.equal(await noticeError(t), '', 'no error notice after Apply');

    // 4. reopen: the new order persisted; Apply is disabled again
    const reopened = await openDialog(t);
    assert.deepEqual(keysOf(reopened), custom, 'the applied order persists');
    assert.equal(await applyDisabled(t), true, 'Apply is disabled on a fresh dialog');
    assert.equal(await orderError(t), '', 'no error in the dialog');
    await closeByEscape(t);

    // 5. undo is one step back to the original order, redo reapplies
    await undoRedo(t, 'undo');
    await until(async () => (await readOrder(t)).join() === original0.join(), 'undo restores the original order');
    await settledPhoto(t);
    await t.evidence('module-order-undone');
    await undoRedo(t, 'redo');
    await until(async () => (await readOrder(t)).join() === custom.join(), 'redo reapplies the custom order');
    await settledPhoto(t);

    // 6. Reset to default: confirm, applies the default order and closes
    await openDialog(t);
    await click(t, `${DIALOG} .order-foot .btn:not(.primary):first-child`);
    await until(() => t.driver.observe(sel => !!document.querySelector(`${sel} .order-confirm`), DIALOG), 'reset confirmation');
    await t.evidence('module-order-reset-ask');
    // Keep leaves the order alone and closes only the question
    await click(t, `${DIALOG} .order-confirm .btn:last-child`);
    await until(() => t.driver.observe(sel => !document.querySelector(`${sel} .order-confirm`), DIALOG), 'Keep closes the question');
    assert(await dialogOpen(t), 'Keep leaves the dialog open');
    await click(t, `${DIALOG} .order-foot .btn:not(.primary):first-child`);
    await until(() => t.driver.observe(sel => !!document.querySelector(`${sel} .order-confirm`), DIALOG), 'reset confirmation again');
    await click(t, `${DIALOG} .order-confirm .btn:first-of-type`);
    await until(async () => !(await dialogOpen(t)), 'Reset closes the dialog');
    await settledPhoto(t);
    const reset = await readOrder(t);
    assert.deepEqual(reset, original0, 'Reset to default gives the original (default) order');
    assert.equal(await noticeError(t), '', 'no error notice after Reset');

    // 7. undo of the reset returns to the custom order
    await undoRedo(t, 'undo');
    await until(async () => (await readOrder(t)).join() === custom.join(), 'undo of Reset returns to the custom order');
    await settledPhoto(t);
    await t.evidence('module-order-reset-undone');
    // leave the photo in its original order
    await undoRedo(t, 'undo');
    await until(async () => (await readOrder(t)).join() === original0.join(), 'a last undo restores the original order');
    assert.equal(await noticeError(t), '', 'no error notice at the end');
  } finally {
    try {
      if (await t.driver.observe(sel => !!document.querySelector(sel), DIALOG)) await t.driver.keys(ESCAPE);
      const now = await t.driver.observe(() => !!document.querySelector('.advanced-search'));
      if (now !== (original === 'Advanced')) await setMode(t, original);
    } catch { /* the failure above is the one to report */ }
  }
}
