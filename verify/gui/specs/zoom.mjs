// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import assert from 'node:assert/strict';
import { reveal } from '../support/controls.mjs';
import { panel, Blocked } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { settledPhoto } from './smoke.mjs';

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
  await t.driver.point(ev.x, ev.y);
  await t.driver.keys('', '', '', '', '');
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
