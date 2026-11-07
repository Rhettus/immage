// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { click, reveal, inspect } from '../support/controls.mjs';
import { Blocked, panel, expandSections } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

// Lens Corrections > Enable Profile Corrections changes the picture on a raw
// whose camera is in the lens database. a camera missing from it (the Sony
// ZV-1 before the database was updated) leaves the picture unchanged, which
// fails here. run it on a ZV-1 raw: --fixture configured, with the raw as the
// config's fixture
export async function lensProfile(t) {
  if (!t.fixture.raw) throw new Blocked('Lens profile needs a raw fixture whose camera is in the lensfun database (a Sony ZV-1 raw)');
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
