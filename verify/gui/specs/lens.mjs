// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool } from '../support/controls.mjs';
import { Blocked, panel, expandSections, textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

// Lens Corrections > Enable Profile Corrections changes the picture on a raw
// whose camera is in the lens database. a camera missing from it (the Sony
// ZV-1 before the database was updated) leaves the picture unchanged, which
// fails here. run it on a ZV-1 raw: --fixture configured, with the raw as the
// config's fixture
export async function lensProfile(t) {
  if (!t.fixture.raw) throw new Blocked('Lens profile needs a raw fixture whose camera is in the lensfun database (a Sony ZV-1 raw)');
  // a case before may have left another tool open (the mask cases leave Masks)
  await openTool(t, 'adjust');
  const root = await panel(t, 'lens');
  await expandSections(t, root);
  const selector = `${root} [data-control-id="lens_profile"] input[type=checkbox]`;
  const initial = await reveal(t, selector), first = await settledPhoto(t);
  await t.evidence('lens-initial');
  const flip = async (want, previous, what) => {
    await click(t, selector);
    await until(async () => (await t.driver.observe(inspect, selector)).checked === want, `profile corrections ${want ? 'on' : 'off'}`);
    const after = await settledPhoto(t, p => p.hash !== previous.hash).catch(() => null);
    assert(after, `${what}: the picture did not change, so the camera has no lens profile in the database`);
    return after;
  };
  const second = await flip(!initial.checked, first, 'toggling Enable Profile Corrections');
  t.measure({ name: 'lens-profile', initial: initial.checked, hashes: [first.hash, second.hash] });
  await t.evidence('lens-toggled');
  // back to the starting state restores the starting picture
  const third = await flip(initial.checked, second, 'toggling it back');
  assert.equal(third.hash, first.hash, 'switching the profile back restores the first picture');
}

// Lens Corrections > Lens: the drop-down shows the lens matched from the
// file, its search box filters ("12-32" keeps the 12-32mm lenses), picking a
// very different lens changes the picture, and Auto restores it
export async function lensPick(t) {
  if (!t.fixture.raw) throw new Blocked('Lens pick needs a raw fixture whose camera is in the lensfun database');
  // a case before may have left another tool open (the mask cases leave Masks)
  await openTool(t, 'adjust');
  const root = await panel(t, 'lens');
  await expandSections(t, root);
  const toggle = `${root} [data-control-id="lens_profile"] input[type=checkbox]`;
  const button = `${root} .lens-button`, search = ".lens-menu input", options = ".lens-list button[role=option]";
  const names = () => t.driver.observe(s => [...document.querySelectorAll(s)].map(b => b.textContent.trim()), options);
  if (!(await reveal(t, toggle)).checked) {
    const before = await settledPhoto(t);
    await click(t, toggle);
    await settledPhoto(t, p => p.hash !== before.hash).catch(() => null);
  }
  const first = await settledPhoto(t);
  const label = async () => (await t.driver.observe(inspect, button)).text;
  assert(/^Auto/.test(await label()), `starts on Auto, shows "${await label()}"`);
  const open = async () => {
    await click(t, button);
    await until(() => t.driver.observe(s => !!document.querySelector(s), search), 'lens search opens');
  };
  const typeQuery = async text => {
    await t.driver.keys(...text.split(''));
    await until(async () => { const n = await names(); return n.length > 0 && n.every(x => x.toLowerCase().includes(text.toLowerCase())); }, `lenses matching ${text}`);
  };
  await open();
  const all = await names();
  assert(/^Auto/.test(all[0]) && all.length > 5, `the list leads with Auto and holds the camera's lenses: ${all.length}`);
  await typeQuery('12-32');
  const filtered = await names();
  assert(filtered.every(n => n.includes('12-32')), `every match has 12-32: ${filtered}`);
  assert(filtered.some(n => /12-32mm/i.test(n)), `the 12-32mm lens is listed: ${filtered}`);
  await t.evidence('lens-search');
  // clear the query, then search for a fisheye
  await t.driver.keys(...Array(5).fill(''));
  await typeQuery('fish');
  const fish = (await names())[0];
  await textButton(t, ".lens-list", fish);
  await until(async () => (await label()) === fish, 'the chosen lens is shown');
  const second = await settledPhoto(t, p => p.hash !== first.hash).catch(() => null);
  assert(second, 'choosing a fisheye lens changes the picture');
  await t.evidence('lens-chosen');
  t.measure({ name: 'lens-pick', chosen: fish, hashes: [first.hash, second.hash] });
  await open();
  await textButton(t, ".lens-list", (await names())[0]);
  await until(async () => /^Auto/.test(await label()), 'Auto is shown again');
  const third = await settledPhoto(t, p => p.hash !== second.hash).catch(() => null);
  assert(third, 'Auto changes the picture back');
  assert.equal(third.hash, first.hash, 'Auto restores the first picture');
}
