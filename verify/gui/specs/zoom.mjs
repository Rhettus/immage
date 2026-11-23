// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { click, reveal } from '../support/controls.mjs';
import { panel, textButton, Blocked } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { settledPhoto, startup } from './smoke.mjs';

// the viewer, its sharp layer and the 100% copy under it (App.tsx, onCopy)
function viewState() {
  const v = document.querySelector('main.viewer'), s = document.querySelector('canvas.layer.sharp');
  const c = document.querySelector('canvas.layer.copy');
  const r = v.getBoundingClientRect(), cr = c?.getBoundingClientRect();
  return { zoom: v.classList.contains('zoom-in') ? 'in' : 'fit', dpr: devicePixelRatio,
    center: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    sharp: { width: s.width, height: s.height, quality: s.dataset.renderQuality },
    copy: c && c.width && !c.classList.contains('empty') ? { width: c.width, height: c.height, cssWidth: cr.width } : null,
    working: !!document.querySelector('.working.on') };
}
const ZOOM_MS = 1500;

// the first frame that settles the zoom: the viewer at the new level, and a
// final sharp frame that is not the one shown before the click
async function timedZoom(t, from, zoom, label) {
  const start = Date.now();
  let sawWorking = false;
  const frame = await until(async () => {
    const v = await t.driver.observe(viewState);
    sawWorking ||= v.working;
    if (v.zoom !== zoom || v.sharp.quality !== 'final') return false;
    const p = await t.driver.observe(read.photo);
    return p && p.hash !== from.hash && p.alpha > 250 && { ...p, view: v };
  }, label, 60000);
  const ms = Date.now() - start;
  const { rgba, ...photo } = frame;
  t.measure({ name: label, ms, sawWorking, photo });
  return { ms, frame };
}

export async function zoomReady(t) {
  const fit = await settledPhoto(t);
  const at = await t.driver.observe(viewState);
  if (at.zoom !== 'fit') throw new Blocked('the photo did not open fitted');
  // fitted, the 100% copy renders in the background once the base is done
  const t0 = Date.now();
  const copy = await until(async () => (await t.driver.observe(viewState)).copy, '100% copy rendered while fitted', 180000);
  t.measure({ name: 'copy-at-fit', ms: Date.now() - t0, copy });
  assert(Math.abs(copy.cssWidth * at.dpr - copy.width) / copy.width > 0.05, 'while fitted, the copy is shown scaled down');
  await t.evidence('fit-copy-ready');

  await t.driver.point(at.center.x, at.center.y);
  const zin = await timedZoom(t, fit, 'in', 'zoom-in-to-100');
  const inView = zin.frame.view;
  assert(inView.copy && Math.abs(inView.copy.cssWidth * inView.dpr - inView.copy.width) <= 2, 'zoomed to 100%');
  await t.evidence('zoomed-100');
  assert(zin.ms < ZOOM_MS, `first zoom to 100% took ${zin.ms} ms (limit ${ZOOM_MS})`);

  // an edit while zoomed drops both; the fitted view is rendered ahead of the
  // copy (Session.pump), so the copy back means the fitted view is ready
  const zoomed = await settledPhoto(t);
  await panel(t, 'basic');
  const ev = await reveal(t, '[data-control-id="exposure"] input[type=range]');
  // Clicking the track center resets Exposure before incrementing it. Start
  // from its current thumb and make an explicit edit large enough to observe.
  const value = Number(ev.value), target = Math.min(ev.max, value + 0.5);
  assert(target > value, 'Exposure needs room for a brighter edit');
  const point = v => ({x: ev.bounds.x + 8 + (ev.bounds.width - 16)
    * (v - ev.min) / (ev.max - ev.min), y: ev.y});
  await t.driver.drag(point(value), point(target));
  const edited = await settledPhoto(t, p => p.hash !== zoomed.hash);
  await until(async () => !(await t.driver.observe(viewState)).copy, 'copy dropped by the edit', 10000).catch(() => {});
  const t1 = Date.now();
  await until(async () => (await t.driver.observe(viewState)).copy, 'background renders after the edit', 180000);
  t.measure({ name: 'renders-after-edit', ms: Date.now() - t1 });
  await pause(300);

  const out = await t.driver.observe(viewState);
  await t.driver.point(out.center.x, out.center.y);
  const zout = await timedZoom(t, edited, 'fit', 'zoom-out-after-edit');
  await t.evidence('fit-after-edit');
  assert(zout.frame.luma > fit.luma + 1, 'the fitted view shows the edit');
  assert(zout.ms < ZOOM_MS, `zoom out after an edit took ${zout.ms} ms (limit ${ZOOM_MS})`);
}

// Compare native canvas detail, rather than the 64px overview used for tone.
function detailPixels() {
  const c = document.querySelector('canvas.layer.sharp');
  const d = c.getContext('2d').getImageData(Math.floor(c.width / 2) - 64,
    Math.floor(c.height / 2) - 64, 128, 128).data;
  let hash = 2166136261;
  for (const b of d) hash = Math.imul(hash ^ b, 16777619);
  return hash >>> 0;
}

export async function fitDetail(t) {
  const initial = await settledPhoto(t);
  t.measure({name: 'fit-default', width: initial.width, height: initial.height});
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'Performance');
  await click(t, '[data-pref-fold="performance-advanced"]');
  const scaleToggle = `[data-pref-label="Fit frames at the screen's scale"] input[type=checkbox]`;
  if (await t.driver.observe(s => !!document.querySelector(s), scaleToggle)) {
    const toggle = await reveal(t, scaleToggle);
    if (toggle.checked) await click(t, scaleToggle);
  }
  // Bound native pipe caches for this VM run while retaining Balanced image
  // quality. The supported memory preference applies after an app restart.
  await textButton(t, '[data-pref-label="Memory"]', 'Small');
  await textButton(t, '.prefs-foot', 'Done');
  await t.restart();
  // Reuse startup's font/layout/Skip readiness after the native restart.
  await startup(t);
  t.measure({name: 'engine-memory', setting: 'Small'});
  // A fresh app opens Basic; collapse it so Detail has a visible hit target.
  if (await t.driver.observe(() => document.querySelector(
    '[data-panel-id="basic"] > .panel-title')?.classList.contains('open')))
    await click(t, '[data-panel-id="basic"] > .panel-title');
  await panel(t, 'detail');
  const id = await t.driver.observe(() => ['usm_amount', 'sharp_amount'].find(id =>
    document.querySelector(`[data-control-id="${id}"] input[type=range]`)));
  assert(id, 'a sharpening amount control must be mounted');
  const selector = `[data-control-id="${id}"] input[type=range]`;
  const amount = await reveal(t, selector);
  await t.driver.point(amount.x, amount.y);
  await t.driver.keys('\uE011'); // Home: sharpening off, also requests the new Fit size
  const off = await settledPhoto(t);
  assert.equal(Math.max(off.width, off.height), 3072,
    'use a fixture larger than 3072: settled Balanced Fit must reach the processing budget');
  const before = await t.driver.observe(detailPixels);
  await t.evidence('fit-sharpening-off');
  await t.driver.keys(...Array(id === 'usm_amount' ? 50 : 3).fill('\uE014'));
  await settledPhoto(t);
  const after = await t.driver.observe(detailPixels);
  assert.notEqual(after, before, 'sharpening changes native Fit canvas detail');
  t.measure({name: 'fit-sharpening-detail', control: id, before, after,
    width: off.width, height: off.height});
  await t.evidence('fit-sharpening-on');
  await t.driver.keys('\uE011');
  await settledPhoto(t);
}

// the whole photo's box at the current zoom (the hover layer, which
// placeLayers sizes to the full image wherever it sits), the zoom bar's label
// and the Navigator's state
function scaleState() {
  const v = document.querySelector('main.viewer'), h = document.querySelector('canvas.hover-preview');
  const r = v.getBoundingClientRect();
  const box = { x: parseFloat(h.style.left), y: parseFloat(h.style.top),
    width: parseFloat(h.style.width), height: parseFloat(h.style.height) };
  return { zoom: v.classList.contains('zoom-in') ? 'in' : 'fit', box,
    viewer: { x: r.x, y: r.y, width: r.width, height: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 },
    label: document.querySelector('.zoom-bar .zoom-label')?.textContent ?? '',
    nav: document.querySelector('.nav-zooms button.active')?.textContent ?? null,
    navRect: !!document.querySelector('.nav-rect') };
}
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.abs(b) * tol;
// the box is placed relative to the viewer's pane: its middle is the pane's
const centered = (s, fit) => near(s.box.x + s.box.width / 2, fit.box.x + fit.box.width / 2, 0.01)
  && near(s.box.y + s.box.height / 2, fit.box.y + fit.box.height / 2, 0.01);
async function settledScale(t, test, label, ms = 15000) {
  let last = null, same = 0;
  return until(async () => {
    const s = await t.driver.observe(scaleState);
    const key = JSON.stringify([s.box, s.label]);
    same = key === last ? same + 1 : 0; last = key;
    return same >= 2 && test(s) && s;
  }, label, ms);
}

// zooming out past fit: the wheel goes down to half of fit, centered and
// unpannable, and pauses at fit on the way back in; ⌘- steps to the same
// floor; the Navigator's 1:2 is exactly 50%, centered only when smaller
// than fit
export async function zoomBelowFit(t) {
  await settledPhoto(t);
  const fit = await settledScale(t, s => s.zoom === 'fit', 'fitted on open');
  const fitLabel = fit.label;
  t.measure({ name: 'fit', box: fit.box, label: fitLabel });

  // wheel out from fit: about 4% a notch, so 25 notches pass half of fit
  for (let i = 0; i < 25; i++) { await t.driver.wheel(fit.viewer.cx, fit.viewer.cy, 50); await pause(40); }
  const half = await settledScale(t, s => near(s.box.width, fit.box.width / 2, 0.01), 'wheel out stops at half of fit');
  t.measure({ name: 'wheel-half', box: half.box, label: half.label });
  assert.equal(half.zoom, 'fit', 'below fit the viewer is not in its zoomed-in (pannable) mode');
  assert(centered(half, fit), 'below fit the photo stays centered');
  assert(!half.navRect, 'below fit the Navigator shows no rectangle');
  assert.notEqual(half.label, fitLabel, 'the zoom bar shows a percentage below fit');
  await t.evidence('wheel-half-of-fit');
  // more notches do not go further
  for (let i = 0; i < 5; i++) { await t.driver.wheel(fit.viewer.cx, fit.viewer.cy, 50); await pause(40); }
  const floor = await settledScale(t, () => true, 'wheel floor settles');
  assert(near(floor.box.width, half.box.width, 0.005), 'half of fit is the wheel floor');

  // (a drag is not tried: an unmoved press on the photo counts as a click,
  // which returns to fit; the zoom-fit class above is what turns panning off)

  // wheel back in notch by notch: it stops exactly at fit
  let s = floor, notches = 0;
  while (s.label !== fitLabel && s.box.width < fit.box.width * 1.01 && notches < 40) {
    await t.driver.wheel(fit.viewer.cx, fit.viewer.cy, -50); notches++;
    s = await settledScale(t, () => true, `wheel in, notch ${notches}`);
  }
  t.measure({ name: 'wheel-back-to-fit', notches, box: s.box, label: s.label });
  assert.equal(s.label, fitLabel, 'the wheel pauses at fit on the way in');
  assert(near(s.box.width, fit.box.width, 0.005), 'and the photo is at its fitted size');

  // ⌘- from fit steps down, ⌘- again reaches the same floor, ⌘= comes back
  const modifier = await t.driver.observe(() => /Mac/.test(navigator.userAgent) ? '' : '');
  for (let i = 0; i < 3; i++) { await t.driver.chord(modifier, '-'); await settledScale(t, () => true, `⌘- ${i + 1}`); }
  const keyFloor = await settledScale(t, () => true, '⌘- floor');
  assert(near(keyFloor.box.width, fit.box.width / 2, 0.01), '⌘- steps down to half of fit');
  assert(centered(keyFloor, fit), '⌘- below fit keeps the photo centered');
  await t.evidence('key-half-of-fit');

  // 1:1 from the Navigator gives the photo's full size, for the 50% check
  await textButton(t, '.nav-zooms', '1:1');
  const full = await settledScale(t, s => s.nav === '1:1' && s.zoom === 'in', 'Navigator 1:1');
  const fitScale = fit.box.width / full.box.width;
  await textButton(t, '.nav-zooms', '1:2');
  const fifty = await settledScale(t, s => s.nav === '1:2', 'Navigator 1:2');
  t.measure({ name: 'navigator-1-2', box: fifty.box, label: fifty.label, fitScale });
  assert(near(fifty.box.width, full.box.width / 2, 0.005), '1:2 is half the 1:1 size');
  assert.equal(fifty.label, '50%', 'the zoom bar reads 50% at 1:2');
  if (fitScale > 0.5 * 1.001) {
    assert.equal(fifty.zoom, 'fit', '50% is below this photo\'s fit: not pannable');
    assert(centered(fifty, fit), '50% below fit stays centered');
    assert(!fifty.navRect, 'no Navigator rectangle below fit');
  } else {
    assert.equal(fifty.zoom, 'in', '50% is above this photo\'s fit: zoomed in');
    assert(fifty.navRect, 'the Navigator shows the visible part at 50%');
  }
  await t.evidence('navigator-1-2');

  // a click on the photo returns to fit
  await t.driver.point(fit.viewer.cx, fit.viewer.cy);
  const back = await settledScale(t, s => s.label === fitLabel, 'click back to fit');
  assert(near(back.box.width, fit.box.width, 0.005), 'a click returns to fit');
}
