// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
// Tauri's invoke is replaced by whatever the test puts in globalThis.__invoke
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '@tauri-apps/api/core') {
      return { url: 'data:text/javascript,export const invoke=(...a)=>globalThis.__invoke(...a)', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    const bare = url.split('?')[0];
    if (!bare.startsWith('file:') || !/\.tsx?$/.test(bare)) return next(url, ctx);
    const path = fileURLToPath(bare);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8')).code, shortCircuit: true };
  },
});

let n = 0;
// a fresh module, with its own map, for each scenario
async function load({ file = {}, ls = null, fail = false } = {}) {
  const calls = [];
  const stored = { ...file };
  globalThis.__invoke = async (cmd, args) => {
    if (fail) throw new Error('no tauri');
    if (cmd === 'settings_all') return { ...stored };
    if (globalThis.__failSet) throw new Error('write failed');
    calls.push({ cmd, args });
    for (const [k, v] of Object.entries(args.changes)) { if (v === null) delete stored[k]; else stored[k] = v; }
  };
  let m = null;
  if (ls) {
    m = ls instanceof Map ? ls : new Map(Object.entries(ls));
    globalThis.localStorage = { get length() { return m.size; }, key: i => [...m.keys()][i] ?? null, getItem: k => m.get(k) ?? null,
      setItem: (k, v) => { m.set(k, String(v)); } };
  } else delete globalThis.localStorage;
  const { settings, ready } = await import(`../app/src/settings.ts?n=${n++}`);
  await ready;
  return { settings, calls, stored, ls: m };
}
const sets = calls => calls.filter(c => c.cmd === 'settings_set');

test('get, set, remove and keys', async () => {
  const { settings } = await load({ file: { a: '1', 'immage.settings-migrated': '1' } });
  assert.equal(settings.get('a'), '1');
  assert.equal(settings.get('nope'), null);
  settings.set('b', '2');
  assert.equal(settings.get('b'), '2');
  settings.remove('a');
  assert.equal(settings.get('a'), null);
  assert.deepEqual(settings.keys().sort(), ['b', 'immage.settings-migrated']);
  await settings.flush();
});

test('writes coalesce into one settings_set', async () => {
  const { settings, calls } = await load({ file: { 'immage.settings-migrated': '1' } });
  settings.set('x', '1');
  settings.set('x', '2');
  settings.set('y', '3');
  settings.remove('y');
  assert.equal(sets(calls).length, 0);
  await new Promise(r => setTimeout(r, 400));
  assert.equal(sets(calls).length, 1);
  assert.deepEqual(sets(calls)[0].args, { changes: { x: '2', y: null } });
});

test('native keys are readable and never written', async () => {
  const { settings } = await load({ file: { 'native.x': 'v', 'immage.settings-migrated': '1' } });
  assert.equal(settings.get('native.x'), 'v');
  assert.throws(() => settings.set('native.x', 'w'));
  assert.throws(() => settings.remove('native.x'));
  assert.equal(settings.get('native.x'), 'v');
});

test('migration copies localStorage once and sets the marker', async () => {
  const { settings, calls, stored } = await load({ file: { keep: 'file' }, ls: { keep: 'old', a: '1', 'native.z': 'q' } });
  assert.equal(settings.get('a'), '1');
  assert.equal(settings.get('keep'), 'file');
  assert.equal(settings.get('native.z'), null);
  assert.equal(stored['immage.settings-migrated'], '1');
  assert.equal(sets(calls).length, 1);
  assert.equal(stored.a, '1');
  // a second start finds the marker and copies nothing
  const again = await load({ file: stored, ls: { late: '9' } });
  assert.equal(again.settings.get('late'), null);
  assert.equal(sets(again.calls).length, 0);
});

test('deleting settings.json after the copy gives defaults, not the old values', async () => {
  const ls = new Map([['a', '1']]);
  const first = await load({ ls });
  assert.equal(first.stored.a, '1');
  assert.equal(ls.get('immage.settings-migrated'), '1');
  // the user moves settings.json away; localStorage still holds the old keys
  const reset = await load({ file: {}, ls });
  assert.equal(reset.settings.get('a'), null);
  assert.equal(sets(reset.calls).length, 0);
});

test('a failed first copy is tried again on the next start', async () => {
  const ls = new Map([['a', '1']]);
  globalThis.__failSet = true;
  const first = await load({ ls });
  assert.equal(ls.has('immage.settings-migrated'), false);
  delete globalThis.__failSet;
  const again = await load({ file: {}, ls });
  assert.equal(again.stored.a, '1');
  assert.equal(ls.get('immage.settings-migrated'), '1');
});

test('falls back to localStorage when invoke fails', async () => {
  const { settings } = await load({ fail: true, ls: { a: '1' } });
  assert.equal(settings.get('a'), '1');
  settings.set('b', '2');
  assert.equal(settings.get('b'), '2');
  await settings.flush();
  assert.equal(settings.get('b'), '2');
});

test('empty without invoke or localStorage', async () => {
  const { settings } = await load({ fail: true });
  assert.deepEqual(settings.keys(), []);
});

test('a failed send is retried on the next flush', async () => {
  const { settings, calls } = await load({ file: { 'immage.settings-migrated': '1' } });
  const ok = globalThis.__invoke;
  globalThis.__invoke = async () => { throw new Error('down'); };
  const warn = console.warn; console.warn = () => {};
  settings.set('k', 'v');
  await settings.flush();
  console.warn = warn;
  globalThis.__invoke = ok;
  await settings.flush();
  assert.deepEqual(sets(calls).at(-1).args, { changes: { k: 'v' } });
});

test('discard drops unsent changes and stops further sends', async () => {
  const { settings, calls, stored } = await load({ file: { a: '1', 'immage.settings-migrated': '1' } });
  settings.set('b', '2');
  settings.discard();
  settings.set('c', '3');
  settings.remove('a');
  await settings.flush();
  await new Promise(r => setTimeout(r, 400));
  assert.equal(sets(calls).length, 0);
  assert.deepEqual(stored, { a: '1', 'immage.settings-migrated': '1' });
});

test('a flush before discard still sends', async () => {
  const { settings, calls } = await load({ file: { 'immage.settings-migrated': '1' } });
  settings.set('b', '2');
  await settings.flush();
  settings.discard();
  assert.equal(sets(calls).length, 1);
});
