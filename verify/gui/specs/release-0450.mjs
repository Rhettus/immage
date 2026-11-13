// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// 0.45.0 features: Space-drag pan (bc893e8), Heal's dot cursor and Show spots
// (6382ad7), the new-photos preset on JPEGs (bfbc555) and the one-click brush
// (79e45e7)
import assert from 'node:assert/strict';
import { click, reveal, inspect, openTool, rangeSelector } from '../support/controls.mjs';
import { panel, textButton, choose, openMaskGroup, Blocked } from '../support/scenario.mjs';
import { until } from '../support/webdriver.mjs';
import * as read from '../support/observations.mjs';
import { settledPhoto } from './smoke.mjs';

// ---- Space-drag pan -------------------------------------------------------

// where the Navigator's rectangle sits, or null without one
const navRect = () => {
  const r = document.querySelector('.nav-rect');
  return r ? { x: r.style.left, y: r.style.top, w: r.style.width, h: r.style.height } : null;
};
const spotCount = () => {
  const m = /\((\d+)\)/.exec(document.querySelector('.heal-actions button:nth-child(2)')?.textContent ?? '');
  return m ? +m[1] : 0;
};
const maskCount = () => document.querySelectorAll('.mask-list > li').length;
const cropRect = () => {
  const r = document.querySelector('.crop-rect')?.getBoundingClientRect();
  return r && { width: r.width, height: r.height };
};
const view = async t => ({ nav: await t.driver.observe(navRect), hash: (await t.driver.observe(read.photo))?.hash });
const same = (a, b) => a.nav ? JSON.stringify(a.nav) === JSON.stringify(b.nav) : a.hash === b.hash;

// the visible middle of an overlay that may be larger than the viewer (a zoomed
// photo): `reveal` wants the whole element on screen, which a 2:1 view never is
async function overlay(t, selector) {
  return until(async () => {
    const c = await t.driver.observe(inspect, selector);
    if (!c) throw Error(`Control is not mounted: ${selector}`);
    const { left, right, top, bottom } = c.clip;
    return c.hit && right - left > 100 && bottom - top > 100 && { x: (left + right) / 2, y: (top + bottom) / 2, bounds: { width: right - left, height: bottom - top } };
  }, `visible overlay ${selector}`, 15000);
}

async function zoomIn(t) {
  await openTool(t, 'adjust');
  if (await t.driver.observe(() => !!document.querySelector('.nav-zooms'))) await textButton(t, '.nav-zooms', '2:1');
  else { const v = await reveal(t, 'main.viewer'); await t.driver.point(v.x, v.y); }
  await until(() => t.driver.observe(() => document.querySelector('main.viewer')?.classList.contains('zoom-in')), 'zoomed in', 20000);
  const photo = await settledPhoto(t);
  const nav = await t.driver.observe(navRect);
  if (nav && parseFloat(nav.w) >= 99.5 && parseFloat(nav.h) >= 99.5) throw new Blocked('the photo fits the viewer at 2:1: nothing to pan (use a larger fixture)');
  return photo;
}
// hold Space and drag `by` from `at`; the view must move, and `acted` must say the tool did not
async function spacePan(t, label, at, by, acted) {
  const before = await view(t);
  await t.driver.spaceDrag(at, { x: at.x + by.x, y: at.y + by.y });
  const after = await until(async () => { const v = await view(t); return !same(before, v) && v; }, `${label}: Space-drag pans the view`, 20000);
  await settledPhoto(t);
  t.measure({ name: `space-pan-${label}`, before, after });
  await t.evidence(`space-pan-${label}`);
  await acted();
}

export async function spacePanTools(t) {
  await zoomIn(t);

  // Heal: a drag would paint a spot
  await openTool(t, 'heal');
  const spots = await t.driver.observe(spotCount);
  const canvas = await overlay(t, 'svg.spot-svg');
  await spacePan(t, 'heal', { x: canvas.x, y: canvas.y }, { x: -160, y: -100 }, async () => {
    assert.equal(await t.driver.observe(spotCount), spots, 'Space-drag healed no spot');
    assert(!await t.driver.observe(() => !!document.querySelector('.spot-sel')), 'no spot selected by a Space-drag');
  });

  // Masks: with the brush armed, a drag would paint a mask
  await openTool(t, 'masks');
  const masks = await t.driver.observe(maskCount);
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Brush');
  const svg = await overlay(t, 'svg.mask-svg');
  await spacePan(t, 'masks', { x: svg.x, y: svg.y }, { x: 160, y: 100 }, async () => {
    assert.equal(await t.driver.observe(maskCount), masks, 'Space-drag painted no mask');
  });

  // Crop: a drag inside the guide would move it
  await click(t, 'button[data-tour="crop"]');
  await until(() => t.driver.observe(cropRect), 'crop overlay');
  if (!await t.driver.observe(() => document.querySelector('main.viewer')?.classList.contains('zoom-in'))) {
    // the crop tool shows the whole photo: there is no zoomed view to pan
    t.measure({ name: 'space-pan-crop', skipped: 'the crop tool fits the photo' });
  } else {
    const guide = await t.driver.observe(cropRect), rect = await reveal(t, '.crop-rect');
    await spacePan(t, 'crop', { x: rect.x, y: rect.y }, { x: -120, y: 80 }, async () => {
      const now = await t.driver.observe(cropRect);
      assert(Math.abs(now.width - guide.width) <= 2 && Math.abs(now.height - guide.height) <= 2, 'Space-drag left the crop guide alone');
    });
  }
  await textButton(t, '.crop-buttons', 'Cancel');
}

// ---- Heal: dot cursor and Show spots -------------------------------------

const selected = () => !!document.querySelector('svg.spot-svg .spot-sel');
async function showMode(t, label) {
  await textButton(t, '.heal-show', label);
  await until(() => t.driver.observe((l) => [...document.querySelectorAll('.heal-show button')].some(b => b.textContent.trim() === l && b.classList.contains('on')), label), `Show spots ${label}`);
}
async function showing(t, mode) {
  await until(() => t.driver.observe((m) => [...document.querySelectorAll('.heal-show button.on')].map(b => b.textContent.trim()).join() === m, mode), `Show spots is ${mode}`);
}

export async function healShowSpots(t) {
  await openTool(t, 'heal');
  await showMode(t, 'Always');
  if (await t.driver.observe(spotCount)) { await click(t, '.heal-actions button:nth-child(2)'); await until(async () => !await t.driver.observe(spotCount), 'spots cleared'); }
  const canvas = await overlay(t, 'svg.spot-svg');
  const left = { x: canvas.x - canvas.bounds.width * .2, y: canvas.y }, right = { x: canvas.x + canvas.bounds.width * .2, y: canvas.y };

  // the brush's circles and a center dot stand in for the pointer: no crosshair
  await t.driver.move(left.x, left.y);
  await until(() => t.driver.observe(() => !!document.querySelector('svg.spot-svg .brush-cursor circle.dot')), 'brush cursor with its center dot');
  const cursor = await t.driver.observe(() => ({ svg: getComputedStyle(document.querySelector('svg.spot-svg')).cursor,
    circles: document.querySelectorAll('svg.spot-svg .brush-cursor circle').length }));
  assert.equal(cursor.svg, 'none', 'no native cursor (crosshair) over the Heal overlay');
  assert(cursor.circles >= 2, 'the brush edge and the dot are drawn');
  await t.evidence('heal-dot-cursor');

  // two spots: the first falls back to a pin, the second is selected
  await t.driver.point(left.x, left.y);
  await until(() => t.driver.observe(selected), 'first spot selected');
  await t.driver.point(right.x, right.y);
  await until(async () => await t.driver.observe(spotCount) === 2, 'two spots');
  const count = () => t.driver.observe(() => ({ pins: document.querySelectorAll('svg.spot-svg circle.spot-pin:not(.source)').length,
    sel: !!document.querySelector('svg.spot-svg .spot-sel') }));
  assert.deepEqual(await count(), { pins: 2, sel: true }, 'Always: the other spot as a pin and the selected spot');
  await t.evidence('heal-show-always');

  await showMode(t, 'Selected');
  await until(async () => { const c = await count(); return c.pins === 1 && c.sel; }, 'Selected: only the selected spot');
  await t.evidence('heal-show-selected');
  await showMode(t, 'Never');
  await until(async () => { const c = await count(); return c.pins === 0 && !c.sel; }, 'Never: no spot');
  await t.evidence('heal-show-never');

  // H hides the spots, and again brings back the earlier choice
  await showMode(t, 'Selected');
  await t.driver.keys('h');
  await showing(t, 'Never');
  await until(async () => { const c = await count(); return c.pins === 0 && !c.sel; }, 'H hides the spots');
  await t.driver.keys('h');
  await showing(t, 'Selected');
  await until(async () => { const c = await count(); return c.pins === 1 && c.sel; }, 'H brings back Selected');
  await showMode(t, 'Always');
  await t.driver.keys('h'); await showing(t, 'Never');
  await t.driver.keys('h'); await showing(t, 'Always');

  // a hidden spot can't be clicked: a click where one is heals a new spot
  await showMode(t, 'Never');
  const photo = await settledPhoto(t);
  await t.driver.point(right.x, right.y);
  await until(async () => await t.driver.observe(spotCount) === 3, 'a click on a hidden spot heals a new one');
  await showMode(t, 'Always');
  await until(async () => (await count()).pins === 3 || (await count()).pins === 2, 'all spots shown again');
  t.measure({ name: 'heal-show-spots', photoBefore: photo.hash });
  await click(t, '.heal-actions button:nth-child(2)');
  await until(async () => !await t.driver.observe(spotCount), 'spots cleared');
}

// ---- New-photos preset on JPEGs ------------------------------------------

const cell = name => `.filmstrip .thumb[title=${JSON.stringify(name)}]`;
const PRESET_ROW = '[data-pref-label="Apply preset"] select', JPEG_ROW = '[data-pref-label="Also apply to JPEGs"] input[type=checkbox]';
async function exposureIs(t, expected, what) {
  await panel(t, 'basic');
  await until(async () => Math.abs(+(await t.driver.observe(inspect, rangeSelector('exposure'))).value - expected) < .02, what, 30000);
}
async function openPhoto(t, name) {
  await openTool(t, 'adjust');
  await click(t, cell(name));
  await settledPhoto(t);
}
async function preferences(t, edit) {
  await click(t, 'button[data-tour="prefs"]');
  await textButton(t, '.prefs-tabs', 'New Photos');
  try { return await edit(); } finally { await textButton(t, '.prefs-foot', 'Done'); }
}

export async function jpegPreset(t) {
  if (t.fixture.raw) throw new Blocked('jpeg-preset needs the isolated JPEG fixture');
  const names = ['preset-jpeg-1.jpg', 'preset-jpeg-2.jpg'];
  for (const name of names) await until(() => t.driver.observe(s => !!document.querySelector(s), cell(name)), `imported ${name}`, 60000);
  const original = await preferences(t, async () => {
    const was = (await reveal(t, PRESET_ROW)).value;
    // a preset that sets Exposure, with no raw-only settings
    await choose(t, PRESET_ROW, 'builtin:Bright & Airy');
    const sw = await reveal(t, JPEG_ROW);
    if (sw.checked) await click(t, JPEG_ROW);
    assert(!(await t.driver.observe(inspect, JPEG_ROW)).checked, 'Also apply to JPEGs is off');
    return was;
  });
  try {
    // off (the default): a new JPEG keeps its own defaults
    await openPhoto(t, names[0]);
    await exposureIs(t, 0, 'the preset is not applied to a new JPEG');
    await t.evidence('jpeg-preset-off');

    // on: the next new JPEG gets the preset
    await preferences(t, async () => {
      await click(t, JPEG_ROW);
      assert((await t.driver.observe(inspect, JPEG_ROW)).checked, 'Also apply to JPEGs is on');
    });
    const before = await settledPhoto(t);
    await openPhoto(t, names[1]);
    await exposureIs(t, 0.35, 'Bright & Airy applied to a new JPEG');
    const applied = await settledPhoto(t, p => p.hash !== before.hash);
    t.measure({ name: 'jpeg-preset', off: before.hash, on: applied.hash });
    await t.evidence('jpeg-preset-on');
  } finally {
    await preferences(t, async () => {
      if ((await reveal(t, JPEG_ROW)).checked) await click(t, JPEG_ROW);
      await choose(t, PRESET_ROW, original);
    });
  }
}

// ---- One-click brush -----------------------------------------------------

// the largest channel difference over the 64x64 samples a column/row test selects
const spread = (a, b, take) => {
  let max = 0;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    if (!take(x, y)) continue;
    const i = (y * 64 + x) * 4;
    for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(a.rgba[i + c] - b.rgba[i + c]));
  }
  return max;
};

export async function brushDot(t) {
  await openTool(t, 'masks');
  // the photo away from a mask row, whose hover shows that mask in red
  const away = async predicate => {
    const title = await reveal(t, '.masks-panel .panel-title span');
    await t.driver.move(title.x, title.y);
    return settledPhoto(t, predicate);
  };
  const baseline = await away();
  await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Brush');
  const svg = await overlay(t, 'svg.mask-svg');
  const at = { x: svg.x - svg.bounds.width * .2, y: svg.y };
  const box = await t.driver.observe(() => { const r = document.querySelector('canvas.layer.sharp').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
  const cx = (at.x - box.x) / box.width * 64, cy = (at.y - box.y) / box.height * 64;
  // a single click: no movement, so a brush of one point
  await t.driver.point(at.x, at.y);
  await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length > 0), 'one-click brush mask created');
  await openMaskGroup(t, 'Tone');
  const s = await reveal(t, '[data-control-id="l_exposure"] input[type=range]');
  await t.driver.drag({ x: s.x, y: s.y }, { x: s.x + s.bounds.width * .4, y: s.y });
  const near = (x, y) => Math.abs(x - cx) <= 4 && Math.abs(y - cy) <= 4;
  const far = x => Math.abs(x - cx) >= 16;
  const edited = await until(async () => {
    const title = await reveal(t, '.masks-panel .panel-title span');
    await t.driver.move(title.x, title.y);
    const p = await t.driver.observe(read.photo);
    return p && p.quality === 'final' && !p.working && spread(baseline, p, near) >= 8 && p;
  }, 'the adjustment changes the pixels at the click', 60000);
  const settled = await away(p => p.hash === edited.hash);
  const farChange = spread(baseline, settled, (x, y) => far(x, y));
  t.measure({ name: 'brush-dot', click: { x: cx, y: cy }, near: spread(baseline, settled, near), far: farChange });
  await t.evidence('brush-dot');
  assert(farChange <= 3, `pixels far from the click are unchanged (largest channel change ${farChange})`);
  await click(t, '.mask-list > li.on .mask-del');
  await until(() => t.driver.observe(() => !document.querySelector('.mask-list > li')), 'mask deleted');
  await away(p => p.hash === baseline.hash);
}
