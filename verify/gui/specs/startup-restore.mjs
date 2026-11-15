// SPDX-License-Identifier: GPL-3.0-or-later
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import { dismissTour, settledPhoto } from './smoke.mjs';

export async function startupRestore(t) {
  await until(async () => { try { return await t.driver.guard(); } catch { return false; } }, 'Immage main window', 60000);
  await until(() => t.driver.observe(() => document.fonts.status === 'loaded'), 'fonts');
  const initial = await until(() => t.driver.observe(() => ({
    grid: !!document.querySelector('.filmstrip.grid'),
    file: document.querySelector('.filmstrip .thumb.active')?.title ?? null,
  })).then(x => x.grid && x.file && x), 'saved folder grid and photo appear during restore', 60000);
  await dismissTour(t);
  const photo = await settledPhoto(t);
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'restored photo first frame replaces grid');
  const final = await t.driver.observe(() => ({
    grid: !!document.querySelector('.filmstrip.grid'),
    active: document.querySelector('.filmstrip .thumb.active')?.title ?? null,
  }));
  assert(initial.file === 'stairs-to-mountain.jpg', `restores saved photo (${initial.file})`);
  assert(!final.grid, 'the restored photo opens in the editor after its first frame');
  await t.evidence('startup-restored-photo');
  t.measure({ name: 'startup-restore', initial, final, photo: { hash: photo.hash, width: photo.width, height: photo.height } });
}
