// SPDX-License-Identifier: GPL-3.0-or-later
// #41: History's rows were seen painted over each other on one line below
// the History card, outside its clip, with the card's own rows intact. This
// case fills History with steps and the Library column past the window,
// then scrolls, undoes, jumps, folds and compresses. After each step it
// checks the rows' layout (no overlap, nothing collapsed, the list inside its
// card) and the pixels of the column below its last card, which must be the
// plain panel color.
//
// WebKitWebDriver's screenshot repaints the page itself rather than copying
// the compositor's output, so a fault only in the compositor's layers may not
// show in it. A pass here is not proof the on-screen glitch is gone.
import assert from 'node:assert/strict';
import { until, pause } from '../support/webdriver.mjs';
import { Blocked } from '../support/scenario.mjs';
import { click, reveal, rangeSelector } from '../support/controls.mjs';
import { decodePNG } from '../support/pixels.mjs';
import { settledPhoto } from './smoke.mjs';
import * as read from '../support/observations.mjs';

// the History card's geometry, as the page lays it out
function geometry() {
  const left = document.querySelector('aside.left');
  const card = document.querySelector('.panel.history');
  const list = card?.querySelector('.history-list');
  if (!left || !card || !list) return null;
  const box = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const rows = [...list.querySelectorAll(':scope > li')].map(box);
  let overlaps = 0, collapsed = 0;
  rows.forEach((r, i) => {
    if (r.bottom - r.top < 12) collapsed++;
    if (i && r.top < rows[i - 1].bottom - 0.5) overlaps++;
  });
  const cards = [...left.children].map(box);
  const l = box(left), c = box(card), li = box(list);
  return {
    left: l, card: c, list: li, rows: rows.length, overlaps, collapsed,
    listOutside: li.bottom > c.bottom + 0.5 || li.top < c.top - 0.5,
    lastBottom: Math.max(...cards.map((r) => r.bottom)),
    top: left.scrollTop, room: left.scrollHeight - left.clientHeight,
    listTop: list.scrollTop, listRoom: list.scrollHeight - list.clientHeight,
    dpr: devicePixelRatio,
  };
}

// fraction of the column's empty space below its cards that is not the
// column's own color
function stray(png, g) {
  const { width, height, rgba } = decodePNG(png);
  const s = g.dpr;
  const x0 = Math.ceil((g.left.left + 14) * s), x1 = Math.floor((g.left.right - 14) * s);
  const y0 = Math.ceil((Math.max(g.lastBottom, g.left.top) + 6) * s), y1 = Math.floor((g.left.bottom - 16) * s);
  if (x1 - x0 < 20 || y1 - y0 < 20 || x1 > width || y1 > height) return null;
  const at = (x, y) => (y * width + x) * 4;
  // the column's color: what most of the region is
  const counts = new Map();
  for (let y = y0; y < y1; y += 4) for (let x = x0; x < x1; x += 4) {
    const i = at(x, y), k = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const bg = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const br = bg >> 16, bgG = (bg >> 8) & 255, bb = bg & 255;
  let off = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = at(x, y); n++;
    if (Math.abs(rgba[i] - br) > 16 || Math.abs(rgba[i + 1] - bgG) > 16 || Math.abs(rgba[i + 2] - bb) > 16) off++;
  }
  return { region: { x0, y0, x1, y1 }, background: [br, bgG, bb], fraction: off / n };
}

function title(name) {
  const e = document.querySelector(`.panel.${name} > .panel-title`), r = e?.querySelector('span')?.getBoundingClientRect();
  return e && r && { open: e.classList.contains('open'), x: r.left + 10, y: r.top + r.height / 2 };
}

export async function historyPaint(t) {
  // History open with Metadata beside it (focus mode's Alt+click adds a
  // card), so the column is taller than the window
  const head = await t.driver.observe(title, 'history');
  if (head && !head.open) { await t.driver.point(head.x, head.y); await pause(500); }
  const meta = await t.driver.observe(title, 'metadata');
  if (meta && !meta.open) { await t.driver.modifiedPoint('', meta.x, meta.y); await pause(500); }

  // one History step per drag: a drag of the same slider as the last step
  // merges into it, so cycle through four
  const p = await t.driver.observe(read.panelTitle);
  if (p && !p.open) await t.driver.point(p.x, p.y);
  const ids = ['exposure', 'contrast', 'highlights', 'shadows'];
  for (let i = 0; i < 28; i++) {
    const selector = rangeSelector(ids[i % ids.length]);
    const s = await reveal(t, selector);
    const at = (v) => ({ x: s.bounds.x + 8 + (s.bounds.width - 16) * (v - s.min) / (s.max - s.min), y: s.y });
    const span = s.max - s.min, to = s.min + span * (i % 8 < 4 ? 0.6 : 0.4) + span * 0.01 * (i % 5);
    await t.driver.drag(at(+s.value), at(to));
    await pause(300);
  }
  await settledPhoto(t);
  await until(async () => (await t.driver.observe(geometry))?.rows >= 25, 'History filled with steps');

  const results = [];
  const check = async (name) => {
    await pause(700);
    const g = await t.driver.observe(geometry);
    assert(g, 'History card present');
    const png = await t.driver.capture();
    const pixels = stray(png, g);
    const r = { name, rows: g.rows, overlaps: g.overlaps, collapsed: g.collapsed, listOutside: g.listOutside,
      top: g.top, room: g.room, listTop: g.listTop, listRoom: g.listRoom, card: g.card, lastBottom: g.lastBottom,
      stray: pixels };
    t.measure(r); results.push(r);
    await t.evidence(name);
  };
  const leftAt = async () => { const g = await t.driver.observe(geometry); return { x: (g.left.left + g.left.right) / 2, y: g.left.top + 60 }; };
  // the middle of the list's part inside the column
  const listAt = async () => {
    const g = await t.driver.observe(geometry);
    const top = Math.max(g.list.top, g.left.top), bottom = Math.min(g.list.bottom, g.left.bottom);
    assert(bottom - top > 40, `History list on screen (${top}..${bottom})`);
    return { x: g.list.left + 40, y: (top + bottom) / 2 };
  };

  await check('filled');
  if ((await t.driver.observe(geometry)).room < 100) throw new Blocked('Library column too short to scroll');

  // the column to its end, the list to its end, then the column back up
  for (let i = 0; i < 8; i++) { const a = await leftAt(); await t.driver.wheel(a.x, a.y, 400); await pause(120); }
  await check('column-end');
  for (let i = 0; i < 8; i++) { const a = await listAt(); await t.driver.wheel(a.x, a.y, 300); await pause(120); }
  await check('list-scrolled');
  for (let i = 0; i < 3; i++) { const a = await leftAt(); await t.driver.wheel(a.x, a.y, -250); await pause(120); }
  await check('column-up');

  // undo several steps
  for (let i = 0; i < 6; i++) { await t.driver.chord('', 'z'); await pause(250); }
  await check('undone');

  // the column shrinks and grows around the scrolled list
  let m = await t.driver.observe(title, 'metadata');
  if (m?.open) { await t.driver.modifiedPoint('', m.x, m.y); await check('metadata-folded'); }
  m = await t.driver.observe(title, 'metadata');
  if (m && !m.open) { await t.driver.modifiedPoint('', m.x, m.y); await check('metadata-open'); }

  // back to the column's end, where History's rows and buttons are on screen
  for (let i = 0; i < 8; i++) { const a = await leftAt(); await t.driver.wheel(a.x, a.y, 400); await pause(120); }
  const row = await t.driver.observe(() => {
    const list = document.querySelector('.panel.history .history-list');
    if (!list) return null;
    const lr = list.getBoundingClientRect();
    const left = list.closest('aside.left').getBoundingClientRect();
    const rows = [...list.querySelectorAll(':scope > li > button:not(:disabled)')]
      .map(b => b.getBoundingClientRect())
      .filter(r => r.top >= Math.max(lr.top, left.top) && r.bottom <= Math.min(lr.bottom, left.bottom));
    const r = rows[Math.floor(rows.length / 2)];
    return r && { x: r.left + 60, y: r.top + r.height / 2 };
  });
  if (row) { await t.driver.point(row.x, row.y); await check('row-picked'); }

  // compress: the list shrinks to a few rows while scrolled
  const compress = '.panel.history > .panel-title > button.compress[title^="compress history"]';
  if (await t.driver.observe(s => !!document.querySelector(`${s}:enabled`), compress)) {
    const before = (await t.driver.observe(geometry)).rows;
    await click(t, compress);
    await until(async () => (await t.driver.observe(geometry))?.rows < before, 'History compressed', 10000);
    await check('compressed');
  }

  for (const r of results) {
    t.subcheck(`${r.name}-rows`, !r.overlaps && !r.collapsed && !r.listOutside,
      { overlaps: r.overlaps, collapsed: r.collapsed, listOutside: r.listOutside });
    t.subcheck(`${r.name}-blank-below`, !r.stray || r.stray.fraction < 0.002, { stray: r.stray });
    t.subcheck(`${r.name}-offset`, r.top <= r.room + 1, { top: r.top, room: r.room });
  }
}
