// SPDX-License-Identifier: GPL-3.0-or-later
// A folder of 20,000 photos (filmWindow.ts, App.tsx showFolder): the page
// answers throughout the read, the filmstrip and grid draw only the cells in
// view, scrolling the grid draws the cells it reaches, the open photo's cell
// is drawn and in view when the strip shows it again, and engine.log's stall
// watch records no blocked page script
import assert from 'node:assert/strict';
import { until, pause } from '../support/webdriver.mjs';
import { settledPhoto } from './smoke.mjs';

export const largeFolderCount = 20000;
export const largeFolderName = (i) => `zz-big-${String(i + 1).padStart(5, "0")}`;

// far fewer than the folder: a screenful and a few lines either side
const DRAWN_MAX = 800;

const strip = () => {
  const root = document.querySelector('.filmstrip');
  if (!root) return null;
  const r = root.getBoundingClientRect();
  const cells = root.querySelectorAll(':scope > .thumb');
  const centre = document.elementFromPoint(r.x + r.width / 2, r.y + Math.min(r.height / 2, 120))?.closest('.thumb');
  const active = root.querySelector('.thumb.active')?.getBoundingClientRect();
  return {
    grid: root.classList.contains('grid'), drawn: cells.length,
    ghosts: root.querySelectorAll(':scope > .thumb.ghost').length,
    scrollTop: root.scrollTop, scrollLeft: root.scrollLeft,
    scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth,
    box: { x: r.x, y: r.y, width: r.width, height: r.height },
    centreIsCell: !!centre && root.contains(centre),
    active: active ? { left: active.left, right: active.right, top: active.top, bottom: active.bottom } : null,
  };
};

export async function largeFolder(t) {
  const logStart = (await t.engineLog()).length;
  await settledPhoto(t);
  // while the folder is read: how long the page takes to answer, and how many
  // cells it has drawn
  const samples = [];
  const started = Date.now();
  let s;
  await until(async () => {
    const asked = Date.now();
    s = await t.driver.observe(strip);
    samples.push({ at: asked - started, answerMs: Date.now() - asked, drawn: s?.drawn ?? 0, ghosts: s?.ghosts ?? 0 });
    await pause(500);
    // read once no file is left waiting, twice in a row
    const tail = samples.slice(-3);
    return tail.length === 3 && tail.every((x) => x.ghosts === 0 && x.drawn > 0);
  }, 'the folder read', 30 * 60 * 1000);
  const slowest = Math.max(...samples.map((x) => x.answerMs));
  const mostDrawn = Math.max(...samples.map((x) => x.drawn));
  t.measure({ name: 'read', seconds: (Date.now() - started) / 1000, samples: samples.length, slowestAnswerMs: slowest, mostDrawn,
              every10th: samples.filter((_, i) => i % 10 === 0) });
  await t.evidence('large-strip-read');
  assert(mostDrawn <= DRAWN_MAX, `the strip draws a window of cells while reading (${mostDrawn})`);
  assert(slowest < 3000, `the page answers within 3 s throughout the read (slowest ${slowest} ms)`);
  s = await t.driver.observe(strip);
  assert(s.scrollWidth > largeFolderCount * 20, `the strip is as long as the folder (${s.scrollWidth} px)`);

  // the grid: a window of cells, and scrolling draws where it lands
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !!document.querySelector('.filmstrip.grid')), 'grid view');
  await pause(800);
  s = await t.driver.observe(strip);
  t.measure({ name: 'grid', ...s });
  assert(s.drawn <= DRAWN_MAX, `the grid draws a window of cells (${s.drawn})`);
  assert(s.scrollHeight > s.box.height * 20, `the grid is as tall as the folder (${s.scrollHeight} px)`);
  const scrolls = [];
  for (let i = 0; i < 12; i++) {
    await t.driver.wheel(s.box.x + s.box.width / 2, s.box.y + s.box.height / 2, 4000);
    await pause(150);
    const now = await t.driver.observe(strip);
    scrolls.push({ scrollTop: now.scrollTop, drawn: now.drawn, centreIsCell: now.centreIsCell });
  }
  t.measure({ name: 'grid-scroll', scrolls });
  await t.evidence('large-grid-scrolled');
  assert(scrolls.at(-1).scrollTop > scrolls[0].scrollTop, 'the wheel scrolls the grid');
  assert(scrolls.every((x) => x.centreIsCell), 'a photo is drawn under the middle of the grid at every scroll position');
  assert(scrolls.every((x) => x.drawn <= DRAWN_MAX), `the grid keeps a window while scrolling (${scrolls.map((x) => x.drawn).join(', ')})`);

  // back to the strip: the open photo's cell is drawn and in view
  await t.driver.keys('g');
  await until(() => t.driver.observe(() => !document.querySelector('.filmstrip.grid')), 'back to the loupe');
  await pause(800);
  s = await t.driver.observe(strip);
  t.measure({ name: 'strip-back', ...s });
  await t.evidence('large-strip-back');
  assert(s.active, 'the open photo\'s cell is drawn in the strip');
  assert(s.active.left >= s.box.x - 1 && s.active.right <= s.box.x + s.box.width + 1, 'the open photo\'s cell is in view');

  // the stall watch's view of the whole case
  const log = (await t.engineLog()).slice(logStart);
  const stalls = log.split('\n').filter((l) => l.includes('[stall]'));
  t.measure({ name: 'stall-lines', stalls: stalls.slice(0, 40), count: stalls.length });
  const blocked = stalls.filter((l) => /script was blocked (\d+) ms/.test(l) && Number(/blocked (\d+) ms/.exec(l)[1]) >= 3000);
  assert(!blocked.length, `no page script block of 3 s or more:\n${blocked.join('\n')}`);
}
