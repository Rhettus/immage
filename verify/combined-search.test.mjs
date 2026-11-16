// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const path = new URL('../app/src/combinedSearch.ts', import.meta.url);
const code = transformSync(path.pathname, readFileSync(path, 'utf8')).code;
const { createCombinedSearchCoordinator: create } = await import('data:text/javascript,' + encodeURIComponent(code));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return {promise,resolve,reject}; };
const tick = () => new Promise(r => setImmediate(r));
test('sources publish independently, errors do not erase successful pages', async () => {
  const slow = deferred(), updates=[];
  const c=create({sources:{local:async()=>({items:['local'],next:'l2'}),immich:()=>slow.promise},onUpdate:s=>updates.push(s)});
  const pending=c.search('beach'); await tick();
  assert.deepEqual(c.getState().results.map(r=>r.item),['local']);
  assert.equal(c.getState().sources.immich.status,'searching');
  slow.reject(Error('offline')); await pending;
  assert.equal(c.getState().sources.immich.status,'error');
  assert.deepEqual(c.getState().results.map(r=>r.item),['local']);
  assert.ok(updates.length>2);
});
test('independent cursors retain pages and reject duplicate load-more while pending', async () => {
  const second=deferred(), calls=[];
  const c=create({sources:{local:async(q,next)=>{calls.push(next);return next ? second.promise : {items:['a'],next:'L'};},immich:async()=>({items:['b'],next:null})}});
  await c.search('x'); const more=c.loadMore('local'); await c.loadMore('local');
  assert.deepEqual(calls,[null,'L']); assert.deepEqual(c.getState().sources.immich.items,['b']);
  second.resolve({items:['c'],next:null});await more;
  assert.deepEqual(c.getState().sources.local.items,['a','c']);
});
test('superseding and cancellation abort adapters and suppress late replies', async () => {
  const old=deferred(), signals=[];
  const c=create({sources:{local:(q,n,s)=>{signals.push(s);return q==='old'?old.promise:Promise.resolve({items:[q],next:null});}}});
  const pending=c.search('old');await c.search('new');assert.equal(signals[0].aborted,true);
  old.resolve({items:['stale'],next:null});await pending;
  assert.deepEqual(c.getState().results.map(r=>r.item),['new']);c.cancel();
  assert.equal(c.getState().query,null);await c.loadMore('local');
});
test('equal RRF combines verified identities only, and duplicate rows cannot boost a source', async () => {
  const c=create({sources:{local:async()=>({items:[{id:'same'},{id:'same'},{id:'local'}],next:null}),immich:async()=>({items:[{id:'remote'},{id:'same'}],next:null})},verifiedIdentity:(_,i)=>i.id==='same'?'verified':null});
  await c.search('x');const rows=c.getState().results;
  assert.equal(rows.length,3);assert.equal(rows[0].item.id,'same');
  assert.equal(rows[0].score,1/61+1/62);assert.deepEqual(rows[0].sources,['local','immich']);
  assert.equal(rows.find(r=>r.item.id==='remote').score,1/61);
});
test('disabled sources perform no calls', async () => {
  let remote=0;const c=create({sources:{local:async()=>({items:['a'],next:null}),immich:async()=>{remote++;throw Error('not configured');}}});
  await c.search('x',['local']);assert.equal(remote,0);assert.equal(c.getState().sources.immich.status,'idle');
});
const changed = () => Error('index-changed: local index changed');
const restartOn = (source, e) => source === 'local' && String(e).includes('index-changed');
test('a source restarts once from its first page when its index changed', async () => {
  const calls = []; let fail = 1;
  const c = create({ restartOn, sources: { local: async (q, next) => { calls.push(next); if (fail-- > 0) throw changed(); return { items: ['a'], next: null }; }, immich: async () => ({ items: ['b'], next: null }) } });
  await c.search('x');
  assert.deepEqual(calls, [null, null]);
  assert.equal(c.getState().sources.local.status, 'ready');
  assert.deepEqual(c.getState().sources.local.items, ['a']);
  assert.deepEqual(c.getState().sources.immich.items, ['b']);
});
test('a failing later page restarts from page one and replaces the items', async () => {
  const calls = []; let failed = false;
  const c = create({ restartOn, sources: { local: async (q, next) => { calls.push(next);
    if (next === 'L' && !failed) { failed = true; throw changed(); }
    return next ? { items: ['c'], next: null } : { items: ['a'], next: 'L' }; }, immich: async () => ({ items: [], next: null }) } });
  await c.search('x'); await c.loadMore('local');
  assert.deepEqual(calls, [null, 'L', null]);
  assert.deepEqual(c.getState().sources.local.items, ['a']);
  assert.equal(c.getState().sources.local.next, 'L');
});
test('two index changes in a row stop with the error and no third attempt', async () => {
  let n = 0;
  const c = create({ restartOn, sources: { local: async () => { n++; throw changed(); }, immich: async () => ({ items: [], next: null }) } });
  await c.search('x');
  assert.equal(n, 2);
  assert.equal(c.getState().sources.local.status, 'error');
});
test('a cancelled query does not retry, and other errors are not retried', async () => {
  let n = 0; const gate = deferred();
  const c = create({ restartOn, sources: { local: async () => { n++; await gate.promise; throw changed(); }, immich: async () => ({ items: [], next: null }) } });
  const p = c.search('x'); await tick(); c.cancel(); gate.resolve(); await p;
  assert.equal(n, 1);
  let m = 0;
  const d = create({ restartOn, sources: { local: async () => { m++; throw Error('offline'); }, immich: async () => ({ items: [], next: null }) } });
  await d.search('x');
  assert.equal(m, 1);
  assert.equal(String(d.getState().sources.local.error), 'Error: offline');
});
