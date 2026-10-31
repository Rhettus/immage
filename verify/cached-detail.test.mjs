// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { interpolateDetail, isDetailControl, isCachedControl, predictionError, anchorInterval } from '../app/src/cachedDetail.ts';
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
const {Session}=await import('../app/src/session.ts');
const full={width:1,height:1,scale:1,x:0,y:0};
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
  s.set('texture',15);
  assert.equal(shown.length,1);assert.equal(shown[0].view.detail,true);assert.equal(pumping(),2);assert.equal(s.pending,true);
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
  const settle=async()=>{for(let i=0;i<500&&!s.idle;i++)await new Promise(r=>setTimeout(r,1));assert.equal(s.idle,true);};
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
  const settle=async()=>{for(let i=0;i<600&&!s.idle;i++)await new Promise(r=>setTimeout(r,1));assert.equal(s.idle,true);};
  return {s,shown,settle,native:()=>native,release:()=>{dragging=false;s.requestRender();}};
}

test('Exposure estimates coalesce native work and release bypasses the timer',async()=>{
  const {s,shown,settle,native,release}=exposureSession();
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.22);s.set('exposure',0.24);
  assert.equal(native(),2);assert.equal(shown.at(-1).trace.estimated,true);
  assert.equal(s.idle,false);
  await settle();assert.equal(native(),3);assert.equal(s.detailCache.b.value,0.24);
  s.set('exposure',0.25);assert.equal(native(),3);
  release();await settle();assert.equal(native(),4);
  assert.equal(shown.at(-1).view.draft,false);assert.equal(s.detailCache,null);
});

test('periodic native work runs without another input and rejects inaccurate Exposure predictions',async()=>{
  const {s,shown,settle,native,release}=exposureSession(value=>pixels(value>0.2?250:100+value*20,80,60,255));
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.24);assert.equal(shown.at(-1).trace.estimated,true);
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
  if(gpu)s.onCachedPreview=()=>true;
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
  s.set('texture',15);
  assert.equal(preview.a,a);assert.equal(preview.b,b);assert.equal(preview.mix,0.75);
  assert.equal(preview.frame.pixels,b.pixels);
  assert.equal(preview.frame.trace.estimated,true);
  assert.equal(preview.frame.view.draft,true);
  assert.equal(shown.length,0);assert.equal(s.detailCache.predictedValue,15);
  assert.equal(pumping(),2);assert.equal(s.pending,true);
  s.onCachedPreview=()=>false;
  s.set('texture',16);
  assert.deepEqual([...shown.at(-1).pixels],[36,56,76,128]);
  assert.notEqual(shown.at(-1).pixels,b.pixels);
});

test('GPU feedback retains native error rejection and exact release',async()=>{
  const {s,shown,settle,release,native}=exposureSession(value=>pixels(value>0.2?250:100+value*20,80,60,255));
  const estimates=[];s.onCachedPreview=p=>{estimates.push(p);return true;};
  s.set('exposure',0.1);await settle();s.set('exposure',0.2);await settle();
  s.set('exposure',0.24);assert.equal(estimates.length,1);
  await settle();assert.equal(s.detailCache.blocked,true);assert.equal(native(),3);
  s.set('exposure',0.25);assert.equal(estimates.length,1);
  release();await settle();
  assert.equal(shown.at(-1).view.draft,false);assert.equal(shown.at(-1).pixels[0],250);
  assert.equal(s.detailCache,null);
});
