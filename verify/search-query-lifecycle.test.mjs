// SPDX-License-Identifier: GPL-3.0-or-later
// Exercise the actual query coordinator and source adapters together; only
// native commands and the Immich API/settings boundary are mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const app = new URL('../app/src/', import.meta.url);
const files = ['combinedSearch.ts', 'localSearch.ts', 'immich.ts'].map(f => new URL(f, app).href);
const data = s => `data:text/javascript,${encodeURIComponent(s)}`;
const mocks = {
  './commands': 'export const commands=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.__queryLifecycle.commands[k](...a)});',
  './settings': 'export const settings={get:()=>null,set:()=>{}};',
  './tunerWorkload': 'export const timeTunerWork=(_,f)=>f();',
  '@immporter/api': 'export const api={getImmichSettings:async()=>({pathPrefix:"/remote",url:"",hasKey:false}),getSettings:async()=>({destRoot:"/photos"})};',
};
registerHooks({
  resolve(specifier, context, next) {
    if (files.includes(context.parentURL)) {
      if (mocks[specifier]) return { url: data(mocks[specifier]), shortCircuit: true };
      if (specifier === './immich') return { url: files[2], shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!files.includes(url)) return next(url, context);
    return { format: 'module', source: transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8')).code, shortCircuit: true };
  },
});

const [{ createCombinedSearchCoordinator }, { localSearch }, { NO_SEARCH, search: immichSearch }] = await Promise.all([
  import(files[0]), import(files[1]), import(files[2]),
]);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const form = { ...NO_SEARCH, source: 'both', text: 'sunset' };
const filters = { minRating: 0 };
const query = { form, filters, folder: '/photos', recursive: true };
const localHit = path => ({ asset_id: path, variant_id: `v-${path}`, subject: 'original', image: { imgid: path, path, filename: path } });
const remoteAsset = (id, path) => ({ id, path, localPath: null, name: path, rating: 0, width: 20, height: 10, date: null, exif: {} });
const adapters = () => ({
  local: (q, next, signal) => localSearch(q.form, q.filters, q.folder, q.recursive, next, signal),
  immich: async (q, next) => {
    const page = await immichSearch(q.form, next);
    return { items: page.entries, next: page.next };
  },
});

test('local results publish before an Immich failure and remain visible', async () => {
  const calls = [];
  const remoteReply = deferred();
  globalThis.__queryLifecycle = { commands: {
    async localSearch(args) { calls.push(args); return { items: [localHit('/photos/local.jpg')], next: 'local-2' }; },
    async localSearchCancel() {},
    async immichSearch() { return remoteReply.promise; },
  } };
  const c = createCombinedSearchCoordinator({ sources: adapters() });
  const running = c.search(query);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(c.getState().sources.local.status, 'ready');
  assert.equal(c.getState().sources.immich.status, 'searching');
  assert.deepEqual(c.getState().results.map(r => r.item.path), ['/photos/local.jpg']);
  remoteReply.reject(new Error('Immich unavailable'));
  await running;
  assert.equal(c.getState().sources.immich.status, 'error');
  assert.deepEqual(c.getState().results.map(r => r.item.path), ['/photos/local.jpg']);
});

test('actual adapters keep source cursors and append each source independently', async () => {
  const calls = [];
  globalThis.__queryLifecycle = { commands: {
    async localSearch(args) {
      calls.push(['local', args.next]);
      return args.next ? { items: [localHit('/photos/l2.jpg')], next: null } : { items: [localHit('/photos/l1.jpg')], next: 'lc' };
    },
    async localSearchCancel() {},
    async immichSearch(args, map) {
      calls.push(['immich', args.next, map]);
      return args.next ? { items: [remoteAsset('r2', 'r2.jpg')], next: null } : { items: [remoteAsset('r1', 'r1.jpg')], next: 'rc' };
    },
  } };
  const c = createCombinedSearchCoordinator({ sources: adapters() });
  await c.search(query);
  await c.loadMore('immich');
  assert.deepEqual(c.getState().sources.immich.items.map(i => i.remote.assetId), ['r1', 'r2']);
  assert.deepEqual(c.getState().sources.local.items.map(i => i.path), ['/photos/l1.jpg']);
  await c.loadMore('local');
  assert.deepEqual(c.getState().sources.local.items.map(i => i.path), ['/photos/l1.jpg', '/photos/l2.jpg']);
  assert.deepEqual(calls.map(row => row.slice(0, 2)), [['local', null], ['immich', null], ['immich', 'rc'], ['local', 'lc']]);
});

test('cancel reaches native local search and a late native reply is discarded', async () => {
  const pendingReply = deferred();
  const cancellations = [];
  globalThis.__queryLifecycle = { commands: {
    localSearch: () => pendingReply.promise,
    async localSearchCancel(id) { cancellations.push(id); },
    async immichSearch() { return { items: [], next: null }; },
  } };
  const c = createCombinedSearchCoordinator({ sources: adapters() });
  const running = c.search(query, ['local']);
  await tick();
  c.cancel();
  assert.equal(cancellations.length, 1);
  pendingReply.resolve({ items: [localHit('/photos/late.jpg')], next: null });
  await running;
  await tick(); // the adapter's native cancel command is intentionally detached
  assert.deepEqual(c.getState().sources.local.items, []);
  assert.equal(c.getState().query, null);
});
