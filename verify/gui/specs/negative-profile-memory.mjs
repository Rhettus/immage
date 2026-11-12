// SPDX-License-Identifier: GPL-3.0-or-later
// Negative remembers the Input and Working Profiles chosen last: picking the
// film border on a photo still on its default profiles sets them as part of
// the conversion, one undo step, and the memory survives a restart
import assert from 'node:assert/strict';
import { click, inspect, openTool, reveal } from '../support/controls.mjs';
import { choose, Blocked, textButton, openStep } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { startup, settledPhoto, settledReset } from './smoke.mjs';

const input = '[data-control-id="neg_input_profile"] select';
const working = '[data-control-id="neg_working_profile"] select';
// the steps after the border unlock with the conversion
const converted = () => !document.querySelector('.negative .step[data-step="base"].locked');

async function openNegative(t) {
  const b = await reveal(t, 'button[data-tour="negative"]');
  if (!b.active) {
    await click(t, 'button[data-tour="negative"]');
    const warned = await until(() => t.driver.observe(() => document.querySelector('.neg-warn') ? 'warn'
      : document.querySelector('button[data-tour="negative"]:is(.on,.active)') ? 'open' : ''), 'negative warning or tool', 10000).catch(() => '');
    // the dialog can render a frame after the button turns active
    if (warned === 'warn' || await until(() => t.driver.observe(() => !!document.querySelector('.neg-warn')), 'negative warning', 3000).then(() => true, () => false)) await textButton(t, '.neg-warn', 'Continue');
  }
  await openTool(t, 'negative');
  await openStep(t, '.negative', 'profiles');
  await until(() => t.driver.observe(s => !!document.querySelector(s), input), 'Negative profile menus');
}
async function pickBorder(t) {
  await openStep(t, '.negative', 'border');
  await textButton(t, '.negative', 'Pick Film Border');
  const c = await reveal(t, '.zone-object-box');
  await t.driver.point(c.bounds.x + c.bounds.width * .02, c.bounds.y + c.bounds.height * .02);
  await until(() => t.driver.observe(converted), 'negative converted');
  await openStep(t, '.negative', 'profiles');
}

export async function negativeProfileMemory(t) {
  if (t.fixture.name !== 'negative') throw new Blocked('Use --fixture negative for conversion tests');
  const original = await settledPhoto(t);
  await openNegative(t);
  const values = async () => [Number((await t.driver.observe(inspect, input)).value),
    Number((await t.driver.observe(inspect, working)).value)];
  const defaults = await values();
  assert(defaults.every(v => v > 0), `photo starts on its default profiles (${defaults})`);
  assert(!(await t.driver.observe(converted)), 'photo starts unconverted');
  // in each menu the first built-in other than the photo's default
  const other = async (selector, not) => Number((await t.driver.observe(inspect, selector)).options
    .find(o => !o.disabled && Number(o.value) > 0 && !not.includes(Number(o.value)))?.value);
  const chosen = [await other(input, [defaults[0]]), await other(working, [defaults[1]])];
  t.measure({ name: 'menus', input: (await t.driver.observe(inspect, input)).options, working: (await t.driver.observe(inspect, working)).options });
  assert(chosen.every((v, i) => v !== defaults[i]), `chosen profiles differ from the defaults (${defaults})`);
  await choose(t, input, chosen[0]);
  // the Working menu is rebuilt while the Input change applies: wait for
  // its option to be offered again
  await until(async () => (await t.driver.observe(inspect, working))?.options
    ?.some(o => o.value === String(chosen[1]) && !o.disabled), 'working option offered again');
  await choose(t, working, chosen[1]);
  await until(async () => (await values()).every((v, i) => v === chosen[i]), 'both profiles chosen');
  await settledPhoto(t, p => p.hash !== original.hash);
  const stored = await t.driver.observe(() => localStorage.getItem('immage.negProfiles'));
  t.measure({ name: 'remembered', stored, defaults, chosen });
  assert.deepEqual(JSON.parse(stored), { input: chosen[0], working: chosen[1] }, 'choices remembered');
  // back to the defaults by undo: the photo is on its defaults again, the
  // memory stays
  await click(t, 'button.tool[title^="undo ("]');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => (await values()).every((v, i) => v === defaults[i]), 'undo restores the default profiles');
  await settledPhoto(t, p => p.hash === original.hash);
  await t.evidence('defaults-again');

  // the conversion brings the remembered profiles with it
  await pickBorder(t);
  await until(async () => (await values()).every((v, i) => v === chosen[i]), 'conversion applies the remembered profiles', 10000);
  const withMemory = await settledPhoto(t, p => p.hash !== original.hash);
  assert.deepEqual(await values(), chosen);
  await t.evidence('converted-with-remembered');
  // and one undo takes back both the conversion and the profiles
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => !(await t.driver.observe(converted))
    && (await values()).every((v, i) => v === defaults[i]), 'one undo removes conversion and profiles', 10000);
  await settledPhoto(t, p => p.hash === original.hash);
  await t.evidence('undo-conversion');

  // a profile already set on the photo is kept: Working set by hand, then
  // a different one chosen and undone, so the photo holds one working
  // profile and the memory another
  const keep = Number((await t.driver.observe(inspect, working)).options
    .find(o => !o.disabled && Number(o.value) > 0 && ![defaults[1], chosen[1]].includes(Number(o.value)))?.value);
  assert(keep > 0, 'a third working profile to set by hand');
  await choose(t, working, keep);
  await until(async () => (await values())[1] === keep, 'working profile set by hand');
  // an Input change between, so the two Working changes are separate undo steps
  await choose(t, input, chosen[0]);
  await until(async () => (await values())[0] === chosen[0], 'input chosen between');
  await choose(t, working, chosen[1]);
  await until(async () => (await values())[1] === chosen[1], 'working profile chosen again');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => (await values()).every((v, i) => v === [chosen[0], keep][i]), 'undo the second working choice');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => (await values()).every((v, i) => v === [defaults[0], keep][i]), 'input on default, working set by hand');
  assert.deepEqual(JSON.parse(await t.driver.observe(() => localStorage.getItem('immage.negProfiles'))),
    { input: chosen[0], working: chosen[1] }, 'memory differs from the photo\'s working profile');
  await pickBorder(t);
  await until(async () => (await values()).every((v, i) => v === [chosen[0], keep][i]), 'only the default input takes the remembered one', 10000);
  await settledPhoto(t);
  await t.evidence('kept-working');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => !(await t.driver.observe(converted)), 'conversion undone');
  await click(t, 'button.tool[title^="undo ("]');
  await until(async () => (await values()).every((v, i) => v === defaults[i]), 'photo back on default profiles');
  await settledPhoto(t, p => p.hash === original.hash);

  // the memory survives a restart and converts the photo the same way
  await t.restart();
  await startup(t);
  await openNegative(t);
  await until(async () => (await values()).every((v, i) => v === defaults[i]), 'photo reopens on its default profiles');
  assert(!(await t.driver.observe(converted)), 'photo reopens unconverted');
  await pickBorder(t);
  await until(async () => (await values()).every((v, i) => v === chosen[i]), 'remembered profiles after restart', 10000);
  // within 1/255 rather than the same hash: after a restart the converted
  // frame can differ from the first session's by a level in a few pixels
  await settledReset(t, withMemory, null, 'same conversion after restart');
  await t.evidence('after-restart');
  t.measure({ name: 'negative-profile-memory', defaults, chosen, keep, convertedHash: withMemory.hash });
}
