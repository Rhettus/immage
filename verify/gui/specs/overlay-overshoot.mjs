// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// a drag on the photo may run on past its edge into the blank viewer: the
// handle follows the pointer there while pressed, and what must stay on the
// photo snaps back to its edge on release. a new radial gradient keeps its
// center where pressed and takes its radius from the overshoot, and a Heal
// spot moved off the photo snaps back
import assert from 'node:assert/strict';
import { click, reveal, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

// the photo's box (the overlay svg) and the viewer around it, read only
const geometry = () => {
  const s = (document.querySelector('svg.mask-svg') ?? document.querySelector('svg.spot-svg')).getBoundingClientRect();
  const v = document.querySelector('.viewer').getBoundingClientRect();
  return { photo: { x: s.x, y: s.y, w: s.width, h: s.height }, viewer: { x: v.x, y: v.y, w: v.width, h: v.height } };
};
// a handle's center as a fraction of the photo box: 0..1 on the photo
const frac = sel => {
  const s = (document.querySelector('svg.mask-svg') ?? document.querySelector('svg.spot-svg')).getBoundingClientRect();
  const e = document.querySelector(sel);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { u: (r.x + r.width / 2 - s.x) / s.width, v: (r.y + r.height / 2 - s.y) / s.height };
};
const CENTER = '.mask-svg .mh.center';
const RX = '.mask-svg .mh:not(.center):not(.rot):not(.feather)';
const PIN = '.spot-svg .spot-sel .spot-pin.on';

// the side of the photo with the most blank viewer beside it
function sideWithRoom({ photo: p, viewer: v }) {
  const room = { right: v.x + v.w - (p.x + p.w), left: p.x - v.x, down: v.y + v.h - (p.y + p.h), up: p.y - v.y };
  const [side, px] = Object.entries(room).sort((a, b) => b[1] - a[1])[0];
  return { side, room: px, axis: side === 'right' || side === 'left' ? 'u' : 'v', at: side === 'right' || side === 'down' ? 1 : 0,
           dir: side === 'right' || side === 'down' ? 1 : -1, horizontal: side === 'right' || side === 'left' };
}
const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)} is not within ${tol} of ${b}`);

export async function overlayOvershoot(t) {
  await openTool(t, 'masks');
  await settledPhoto(t);
  const g = await t.driver.observe(geometry);
  const s = sideWithRoom(g);
  t.measure({ name: 'overshoot-geometry', ...g, ...s });
  assert(s.room >= 40, `${s.room}px of blank viewer beside the photo is too little to overshoot into`);
  const over = Math.min(s.room - 12, 70);
  // pixel position of a point `f` along the box side in the overshoot axis
  const place = (along, across) => s.horizontal
    ? { x: g.photo.x + g.photo.w * along, y: g.photo.y + g.photo.h * across }
    : { x: g.photo.x + g.photo.w * across, y: g.photo.y + g.photo.h * along };
  const edge = place(s.at, .5);
  const outside = { x: edge.x + (s.horizontal ? s.dir * over : 0), y: edge.y + (s.horizontal ? 0 : s.dir * over) };
  const beyond = f => (s.dir > 0 ? f > 1.02 : f < -0.02);

  // a: moving an ellipse's center past the edge
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Radial Gradient');
  const c0 = place(.5, .5), r0 = place(.6, .5);
  await t.driver.drag(c0, r0);
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length === 1), 'radial mask created');
  await t.driver.move(c0.x + 4, c0.y + 4);
  const start = await until(() => t.driver.observe(frac, CENTER), 'center handle shown');
  near(start.u, .5, .02, 'created center u'); near(start.v, .5, .02, 'created center v');
  const handle = await reveal(t, CENTER);
  await t.driver.hold({ x: handle.x, y: handle.y }, outside);
  let held;
  try {
    held = await until(async () => {
      const f = await t.driver.observe(frac, CENTER);
      return f && beyond(f[s.axis]) && f;
    }, 'handle follows the pointer past the edge', 8000).catch(async e => {
      throw Error(`${e.message}: handle at ${JSON.stringify(await t.driver.observe(frac, CENTER))}`);
    });
    t.measure({ name: 'handle-while-pressed', ...held });
    await t.evidence('ellipse-overshoot-held');
  } finally { await t.driver.release(); }
  await t.driver.move(c0.x, c0.y);
  const snapped = await until(async () => {
    const f = await t.driver.observe(frac, CENTER);
    return f && Math.abs(f[s.axis] - s.at) <= .01 && f;
  }, 'center snaps back to the photo edge on release', 10000).catch(async e => {
    throw Error(`${e.message}: handle at ${JSON.stringify(await t.driver.observe(frac, CENTER))}`);
  });
  t.measure({ name: 'handle-after-release', ...snapped });
  await t.evidence('ellipse-overshoot-released');

  // b: a new ellipse dragged out past the edge keeps its center, and its radius reaches the pointer
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Radial Gradient');
  const from = place(.5, .5);
  const to = { x: outside.x, y: outside.y };
  await t.driver.drag(from, to);
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length === 2), 'second radial mask created');
  await t.driver.move(from.x, from.y + 6);
  const made = await until(() => t.driver.observe(frac, CENTER), 'new center handle shown');
  near(made.u, .5, .02, 'drawn center u'); near(made.v, .5, .02, 'drawn center v');
  const rx = await until(() => t.driver.observe(frac, RX), 'radius handle shown');
  t.measure({ name: 'drawn-ellipse', center: made, radius: rx });
  if (s.horizontal) assert(s.dir > 0 ? rx.u > 1.01 : rx.u < -0.01, `radius handle reaches past the edge (${JSON.stringify(rx)})`);
  else assert(rx.v !== made.v || rx.u !== made.u, 'radius handle has moved off the center');
  await t.evidence('ellipse-drawn-overshoot');

  // c: a Heal spot moved past the edge
  await openTool(t, 'heal');
  const canvas = await reveal(t, 'svg.spot-svg');
  const hg = await t.driver.observe(geometry);
  assert(Math.abs(hg.photo.x - g.photo.x) < 2 && Math.abs(hg.photo.w - g.photo.w) < 2, 'the photo box did not move for Heal');
  await t.driver.point(canvas.bounds.x + canvas.bounds.width * .5, canvas.bounds.y + canvas.bounds.height * .5);
  await until(() => t.driver.observe(() => !!document.querySelector('.spot-sel')), 'spot created');
  await pause(500);
  const pin = await reveal(t, PIN);
  await t.driver.hold({ x: pin.x, y: pin.y }, outside);
  try {
    const f = await until(async () => {
      const p = await t.driver.observe(frac, PIN);
      return p && beyond(p[s.axis]) && p;
    }, 'spot follows the pointer past the edge', 8000);
    t.measure({ name: 'spot-while-pressed', ...f });
  } finally { await t.driver.release(); }
  await until(async () => {
    const p = await t.driver.observe(frac, PIN);
    return p && Math.abs(p[s.axis] - s.at) <= .01 && p;
  }, 'spot snaps back to the photo edge on release', 10000).catch(async e => {
    throw Error(`${e.message}: pin at ${JSON.stringify(await t.driver.observe(frac, PIN))}`);
  });
  await t.evidence('spot-overshoot-released');
}
