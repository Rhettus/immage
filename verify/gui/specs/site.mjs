// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//
// Screenshots for the website (Rhettus/immage-site), taken through the
// same app-only WebDriver session as every other case: real pointer and
// keyboard input on the dedicated test app, webview screenshots only.
// Each shot is independent; one that cannot be reached is recorded and
// skipped rather than failing the others. The photo canvas bounds are
// measured with every shot so a before/after pair can be cropped to the
// photo alone.
import { click, reveal, inspect, rangeSelector } from '../support/controls.mjs';
import { panel, textButton } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

const canvasBounds = () => {
  const c = document.querySelector('canvas.layer.sharp');
  const r = c?.getBoundingClientRect();
  return r && { x: r.x, y: r.y, width: r.width, height: r.height, scale: devicePixelRatio };
};

// Website shots must not show file paths: any visible text with a home or
// temporary directory in it skips the shot rather than saving it.
const visiblePath = () => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/(^|\s)(\/home\/|\/tmp\/|\/Users\/|[A-Z]:\\)/.test(n.textContent)) continue;
    const r = n.parentElement?.getBoundingClientRect();
    const st = n.parentElement && getComputedStyle(n.parentElement);
    if (r && r.width && r.height && st.visibility !== 'hidden' && st.display !== 'none' && +st.opacity > 0) return n.textContent.trim().slice(0, 80);
  }
  return null;
};

// The info over the photo shows its folder: I cycles it to none.
async function hideInfo(t) {
  for (let i = 0; i < 3 && await t.driver.observe(() => !!document.querySelector('.info-overlay')); i++) {
    await t.driver.keys('i');
    await pause(300);
  }
  if (await t.driver.observe(() => !!document.querySelector('.info-overlay'))) throw Error('photo info overlay still shown');
}

async function shot(t, label) {
  await settledPhoto(t);
  await hideInfo(t);
  await pause(400); // let panel transitions finish
  const path = await t.driver.observe(visiblePath);
  if (path) throw Error(`a file path is visible (${path}); shot not taken`);
  await t.evidence(label);
  t.measure({ name: label, canvas: await t.driver.observe(canvasBounds) });
}

// Drag a range control to a value through its visible track.
async function slide(t, id, target) {
  const s = await reveal(t, rangeSelector(id));
  const { x, y, width, height } = s.bounds;
  const at = v => ({ x: x + 8 + (width - 16) * (v - s.min) / (s.max - s.min), y: y + height / 2 });
  await t.driver.drag(at(Number(s.value)), at(target));
  await until(async () => Math.abs(Number((await t.driver.observe(inspect, rangeSelector(id))).value) - target)
    <= Math.max((s.max - s.min) * .04, s.step || 0), `${id} near ${target}`);
}

// A tool panel opens at the previous panel's scroll offset; wheel the
// shared side panel back to its top so each shot starts there.
async function panelsTop(t) {
  for (let i = 0; i < 20; i++) {
    const s = await t.driver.observe(() => {
      const p = document.querySelector('.right .panels'), r = p?.getBoundingClientRect();
      return r && { x: r.right - 6, y: r.top + r.height / 2, top: p.scrollTop };
    });
    if (!s || s.top <= 0) return;
    await t.driver.wheel(s.x, s.y, -600);
    await pause(150);
  }
  throw Error('side panel did not scroll to its top');
}

// A mask menu item's text includes its shortcut ("Linear GradientM"), so
// match the item's label span instead of the whole button.
async function menuItem(t, label) {
  const point = await until(() => t.driver.observe(label => {
    const e = [...document.querySelectorAll('.shape-menu-list button')]
      .find(b => b.querySelector('span:not(.key):not(.more)')?.textContent.trim() === label);
    if (!e || e.disabled) return null;
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width && r.height && (e === hit || e.contains(hit)) && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label), `mask menu item ${label}`);
  await t.driver.point(point.x, point.y);
}

async function tool(t, name) {
  await panelsTop(t);
  await click(t, `button[data-tour="${name}"]`);
  await pause(300);
  await panelsTop(t);
}

// SITE_SHOTS=masks,heal runs only those steps (for a retake).
const only = process.env.SITE_SHOTS?.split(',').map(s => s.trim()).filter(Boolean);

async function attempt(t, name, fn) {
  if (only && !only.includes(name)) return;
  try { await fn(); }
  catch (error) {
    t.measure({ name, skipped: error.message.split('\n')[0] });
    try { await t.driver.keys('\uE00C'); } catch {} // Escape out of any open tool
  }
}

export async function siteShots(t) {
  // The window is floated and sized from outside the runner (an authorized,
  // app-only desktop step); wait until this webview has that size.
  let last, stable = 0;
  const size = await until(async () => {
    const now = await t.driver.observe(() => `${innerWidth}x${innerHeight}`);
    stable = now === last ? stable + 1 : 0; last = now;
    return stable >= 5 && Number(now.split('x')[0]) >= 1200 && now;
  }, 'a stable, sized window', 60000);
  t.measure({ name: 'viewport', size });
  await settledPhoto(t);
  await hideInfo(t);

  // 1. Before and after a Basic edit, with the Adjustments panel open.
  await attempt(t, 'basic', async () => {
    await panel(t, 'basic');
    await shot(t, 'basic-before');
    for (const [id, value] of [['contrast', 22], ['highlights', -45], ['shadows', 35], ['whites', 12],
      ['blacks', -12], ['clarity', 18], ['vibrance', 28]]) {
      try { await slide(t, id, value); } catch (error) { t.measure({ name: `basic-${id}`, skipped: error.message.split('\n')[0] }); }
    }
    await shot(t, 'basic-after');
  });

  // 2. A linear gradient mask from the top, darkened, with its overlay.
  await attempt(t, 'masks', async () => {
    await tool(t, 'masks');
    await click(t, '.create-mask');
    await menuItem(t, 'Linear Gradient');
    const photo = await reveal(t, 'svg.mask-svg');
    await t.driver.drag({ x: photo.x, y: photo.bounds.y + photo.bounds.height * .08 },
      { x: photo.x, y: photo.bounds.y + photo.bounds.height * .42 });
    await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length > 0), 'created mask');
    const heading = await t.driver.observe(() => [...document.querySelectorAll('.masks-panel h3.fold')]
      .find(e => e.textContent.trim() === 'Tone')?.getBoundingClientRect().toJSON());
    if (heading) await t.driver.point(heading.x + heading.width / 2, heading.y + heading.height / 2);
    try { await slide(t, 'l_exposure', -0.7); } catch {}
    await panelsTop(t);
    await shot(t, 'masks');
    await t.driver.keys('o');
    await shot(t, 'masks-overlay');
    await t.driver.keys('o');
  });

  // 3. Heal: one spot with its source.
  await attempt(t, 'heal', async () => {
    await tool(t, 'heal');
    const canvas = await reveal(t, 'svg.spot-svg');
    await t.driver.point(canvas.bounds.x + canvas.bounds.width * .62, canvas.bounds.y + canvas.bounds.height * .7);
    await until(() => t.driver.observe(() => !!document.querySelector('.spot-sel')), 'spot created');
    await shot(t, 'heal');
  });

  // 4. Crop with its guides.
  await attempt(t, 'crop', async () => {
    await tool(t, 'crop');
    await pause(800);
    await shot(t, 'crop');
    await t.driver.keys('\uE00C');
  });

  // 5. Presets and looks, with live previews of this photo.
  await attempt(t, 'presets', async () => {
    await tool(t, 'presets');
    await until(() => t.driver.observe(() => document.querySelectorAll('.presets-panel .tiles img, .presets-panel .tiles canvas').length > 3),
      'preset previews', 60000);
    await pause(1500);
    await shot(t, 'presets');
  });

  // 6. Black and white, then the Zone System; back to color afterwards.
  await attempt(t, 'zones', async () => {
    await tool(t, 'adjust');
    const p = await panel(t, 'basic');
    await textButton(t, p, 'B&W');
    await settledPhoto(t);
    await tool(t, 'zones');
    await until(() => t.driver.observe(() => document.querySelectorAll('.zone-col').length >= 10), 'zone columns');
    await shot(t, 'zones');
  });
  await attempt(t, 'color', async () => {
    await tool(t, 'adjust');
    await textButton(t, await panel(t, 'basic'), 'Color');
    await settledPhoto(t);
  });

  // 7. Last, so it tints nothing else: a gentle split tone on the
  // Shadows (toward teal) and Highlights (toward orange) wheels.
  await attempt(t, 'colorgrading', async () => {
    const p = await panel(t, 'colorgrading');
    await textButton(t, `${p} .tabs`, '3-Way');
    await reveal(t, `${p} .wheel-cell:last-child .wheel`);
    const wheels = await t.driver.observe(s => Object.fromEntries([...document.querySelectorAll(`${s} .wheel-cell`)]
      .map(c => { const r = c.querySelector('.wheel').getBoundingClientRect();
        return [c.querySelector('.wheel-title')?.textContent.trim(), { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }]; })), p);
    const { Shadows: sh, Highlights: hi } = wheels;
    if (!sh || !hi) throw Error(`wheels not found: ${Object.keys(wheels).join(', ')}`);
    await t.driver.drag(sh, { x: sh.x - sh.w * .09, y: sh.y + sh.w * .04 });
    await t.driver.drag(hi, { x: hi.x + hi.w * .08, y: hi.y - hi.w * .06 });
    await shot(t, 'color-grading');
  });
}
