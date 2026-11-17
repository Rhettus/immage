// SPDX-License-Identifier: GPL-3.0-or-later
// Engine-free: the saved filters store (savedFilters.ts), over an in-memory settings.
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
    if (spec === './settings' && ctx.parentURL?.endsWith('/savedFilters.ts')) return { url: 'data:text/javascript,' + encodeURIComponent('export const settings=globalThis.__mem;'), shortCircuit: true };
    if (spec === 'react' && ctx.parentURL?.endsWith('/savedFilters.ts')) return { url: 'data:text/javascript,' + encodeURIComponent('export const useSyncExternalStore=(s,g)=>g();'), shortCircuit: true };
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
const S = await import('../app/src/savedFilters.ts');
const { NO_SEARCH } = await import('../app/src/immich.ts');
const { NO_FILTER } = await import('../app/src/filter.ts');
const KEY = 'immage.savedFilters';
const st = (text = '') => ({ search: { ...NO_SEARCH, text }, filter: { ...NO_FILTER } });
const reset = () => mem.clear();

test('missing or corrupt storage gives an empty list', () => {
  reset();
  assert.deepEqual(S.loadSaved(), []);
  for (const bad of ['{nope', '{}', '"x"', 'null', '[1,null,{"id":"a"},{"name":"b"},{"id":"c","name":"  "}]']) {
    mem.set(KEY, bad);
    assert.deepEqual(S.loadSaved(), [], bad);
  }
});

test('add, update, rename, delete', () => {
  reset();
  const a = S.addSaved('  Sunsets ', st('sun'));
  const b = S.addSaved('Sunsets', st('sea'));
  assert.notEqual(a.id, b.id);
  assert.equal(a.name, 'Sunsets');
  assert.deepEqual(S.loadSaved().map(f => f.state.search.text), ['sun', 'sea']);
  S.updateSaved(a.id, st('dusk'));
  assert.equal(S.loadSaved()[0].state.search.text, 'dusk');
  S.renameSaved(a.id, ' Dusk ');
  assert.equal(S.loadSaved()[0].name, 'Dusk');
  S.renameSaved(a.id, '   ');
  assert.equal(S.loadSaved()[0].name, 'Dusk');
  S.deleteSaved(a.id);
  assert.deepEqual(S.loadSaved().map(f => f.id), [b.id]);
  S.deleteSaved('missing');
  assert.equal(S.loadSaved().length, 1);
});

test('moveSaved reorders and clamps', () => {
  reset();
  const [a, b, c] = ['a', 'b', 'c'].map(n => S.addSaved(n, st()));
  const order = () => S.loadSaved().map(f => f.name).join('');
  S.moveSaved(c.id, 0); assert.equal(order(), 'cab');
  S.moveSaved(c.id, 2); assert.equal(order(), 'abc');
  S.moveSaved(a.id, 99); assert.equal(order(), 'bca');
  S.moveSaved(a.id, -5); assert.equal(order(), 'abc');
  S.moveSaved('missing', 1); assert.equal(order(), 'abc');
});

test('an old partial entry is filled out', () => {
  reset();
  mem.set(KEY, JSON.stringify([{ id: 'x', name: 'Old', state: { search: { text: 'hi' } } }, { id: 'y', name: 'None' }]));
  const [x, y] = S.loadSaved();
  assert.deepEqual(x.state.search, { ...NO_SEARCH, text: 'hi' });
  assert.deepEqual(x.state.filter, NO_FILTER);
  assert.deepEqual(y.state, { search: NO_SEARCH, filter: NO_FILTER });
});

test('subscribers hear changes', () => {
  reset();
  let n = 0;
  const off = S.subscribeSaved(() => n++);
  S.addSaved('a', st());
  assert.equal(n, 1);
  off();
  S.addSaved('b', st());
  assert.equal(n, 1);
});

test('savedForDigit', () => {
  reset();
  for (let i = 1; i <= 10; i++) S.addSaved('f' + i, st());
  assert.equal(S.savedForDigit('Digit1').name, 'f1');
  assert.equal(S.savedForDigit('Digit9').name, 'f9');
  assert.equal(S.savedForDigit('Digit0'), undefined);
  assert.equal(S.savedForDigit('KeyA'), undefined);
  reset();
  assert.equal(S.savedForDigit('Digit1'), undefined);
});

test('skippedNote', () => {
  assert.equal(S.skippedNote({ local: true, immich: false, skipped: true }), 'library.find.saved.immichSkipped');
  assert.equal(S.skippedNote({ local: true, immich: true, skipped: false }), null);
});
