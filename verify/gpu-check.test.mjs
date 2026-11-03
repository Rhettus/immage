// SPDX-License-Identifier: GPL-3.0-or-later
// The GPU check's cases and verdicts against the app's real controls, without an engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
registerHooks({
  resolve(spec,ctx,next){
    // the app's packages, from its node_modules
    if(!spec.startsWith('.')&&!spec.startsWith('node:')&&!spec.startsWith('file:'))
      return next(spec,{...ctx,parentURL:new URL('../app/package.json',import.meta.url).href});
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
const {GPU_CASES,resolveCase,verdict}=await import('../app/src/gpuCheck.ts');
const {controlById,choiceShows,MODULE_CHOICES}=await import('../app/src/manifest.ts');

const choices=new Map(MODULE_CHOICES.map(c=>[c.control,c]));
const range=id=>controlById.get(id)??(choices.has(id)?{min:0,max:9}:undefined);

test('every case names real controls and choice values',()=>{
  for(const c of GPU_CASES)for(const step of c.steps){
    if(step.to!==undefined&&choices.has(step.id)){
      assert.ok(choices.get(step.id).options.some(o=>o.value===step.to),`${c.id}: ${step.id}=${step.to}`);
      continue;
    }
    assert.ok(controlById.has(step.id),`${c.id}: no control ${step.id}`);
  }
  assert.equal(new Set(GPU_CASES.map(c=>c.id)).size,GPU_CASES.length);
});

test('a choice is applied before the slider it shows',()=>{
  const r=resolveCase(GPU_CASES.find(c=>c.id==='contrastntexture-texture'),{mod_texture:0},range,choiceShows);
  assert.deepEqual(r.entries[0],['mod_texture',1]);
  assert.equal(r.entries[1][0],'detail_texture_gain_fine');
  const c=controlById.get('detail_texture_gain_fine');
  assert.ok(r.entries[1][1]>=c.min&&r.entries[1][1]<=c.max);
});

test('a slider at its end moves the other way and stays in range',()=>{
  const c=controlById.get('vig_amount');
  const r=resolveCase({id:'v',label:'v',op:'vignette',steps:[{id:'vig_amount',by:-0.15}]},{vig_amount:c.min},range,choiceShows);
  assert.ok(r.entries[0][1]>c.min&&r.entries[0][1]<=c.max,String(r.entries[0][1]));
});

test('an unknown control skips the case',()=>{
  const r=resolveCase({id:'x',label:'x',op:'',steps:[{id:'no_such_control',by:0.1}]},{},range,choiceShows);
  assert.match(r.skipped,/no control/);
});

const pass=(over={})=>({width:4,height:4,de:{mean:0,p99:0.1,max:0.5,over2:0},rgb:{},
  cpu:{ms:1,devid:-1,cl_errors:0},gpu:{ms:1,devid:0,cl_errors:0},modules:{gpu:[]},...over});

test('verdicts fail on fallback, no device or dE, and note CPU modules',()=>{
  assert.equal(verdict(pass(),'exposure').pass,true);
  assert.equal(verdict(pass({gpu:{ms:1,devid:0,cl_errors:1}}),'').pass,false);
  assert.equal(verdict(pass({gpu:{ms:1,devid:-1,cl_errors:0}}),'').pass,false);
  assert.equal(verdict(pass({de:{mean:1,p99:2.5,max:9,over2:0.02}}),'').pass,false);
  const cpu=verdict(pass({modules:{gpu:[{label:'contrastntexture',kind:'module',ms:5,gpu:false,tiled:false}]}}),'contrastntexture');
  assert.equal(cpu.pass,true);
  assert.deepEqual(cpu.notes,['contrastntexture ran on the CPU']);
});

test('a second instance of the case\'s module is noted as the module',()=>{
  const v=verdict(pass({modules:{gpu:[{label:'contrastntexture.1',kind:'module',ms:5,gpu:false,tiled:true}]}}),'contrastntexture');
  assert.deepEqual(v.notes,['contrastntexture ran on the CPU','contrastntexture was tiled']);
  assert.deepEqual(verdict(pass({modules:{gpu:[{label:'exposure.1',kind:'module',ms:1,gpu:false,tiled:false}]}}),'exposure.12').notes,[]);
});
