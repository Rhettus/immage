// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, inspect } from '../support/controls.mjs';
import { choose, panel, expandSections, textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { startup, settledPhoto } from './smoke.mjs';

const menu = '[data-control-id="profile"] select';
const dialog = '[data-dialog="agx-presets"]';
const checks = `${dialog} input[type=checkbox]`;
const label = 'AgX test look';
const options = t => t.driver.observe(s => [...document.querySelector(s).options].filter(o => !o.hidden).map(o => ({ value: o.value, label: o.label })), menu);
const selected = t => t.driver.observe(s => document.querySelector(s)?.selectedOptions[0]?.label, menu);
const closed = t => until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'AgX loader closed');

export async function agxPresets(t) {
  const root = await panel(t, 'basic');
  await expandSections(t, root);
  await click(t, menu);
  await until(() => t.driver.observe(() => !!document.querySelector('.select-menu')), 'Profile menu open');
  const actions = await t.driver.observe(() => {
    const buttons = [...document.querySelectorAll('.select-menu button')];
    const load = buttons.find(b => b.textContent === 'Load AgX Preset');
    const remove = buttons.find(b => b.textContent === 'Delete AgX Preset');
    const spacer = load?.previousElementSibling;
    return { names: buttons.slice(-2).map(b => b.textContent), deleteDisabled: remove?.disabled,
      spacer: spacer?.classList.contains('menu-label') && !spacer.textContent.trim() };
  });
  assert.deepEqual(actions.names, ['Load AgX Preset', 'Delete AgX Preset']);
  assert(actions.spacer, 'preset actions follow a group spacer');
  assert(actions.deleteDisabled, 'Delete disabled without imported presets');
  await t.evidence('agx-menu-actions');
  await t.driver.keys('\uE00C');
  const initial = await settledPhoto(t);
  const original = (await t.driver.observe(inspect, menu)).value;
  const open = async () => {
    await choose(t, menu, -1, dialog);
    await until(() => t.driver.observe(s => document.querySelectorAll(s).length === 1, checks), 'only the user AgX preset found');
    assert.equal(await t.driver.observe(s => document.querySelector(s).textContent.includes('GUI|AgX test look'), dialog), true);
    assert.equal(await t.driver.observe(s => /Hidden builtin|Other module/.test(document.querySelector(s).textContent), dialog), false);
  };
  const addDisabled = () => t.driver.observe(s => [...document.querySelectorAll(`${s} button`)].find(b => b.textContent === 'Add')?.disabled, dialog);
  // Cancelling the action cannot select its sentinel value or edit the photo.
  await open();
  await click(t, checks);
  await until(addDisabled, 'Add disabled when nothing is checked');
  await t.evidence('agx-empty-selection');
  await textButton(t, dialog, 'Close');
  await closed(t);
  assert.equal((await t.driver.observe(inspect, menu)).value, original);
  assert.equal((await settledPhoto(t)).hash, initial.hash);

  await open();
  await textButton(t, dialog, 'From darktable');
  await until(() => t.driver.observe(s => document.querySelectorAll(s).length === 1, checks), 'refresh keeps the user AgX preset');
  await until(async () => !(await addDisabled()), 'Add enabled');
  await t.evidence('agx-found');
  await textButton(t, dialog, 'Add');
  await closed(t);
  await until(async () => (await selected(t)) === label, 'imported profile selected');
  const imported = await settledPhoto(t, p => p.hash !== initial.hash);
  await t.evidence('agx-applied');
  const first = (await options(t)).find(o => o.label === label);
  assert(first && Number(first.value) >= 100);

  // Import the same name again: two independently selectable saved profiles.
  await open();
  await textButton(t, dialog, 'Add');
  await closed(t);
  await until(async () => (await selected(t)) === `${label} (2)`, 'duplicate numbered');
  const duplicate = (await options(t)).find(o => o.label === `${label} (2)`);
  assert(duplicate && duplicate.value !== first.value);
  await choose(t, menu, 0);
  await settledPhoto(t, p => p.hash !== imported.hash);
  await choose(t, menu, first.value);
  assert.equal((await settledPhoto(t, p => p.hash === imported.hash)).hash, imported.hash);
  await t.evidence('agx-reselected');
  // Wait for normal autosave before shutting down this test app.
  await until(async () => (await t.sidecars()).length > 0, 'photo sidecar saved');
  await t.restart();
  await startup(t);
  await panel(t, 'basic');
  await expandSections(t, root);
  const restoredOptions = await options(t);
  assert(restoredOptions.some(o => o.value === first.value && o.label === label));
  assert(restoredOptions.some(o => o.value === duplicate.value && o.label === `${label} (2)`));
  await until(async () => (await selected(t)) === label, 'photo reopens on imported profile');
  assert.equal((await settledPhoto(t)).hash, imported.hash, 'restart restores the saved render');
  await t.evidence('agx-after-restart');
  // Use a real preference selection to make deletion exercise the default gate.
  const defaultMenu = '.prefs [data-pref-label="Profile"] select';
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'New Photos');
  await choose(t, defaultMenu, first.value);
  await textButton(t, '.prefs-foot', 'Done');
  const removeDialog = '[data-dialog="agx-presets-delete"]';
  const removeChecks = `${removeDialog} input[type=checkbox]`;
  await choose(t, menu, -2, removeDialog);
  await until(() => t.driver.observe(s => document.querySelectorAll(s).length === 2, removeChecks), 'only two imported presets offered for deletion');
  const names = await t.driver.observe(s => [...document.querySelectorAll(`${s} label`)].map(e => e.textContent.trim()), removeDialog);
  assert.deepEqual(names, [label, `${label} (2)`], 'builtins absent from delete dialog');
  const deleteDisabled = () => t.driver.observe(s => [...document.querySelectorAll(`${s} button`)].find(b => b.textContent === 'Delete')?.disabled, removeDialog);
  assert(await deleteDisabled(), 'deletion requires an explicit selection');
  await click(t, `${removeDialog} label:first-of-type input[type=checkbox]`);
  const replacementMenu = `${removeDialog} select[data-action="agx-replacement-default"]`;
  await until(() => t.driver.observe(s => !!document.querySelector(s), replacementMenu), 'default replacement required');
  assert(await deleteDisabled(), 'default cannot be deleted without an explicit replacement');
  const replacements = await t.driver.observe(s => [...document.querySelector(s).options].map(o => o.value), replacementMenu);
  assert(!replacements.includes(first.value), 'preset being deleted cannot replace itself');
  assert(replacements.includes(duplicate.value), 'surviving user preset can replace default');
  await choose(t, replacementMenu, duplicate.value);
  await t.evidence('agx-delete-selection');
  await textButton(t, removeDialog, 'Close');
  await until(() => t.driver.observe(s => !document.querySelector(s), removeDialog), 'cancel deletion');
  assert((await options(t)).some(o => o.value === first.value), 'cancel keeps selected preset');
  assert.equal((await settledPhoto(t)).hash, imported.hash, 'cancel deletion preserves pixels');
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'New Photos');
  assert.equal((await t.driver.observe(inspect, defaultMenu)).value, first.value, 'cancel did not change the default');
  await textButton(t, '.prefs-foot', 'Done');
  await choose(t, menu, -2, removeDialog);
  await click(t, `${removeDialog} label:first-of-type input[type=checkbox]`);
  assert(await deleteDisabled(), 'replacement must be explicitly chosen again after cancel');
  await choose(t, replacementMenu, duplicate.value);
  await textButton(t, removeDialog, 'Delete');
  await until(() => t.driver.observe(s => !document.querySelector(s), removeDialog), 'delete dialog closed');
  assert(!(await options(t)).some(o => o.value === first.value), 'deleted profile absent from menu');
  assert((await options(t)).some(o => o.value === duplicate.value), 'unselected profile remains');
  assert.equal(await selected(t), `${label} (deleted)`);
  assert.equal((await settledPhoto(t)).hash, imported.hash, 'deleting applied preset preserves pixels');
  await t.restart();
  await startup(t);
  await panel(t, 'basic');
  await expandSections(t, root);
  assert(!(await options(t)).some(o => o.value === first.value), 'deleted entry stays absent after restart');
  assert((await options(t)).some(o => o.value === duplicate.value));
  assert.equal((await settledPhoto(t)).hash, imported.hash, 'deleted preset still preserves saved photo');
  await t.evidence('agx-deleted-after-restart');
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'New Photos');
  assert.equal((await t.driver.observe(inspect, defaultMenu)).value, duplicate.value, 'chosen replacement persists after restart');
  await textButton(t, '.prefs-foot', 'Done');

  await choose(t, menu, -2, removeDialog);
  await until(() => t.driver.observe(s => document.querySelectorAll(s).length === 1, removeChecks), 'only remaining imported preset listed');
  await click(t, removeChecks);
  assert(await deleteDisabled(), 'last user preset is now the default and also requires a replacement');
  await choose(t, replacementMenu, 0);
  await textButton(t, removeDialog, 'Delete');
  await until(() => t.driver.observe(s => !document.querySelector(s), removeDialog), 'last preset deleted');
  assert(!(await options(t)).some(o => Number(o.value) >= 100), 'all imported entries removed');
  assert.equal((await settledPhoto(t)).hash, imported.hash, 'deleting last preset preserves current photo');
  await click(t, menu);
  await until(() => t.driver.observe(() => !!document.querySelector('.select-menu')), 'menu after last deletion');
  assert(await t.driver.observe(() => [...document.querySelectorAll('.select-menu button')]
    .find(b => b.textContent === 'Delete AgX Preset')?.disabled), 'Delete disabled again after last preset');
  await t.evidence('agx-all-deleted');
  await t.driver.keys('\uE00C');

  t.measure({ name: 'agx-presets', profiles: [first, duplicate], hashes: [initial.hash, imported.hash] });
}
