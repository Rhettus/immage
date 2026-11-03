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

async function attempt(t, name, fn) {
  try { await fn(); }
  catch (error) {
    t.measure({ name, skipped: error.message.split('\n')[0] });
    try { await t.driver.keys(''); } catch {} // Escape out of any open tool
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

  // 2. Color grading wheels with a split tone.
  await attempt(t, 'colorgrading', async () => {
    const p = await panel(t, 'colorgrading');
    await textButton(t, `${p} .tabs`, '3-Way');
    const wheels = await t.driver.observe(s => [...document.querySelectorAll(`${s} .wheel`)]
      .map(e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; }), p);
    if (wheels.length >= 3) {
      // shadows toward teal, highlights toward orange
      await t.driver.drag(wheels[0], { x: wheels[0].x - wheels[0].w * .14, y: wheels[0].y + wheels[0].w * .06 });
      await t.driver.drag(wheels[2], { x: wheels[2].x + wheels[2].w * .12, y: wheels[2].y - wheels[2].w * .1 });
    }
    await shot(t, 'color-grading');
  });

  // 3. A linear gradient mask from the top, darkened, with its overlay.
  await attempt(t, 'masks', async () => {
    await click(t, 'button[data-tour="masks"]');
    await click(t, '.create-mask');
    await textButton(t, '.shape-menu-list', 'Linear Gradient');
    const photo = await reveal(t, 'svg.mask-svg');
    await t.driver.drag({ x: photo.x, y: photo.bounds.y + photo.bounds.height * .08 },
      { x: photo.x, y: photo.bounds.y + photo.bounds.height * .42 });
    await until(() => t.driver.observe(() => document.querySelectorAll('.mask-list > li').length > 0), 'created mask');
    const heading = await t.driver.observe(() => [...document.querySelectorAll('.masks-panel h3.fold')]
      .find(e => e.textContent.trim() === 'Tone')?.getBoundingClientRect().toJSON());
    if (heading) await t.driver.point(heading.x + heading.width / 2, heading.y + heading.height / 2);
    try { await slide(t, 'l_exposure', -0.7); } catch {}
    await shot(t, 'masks');
    await t.driver.keys('o');
    await shot(t, 'masks-overlay');
    await t.driver.keys('o');
  });

  // 4. Presets and looks, with live previews of this photo.
  await attempt(t, 'presets', async () => {
    await click(t, 'button[data-tour="presets"]');
    await until(() => t.driver.observe(() => document.querySelectorAll('.presets-panel .tiles img, .presets-panel .tiles canvas').length > 3),
      'preset previews', 60000);
    await pause(1500);
    await shot(t, 'presets');
  });

  // 5. Heal: one spot with its source.
  await attempt(t, 'heal', async () => {
    await click(t, 'button[data-tour="heal"]');
    const canvas = await reveal(t, 'svg.spot-svg');
    await t.driver.point(canvas.bounds.x + canvas.bounds.width * .62, canvas.bounds.y + canvas.bounds.height * .7);
    await until(() => t.driver.observe(() => !!document.querySelector('.spot-sel')), 'spot created');
    await shot(t, 'heal');
  });

  // 6. Crop with its guides.
  await attempt(t, 'crop', async () => {
    await click(t, 'button[data-tour="crop"]');
    await pause(800);
    await shot(t, 'crop');
    await t.driver.keys('');
  });

  // 7. Black and white, then the Zone System.
  await attempt(t, 'zones', async () => {
    await click(t, 'button[data-tour="adjust"]');
    const p = await panel(t, 'basic');
    await textButton(t, p, 'B&W');
    await settledPhoto(t);
    await click(t, 'button[data-tour="zones"]');
    await until(() => t.driver.observe(() => document.querySelectorAll('.zone-col').length >= 10), 'zone columns');
    await shot(t, 'zones');
  });

  // 8. The whole window again, back on Adjustments, for the hero.
  await attempt(t, 'workspace', async () => {
    await click(t, 'button[data-tour="adjust"]');
    await shot(t, 'workspace-bw');
  });
}
