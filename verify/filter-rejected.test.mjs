// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: the folder filter's rejection rule and the Rejected category's counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withNodeLocales } from './vite-locales.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke=async()=>({});', shortCircuit: true };
    if (spec === '@tauri-apps/api/event') return { url: 'data:text/javascript,export const listen=async()=>()=>{};', shortCircuit: true };
    // library.ts only uses immich.ts for thumbnails, which these tests never fetch
    if (spec === './immich' && ctx.parentURL?.endsWith('/library.ts')) return { url: 'data:text/javascript,export const fetchImmichThumb=async()=>null;', shortCircuit: true };
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
const { NO_FILTER, passes, rejectedOptions } = await import('../app/src/filter.ts');

const photo = (imgid, extra = {}) => ({ imgid, filename: `${imgid}.raw`, rejected: false, rating: 0, labels: 0,
  edited: false, keywords: [], exif: { lens: '', model: 'Cam', maker: 'Co' }, ...extra });
const images = [photo(1), photo(2, { rejected: true }), photo(3, { rating: 4 }), photo(4, { rejected: true, edited: true })];
const ids = f => images.filter(i => passes(i, f)).map(i => i.imgid);

test('all shows everything, only shows rejected, hide shows the rest', () => {
  assert.deepEqual(ids({ ...NO_FILTER, rejected: 'all' }), [1, 2, 3, 4]);
  assert.deepEqual(ids({ ...NO_FILTER, rejected: 'only' }), [2, 4]);
  assert.deepEqual(ids({ ...NO_FILTER, rejected: 'hide' }), [1, 3]);
});

test('a rating minimum never admits a rejected photo', () => {
  assert.deepEqual(ids({ ...NO_FILTER, minRating: 1 }), [3]);
});

test('Rejected category counts follow the other filters but not its own choice', () => {
  const value = o => Object.fromEntries(o.map(r => [r.value, r.count]));
  assert.deepEqual(value(rejectedOptions(images, NO_FILTER)), { all: 4, hide: 2, only: 2 });
  // the counts are the same whichever of its rows is chosen
  assert.deepEqual(value(rejectedOptions(images, { ...NO_FILTER, rejected: 'only' })), { all: 4, hide: 2, only: 2 });
  assert.deepEqual(value(rejectedOptions(images, { ...NO_FILTER, edited: 'edited' })), { all: 1, hide: 0, only: 1 });
  assert.deepEqual(value(rejectedOptions(images, { ...NO_FILTER, edited: 'unedited' })), { all: 3, hide: 2, only: 1 });
  assert.deepEqual(rejectedOptions([], NO_FILTER).map(r => r.count), [0, 0, 0]);
});

test('every rejected state ticks exactly one row, which is its own', () => {
  for (const state of ['all', 'hide', 'only']) {
    const f = { ...NO_FILTER, rejected: state };
    const ticked = rejectedOptions(images, f).filter(r => r.value === f.rejected);
    assert.equal(ticked.length, 1, state);
    assert.equal(ticked[0].value, state);
  }
  assert.deepEqual(rejectedOptions(images, NO_FILTER).map(r => r.value), ['all', 'hide', 'only']);
});
