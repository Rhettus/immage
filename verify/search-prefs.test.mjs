// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const source=new URL('../app/src/SearchPrefs.tsx',import.meta.url).href;
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
const en=JSON.parse(readFileSync(new URL('../app/src/locales/en.json',import.meta.url),'utf8'));
const i18nMock=data(`const d=${JSON.stringify(en)};export const t=(k,v)=>Object.entries(v||{}).reduce((s,[n,x])=>s.replaceAll('{'+n+'}',String(x)),d[k]??k);`);
registerHooks({
 resolve(spec,ctx,next){
  if(ctx.parentURL===source){
   if(spec==='react')return {url:data('export const useState=(v)=>globalThis.__searchPrefs.state(v);export const useEffect=(f)=>globalThis.__searchPrefs.effect(f);'),shortCircuit:true};
   if(spec==='./i18n')return {url:i18nMock,shortCircuit:true};
   if(spec==='./commands')return {url:data('export const commands=new Proxy({}, {get:(_,key)=>(...args)=>globalThis.__searchPrefs.commands[key](...args)});'),shortCircuit:true};
   if(spec==='./PrefsUI')return {url:data('export const PrefCard="card",PrefRow="row";'),shortCircuit:true};
  }
  return next(spec,ctx);
 },
 load(url,ctx,next){if(url!==source)return next(url,ctx);return {format:'module',source:transformSync(fileURLToPath(url),readFileSync(fileURLToPath(url),'utf8'),{jsx:{runtime:'automatic'}}).code,shortCircuit:true};}
});
const {SearchPrefs,ClipPrefs}=await import(source);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(Comp=SearchPrefs){
 const calls=[],slots=[],effects=[];let index=0,mounted=false;
 const status={counts:{assets:3,variants:4,metadata:4,analyses:0,analysed_photos:0},roots:[{path:'/photos',state:'offline',error:'unmounted'}],clip_providers:[{path:'/photos',provider:'local'},{path:'/nas',provider:'morfPhoto'}],remote_clip:true,queue:{paused:false,active:0,queued:0},model:{bytes:607974672,verified:true,downloading:false,error:null}};
 const f={calls,status,commands:{
  async searchStatus(){calls.push(['status']);return structuredClone(status);},
  async searchPause(v){calls.push(['pause',v]);status.queue.paused=v;},
  async searchCacheClear(v){calls.push(['clear',v]);},
  async searchModelDownload(v){calls.push(['download',v]);},
  async searchModelCancel(){calls.push(['cancel']);},
  async searchModelProbe(){calls.push(['probe']);return {dimensions:512,image_dimensions:512,elapsed_ms:20};}
 },state(v){const i=index++;if(!(i in slots))slots[i]=v;return [slots[i],v=>{slots[i]=v;}];},effect(fn){if(!mounted)effects.push(fn);},render(){index=0;const tree=Comp();mounted=true;return tree;},async mount(){f.render();f.cleanup=effects[0]();await tick();},cleanup(){}};
 globalThis.__searchPrefs=f;return f;
}
function nodes(tree){if(Array.isArray(tree))return tree.flatMap(nodes);if(!tree||typeof tree!=='object')return [];return [tree,...nodes(tree.props?.children)];}
function button(f,label){const result=nodes(f.render()).find(n=>n.type==='button'&&JSON.stringify(n.props.children).includes(label));assert.ok(result,label);return result.props;}
test('mount only polls status; model download requires the explicit button',async()=>{
 const f=fixture(ClipPrefs);try{await f.mount();assert.deepEqual(f.calls,[['status']]);button(f,'Download or repair').onClick();await tick();assert.ok(f.calls.some(c=>c[0]==='download'&&c[1]===true));assert.equal(f.calls.some(c=>c[0]==='probe'),false);}finally{f.cleanup();}
});
test('clear and rebuild remain distinct, and remembered pause gates the CPU check',async()=>{
 const f=fixture();try{await f.mount();button(f,'Clear').onClick();await tick();button(f,'Rebuild').onClick();await tick();assert.deepEqual(f.calls.filter(c=>c[0]==='clear'),[['clear',false],['clear',true]]);button(f,'Pause').onClick();await tick();assert.ok(f.calls.some(c=>c[0]==='pause'&&c[1]===true));button(f,'Resume').onClick();await tick();assert.ok(f.calls.some(c=>c[0]==='pause'&&c[1]===false));}finally{f.cleanup();}
 const paused=fixture(ClipPrefs);paused.status.queue.paused=true;try{await paused.mount();assert.equal(button(paused,'Check').disabled,true);}finally{paused.cleanup();}
 const c=fixture(ClipPrefs);try{await c.mount();button(c,'Check').onClick();await tick();assert.ok(c.calls.some(x=>x[0]==='probe'));assert.ok(nodes(c.render()).some(n=>n.type==='row'&&n.props.summary?.includes('512 values')));}finally{c.cleanup();}
});
test('download errors are visible and do not start inference',async()=>{
 const f=fixture(ClipPrefs);f.commands.searchModelDownload=async()=>{throw Error('download failed');};try{await f.mount();button(f,'Download or repair').onClick();await tick();assert.ok(nodes(f.render()).some(n=>n.props?.role==='alert'&&String(n.props.children).includes('download failed')));assert.equal(f.calls.some(c=>c[0]==='probe'),false);}finally{f.cleanup();}
});
test('directory status renders per-folder CLIP provider badges including remote-only roots',async()=>{
 const f=fixture(SearchPrefs);try{await f.mount();const all=nodes(f.render());const badges=all.filter(n=>typeof n.props?.className==='string'&&n.props.className.includes('cache-directory-provider')).map(n=>n.props.children);assert.deepEqual(badges,['morfPhoto','Local']);}finally{f.cleanup();}
});
