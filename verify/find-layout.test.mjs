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

test('missing or corrupt storage gives the defaults', () => {
  mem.clear();
  assert.deepEqual(L.loadLayout(), { pos: null });
  for (const bad of ['{nope', 'null', '"x"', '[]', '{"size":"huge","pos":{"dock":{"x":"a","y":1}}}'])
    { mem.set(KEY, bad); assert.deepEqual(L.loadLayout(), { pos: null }, bad); }
});

test('store and load round-trip the dock place', () => {
  mem.clear();
  L.storeLayout({ pos: { x: -30, y: 0 } });
  assert.deepEqual(L.loadLayout(), { pos: { x: -30, y: 0 } });
  L.storeLayout({ pos: null });
  assert.deepEqual(L.loadLayout(), { pos: null });
});

test('settings from the three-size versions open as the dock, keeping its place', () => {
  mem.clear();
  mem.set(KEY, JSON.stringify({ size: 'minimize', pos: { minimize: { x: 5, y: -7 }, dock: { x: -30, y: 0 } } }));
  assert.deepEqual(L.loadLayout(), { pos: { x: -30, y: 0 } });
  mem.set(KEY, JSON.stringify({ size: 'fill', pos: { dock: { x: 40, y: 60 }, fill: { x: 9, y: 9 } } }));
  assert.deepEqual(L.loadLayout(), { pos: { x: 40, y: 60 } });
  mem.set(KEY, JSON.stringify({ size: 'minimize', pos: { minimize: { x: 5, y: -7 } } }));
  assert.deepEqual(L.loadLayout(), { pos: null });
  mem.set(KEY, JSON.stringify({ size: 'fill', pos: {} }));
  assert.deepEqual(L.loadLayout(), { pos: null });
  mem.set(KEY, JSON.stringify({ size: 'dock' }));
  assert.deepEqual(L.loadLayout(), { pos: null });
});

test('the default place is the inline end, full height', () => {
  const d = L.defaultRect(B, false);
  assert.equal(d.width, 380); assert.equal(d.left + d.width, 1092); assert.equal(d.top, 58); assert.equal(d.height, 584);
  assert.equal(L.defaultRect(B, true).left, 108);
});

test('narrow bounds shrink the dock', () => {
  const n = { left: 0, right: 300, top: 0, bottom: 400 };
  assert.equal(L.defaultRect(n, false).width, 284);
});

test('clampRect keeps a rectangle inside, or at the start when larger', () => {
  const r = { left: 0, top: 0, width: 200, height: 100 };
  assert.deepEqual(L.clampRect({ ...r, left: 1000, top: 640 }, B), { ...r, left: 900, top: 550 });
  assert.deepEqual(L.clampRect({ ...r, left: -5, top: -5 }, B), { ...r, left: 100, top: 50 });
  const big = L.clampRect({ left: 500, top: 500, width: 5000, height: 5000 }, B);
  assert.equal(big.left, 100); assert.equal(big.top, 50);
});

test('placeRect puts the dock where it was left and clamps it', () => {
  assert.deepEqual(L.placeRect(B, false, null), L.defaultRect(B, false));
  const moved = L.placeRect(B, false, { x: 300, y: 200 });
  // the dock is almost the area's height, so it only moves a little down
  assert.equal(moved.left, 300); assert.equal(moved.top, 66);
  assert.ok(inside(L.placeRect(B, false, { x: 9999, y: 9999 }), B));
  // a stored place is clamped again when the area shrinks, and found again when it grows
  const small = { left: 100, right: 700, top: 50, bottom: 400 };
  assert.ok(inside(L.placeRect(small, false, { x: 50, y: 900 }), small));
  assert.equal(L.placeRect(B, false, { x: 700, y: 58 }).left, 700);
});

test('posFor keeps the place the dock was dragged to, clamped, whatever the default', () => {
  assert.deepEqual(L.posFor(B, false, { left: 700, top: 58 }), { x: 700, y: 58 });
  const o = L.posFor(B, false, { left: 5000, top: -5000 });
  assert.ok(inside(L.placeRect(B, false, o), B));
  assert.equal(L.posFor(B, false, { left: -1e6, top: 0 }).x, B.left);
  // the same stored place reopens where it was when the area's right edge moves in
  // far enough to leave room for it, and the default would have moved
  const narrow = { ...B, right: 900 };
  assert.notEqual(L.defaultRect(B, false).left, L.defaultRect(narrow, false).left);
  assert.equal(L.placeRect(narrow, false, { x: 400, y: 58 }).left, 400);
});
