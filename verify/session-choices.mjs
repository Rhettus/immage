// SPDX-License-Identifier: GPL-3.0-or-later
// Export the actual global/local manifest fields; no copied field inventory.
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Headless session orchestration using real engine snapshots; no render/UI.
const {default:assert}=await import('node:assert/strict');
globalThis.window=globalThis;
globalThis.addEventListener=()=>{};
const storage=new Map();
globalThis.localStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))};
const {Session}=await import('../app/src/session.ts');
const {perf}=await import('../app/src/perf.ts');
const {modules,MODULE_CHOICES,NEG_CHOICES,NEG_OFF,choiceCovers,controlById}=await import('../app/src/manifest.ts');
const snapshot=JSON.parse(readFileSync(process.argv[2],'utf8'));
const ctx={sensorWidth:128,sensorHeight:96,orientation:0,camera:0};
let state,edited=false;
perf.command=async command=>{
  if(command==='open_image')return {imgid:1,sensor_width:128,sensor_height:96,orientation:0,raw:false,fresh:!edited,edited,look:null};
  if(command==='get_params')return {modules:state};
  if(command==='history'||command==='spots')return [];
  throw Error(`Unexpected command ${command}`);
};
Session.prototype.loadMasks=async()=>{};
Session.prototype.requestRender=()=>{};
function reset(){
  storage.clear();
  state=Object.fromEntries(modules.map(m=>[m.op,structuredClone(snapshot[m.op.split('#')[0]])]));
  for(const info of Object.values(state))info.enabled=false;
  edited=false;
}
const open=()=>Session.open('synthetic.png',null,()=>({width:128,height:96}),()=>{},e=>{throw Error(e)});
let checks=0;
for(const c of MODULE_CHOICES)for(const option of c.options){
  reset();storage.set('immage.modules.mode','custom');storage.set('immage.modules.choices',JSON.stringify({[c.id]:option.value}));
  let s=await open();assert.equal(s.values[c.control],option.value,`fresh preference ${c.id}`);checks++;
  edited=true;s=await open();assert.equal(s.values[c.control],option.value,`unused edited preference ${c.id}`);checks++;
  // A used alternative wins over the preference on an already edited photo.
  const maps=modules.filter(m=>m.choice?.control===c.control&&m.choice.value===option.value);
  let changed=false;
  for(const m of maps){
    const values={...s.values,[c.control]:option.value};
    for(const id of choiceCovers(c)){
      if(!m.controls.includes(id)||!controlById.has(id))continue;
      const def=controlById.get(id);
      values[id]=s.neutral[id]===def.max?def.min:def.max;
    }
    const params={...state[m.op].params,...m.write(values,state[m.op].defaults,ctx)};
    const read=m.read(params,state[m.op].defaults,ctx,values);
    if(choiceCovers(c).some(id=>id in read&&Math.abs(read[id]-(s.neutral[id]??0))>1e-6)){
      state[m.op].params=params;state[m.op].enabled=true;changed=true;
    }
  }
  if(changed){
    const other=c.options.find(o=>o.value!==option.value);
    storage.set('immage.modules.choices',JSON.stringify({[c.id]:other.value}));
    s=await open();assert.equal(s.values[c.control],option.value,`used history ${c.id}/${option.value}`);checks++;
    for(const m of maps)s.foreign.add(m);
    s.chooseModules();assert.equal(s.values[c.control],other.value,`foreign excluded ${c.id}`);checks++;
    // Fresh photos obey preference even if supplied modules contain edits.
    edited=false;s=await open();assert.equal(s.values[c.control],other.value,`fresh overrides history ${c.id}`);checks++;
  }
}
reset();state.negadoctor.enabled=true;edited=true;
let s=await open();
assert.equal(s.values.neg_on,1);
for(const [id,value]of Object.entries(NEG_CHOICES)){assert.equal(s.values[id],value,id);checks++;}
for(const op of NEG_OFF)if(state[op]){assert.equal(s.moduleEdit(op).enabled,false,`negative disables ${op}`);checks++;}
reset();s=await open();
for(const [id,neutral]of Object.entries(s.neutral)){
  const c=controlById.get(id);if(!c||!Number.isFinite(neutral))continue;
  assert.equal(s.snap(id,NaN,neutral),neutral,id);
  assert.equal(s.snap(id,neutral+c.step*.49,neutral),neutral,id);checks+=2;
}
// Combined tone mapper and shared tool choices must leave exactly one mapper on.
for(const tm of [0,1])for(const contrast of MODULE_CHOICES.find(c=>c.id==='contrast').options)
for(const blacks of MODULE_CHOICES.find(c=>c.id==='blacks').options)
for(const saturation of MODULE_CHOICES.find(c=>c.id==='saturation').options){
  const values={...s.values,tm_mode:tm,mod_contrast:contrast.value,
    mod_blacks:blacks.value,mod_saturation:saturation.value,contrast:30,blacks:20,saturation:25,whites:15};
  const agx=s.moduleEdit('agx',values),sigmoid=s.moduleEdit('sigmoid',values);
  assert.equal(agx.enabled,tm===1);assert.equal(sigmoid.enabled,tm===0);
  for(const edit of [agx,sigmoid])assert.ok(Object.values(edit.params).every(Number.isFinite));
  checks+=4;
}
// Bypass wins even for modules whose keepOn would preserve enabled state.
for(const op of Object.keys(state)){
  state[op].enabled=true;s.bypassed.add(op);
  assert.equal(s.moduleEdit(op).enabled,false,`bypass ${op}`);checks++;
}
console.log(JSON.stringify({snapshot:process.argv[2],checks,scope:'session selection; synthetic PNG; rendering and masks stubbed'}));
