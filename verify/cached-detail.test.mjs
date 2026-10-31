// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { interpolateDetail, isDetailControl } from '../app/src/cachedDetail.ts';
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
test('cached feedback still schedules native work; Exposure never uses it',()=>{
  const {s,shown,pumping}=session();
  s.set('texture',10);
  const frame={...full,view:full,pixels:pixels(20,40,60,255)};
  s.detailCache.a={frame,value:0};s.detailCache.b={frame:{...frame,pixels:pixels(40,60,80,255)},value:20};
  s.set('texture',15);
  assert.equal(shown.length,1);assert.equal(shown[0].view.detail,true);assert.equal(pumping(),2);assert.equal(s.pending,true);
  s.set('exposure',1);assert.equal(shown.length,1);assert.equal(s.detailCache,null);
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
  const settle=async()=>{for(let i=0;i<20&&!s.idle;i++)await new Promise(r=>setTimeout(r,1));assert.equal(s.idle,true);};
  s.set('texture',10);await settle();assert.equal(s.detailCache.a.value,0);assert.equal(s.detailCache.b.value,10);
  s.set('texture',12);await settle();assert.equal(shown.length,3);assert.equal(native,2);
  dragging=false;s.requestRender();await settle();assert.equal(s.detailCache,null);assert.equal(shown.at(-1).view.draft,false);assert.equal(native,3);
});
