// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,registerHooks} from 'node:module';
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const root=new URL('../app/src/',import.meta.url);
const data=s=>'data:text/javascript,'+encodeURIComponent(s);
const en=JSON.parse(readFileSync(new URL('../app/src/locales/en.json',import.meta.url),'utf8'));
const i18nMock=`const d=${JSON.stringify(en)};export const t=(k,v)=>Object.entries(v||{}).reduce((s,[n,x])=>s.replaceAll('{'+n+'}',String(x)),d[k]??k);export const formatNumber=n=>String(n);export const formatDate=d=>String(d);`;
const mocks={
 './commands':'export const commands=new Proxy({}, {get:(_,k)=>(...a)=>globalThis.__searchUI.commands[k](...a)});',
 './settings':'export const settings={get:()=>null,set:()=>{}};',
 './tunerWorkload':'export const timeTunerWork=(_,f)=>f();',
 '@immporter/api':'export const api={};',
 // FindPanel's hooks run as plain calls: state is its initial value, effects are collected for the test to run
 react:'export const useState=v=>[typeof v==="function"?v():v,()=>{}];export const useEffect=f=>globalThis.__searchUI.effects.push(f);export const useLayoutEffect=useEffect;export const useRef=v=>({current:v});export const useMemo=f=>f();export const useCallback=f=>f;export const useId=()=>"id";',
 'react-dom':'export const createPortal=c=>c;',
 './icons':'export const StarIcon="star";',
 './AnalysisStatus':'export const AnalysisStatus=()=>null;',
 './library':'export const LABEL_COLORS=["#f00","#ff0","#0f0","#00f","#a0f"];export const fileKind=()=>"";export const fileExt=()=>"";export const kindsInclude=()=>true;export const takenAt=()=>0;',
 './exportTokens':'export const shutter=v=>String(v);',
 './i18n':i18nMock,
};
const sources=new Set();
const inSrc=u=>u&&u.startsWith(root.href)&&/\.tsx?$/.test(u);
registerHooks({resolve(s,c,next){
 if(inSrc(c.parentURL)){
  if(mocks[s])return{url:data(mocks[s]),shortCircuit:true};
  if(s.startsWith('./'))for(const ext of['.ts','.tsx']){const url=new URL(s+ext,c.parentURL);if(existsSync(url)){sources.add(url.href);return{url:url.href,shortCircuit:true};}}
 }
 return next(s,c);},
 load(u,c,next){if(!sources.has(u))return next(u,c);return{format:'module',source:transformSync(fileURLToPath(u),readFileSync(fileURLToPath(u),'utf8'),{jsx:{runtime:'automatic'}}).code,shortCircuit:true};}});
const files=['immich.ts','localSearch.ts','FindPanel.tsx'].map(f=>{const u=new URL(f,root).href;sources.add(u);return u;});
const {NO_SEARCH,nativeSearchArgs}=await import(files[0]);
const {localSearch,similarSearch}=await import(files[1]);
const {FindPanel}=await import(files[2]);
const {NO_FIND}=await import(new URL('findModel.ts',root).href);
const nodes=t=>Array.isArray(t)?t.flatMap(nodes):!t||typeof t!=='object'?[]:[t,...nodes(t.props?.children)];
test('native Immich arguments exclude local controls',()=>{
 const args=nativeSearchArgs({...NO_SEARCH,source:'both',scope:'folder',subject:'edited'},'cursor');
 assert.equal(args.next,'cursor');for(const key of ['source','scope','subject'])assert.equal(key in args,false);
});
test('Find with Immich unavailable works without server calls and carries exact query placeholder',()=>{
 const calls=[],effects=[];globalThis.__searchUI={commands:new Proxy({}, {get:(_,k)=>()=>{calls.push(k);return Promise.resolve([]);}}),effects};
 const listeners=[];
 globalThis.document={dir:'ltr',querySelector:()=>null};
 globalThis.window={innerWidth:1200,innerHeight:800,addEventListener:(...a)=>listeners.push(a),removeEventListener(){}};
 const tree=FindPanel({state:{...NO_FIND,search:{...NO_FIND.search,source:'immich'}},onChange(){},images:[],immichAvailable:false,smart:true,count:0,busy:false,notes:[],
  onShow(){},onClose(){},anchor:()=>undefined,bounds:()=>({left:0,right:1200,top:0,bottom:700})});
 for(const effect of effects)effect();assert.deepEqual(calls.filter(k=>/^immich/.test(k)),[]);
 assert.ok(nodes(tree).some(n=>n.type==='input'&&String(n.props.className).includes('find-text')&&n.props.placeholder==='sunset on a beach'));
});
test('Find without the CLIP model or Immich offers file names only',()=>{
 const effects=[];globalThis.__searchUI={commands:new Proxy({}, {get:()=>()=>Promise.resolve([])}),effects};
 globalThis.document={dir:'ltr',querySelector:()=>null};
 globalThis.window={innerWidth:1200,innerHeight:800,addEventListener(){},removeEventListener(){}};
 const tree=FindPanel({state:NO_FIND,onChange(){},images:[],immichAvailable:false,smart:false,count:0,busy:false,notes:[],
  onShow(){},onClose(){},anchor:()=>undefined,bounds:()=>({left:0,right:1200,top:0,bottom:700})});
 const all=nodes(tree);
 const smartButton=all.find(n=>n.type==='button'&&n.props['aria-disabled']==='true');
 assert.ok(smartButton,'Smart stays, aria-disabled');
 assert.ok(!smartButton.props.disabled,'Smart is not the disabled attribute, so its tooltip works');
 const filenameButton=all.find(n=>n.type==='button'&&n.props.className==='active'&&n.props['aria-pressed']===true);
 assert.ok(filenameButton,'Filename shows as active');
 const box=all.find(n=>n.type==='input'&&String(n.props.className).includes('find-text'));
 assert.ok(box&&box.props.placeholder!=='sunset on a beach','the box says it searches file names');
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

test('local queries wait for pending metadata saves and cancellation prevents a delayed native query',async()=>{
 let release;const saved=new Promise(r=>release=r);const calls=[];
 globalThis.__searchUI={commands:{async localSearch(args){calls.push(args);return{items:[],next:null};}}};
 const controller=new AbortController();
 const pending=localSearch(NO_SEARCH,{},'/photos',false,null,controller.signal,undefined,[saved]);
 assert.equal(calls.length,0);release();await pending;assert.equal(calls.length,1);
 let finish;const anotherSave=new Promise(r=>finish=r);const stopped=new AbortController();
 const cancelled=localSearch(NO_SEARCH,{},'/photos',false,null,stopped.signal,undefined,[anotherSave]);
 stopped.abort();finish();await assert.rejects(cancelled,/cancelled/);assert.equal(calls.length,1);
});
