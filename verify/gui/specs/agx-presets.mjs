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
const options = t => t.driver.observe(s => [...document.querySelector(s).options].map(o => ({ value: o.value, label: o.label })), menu);
const selected = t => t.driver.observe(s => document.querySelector(s)?.selectedOptions[0]?.label, menu);
const closed = t => until(() => t.driver.observe(s => !document.querySelector(s), dialog), 'AgX loader closed');

export async function agxPresets(t) {
  const root = await panel(t, 'basic');
  await expandSections(t, root);
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
  t.measure({ name: 'agx-presets', profiles: [first, duplicate], hashes: [initial.hash, imported.hash] });
}
