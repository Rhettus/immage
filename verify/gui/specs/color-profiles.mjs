// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, inspect, openTool } from '../support/controls.mjs';
import { choose } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { startup, settledPhoto, settledReset } from './smoke.mjs';
import { prepareNegative } from './workflows.mjs';

const input = '[data-control-id="neg_input_profile"] select';
const working = '[data-control-id="neg_working_profile"] select';
export async function colorProfiles(t) {
  await prepareNegative(t);
  const original = await settledPhoto(t);
  const values = async () => [Number((await t.driver.observe(inspect, input)).value),
    Number((await t.driver.observe(inspect, working)).value)];
  await until(async () => (await t.driver.observe(inspect, input))?.options?.some(o => o.label === 'Immage test scanner'), 'input ICC loaded');
  const inputOptions = (await t.driver.observe(inspect, input)).options;
  const workOptions = (await t.driver.observe(inspect, working)).options;
  assert(workOptions.some(o => o.label === 'Immage test working'), 'working ICC loaded');
  assert(!workOptions.some(o => o.label === 'Immage test scanner'), 'input-only ICC excluded from working menu');
  const defaults = await values();
  assert(defaults[0] > 0 && defaults[1] > 0);
  await choose(t, input, 3); // Adobe RGB
  const changed = await settledPhoto(t, p => p.hash !== original.hash);
  assert.equal((await values())[1], defaults[1], 'input choice preserves working profile');
  assert(await t.driver.observe(() => document.querySelector('.negative').textContent.includes('Profile changed: pick the film border')), 'repick guidance shown');
  await t.evidence('input-profile');
  await click(t, 'button.tool[title^="undo ("]');
  await settledReset(t, original, changed, 'profile-undo');
  assert.deepEqual(await values(), defaults);
  await choose(t, working, 4); // linear Rec709
  await settledPhoto(t, p => p.hash !== original.hash);
  assert.equal((await values())[0], defaults[0], 'working choice preserves input profile');
  await choose(t, working, 0);
  await settledReset(t, original, changed, 'profile-default');
  const scanner = inputOptions.find(o => o.label === 'Immage test scanner').value;
  const work = workOptions.find(o => o.label === 'Immage test working').value;
  await choose(t, input, scanner);
  await choose(t, working, work);
  const icc = await settledPhoto(t, p => p.hash !== original.hash);
  await until(async () => (await t.sidecars()).some(s => s.includes('colorin')), 'color profile sidecar saved');
  await t.evidence('icc-profiles');
  await t.restart();
  await startup(t);
  await openTool(t, 'negative');
  await until(async () => (await values()).every((v, i) => v === Number([scanner, work][i])), 'ICC selections survive restart');
  assert.equal((await settledPhoto(t)).hash, icc.hash, 'ICC render survives restart');
  await t.evidence('profiles-after-restart');
  // Reset all includes both profiles, and undo brings back the conversion.
  await click(t, 'button[aria-label="reset all"]');
  await until(async () => !(await t.driver.observe(() => !!document.querySelector('.neg-swatch'))), 'Reset all turns conversion off');
  assert.deepEqual(await values(), defaults, 'Reset all restores profile defaults');
  await settledPhoto(t, p => p.hash !== icc.hash);
  await t.evidence('profiles-reset');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => (await values()).every((v, i) => v === Number([scanner, work][i]))
    && await t.driver.observe(() => !!document.querySelector('.neg-swatch')),
    'Undo Reset all restores conversion and profile selections', 10000);
  await settledPhoto(t, p => p.hash === icc.hash);
  assert.deepEqual(await values(), [Number(scanner), Number(work)]);
  t.measure({ name: 'color-profiles', defaults, icc: [scanner, work], restartHash: icc.hash });
}
