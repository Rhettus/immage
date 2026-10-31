// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { interpolateDetail, isDetailControl, isCachedControl, predictionError, anchorInterval, predictionAccuracy, validatePrediction } from '../app/src/cachedDetail.ts';
const pixels=(...values)=>new Uint8ClampedArray(values);

test('detail interpolation follows real render endpoints and preserves alpha',()=>{
  const a={value:0,pixels:pixels(20,40,60,255)},b={value:20,pixels:pixels(40,80,100,128)};
  assert.deepEqual([...interpolateDetail(a,b,10,200)],[30,60,80,128]);
  assert.deepEqual([...interpolateDetail(a,b,20,200)],[40,80,100,128]);
  assert.deepEqual([...a.pixels],[20,40,60,255]);
});
test('unsafe extrapolation or incompatible frames use the native render',()=>{
  const a={value:0,pixels:pixels(20,40,60,255)},b={value:20,pixels:pixels(40,80,100,255)};
  assert.equal(interpolateDetail(a,b,90,200),null);
  assert.equal(interpolateDetail(a,{...b,value:0},10,200),null);
  assert.equal(interpolateDetail(a,{...b,pixels:pixels(0)},10,200),null);
  assert.equal(interpolateDetail(a,b,NaN,200),null);
});
test('detail eligibility excludes Exposure and other tone controls',()=>{
  for(const id of ['texture','clarity','contrast','dehaze','sharp_amount','detail_texture_gain_fine','l_detail_clarity_halo_control'])assert.equal(isDetailControl(id),true,id);
  for(const id of ['exposure','highlights','shadows','temp','saturation','l_exposure'])assert.equal(isDetailControl(id),false,id);
});

// Exercise Session with no engine: only the pump is replaced, so its cache and
// control lifecycle are the same code the UI uses.
const require=createRequire(new URL('../app/package.json',import.meta.url));
const reactPath=require.resolve('react');
const {transformSync}=await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec,ctx,next){
    if(spec==='@tauri-apps/api/core')return {url:'data:text/javascript,export async function invoke(){return {};}',shortCircuit:true};
    if(spec==='react')return next(reactPath,ctx);
    if(spec.startsWith('./')||spec.startsWith('../'))for(const ext of ['.ts','.tsx']){
      const url=new URL(spec+ext,ctx.parentURL);if(existsSync(url))return next(url.href,ctx);
    }
    return next(spec,ctx);
  },
  load(url,ctx,next){
    if(!url.startsWith('file:')||!/\.tsx?$/.test(url))return next(url,ctx);
    const path=fileURLToPath(url),out=transformSync(path,readFileSync(path,'utf8'),{jsx:{runtime:'automatic'}});
    if(out.errors?.length)throw Error(JSON.stringify(out.errors));
    return {format:'module',source:out.code,shortCircuit:true};
  },
});
globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
globalThis.window=globalThis;
let nextFrame=0;
const animationFrames=new Map();
globalThis.requestAnimationFrame=callback=>{const id=++nextFrame;animationFrames.set(id,callback);return id;};
globalThis.cancelAnimationFrame=id=>animationFrames.delete(id);
function displayFrame() {
  const callbacks=[...animationFrames.values()];animationFrames.clear();
  for(const callback of callbacks)callback(performance.now());
}
test.afterEach(()=>{assert.equal(animationFrames.size,0,'test left a queued preview');});
const {Session}=await import('../app/src/session.ts');
const full={width:1,height:1,scale:1,x:0,y:0};
for (const change of ['pan','resize','release']) test(`ordinary in-flight preview is discarded after ${change}`,async()=>{
  let view={...full,draft:true},finish,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const shown=[],errors=[];
  const s=new Session(()=>({...view}),f=>shown.push(f),e=>errors.push(e));
  s.cachedDetailPreview=()=>false;
  let renders=0;
  s.renderView=async requested=>{
    if(++renders===1){started();await new Promise(resolve=>{finish=resolve;});}
    return {width:1,height:1,fullWidth:1,fullHeight:1,x:0,y:0,view:requested,
      pixels:pixels(10,20,30,255),ms:1,hash:BigInt(renders)};
  };
  s.requestRender();await ready;
  view=change==='pan'?{...view,x:1}:change==='resize'?{...view,width:2}:{...view,draft:false};
  s.requestRender();finish();
  for(let i=0;i<100&&!s.idle;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.deepEqual(errors,[]);assert.equal(s.idle,true);
  assert.equal(shown.length,1);assert.deepEqual(shown[0].view,view);
});
function session(){
  const shown=[],active=[];let pumping=0;
  const s=new Session(()=>({...full,draft:true}),f=>shown.push(f),e=>{throw Error(e);});
  s.pump=async()=>{pumping++;};s.values={texture:0,exposure:0};
  s.fullView=()=>full;s.cachedDetailPreview=()=>true;s.onDetailControl=id=>active.push(id);
  return {s,shown,active,pumping:()=>pumping};
}
test('cached feedback still schedules native work; Exposure is eligible without a loupe',()=>{
  const {s,shown,pumping}=session();
  s.set('texture',10);
  const frame={...full,view:full,pixels:pixels(20,40,60,255)};
  s.detailCache.a={frame,value:0};s.detailCache.b={frame:{...frame,pixels:pixels(40,60,80,255)},value:20};
  s.set('texture',15);displayFrame();
  assert.equal(shown.length,1);assert.equal(shown[0].view.detail,true);assert.equal(pumping(),3);assert.equal(s.pending,true);
  s.set('exposure',1);assert.equal(shown.length,1);assert.equal(s.detailCache.id,'exposure');assert.equal(s.activeDetailControl,null);
});
test('release, multi-control edits and view changes invalidate cached detail frames',()=>{
  const {s,active}=session();s.set('texture',10);assert.equal(active.at(-1),'texture');
  s.requestRender();assert.equal(s.detailCache,null);assert.equal(active.at(-1),null);
  s.set('texture',20);s.setMany([['contrast',10]]);assert.equal(s.detailCache,null);assert.equal(active.at(-1),null);
  s.set('texture',30);const cache=s.detailCache;s.fullView=()=>({...full,width:2});s.set('texture',35);
  assert.notEqual(s.detailCache,cache);assert.equal(s.detailCache.a,undefined);
});
test('loupe is ineligible for ordinary sliders even when they share a module',()=>{
  const {s}=session();s.cachedDetailPreview=()=>false;s.detailView=()=>full;
  s.set('saturation',20);assert.equal(s.draftView({...full,draft:true},['colorbalancergb']).detail,undefined);
  s.set('contrast',20);assert.equal(s.draftView({...full,draft:true},['colorbalancergb']).detail,true);
});

test('native renders train the cache and release discards it for an exact full render',async()=>{
  let dragging=true,native=0;const shown=[];
  const s=new Session(()=>({...full,draft:dragging}),f=>shown.push(f),e=>{throw Error(e);});
  s.fullView=()=>full;s.cachedDetailPreview=()=>true;s.values={texture:0};
  s.moduleEdit=op=>({op,params:{},enabled:true});s.scheduleSave=()=>{};
  const frame=(value,view)=>({width:1,height:1,fullWidth:1,fullHeight:1,x:0,y:0,view,pixels:pixels(value,40,60,255),ms:1,hash:BigInt(value+1000)});
  s.current.set(s.frameKey(full,false),frame(0,full));
  s.renderView=async view=>{native++;return frame(s.values.texture,view);};
  const settle=async()=>{for(let i=0;i<500&&!s.idle;i++){displayFrame();await new Promise(r=>setTimeout(r,1));}assert.equal(s.idle,true);};
  s.set('texture',10);await settle();assert.equal(s.detailCache.a.value,0);assert.equal(s.detailCache.b.value,10);
  s.set('texture',12);await settle();assert.equal(shown.length,3);assert.equal(native,2);
  dragging=false;s.requestRender();await settle();assert.equal(s.detailCache,null);assert.equal(shown.at(-1).view.draft,false);assert.equal(native,3);
});


test('adaptive color eligibility and normalized prediction error',()=>{
  for(const id of ['temp','tint','exposure','contrast','highlights','shadows','whites','blacks','texture','clarity','dehaze','vibrance','saturation'])assert.equal(isCachedControl(id),true);
  for(const id of ['profile','bw_mode','tc_highlights','l_exposure'])assert.equal(isCachedControl(id),false);
  assert.equal(isDetailControl('exposure'),false);
  assert.deepEqual(predictionError(pixels(0,0,0,0),pixels(0,0,0,255)),{mean:0,p95:0});
  const error=predictionError(pixels(0,0,0,255),pixels(255,0,0,255));
  assert.equal(error.mean,1/3);assert.equal(error.p95,1);
  assert.equal(predictionError(pixels(0),pixels()).mean,Infinity);
  assert.equal(anchorInterval(40,80),80);assert.equal(anchorInterval(160,80),200);
  assert.equal(anchorInterval(1000,80),320);
});

function exposureSession(renderPixels=value=>pixels(100+value*20,80,60,255)) {
  let dragging=true,native=0;
  const shown=[];
  const s=new Session(()=>({...full,draft:dragging}),f=>shown.push(f),e=>{throw Error(e);});
  s.fullView=()=>full;s.cachedDetailPreview=()=>true;s.values={exposure:0};
  s.moduleEdit=op=>({op,params:{},enabled:true});s.scheduleSave=()=>{};
  s.renderView=async view=>{native++;return {width:1,height:1,view,pixels:renderPixels(s.values.exposure),ms:1};};
  const settle=async()=>{for(let i=0;i<600&&!s.idle;i++){displayFrame();await new Promise(r=>setTimeout(r,1));}assert.equal(s.idle,true);};
  return {s,shown,settle,native:()=>native,release:()=>{dragging=false;s.requestRender();}};
}

test('Exposure estimates coalesce native work and release bypasses the timer',async()=>{
  const {s,shown,settle,native,release}=exposureSession();
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.22);s.set('exposure',0.24);
  assert.equal(native(),2);displayFrame();assert.equal(shown.at(-1).trace.estimated,true);
  assert.equal(s.idle,false);
  await settle();assert.equal(native(),3);assert.equal(s.detailCache.b.value,0.24);
  s.set('exposure',0.25);assert.equal(native(),3);
  release();await settle();assert.equal(native(),4);
  assert.equal(shown.at(-1).view.draft,false);assert.equal(s.detailCache,null);
});

test('periodic native work runs without another input and rejects inaccurate Exposure predictions',async()=>{
  const {s,shown,settle,native,release}=exposureSession(value=>pixels(value>0.2?250:100+value*20,80,60,255));
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.24);displayFrame();assert.equal(shown.at(-1).trace.estimated,true);
  await settle();assert.equal(native(),3);assert.equal(s.detailCache.blocked,true);
  const count=shown.length;s.set('exposure',0.25);
  assert.equal(shown.slice(count).some(f=>f.trace?.estimated),false);
  await settle();release();await settle();
});

test('reversals and large jumps require a fresh native anchor',async()=>{
  const {s,shown,settle,release}=exposureSession();
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const count=shown.length;s.set('exposure',0.15);await settle();
  assert.equal(shown.slice(count).some(f=>f.trace?.estimated),false);
  const next=shown.length;s.set('exposure',3);await settle();
  assert.equal(shown.slice(next).some(f=>f.trace?.estimated),false);
  release();await settle();
});


for(const gpu of [false,true]) test(`an in-flight anchor never overwrites newer Exposure feedback (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,settle,release}=exposureSession();
  if(gpu)s.onCachedPreview=preview=>{if(!preview.frame.trace?.estimated)shown.push(preview.frame);return true;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const render=s.renderView;
  let finish;
  s.renderView=async view=>{
    const frame=await render(view);
    if (!finish) await new Promise(resolve=>{finish=()=>resolve();});
    return frame;
  };
  s.detailCache.lastStart=0;
  s.set('exposure',0.22);
  for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(finish);
  s.set('exposure',0.24);const count=shown.length;
  finish();await settle();
  const newer=shown.slice(count);
  assert.equal(newer.some(f=>f.pixels[0]===104),false);
  assert.equal(newer.at(-1).pixels[0],105);
  release();await settle();
});

test('exact adaptive refresh stays on the GPU surface until release',async()=>{
  const {s,shown,settle,release}=exposureSession();
  const gpu=[];
  s.onCachedPreview=preview=>{gpu.push(preview);return true;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const count=shown.length;
  s.set('exposure',0.24);displayFrame();await settle();
  assert.equal(shown.length,count,'native refresh must not switch to the CPU canvas');
  const exact=gpu.at(-1);
  assert.equal(exact.frame.trace?.estimated,undefined);
  assert.equal(exact.a,exact.b);assert.equal(exact.mix,1);
  assert.equal(exact.frame.pixels[0],105);
  release();await settle();
  assert.equal(shown.length,count+1);assert.equal(shown.at(-1).view.draft,false);
});

for(const gpu of [false,true]) test(`release during an in-flight anchor discards it and renders the latest exact value (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,settle,release}=exposureSession();
  if(gpu)s.onCachedPreview=()=>true;
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const render=s.renderView;
  let finish;
  s.renderView=async view=>{
    const frame=await render(view);
    if (!finish) await new Promise(resolve=>{finish=()=>resolve();});
    return frame;
  };
  s.detailCache.lastStart=0;s.set('exposure',0.22);
  for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(finish);s.set('exposure',0.24);release();
  const count=shown.length;finish();await settle();
  assert.equal(shown.length,count+1);
  assert.equal(shown.at(-1).view.draft,false);
  assert.equal(shown.at(-1).pixels[0],105);
});

// Keep cache support aligned with every continuous slider in Basic.
test('every Basic slider supports adaptive caching without extending the loupe',async()=>{
  const {panels}=await import('../app/src/manifest.ts');
  const basic=panels.find(p=>p.id==='basic');
  for(const control of basic.sections.flatMap(section=>section.controls ?? [])) {
    if(control.kind==='choice')continue;
    assert.equal(isCachedControl(control.id),true,control.id);
  }
  for(const id of ['temp','tint','highlights','shadows','whites','blacks']) {
    assert.equal(isDetailControl(id),false,id);
    const {s}=session();s.values[id]=0;s.set(id,1);
    assert.equal(s.detailCache.id,id);
    assert.equal(s.activeDetailControl,null);
    s.requestRender();assert.equal(s.detailCache,null);
  }
});

test('GPU feedback passes native anchors without allocating an estimated image',()=>{
  const {s,shown,pumping}=session();
  s.set('texture',10);
  const frame={...full,view:full,pixels:pixels(20,40,60,255)};
  const a={...frame},b={...frame,pixels:pixels(40,60,80,128)};
  s.detailCache.a={frame:a,value:0};s.detailCache.b={frame:b,value:20};
  let preview;
  s.onCachedPreview=p=>{preview=p;return true;};
  s.set('texture',15);assert.equal(preview,undefined);displayFrame();
  assert.equal(preview.a,a);assert.equal(preview.b,b);assert.equal(preview.mix,0.75);
  assert.equal(preview.frame.pixels,b.pixels);
  assert.equal(preview.frame.trace.estimated,true);
  assert.equal(preview.frame.view.draft,true);
  assert.equal(shown.length,0);assert.equal(s.detailCache.predictedValue,15);
  assert.equal(pumping(),3);assert.equal(s.pending,true);
  s.onCachedPreview=()=>false;
  s.set('texture',16);displayFrame();
  assert.deepEqual([...shown.at(-1).pixels],[36,56,76,128]);
  assert.notEqual(shown.at(-1).pixels,b.pixels);
});

test('GPU feedback retains native error rejection and exact release',async()=>{
  const {s,shown,settle,release,native}=exposureSession(value=>pixels(value>0.2?250:100+value*20,80,60,255));
  const estimates=[];s.onCachedPreview=p=>{estimates.push(p);return true;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.24);displayFrame();assert.equal(estimates.length,1);
  await settle();assert.equal(s.detailCache.blocked,true);assert.equal(native(),3);
  s.set('exposure',0.25);assert.equal(estimates.length,1);
  release();await settle();
  assert.equal(shown.at(-1).view.draft,false);assert.equal(shown.at(-1).pixels[0],250);
  assert.equal(s.detailCache,null);
});

function seededPreview(gpu=false) {
  const result=session(),estimates=[];
  const {s}=result;s.set('texture',10);
  const frame={...full,view:full,pixels:pixels(20,40,60,255)};
  s.detailCache.a={frame,value:0};
  s.detailCache.b={frame:{...frame,pixels:pixels(40,60,80,128)},value:20};
  s.onCachedPreview=preview=>{estimates.push(preview);return gpu;};
  return {...result,estimates};
}

for(const gpu of [false,true]) test(`a burst draws only the latest value per display frame (${gpu?'GPU':'CPU'})`,()=>{
  const {s,shown,estimates}=seededPreview(gpu);
  for(let i=1;i<=100;i++)s.set('texture',10+i*0.09);
  assert.equal(s.values.texture,19);
  assert.equal(animationFrames.size,1);
  assert.equal(estimates.length,0);assert.equal(shown.length,0);
  displayFrame();
  assert.equal(animationFrames.size,0);assert.equal(estimates.length,1);
  assert.equal(estimates[0].mix,0.95);assert.equal(estimates[0].frame.trace.edits,100);
  assert.equal(s.detailCache.predictedValue,19);
  assert.equal(shown.length,gpu?0:1);
  if(!gpu)assert.deepEqual([...shown[0].pixels],[39,59,79,128]);
  s.set('texture',19.1);s.set('texture',19.2);
  assert.equal(estimates.length,1);assert.equal(animationFrames.size,1);
  displayFrame();assert.equal(estimates.length,2);assert.equal(estimates[1].mix,0.96);
});

test('frame waiting preserves the latest input timestamp without blocking cheap CPU fallback',t=>{
  let now=100;t.mock.method(performance,'now',()=>now);
  const {s,shown}=seededPreview();
  s.set('texture',11);now=110;s.set('texture',15);
  now=1000;displayFrame();
  assert.equal(shown.length,1);assert.equal(shown[0].trace.inputAt,110);
  assert.equal(shown[0].trace.edits,2);assert.equal(s.detailCache.blocked,false);
});

for(const [name,invalidate] of [
  ['release',s=>s.requestRender()],
  ['multiple controls',s=>s.setMany([['contrast',10]])],
  ['another slider',s=>s.set('exposure',1)],
  ['a new viewport',s=>{s.fullView=()=>({...full,width:2});s.set('texture',16);}],
  ['a reversal',s=>s.set('texture',5)],
  ['an unsafe jump',s=>s.set('texture',90)],
  ['non-slider edits',s=>s.changed()],
])test(`${name} cancels a queued preview`,()=>{
  const {s,shown,estimates}=seededPreview(true);
  s.set('texture',15);assert.equal(animationFrames.size,1);
  invalidate(s);assert.equal(animationFrames.size,0);
  displayFrame();assert.equal(estimates.length,0);assert.equal(shown.length,0);
});

for(const [name,invalidate] of [
  ['view moved',s=>{s.fullView=()=>({...full,x:1});}],
  ['caching disabled',s=>{s.cachedDetailPreview=()=>false;}],
  ['prediction rejected',s=>{s.detailCache.blocked=true;}],
  ['native value already shown',s=>{s.detailCache.b.value=15;}],
])test(`queued preview rechecks ${name} before drawing`,()=>{
  const {s,shown,estimates}=seededPreview(true);
  s.set('texture',15);invalidate(s);displayFrame();
  assert.equal(estimates.length,0);assert.equal(shown.length,0);
});

test('a paused display does not prevent periodic native refresh',async()=>{
  const {s,shown,native,settle,release}=exposureSession();
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.24);
  assert.equal(animationFrames.size,1);assert.equal(native(),2);
  // deliberately do not run any animation callbacks while the anchor timer runs
  for(let i=0;i<300&&native()===2;i++)await new Promise(r=>setTimeout(r,1));
  assert.equal(native(),3);
  await new Promise(r=>setTimeout(r,1));
  assert.equal(shown.at(-1).trace?.estimated,undefined);
  const count=shown.length;displayFrame();
  assert.equal(shown.length,count,'queued estimate replaced a newer native frame');
  release();await settle();assert.equal(shown.at(-1).view.draft,false);
});

for(const gpu of [false,true])test(`release before the display callback renders exactly without a draft (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,native,settle,release}=exposureSession();
  const estimates=[];s.onCachedPreview=p=>{estimates.push(p);return gpu;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const count=shown.length;
  s.set('exposure',0.22);s.set('exposure',0.24);
  assert.equal(native(),2);assert.equal(animationFrames.size,1);
  release();assert.equal(animationFrames.size,0);
  await settle();displayFrame();
  assert.equal(native(),3);assert.equal(shown.length,count+1);
  assert.equal(shown.at(-1).view.draft,false);assert.equal(shown.at(-1).pixels[0],105);
  assert.equal(estimates.length,0);
});

test('an expensive fallback resumes native work immediately',t=>{
  let now=100;t.mock.method(performance,'now',()=>now);
  const {s,shown,pumping}=seededPreview();
  s.onCachedPreview=()=>{now+=1000;return false;};
  s.set('texture',15);const before=pumping();displayFrame();
  assert.equal(s.detailCache.blocked,true);assert.equal(shown.length,0);
  assert.equal(pumping(),before+1);
});

for(const gpu of [false,true])test(`an anchor completing before the display callback cannot paint an old value (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,settle,release}=exposureSession();
  const estimates=[];s.onCachedPreview=p=>{estimates.push(p);return gpu;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  const previous=s.detailCache.b.frame,render=s.renderView;
  let finish;
  s.renderView=async view=>{
    const frame=await render(view);
    if(!finish)await new Promise(resolve=>{finish=resolve;});
    return frame;
  };
  s.detailCache.lastStart=0;s.set('exposure',0.22);
  for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(finish);s.set('exposure',0.225);
  const count=shown.length;finish();
  await new Promise(r=>setTimeout(r,1));
  assert.equal(shown.length,count,'an old anchor painted while a newer value awaited display');
  assert.equal(estimates.length,0);
  assert.equal(s.detailCache.b.value,0.22);
  displayFrame();assert.equal(estimates.length,1);
  assert.equal(estimates[0].a,previous);assert.equal(estimates[0].b,s.detailCache.b.frame);
  assert.ok(Math.abs(estimates[0].mix-1.25)<1e-9);
  release();await settle();assert.equal(shown.at(-1).view.draft,false);
});


test('accuracy lengthens reliable intervals, shortens risky intervals and preserves bounds',()=>{
  const state=predictionAccuracy();
  const interval=()=>anchorInterval(80,80,state.factor);
  assert.equal(interval(),100);
  for(let i=0;i<4;i++)validatePrediction(state,{mean:0,p95:0});
  assert.equal(interval(),200);
  validatePrediction(state,{mean:0.015,p95:0.04});
  assert.equal(interval(),100);
  validatePrediction(state,{mean:0.019,p95:0.05});
  assert.equal(interval(),50);
  assert.equal(anchorInterval(1,1,0.5),40);
  assert.equal(anchorInterval(1000,1000,2),320);
  for(const error of [{mean:Infinity,p95:0},{mean:0,p95:NaN}]) {
    assert.equal(validatePrediction(state,error),false);
    assert.equal(state.recovering,true);
  }
});

for(const gpu of [false,true]) test(`failed predictions retrain privately and recover within the same drag (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,settle,release}=exposureSession(v=>pixels(v>0.2?200:100,80,60,255));
  const estimates=[];
  if(gpu)s.onCachedPreview=p=>{estimates.push(p);return true;};
  const count=()=>gpu?estimates.length:shown.filter(f=>f.trace?.estimated).length;
  for(const v of [0.1,0.2,0.24]){s.set('exposure',v);await settle();}
  const cache=s.detailCache;
  assert.equal(cache.blocked,true);assert.equal(cache.a,undefined);
  assert.equal(cache.b.value,0.24);assert.equal(cache.accuracy.failures,1);
  const before=count();
  for(const v of [0.25,0.26]){s.set('exposure',v);await settle();assert.equal(cache.blocked,true);}
  assert.equal(cache.accuracy.good,1);
  s.set('exposure',0.27);await settle();
  assert.equal(cache.blocked,false);assert.equal(count(),before);
  s.set('exposure',0.274);displayFrame();assert.equal(count(),before+1);
  await settle();release();await settle();
  assert.equal(s.detailCache,null);assert.equal(shown.at(-1).view.draft,false);
});

test('repeated inaccurate recovery checks stop retries for the drag',async()=>{
  let bright=false;
  const {s,shown,settle,release}=exposureSession(()=>pixels(bright?240:20,80,60,255));
  for(const v of [0.1,0.2]){s.set('exposure',v);await settle();}
  bright=true;s.set('exposure',0.24);await settle();
  for(const [base,next] of [[0.25,0.26],[0.27,0.28]]) {
    s.set('exposure',base);await settle();
    bright=!bright;s.set('exposure',next);await settle();
  }
  assert.equal(s.detailCache.accuracy.failures,3);
  const count=shown.filter(f=>f.trace?.estimated).length;
  for(const v of [0.29,0.30,0.31,0.32]){s.set('exposure',v);await settle();}
  assert.equal(s.detailCache.blocked,true);
  assert.equal(s.detailCache.accuracy.good,0);
  assert.equal(shown.filter(f=>f.trace?.estimated).length,count);
  release();await settle();
});


test('private recovery validation allows uniform native steps without widening displayed estimates',()=>{
  const a={value:0,pixels:pixels(10,20,30,255)},b={value:1,pixels:pixels(20,30,40,255)};
  assert.equal(interpolateDetail(a,b,2,100),null);
  assert.deepEqual([...interpolateDetail(a,b,2,100,true)],[30,40,50,255]);
  assert.equal(interpolateDetail(a,b,3,100,true),null);
});

test('native timer applies accuracy factor and refreshes without more input',async()=>{
  const {s,settle,native,release}=exposureSession();
  for(const v of [0.1,0.2]){s.set('exposure',v);await settle();}
  const cache=s.detailCache;
  cache.nativeMs=80;cache.accuracy.factor=2;cache.lastStart=performance.now();
  s.set('exposure',0.24);displayFrame();
  await new Promise(r=>setTimeout(r,100));assert.equal(native(),2);
  await settle();assert.equal(native(),3);
  assert.equal(cache.accuracy.factor,2);
  cache.nativeMs=80;cache.accuracy.factor=0.5;cache.lastStart=performance.now();
  s.set('exposure',0.25);displayFrame();
  await new Promise(r=>setTimeout(r,80));assert.equal(native(),4);
  await settle();release();await settle();
});

for(const gpu of [false,true]) test(`accuracy failure cancels estimates while native updates keep advancing (${gpu?'GPU':'CPU'})`,async()=>{
  const {s,shown,settle,release}=exposureSession(v=>pixels(v>0.2?200:100,80,60,255));
  if(gpu)s.onCachedPreview=()=>true;
  for(const v of [0.1,0.2]){s.set('exposure',v);await settle();}
  const render=s.renderView;let finish;
  s.renderView=async view=>{
    const f=await render(view);
    if(!finish)await new Promise(resolve=>{finish=resolve;});
    return f;
  };
  s.detailCache.lastStart=0;s.set('exposure',0.24);
  for(let i=0;i<100&&!finish;i++)await new Promise(r=>setTimeout(r,1));
  assert.ok(finish);
  s.set('exposure',0.25);const count=shown.length;
  finish();
  for(let i=0;i<100&&!s.detailCache.blocked;i++)await new Promise(r=>setTimeout(r,1));
  await settle();
  assert.equal(s.detailCache.blocked,true);
  assert.equal(s.detailCache.b.value,0.25);
  assert.equal(shown.slice(count).some(f=>f.trace?.estimated),false);
  assert.equal(shown.slice(count).length,2);
  release();await settle();
});

for(const blocked of [false,true]) test(`continuous dragging keeps native feedback when ${blocked?'accuracy blocked the cache':'movement exceeds estimation bounds'}`,async()=>{
  const {s,shown,settle,release}=exposureSession();
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.detailCache.blocked=blocked;
  const render=s.renderView,finishes=[];
  s.renderView=async view=>{
    const frame=await render(view);
    await new Promise(resolve=>finishes.push(resolve));
    return frame;
  };
  const waitForRender=async()=>{
    for(let i=0;i<100&&!finishes.length;i++)await new Promise(r=>setTimeout(r,1));
    assert.ok(finishes.length,'native render did not start');
  };
  s.set('exposure',1);
  for(const next of [2,3,4]) {
    await waitForRender();
    const count=shown.length;
    // Another input always arrives before the current native render finishes.
    // No estimate can be shown for these widely spaced values.
    s.set('exposure',next);
    assert.equal(animationFrames.size,0);
    finishes.shift()();
    await waitForRender();
    assert.equal(shown.length,count+1,'drag froze while waiting for an exact latest value');
    assert.equal(shown.at(-1).pixels[0],100+(next-1)*20);
  }
  // Stop holding renders, then release: the final image is still exact.
  s.renderView=render;
  release();finishes.shift()();await settle();
  assert.equal(shown.at(-1).view.draft,false);
  assert.equal(shown.at(-1).pixels[0],180);
});
