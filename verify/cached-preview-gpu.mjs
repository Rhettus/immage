// SPDX-License-Identifier: GPL-3.0-or-later
// Browser parity and texture-lifecycle checks; requires Chromium and app dependencies.
// CHROMIUM=/path/to/chromium node verify/cached-preview-gpu.mjs
// WEBKIT_MINIBROWSER=/path/to/MiniBrowser node verify/cached-preview-gpu.mjs
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const root=fileURLToPath(new URL('results/',import.meta.url));
mkdirSync(root,{recursive:true});
const profile=mkdtempSync(root+'g-');
const modules=new Map(['cachedPreviewRenderer','cachedDetail'].map(name=>{
  const path=fileURLToPath(new URL(`../app/src/${name}.ts`,import.meta.url));
  return [`/${name}.js`,transformSync(path,readFileSync(path,'utf8')).code];
}));
const {rolldown}=await import(require.resolve('rolldown'));
const sessionBundle=await rolldown({
  input:fileURLToPath(new URL('../app/src/session.ts',import.meta.url)),
  transform:{define:{'process.env.NODE_ENV':'"production"'}},
  onwarn(warning,warn){if(warning.code!=='MODULE_LEVEL_DIRECTIVE')warn(warning);},
  plugins:[{
    name:'test-engine-boundary',
    resolveId(id){if(id==='@tauri-apps/api/core')return '\0test-core';},
    load(id){if(id==='\0test-core')return 'export async function invoke(){throw Error("unexpected engine call");}';},
  }],
});
try {
  const {output}=await sessionBundle.generate({format:'es'});
  modules.set('/session.js',output.find(chunk=>chunk.type==='chunk'&&chunk.isEntry).code);
} finally {await sessionBundle.close();}
async function check() {
  const {CachedPreviewRenderer}=await import('/cachedPreviewRenderer.js');
  const {mixDetailPixels}=await import('/cachedDetail.js');
  const assert=(ok,message)=>{if(!ok)throw Error(message);};
  const canvas=document.createElement('canvas');document.body.append(canvas);
  let lost=0;
  const renderer=new CachedPreviewRenderer(canvas,()=>lost++);
  const frame=(width,height,pixels)=>({width,height,pixels});
  const a=frame(3,2,new Uint8ClampedArray([
    0,20,255,255, 200,80,70,255, 3,17,50,255,
    90,150,240,255, 255,0,80,255, 100,110,120,255,
  ]));
  const b=frame(3,2,new Uint8ClampedArray([
    255,60,0,255, 20,90,250,128, 100,20,80,0,
    100,180,250,200, 0,255,80,255, 120,90,255,255,
  ]));
  const off={low:false,high:false};
  let cases=0,worst=0;
  function parity(a,b,mix,clipping=off) {
    assert(renderer.draw({a,b,mix},clipping),'GPU draw rejected');
    const gl=canvas.getContext('webgl');
    const actual=new Uint8Array(b.pixels.length);
    // test-only readback, immediately after drawing, before browser buffer discard
    gl.readPixels(0,0,b.width,b.height,gl.RGBA,gl.UNSIGNED_BYTE,actual);
    const expected=mixDetailPixels(a.pixels,b.pixels,mix);
    for(let y=0;y<b.height;y++)for(let x=0;x<b.width;x++) {
      const i=4*(y*b.width+x),j=4*((b.height-1-y)*b.width+x);
      const rgb=[...expected.slice(i,i+3)];
      if(clipping.high&&rgb.includes(255))expected.set([255,0,0,255],i);
      else if(clipping.low&&rgb.includes(0))expected.set([0,64,255,255],i);
      for(let c=0;c<4;c++) {
        const error=Math.abs(actual[j+c]-expected[i+c]);worst=Math.max(worst,error);
        assert(error<=1,`pixel mismatch: mix ${mix}, pixel ${i/4}, channel ${c}: ${actual[j+c]} vs ${expected[i+c]}`);
      }
    }
    cases++;
  }
  for(const mix of [-0.5,0,0.25,0.5,0.75,1,1.5])parity(a,b,mix);
  assert(renderer.stats.uploads===2,'slider changes re-uploaded anchors');
  for(const clipping of [{low:true,high:false},{low:false,high:true},{low:true,high:true}])parity(a,b,0,clipping);
  assert(renderer.redraw(off),'clipping redraw failed');
  assert(renderer.stats.uploads===2,'clipping re-uploaded anchors');
  const halfA=frame(1,1,new Uint8ClampedArray([254,0,0,255]));
  const halfB=frame(1,1,new Uint8ClampedArray([255,1,1,255]));
  parity(halfA,halfB,0.5,{low:true,high:true});
  // restore the pair before checking the B-to-A transition
  parity(a,b,0.5);
  let before=renderer.stats.uploads;
  parity(b,b,1); // exact native refresh must retain A for the next estimate
  parity(a,b,0.75);
  assert(renderer.stats.uploads===before,'exact refresh retired a reusable anchor');
  const c={...b,pixels:new Uint8ClampedArray(b.pixels).fill(120)};
  parity(c,c,1); // train the next native anchor before estimating from B and C
  assert(renderer.stats.uploads===before+1,'exact refresh uploaded more than its new frame');
  parity(b,c,0.5);
  assert(renderer.stats.uploads===before+1,'next estimate re-uploaded the retained B');
  parity(c,b,0.25); // requested anchors must survive even when bound second
  assert(renderer.stats.uploads===before+1,'reversed pair re-uploaded anchors');
  before=renderer.stats.uploads;
  parity(a,c,0.5);
  assert(renderer.stats.uploads===before+1,'evicted A was not uploaded again');
  assert(renderer.stats.textureBytes===a.pixels.byteLength*2,'texture budget grew');
  assert(!renderer.draw({a,b:{...b,width:2},mix:0.5},off),'mismatched dimensions accepted');
  assert(!renderer.draw({a,b,mix:Infinity},off),'nonfinite mix accepted');
  const maxWidth=canvas.getContext('webgl').getParameter(canvas.getContext('webgl').MAX_TEXTURE_SIZE);
  const oversized=frame(maxWidth+1,1,new Uint8ClampedArray((maxWidth+1)*4));
  assert(!renderer.draw({a:oversized,b:oversized,mix:0.5},off),'oversized texture accepted');
  const resized=frame(2,1,new Uint8ClampedArray([2,4,6,255,8,10,12,255]));
  parity(resized,resized,0.5);
  assert(canvas.width===2&&canvas.height===1,'canvas resize failed');
  assert(renderer.stats.textureBytes===resized.pixels.byteLength,'dimension change retained incompatible textures');
  renderer.reset();assert(renderer.stats.textureBytes===0,'reset leaked textures');
  parity(a,b,0.25);
  const random=(width,height,seed)=>{
    const px=new Uint8ClampedArray(width*height*4);
    for(let i=0;i<px.length;i++){seed=(seed*1664525+1013904223)>>>0;px[i]=seed>>>24;}
    return frame(width,height,px);
  };
  const randomA=random(13,7,42),randomB=random(13,7,99);
  for(const mix of [-0.5,0,0.12345,0.5,0.99999,1,1.5])parity(randomA,randomB,mix);
  const gl=canvas.getContext('webgl');
  const debug=gl.getExtension('WEBGL_debug_renderer_info');
  const device=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
  const timings=[];
  const fence=new Uint8Array(4);
  const complete=()=>gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,fence);
  for(const [width,height] of [[1920,1080],[3840,2160]]) {
    const length=width*height*4;
    const a=frame(width,height,new Uint8ClampedArray(length).fill(80));
    const b=frame(width,height,new Uint8ClampedArray(length).fill(160));
    const cpu=document.createElement('canvas');cpu.width=width;cpu.height=height;
    const ctx=cpu.getContext('2d');
    assert(renderer.draw({a,b,mix:0.5},off),'benchmark GPU unavailable');complete();
    const measure=run=>{
      const values=[];
      for(let i=0;i<12;i++) {const start=performance.now();run(i);values.push(performance.now()-start);}
      values.sort((a,b)=>a-b);
      return {p50:values[6],p95:values[11]};
    };
    const uploads=renderer.stats.uploads;
    renderer.draw({a:b,b,mix:1},off);
    renderer.draw({a,b,mix:0.5},off);
    assert(renderer.stats.uploads===uploads,'full-size exact refresh re-uploaded anchors');
    const cpuMs=measure(i=>ctx.putImageData(new ImageData(mixDetailPixels(a.pixels,b.pixels,i/12),width,height),0,0));
    const gpuSubmitMs=measure(i=>renderer.draw({a,b,mix:i/12},off));complete();
    const gpuCompleteMs=measure(i=>{renderer.draw({a,b,mix:i/12},off);complete();});
    assert(renderer.stats.uploads===uploads,'benchmark re-uploaded anchors');
    timings.push({width,height,cpuMs,gpuSubmitMs,gpuCompleteMs});
    assert(renderer.stats.textureBytes===length*2,'benchmark texture budget grew');
  }
  const extension=gl.getExtension('WEBGL_lose_context');
  assert(extension,'context-loss test unavailable');
  extension.loseContext();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert(lost===1,'context loss did not notify UI');
  assert(!renderer.draw({a,b,mix:0.5},off),'lost context did not fall back');
  extension.restoreContext();
  await new Promise(resolve=>setTimeout(resolve,200));
  assert(renderer.stats.textureBytes===0,'context loss retained textures');
  const recoveredUploads=renderer.stats.uploads;
  parity(a,b,0.5);
  assert(renderer.stats.uploads===recoveredUploads+2,'restored context reused invalid textures');
  const {Session}=await import('/session.js');
  const scheduling=[];
  for(const gpu of [false,true]) {
    const view={width:a.width,height:a.height,scale:1,x:0,y:0,draft:true};
    const shown=[],estimates=[];
    const s=new Session(()=>view,f=>shown.push(f),error=>{throw Error(error);});
    let dispatches=0;
    const flush=s.flushEdits.bind(s);
    s.flushEdits=()=>{dispatches++;flush();};
    s.pump=async()=>{};s.fullView=()=>view;s.cachedDetailPreview=()=>true;s.values={texture:0};
    s.set('texture',10);
    s.detailCache.a={frame:{...a,view},value:0};
    s.detailCache.b={frame:{...b,view},value:20};
    const before=renderer.stats.draws;
    s.onCachedPreview=p=>{estimates.push(p);return gpu&&renderer.draw(p,off);};
    dispatches=0;
    for(let i=1;i<=100;i++)s.set('texture',10+i*0.09,true);
    assert(dispatches===0,'burst submitted native work before the display frame');
    assert(estimates.length===0&&shown.length===0,'burst drew before the display frame');
    await new Promise(requestAnimationFrame);
    assert(dispatches===1,'burst did not submit native work once per frame');
    assert(estimates.length===1&&estimates[0].mix===0.95,'display did not draw just the latest input');
    assert(estimates[0].frame.trace.edits===100,'coalesced trace lost input count');
    // CPU mixing may finish after the animation frame via its worker queue.
    if (!gpu) {
      const deadline=performance.now()+2000;
      while (!shown.length&&performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert(shown.length===(gpu?0:1),'incorrect CPU fallback draw count');
    assert(renderer.stats.draws-before===(gpu?1:0),'GPU drew more than once per display frame');
    s.set('texture',19.5,true);s.requestRender();
    await new Promise(requestAnimationFrame);
    assert(estimates.length===1,'release did not cancel the queued display callback');
    scheduling.push({backend:gpu?'webgl':'cpu',inputs:100,draws:1,releaseCancelled:true});
    s.previewWorker?.dispose();
  }
  renderer.dispose();assert(renderer.stats.textureBytes===0,'dispose leaked textures');
  const unavailable=new CachedPreviewRenderer({getContext:()=>null,addEventListener(){},removeEventListener(){}},()=>{});
  assert(!unavailable.draw({a,b,mix:0.5},off),'unavailable WebGL did not fall back');unavailable.dispose();
  const failingCanvas=document.createElement('canvas');
  const failingGl=failingCanvas.getContext('webgl');
  const upload=failingGl.texImage2D;
  failingGl.texImage2D=()=>{throw Error('test upload failure');};
  const failing=new CachedPreviewRenderer(failingCanvas,()=>{});
  assert(!failing.draw({a,b,mix:0.5},off),'upload failure did not fall back');
  assert(failing.stats.textureBytes===0,'upload failure retained textures');
  failingGl.texImage2D=upload;failing.dispose();
  return {cases,worstByteError:worst,device,timings,scheduling,contextRecovery:true,uploadFailureFallback:true};
}
let resolveReport,rejectReport;
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject;});
const server=createServer((req,res)=>{
  if(req.url==='/result') {
    let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
      res.end('ok');const result=JSON.parse(body);
      if(result.error)rejectReport(Error(result.error));else resolveReport(result);
    });return;
  }
  if(modules.has(req.url)){res.setHeader('Content-Type','text/javascript');res.end(modules.get(req.url));return;}
  res.setHeader('Content-Type','text/html');
  res.end(`<script type="module">(${check.toString()})().then(result=>fetch('/result',{method:'POST',body:JSON.stringify(result)})).catch(error=>fetch('/result',{method:'POST',body:JSON.stringify({error:error.stack})}));</script>`);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;
const webkit=process.env.WEBKIT_MINIBROWSER;
const browser=spawn(webkit??process.env.CHROMIUM??'chromium',webkit?[
  '--automation','--private',`--profile-dir=${profile}`,'--enable-webgl=true','--hardware-acceleration-policy=always',url,
]:[
  '--headless','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check',
  '--enable-unsafe-swiftshader',`--user-data-dir=${profile}`,url,
],{stdio:['ignore','ignore','pipe'],detached:true,env:{...process.env,TMPDIR:profile}});
let stderr='';browser.stderr.on('data',chunk=>stderr=(stderr+chunk).slice(-4000));
browser.on('error',rejectReport);
browser.on('exit',code=>rejectReport(Error(`Browser exited ${code}: ${stderr}`)));
const timeout=setTimeout(()=>rejectReport(Error(`GPU test timed out: ${stderr}`)),60000);
try {console.log(JSON.stringify(await report,null,2));}
finally {
  clearTimeout(timeout);
  if(browser.pid){try{process.kill(-browser.pid,'SIGTERM');}catch{}}
  server.closeAllConnections();server.close();
  await new Promise(resolve=>setTimeout(resolve,300));
  rmSync(profile,{recursive:true,force:true});
}
