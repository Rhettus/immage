// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: the Find popup's layout (findLayout.ts), over an in-memory settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const mem = new Map();
globalThis.__mem = { get: (k) => mem.get(k) ?? null, set: (k, v) => { mem.set(k, String(v)); } };
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=async()=>({});', shortCircuit: true };
    if (spec === '@tauri-apps/api/event') return { url: 'data:text/javascript,export const listen=async()=>()=>{};', shortCircuit: true };
    // library.ts only uses immich.ts for thumbnails, which these tests never fetch
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
    if (spec === './settings' && ctx.parentURL?.endsWith('/findLayout.ts')) return { url: 'data:text/javascript,' + encodeURIComponent('export const settings=globalThis.__mem;'), shortCircuit: true };
    if (ctx.parentURL?.endsWith('/immich.ts')) {
      const m = { './commands': 'export const commands={};', './settings': 'export const settings={get:()=>null,set:()=>{}};',
        './tunerWorkload': 'export const timeTunerWork=(_,f)=>f();', '@immporter/api': 'export const api={};' }[spec];
      if (m) return { url: 'data:text/javascript,' + encodeURIComponent(m), shortCircuit: true };
    }
    if (spec.startsWith('./') || spec.startsWith('../')) for (const ext of ['.ts', '.tsx']) {
      const url = new URL(spec + ext, ctx.parentURL);
      if (existsSync(url)) return next(url.href, ctx);
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    const source = withNodeLocales(url, readFileSync(path, 'utf8'));
    return { format: 'module', source: transformSync(path, source, { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
});
const L = await import('../app/src/findLayout.ts');
const KEY = 'immage.findLayout';
const B = { left: 100, right: 1100, top: 50, bottom: 650 };
const inside = (r, b) => r.left >= b.left && r.top >= b.top && r.left + r.width <= b.right && r.top + r.height <= b.bottom;

test('missing or corrupt storage gives the defaults, first size Dock', () => {
  mem.clear();
  assert.deepEqual(L.loadLayout(), { size: 'dock', pos: {} });
  for (const bad of ['{nope', 'null', '"x"', '[]', '{"size":"huge","pos":{"dock":{"x":"a","y":1}}}'])
    { mem.set(KEY, bad); assert.deepEqual(L.loadLayout(), { size: 'dock', pos: {} }, bad); }
});

test('store and load round-trip; Fill has no position', () => {
  mem.clear();
  L.storeLayout({ size: 'minimize', pos: { minimize: { x: 5, y: -7 }, dock: { x: -30, y: 0 } } });
  assert.deepEqual(L.loadLayout(), { size: 'minimize', pos: { minimize: { x: 5, y: -7 }, dock: { x: -30, y: 0 } } });
  mem.set(KEY, JSON.stringify({ size: 'fill', pos: { fill: { x: 9, y: 9 } } }));
  assert.deepEqual(L.loadLayout(), { size: 'fill', pos: {} });
});

test('default places: strip above the anchor, dock at the inline end, fill covers', () => {
  const s = L.defaultRect('minimize', B, 600, false);
  assert.equal(s.width, 640); assert.equal(s.left, 100 + (1000 - 640) / 2); assert.equal(s.top + s.height, 594);
  const d = L.defaultRect('dock', B, 600, false);
  assert.equal(d.width, 380); assert.equal(d.left + d.width, 1092); assert.equal(d.top, 58); assert.equal(d.height, 584);
  assert.equal(L.defaultRect('dock', B, 600, true).left, 108);
  assert.deepEqual(L.defaultRect('fill', B, 600, false), { left: 108, top: 58, width: 984, height: 584 });
  assert.equal(L.defaultRect('minimize', B, undefined, false).top + L.STRIP_HEIGHT, 642);
});

test('narrow bounds shrink the strip and dock', () => {
  const n = { left: 0, right: 300, top: 0, bottom: 400 };
  assert.equal(L.defaultRect('minimize', n, 380, false).width, 284);
  assert.equal(L.defaultRect('dock', n, 380, false).width, 284);
});

test('clampRect keeps a rectangle inside, or at the start when larger', () => {
  const r = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(L.clampRect({ ...r, left: 1000, top: 640 }, B), { ...r, left: 900, top: 550 });
  assert.deepEqual(L.clampRect({ ...r, left: -5, top: -5 }, B), { ...r, left: 100, top: 50 });
  const big = L.clampRect({ left: 500, top: 500, width: 5000, height: 5000 }, B);
  assert.equal(big.left, 100); assert.equal(big.top, 50);
});

test('placeRect puts a size where it was left, clamps it, and Fill never moves', () => {
  const moved = L.placeRect('minimize', B, 600, false, { x: 300, y: 200 });
  assert.equal(moved.left, 300); assert.equal(moved.top, 200);
  assert.ok(inside(L.placeRect('minimize', B, 600, false, { x: 9999, y: 9999 }), B));
  assert.deepEqual(L.placeRect('fill', B, 600, false, { x: 40, y: 40 }), L.defaultRect('fill', B, 600, false));
  // a stored place is clamped again when the area shrinks, and found again when it grows
  const small = { left: 100, right: 700, top: 50, bottom: 400 };
  assert.ok(inside(L.placeRect('dock', small, 380, false, { x: 50, y: 900 }), small));
  assert.equal(L.placeRect('dock', B, 600, false, { x: 700, y: 58 }).left, 700);
});

test('posFor keeps the place a size was dragged to, clamped, whatever the default', () => {
  assert.deepEqual(L.posFor('dock', B, 600, false, { left: 700, top: 58 }), { x: 700, y: 58 });
  const o = L.posFor('dock', B, 600, false, { left: 5000, top: -5000 });
  assert.ok(inside(L.placeRect('dock', B, 600, false, o), B));
  assert.equal(L.posFor('minimize', B, 600, false, { left: -1e6, top: 0 }).x, B.left);
  // the same stored place reopens where it was when the area's right edge moves in
  // far enough to leave room for it, and the default would have moved
  const narrow = { ...B, right: 900 };
  assert.notEqual(L.defaultRect('dock', B, 600, false).left, L.defaultRect('dock', narrow, 600, false).left);
  assert.equal(L.placeRect('dock', narrow, 600, false, { x: 400, y: 58 }).left, 400);
});

test('the strip is placed by its measured height', () => {
  const r = L.defaultRect('minimize', B, 600, false, 100);
  assert.equal(r.height, 100); assert.equal(r.top + r.height, 594);
  const p = L.placeRect('minimize', B, 600, false, { x: 300, y: 640 }, 100);
  assert.equal(p.top, 550);
});
