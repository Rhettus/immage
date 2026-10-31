// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
// Exercise the actual UI paint callback with canvas/DOM boundaries stubbed.
const source=readFileSync(new URL('../app/src/App.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const paintFrame = useCallback(');
const end=source.indexOf('  // timed for the performance overlay',start);
assert.ok(start>=0&&end>start);
const {code}=transformSync('paint.ts',source.slice(start,end));
const create=new Function('env',`with(env) { ${code}; return paintFrame; }`);
const ref=current=>({current});
function fixture(success=true) {
  const calls=[];
  const renderer={stats:{uploads:0,textureBytes:16},draw(preview){
    calls.push(['gpu',preview]);this.stats.uploads++;return success;
  },reset(){calls.push(['reset']);}};
  const env={
    perf:{time(_name,fn){return fn();}},
    useCallback:callback=>callback,
    draftShown:ref(true),dragging:ref(false),session:ref(null),
    baModeRef:ref('off'),loupeCanvas:ref(null),loupeMeta:ref(null),setLoupeShown(){},
    cachedShown:ref(true),cachedRenderer:ref(renderer),exactGpuFrame:ref(null),
    clipRef:ref({low:false,high:false}),
    canvas:ref({width:2,height:2,getContext(){return {putImageData(){calls.push(['cpu']);}};}}),
    hideCachedPreview(){calls.push(['hide']);env.cachedShown.current=false;},
    ImageData:class {},paintClip(){},full:ref(null),sharpMeta:ref(null),placed:f=>f,
    setShownView(){},placeLayers(){calls.push(['place']);},updatePlacement(){calls.push(['placement']);},
    baseStale:ref(false),overviewHash:ref(null),autoPending:ref(false),tonePending:ref(null),wbTarget:ref(null),
    scheduleCopy(){calls.push(['copy']);},setStatus(){calls.push(['status']);},
    cachedCanvas:ref({style:{display:'block'}}),
  };
  const f={width:2,height:2,fullWidth:4,fullHeight:4,x:0,y:0,
    view:{width:2,height:2,scale:0.5},pixels:new Uint8ClampedArray(16),trace:{}};
  return {env,f,calls,paint:create(env)};
}
test('release presents exact pixels on the visible GPU surface and completes frame bookkeeping',()=>{
  const {env,f,calls,paint}=fixture();
  paint(f);
  assert.deepEqual(calls.map(c=>c[0]),['gpu','place','placement','copy','status']);
  const preview=calls[0][1];
  assert.equal(preview.a,f);assert.equal(preview.b,f);assert.equal(preview.mix,1);
  assert.equal(env.cachedShown.current,true);assert.equal(env.exactGpuFrame.current,f);
  assert.equal(env.draftShown.current,false);assert.equal(env.sharpMeta.current,f);
  assert.equal(f.trace.previewBackend,'webgl');assert.equal(f.trace.anchorUploads,1);
});
test('failed exact GPU upload falls back to native pixels',()=>{
  const {env,f,calls,paint}=fixture(false);
  paint(f);
  assert.deepEqual(calls.map(c=>c[0]),['gpu','hide','reset','cpu','place','placement','copy','status']);
  assert.equal(env.cachedShown.current,false);assert.equal(env.exactGpuFrame.current,null);
});
