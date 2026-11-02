// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../app/package.json',import.meta.url));
const {transformSync}=await import(require.resolve('rolldown/experimental'));
const source=readFileSync(new URL('../app/src/App.tsx',import.meta.url),'utf8');
const start=source.indexOf('  const prepareCropView =');
const end=source.indexOf('  const enterCrop =',start);
assert.ok(start>=0&&end>start);
const {code}=transformSync('crop.ts',source.slice(start,end));
const create=new Function('env',`with(env) { ${code}; return prepareCropView; }`);
const ref=current=>({current});
test('crop transition removes previous pixels and stops zoom before the replacement arrives',()=>{
  const cleared=[], canceled=[];
  const env={
    resetCanvases(){env.canvasesReset=true;},resetHistogram(){env.histogramReset=true;},
    loupeDisplays:ref(new Map()),
    pixelWorker:ref({dispose(){env.workerDisposed=true;}}),
    sharpMeta:ref({}),baseMeta:ref({}),loupeMeta:ref({}),overviewHash:ref('old'),
    setCropBox(box){env.box=box;},
    placementRef:ref({fullWidth:800,fullHeight:600}),
    anim:ref({raf:42,end:{x:0.2},asked:{scale:1}}),
    cancelAnimationFrame(id){canceled.push(id);},
    zoomRef:ref(1),setZoomState(z){env.zoom=z;},center:ref({x:0.2,y:0.7}),
  };
  for(const name of ['canvas','baseCanvas','clipSharp','clipBase','loupeCanvas']) {
    env[name]=ref({width:800,height:600,getContext(){return {
      clearRect(...args){cleared.push([name,...args]);},
    };}});
  }
  create(env)();
  assert.equal(env.canvasesReset,true);assert.equal(env.histogramReset,true);
  assert.equal(env.workerDisposed,true);
  assert.equal(env.pixelWorker.current,null);
  assert.equal(cleared.length,5);
  for(const [, ...rect] of cleared) assert.deepEqual(rect,[0,0,800,600]);
  for(const name of ['sharpMeta','baseMeta','overviewHash']) assert.equal(env[name].current,null);
  assert.equal(env.box,null);
  assert.equal(env.placementRef.current,null);
  assert.deepEqual(canceled,[42]);
  assert.deepEqual(env.anim.current,{raf:null,end:null,asked:null});
  assert.equal(env.zoomRef.current,'fit');
  assert.equal(env.zoom,'fit');
  assert.deepEqual(env.center.current,{x:0.5,y:0.5});
});

test('entering crop republishes unchanged placement when the replacement frame arrives',()=>{
  const start=source.indexOf('  const updatePlacement =');
  const end=source.indexOf('  const paintFrame =',start);
  assert.ok(start>=0&&end>start);
  const {code}=transformSync('placement.ts',source.slice(start,end));
  const makePlacement=new Function('env',`with(env) { ${code}; return updatePlacement; }`);
  const placement={fullWidth:800,fullHeight:600,scale:1,x:0,y:0,width:800,height:600};
  let updates=0;
  const env={
    resetCanvases(){},resetHistogram(){},pixelWorker:ref(null),loupeDisplays:ref(new Map()),
    sharpMeta:ref({}),baseMeta:ref(null),loupeMeta:ref(null),overviewHash:ref(null),
    setCropBox(){},anim:ref({raf:null,end:null,asked:null}),
    zoomRef:ref('fit'),setZoomState(){},center:ref({x:0.5,y:0.5}),
    placementRef:ref(placement),full:ref({w:800,h:600}),viewZ:ref(1),
    viewport(){return {w:800,h:600};},setPlacement(p){updates++;assert.deepEqual(p,placement);},
  };
  for(const name of ['canvas','baseCanvas','clipSharp','clipBase','loupeCanvas']) env[name]=ref(null);
  const updatePlacement=makePlacement(env);
  updatePlacement();
  assert.equal(updates,0,'ordinary unchanged frames still skip placement updates');
  create(env)();
  env.sharpMeta.current={}; // the uncropped replacement frame has arrived
  updatePlacement();
  assert.equal(updates,1,'the replacement restores the crop overlay even with identical geometry');
  updatePlacement();
  assert.equal(updates,1,'subsequent identical frames remain deduplicated');
});


test('entering crop preserves displayed orientation before resetting placement', () => {
  const start = source.indexOf('  const enterCrop =');
  const end = source.indexOf('  const leaveCrop =', start);
  assert.ok(start >= 0 && end > start);
  const {code} = transformSync('enter-crop.ts', source.slice(start, end));
  const enter = new Function('env', `with(env) { ${code}; return enterCrop; }`);
  for (const [width, height] of [[600, 900], [900, 600], [600, 600]]) {
    for (const cropped of [false, true]) {
      const env = {
        session: ref({values: cropped ? {crop_l: 0.1, crop_t: 0.1, crop_r: 0.9, crop_b: 0.9,
          crop_rd: 3, crop_rn: 2} : {}, bypass() {}}),
        croppingRef: ref(false), placementRef: ref({fullWidth: width, fullHeight: height}),
        cropCustoms: [], ASPECTS: [{id: '3:2', ratio: [3, 2]}],
        setBaMode() {}, setCompare() {},
        prepareCropView() { env.placementRef.current = null; },
        setCropRect() {}, setCropOwn() {}, setCropEntry() {}, setCropAspect() {},
        setCropPortrait(value) { env.portrait = value; }, setCropping() {},
      };
      enter(env)();
      assert.equal(env.portrait, height > width);
      assert.equal(env.placementRef.current, null);
    }
  }
});
