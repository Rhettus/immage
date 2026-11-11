// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { panel } from '../support/scenario.mjs';
import { reveal, rangeSelector } from '../support/controls.mjs';
import { settledPhoto } from './smoke.mjs';

// the save error notice as shown: its text, and whether it is on screen and
// uncovered. the activity notices take no pointer events, so the point under
// one hits the photo beneath: covered means a panel or dialog is hit instead
const notice = t => t.driver.observe(() => {
  const el = document.querySelector('[data-save-error]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const viewer = el.closest('main');
  const points = [[.1, .5], [.5, .5], [.9, .5]].map(([fx, fy]) => document.elementFromPoint(r.x + r.width * fx, r.y + r.height * fy));
  return { text: el.textContent, visible: r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
           uncovered: !!viewer && points.every(hit => hit && viewer.contains(hit)), color: getComputedStyle(el.querySelector('.failed') ?? el).color };
});

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

const sidecar = async t => (await t.sidecarsNamed()).find(s => s.file === `${t.fixture.file}.xmp`)?.text;
// the sidecar is saved about 600 ms after an edit
const savedSince = (t, before) => until(async () => { const now = await sidecar(t); return now && now !== before && now; }, 'edit saved to the sidecar', 15000);

// engine/main.c, _write_xmp_whole: a save the folder refuses leaves the old
// sidecar as it was, and a notice that stays until a save works names the
// sidecar and the reason (App.tsx, saveError)
export async function saveFailure(t) {
  await settledPhoto(t);
  const first = await dragExposure(t, 1);
  const saved = await savedSince(t, await sidecar(t));
  const name = `${t.fixture.file}.xmp`;
  let message;
  await t.fixturesWritable(false);
  try {
    await dragExposure(t, -1);
    const shown = await until(async () => { const n = await notice(t); return n?.text.toLowerCase().includes(`could not save the edit to ${name.toLowerCase()}`) && n; },
                              'a notice names the sidecar that could not be saved', 15000);
    message = shown.text;
    assert.match(message, /Permission denied|read-only/i, `the notice gives the reason: ${message}`);
    // frames painted after the failed save must not take it away
    await new Promise(r => setTimeout(r, 4000));
    const later = await notice(t);
    assert(later?.text === message, `the notice is still shown 4 s later: ${JSON.stringify(later)}`);
    assert(later.visible && later.uncovered, `the notice is on screen and not covered: ${JSON.stringify(later)}`);
    await t.evidence('save-failed-notice');
    assert.equal(await sidecar(t), saved, 'the old sidecar is unchanged');
    assert(!(await t.fixtureFiles()).some(f => f.endsWith('.immage-tmp')), 'no copy is left in the folder');
  } finally {
    await t.fixturesWritable(true);
  }
  t.measure({ name: 'save-failed', status: message, exposure: first.value });

  // with the folder writable again the next edit saves
  await dragExposure(t, 0.5);
  const after = await savedSince(t, saved);
  assert.notEqual(after, saved, 'the next edit is saved');
  await until(async () => !(await notice(t)), 'the notice goes once a save works');
  assert(!(await t.fixtureFiles()).some(f => f.endsWith('.immage-tmp')), 'no copy is left after the next save');
  await t.evidence('save-recovered');
}
