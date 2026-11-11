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
