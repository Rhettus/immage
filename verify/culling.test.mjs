// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { cullingKey, pickCullingTarget, fallbackPhoto, fitLightbox, keywordTargets, previewNeighbors, PreviewQueue } from '../app/src/culling.ts';

test('keyword selection wins over hover, including filtered-out selections', () => {
  const images = [{imgid: 1}, {imgid: 2}, {imgid: 3}];
  assert.deepEqual(keywordTargets(images, new Set([1, 2]), 3), images.slice(0, 2));
  assert.deepEqual(keywordTargets(images, new Set(), 3), [images[2]]);
  assert.deepEqual(keywordTargets(images, new Set()), []);
  assert.deepEqual(keywordTargets([{imgid: 1, remote: {}}], new Set([1]), 1), []);
});

test('rapid navigation replaces queued neighbors but lets active work finish', async () => {
  const q = new PreviewQueue();
  let finish;
  const calls = [];
  const first = q.enqueue(() => new Promise(resolve => { calls.push('active'); finish = resolve; }));
  const old = q.enqueue(async () => calls.push('obsolete'));
  const rejection = assert.rejects(old, /superseded/);
  q.replace();
  const next = q.enqueue(async () => calls.push('foreground'));
  assert.deepEqual(calls, ['active']);
  finish();
  await Promise.all([first, next, rejection]);
  assert.deepEqual(calls, ['active', 'foreground']);
});

test('failed work does not block subsequent previews', async () => {
  const q = new PreviewQueue();
  const failed = q.enqueue(async () => { throw Error('decode failed'); });
  const next = q.enqueue(async () => 42);
  await assert.rejects(failed, /decode failed/);
  assert.equal(await next, 42);
});

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const component = readFileSync(new URL('../app/src/GridCulling.tsx', import.meta.url), 'utf8');
const start = component.indexOf('    const key = (e: KeyboardEvent)');
const end = component.indexOf('    window.addEventListener("keydown"', start);
const body = transformSync('handler.ts', component.slice(start, end)).code;
const createHandler = new Function('env', `with(env) { ${body}; return key; }`);
function fixture(overrides = {}) {
  const calls = [];
  const images = [{ imgid: 1, labels: 0 }, { imgid: 2, labels: 0 }, { imgid: 3, labels: 0 }];
  const env = { writing: false, targets: [], photo: null, current: null, images, allImages: images,
    selection: new Set([1,2]), anchor: 2, keywordTargets, cullingKey, pickCullingTarget, direction: {current:1},
    zoomRef: {current:null}, zoomAnchor: {current:null},
    document: { querySelector: selector => selector.includes(':hover') ? {getAttribute: () => '3'} : null },
    setTargets: v => calls.push(['targets', v]), keywordGeneration: { current: 0 }, space: {current:false}, setSpaceHeld() {},
    setPhoto: v => calls.push(['photo', v]), keywords: v => calls.push(['keywords', v.map(i => i.imgid)]),
    setZoom: v => calls.push(['zoom', v]),
    onMeta: (i, v) => calls.push(['meta', i.imgid, v]), ...overrides };
  const press = (key, target = {}) => createHandler(env)({key, target: {closest: () => false, ...target},
    preventDefault() {}, stopImmediatePropagation() {}});
  return { env, calls, press };
}
test('actual K handler prefers selection; F starts under the pointer', () => {
  const {press, calls} = fixture();
  press('k'); press('f');
  assert.deepEqual(calls, [['keywords', [1,2]], ['photo', 3]]);
});
test('lightbox arrows and metadata operate on displayed photo only', () => {
  const f = fixture({ photo: 2, current: {imgid: 2, labels: 0} });
  f.env.current = f.env.images[1];
  f.press('ArrowRight'); f.press('5'); f.press('k');
  assert.deepEqual(f.calls, [['photo',3], ['meta',2,{rating:5,rejected:false}], ['keywords',[2]]]);
});
test('typing in a keyword input never runs F or K', () => {
  const f = fixture();
  f.press('f', {closest: () => true}); f.press('k', {closest: () => true});
  assert.deepEqual(f.calls, []);
});
test('Escape closes keyword dialog before closing the lightbox', () => {
  const f = fixture({photo: 2, targets: [{imgid:2}]});
  f.press('Escape', {closest: () => true});
  assert.deepEqual(f.calls, [['targets', []]]);
});
test('Z toggles Fit and 100% on the displayed photo', () => {
  const f = fixture({photo:2, current:{imgid:2}});
  f.press('z');
  assert.deepEqual(f.calls, [['zoom',1]]);
});

test('first paint borrows the exact virtual-copy thumbnail without closing it', () => {
  const begin = component.indexOf('    const small = thumbnail(current.imgid);');
  const end = component.indexOf('    const key = (entry:', begin);
  const paint = new Function('thumbnail', 'current', 'detailed', 'canvas', 'setPaintSize', 'viewport', component.slice(begin, end));
  const calls = [];
  const bitmaps = new Map([[1, {width: 240, height: 160}], [2, {width: 160, height: 240}]]);
  const canvas = {current: {width: 0, height: 0, style: {}, getContext: () => ({drawImage: b => calls.push(b)})}};
  paint(id => bitmaps.get(id), {imgid: 2}, false, canvas, () => {}, {current:{clientWidth:800,clientHeight:600}});
  assert.deepEqual(calls, [bitmaps.get(2)]);
  assert.equal(canvas.current.height, 240);
  assert.equal(canvas.current.style.height, "600px");
  assert.equal(canvas.current.style.width, "400px");
  paint(id => bitmaps.get(id), {imgid: 1}, true, canvas, () => {}, {current:null});
  assert.equal(calls.length, 1, 'detail loading keeps the existing frame');
});

test('lightbox keeps a fixed 80% viewport frame across photos and zoom modes', () => {
  const frame = fitLightbox(1600, 900);
  assert.deepEqual(frame, {width:1280, height:720});
  for (const [w,h] of [[6000,4000],[4000,6000],[400,300],[300,600]]) {
    assert.deepEqual(fitLightbox(1600, 900), frame, `${w}x${h} photo keeps the same frame`);
  }
  assert.deepEqual(fitLightbox(400, 300), {width:320, height:240});
});

const sessionSource = readFileSync(new URL('../app/src/session.ts', import.meta.url), 'utf8');
const saveStart = sessionSource.indexOf('  async saveForPreview() {');
const saveEnd = sessionSource.indexOf('  async close()', saveStart);
const saveSource = sessionSource.slice(saveStart, saveEnd).replace('  async saveForPreview()', 'async function saveForPreview()');
const saveForPreview = new Function('traced', 'commands', 'window',
  `${saveSource}; return saveForPreview;`)((_, fn) => fn(), {save: async () => ({edited:true})}, {clearTimeout(){}});
test('an unchanged editor never delays preview waiting for its background rendering', async () => {
  const owner = {unsaved:false, dirty:new Set(), modulePending:[],
    settled() { throw Error('must not wait for unrelated rendering'); }};
  await saveForPreview.call(owner);
});
test('pending edits are flushed and saved before their processed preview', async () => {
  const calls = [];
  const owner = {unsaved:true, dirty:new Set(), modulePending:[],
    flushEdits() { calls.push('flush'); }, async settled() { calls.push('settle'); },
    onSaved(edited) { calls.push(edited); }};
  await saveForPreview.call(owner);
  assert.deepEqual(calls, ['flush','settle',true]);
  assert.equal(owner.unsaved, false);
});

test('preview read-ahead honors count, direction, behind toggle and boundaries', () => {
  const images = Array.from({length:7}, (_, i) => ({imgid:i+1}));
  const ids = (at, dir, count, both) => previewNeighbors(images, at, dir, count, both).map(i => i.imgid);
  for (const both of [false,true]) assert.deepEqual(ids(4,1,0,both), []);
  for (let count=1; count<=3; count++) {
    assert.deepEqual(ids(4,1,count,false), [5,6,7].slice(0,count));
    assert.deepEqual(ids(4,-1,count,false), [3,2,1].slice(0,count));
    assert.deepEqual(ids(4,-1,count,true), [...[3,2,1].slice(0,count), ...[5,6,7].slice(0,count)]);
  }
  assert.deepEqual(ids(1,-1,3,true), [2,3,4]);
  assert.deepEqual(ids(7,1,3,false), []);
  assert.deepEqual(ids(99,1,3,true), []);
  assert.deepEqual(previewNeighbors([{imgid:1},{imgid:2,remote:{}}],1,1,3,true), []);
});

test('lightbox rating, color and rejection keys match the regular photo shortcuts', () => {
  const f = fixture({photo:2});
  f.env.current = {...f.env.images[1], rejected:true};
  for (const key of ['0','1','2','3','4','5','6','7','8','9','x']) f.press(key);
  assert.deepEqual(f.calls.slice(0,6), Array.from({length:6}, (_, rating) => ['meta',2,{rating,rejected:false}]));
  assert.deepEqual(f.calls.slice(6,10), [1,2,4,8].map(labels => ['meta',2,{labels}]));
  assert.deepEqual(f.calls[10], ['meta',2,{rejected:false}]);
});

test('Space in the lightbox arms panning and leaves photo/metadata unchanged', () => {
  const f = fixture({photo:2});
  f.press(' ');
  assert.equal(f.env.space.current, true);
  assert.deepEqual(f.calls, []);
});

const viewportStart = component.indexOf('<div ref={viewport}');
const clickStart = component.indexOf('onClick={', viewportStart) + 'onClick={'.length;
const clickEnd = component.indexOf('\n          onDoubleClick=', clickStart);
const clickSource = component.slice(clickStart, clickEnd).trim().slice(0,-1);
const createClick = new Function('env', `with(env) { return (${clickSource}); }`);
test('single click toggles Fit and 100%, second click of double-click does not toggle again', () => {
  let zoom=null, count=0;
  const zoomRef={current:null};
  const env = {panClick:{current:false},space:{current:false},zoomAnchor:{current:null},
    zoomRef,
    canvas:{current:{getBoundingClientRect:()=>({left:0,top:0,width:400,height:300})}},
    setZoom(value) { zoom=zoomRef.current=value; count++; }};
  const click=createClick(env);
  const e={detail:1, clientX:100,clientY:150,currentTarget:{getBoundingClientRect:()=>({left:0,top:0})}};
  click(e);
  assert.equal(zoom,1);
  assert.deepEqual(env.zoomAnchor.current,{ix:.25,iy:.5,sx:100,sy:150});
  click({...e,detail:2});
  assert.equal(count,1);
});
test('Space-click and a pan-release click never toggle zoom', () => {
  const env={panClick:{current:true},space:{current:false},setZoom(){throw Error('unexpected zoom');}};
  const click=createClick(env);
  click({detail:1});
  assert.equal(env.panClick.current,false);
  env.space.current=true;
  click({detail:1});
});

const loaderStart = component.indexOf('    const key = (entry:');
const loaderEnd = component.indexOf('    const show = async', loaderStart);
const loaderSource = transformSync('loader.ts', component.slice(loaderStart, loaderEnd)).code;
const makeLoader = new Function('env', `with(env) { ${loaderSource}; return load; }`);
test('preview memory cache reuses pixels, bounds ownership and separates virtual copies', async () => {
  let reads = 0, closes = 0;
  const env = {previews:{current:new Map()}, epoch:0, previewEpoch:{current:0},
    fetchCachedThumb:async () => { reads++; return {close(){closes++;}}; },
    fetchThumb:async () => { throw Error('unexpected render'); }};
  const load = makeLoader(env);
  const first = await load({imgid:1,path:'raw',version:0}, 800);
  assert.equal(await load({imgid:1,path:'raw',version:0}, 800), first);
  assert.equal(reads, 1);
  for (let imgid=2;imgid<=10;imgid++) await load({imgid,path:'raw',version:0},800);
  assert.equal(env.previews.current.size,8);
  assert.equal(closes,2);
  await load({imgid:10,path:'raw',version:1},800);
  assert.equal(reads,11,'changed version needs fresh pixels');
  const before=env.previews.current.size;
  const detail=await load({imgid:10,path:'raw',version:1},0);
  assert.equal(env.previews.current.size,before,'native detail is not retained');
  detail.close();
});
test('closing lightbox disposes late preview results instead of retaining them', async () => {
  let finish, closed=false;
  const env={previews:{current:new Map()},epoch:0,previewEpoch:{current:0},
    fetchCachedThumb:() => new Promise(resolve => { finish=resolve; })};
  const pending=makeLoader(env)({imgid:1},800);
  env.previewEpoch.current++;
  finish({close(){closed=true;}});
  assert.equal(await pending,null);
  assert.equal(closed,true);
  assert.equal(env.previews.current.size,0);
});

test('cached foreground draws immediately even while native speculative work is busy', async () => {
  const start=component.indexOf('    const show = async');
  const end=component.indexOf('    void show().catch', start);
  const source=transformSync('show.ts',component.slice(start,end)).code;
  const pixels={}; const calls=[];
  const env={current:{imgid:2},size:800,key:()=> 'second',
    previews:{current:new Map([['second',pixels]])},stale:false,detailed:false,
    q:{enqueue(){throw Error('cached foreground must bypass native queue');}},
    draw:b=>calls.push(b),setDetail(){},setBusy(){},
    setTimeout:()=>123,timer:undefined};
  await new Function('env',`with(env) { ${source}; return show(); }`)(env);
  assert.deepEqual(calls,[pixels]);
});

const state = (o = {}) => ({ photo: null, keywordsOpen: false, writing: false, blocked: false,
  modalOpen: false, hasTarget: true, hasCurrent: true, ...o });
const act = (k, o) => cullingKey(k, state(o));

test('Escape closes the keyword dialog first, then the lightbox, and waits while writing', () => {
  assert.deepEqual(act('escape', { photo: 4, keywordsOpen: true }), { kind: 'consume', action: { type: 'closeKeywords' } });
  assert.deepEqual(act('escape', { photo: 4, keywordsOpen: true, writing: true }), { kind: 'consume', action: { type: 'none' } });
  assert.deepEqual(act('escape', { photo: 4 }), { kind: 'consume', action: { type: 'closeLightbox' } });
  // the keyword dialog's Escape wins even over modifier or editable-field blocking
  assert.equal(act('escape', { keywordsOpen: true, blocked: true }).action.type, 'closeKeywords');
  assert.equal(act('escape').kind, 'ignore');
  assert.equal(act('escape', { photo: 4, blocked: true }).kind, 'ignore');
});

test('z toggles zoom, arrows step, space holds, only in the lightbox', () => {
  assert.equal(act('z', { photo: 1 }).action.type, 'toggleZoom');
  assert.equal(act('z', { photo: 1, hasCurrent: false }).action.type, 'none');
  assert.equal(act('z').kind, 'ignore');
  assert.deepEqual(act('arrowleft', { photo: 1 }).action, { type: 'step', by: -1 });
  assert.deepEqual(act('arrowright', { photo: 1 }).action, { type: 'step', by: 1 });
  assert.equal(act('arrowright').kind, 'ignore');
  assert.equal(act(' ', { photo: 1 }).action.type, 'holdSpace');
  assert.equal(act(' ', { photo: 1, keywordsOpen: true }).kind, 'swallow');
  assert.equal(act(' ').kind, 'ignore');
});

test('ratings, color labels and reject act on the current photo', () => {
  assert.deepEqual(act('0', { photo: 1 }).action, { type: 'rate', value: 0 });
  assert.deepEqual(act('5', { photo: 1 }).action, { type: 'rate', value: 5 });
  assert.deepEqual(act('6', { photo: 1 }).action, { type: 'label', bit: 0 });
  assert.deepEqual(act('9', { photo: 1 }).action, { type: 'label', bit: 3 });
  assert.equal(act('x', { photo: 1 }).action.type, 'toggleReject');
  assert.equal(act('3', { photo: 1, hasCurrent: false }).action.type, 'none');
  // a lightbox swallows other keys; the grid ignores ratings
  assert.equal(act('q', { photo: 1 }).kind, 'swallow');
  assert.equal(act('3').kind, 'ignore');
  assert.equal(act('3', { photo: 1, keywordsOpen: true }).kind, 'ignore');
});

test('f and k open from the grid only with a target; open modals block the grid', () => {
  assert.equal(act('f').action.type, 'toggleLightbox');
  assert.equal(act('k').action.type, 'keywords');
  assert.equal(act('f', { hasTarget: false }).kind, 'ignore');
  assert.equal(act('f', { modalOpen: true }).kind, 'ignore');
  assert.equal(act('f', { photo: 1, modalOpen: true }).action.type, 'toggleLightbox');
  assert.equal(act('f', { blocked: true }).kind, 'ignore');
});

test('the lightbox falls back to the photo now at the same position, else the last, else closes', () => {
  const list = [{ imgid: 10 }, { imgid: 11 }, { imgid: 12 }];
  assert.equal(fallbackPhoto(list, 1), 11);
  assert.equal(fallbackPhoto(list, 7), 12);
  assert.equal(fallbackPhoto([], 0), null);
});
