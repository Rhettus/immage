// SPDX-License-Identifier: GPL-3.0-or-later
// Integration check: the saturation curve, on the photo and in a mask, renders, saves and reloads.
import { createRequire, registerHooks } from "node:module";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
         writeFileSync, constants } from "node:fs";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const APP = join(HERE, "..", "app");
const SHIM = pathToFileURL(join(HERE, "shim.mjs")).href;

// the app's TypeScript compiled as Vite compiles it, with oxc through
// rolldown: Node's own type stripping rejects session.ts's parameter
// properties
const { transformSync } = await import(pathToFileURL(
  createRequire(join(APP, "package.json")).resolve("rolldown/experimental")).href);

// the app imports without extensions, as Vite allows (as benchmarking/lib/edits.mjs);
// Tauri's invoke and events, and the importer's api, are the shim's
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    const out = transformSync(path, readFileSync(path, "utf8"), { jsx: { runtime: "automatic" } });
    if (out.errors?.length) throw new Error(`${path}: ${out.errors.map((e) => e.message).join("; ")}`);
    return { format: "module", source: out.code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec === "@tauri-apps/api/core" || spec === "@tauri-apps/api/event" || spec === "@tauri-apps/api/window"
        || spec === "@immporter/api") return next(SHIM, ctx);
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(spec)) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

// what the WebView would have: the timers Session and activity.ts use,
// localStorage, which holds Preferences › Modules, and ImageData, which a
// mask's overlay comes in
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);
globalThis.ImageData = class {
  constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(4 * w * h); }
};



const {startEngine,stopEngine,request}=await import(SHIM);
const {Session}=await import('../app/src/session.ts');
const {localFields,satPointValues,satPointsOf}=await import('../app/src/manifest.ts');
const {storeModuleMode,storeModuleChoice}=await import('../app/src/moduleChoice.ts');
const {mkdtempSync}=await import('node:fs');
const assert=(await import('node:assert/strict')).default;

const work=mkdtempSync('/tmp/immage-satcurve-');
const photo=join(work,'photo.jpg');
copyFileSync(join(APP,'sample/stairs-to-mountain.jpg'),photo);
storeModuleMode('custom');
storeModuleChoice('saturation',2);
storeModuleChoice('saturation',2,'masks');
startEngine(join(HERE,'../build/bin/darktable-engine'),join(work,'runtime'));
let session;
const errors=[];
const open=()=>Session.open(photo,null,()=>({width:384,height:256}),()=>{},e=>errors.push(e));
const near=(a,b)=>Math.abs(a-b)<1e-5;
const globalCurve=[[0,.62],[.45,.66],[1,.42]], brilliance=[[0,.5],[.4,.58],[1,.48]], maskCurve=[[0,.7],[1,.55]];
const fields=['channel[0].curve_num_nodes','channel[0].curve[1].x','channel[0].curve[1].y',
              'channel[1].curve_num_nodes','channel[1].curve[1].y'];
// the frame's mean chroma, as the spread of each pixel's channels
const chroma=async name=>{
  const rgba=join(work,name+'.rgba');
  await request({cmd:'render',width:192,height:128,rgba});
  const px=readFileSync(rgba);let sum=0;
  for(let i=0;i<px.length;i+=4)sum+=Math.max(px[i],px[i+1],px[i+2])-Math.min(px[i],px[i+1],px[i+2]);
  return sum/(px.length/4);
};
try {
  session=await open();
  await session.settled();
  assert.equal(session.values.mod_saturation,2,'a new photo did not take the saturation curve');
  const before=await chroma('before');
  session.setMany(Object.entries({...satPointValues(globalCurve,0),...satPointValues(brilliance,1)}));
  session.addMask('mask 1',[{type:'ellipse',x:.5,y:.5,rx:.4,ry:.4,angle:0,feather:.1}]);
  assert.equal(session.masks[0].values.mod_saturation,2,'a new mask did not take the saturation curve');
  for(const [id,v] of Object.entries(satPointValues(maskCurve,0)))session.setLocal('mask 1',id,v);
  await session.settled();
  assert.deepEqual(errors,[]);
  const after=await chroma('after');
  assert.ok(after>before*1.05,`the curves left the frame's chroma at ${after.toFixed(2)} (from ${before.toFixed(2)})`);
  console.log(`mean chroma ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  const got=(await request({cmd:'get',modules:{satcurvergb:fields,colorbalancergb:['saturation_global']}})).modules;
  assert.ok(got.satcurvergb.enabled,'satcurvergb is off');
  assert.equal(got.satcurvergb.params['channel[0].curve_num_nodes'],3);
  assert.ok(near(got.satcurvergb.params['channel[0].curve[1].y'],.66));
  assert.equal(got.satcurvergb.params['channel[1].curve_num_nodes'],3);
  assert.ok(near(got.satcurvergb.params['channel[1].curve[1].y'],.58));
  assert.ok(!got.colorbalancergb?.enabled || got.colorbalancergb.params.saturation_global===0,
            'color balance rgb also carries Saturation');
  const raw=await request({cmd:'masks',fields:localFields()});
  const mask=(Array.isArray(raw)?raw:raw.masks).find(m=>m.name==='mask 1');
  assert.ok(mask.instances.satcurvergb?.enabled,'the mask has no saturation curve instance');
  assert.ok(near(mask.instances.satcurvergb.params['channel[0].curve[0].y'],.7));
  await session.close();session=null;
  session=await open();
  await session.settled();
  assert.equal(session.values.mod_saturation,2,'saved photo lost the saturation curve');
  const close=(a,b)=>a.length===b.length&&a.every(([x,y],k)=>near(x,b[k][0])&&near(y,b[k][1]));
  assert.ok(close(satPointsOf(session.values,0),globalCurve),'saved saturation curve changed');
  assert.ok(close(satPointsOf(session.values,1),brilliance),'saved brilliance curve changed');
  assert.equal(session.masks[0].values.mod_saturation,2,'saved mask lost the saturation curve');
  assert.ok(close(satPointsOf(session.masks[0].values,0),maskCurve),'saved mask curve changed');
  assert.deepEqual(errors,[]);
  console.log('PASS: the saturation curve renders, saves and reloads, on the photo and in a mask');
} finally {
  if(session)await session.close();
  await stopEngine();
  rmSync(work,{recursive:true,force:true});
}
