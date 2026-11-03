// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { Blocked } from '../support/scenario.mjs';

// A tiling window manager that tiles the splash instead of floating it
// stretches it over the workspace. The session starts after the splash has
// closed, so the splash keeps the largest size it was given in localStorage.
export const SPLASH = { width: 640, height: 427 };
const splashSize = t => t.driver.observe(() => {
  const m = /^(\d+)x(\d+)$/.exec(localStorage.getItem('immage.splashSize') ?? '');
  return m && { width: +m[1], height: +m[2] };
});

let launchSplash;
export async function startup(t) {
  await until(async () => { try { return await t.driver.guard(); } catch { return false; } }, 'Immage main window', 60000);
  // Read here, at launch; the splash case judges it, so a tiled splash
  // does not stop the cases that follow startup.
  launchSplash = await splashSize(t);
  t.measure({ name: 'splash', observed: launchSplash ?? 'not recorded', expected: SPLASH });
  await until(() => t.driver.observe(() => document.fonts.status === 'loaded'), 'fonts');
  // Wait for the first-run tour's actual hit target and animated layout before
  // sending input. The pointer still goes through the real control.
  const touring = await t.driver.observe(() => !!document.querySelector('.tour'));
  if (touring) {
    let previous, matches = 0;
    const p = await until(async () => {
      const now = await t.driver.observe(read.button, 'Skip');
      if (!now) return false;
      if (previous && Math.abs(now.x - previous.x) < .5 && Math.abs(now.y - previous.y) < .5) matches++;
      else matches = 0;
      previous = now;
      return matches >= 3 && now;
    }, 'stable, clickable tour Skip button');
    await t.driver.point(p.x, p.y);
    await until(() => t.driver.observe(() => !document.querySelector('.tour')), 'tour closed');
  }
  await t.evidence('opened');
  const initial = await settledPhoto(t);
  assert(initial.alpha > 250 && initial.luma > 1, 'fixture photo must be visibly rendered');
  await t.evidence('startup');
  t.measure({ name: 'startup', photo: summary(initial), environment: await t.driver.observe(read.environment) });
}

export async function settledPhoto(t, predicate = () => true) {
  // the viewer's working indicator means a render is still on its way (a
  // native module's second pass can land after three equal frames); after
  // 20 s of other jobs (thumbnails) it no longer holds the frame back
  let last, same = 0, since = Date.now();
  const start = Date.now();
  return until(async () => {
    const now = await t.driver.observe(read.photo);
    if (!now || now.alpha < 250 || !predicate(now)) { same = 0; return false; }
    if (last?.hash === now.hash) same++; else { same = 0; since = Date.now(); }
    last = now;
    // Matching pixels after release plus the production canvas quality marker:
    // a stable drag draft cannot satisfy final-frame readiness.
    return same >= 3 && Date.now() - since >= 600 && now.quality === 'final'
      && (!now.working || Date.now() - start > 20000) ? now : false;
  }, 'a settled final photo frame', 60000);
}
const summary = ({ rgba, ...rest }) => rest;
// After a reset: wait for a settled frame other than the edited one, then
// compare it with the baseline by mean absolute error (exact is 0).
export async function settledReset(t, baseline, edited, label = 'reset') {
  const reset = await settledPhoto(t, p => p.hash !== edited.hash);
  let error = 0;
  for (let i = 0; i < reset.rgba.length; i++) error += Math.abs(reset.rgba[i] - baseline.rgba[i]);
  error /= reset.rgba.length;
  t.measure({ name: label, photoHash: reset.hash, baselineHash: baseline.hash, meanAbsoluteError: error });
  assert(error < 1, `${label}: photo mean pixel error ${error} exceeds 1/255`);
  return reset;
}

export async function exposure(t) {
  const title = await t.driver.observe(read.panelTitle);
  assert(title, 'Basic panel must exist');
  if (!title.open) await t.driver.point(title.x, title.y);
  let slider = await until(async () => { const s = await t.driver.observe(read.exposure); return s?.visible && !s.disabled && s; }, 'visible Exposure slider');
  assert(slider.hit, 'Exposure track must receive hit testing');
  // Reset with a real double click, then establish a final neutral baseline.
  await t.driver.point(slider.label.x, slider.label.y, 2);
  await until(async () => Math.abs((await t.driver.observe(read.exposure)).value) < .02, 'neutral Exposure');
  const baseline = await settledPhoto(t);
  await t.evidence('exposure-neutral');
  for (const [name, target] of [['bright', 1], ['dark', -1]]) {
    slider = await t.driver.observe(read.exposure);
    const { x, y, width, height } = slider.bounds;
    const at = value => ({ x: x + 8 + (width - 16) * (value - slider.min) / (slider.max - slider.min), y: y + height / 2 });
    await t.driver.drag(at(slider.value), at(target));
    const changed = await until(async () => { const s = await t.driver.observe(read.exposure); return Math.abs(s.value - target) < .3 && s; }, `Exposure near ${target}`);
    assert(Math.abs(parseFloat(changed.displayed) - changed.value) < .02, 'displayed Exposure must match range value');
    const frame = await settledPhoto(t, p => p.hash !== baseline.hash && (target > 0 ? p.luma > baseline.luma + 2 : p.luma < baseline.luma - 2));
    t.measure({ name, slider: changed, photo: summary(frame) });
    await t.evidence(`exposure-${name}`);
  }
  slider = await t.driver.observe(read.exposure);
  await t.driver.point(slider.label.x, slider.label.y, 2);
  await until(async () => Math.abs((await t.driver.observe(read.exposure)).value) < .02, 'reset Exposure');
  const reset = await settledPhoto(t, p => Math.abs(p.luma - baseline.luma) < 1);
  let error = 0;
  for (let i = 0; i < reset.rgba.length; i++) error += Math.abs(reset.rgba[i] - baseline.rgba[i]);
  error /= reset.rgba.length;
  assert(error < 1, `reset photo mean pixel error ${error} exceeds 1/255`);
  t.measure({ name: 'reset', photo: summary(reset), meanAbsoluteError: error });
  await t.evidence('exposure-reset');
}

export async function splash(t) {
  if (!launchSplash) throw new Blocked('the splash did not record its size (immage.splashSize)');
  t.measure({ name: 'splash', observed: launchSplash, expected: SPLASH });
  assert(launchSplash.width <= SPLASH.width + 2 && launchSplash.height <= SPLASH.height + 2,
    `splash keeps its size instead of being tiled (${launchSplash.width}x${launchSplash.height})`);
}
