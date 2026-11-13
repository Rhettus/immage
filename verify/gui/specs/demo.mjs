// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//
// The announcement demo: a short tour of Immage's main features, recorded
// from the dedicated test app (support/recorder.mjs; verify/gui/README.md,
// "Demo clip"). Real pointer and keyboard input only. Each segment is
// independent: one that cannot be reached is noted and skipped. Setup that
// would bore a viewer (Preferences, module choices) runs while recording is
// paused and is cut from the clip.
//   DEMO_SEGMENTS=sliders,masks  runs only those segments (a retake)
//   DEMO_OUT=dir                 where frames and timeline.json go
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { click, reveal, inspect, rangeSelector, openTool } from '../support/controls.mjs';
import { panel, textButton, openMaskGroup, expandSections, choose } from '../support/scenario.mjs';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';
import { hideInfo, pathFree } from '../support/privacy.mjs';
import { Recorder } from '../support/recorder.mjs';

const only = process.env.DEMO_SEGMENTS?.split(',').map(s => s.trim()).filter(Boolean);

async function slide(t, id, target) {
  const s = await reveal(t, rangeSelector(id));
  const { x, y, width, height } = s.bounds;
  const at = v => ({ x: x + 8 + (width - 16) * (v - s.min) / (s.max - s.min), y: y + height / 2 });
  await t.driver.drag(at(Number(s.value)), at(target));
}

// a tool panel opens at the previous panel's scroll offset: back to the top
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
}
async function tool(t, name) {
  await panelsTop(t); await openTool(t, name); await pause(300); await panelsTop(t);
}

// flip a General preference switch by its row's label
async function preference(t, label, on) {
  await click(t, 'button[data-tour="prefs"]');
  await until(() => t.driver.observe(() => !!document.querySelector('.prefs')), 'Preferences');
  const sw = await t.driver.observe(text => {
    const row = [...document.querySelectorAll('.prefs *')].find(e => e.children.length && [...e.childNodes]
      .some(n => n.nodeType === 3 && n.textContent.trim() === text) || e.firstElementChild?.textContent.trim() === text);
    const box = row?.closest('div')?.querySelector('input.switch') ?? row?.parentElement?.querySelector('input.switch');
    if (!box) return null;
    const r = box.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, checked: box.checked };
  }, label);
  if (!sw) throw Error(`no switch for ${label}`);
  if (sw.checked !== on) await t.driver.point(sw.x, sw.y);
  await textButton(t, '.prefs-foot', 'Done');
  await pause(400);
}

export async function demo(t) {
  const out = process.env.DEMO_OUT ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../results/gui/demo');
  const rec = new Recorder(t.driver, out);
  await settledPhoto(t);
  await hideInfo(t.driver);
  if (await pathFree(t.driver)) throw Error('a path is visible; the clip would show it');

  const segment = async (name, caption, fn, { quiet } = {}) => {
    if (only && !only.includes(name)) return;
    try {
      if (caption) rec.caption(caption);
      await fn();
      await pause(quiet ?? 700);
    } catch (error) {
      t.measure({ name: `demo-${name}`, skipped: error.message.split('\n')[0] });
      try { await t.driver.keys(''); } catch {}
    }
  };
  // setup the viewer never sees
  const setup = async fn => { rec.pause(); try { await fn(); } finally { rec.resume(); } };

  await rec.start();
  try {
    // 1. auto-hide with the right column pinned, then focus mode
    await segment('layout', 'Panels hide until you need them. Pin the ones you keep.', async () => {
      await setup(() => preference(t, 'Auto-hide panels', true));
      await tool(t, 'adjust');
      await pause(800);
      await click(t, '.right button.pin'); // pin the right column
      await pause(900);
      const view = await t.driver.observe(() => ({ w: innerWidth, h: innerHeight }));
      await t.driver.move(view.w * .45, view.h * .5); // pointer leaves the left panel: it slides away
      await pause(1400);
    });
    await segment('focus', 'Focus mode: one panel open at a time.', async () => {
      // click the first three panel titles in turn; each opening closes the last
      for (const i of [1, 2, 0]) {
        const p = await t.driver.observe(n => {
          const e = document.querySelectorAll('.panel.adjust .panel-title')[n], r = e?.getBoundingClientRect();
          return r && { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, i);
        if (!p) throw Error('panel title not found');
        await t.driver.point(p.x, p.y); await pause(900);
      }
    });

    // 2. basic sliders
    await segment('sliders', 'Basic sliders', async () => {
      await tool(t, 'adjust'); await panel(t, 'basic');
      for (const [id, v] of [['exposure', 0.8], ['contrast', 25], ['highlights', -45], ['shadows', 35], ['vibrance', 30]]) {
        await slide(t, id, v); await pause(500);
      }
      await settledPhoto(t);
    });

    // 3. masks
    await segment('masks', 'Masks: local adjustments', async () => {
      await tool(t, 'masks');
      await click(t, '.create-mask'); await textButton(t, '.shape-menu-list', 'Radial Gradient');
      const photo = await reveal(t, 'svg.mask-svg');
      await t.driver.drag({ x: photo.x - photo.bounds.width * .15, y: photo.y - photo.bounds.height * .1 },
                          { x: photo.x + photo.bounds.width * .15, y: photo.y + photo.bounds.height * .12 });
      await until(() => t.driver.observe(() => !!document.querySelector('.mask-list > li')), 'mask created');
      await openMaskGroup(t, 'Tone');
      const s = await reveal(t, '[data-control-id="l_exposure"] input[type=range]');
      await t.driver.drag({ x: s.x, y: s.y }, { x: s.x + s.bounds.width * .22, y: s.y });
      await settledPhoto(t);
      await pause(900);
    });

    // 4. contrast equalizer: a module choice, set in Preferences first
    await segment('equalizer', 'Contrast equalizer', async () => {
      await setup(async () => {
        await click(t, 'button[data-tour="prefs"]');
        await textButton(t, '.prefs-tabs', 'Modules'); await textButton(t, '.prefs', 'Custom');
        const fold = 'button[aria-controls="module-prefs-global"]';
        if (!await t.driver.observe(s => document.querySelector(s)?.getAttribute('aria-expanded') === 'true', fold)) await click(t, fold);
        const selector = 'select[aria-label="Global Contrast"]', menu = await reveal(t, selector);
        const option = menu.options.find(o => o.label.includes('equalizer'));
        if (!option) throw Error('no equalizer option');
        await choose(t, selector, option.value); await textButton(t, '.prefs-foot', 'Done');
        await tool(t, 'adjust'); await expandSections(t, await panel(t, 'basic'));
      });
      for (const [band, dy] of [[2, -40], [4, 45], [5, -30]]) {
        const p = await reveal(t, `.equalizer-graph circle:nth-of-type(${band})`);
        await t.driver.drag({ x: p.x, y: p.y }, { x: p.x, y: p.y + dy });
        await pause(400);
      }
      await settledPhoto(t);
    });

    // 5. panorama and HDR merge: only with source photos (DEMO_PHOTOS)
    await segment('merge', 'Panorama and HDR merge', async () => {
      if (!t.fixtureFiles || !(await t.fixtureFiles()).filter(n => !n.endsWith('.xmp')).length > 1)
        throw Error('no merge source photos in the fixture folder');
      await click(t, 'button[title^="grid view"]'); await t.driver.chord('', 'a');
      await t.driver.keys('p');
      await until(() => t.driver.observe(() => !!document.querySelector('.pano-merge')), 'Panorama Merge');
      for (const label of await t.driver.observe(() => [...document.querySelectorAll('[aria-label="Projection"] button')].map(e => e.textContent.trim()))) {
        await textButton(t, '[aria-label="Projection"]', label); await pause(900);
      }
      await textButton(t, '.pano-merge .modal-foot', 'Cancel');
    });

    // 6. presets
    await segment('presets', 'Presets and looks', async () => {
      await tool(t, 'presets');
      const tiles = await t.driver.observe(() => [...document.querySelectorAll('.presets-panel .tile')].slice(0, 4).map(e => {
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
      for (const tile of tiles.slice(0, 3)) { await t.driver.move(tile.x, tile.y); await pause(700); }
      if (tiles[1]) await t.driver.point(tiles[1].x, tiles[1].y);
      await settledPhoto(t);
    });

    // 7. film simulation
    await segment('film', 'Film simulation', async () => {
      await tool(t, 'film');
      await until(() => t.driver.observe(() => !!document.querySelector('.panel.film button, .panel.film select')), 'film panel');
      await textButton(t, '.panel.film', 'Convert to Film');
      await settledPhoto(t, () => true);
      await pause(1200);
      await choose(t, '.panel.film [data-action="film-preset"]', 'film|portrait');
      await settledPhoto(t); await pause(900);
    });

    // 8. zone system: hover over zones
    await segment('zones', 'Zone System', async () => {
      await tool(t, 'zones');
      await until(() => t.driver.observe(() => document.querySelectorAll('.zone-col').length >= 10), 'zone columns');
      const cols = await t.driver.observe(() => [...document.querySelectorAll('.zone-col')].map(e => {
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
      for (const i of [1, 3, 5, 7, 9, 6, 2]) { await t.driver.move(cols[i].x, cols[i].y); await pause(600); }
    });

    // 9. print
    await segment('print', 'Print and soft proofing', async () => {
      await tool(t, 'print');
      await until(() => t.driver.observe(() => !!document.querySelector('.panel.print')), 'print panel');
      await pause(1800);
    }, { quiet: 1500 });
  } finally {
    const timeline = await rec.stop();
    t.measure({ name: 'demo-recorded', out, frames: timeline.frames.length, seconds: timeline.frames.at(-1)?.t / 1000 });
  }
}
