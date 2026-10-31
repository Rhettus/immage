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
    hideCachedPreview(){this.cachedShown=false;},cachedShown:true,
    cachedRenderer:ref({reset(){env.reset=true;}}),
    sharpMeta:ref({}),baseMeta:ref({}),loupeMeta:ref({}),overviewHash:ref('old'),
    setCropBox(box){env.box=box;},
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
  assert.equal(env.cachedShown,false);
  assert.equal(env.reset,true);
  assert.equal(cleared.length,5);
  for(const [, ...rect] of cleared) assert.deepEqual(rect,[0,0,800,600]);
  for(const name of ['sharpMeta','baseMeta','loupeMeta','overviewHash']) assert.equal(env[name].current,null);
  assert.equal(env.box,null);
  assert.deepEqual(canceled,[42]);
  assert.deepEqual(env.anim.current,{raf:null,end:null,asked:null});
  assert.equal(env.zoomRef.current,'fit');
  assert.equal(env.zoom,'fit');
  assert.deepEqual(env.center.current,{x:0.5,y:0.5});
});
