// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { panel } from '../support/scenario.mjs';
import { reveal, rangeSelector } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';

const RESTARTED = 'The engine restarted. The photo was reopened from its last save; undo history was cleared.';
const status = t => t.driver.observe(() => document.querySelector('.status')?.textContent ?? '');
const failed = t => t.driver.observe(() => /The engine keeps stopping/.test(document.querySelector('.activities')?.textContent ?? ''));
const summary = ({ rgba, ...rest }) => rest;

// Drag Exposure to a target through the real slider, then wait for the value.
async function dragExposure(t, target) {
  await panel(t, 'basic');
  await reveal(t, '[data-control-id="exposure"] label');
  await reveal(t, rangeSelector('exposure'));
  const slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && s.hit && !s.disabled && s; }, 'visible Exposure slider');
  const { x, y, width, height } = slider.bounds;
  const at = value => ({ x: x + 8 + (width - 16) * (value - slider.min) / (slider.max - slider.min), y: y + height / 2 });
  await t.driver.drag(at(slider.value), at(target));
  return until(async () => { const s = await t.driver.observe(read.exposure); return Math.abs(s.value - target) < .3 && s; }, `Exposure near ${target}`);
}
const sidecarText = async t => (await t.sidecars()).join('\n');
// the sidecar is saved about 600 ms after an edit
const savedSince = (t, before) => until(async () => { const now = await sidecarText(t); return now !== before && now; }, 'edit saved to the sidecar', 15000);

export async function engineRestart(t) {
  const baseline = await settledPhoto(t);
  const before = await sidecarText(t);
  const edited = await dragExposure(t, 1);
  await savedSince(t, before);
  const afterEdit = await settledPhoto(t, p => p.hash !== baseline.hash);

  const pid = await t.killEngine();
  t.measure({ name: 'engine-killed', pid, exposure: edited.value });

  // the restarting status can be short; the final message is what is required
  let sawRestarting = false;
  await until(async () => {
    const s = await status(t);
    if (/Restarting the engine/.test(s)) sawRestarting = true;
    assert(!(await failed(t)), 'the app gave up: The engine keeps stopping');
    return s === RESTARTED;
  }, 'the engine restart message', 90000);
  t.measure({ name: 'restart-status', sawRestarting });
  await t.evidence('engine-restarted');

  // the same photo, with the saved edit, rendered by the new engine
  const slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s && !s.disabled && s; }, 'Exposure control after restart');
  assert(Math.abs(slider.value - edited.value) < .05, `Exposure after restart ${slider.value}, edited ${edited.value}`);
  const restored = await settledPhoto(t);
  assert(restored.alpha > 250 && restored.luma > 1, 'restarted engine renders the photo');
  assert(Math.abs(restored.luma - afterEdit.luma) < Math.abs(restored.luma - baseline.luma), `restored photo keeps the edit (luma ${restored.luma}, edited ${afterEdit.luma}, neutral ${baseline.luma})`);
  t.measure({ name: 'restored', photo: summary(restored) });

  // the new engine takes edits
  const mid = await sidecarText(t);
  const again = await dragExposure(t, -1);
  await savedSince(t, mid);
  const darker = await settledPhoto(t, p => p.hash !== restored.hash && p.luma < restored.luma - 2);
  t.measure({ name: 'edit-after-restart', slider: again, photo: summary(darker) });
  assert(!(await failed(t)), 'no "The engine keeps stopping" message');
  const log = await t.engineLog();
  assert(log.length > 0, 'engine.log still exists');
  await t.evidence('engine-restart-edited');
}
