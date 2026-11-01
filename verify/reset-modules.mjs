// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the release checks: the app's own Session (app/src/session.ts) driven
// headless, every slider of every panel and of a mask moved and the frame
// it renders measured. run by verify/run.py, with one JSON argument:
//   { engine, work, photos: [path], rendered: raw, checks: [name], controls: [id], references, accept,
//     git, out }
// and writes `out`: every result, then the summary run.py reports
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
const {Session,instanceKey}=await import('../app/src/session.ts');
const {isModuleSetting}=await import('../app/src/manifest.ts');
const {computeHistogram}=await import('../app/src/histogram.ts');
const {mkdtempSync}=await import('node:fs');
const assert=(await import('node:assert/strict')).default;
const work=mkdtempSync('/tmp/immage-reset-check-');
const original=process.env.IMMAGE_RESET_PHOTO ?? join(APP,'sample/stairs-to-mountain.jpg');
const photo=join(work,basename(original));copyFileSync(original,photo);
if(existsSync(original+'.xmp'))copyFileSync(original+'.xmp',photo+'.xmp');
startEngine(join(HERE,'../build/bin/darktable-engine'),join(work,'runtime'));
let session;
try {
 await request({cmd:'open',path:photo});
 // An unsupported module and a hidden parameter in a supported module.
 await request({cmd:'set',op:'velvia',enabled:true,params:{strength:75}});
 await request({cmd:'set',op:'exposure',enabled:true,params:{deflicker_percentile:73}});
 await request({cmd:'set',op:'filmicrgb',enabled:true,params:{}});
 await request({cmd:'set',op:'agx',enabled:true,params:{}});
 await request({cmd:'save'});
 let frame,errors=[];
 session=await Session.open(photo,null,()=>({width:512,height:512}),f=>frame=f,e=>errors.push(e));
 await session.settled();
 const before=new Uint8ClampedArray(frame.pixels),values={...session.values};
 session.setMany(Object.entries(session.neutral).filter(([id])=>!isModuleSetting(id)&&!['profile','exp_comp','orient'].includes(id)));
 session.resetModules();
 await session.settled();assert.deepEqual(errors,[]);
 for(const op of ['velvia','filmicrgb']) {
  const row=session.history.find(h=>h.op===op);
  assert.equal(session.moduleStates.get(instanceKey(row)).enabled,false,op+' survived Reset');
 }
 const params=await request({cmd:'get',modules:{exposure:['deflicker_percentile']}});
 assert.equal(params.modules.exposure.params.deflicker_percentile,params.modules.exposure.defaults.deflicker_percentile,'hidden exposure field survived Reset');
 const resetFrame=new Uint8ClampedArray(frame.pixels);
 // The same state restoration used by App's Undo, including fixed modules.
 session.setMany(Object.entries(values));
 for(const key of session.touched){const h=session.history.find(h=>instanceKey(h)===key);session.setModuleState(h,{restore:'opened'});}
 await session.settled();assert.deepEqual(errors,[]);
 assert.deepEqual(frame.pixels,before,'Undo did not restore the saved processing');
 // Reset once more, then push exposure to the screenshot's setting.
 session.setMany(Object.entries(session.neutral).filter(([id])=>!isModuleSetting(id)&&!['profile','exp_comp','orient'].includes(id)));
 session.resetModules();await session.settled();
 assert.deepEqual(frame.pixels,resetFrame,'repeated Reset changed its result');
 session.set('exposure',5);await session.settled();
 const h=computeHistogram(frame.pixels,frame.width,frame.height);
 assert.ok(h.highlightsClipped>0,'highlights still cannot reach white after Reset');
 console.log(JSON.stringify({photo:basename(photo),nativeModulesReset:true,hiddenFieldsReset:true,undoRestoresPixels:true,repeatableReset:true,highlightsClipped:h.highlightsClipped},null,2));
} finally {
 if(session)await session.close();
 await stopEngine();rmSync(work,{recursive:true,force:true});
}
