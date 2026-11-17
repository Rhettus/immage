// SPDX-License-Identifier: GPL-3.0-or-later
// Lens Corrections' Method (Simple's demosaic choice, manifest.ts
// demosaicOptions): the list per sensor, darktable's default first, and how a
// method outside the list (Advanced's) is shown. Engine-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const shim = new URL('./shim.mjs', import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith('@tauri-apps/') || spec.startsWith('@immporter/')) return next(shim, ctx);
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec))
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    return next(spec, ctx);
  },
});
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.addEventListener ??= () => {};
const { panels } = await import('../app/src/manifest.ts');
const control = panels.flatMap(p => p.sections.flatMap(s => s.controls)).find(c => c.id === 'demosaic_method');
const opts = (sensor, value) => control.optionsFor({ sensor }, value);
const names = l => l.map(([n]) => n);

test('the demosaic method is a raw-only choice in Lens Corrections', () => {
  assert.ok(control, 'demosaic_method is in the manifest');
  assert.equal(control.rawOnly, true);
  assert.equal(typeof control.optionsFor, 'function');
});

test('a Bayer sensor lists Bayer methods, RCD first; X-Trans lists its own', () => {
  assert.deepEqual(opts('bayer', 5), [['RCD', 5], ['AMaZE', 1], ['LMMSE', 6], ['PPG', 0], ['VNG4', 2]]);
  const x = opts('xtrans', 1025);
  assert.equal(x[0][0], 'Markesteijn 1-pass');
  assert.deepEqual(x.map(([, v]) => v), [1025, 1026, 1028, 1024]);
  // X-Trans methods carry bit 1024, Bayer ones do not
  assert.ok(x.every(([, v]) => (v & 1024) !== 0));
  assert.ok(opts('bayer', 5).every(([, v]) => (v & 1024) === 0));
});

test('a method outside the list is shown by name, marked Advanced, and kept', () => {
  assert.deepEqual(opts('bayer', 2053).at(-1), ['RCD (dual) (Advanced)', 2053]);
  assert.deepEqual(names(opts('bayer', 2053)).slice(0, 5), names(opts('bayer', 5)));
  assert.deepEqual(opts('xtrans', 3074).at(-1), ['Markesteijn 3-pass (dual) (Advanced)', 3074]);
  assert.deepEqual(opts('bayer', 4000).at(-1), ['Custom (Advanced)', 4000]);
});

test('a bayer4 or monochrome raw has the one method darktable sets; a non-raw has none', () => {
  assert.deepEqual(opts('bayer4', 7), [['Monochrome', 7]]);
  assert.deepEqual(opts(undefined, 5), [['Not a raw', 5]]);
  assert.deepEqual(opts(null, 0), [['Not a raw', 0]]);
});

test('the chosen value reads back by method name', () => {
  assert.equal(control.format(5), 'RCD');
  assert.equal(control.format(1025), 'Markesteijn 1-pass');
  assert.equal(control.format(7), 'Monochrome');
  assert.equal(control.format(4000), '4000');
});
