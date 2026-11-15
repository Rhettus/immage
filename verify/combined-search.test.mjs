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
