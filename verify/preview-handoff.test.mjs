// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
// Exercise the actual UI paint callback with canvas/DOM boundaries stubbed.
const source=readFileSync(new URL('../app/src/App.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const paintFrame = useCallback(');
const end=source.indexOf('  // timed for the performance overlay',start);
assert.ok(start>=0&&end>start);
const {code}=transformSync('paint.ts',source.slice(start,end));
const create=new Function('env',`with(env) { ${code}; return paintFrame; }`);
const ref=current=>({current});
function fixture() {
  const calls=[];
  const env={
    perf:{time(_name,fn){return fn();}},
    useCallback:callback=>callback,
    draftShown:ref(true),dragging:ref(false),session:ref(null),
    baModeRef:ref('off'),loupeCanvas:ref(null),loupeMeta:ref(null),setLoupeShown(){},
    clipRef:ref({low:false,high:false}),
    canvas:ref({width:2,height:2,getContext(){return {putImageData(){calls.push(['cpu']);}};}}),
    invalidateClip(){},frameGenerations:{histogram:{next(){}}},
    canvasFrames:{draw(){calls.push(['cpu']);}},
    ImageData:class {},paintClip(){},full:ref(null),sharpMeta:ref(null),placed:f=>f,
    setShownView(){},placeLayers(){calls.push(['place']);},updatePlacement(){calls.push(['placement']);},
    baseStale:ref(false),overviewHash:ref(null),autoPending:ref(false),tonePending:ref(null),wbTarget:ref(null),
    scheduleCopy(){calls.push(['copy']);},setStatus(){calls.push(['status']);},
  };
  const f={width:2,height:2,fullWidth:4,fullHeight:4,x:0,y:0,
    view:{width:2,height:2,scale:0.5},pixels:new Uint8ClampedArray(16),trace:{}};
  return {env,f,calls,paint:create(env)};
}
test('release presents native pixels and completes frame bookkeeping',()=>{
  const {env,f,calls,paint}=fixture();
  paint(f);
  assert.deepEqual(calls.map(c=>c[0]),['cpu','place','placement','copy','status']);
  assert.equal(env.draftShown.current,false);assert.equal(env.sharpMeta.current,f);
});

// Copy bitmaps finish asynchronously; stale copies must report a discard rather
// than a displayed frame, and each accepted copy must close its draw span.
const copyStart=source.indexOf('      s.onCopy = (f) => {');
const copyEnd=source.indexOf('      s.thumbSize =',copyStart);
const copyCode=transformSync('copy.ts',source.slice(copyStart,copyEnd)).code;
const createCopy=new Function('env',`with(env) { ${copyCode}; return s.onCopy; }`);
function copyFixture() {
  const calls=[],pending=[];
  const s={};
  const env={s,session:ref(s),copyCanvas:ref({getContext(){return {drawImage(){calls.push('pixels');}};}}),
    copyGen:ref(0),copyMeta:ref(null),placed:f=>f,placeLayers(){calls.push('place');},setCopyOn(on){calls.push(on);},
    ImageData:class {},createImageBitmap(){return new Promise(resolve=>pending.push(resolve));},
    perf:{begin(){calls.push('begin');return 1;},finish(){calls.push('finish');},
      drawStart(){calls.push('draw.start');},drawEnd(){calls.push('draw.end');},discard(_trace,reason){calls.push(reason);}}};
  const f={width:1,height:1,pixels:new Uint8ClampedArray(4),trace:{}};
  return {env,calls,pending,f,copy:createCopy(env)};
}
test('copy bitmap completion draws and closes the frame lifecycle',async()=>{
  const {copy,f,pending,calls}=copyFixture();copy(f);
  pending[0]({close(){calls.push('close');}});await new Promise(setImmediate);
  assert.deepEqual(calls,['begin','finish','draw.start','pixels','place',true,'close','draw.end']);
});
test('a late copy bitmap is closed and recorded as discarded',async()=>{
  const {copy,f,pending,calls,env}=copyFixture();copy(f);env.session.current=null;
  pending[0]({close(){calls.push('close');}});await new Promise(setImmediate);
  assert.deepEqual(calls,['begin','finish','close','copy-bitmap-obsolete']);
});
