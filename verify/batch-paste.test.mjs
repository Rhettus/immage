// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, registerHooks } from 'node:module';
import { mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync, mkdirSync, renameSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../app/package.json', import.meta.url));
const { transformSync } = await import(require.resolve('rolldown/experimental'));
const shim = new URL('./shim.mjs', import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith('file:') || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: 'module', source: transformSync(path, readFileSync(path, 'utf8'), { jsx: { runtime: 'automatic' } }).code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith('@tauri-apps/') || spec === '@immporter/api') return next(shim, ctx);
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec))
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    return next(spec, ctx);
  },
});
process.env.OMP_NUM_THREADS = '2';
globalThis.window = globalThis;
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,String(v)), removeItem: k => store.delete(k) };
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame = f => setTimeout(() => f(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { Session } = await import('../app/src/session.ts');
const { applyClip, pasteTargets, runPaste, restorePaste } = await import('../app/src/batchPaste.ts');
const { startEngine, stopEngine, request, requestTagged, sent } = await import('./shim.mjs');
const batch = (action, token, imgids) => request({ cmd:'paste_batch', action, token, imgids });
const view = () => ({ width:64,height:64 });
async function open(i) {
  let failure;
  const s = await Session.open(i.path, i.imgid, view, () => {}, e => { failure=e; }, true);
  await s.settled(); assert.equal(failure, undefined);
  return s;
}
async function fixture(fn, ai = false) {
  const dir = mkdtempSync(join(tmpdir(), 'immage-batch-'));
  const paths = ['source','one','two','untouched'].map(n => join(dir,n+'.jpg'));
  paths.forEach(p => copyFileSync(join(root,'app/sample/stairs-to-mountain.jpg'),p));
  const modelDir = ai ? join(dir,'models') : null;
  if(ai) cpSync(join(root,'build/ai-models/mask-object-sam21-small'),join(modelDir,'mask-object-sam21-small'),{recursive:true});
  startEngine(join(root,'build/bin/darktable-engine'),join(dir,'runtime'),modelDir);
  try {
    const images=[];
    for (const path of paths) {
      const r = await request({cmd:'open',path});
      const i = {path,imgid:r.imgid};
      const s=await open(i); s.endBaseline(); s.setMany([['exposure',images.length*.2],['vibrance',images.length*5]]); await s.close(); images.push(i);
    }
    await fn({dir, images, paths});
  } finally { await stopEngine(); rmSync(dir,{recursive:true,force:true}); }
}

test('paste targets are exactly selected local versions, including a single non-active target', () => {
  const images=[{imgid:1,path:'a'}, {imgid:2,path:'b'}, {imgid:3,path:'a'}, {imgid:-4,path:'remote'}];
  const choose = selection => pasteTargets(images,new Set(selection),images[0],i=>i.imgid<0);
  assert.deepEqual(choose([2,3,-4]),{targets:[images[1],images[2]],skipped:1});
  assert.deepEqual(choose([2]).targets,[images[1]]);
  assert.deepEqual(choose([]).targets,[images[0]]);
  assert.deepEqual(choose([-4]).targets,[]);
});

test('batch paste persists selected values and complete Kodak look, preserves other edits, undo/redo and virtual copies', {timeout:120000}, async () => fixture(async ({images,dir}) => {
  const lookPath=join(root,'app/looks/t3mujinpack/t3mujinpack - Color Negative_Kodak Gold 200.dtstyle');
  const source=await open(images[0]);
  applyClip(source,{values:{exposure:1},look:{name:'Kodak Gold 200',path:lookPath,amount:65}}); await source.close();
  // Session's opening history predates the applied look; read the live stack.
  const nativeLook=(await request({cmd:'history'})).items.find(h=>h.label==='look: Kodak Gold 200');assert(nativeLook);
  const styleParams=(await request({cmd:'module_state',op:nativeLook.op,priority:nativeLook.priority})).was.params;
  const pixels=async name=>{const rgba=join(dir,name+'.rgba');await request({cmd:'render',width:64,height:64,rgba});return readFileSync(rgba);};
  const copy=(await request({cmd:'copy',imgid:images[1].imgid})).image;
  const targets=[images[1],images[2],{imgid:copy.imgid,path:images[1].path}];
  const untouched=readFileSync(images[3].path+'.xmp','utf8');
  const before=[];
  let beforePixels;
  for(const i of targets) { const s=await open(i); before.push({exposure:s.values.exposure,vibrance:s.values.vibrance}); if(!beforePixels)beforePixels=await pixels('before');await s.close(); }
  let renders=0;
  sent.hook=cmd=>{if(cmd==='render')renders++;};
  const progress=[];
  const result=await runPaste(targets,{values:{exposure:1},look:{name:'Kodak Gold 200',path:lookPath,amount:65}},(n,total)=>progress.push([n,total]),()=>{});
  assert.equal(result.error,null); assert(result.token>0);
  assert.deepEqual(progress.at(-1),[3,3]);
  sent.hook=null;
  assert.equal(renders,0,'background paste never renders');
  let pastedPixels;
  for(const [n,i] of targets.entries()) {
    const s=await open(i); assert.equal(s.values.exposure,1); assert.equal(s.values.vibrance,before[n].vibrance);
    assert.equal(s.look,'Kodak Gold 200'); assert.equal(s.lookAmount,65);
    const h=s.history.find(h=>h.label==='look: Kodak Gold 200');assert(h);
    assert.equal((await request({cmd:'module_state',op:h.op,priority:h.priority})).was.params,styleParams,'complete native curve parameters travel with the look');
    if(!pastedPixels)pastedPixels=await pixels('pasted');
    assert(readFileSync(i.path+'.xmp','utf8').includes('look: Kodak Gold 200'));
    await s.close();
  }
  assert.equal(readFileSync(images[3].path+'.xmp','utf8'),untouched);
  assert.notDeepEqual(pastedPixels,beforePixels,'the pasted edit changes rendered pixels');
  const undo=await restorePaste(result.token,'undo'); assert(undo.every(i=>!i.error));
  for(const [n,i] of targets.entries()) { const s=await open(i); assert.equal(s.values.exposure,before[n].exposure); assert.equal(s.look,null); await s.close(); }
  await open(targets[0]);assert.deepEqual(await pixels('undone'),beforePixels,'undo restores rendered pixels');
  assert((await restorePaste(result.token,'redo')).every(i=>!i.error));
  await open(targets[0]);assert.deepEqual(await pixels('redone'),pastedPixels,'redo restores rendered pixels');
  for(const i of targets) { const s=await open(i); assert.equal(s.values.exposure,1); assert.equal(s.look,'Kodak Gold 200'); assert.equal(s.lookAmount,65); await s.close(); }
  await batch('release',result.token);
  await assert.rejects(batch('undo',result.token),/no longer available/);
  await stopEngine(); startEngine(join(root,'build/bin/darktable-engine'),join(images[0].path,'..','runtime'));
  for(const i of targets) { const s=await open(i); assert.equal(s.values.exposure,1); assert.equal(s.look,'Kodak Gold 200'); await s.close(); }
}));

test('batch validates all targets, rolls back a missing look, and refuses stale undo without changing another photo', {timeout:120000}, async () => fixture(async ({images}) => {
  await assert.rejects(batch('begin',0,[images[1].imgid,99999999]),/missing/);
  await assert.rejects(batch('begin',0,[images[1].imgid,images[1].imgid]),/duplicate/);
  const failed=await runPaste([images[1],images[2]],{values:{exposure:2},look:{name:'missing',path:'/does/not/exist',amount:100}},()=>{},()=>{});
  assert.equal(failed.token,null); assert.match(failed.error,/rolled back/);
  for(const [n,i] of images.slice(1,3).entries()) {const s=await open(i);assert.equal(s.values.exposure,(n+1)*.2); await s.close();}
  const result=await runPaste([images[1],images[2]],{values:{exposure:1}},()=>{},()=>{});
  assert.equal(result.error,null);
  const s=await open(images[2]); s.setMany([['exposure',2]]); await s.close();
  await assert.rejects(restorePaste(result.token,'undo'),/changed since/);
  const other=await open(images[1]); assert.equal(other.values.exposure,1); await other.close();
  await batch('release',result.token);
}));

test('batch mask replacement and undo preserve local edits and crop omitted from Copy', {timeout:120000}, async () => fixture(async ({images}) => {
  const s=await open(images[1]);
  s.addMask('old',[{type:'ellipse',x:.5,y:.5,rx:.2,ry:.2,angle:0,feather:.2}]);
  s.setLocal('old','exposure',.7); s.setMany([['crop_l',.1]]); await s.close();
  const before=await open(images[1]); const masks=structuredClone(before.masks), crop=before.values.crop_l; await before.close();
  const result=await runPaste([images[1],images[2]],{values:{exposure:1},masks:[]},()=>{},()=>{});
  assert.equal(result.error,null);
  const pasted=await open(images[1]); assert.equal(pasted.masks.length,0); assert.equal(pasted.values.crop_l,crop);await pasted.close();
  assert((await restorePaste(result.token,'undo')).every(i=>!i.error));
  const restored=await open(images[1]); assert.deepEqual(restored.masks,masks); assert.equal(restored.values.crop_l,crop);await restored.close();
  await batch('release',result.token);
}));

test('sidecar write failure reports failed recovery and retains snapshots for a retry', {timeout:120000}, async () => fixture(async ({images}) => {
  const path=images[2].path+'.xmp', backup=path+'.bak';
  renameSync(path,backup); mkdirSync(path);
  const result=await runPaste([images[1],images[2]],{values:{exposure:1}},()=>{},()=>{});
  assert.equal(result.recovery,true); assert(result.token>0); assert.match(result.error,/recovery failed/);
  rmSync(path,{recursive:true}); renameSync(backup,path);
  assert((await restorePaste(result.token,'abort')).every(i=>!i.error));
  for(const [n,i] of images.slice(1,3).entries()) {const s=await open(i);assert.equal(s.values.exposure,(n+1)*.2);await s.close();}
  await batch('release',result.token);
}));

test('new photos establish defaults before snapshot, preserving unticked preset edits through undo/redo', {timeout:120000}, async () => fixture(async ({dir,images}) => {
  const { preparePastePhoto }=await import('../app/src/pasteDefaults.ts');
  const path=join(dir,'fresh.jpg');copyFileSync(images[0].path,path);
  const fresh={path,imgid:(await requestTagged({cmd:'import',files:[path]})).images[0].imgid};
  const defaults={profile:0,compensation:0,auto:false,preset:{values:{vibrance:17,lens_profile:1,lens_ca:1,hp_enable:1},nonRaw:true}};
  const result=await runPaste([fresh,images[1]],{values:{exposure:1}},()=>{},()=>{},s=>preparePastePhoto(s,defaults));
  assert.equal(result.error,null);
  const pasted=await open(fresh);assert.equal(pasted.values.vibrance,17);assert.equal(pasted.values.exposure,1);
  assert.notEqual(pasted.values.lens_profile,1,'a JPEG keeps the camera\'s lens corrections');
  assert.notEqual(pasted.values.hp_enable,1,'a JPEG gets no raw-only settings');await pasted.close();
  assert((await restorePaste(result.token,'undo')).every(i=>!i.error));
  const undone=await open(fresh);assert.equal(undone.values.vibrance,17);assert.equal(undone.values.exposure,0);await undone.close();
  assert((await restorePaste(result.token,'redo')).every(i=>!i.error));
  const other=await open(images[1]);assert.equal(other.values.vibrance,5,'existing photo keeps its own edit');await other.close();
  await batch('release',result.token);
}));

test('a new JPEG gets the new-photos preset only when Also apply to JPEGs is on', {timeout:120000}, async () => fixture(async ({dir,images}) => {
  const { preparePastePhoto }=await import('../app/src/pasteDefaults.ts');
  const path=join(dir,'plain.jpg');copyFileSync(images[0].path,path);
  const fresh={path,imgid:(await requestTagged({cmd:'import',files:[path]})).images[0].imgid};
  const defaults={profile:0,compensation:0,auto:false,preset:{values:{vibrance:17,lens_profile:1}}};
  const result=await runPaste([fresh],{values:{exposure:1}},()=>{},()=>{},s=>preparePastePhoto(s,defaults));
  assert.equal(result.error,null);
  const pasted=await open(fresh);assert.equal(pasted.values.exposure,1);
  assert.notEqual(pasted.values.vibrance,17,'the preset is for raws');assert.notEqual(pasted.values.lens_profile,1);await pasted.close();
  await batch('release',result.token);
}));

// The first session of a never-processed JPEG once scaled its input without
// gamma correction, so undo could not match the frame the viewer had shown.
test('a fresh photo renders the same in its first session as after paste and undo', {timeout:120000}, async () => fixture(async ({dir}) => {
  const { preparePastePhoto }=await import('../app/src/pasteDefaults.ts');
  const path=join(dir,'first.jpg');copyFileSync(join(root,'app/sample/stairs-to-mountain.jpg'),path);
  const fresh={path,imgid:(await requestTagged({cmd:'import',files:[path]})).images[0].imgid};
  const pixels=async name=>{const rgba=join(dir,name+'.rgba');await request({cmd:'render',width:96,height:96,rgba});return readFileSync(rgba);};
  let s=await open(fresh);assert.equal(s.wasEdited,false);s.setMany([['tm_mode',1]]);await s.settled();
  const first=await pixels('first');await s.close();
  const lookPath=join(root,'app/looks/t3mujinpack/t3mujinpack - Color Negative_Kodak Gold 200.dtstyle');
  const result=await runPaste([fresh],{values:{exposure:1},look:{name:'Kodak Gold 200',path:lookPath,amount:35}},()=>{},()=>{},
    x=>preparePastePhoto(x,{profile:0,compensation:0,auto:false,preset:null}));
  assert.equal(result.error,null);
  assert((await restorePaste(result.token,'undo')).every(i=>!i.error));
  s=await open(fresh);assert.deepEqual(await pixels('undone'),first,'undo restores the first session\'s frame');await s.close();
  await batch('release',result.token);
}));

test('negative paste converts every target, disables legacy tone modules, and undo restores those modules', {timeout:120000}, async () => fixture(async ({images}) => {
  const {NEG_CHOICES}=await import('../app/src/manifest.ts');
  for(const i of images.slice(1,3)) {
    await open(i);await request({cmd:'set',op:'basecurve',enabled:true});await request({cmd:'save'});
  }
  const result=await runPaste(images.slice(1,3),{values:{...NEG_CHOICES,neg_on:1}},()=>{},()=>{});
  assert.equal(result.error,null);
  for(const i of images.slice(1,3)) {
    const s=await open(i);assert.equal(s.values.neg_on,1);
    assert(!s.history.some(h=>h.op==='basecurve'&&h.enabled));await s.close();
  }
  assert((await restorePaste(result.token,'undo')).every(i=>!i.error));
  for(const i of images.slice(1,3)) {const s=await open(i);assert.equal(s.values.neg_on,0);assert(s.history.some(h=>h.op==='basecurve'&&h.enabled));await s.close();}
  await batch('release',result.token);
}));

test('reloading after batch undo retains native module states from earlier editing steps', {timeout:120000}, async () => fixture(async ({images}) => {
  await open(images[1]);await request({cmd:'set',op:'basecurve',enabled:true});await request({cmd:'save'});
  const original=await open(images[1]);
  const h=original.history.find(h=>h.op==='basecurve'&&h.enabled);assert(h);
  original.setModuleState(h,{enabled:false});await original.close();
  const result=await runPaste(images.slice(1,3),{values:{exposure:1}},()=>{},()=>{});assert.equal(result.error,null);
  const pasted=await open(images[1]);pasted.inheritUndo(original);await pasted.close();
  assert((await restorePaste(result.token,'undo')).every(i=>!i.error));
  const reopened=await open(images[1]);reopened.inheritUndo(pasted);
  reopened.setModuleState(h,{restore:'opened'});await reopened.close();
  const restored=await open(images[1]);assert(restored.history.some(h=>h.op==='basecurve'&&h.enabled));await restored.close();
  await batch('release',result.token);
}));

test('AI recipes survive mask persistence, rename and duplication, and legacy masks block before edits', {timeout:120000}, async () => fixture(async ({images,dir}) => {
  const s=await open(images[0]);
  const paths=[{hole:false,points:[[.2,.2,.2,.2,.2,.2],[.8,.2,.8,.2,.8,.2],[.5,.8,.5,.8,.5,.8]]}];
  const ai={kind:'object',points:[[.5,.4,1]],box:[.2,.2,.8,.8],inset:true,backdrop:true};
  s.addMask('renamable',[{type:'object',paths,ai}]);s.setLocal('renamable','l_exposure',.5);await s.close();
  const reopened=await open(images[0]);
  const pixels=async name=>{const rgba=join(dir,name+'.rgba');await request({cmd:'render',width:64,height:64,rgba});return readFileSync(rgba);};
  const withRecipe=await pixels('with-recipe');
  reopened.setShapes('renamable',[{type:'object',paths}]);await reopened.settled();
  assert.deepEqual(await pixels('without-recipe'),withRecipe,'metadata groups do not change rendered pixels');
  reopened.setShapes('renamable',[{type:'object',paths,ai}]);await reopened.settled();
  const recipe=reopened.masks.find(m=>m.name==='renamable').shapes[0].ai;
  assert.equal(recipe.kind,'object');assert.equal(recipe.inset,true);
  assert.ok(Math.abs(recipe.points[0][0]-.5)<1e-5);
  reopened.setMany([['crop_l',.1]]);await reopened.close();
  const cropped=await open(images[0]);
  const moved=cropped.masks.find(m=>m.name==='renamable').shapes[0].ai;
  assert.ok(Math.abs(moved.points[0][0]-(.5-.1)/.9)<.002,'object prompt follows crop');
  cropped.setMany([['crop_l',0]]);await cropped.close();
  const uncropped=await open(images[0]);
  assert.ok(Math.abs(uncropped.masks[0].shapes[0].ai.points[0][0]-.5)<.002,'prompt returns after uncrop');
  await uncropped.close();
  const toRename=await open(images[0]);
  toRename.renameMask('renamable','renamed');
  toRename.duplicateMask('renamed','duplicate');
  toRename.setShapes('duplicate',[{type:'object',paths,ai:{...ai,points:[[.3,.6,1]]}}]);
  toRename.setLocal('duplicate','l_exposure',.4);
  await toRename.close();
  const renamed=await open(images[0]);
  assert.equal(renamed.masks.find(m=>m.name==='renamed').shapes[0].ai.kind,'object');
  assert.equal(renamed.masks.find(m=>m.name==='duplicate').shapes[0].ai.kind,'object');
  assert.ok(Math.abs(renamed.masks.find(m=>m.name==='duplicate').shapes[0].ai.points[0][0]-.3)<1e-5);
  assert.ok(Math.abs(renamed.masks.find(m=>m.name==='renamed').shapes[0].ai.points[0][0]-.5)<1e-5);
  await renamed.close();
  const legacy={values:{exposure:9},masks:[{name:'old sky',invert:false,values:{},shapes:[{type:'object',paths}]}]};
  await assert.rejects(runPaste([images[1]],legacy,()=>{},()=>{}),/recreate it on the source/);
  const untouched=await open(images[1]);assert.equal(untouched.values.exposure,.2);await untouched.close();
  await stopEngine();startEngine(join(root,'build/bin/darktable-engine'),join(dir,'restart-runtime'));
  const fromXmp=await Session.open(images[0].path,null,view,()=>{},()=>{},true);
  assert.equal(fromXmp.masks.find(m=>m.name==='duplicate').shapes[0].ai.kind,'object');
  await fromXmp.close();
}));


test('Select Object paste reruns inference per destination, preserves manual components, undo/redo and failure rollback',
  {timeout:180000, skip:!existsSync(join(root,'build/ai-models/mask-object-sam21-small/config.json'))}, async () => fixture(async ({images}) => {
  const s=await open(images[0]);
  const paths=[{hole:false,points:[[.1,.1,.1,.1,.1,.1],[.2,.1,.2,.1,.2,.1],[.15,.2,.15,.2,.15,.2]]}];
  const manual={type:'ellipse',x:.3,y:.3,rx:.1,ry:.1,angle:0,feather:.1};
  s.addMask('Object',[{type:'object',paths,ai:{kind:'object',points:[[.5,.5,1]],inset:true,backdrop:false}},manual]);
  s.setLocal('Object','l_exposure',.6);await s.close();
  const source=await open(images[0]);const masks=structuredClone(source.masks);await source.close();
  let calls=0; sent.hook=cmd=>{if(cmd==='ai_object')calls++;};
  const before=calls;
  const result=await runPaste(images.slice(1,3),{values:{exposure:.9},masks},()=>{},()=>{});
  assert.equal(result.error,null);
  assert.equal(calls-before,2);
  for(const image of images.slice(1,3)) {
    const pasted=await open(image);const mask=pasted.masks.find(m=>m.name==='Object');
    assert.equal(mask.shapes[0].ai.kind,'object');assert.notDeepEqual(mask.shapes[0].paths,paths);
    assert.equal(mask.shapes[1].type,'ellipse');assert.ok(Math.abs(mask.values.l_exposure-.6)<1e-5);
    await pasted.close();
  }
  const count=calls;
  await restorePaste(result.token,'undo');await restorePaste(result.token,'redo');
  assert.equal(calls,count);
  await batch('release',result.token);
  let attempts=0;sent.hook=cmd=>{if(cmd==='ai_object'&&++attempts===2)throw Error('injected second destination inference failure');};
  const failed=await runPaste(images.slice(1,3),{values:{exposure:4},masks},()=>{},()=>{});
  assert.match(failed.error,/rolled back/);
  assert.equal(attempts,2);sent.hook=null;
  for(const image of images.slice(1,3)) {const restored=await open(image);assert.equal(restored.values.exposure,.9);assert.equal(restored.masks[0].shapes[0].ai.kind,'object');await restored.close();}
},true));

test('tone and look paste undo/redo preserves existing AI masks', {timeout:120000}, async () => fixture(async ({images,dir}) => {
  const paths=[{hole:false,points:[[.2,.2,.2,.2,.2,.2],[.8,.2,.8,.2,.8,.2],[.5,.8,.5,.8,.5,.8]]}];
  for(const image of images.slice(1,3)) {
    const s=await open(image);s.setMany([['exposure',0]]);
    s.addMask('Object',[{type:'object',paths,ai:{kind:'object',points:[[.5,.4,1]],inset:true,backdrop:true}}]);
    s.setLocal('Object','l_exposure',.1);await s.close();
  }
  const result=await runPaste(images.slice(1,3),{values:{exposure:1},look:{name:'Kodak Gold 200',path:join(root,'app/looks/t3mujinpack/t3mujinpack - Color Negative_Kodak Gold 200.dtstyle'),amount:35}},()=>{},()=>{});
  assert.equal(result.error,null);
  let s=await open(images[1]);assert.equal(s.values.exposure,1);await s.close();
  await restorePaste(result.token,'undo');
  s=await open(images[1]);assert.equal(s.values.exposure,0);
  const {BUILTIN_PRESETS}=await import('../app/src/Presets.tsx');
  for(const p of BUILTIN_PRESETS.filter(p=>!p.rawOnly))await s.preview(32,p.values);
  await s.preview(32,{},join(root,'app/looks/t3mujinpack/t3mujinpack - Color Negative_Kodak Gold 200.dtstyle'));
  await s.preview(32,{},null);
  await assert.rejects(request({cmd:'preview',size:32,rgba:join(dir,'failed-preview.rgba'),edits:[{op:'channelmixerrgb',instance:'failed preview',enabled:true,params:{invalid_field:1}}]}),/has no field/);
  await s.close();
  await restorePaste(result.token,'redo');
  s=await open(images[1]);assert.equal(s.values.exposure,1);assert.equal(s.masks[0].shapes[0].ai.kind,'object');await s.close();
  await batch('release',result.token);
}));
