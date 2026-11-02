// SPDX-License-Identifier: GPL-3.0-or-later
// Integration check: independent global and local module choices survive saving.
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
const {localFields}=await import('../app/src/manifest.ts');
const {storeModuleMode,storeModuleChoice}=await import('../app/src/moduleChoice.ts');
const {mkdtempSync}=await import('node:fs');
const assert=(await import('node:assert/strict')).default;

const work=mkdtempSync('/tmp/immage-mask-modules-');
const photo=join(work,'photo.jpg');
copyFileSync(join(APP,'sample/stairs-to-mountain.jpg'),photo);
storeModuleMode('custom');
storeModuleChoice('contrast',0);
storeModuleChoice('contrast',2,'masks');
storeModuleChoice('texture',1);
storeModuleChoice('texture',0,'masks');
startEngine(join(HERE,'../build/bin/darktable-engine'),join(work,'runtime'));
let session;
const errors=[];
const open=()=>Session.open(photo,null,()=>({width:384,height:256}),()=>{},e=>errors.push(e));
try {
  session=await open();
  await session.settled();
  assert.equal(session.values.mod_contrast,0);
  session.set('contrast',20);
  session.addMask('mask 1',[{type:'ellipse',x:.5,y:.5,rx:.4,ry:.4,angle:0,feather:.1}]);
  assert.equal(session.masks[0].values.mod_contrast,2);
  assert.equal(session.masks[0].values.mod_texture,0);
  session.setLocal('mask 1','ce_0_2',.731);
  session.setLocal('mask 1','ce_4_5',.129);
  session.setLocal('mask 1','l_texture',10);
  await session.settled();
  assert.deepEqual(errors,[]);
  const raw=await request({cmd:'masks',fields:localFields()});
  const mask=(Array.isArray(raw)?raw:raw.masks).find(m=>m.name==='mask 1');
  assert.ok(mask.instances.atrous.enabled);
  assert.ok(Math.abs(mask.instances.atrous.params['y[0][2]']-.731)<1e-5);
  storeModuleChoice('contrast',1,'masks');
  storeModuleChoice('texture',1,'masks');
  session.refreshModuleChoices();
  assert.equal(session.masks[0].values.mod_contrast,2,'used mask contrast replaced');
  assert.equal(session.masks[0].values.mod_texture,0,'used mask texture replaced');
  await session.close();session=null;
  session=await open();
  await session.settled();
  assert.equal(session.values.mod_contrast,0,'mask changed global contrast');
  assert.equal(session.masks[0].values.mod_contrast,2,'saved mask lost equalizer selection');
  assert.equal(session.masks[0].values.mod_texture,0,'saved mask lost texture selection');
  assert.ok(Math.abs(session.masks[0].values.ce_0_2-.731)<1e-5,'saved curve lost precision');
  assert.ok(Math.abs(session.masks[0].values.ce_4_5-.129)<1e-5);
  assert.deepEqual(errors,[]);
  console.log('PASS: global AgX and masked equalizer render, save and reload independently');
} finally {
  if(session)await session.close();
  await stopEngine();
  rmSync(work,{recursive:true,force:true});
}
