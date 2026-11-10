// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const data=source=>'data:text/javascript,'+encodeURIComponent(source);
registerHooks({
  resolve(spec,ctx,next) {
    if(spec==='@tauri-apps/api/core')return {url:data('export const invoke=(...args)=>globalThis.aiInvoke(...args)'),shortCircuit:true};
    if(ctx.parentURL?.endsWith('/batchPaste.ts')&&spec==='./session')return {url:data('export class Session {}; export const instanceKey=()=>{}, mapOpOf=()=>{};'),shortCircuit:true};
    if(spec==='./manifest')return {url:data('export const CONVERSIONS=[], LOCAL_CONTROLS=[];'),shortCircuit:true};
    if(spec.startsWith('.')&&!/\.[jt]sx?$/.test(spec))for(const ext of ['.ts','.tsx']) {
      const u=new URL(spec+ext,ctx.parentURL);if(existsSync(fileURLToPath(u)))return next(u.href,ctx);
    }
    return next(spec,ctx);
  },
  load(url,ctx,next) {
    if(!url.startsWith('file:')||!url.endsWith('.ts'))return next(url,ctx);
    return {format:'module',source:transformSync(fileURLToPath(url),readFileSync(fileURLToPath(url),'utf8')).code,shortCircuit:true};
  }
});
const {recalculateAiMasks,validateAiPaste}=await import('../app/src/batchPaste.ts');
const paths=[{hole:false,points:[[0,0,0,0,0,0],[1,0,1,0,1,0],[0,1,0,1,0,1]]}];
const make=shape=>({values:{exposure:1},masks:[{name:'renamed',invert:true,opacity:35,hidden:true,refine:{feather:22,blur:2,detail:.1,contrast:.2},values:{l_exposure:.5},shapes:[shape,{type:'gradient',x:.2,y:.3,angle:40,width:.5}]}]});

test('semantic and depth components select their own models and retain mask settings',async()=>{
  for(const kind of ['subject','sky','people','water','vegetation','mountains','ground','architecture','artificial_ground','depth']) {
    const calls=[];globalThis.aiInvoke=async(cmd,args)=>{calls.push({cmd,args});return cmd==='ai_mask'?paths:undefined;};
    const clip=make({type:'object',paths:[],mode:'subtract',feather:.03,...(kind==='depth'?{depth:[.2,.7]}:{ai:{kind,inset:false,backdrop:false}})});
    const result=await recalculateAiMasks(clip);
    const model=kind==='depth'?'mask-depth-da2-small':kind==='subject'?'mask-subject-birefnet-lite':'mask-scene-segformer-b2';
    assert.equal(calls[0].args.id,model);assert.equal(calls[1].cmd,'ai_mask');assert.equal(calls[1].args.kind,kind);
    if(kind==='depth')assert.deepEqual(calls[1].args.range,[.2,.7]);
    const expected=structuredClone(clip);expected.masks[0].shapes[0].paths=paths;assert.deepEqual(result,expected);
    assert.deepEqual(clip.masks[0].shapes[0].paths,[],'clipboard remains immutable');
  }
});
test('object prompts replay and backdrop is regenerated while its off setting survives',async()=>{
  const calls=[];const backdrop={range:[.1,.2,.3,.4],paths,plain:paths};
  globalThis.aiInvoke=async(cmd,args)=>{calls.push({cmd,args});return cmd==='ai_object'?{paths,backdrop}:undefined;};
  const ai={kind:'object',points:[[.3,.4,1],[.8,.6,0]],box:[.2,.1,.9,.8],inset:true,backdrop:true};
  const clip=make({type:'object',paths:[],ai,backdrop:{range:[0,0,0,0],paths:[],off:true}});
  const result=await recalculateAiMasks(clip);
  assert.deepEqual(calls[1],{cmd:'ai_object',args:{points:ai.points,box:ai.box,inset:true,backdrop:true}});
  assert.deepEqual(result.masks[0].shapes[0].backdrop,{...backdrop,off:true});
});
test('legacy rejection, no-op clips, empty selections and inference errors',async()=>{
  assert.throws(()=>validateAiPaste(make({type:'object',paths})),/recreate it on the source/);
  globalThis.aiInvoke=()=>{throw Error('unexpected inference');};
  assert.deepEqual(await recalculateAiMasks({values:{},masks:[]}),{values:{},masks:[]});
  const clip=make({type:'object',paths,ai:{kind:'sky',inset:true,backdrop:false}});
  globalThis.aiInvoke=async cmd=>cmd==='ai_mask'?[]:undefined;
  await assert.rejects(recalculateAiMasks(clip),/renamed.*nothing found/);
  globalThis.aiInvoke=async cmd=>{if(cmd==='ai_mask')throw Error('inference failed');};
  await assert.rejects(recalculateAiMasks(clip),/renamed.*inference failed/);
});
