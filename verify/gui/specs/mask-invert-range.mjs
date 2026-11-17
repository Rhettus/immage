// SPDX-License-Identifier: GPL-3.0-or-later
// Invert on a mask that combines a luminance range with a drawn shape inverts
// the range, not the product: with the shape shown as taking away, it cuts its
// area out of the inverted range, (1 - S) * (1 - r). Read from the overlay's
// pixels (the page's own mask math) and from the rendered photo (the engine's).
import assert from 'node:assert/strict';
import { click, reveal, openTool } from '../support/controls.mjs';
import { textButton } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const CENTER = [.5, .5];
const OUTSIDE = [];
for (const x of [.08, .2, .8, .92]) for (const y of [.1, .3, .7, .9]) OUTSIDE.push([x, y]);
const ALL = [CENTER, ...OUTSIDE];
const FULL = 140; // the overlay's alpha for a mask value of 1 (Overlay opacity 55%)

// the overlay's alpha at fractions of the photo, strongest of its canvases
const overlayAt = pts => {
  const out = pts.map(() => 0);
  let any = false;
  for (const c of document.querySelectorAll('canvas.mask-tint')) {
    if (!c.width || !c.height) continue;
    any = true;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    pts.forEach(([u, v], n) => {
      const x = Math.min(c.width - 1, Math.floor(u * c.width)), y = Math.min(c.height - 1, Math.floor(v * c.height));
      out[n] = Math.max(out[n], d[(y * c.width + x) * 4 + 3]);
    });
  }
  return any ? out : null;
};
const lumaOf = (photo, [u, v]) => {
  const x = Math.min(63, Math.floor(u * 64)), y = Math.min(63, Math.floor(v * 64)), i = (y * 64 + x) * 4;
  return photo.rgba[i] * .2126 + photo.rgba[i + 1] * .7152 + photo.rgba[i + 2] * .0722;
};
const invertOn = () => [...document.querySelectorAll('label.toggle')].find(l => l.textContent.trim() === 'Invert')?.querySelector('input')?.checked ?? null;
const modeSub = () => document.querySelector('.shape-list li:nth-child(2) button.mode')?.classList.contains('sub') ?? null;

// two equal reads in a row: the overlay redraws after each edit
async function stableOverlay(t, label) {
  let last;
  return until(async () => {
    const now = await t.driver.observe(overlayAt, ALL);
    if (!now) { last = null; return false; }
    const same = last && now.every((a, i) => Math.abs(a - last[i]) <= 1);
    last = now;
    return same ? now : false;
  }, label, 20000);
}
async function setInvert(t, on) {
  if ((await t.driver.observe(invertOn)) === null) {
    await click(t, 'h3.fold:not([data-mask-group])');
    await until(async () => (await t.driver.observe(invertOn)) !== null, 'Mask settings open');
  }
  if ((await t.driver.observe(invertOn)) === on) return;
  const row = await reveal(t, 'label.toggle', 'Invert');
  await t.driver.point(row.x, row.y);
  await until(async () => (await t.driver.observe(invertOn)) === on, `Invert ${on ? 'on' : 'off'}`);
}
async function flipShape(t, shownSub) {
  await click(t, '.shape-list li:nth-child(2) button.mode');
  await until(async () => (await t.driver.observe(modeSub)) === shownSub, `shape shown as ${shownSub ? 'taking away' : 'adding'}`);
}
async function overlayOn(t) {
  if ((await t.driver.observe(overlayAt, ALL)) === null || Math.max(...(await t.driver.observe(overlayAt, ALL))) <= 0)
    await t.driver.keys('o');
}

export async function maskInvertRange(t) {
  await openTool(t, 'masks');
  const baseline = await settledPhoto(t);
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Luminance Range');
  await reveal(t, 'svg.mask-svg');
  // the drawing layer is larger than the photo: aim by the photo's own box
  const box = () => t.driver.observe(() => { const r = document.querySelector('canvas.mask-tint').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; });
  const at = await box();
  t.measure({ name: 'photo-box', at, sharp: await t.driver.observe(() => { const r = document.querySelector('canvas.layer.sharp').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }), svg: await t.driver.observe(() => { const r = document.querySelector('svg.mask-svg').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }) });
  await t.driver.point(at.x, at.y);
  await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li.on')), 'luminance mask');
  // Subtract > Radial Gradient, dragged out from the centre, where the range was picked
  await click(t, '.mask-ops .mask-op.sub');
  await textButton(t, '.shape-menu-list', 'Radial Gradient');
  await reveal(t, 'svg.mask-svg');
  await t.driver.drag({ x: at.x, y: at.y }, { x: at.x + at.w * .12, y: at.y + at.h * .12 });
  await until(() => t.driver.observe(() => document.querySelectorAll('.shape-list li').length === 2), 'range and radial listed');
  await until(async () => (await t.driver.observe(modeSub)) === true, 'radial shown as taking away');

  // 1. plain: (1 - S) * r
  await overlayOn(t);
  const plain = await stableOverlay(t, 'plain overlay');
  t.measure({ name: 'overlay-plain', plain });
  await t.evidence('plain');
  assert(plain[0] <= 8, `inside the shape the plain mask is empty (${plain[0]})`);
  const rangeOut = plain.slice(1);
  assert(Math.max(...rangeOut) > FULL * .5, `the range selects part of the photo outside the shape (${rangeOut})`);

  // 2. Invert on: the stored shape now reads as adding; inside it the inverted range, nowhere else
  await setInvert(t, true);
  await until(async () => (await t.driver.observe(modeSub)) === false, 'radial shown as adding when inverted');
  const added = await stableOverlay(t, 'inverted, shape adding');
  t.measure({ name: 'overlay-inverted-adding', added });
  assert(Math.max(...added.slice(1)) <= 8, `an adding shape keeps to its area (${added.slice(1)})`);

  // 3. the shape shown as taking away: (1 - S) * (1 - r), the complement of plain outside it
  await flipShape(t, true);
  const cut = await stableOverlay(t, 'inverted, shape taking away');
  await t.evidence('inverted');
  t.measure({ name: 'overlay-inverted', cut });
  assert(cut[0] <= 8, `inside the shape the inverted mask is empty (${cut[0]})`);
  cut.slice(1).forEach((a, i) => assert(Math.abs(a + plain[i + 1] - FULL) <= 10,
    `outside the shape inverted + plain is the full overlay at ${OUTSIDE[i]}: ${a} + ${plain[i + 1]}`));
  assert(Math.max(...cut.slice(1)) > FULL * .5, 'the inverted range selects part of the photo outside the shape');

  // 4. Invert off, the shape back to taking away: plain again
  await setInvert(t, false);
  await until(async () => (await t.driver.observe(modeSub)) === false, 'stored add shows as adding when not inverted');
  await flipShape(t, true);
  const again = await stableOverlay(t, 'plain again');
  again.forEach((a, i) => assert(Math.abs(a - plain[i]) <= 2, `Invert off restores the plain mask at ${ALL[i]}: ${a} vs ${plain[i]}`));

  // the engine's render: lift the mask's exposure, then the same two states
  await t.driver.keys('o');
  await until(async () => (await t.driver.observe(overlayAt, ALL))?.every(a => a === 0) ?? true, 'overlay off');
  await click(t, '[data-mask-group="Tone"]');
  const slider = await reveal(t, '[data-control-id="l_exposure"] input[type=range]');
  await t.driver.drag({ x: slider.x, y: slider.y }, { x: slider.x + slider.bounds.width * .2, y: slider.y });
  const lifted = await settledPhoto(t, p => p.hash !== baseline.hash);
  const delta = (p, i) => lumaOf(p, ALL[i]) - lumaOf(baseline, ALL[i]);
  const plainDelta = ALL.map((_, i) => delta(lifted, i));
  await t.evidence('render-plain');
  await setInvert(t, true);
  await flipShape(t, true);
  const inverted = await settledPhoto(t, p => p.hash !== lifted.hash);
  const invertedDelta = ALL.map((_, i) => delta(inverted, i));
  await t.evidence('render-inverted');
  t.measure({ name: 'render', plainDelta, invertedDelta, plain, cut });
  assert(Math.abs(plainDelta[0]) <= 3 && Math.abs(invertedDelta[0]) <= 3, `the shape's centre is unchanged in both (${plainDelta[0]}, ${invertedDelta[0]})`);
  // the overlay and the 64 px photo sample sit on different grids, so a point on the
  // range's edge can disagree: compare the means over the points the overlay settles
  const mean = (list, from) => list.reduce((a, i) => a + from[i], 0) / list.length;
  const idx = ALL.map((_, i) => i).filter(i => i > 0);
  const byRange = idx.filter(i => plain[i] >= FULL * .8), byInverse = idx.filter(i => cut[i] >= FULL * .8);
  assert(byRange.length >= 3 && byInverse.length >= 3, `points selected by each (${byRange.length}, ${byInverse.length})`);
  const a1 = mean(byRange, plainDelta), a2 = mean(byRange, invertedDelta), b1 = mean(byInverse, plainDelta), b2 = mean(byInverse, invertedDelta);
  t.measure({ name: 'render-means', a1, a2, b1, b2 });
  assert(a1 > 10 && a2 < a1 * .3, `where the range selects, only the plain render lifts (${a1} / ${a2})`);
  assert(b2 > 10 && b1 < b2 * .3, `where the inverted range selects, only the inverted render lifts (${b1} / ${b2})`);
  await setInvert(t, false);
  await flipShape(t, true);
  await settledPhoto(t, p => p.hash === lifted.hash);

  await click(t, '.mask-list > li.on .mask-del');
  await until(() => t.driver.observe(() => !document.querySelector('.mask-list > li')), 'mask deleted');
  await settledPhoto(t, p => p.hash === baseline.hash);
}
