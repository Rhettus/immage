// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isDetailControl } from '../app/src/detailPreview.ts';
const pixels=(...values)=>new Uint8ClampedArray(values);

test('detail eligibility excludes Exposure and other tone controls',()=>{
  for(const id of ['texture','clarity','dehaze','sharp_amount','detail_texture_gain_fine','l_detail_clarity_halo_control'])assert.equal(isDetailControl(id),true,id);
  for(const id of ['contrast','l_contrast','exposure','highlights','shadows','temp','saturation','l_exposure'])assert.equal(isDetailControl(id),false,id);
});

// Exercise native preview scheduling and detail-control lifecycle without an engine.
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
test.afterEach(()=>{assert.equal(animationFrames.size,0,'test left a queued preview');});
const {Session}=await import('../app/src/session.ts');
const full={width:1,height:1,scale:1,x:0,y:0};
for (const change of ['pan','resize','release']) test(`ordinary in-flight preview is discarded after ${change}`,async()=>{
  let view={...full,draft:true},finish,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const shown=[],errors=[];
  const s=new Session(()=>({...view}),f=>shown.push(f),e=>errors.push(e));
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
  s.onDetailControl=id=>active.push(id);
  return {s,shown,active,pumping:()=>pumping};
}
test('loupe is ineligible for ordinary sliders even when they share a module',()=>{
  const {s}=session();s.detailView=()=>full;
  s.set('saturation',20);assert.equal(s.draftView({...full,draft:true},['colorbalancergb']).detail,undefined);
  for(const id of ['contrast','l_contrast']) {
    s.set(id,20);
    assert.equal(s.activeDetailControl,null);
    assert.equal(s.draftView({...full,draft:true},['colorbalancergb']).detail,undefined);
  }
});

test('detail drags start in the loupe without full-size probe frames',()=>{
  const {s}=session();
  s.detailView=()=>({width:480,height:480,scale:0.4,x:120,y:60});
  s.set('texture',20);
  for(let i=0;i<3;i++) {
    const view=s.draftView({width:1200,height:900,draft:true},['diffuse']);
    assert.deepEqual(view,{width:480,height:480,scale:0.4,x:120,y:60,draft:true,detail:true,loupe:true});
    s.draftTimed({view,ms:300},1);
  }
  const release={width:2400,height:1800};
  assert.equal(s.draftView(release,[]),release);
});

test('grain uses native loupe feedback',()=>{
  const {s}=session();s.values.grain_amount=0;s.values.grain_size=25;
  s.detailView=()=>({width:480,height:480,scale:0.4,x:0,y:0});
  for(const id of ['grain_amount','grain_size']) {
    assert.equal(isDetailControl(id),true);
    s.set(id,40);
    assert.equal(s.activeDetailControl,id);
    assert.equal(s.draftView({...full,draft:true},['grain']).loupe,true);
  }
});

test('disabling the loupe keeps detail and grain at full visible resolution',()=>{
  const {s}=session();s.detailView=()=>null;
  const exact={width:2400,height:1800,scale:0.8,x:120,y:60};
  s.exactView=()=>exact;
  for(const [id,op] of [['texture','diffuse'],['sharp_amount','sharpen'],
    ['nr_luminance','denoiseprofile'],['nr_color','denoiseprofile'],['nr_detail','denoiseprofile'],
    ['l_nr_color','denoiseprofile'],['grain_amount','grain']]) {
    s.values[id]=0;s.set(id,10);
    for(let i=0;i<3;i++) {
      const view=s.draftView({width:1200,height:900,draft:true},[op]);
      assert.deepEqual(view,{...exact,draft:true,detail:true},id);
      s.draftTimed({view,ms:300},1);
    }
  }
  s.set('exposure',1);
  const ordinary={width:1200,height:900,draft:true};
  assert.equal(s.draftView(ordinary,['exposure']),ordinary);
  assert.equal(s.draftView(exact,[]),exact,'release uses the ordinary exact view');
});

for (const mode of ['idle', 'disabled', 'moved']) test(`persistent loupe request: ${mode}`, async()=>{
  let view=mode==='disabled'?null:{...full};
  const shown=[],errors=[],rendered=[];
  const s=new Session(()=>full,f=>shown.push(f),e=>errors.push(e));
  s.detailView=()=>view;
  s.idleRender=async(requested,every,use)=>{
    rendered.push(requested);
    assert.equal(every,true);
    if(mode==='moved')view={...full,x:10};
    use({view:requested});
  };
  s.requestLoupe();
  for(let i=0;i<100&&!s.idle;i++)await new Promise(resolve=>setTimeout(resolve,1));
  assert.deepEqual(errors,[]);
  assert.equal(s.idle,true);
  assert.equal(rendered.length,mode==='disabled'?0:1);
  assert.equal(shown.length,mode==='idle'?1:0);
  if(mode==='idle')assert.deepEqual(shown[0].view,{...full,detail:true,loupe:true});
});

test('module preferences refresh unused tools and preserve global and masked edits', () => {
  const storage = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => key.endsWith('.mode') ? 'custom'
    : key.endsWith('.choices') ? '{"clarity":1,"texture":1}' : null };
  try {
    const s = Object.create(Session.prototype);
    s.values = { mod_clarity: 0, mod_texture: 0, clarity: 0, texture: 0 };
    s.neutral = { clarity: 0, texture: 0 };
    s.foreign = new Set(); s.maskOps = new Map();
    s.set = (id, value) => { s.values[id] = value; };
    let updates = 0; s.onModules = () => updates++;
    s.refreshModuleChoices();
    assert.equal(s.values.mod_clarity, 1); assert.equal(s.values.mod_texture, 1);
    assert.equal(updates, 1);
    s.values = { mod_clarity: 0, mod_texture: 0, clarity: 20, texture: 0 };
    s.maskOps.set('mask1', new Set(['diffuse']));
    s.refreshModuleChoices();
    assert.equal(s.values.mod_clarity, 0); assert.equal(s.values.clarity, 20);
    assert.equal(s.values.mod_texture, 0);
  } finally { globalThis.localStorage = storage; }
});
