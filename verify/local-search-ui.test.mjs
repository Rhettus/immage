// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const root=new URL('../app/src/',import.meta.url);
const files=['immich.ts','localSearch.ts','ImmichPanel.tsx'].map(f=>new URL(f,root).href);
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
const mocks={
 './commands':'export const commands=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.__searchUI.commands[k](...a)});',
 './settings':'export const settings={get:()=>null,set:()=>{}};',
 './tunerWorkload':'export const timeTunerWork=(_,f)=>f();',
 '@immporter/api':'export const api={};',
 react:'export const useState=v=>[v,()=>{}];export const useEffect=f=>globalThis.__searchUI.effects.push(f);',
 './Collapse':'export const Chevron="chevron",Collapse="collapse";',
};
registerHooks({resolve(s,c,next){if(files.includes(c.parentURL)){if(mocks[s])return{url:data(mocks[s]),shortCircuit:true};if(s==='./immich')return{url:files[0],shortCircuit:true};}return next(s,c);},load(u,c,next){if(!files.includes(u))return next(u,c);return{format:'module',source:transformSync(fileURLToPath(u),readFileSync(fileURLToPath(u),'utf8'),{jsx:{runtime:'automatic'}}).code,shortCircuit:true};}});
const {NO_SEARCH,nativeSearchArgs}=await import(files[0]);
const {localSearch,similarSearch}=await import(files[1]);
const {ImmichPanel}=await import(files[2]);
const nodes=t=>Array.isArray(t)?t.flatMap(nodes):!t||typeof t!=='object'?[]:[t,...nodes(t.props?.children)];
test('native Immich arguments exclude local controls',()=>{
 const args=nativeSearchArgs({...NO_SEARCH,source:'both',scope:'folder',subject:'edited'},'cursor');
 assert.equal(args.next,'cursor');for(const key of ['source','scope','subject'])assert.equal(key in args,false);
});
test('local panel works without server calls and carries exact query placeholder',()=>{
 const calls=[],effects=[];globalThis.__searchUI={commands:new Proxy({}, {get:(_,k)=>()=>{calls.push(k);return Promise.resolve([]);}}),effects};
 const tree=ImmichPanel({open:true,onToggle(){},active:false,searching:false,form:NO_SEARCH,onChange(){},onSearch(){},onMenu(){}});
 for(const effect of effects)effect();assert.deepEqual(calls,[]);
 assert.ok(nodes(tree).some(n=>n.type==='input'&&n.props.placeholder==='sunset on a beach'));
 assert.ok(nodes(tree).some(n=>n.type==='select'&&n.props['aria-label']==='Local search scope'));
});
test('local adapter carries filters, scope and cache identities',async()=>{
 const calls=[];globalThis.__searchUI={commands:{async localSearch(...args){calls.push(args);return{items:[{asset_id:'12',variant_id:'23',subject:'original',image:{imgid:42,path:'/photos/a.jpg'}}],next:'more'};}}};
 const signal=new AbortController().signal;
 const result=await localSearch({...NO_SEARCH,scope:'folder'}, {minRating:3},'/photos',true,null,signal);
 assert.equal(calls[0][0].folder,'/photos');assert.equal(calls[0][0].recursive,true);assert.deepEqual(calls[0][0].filters,{minRating:3});
 assert.deepEqual(result.items[0].localIndex,{assetId:'12',variantId:'23',subject:'original'});
 assert.equal(result.next,'more');
});
test('abort invokes native cancellation and rejects late local replies',async()=>{
 let finish;const cancelled=[];globalThis.__searchUI={commands:{localSearch:()=>new Promise(r=>finish=r),async localSearchCancel(id){cancelled.push(id);}}};
 const controller=new AbortController();const pending=localSearch(NO_SEARCH,{},'',false,null,controller.signal);
 controller.abort();finish({items:[],next:null});await assert.rejects(pending,/cancelled/);assert.equal(cancelled.length,1);
});

test('similar photo query selects local all-roots while retaining filter fields',async()=>{
 const form={...NO_SEARCH,source:'both',scope:'folder',text:'old text',mode:'filename',favorites:true,minRating:4};
 const q=similarSearch(form);assert.equal(q.source,'local');assert.equal(q.scope,'library');assert.equal(q.text,'');assert.equal(q.mode,'smart');assert.equal(q.favorites,true);assert.equal(q.minRating,4);
 let sent;globalThis.__searchUI={commands:{async localSearch(args){sent=args;return{items:[],next:null};}}};
 await localSearch(q,{labels:2},'/photos',false,null,new AbortController().signal,'123');
 assert.equal(sent.imageVariant,'123');assert.equal(sent.text,'');assert.equal(sent.scope,'library');assert.deepEqual(sent.filters,{labels:2});
});
