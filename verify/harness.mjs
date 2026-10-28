// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the release checks: the app's own Session (app/src/session.ts) driven
// headless, every slider of every panel and of a mask moved and the frame
// it renders measured. run by verify/run.py, with one JSON argument:
//   { engine, work, photos: [path], rendered: raw, checks: [name], controls: [id], references, accept,
//     git, out }
// and writes `out`: every result, then the summary run.py reports
import { createRequire, registerHooks } from "node:module";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
         constants } from "node:fs";
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

const args = JSON.parse(process.argv[2]);
const { startEngine, stopEngine, request, requestTagged, invoke, sent, models, screen, enginePid, FRAME_HEAD } = await import(SHIM);
const { Session, framePlace } = await import("../app/src/session.ts");
const { withModel } = await import("../app/src/aiModel.ts");
const m = await import("../app/src/manifest.ts");
const { canMerge } = await import("../app/src/localMerge.ts");
const { aiRefine, overlayPixels, overlayShown, overlayStep, readsBackdrop } = await import("../app/src/masks.ts");
const { fieldKeeps } = await import("../app/src/keys.ts");
const { ILLUMINANT_D } = await import("../app/src/wb.ts");
const { autoTone } = await import("../app/src/autoTone.ts");
const { dueIn } = await import("../app/src/activity.ts");
const { byCaptureTime, withKnown } = await import("../app/src/library.ts");
const { NO_FILTER, exposureLabel, facetsWithin, passes } = await import("../app/src/filter.ts");
const z = await import("../app/src/zones.ts");
const nd = await import("../app/src/negadoctor.ts");
const { compare, chromaChange, meanChroma, inEllipse, rightOf } = await import("./metrics.mjs");
const { THRESHOLD, GLOBAL, COMPOSITE, LOCAL, trialValues, judge } = await import("./expect.mjs");

const VIEW = { width: 1024, height: 1024 };
// `controls`: only these, by id, to look into one
const wanted = (id) => !args.controls?.length || args.controls.includes(id);
const log = (...a) => process.stderr.write(a.join(" ") + "\n");
const results = [];
const record = (r) => {
  results.push(r);
  if (r.status === "fail") log(`  FAIL ${r.check} ${r.id} (${r.photo}): ${r.detail}`);
};

// the engine as the app runs it: edits on the GPU, as by default since
// 0.39.0, unless run.py's --cpu asks for Edit on the GPU off. a darktable
// with no OpenCL device renders on the CPU either way
const GPU = !args.cpu;
const startApp = (home, modelsDir = null, opts = {}) => startEngine(args.engine, home, modelsDir, { gpu: GPU, ...opts });

let engineHome = join(args.work, "runtime");
startApp(engineHome);

// a copy of the photo no edit has touched: each open gets its own folder,
// as the engine keeps what it opened in its library for the rest of its run
let copies = 0;
function fresh(photo) {
  const dir = join(args.work, "photos", String(++copies));
  mkdirSync(dir, { recursive: true });
  const to = join(dir, basename(photo));
  copyFileSync(photo, to, constants.COPYFILE_FICLONE);
  return to;
}

// a photo opened as the app opens it (App.tsx, openFile): a new one gets
// AgX, and a raw darktable's capture sharpening. the new-photos preset and
// profile are left out, being Preferences'
async function open(path) {
  let last = null;
  const errors = [];
  const o = { view: VIEW };
  const s = await Session.open(path, null, () => o.view, (f) => { last = f; }, (e) => errors.push(e));
  s.previewMode = () => "quality";
  // drafts at the view's size, however long they take
  s.draftLimits = () => ({ target: 60, smallest: 1 });
  if (!s.wasEdited) {
    const defaults = [];
    if (s.values.tm_mode !== 1) defaults.push(["tm_mode", 1]);
    if (s.raw) defaults.push(["capture", 1]);
    if (defaults.length) s.setMany(defaults);
  }
  // Session stops pumping on an engine error, which it hands to onError,
  // so settled() alone would wait for ever
  const frame = async () => {
    while (!s.idle && !errors.length) await new Promise((r) => setTimeout(r, 20));
    if (errors.length) throw new Error(errors.splice(0).join("; "));
    return last;
  };
  // every change gets a frame of its own, as a slider's release does
  const after = async (change) => {
    last = null;
    change();
    s.requestRender();
    return frame();
  };
  return Object.assign(o, { s, frame, after, base: await frame() });
}

// a 1024 px window at 100% around (cx, cy) of the photo, where sharpening
// and noise reduction show; the frame it starts from
async function zoomed(o, cx = 0.5, cy = 0.5) {
  const { fullWidth: w, fullHeight: h } = o.base;
  o.view = { ...VIEW, scale: 1, x: Math.max(0, Math.round(cx * w - 512)), y: Math.max(0, Math.round(cy * h - 512)) };
  return o.after(() => {});
}

const controls = () => {
  const seen = new Set(), out = [];
  for (const p of m.panels) for (const sec of p.sections ?? []) for (const c of sec.controls ?? []) {
    const cc = typeof c === "string" ? m.controlById.get(c) : c;
    if (cc && !seen.has(cc.id)) { seen.add(cc.id); out.push(cc); }
  }
  return out;
};

// a control the photo's tool runs on: one of Highlights' maps is the
// tone equalizer, the other shadows and highlights, and only the chosen one
// takes a move
const active = (s, id) => m.mapsWith(id).some((map) => m.choiceOn(map, s.values));
const activeLocal = (s, id) => m.localMaps.some((map) => map.controls.includes(id) && m.choiceOn(map, s.values));

const optionsOf = (c) => (c.optionGroups ? c.optionGroups.flatMap(([, o]) => o) : c.options ?? []).map(([, v]) => v);

// one control's trials: set what it needs, try each value, put it all back
async function trialGlobal(o, photo, c, spec, check) {
  const { s } = o;
  const id = c.id;
  const prior = Object.fromEntries([id, ...Object.keys(spec.with ?? {})].map((k) => [k, s.values[k]]));
  const start = spec.detail ? await zoomed(o) : o.base;
  try {
  const ref = spec.with ? await o.after(() => s.setMany(Object.entries(spec.with))) : start;
  const current = s.values[id];
  const values = c.kind === "choice" ? optionsOf(c).filter((v) => v !== current)
    : c.kind === "toggle" ? [current ? 0 : 1] : trialValues(c, spec, current);
  const trials = [];
  let failed = null;
  for (const v of values) {
    const f = await o.after(() => s.set(id, v));
    const d = compare(f, ref);
    const err = spec.mono ? (meanChroma(f) < 1.5 ? null : `still in color (mean chroma ${meanChroma(f).toFixed(2)})`)
      : judge(c.kind === "choice" ? {} : spec, d, v > current ? 1 : -1);
    trials.push({ value: v, ...d, ...(err ? { error: err } : {}) });
    failed ??= err && `${v}: ${err}`;
  }
  const back = await o.after(() => s.setMany(Object.entries(prior)));
  const r = compare(back, start);
  if (!failed && !(r.mad <= THRESHOLD.reset)) failed = `put back, the frame stays different (mean |Δ| ${r.mad})`;
  record({ check, photo, id, status: failed ? "fail" : "pass", detail: failed ?? "", trials,
           anyPhoto: !!spec.anyPhoto });
  } finally {
    o.view = VIEW;
  }
}

async function sliders(photo) {
  const o = await open(fresh(photo));
  for (const c of controls()) {
    if (!wanted(c.id)) continue;
    const spec = GLOBAL[c.id] ?? {};
    const base = { check: "sliders", photo: basename(photo), id: c.id };
    if (spec.skip) { record({ ...base, status: "skip", detail: spec.skip }); continue; }
    if (!m.mapOf.has(c.id)) { record({ ...base, status: "fail", detail: "no module map in manifest.ts" }); continue; }
    if ((c.rawOnly || spec.raw) && !o.s.raw) { record({ ...base, status: "skip", detail: "raws only" }); continue; }
    if (!active(o.s, c.id)) { record({ ...base, status: "skip", detail: "not the photo's module: the choices check covers it" }); continue; }
    try { await trialGlobal(o, basename(photo), c, spec, "sliders"); }
    catch (e) { record({ ...base, status: "fail", detail: String(e) }); }
  }
  for (const [id, spec] of Object.entries(COMPOSITE)) {
    if (!wanted(id)) continue;
    const base = { check: "sliders", photo: basename(photo), id };
    try {
      const prior = Object.fromEntries(Object.keys(spec.set).map((k) => [k, o.s.values[k]]));
      const f = await o.after(() => o.s.setMany(Object.entries(spec.set)));
      const d = compare(f, o.base);
      const err = spec.geometry ? (d.geometry ? null : "the frame kept its size") : judge(spec, d, 1);
      const back = await o.after(() => o.s.setMany(Object.entries(prior)));
      const r = compare(back, o.base);
      const failed = err ?? (r.mad <= THRESHOLD.reset ? null : `put back, the frame stays different (mean |Δ| ${r.mad})`);
      record({ ...base, status: failed ? "fail" : "pass", detail: failed ?? "", trials: [d] });
    } catch (e) { record({ ...base, status: "fail", detail: String(e) }); }
  }
  await o.s.close();
}

// a mask: an ellipse on the left of the photo. its sliders are judged on
// the middle of the ellipse, and must leave the right of the photo alone
const MASK = { type: "ellipse", x: 0.25, y: 0.5, rx: 0.18, ry: 0.18, angle: 0, feather: 0.05 };
const INSIDE = inEllipse(0.25, 0.5, 0.12);
const OUTSIDE = rightOf(0.6);

async function trialLocal(o, photo, name, c, spec, check) {
  const { s } = o;
  const id = c.id;
  const values = (name0) => s.masks.find((x) => x.name === name0).values;
  const prior = Object.fromEntries([id, ...Object.keys(spec.with ?? {})].map((k) => [k, values(name)[k]]));
  // a detail tool on a 100% crop in the middle of the mask, all of it inside
  const start = spec.detail ? await zoomed(o, MASK.x, MASK.y) : o.masked;
  try {
  const ref = spec.with
    ? await o.after(() => { for (const [k, v] of Object.entries(spec.with)) s.setLocal(name, k, v); })
    : start;
  const trials = [];
  let failed = null;
  for (const v of trialValues(c, spec, 0)) {
    const f = await o.after(() => s.setLocal(name, id, v));
    const dIn = compare(f, ref, spec.detail ? null : INSIDE);
    const dOut = spec.detail ? { mad: 0 } : compare(f, ref, OUTSIDE);
    const err = judge(spec, dIn, v > 0 ? 1 : -1)
      ?? (dOut.mad > THRESHOLD.outside ? `changed the photo outside the mask (mean |Δ| ${dOut.mad})` : null);
    trials.push({ value: v, inside: dIn, outside: dOut, ...(err ? { error: err } : {}) });
    failed ??= err && `${v}: ${err}`;
  }
  const back = await o.after(() => { for (const [k, v] of Object.entries(prior)) s.setLocal(name, k, v); });
  const r = compare(back, start);
  if (!failed && !(r.mad <= THRESHOLD.reset)) failed = `put back, the frame stays different (mean |Δ| ${r.mad})`;
  record({ check, photo, id, status: failed ? "fail" : "pass", detail: failed ?? "", trials,
           anyPhoto: !!spec.anyPhoto });
  } finally {
    o.view = VIEW;
  }
}

async function maskOpen(photo) {
  const o = await open(fresh(photo));
  o.masked = await o.after(() => o.s.addMask("Verify", [MASK]));
  return o;
}

async function localSliders(o, photo, check, only = null) {
  for (const c of m.LOCAL_CONTROLS) {
    if ((only && !only.includes(c.id)) || !wanted(c.id)) continue;
    const spec = LOCAL[c.id] ?? {};
    const base = { check, photo, id: c.id };
    if (!activeLocal(o.s, c.id)) { record({ ...base, status: "skip", detail: "not the photo's module: the choices check covers it" }); continue; }
    try { await trialLocal(o, photo, "Verify", c, spec, check); }
    catch (e) { record({ ...base, status: "fail", detail: String(e) }); }
  }
}

async function masks(photo) {
  const name = basename(photo);
  let o = await maskOpen(photo);
  await localSliders(o, name, "masks");
  await o.s.close();

  // three masks sharing color balance rgb's instances (localMerge.ts), each
  // still brightening only its own ellipse
  o = await open(fresh(photo));
  // each mask drawn, then given its sliders, with a frame between as in the
  // app
  const spots = [0.2, 0.5, 0.8];
  let f;
  for (const [i, x] of spots.entries()) {
    await o.after(() => o.s.addMask(`M${i}`, [{ ...MASK, x, rx: 0.1, ry: 0.1 }]));
    f = await o.after(() => {
      o.s.setLocal(`M${i}`, "l_exposure", 0.8);
      o.s.setLocal(`M${i}`, "l_saturation", 40);
      o.s.setLocal(`M${i}`, "l_contrast", 30);
    });
  }
  spots.forEach((x, i) => {
    const d = compare(f, o.base, inEllipse(x, 0.5, 0.06));
    const err = judge({ expect: { lum: 1 } }, d, 1);
    record({ check: "masks", photo: name, id: `shared mask ${i + 1} of 3`, status: err ? "fail" : "pass",
             detail: err ?? "", trials: [d] });
  });
  const top = (x, y) => y < 0.12;
  const still = compare(f, o.base, top);
  record({ check: "masks", photo: name, id: "shared masks leave the rest", status: still.mad <= THRESHOLD.outside ? "pass" : "fail",
           detail: still.mad <= THRESHOLD.outside ? "" : `the top of the photo changed (mean |Δ| ${still.mad})`, trials: [still] });
  // inverted, the third mask's adjustment moves to everywhere but its ellipse
  const inv = await o.after(() => o.s.setInvert("M2", true));
  const dTop = compare(inv, f, top);
  const errInv = judge({ expect: { lum: 1 } }, dTop, 1);
  record({ check: "masks", photo: name, id: "inverted mask", status: errInv ? "fail" : "pass", detail: errInv ?? "", trials: [dTop] });
  await o.s.close();

  // a luminance range alone, from 3 EV under middle gray up: darkening the
  // bright parts more than the dark ones
  o = await open(fresh(photo));
  await o.after(() => o.s.addMask("Bright", [{ type: "luminance", lo: -3, hi: null, feather: 1 }]));
  const lr = await o.after(() => o.s.setLocal("Bright", "l_exposure", -1));
  const d = compare(lr, o.base);
  const err = judge({ expect: { lum: -1 } }, d, 1)
    ?? (d.lumHi !== null && d.lumLo !== null && !(d.lumHi < d.lumLo) ? `the shadows darkened as much as the highlights (${d.lumLo} vs ${d.lumHi})` : null);
  record({ check: "masks", photo: name, id: "luminance range", status: err ? "fail" : "pass", detail: err ?? "", trials: [d] });
  await o.s.close();

  // a mask drawn and given a slider while the engine still takes another
  // mask's shape: its slider must not reach the engine ahead of its shape,
  // which stopped Session on "no mask" before 0.33.0 (sendMaskQueues)
  o = await open(fresh(photo));
  sent.hook = (cmd, a) => {
    if (cmd !== "mask_shapes" || a.name !== "First") return;
    sent.hook = null;
    o.s.addMask("Second", [{ ...MASK, x: 0.75 }]);
    o.s.setLocal("Second", "l_exposure", 0.8);
  };
  try {
    const both = await o.after(() => { o.s.addMask("First", [MASK]); o.s.setLocal("First", "l_exposure", 0.8); });
    for (const [i, x] of [0.25, 0.75].entries()) {
      const dm = compare(both, o.base, inEllipse(x, 0.5, 0.06));
      const e = judge({ expect: { lum: 1 } }, dm, 1);
      record({ check: "masks", photo: name, id: `mask added mid-send, ${i ? "second" : "first"}`, status: e ? "fail" : "pass",
               detail: e ?? "", trials: [dm] });
    }
  } catch (e) {
    record({ check: "masks", photo: name, id: "mask added mid-send", status: "fail", detail: String(e) });
  } finally {
    sent.hook = null;
  }
  await o.s.close();
}

// one check's result from `run`, which returns what went wrong or null
async function outcome(check, photo, id, run) {
  try {
    const err = await run();
    record({ check, photo, id, status: err ? "fail" : "pass", detail: err ?? "" });
  } catch (e) {
    record({ check, photo, id, status: "fail", detail: String(e?.stack ?? e) });
  }
}

// the engine started again, as the app quitting and starting again
async function restart() {
  await stopEngine();
  startApp(engineHome);
}

// once the engine has done what was asked before, a save Session made on
// its own timer included
const drained = () => request({ cmd: "version" });

const brighter = (f, ref, region = null) => judge({ expect: { lum: 1 } }, compare(f, ref, region), 1);

// a region of the pixels well inside an AI object's outlines (`inside`), or
// well outside them: even-odd over the paths' corners, the same answer 2%
// of the frame either way. masks.ts's maskAt() needs a canvas, which Node
// lacks
function inPaths(paths, inside) {
  const polys = paths.map((p) => p.points.map((c) => [c[0], c[1]]));
  const at = (x, y) => {
    let c = false;
    for (const P of polys) for (let i = 0, j = P.length - 1; i < P.length; j = i++)
      if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
    return c;
  };
  return (x, y) => [[0, 0], [0.02, 0], [-0.02, 0], [0, 0.02], [0, -0.02]].every(([a, b]) => at(x + a, y + b) === inside);
}

// a zip of `files` ({ name: text }), stored, as a .dtmodel is laid out
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    local.push(head, n, data);
    central.push(dir, n);
    offset += 30 + n.length + data.length;
  }
  const size = central.reduce((a, b) => a + b.length, 0), count = Object.keys(files).length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// bugs fixed before these checks existed, each named for the release that
// fixed it (README, "When a bug is fixed")
// every hue (HSV, 85% saturated, value 0.8) left to right, two columns a
// degree, as an 8-bit RGB TIFF: a photo has too few hues to tell the HSL
// bands apart
function hueStrip() {
  const path = join(args.work, "strip", "hues.tif");
  if (existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true });
  const w = 720, h = 120, data = 140;
  const px = Buffer.alloc(data + w * h * 3);
  for (let x = 0; x < w; x++) {
    const hue = (x + 0.5) / 2 / 60, s = 0.85, v = 0.8;
    const f = (n) => { const k = (n + hue) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
    for (let y = 0; y < h; y++) [f(5), f(3), f(1)].forEach((c, i) => { px[data + 3 * (y * w + x) + i] = Math.round(255 * c); });
  }
  // the header, one IFD at 8 and the three BitsPerSample at 134
  px.write("II", 0, "latin1");
  px.writeUInt16LE(42, 2);
  px.writeUInt32LE(8, 4);
  const tags = [[256, 3, 1, w], [257, 3, 1, h], [258, 3, 3, 134], [259, 3, 1, 1], [262, 3, 1, 2], [273, 4, 1, data],
                [277, 3, 1, 3], [278, 3, 1, h], [279, 4, 1, w * h * 3], [284, 3, 1, 1]];
  px.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, count, value], i) => {
    const at = 10 + 12 * i;
    px.writeUInt16LE(tag, at);
    px.writeUInt16LE(type, at + 2);
    px.writeUInt32LE(count, at + 4);
    if (type === 3 && count === 1) px.writeUInt16LE(value, at + 8); else px.writeUInt32LE(value, at + 8);
  });
  px.writeUInt32LE(0, 10 + 12 * tags.length);
  for (let i = 0; i < 3; i++) px.writeUInt16LE(8, 134 + 2 * i);
  writeFileSync(path, px);
  return path;
}

// the strip's mean chroma (max - min) and luma at an HSV hue, over the
// columns within 2° of it and the middle half of the rows
function bandAt(f, hue) {
  const { width: w, height: h, pixels: p } = f;
  let n = 0, chroma = 0, luma = 0;
  for (let y = Math.floor(h / 4); y < Math.ceil((3 * h) / 4); y++) for (let x = 0; x < w; x++) {
    const d = Math.abs((((x + 0.5) / w) * 360 - hue + 540) % 360 - 180);
    if (d > 2) continue;
    const i = 4 * (y * w + x);
    chroma += Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]);
    luma += 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
    n++;
  }
  return { chroma: Math.round(chroma / n), luma: Math.round(luma / n) };
}

async function fixes(photo) {
  const fix = (id, run) => outcome("fixes", basename(photo), id, run);

  // 0.38.0: on Linux the engine never exited after quit. its stdin reader
  // waited in fgets(), holding stdin's lock, which glibc's exit() takes to
  // flush every stream (main.c, _read_line); the app killed it after 5 s
  if (photo === args.photos[0]) await fix("the engine exits after quit", async () => {
    const gone = await stopEngine();
    startApp(engineHome);
    return gone ? null : "still running 5 s after quit";
  });

  // 0.39.0: with edits on the GPU, Auto and every other sample of the
  // working-space image failed with "the working-space image is not at
  // hand": the sample pipe became a GPU one too, and darktable keeps no GPU
  // output in the pipe cache unless it is the last edited module's input
  // (main.c, _working_at). once, on the first raw, where OpenCL works
  if (photo === args.photos.find((p) => /\.(arw|cr2|cr3|nef|nrw|orf|pef|raf|rw2|srw)$/i.test(p))) {
    await stopEngine();
    startApp(join(args.work, "gpu-engine"), null, { gpu: true });
    const cl = await request({ cmd: "opencl" });
    if (!cl.running) record({ check: "fixes", photo: basename(photo), id: "samples on the GPU", status: "skip",
                              detail: "no OpenCL here" });
    else await fix("samples on the GPU", async () => {
      const o = await open(fresh(photo));
      await o.frame();
      const failed = [];
      const zones = join(args.work, "gpu-zones.bin");
      for (const [what, req] of [["Auto", { cmd: "agx_auto" }], ["sample", { cmd: "sample", x: 0.5, y: 0.5 }],
                                 ["zones before", { cmd: "zones", stage: "before", out: zones }],
                                 ["zones after", { cmd: "zones", stage: "after", out: zones }],
                                 ["zones unplaced", { cmd: "zones", stage: "unplaced", out: zones }],
                                 ["Upright", { cmd: "upright", mode: "auto", aspect: 1 }]]) {
        try { await request(req); } catch (e) { failed.push(`${what}: ${e.message}`); }
      }
      await o.s.close();
      return failed.length ? failed.join("; ") : null;
    });
    await restart();
  }

  // 0.37.0: HSL's Saturation was twice Lightroom's strength, -50 already
  // gray, and its bands sat on the color equalizer's nodes, not at
  // Lightroom's hues (colorequal.ts). with Blue at -100, Aqua did nothing to
  // the hues between them, or grayed them further; Purple, not Blue, grayed
  // blue; and Luminance or the B&W Mix at -100 turned a saturated red black
  if (photo === args.photos[0]) {
    const strip = hueStrip();
    await fix("HSL Blue grays blue, more than Purple", async () => {
      const o = await open(fresh(strip));
      const blue = bandAt(await o.after(() => o.s.set("hsl_sat_blue", -100)), 240);
      const purple = bandAt(await o.after(() => o.s.setMany([["hsl_sat_blue", 0], ["hsl_sat_lavender", -100]])), 240);
      await o.s.close();
      return blue.chroma < purple.chroma ? null
        : `at blue, Blue -100 left chroma ${blue.chroma} and Purple -100 ${purple.chroma}`;
    });
    await fix("HSL Aqua works with Blue at -100", async () => {
      const o = await open(fresh(strip));
      const gray = await o.after(() => o.s.set("hsl_sat_blue", -100));
      const aqua = await o.after(() => o.s.set("hsl_sat_cyan", 100));
      await o.s.close();
      const [g200, a200, g225, a225] = [bandAt(gray, 200), bandAt(aqua, 200), bandAt(gray, 225), bandAt(aqua, 225)];
      return a200.chroma < g200.chroma + 5 ? `at HSV 200, Aqua +100 took chroma from ${g200.chroma} to ${a200.chroma}`
        : a225.chroma < g225.chroma - 2 ? `at HSV 225, Aqua +100 lowered chroma from ${g225.chroma} to ${a225.chroma}`
        : null;
    });
    await fix("HSL Luminance -100 keeps red", async () => {
      const o = await open(fresh(strip));
      const was = bandAt(o.base, 0), red = bandAt(await o.after(() => o.s.set("hsl_lum_red", -100)), 0);
      await o.s.close();
      return red.luma >= 0.25 * was.luma ? null : `red went from luma ${was.luma} to ${red.luma}`;
    });
    await fix("B&W Mix -100 keeps red", async () => {
      const o = await open(fresh(strip));
      const was = bandAt(await o.after(() => o.s.set("bw_mode", 1)), 0);
      const red = bandAt(await o.after(() => o.s.set("bw_red", -100)), 0);
      await o.s.close();
      return red.luma >= 0.25 * was.luma ? null : `red's gray went from luma ${was.luma} to ${red.luma}`;
    });
    // a band set in darktable or before 0.37.0 reads as a mix of sliders,
    // some past ±100 (manifest.ts, readsPast): Luminance -100 then, which
    // turned red black, is about -200 now. clamped, the next edit rewrote
    // the band at half its effect, and red came back
    await fix("an older HSL band stays as it was at the next edit", async () => {
      const path = fresh(strip);
      await request({ cmd: "open", path, imgid: -1 });
      await request({ cmd: "set", op: "colorequal", params: { bright_red: 0.5 }, enabled: true });
      await request({ cmd: "save" });
      const o = await open(path);
      const next = await o.after(() => { o.s.endBaseline(); o.s.set("hsl_lum_cyan", 10); });
      await o.s.close();
      const a = bandAt(o.base, 0), b = bandAt(next, 0);
      return Math.abs(b.luma - a.luma) > 3 ? `red went from luma ${a.luma} to ${b.luma}` : null;
    });
  }

  // 0.37.0: Clarity switched local contrast on at its default 50% shadows
  // and highlights (manifest.ts, clarityMap), so ±1 flattened the photo
  // more than ±10 did
  await fix("Clarity at ±1 changes less than at ±10", async () => {
    const o = await open(fresh(photo));
    const mad = async (v) => compare(await o.after(() => o.s.set("clarity", v)), o.base).mad;
    const [p1, p10, n1, n10] = [await mad(1), await mad(10), await mad(-1), await mad(-10)];
    await o.s.close();
    return p1 < p10 / 3 && n1 < n10 / 3 ? null
      : `the frame changed by ${p1.toFixed(2)} at +1 and ${p10.toFixed(2)} at +10, ${n1.toFixed(2)} at -1 and ${n10.toFixed(2)} at -10`;
  });

  // 0.39.0: the photo moved when a slider was let go. the app drew a frame
  // as if darktable's pixels showed the image at their middles, where they
  // show it at their corners, and took a fitted frame's scale from its
  // rounded width (session.ts, framePlace): the half-size draft sat half a
  // pixel or more off the full frame. here the draft is drawn as the app
  // draws it, and the full frame must match it best unshifted
  await fix("a drag's draft lines up with the full frame", async () => {
    const o = await open(fresh(photo));
    try {
      const full = await o.after(() => o.s.set("exposure", 0.3));
      o.view = { width: VIEW.width / 2, height: VIEW.height / 2, draft: true };
      const draft = await o.after(() => {});
      const z = Math.min(1, VIEW.width / full.fullWidth, VIEW.height / full.fullHeight);
      const pf = framePlace(full, z), pd = framePlace(draft, z);
      const luma = (f, i) => 0.2126 * f.pixels[i] + 0.7152 * f.pixels[i + 1] + 0.0722 * f.pixels[i + 2];
      // the draft at a screen point, bilinear as the web view enlarges it
      const at = (sx, sy) => {
        const u = Math.min(Math.max((sx - pd.x) / pd.k - 0.5, 0), draft.width - 1.001);
        const v = Math.min(Math.max((sy - pd.y) / pd.k - 0.5, 0), draft.height - 1.001);
        const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j;
        const p = (x, y) => luma(draft, 4 * (y * draft.width + x));
        return (1 - b) * ((1 - a) * p(i, j) + a * p(i + 1, j)) + b * ((1 - a) * p(i, j + 1) + a * p(i + 1, j + 1));
      };
      const mad = (dx, dy) => {
        let n = 0, sum = 0;
        for (let y = 16; y < full.height - 16; y++) for (let x = 16; x < full.width - 16; x++) {
          const sx = pf.x + (x + 0.5) * pf.k + dx, sy = pf.y + (y + 0.5) * pf.k + dy;
          sum += Math.abs(luma(full, 4 * (y * full.width + x)) - at(sx, sy));
          n++;
        }
        return sum / n;
      };
      let best = { dx: 0, dy: 0, d: mad(0, 0) };
      for (const dx of [-0.5, 0, 0.5]) for (const dy of [-0.5, 0, 0.5]) {
        const d = mad(dx, dy);
        if (d < best.d) best = { dx, dy, d };
      }
      return !best.dx && !best.dy ? null
        : `the draft matches the full frame best moved ${best.dx}, ${best.dy} screen pixels`;
    } finally {
      o.view = VIEW;
      await o.s.close();
    }
  });

  // 0.34.0: darktable's AI models were unpacked with the system's unzip,
  // which Arch and CachyOS do not install, so AI Denoise and Select Object
  // never got theirs. the engine unpacks now, into a models folder reached
  // through a symlink (macOS' /var, a moved home folder), and refuses an
  // entry that climbs out of it
  await fix("AI models unpack without unzip", async () => {
    const root = join(args.work, "unpack");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "real"), { recursive: true });
    symlinkSync(join(root, "real"), join(root, "link"));
    const good = join(root, "good.dtmodel"), bad = join(root, "bad.dtmodel");
    writeFileSync(good, zip({ "m/config.json": "{ \"id\": \"m\" }" }));
    writeFileSync(bad, zip({ "../escaped.txt": "out" }));
    const into = join(root, "link", "models");
    const err = await request({ cmd: "unpack", archive: good, dir: into }).then(() => null, (e) => e.message);
    if (err) return `unpacking failed: ${err}`;
    const got = existsSync(join(root, "real", "models", "m", "config.json"))
      && readFileSync(join(root, "real", "models", "m", "config.json"), "utf8");
    if (got !== "{ \"id\": \"m\" }") return `the unpacked config.json reads ${JSON.stringify(got)}`;
    const refused = await request({ cmd: "unpack", archive: bad, dir: into }).then(() => false, () => true);
    return !refused || existsSync(join(root, "link", "escaped.txt")) ? "an entry with .. was unpacked" : null;
  });

  // 0.34.0: a model whose unpack was cut short kept its config.json, so it
  // counted as installed and never loaded: Select Object failed until the
  // app's data folder was deleted. a model that won't load is downloaded
  // again (aiModel.ts), and the same engine then loads it. on the first
  // photo only: it encodes the photo with SAM on the CPU
  const SAM = "mask-object-sam21-small";
  if (photo === args.photos[0]) {
    if (!args.models || !existsSync(join(args.models, SAM, "config.json"))) {
      record({ check: "fixes", photo: basename(photo), id: "AI model that won't load downloads again", status: "skip",
               detail: `no ${SAM} in build/ai-models: use Select Object once in a dev build` });
    } else await fix("AI model that won't load downloads again", async () => {
      const dir = join(args.work, "models");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, SAM), { recursive: true });
      copyFileSync(join(args.models, SAM, "config.json"), join(dir, SAM, "config.json"));
      writeFileSync(join(dir, SAM, "encoder.onnx"), readFileSync(join(args.models, SAM, "encoder.onnx")).subarray(0, 1 << 20));
      models.source = args.models;
      // an engine of its own, so the others' config never has AI on
      await stopEngine();
      startApp(join(args.work, "ai-engine"), dir);
      try {
        await request({ cmd: "open", path: fresh(photo), imgid: -1 });
        const paths = await withModel(SAM, () => invoke("ai_object", { points: [[0.5, 0.5, 1]], box: null }));
        return paths?.length ? null : "Select Object found nothing once the model was downloaded again";
      } finally {
        await restart();
      }
    });
  }

  // 0.10.1: a second mask of a kind renames the first, and the Before view
  // sends every mask again; the rename never reached the engine, so that
  // failed on "no mask". shim.mjs refuses a command main.rs lacks, which
  // this one was
  await fix("renamed mask, Before view", async () => {
    const o = await open(fresh(photo));
    await o.after(() => o.s.addMask("Linear", [MASK]));
    await o.after(() => o.s.setLocal("Linear", "l_exposure", 0.8));
    await o.after(() => { o.s.renameMask("Linear", "Linear 1"); o.s.addMask("Linear 2", [{ ...MASK, x: 0.75 }]); });
    await o.after(() => o.s.showBefore(() => false));
    const f = await o.after(() => o.s.showBefore(null));
    await o.s.close();
    return brighter(f, o.base, inEllipse(0.25, 0.5, 0.06));
  });

  // 0.10.1: a deleted mask left its instances, switched off, and its
  // shapes in the saved history
  await fix("deleted mask leaves the sidecar", async () => {
    const path = fresh(photo);
    const o = await open(path);
    await o.after(() => o.s.addMask("Gone", [MASK]));
    await o.after(() => o.s.setLocal("Gone", "l_exposure", 0.8));
    await o.after(() => o.s.deleteMask("Gone"));
    await o.s.close();
    await drained();
    return readFileSync(sidecar(path), "utf8").includes("Gone") ? "the sidecar still names the deleted mask" : null;
  });

  // 0.10.1: quitting within 600 ms of an edit, ahead of the client's save,
  // lost it. the engine saves on quitting, but never the Before view's
  // settings
  await fix("quitting saves the last edit", async () => {
    const path = fresh(photo);
    let o = await open(path);
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.9); });
    clearTimeout(o.s.saveTimer);
    await restart();
    o = await open(path);
    const got = o.s.values.exposure;
    await o.after(() => o.s.showBefore(() => false));
    clearTimeout(o.s.saveTimer);
    await restart();
    o = await open(path);
    const kept = o.s.values.exposure;
    await o.s.close();
    return Math.abs(got - 0.9) > 0.01 ? `the edit made just before quitting was lost (Exposure ${got})`
      : Math.abs(kept - 0.9) > 0.01 ? `quitting in the Before view saved its settings (Exposure ${kept})` : null;
  });

  // 0.11.0: a range mask whose first drawn shape subtracts selected the
  // shape inside the range, not the range less the shape
  await fix("subtract from a luminance range", async () => {
    const o = await open(fresh(photo));
    await o.after(() => o.s.addMask("Range", [{ type: "luminance", lo: -3, hi: null, feather: 1 },
                                              { ...MASK, mode: "subtract" }]));
    const f = await o.after(() => o.s.setLocal("Range", "l_exposure", -1));
    await o.s.close();
    const hole = compare(f, o.base, INSIDE);
    return judge({ expect: { lum: -1 } }, compare(f, o.base, OUTSIDE), 1)
      ?? (hole.mad > THRESHOLD.outside ? `changed the subtracted ellipse (mean |Δ| ${hole.mad})` : null);
  });

  // 0.22.0: a warm daylight white balance, as some cameras' as-shot one
  // is, read as 25000 K: below 4000 K darktable renders the black body
  await fix("warm daylight white balance", async () => {
    const path = fresh(photo);
    await request({ cmd: "open", path, imgid: -1 });
    await request({ cmd: "set", op: "channelmixerrgb", params: { illuminant: ILLUMINANT_D, temperature: 3200 },
                    enabled: true });
    await request({ cmd: "save" });
    const o = await open(path);
    const { temp, tint } = o.s.values;
    const f = await o.after(() => o.s.setMany([["temp", temp], ["tint", 0]]));
    await o.s.close();
    const d = compare(f, o.base);
    return Math.abs(temp - 3200) > 100 ? `3200 K daylight reads as ${Math.round(temp)} K, tint ${tint}`
      : d.mad > THRESHOLD.roundtrip ? `Temp ${temp} renders differently from the daylight it was read from (mean |Δ| ${d.mad})`
      : null;
  });

  // 0.25.2: masks are kept in the shown frame, which a crop changes: they
  // are read back once the engine has the crop, and an undo sends the old
  // crop ahead of the old shapes, which are in its frame. the undo comes
  // while a frame renders, so both wait for the pump's next round
  await fix("masks follow a crop", async () => {
    const o = await open(fresh(photo));
    const spot = { ...MASK, x: 0.15, rx: 0.05, ry: 0.05, feather: 0.02 };
    await o.after(() => o.s.addMask("Spot", [spot]));
    await o.after(() => o.s.setLocal("Spot", "l_exposure", 1));
    await o.after(() => o.s.set("crop_l", 0.1));
    const x = o.s.masks[0].shapes[0].x, want = (0.15 - 0.1) / 0.9;
    const f = await o.after(() => { o.s.requestRender(); o.s.set("crop_l", 0); o.s.setShapes("Spot", [spot]); });
    await o.s.close();
    if (Math.abs(x - want) > 0.01) return `cropped, the mask is at x ${x.toFixed(3)}, not ${want.toFixed(3)}`;
    return brighter(f, o.base, inEllipse(0.15, 0.5, 0.02)) && "the crop undone, the mask is not where it was drawn";
  });

  // 0.24.2: a whole-image base stopped by an edit was still shown when its
  // frame came in after the edit
  await fix("stopped base not shown", async () => {
    const o = await open(fresh(photo));
    let shown = 0;
    o.s.onThumb = () => shown++;
    sent.hook = (cmd, a) => {
      if (cmd !== "render" || !a.base) return;
      sent.hook = null;
      o.s.set("exposure", 1);
    };
    try {
      const f = await o.after(() => o.s.requestThumb());
      return shown ? "the stopped base was shown"
        : brighter(f, o.base) && "the edit that stopped the base is not in the frame";
    } finally {
      sent.hook = null;
      await o.s.close();
    }
  });

  // 0.30.0: export reads the edit from the library, and with the Before
  // view up it exported the view's settings
  await fix("export in the Before view", async () => {
    const o = await open(fresh(photo));
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 1); });
    const exported = async (tag) => {
      const out = join(args.work, "export", `${copies}-${tag}.jpg`);
      mkdirSync(dirname(out), { recursive: true });
      await request({ cmd: "export", imgid: o.s.imgid, out, format: "jpeg", color_space: "srgb", quality: 90,
                      long_edge: 512 });
      // the image data alone: the EXIF carries the time of export
      const file = readFileSync(out);
      return file.subarray(file.indexOf(Buffer.from([0xff, 0xda])));
    };
    const edit = await exported("edit");
    await o.after(() => o.s.showBefore(() => false));
    const before = await exported("before");
    await o.s.close();
    return edit.equals(before) ? null : "the export has the Before view's settings, not the edit";
  });

  // 0.37.0: an export carried the camera's serial numbers (Flickr showed
  // them): darktable copies the raw's EXIF, makernotes and all. the dialog
  // now sends serials: false unless Metadata's box is ticked, and the
  // engine takes them out of the written file (engine/strip.cc)
  const exiv2 = spawnSync("exiv2", ["--version"]).status === 0;
  if (!exiv2) {
    record({ check: "fixes", photo: basename(photo), id: "export leaves out serial numbers", status: "skip",
             detail: "no exiv2 command to read the exported file with (brew install exiv2)" });
  } else await fix("export leaves out serial numbers", async () => {
    // the keys exiv2 sees, with Sony's undecoded block that holds its serial.
    // a raw's listing runs to megabytes, past spawnSync's 1 MB default
    const list = (file, ...opts) => spawnSync("exiv2", ["-pa", ...opts, "-q", file],
                                              { encoding: "utf8", maxBuffer: 1 << 28 }).stdout;
    const personal = (file) => list(file, "-u").split("\n").map((l) => l.split(/\s+/)[0])
      .filter((k) => /serial|ownername|^Exif\.Sony\d\.0x9050$/i.test(k));
    const keys = (file) => list(file);
    if (!personal(photo).length) return null;
    const { images: [e] } = await request({ cmd: "import", files: [fresh(photo)] });
    const exported = async (tag, serials) => {
      const out = join(args.work, "export", `${copies}-${tag}.jpg`);
      mkdirSync(dirname(out), { recursive: true });
      await request({ cmd: "export", imgid: e.imgid, out, format: "jpeg", color_space: "srgb", quality: 90,
                      long_edge: 512, draft: true, serials });
      return out;
    };
    const left = await exported("serials-out", false), kept = await exported("serials-in", true);
    const leaked = personal(left);
    return leaked.length ? `the export kept ${leaked.join(", ")}`
      : !/^Exif\.Image\.Model /m.test(keys(left)) ? "the export lost the camera model with the serial numbers"
      : !personal(kept).length ? "with serial numbers asked for, the export had none" : null;
  });

  // 0.34.0: zoomed in, a range mask's overlay is darktable's own mask, made
  // on the preview pipe for the window shown. a range map after it read the
  // whole image from that window, its edges repeated across the rest
  await fix("range map after a zoomed mask map", async () => {
    const o = await open(fresh(photo));
    const range = { type: "luminance", lo: -2, hi: 1.7, feather: 1 };
    await o.after(() => o.s.addMask("Range", [range]));
    await o.after(() => o.s.setLocal("Range", "l_exposure", 0.5));
    const map = async () => new Uint8Array(await invoke("range_map", { ranges: [range], width: 320, height: 240 }), 8);
    const before = await map();
    const { fullWidth: w, fullHeight: h } = o.base;
    await invoke("mask_map", { name: "Range", width: 1024, height: 1024,
                               view: { x: Math.round(w / 2), y: Math.round(h / 2), scale: 1 } });
    const after = await map();
    await o.s.close();
    const moved = before.filter((v, k) => Math.abs(v - after[k]) > 2).length / before.length;
    return moved > 0.01 ? `after a zoomed mask map, ${(100 * moved).toFixed(0)}% of the range map changed` : null;
  });

  // 0.39.0: an AI selection's model stayed loaded for the engine's life,
  // and ONNX Runtime keeps a session's peak working memory until the
  // session goes: after Select Subject, 7-10 GB resident and an 18 GB
  // footprint for good. the engine lets the models go 30 s after their
  // last use (main.c, _ai_release). how much goes back varies on macOS,
  // where malloc keeps freed regions a while (36-60% kept in runs), so
  // the check asks only that it goes down: held, nothing came back
  const BIREFNET = "mask-subject-birefnet-lite", IDLE = "AI models let go when idle";
  if (photo === args.photos[0]) {
    if (process.platform === "win32" || !args.models || !existsSync(join(args.models, BIREFNET, "config.json"))) {
      record({ check: "fixes", photo: basename(photo), id: IDLE, status: "skip",
               detail: process.platform === "win32" ? "measured with ps, which Windows lacks"
                 : `no ${BIREFNET} in build/ai-models: use Select Subject once in a dev build` });
    } else await fix(IDLE, async () => {
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        const rss = () => Number(spawnSync("ps", ["-o", "rss=", "-p", String(enginePid())]).stdout.toString().trim()) / 1024;
        await request({ cmd: "open", path: fresh(photo), imgid: -1 });
        await invoke("ai_model_ensure", { id: BIREFNET });
        if (!(await invoke("ai_mask", { kind: "subject" }))?.length) return "Select Subject found nothing";
        const ran = rss();
        await new Promise((r) => setTimeout(r, 40000));
        const idle = rss();
        return idle > ran * 0.9
          ? `40 s after Select Subject, the engine still holds ${idle.toFixed(0)} MB of the ${ran.toFixed(0)} MB it ran with` : null;
      } finally {
        await restart();
      }
    });
  }

  // 0.38.0: an AI selection's overlay was drawn from a copy of its outline
  // 512 px across, so zoomed in its edge came in steps, and it left out
  // darktable's default feather. it is drawn at the overlay's own size now
  // (masks.ts, objectCover): a circle 10x zoomed matches darktable's
  // coverage, full inside, falling linearly over the feather outside
  if (photo === args.photos[0]) await fix("an AI selection's overlay zoomed in", async () => {
    const W = 6000, H = 4000, R = 1200, k = 0.5523 * R;
    const at = (x, y) => [0.5 + x / W, 0.5 + y / H];
    const points = [[R, 0], [0, R], [-R, 0], [0, -R]].map(([x, y]) => {
      const tx = -y / R, ty = x / R;
      return [...at(x, y), ...at(x - tx * k, y - ty * k), ...at(x + tx * k, y + ty * k)];
    });
    const mask = { name: "", invert: false, values: {}, shapes: [{ type: "object", paths: [{ hole: false, points }] }] };
    const win = [0.66, 0.4, 0.74, 0.5];
    const img = overlayPixels(mask, 640, W, H, null, [230, 40, 40], win);
    const scale = img.width / ((win[2] - win[0]) * W), feather = 0.003 * H;
    let worst = 0;
    for (let j = 0; j < img.height; j++)
      for (let i = 0; i < img.width; i++) {
        const x = (win[0] + ((i + 0.5) / img.width) * (win[2] - win[0])) * W - W / 2;
        const y = (win[1] + ((j + 0.5) / img.height) * (win[3] - win[1])) * H - H / 2;
        const d = Math.hypot(x, y) - R;
        // the anti-aliased pixels astride the outline aside
        if (Math.abs(d) * scale < 1) continue;
        const want = d < 0 ? 1 : Math.max(0, 1 - d / feather);
        worst = Math.max(worst, Math.abs(img.data[4 * (j * img.width + i) + 3] / 140 - want));
      }
    return worst > 0.1 ? `zoomed in, the overlay strays from the mask by up to ${(100 * worst).toFixed(0)}%` : null;
  });

  // 0.34.0: a JPEG or TIFF reaches the mask stage in Lab, and reading it
  // there failed ("not in RGB at the mask stage"): the color range picker,
  // range overlays and the hover probe. what a range map reads is what
  // darktable's own mask of the range selects
  await fix("range masks read the photo", async () => {
    const o = await open(fresh(photo));
    const range = { type: "luminance", lo: -2, hi: 1, feather: 1 };
    await o.after(() => o.s.addMask("Range", [range]));
    await o.after(() => o.s.setLocal("Range", "l_exposure", 0.5));
    const picked = await invoke("sample", { x: 0.5, y: 0.5 });
    const width = 320, height = Math.round((320 * o.base.fullHeight) / o.base.fullWidth);
    const ours = new Uint8Array(await invoke("range_map", { ranges: [range], width, height }), 8);
    const buf = await invoke("mask_map", { name: "Range", width, height });
    await o.s.close();
    const head = new DataView(buf, 0, 8);
    if (head.getUint32(0, true) !== width || head.getUint32(4, true) !== height)
      return `darktable's mask came back ${head.getUint32(0, true)}x${head.getUint32(4, true)}, not ${width}x${height}`;
    const theirs = new Uint8Array(buf, 8);
    const mad = ours.reduce((a, v, k) => a + Math.abs(v - theirs[k]), 0) / ours.length;
    return !Number.isFinite(picked.ev) ? `the picker read ${JSON.stringify(picked)}`
      // the map reads a point a pixel, darktable's mask covers the pixel: some
      // 4 of 255 apart on these photos
      : mad > 8 ? `the range map differs from darktable's mask by ${mad.toFixed(1)} of 255 on average` : null;
  });

  // 0.30.0: a mask's refinements with no adjustment yet had no instance to
  // live in, and were lost on save
  await fix("refined mask with no adjustment", async () => {
    const path = fresh(photo);
    let o = await open(path);
    await o.after(() => o.s.addMask("Soft", [MASK]));
    await o.after(() => o.s.setRefine("Soft", { feather: 0, blur: 20, detail: 0, contrast: 0 }));
    await o.s.close();
    await restart();
    o = await open(path);
    const got = o.s.masks.find((x) => x.name === "Soft")?.refine;
    await o.s.close();
    return got?.blur > 0 ? null : `opened again, its refinements are ${JSON.stringify(got ?? null)}`;
  });

  // 0.37.0: darktable takes a mask's shapes into the pipe's hash from
  // darktable.develop, not the engine's develop, so 0.36.0's frames by hash
  // (`have`) handed back the zoomed frame from before a mask moved: the
  // view showed the mask where it had been, or not at all
  await fix("a moved mask isn't shown where it was", async () => {
    const o = await open(fresh(photo));
    const plain = await zoomed(o);
    const spot = { ...MASK, x: 0.5, y: 0.5, rx: 0.1, ry: 0.1, feather: 0.02 };
    await o.after(() => o.s.addMask("Spot", [spot]));
    const lit = await o.after(() => o.s.setLocal("Spot", "l_exposure", 1));
    const moved = await o.after(() => o.s.setShapes("Spot", [{ ...spot, x: 0.05, y: 0.05, rx: 0.02, ry: 0.02 }]));
    await o.s.close();
    const center = inEllipse(0.5, 0.5, 0.1);
    const stale = compare(moved, plain, center).mad;
    return brighter(lit, plain, center) ? "the mask did not brighten the zoomed view"
      : stale > 1 ? `moved out of the view, the mask still shows there (${stale.toFixed(1)} of 255 apart)` : null;
  });

  // 0.36.0: on Linux at 2x, a drag's frames took longer than the busy
  // indicator's wait, so it came up between them, and its spinning redrew
  // the whole window every display frame. a job that has shown a frame
  // waits a second before it shows the indicator
  await fix("a slow drag doesn't bring up the busy indicator", async () => {
    const cases = [
      ["a first frame at 300 ms shows it", dueIn([{ since: 0, shown: false }], 300, 250, 1000) <= 0, true],
      ["a drag's next frame at 465 ms leaves it off", dueIn([{ since: 0, shown: true }], 465, 250, 1000) <= 0, false],
      ["a drag's frame at 1100 ms shows it", dueIn([{ since: 0, shown: true }], 1100, 250, 1000) <= 0, true],
      ["a new job beside a drag shows it", dueIn([{ since: 0, shown: true }, { since: 0, shown: false }], 300, 250, 1000) <= 0, true],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want).map(([label]) => label);
    return wrong.length ? `not so: ${wrong.join(", ")}` : null;
  });

  // 0.38.0: a rejected photo deleted, then a new file at its path (a
  // panorama merged again), came back rejected: the library kept its row
  await fix("a new file where a deleted one was isn't rejected", async () => {
    const path = fresh(photo);
    const { images: [e] } = await request({ cmd: "import", files: [path] });
    await invoke("meta_set", { imgid: e.imgid, fields: { rejected: true } });
    await invoke("trash_files", { imgids: [e.imgid] });
    if (existsSync(path)) return "the photo wasn't deleted";
    copyFileSync(photo, path, constants.COPYFILE_FICLONE);
    const { images: [i] } = await request({ cmd: "import", files: [path] });
    return i.rejected ? "it came back rejected" : null;
  });
}

// what Immage decided it does, as README.md, the code map and the
// backlog's Decisions record it. changing one is deliberate, and changes
// its check with it
async function decisions(photo) {
  const decide = (id, run) => outcome("decisions", basename(photo), id, run);

  // the new-photo defaults never mark a photo edited, in Immage or in
  // darktable, and apply once; the user's first change does mark it
  // (architecture.md, Engine; backlog.md, 0.23.2)
  await decide("new-photo defaults leave it unedited", async () => {
    const path = fresh(photo);
    let o = await open(path);
    await o.s.close();
    await drained();
    const first = await request({ cmd: "open", path, imgid: -1 });
    o = await open(path);
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); });
    await o.s.close();
    await drained();
    const second = await request({ cmd: "open", path, imgid: -1 });
    return first.edited ? "the new-photo defaults marked it edited"
      : first.fresh ? "opened again, it is taken for a new photo" : !second.edited ? "the user's change left it unedited" : null;
  });

  // a folder's photos show in the order they were taken; ties keep the
  // name order, a photo without a capture time goes by its file's, and
  // photos with neither go last (user guide, library.md, The filmstrip and
  // the grid)
  await decide("the filmstrip is in capture order", async () => {
    const { images: [e] } = await request({ cmd: "import", files: [fresh(photo)] });
    // a camera whose clock was never set writes zeros, which read as no time
    const t = e?.exif.datetime || e?.exif.file_datetime || "";
    if (!/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(t)) return `the engine gave capture time ${JSON.stringify(t)}`;
    const at = (filename, datetime, file_datetime) => ({ ...e, filename, exif: { ...e.exif, datetime, file_datetime } });
    const later = `${Number(t.slice(0, 4)) + 1}${t.slice(4)}`, earlier = `${Number(t.slice(0, 4)) - 1}${t.slice(4)}`;
    const got = byCaptureTime([at("a", ""), at("b", later), at("c", t), at("d", t), at("e", "", earlier)])
      .map((i) => i.filename).join("");
    return got === "ecdba" ? null : `sorted as ${got}, not ecdba`;
  });

  // a folder read before shows its photos as the last read found them,
  // until this one reaches them, and in the order the read ends with: a
  // known cell keeps its place when its photo is read (architecture.md,
  // Import a folder), whatever the capture times and however far it got
  await decide("a known photo keeps its place when read", async () => {
    const { images: [e] } = await request({ cmd: "import", files: [fresh(photo)] });
    const t = e?.exif.datetime || e?.exif.file_datetime || "";
    if (!t) return "the engine gave no capture time";
    const at = (name, datetime) => ({ ...e, filename: name, path: `/folder/${name}`, version: 0,
                                      exif: { ...e.exif, datetime, file_datetime: "" } });
    const listed = [at("z", t), at("y", ""), at("x", t), at("w", ""), at("v", t)];
    const end = byCaptureTime(listed).map((i) => i.filename).join("");
    for (let read = 0; read <= listed.length; read++) {
      const got = withKnown(byCaptureTime(listed.slice(0, read)), listed.slice(read)).map((i) => i.filename).join("");
      if (got !== end) return `with ${read} read, shown as ${got}, then ${end}`;
    }
    return null;
  });

  // on Wayland at 125%, where the window is drawn at 2× and shrunk, drag
  // drafts are sized for the screen: smaller by 1.25 over 2. not the frame
  // after letting go, which came out jagged (FINDINGS, "Drag drafts at the
  // screen's scale"); not where the screen's scale is the window's, nor
  // with the preference off. a window not on a screen yet keeps the scale
  await decide("drag drafts at the screen's scale", async () => {
    const { draftScale, refreshScreenScale, storeScreenScale } = await import("../app/src/pixelRatio.ts");
    const at = async (dpr, scale) => {
      globalThis.devicePixelRatio = dpr;
      screen.scale = scale;
      await refreshScreenScale(0);
      return draftScale();
    };
    const got = {
      "125%": await at(2, 1.25),
      "not on a screen yet": await at(2, "error"),
      "200%": await at(2, null),
      "the compositor's 2 at 200%": await at(2, 2),
      "at 1×": await at(1, 1.25),
    };
    await at(2, 1.25);
    storeScreenScale(false);
    got["preference off"] = draftScale();
    storeScreenScale(true);
    await at(undefined, null);
    const want = { "125%": 0.625, "not on a screen yet": 0.625, "200%": 1, "the compositor's 2 at 200%": 1, "at 1×": 1,
                   "preference off": 1 };
    const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
    return wrong.length ? wrong.map((k) => `${k}: ${got[k]}, not ${want[k]}`).join("; ") : null;
  });

  // a move's module edits go with its render, one call however many modules
  // moved: a call cost 20 ms or more on Linux while the page drew (FINDINGS,
  // "KDE on AMD at 100%"). its frame shows them
  await decide("a move's edits go with its render", async () => {
    const o = await open(fresh(photo));
    const calls = [];
    sent.hook = (cmd, a) => { calls.push({ cmd, ops: (a.edits ?? []).map((e) => e.op) }); };
    let f;
    try {
      f = await o.after(() => o.s.setMany([["exposure", 0.5], ["vibrance", 30]]));
    } finally {
      sent.hook = null;
    }
    await o.s.close();
    const sets = calls.filter((c) => c.cmd === "set_params").length;
    const carried = calls.filter((c) => c.cmd === "render" && c.ops.length);
    const ops = carried.flatMap((c) => c.ops).sort().join(", ");
    return sets ? `${sets} set_params calls`
      : carried.length !== 1 ? `${carried.length} renders carried edits`
      : ops !== "colorbalancergb, exposure" ? `the render carried ${ops}`
      : judge({ expect: { lum: 1 } }, compare(f, o.base), 1);
  });

  // the Filters popup narrows a folder by camera, keywords (a keyword
  // with those under it) and exposure settings, which needs the engine to
  // list each photo's keywords with the folder (filter.ts; library.md,
  // Filtering)
  await decide("the filter reads camera, keywords and exposure", async () => {
    const path = fresh(photo);
    const { images: [e] } = await request({ cmd: "import", files: [path] });
    await request({ cmd: "keywords_set", imgid: e.imgid, add: ["Verify|Filter"], remove: [] });
    const { images: [i] } = await request({ cmd: "import", files: [path] });
    if (!i?.keywords?.includes("Verify|Filter")) return `the folder listed keywords ${JSON.stringify(i?.keywords)}`;
    const camera = `${i.exif.maker} ${i.exif.model}`.trim();
    const iso = i.exif.iso;
    const cases = [
      [{ cameras: [camera] }, true], [{ cameras: ["No Such Camera"] }, false],
      [{ keywords: ["Verify"] }, true], [{ keywords: ["Verify|Filter"] }, true], [{ keywords: ["Verify|Other"] }, false],
      [{ iso: [exposureLabel("iso", iso)] }, true], [{ iso: [exposureLabel("iso", iso * 2)] }, false],
    ];
    const wrong = cases.filter(([f, want]) => passes(i, { ...NO_FILTER, ...f }) !== want);
    return !iso ? "the photo has no ISO to filter by"
      : wrong.length ? `wrong for ${wrong.map(([f]) => JSON.stringify(f)).join(", ")}` : null;
  });

  // each of the Filters popup's lists holds only what the other choices
  // leave, so a camera chosen narrows the lenses, ISOs and the rest to
  // those it took (library.md, Filtering)
  await decide("the filter's lists narrow by the other choices", async () => {
    const { images: [i] } = await request({ cmd: "import", files: [fresh(photo)] });
    const camera = `${i.exif.maker} ${i.exif.model}`.trim(), iso = exposureLabel("iso", i.exif.iso);
    const has = (f, clear, key, v) => facetsWithin([i], { ...NO_FILTER, ...f }, clear)[key].some(([x]) => x === v);
    const wrong = [
      [has({ cameras: [camera] }, { iso: [] }, "iso", iso), true],
      [has({ cameras: ["No Such Camera"] }, { iso: [] }, "iso", iso), false],
      // its own choice left out, the other cameras stay to choose
      [has({ cameras: ["No Such Camera"] }, { cameras: [] }, "cameras", camera), true],
    ].map(([got, want], n) => got === want ? null : n).filter((n) => n !== null);
    return !iso ? "the photo has no ISO to filter by" : wrong.length ? `wrong for cases ${wrong.join(", ")}` : null;
  });

  // the photo is never written, only its sidecar (architecture.md, Where data
  // lives)
  await decide("the photo file is never written", async () => {
    const path = fresh(photo);
    const sum = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const was = sum();
    const o = await open(path);
    await o.after(() => o.s.addMask("Verify", [MASK]));
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); o.s.setLocal("Verify", "l_exposure", 0.5); });
    await o.s.close();
    await drained();
    return sum() === was ? null : "the photo file changed";
  });

  // a photo shown in the library or exported, and not opened, gains no
  // sidecar: darktable's own writes stay off, and the engine writes one only
  // where it means to (_write_sidecar in engine/main.c). opening one saves
  // the new-photo defaults as its baseline (architecture.md, Engine)
  await decide("a photo shown or exported gains no sidecar", async () => {
    const path = fresh(photo);
    const { images: [e] } = await request({ cmd: "import", files: [path] });
    await request({ cmd: "thumb", imgid: e.imgid, size: 240, out: join(args.work, "thumb.rgba") });
    await request({ cmd: "export", imgid: e.imgid, out: join(args.work, "looked.jpg"), format: "jpeg",
                    color_space: "srgb", quality: 90, long_edge: 512 });
    return sidecar(path) ? `it gained ${basename(sidecar(path))}` : null;
  });

  // an export renders each photo as it was when the export was asked for,
  // however it is edited while the export runs: the open photo, and one
  // opened after (exports.ts; export_hold in engine/main.c)
  const exportOpts = { format: "jpeg", color_space: "srgb", quality: 90, long_edge: 512 };
  const exportOut = (tag) => {
    const out = join(args.work, "export", `${copies}-${tag}.jpg`);
    mkdirSync(dirname(out), { recursive: true });
    return out;
  };
  // the image data alone: the EXIF carries the time of export. the
  // segments are walked to the start of scan, as its marker's two bytes
  // can turn up in a photo's metadata before it
  const scan = (file) => {
    const b = readFileSync(file);
    let i = 2;
    while (i + 4 <= b.length && b[i] === 0xff && b[i + 1] !== 0xda) i += 2 + b.readUInt16BE(i + 2);
    return b.subarray(i);
  };
  let jobs = 0;
  await decide("an export renders the edit it was asked for", async () => {
    for (const later of [false, true]) {
      const path = fresh(photo);
      let o = await open(path);
      await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 1); });
      const asked = exportOut("asked");
      await request({ cmd: "export", imgid: o.s.imgid, out: asked, ...exportOpts });
      const imgid = o.s.imgid, job = ++jobs;
      // the engine keeps a photo open until the next one opens
      if (later) {
        await o.s.close();
        await (await open(fresh(photo))).s.close();
      }
      await request({ cmd: "export_hold", job, imgids: [imgid] });
      if (later) o = await open(path);
      await o.after(() => o.s.set("exposure", -1));
      await o.s.close();
      await drained();
      const held = exportOut("held");
      await requestTagged({ cmd: "export", job, imgid, out: held, ...exportOpts });
      await requestTagged({ cmd: "export_release", job });
      if (!scan(held).equals(scan(asked)))
        return `the export of the photo ${later ? "opened after it was asked for" : "open"} has the later edit`;
    }
    return null;
  });

  // a background export leaves the editor rendering, and its copies of the
  // edit never show as versions of the photo or take a virtual copy's
  // number (_SNAPSHOT_VERSION in engine/main.c)
  await decide("a background export stays out of the editor's way", async () => {
    const path = fresh(photo);
    const o = await open(path);
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); });
    const job = ++jobs;
    await request({ cmd: "export_hold", job, imgids: [o.s.imgid] });
    // before the import below, which has darktable number the file's
    // versions again
    const { image: copy } = await request({ cmd: "copy", imgid: o.s.imgid });
    const versions = async () => (await request({ cmd: "import", files: [path] })).images.length;
    const during = await versions();
    const exporting = requestTagged({ cmd: "export", job, imgid: o.s.imgid, out: exportOut("beside"), ...exportOpts });
    const frames = [];
    for (const ev of [1, 0.25, 0.75]) frames.push(await o.after(() => o.s.set("exposure", ev)));
    await exporting;
    await requestTagged({ cmd: "export_release", job });
    await o.s.close();
    const after = await versions();
    return frames.some((f) => !f) ? "an edit made during the export rendered no frame"
      : copy.version !== 1 ? `a virtual copy made during the export is version ${copy.version}`
      : during !== 2 ? `with a copy, the photo showed ${during} versions while it exported`
      : after !== 2 ? `with a copy, the photo shows ${after} versions after the export` : null;
  });

  // a folder is read on the engine's import thread while the photo is
  // edited (main.c, _import_run), and an import on the main loop meanwhile,
  // as `open` makes, waits for one file at most (_import_lock)
  await decide("a folder imports beside editing", async () => {
    const o = await open(fresh(photo));
    await o.after(() => o.s.endBaseline());
    // on the GPU a module's first frame renders from the raw, as the pipe
    // cache keeps only the last edited module's input (main.c, _set): the
    // timed edit is the one after it, as in a drag
    await o.after(() => o.s.set("exposure", 0.25));
    const dir = join(args.work, "photos", String(++copies));
    mkdirSync(dir, { recursive: true });
    const files = Array.from({ length: 200 }, (_, k) => {
      const to = join(dir, `${k}-${basename(photo)}`);
      copyFileSync(photo, to, constants.COPYFILE_FICLONE);
      return to;
    });
    // by the time each takes: replies that come together settle in no
    // telling order. the batch takes about 1 s, an edit's frame 50 ms
    const t0 = performance.now();
    let end = null;
    const importing = requestTagged({ cmd: "import", files }).finally(() => { end = performance.now() - t0; });
    const f = await o.after(() => o.s.set("exposure", 0.5));
    const framed = performance.now() - t0;
    const one = (await request({ cmd: "import", files: [files.at(-1)] })).images[0];
    const alone = performance.now() - t0;
    const { images } = await importing;
    await o.s.close();
    const last = images.find((i) => i.path === files.at(-1));
    const sidecars = readdirSync(dir).filter((n) => n.endsWith(".xmp"));
    return !f ? "an edit made during the import rendered no frame"
      : framed > end / 2 ? `an edit made during the import took ${framed.toFixed(0)} ms, the import ${end.toFixed(0)} ms`
      : alone > end / 2 ? `an import on the main loop took ${alone.toFixed(0)} ms, the folder's ${end.toFixed(0)} ms`
      : images.length !== files.length ? `the folder's ${files.length} photos imported as ${images.length}`
      : last?.imgid !== one?.imgid ? `one file imported twice at once is images ${one?.imgid} and ${last?.imgid}`
      : sidecars.length ? `the import wrote ${sidecars.length} sidecars` : null;
  });

  // AI Denoise runs on a thread of the engine's while the photo is edited,
  // and the DNG gets the edit as it was when it was asked for (main.c,
  // _denoise_run). once, on the first raw: the model takes a minute on the
  // CPU
  const DENOISE = "rawdenoise-nind";
  if (photo === args.photos.find((p) => /\.(arw|cr2|cr3|nef|nrw|orf|pef|raf|rw2|srw)$/i.test(p))) {
    if (!args.models || !existsSync(join(args.models, DENOISE, "config.json"))) {
      record({ check: "decisions", photo: basename(photo), id: "AI Denoise runs beside editing", status: "skip",
               detail: `no ${DENOISE} in build/ai-models: use AI Denoise once in a dev build` });
    } else await decide("AI Denoise runs beside editing", async () => {
      // an engine of its own, so the others' config never has AI on
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        const o = await open(fresh(photo));
        await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); });
        let done = false;
        const denoising = invoke("ai_denoise", { strength: 1 }).finally(() => { done = true; });
        const f = await o.after(() => o.s.set("exposure", 1.5));
        await request({ cmd: "save" });
        const beside = !done;
        const preview = await invoke("ai_denoise_preview", { u: 0.5, v: 0.5, size: 256 }).then(() => null, (e) => String(e));
        const r = await denoising;
        await o.s.close();
        const d = await open(r.path);
        const ev = d.s.values.exposure;
        await d.s.close();
        return !f ? "an edit made during the denoise rendered no frame"
          : !beside ? "an edit made during the denoise waited for it"
          : !preview?.includes("still writing") ? `a preview during the denoise ${preview ? `failed with: ${preview}` : "ran"}`
          : Math.abs(ev - 0.5) > 1e-3 ? `the DNG has Exposure ${ev}, not the 0.5 it was asked with` : null;
      } finally {
        await restart();
      }
    });
  }

  // HDR Merge writes a float DNG beside the first bracket that opens as the
  // brackets render: two of the same exposure merge to that exposure
  // (hdrmerge.c). a single photo is refused. on the first raw
  if (photo === args.photos.find((p) => /\.(arw|cr2|cr3|nef|nrw|orf|pef|raf|rw2|srw)$/i.test(p))) {
    await decide("HDR Merge of two brackets renders as one", async () => {
      const dir = join(args.work, "hdr");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const ext = photo.match(/\.[^.]+$/)[0];
      const files = ["a", "b"].map((n) => join(dir, n + ext));
      for (const f of files) copyFileSync(photo, f, constants.COPYFILE_FICLONE);
      const { images } = await request({ cmd: "import", files });
      const alone = await invoke("hdr_merge", { imgids: [images[0].imgid], align: false }).then(() => null, (e) => String(e));
      const r = await invoke("hdr_merge", { imgids: images.map((i) => i.imgid), align: await invoke("hdr_can_align") });
      const src = await open(files[0]);
      await src.s.close();
      const hdr = await open(r.path);
      await hdr.s.close();
      const d = compare(hdr.base, src.base);
      return alone === null ? "a merge of one photo was not refused"
        : basename(r.path) !== `a-hdr.dng` ? `the merge wrote ${basename(r.path)}, not a-hdr.dng`
        : r.image?.path !== r.path ? "the DNG was not imported"
        : d.geometry ? `the DNG renders ${hdr.base.width}x${hdr.base.height}, the raw ${src.base.width}x${src.base.height}`
        : Math.abs(d.lum) > 3 || d.mad > 6 ? `the DNG renders ${d.lum} brighter than the raw, ${d.mad} apart` : null;
    });
  }

  // Panorama Merge writes a DNG beside the first raw that opens as that
  // raw, in its own color (main.c, _pano_frame; dng.c): two copies of one
  // raw stitch back into it, as bright and of the same color, upright. a
  // single photo is refused. on the first raw, when the engine has OpenCV's
  // stitching
  if (photo === args.photos.find((p) => /\.(arw|cr2|cr3|nef|nrw|orf|pef|raf|rw2|srw)$/i.test(p))
      && await invoke("pano_can_merge")) {
    await decide("Panorama Merge of two copies of a raw renders as the raw", async () => {
      const dir = join(args.work, "pano");
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const ext = photo.match(/\.[^.]+$/)[0];
      const files = ["a", "b"].map((n) => join(dir, n + ext));
      for (const f of files) copyFileSync(photo, f, constants.COPYFILE_FICLONE);
      const { images } = await request({ cmd: "import", files });
      const alone = await invoke("pano_merge", { imgids: [images[0].imgid], projection: "auto", crop: true })
        .then(() => null, (e) => String(e));
      const r = await invoke("pano_merge", { imgids: images.map((i) => i.imgid), projection: "auto", crop: true });
      const src = await open(files[0]);
      await src.s.close();
      const pano = await open(r.path);
      const fresh = !pano.s.wasEdited;
      await pano.s.close();
      // the mean luma and warmth of a frame: the two differ in size, as the
      // stitch warps and crops
      const mean = (f) => {
        let l = 0, w = 0;
        const p = f.pixels, n = f.width * f.height;
        for (let i = 0; i < 4 * n; i += 4) {
          l += 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
          w += p[i] - p[i + 2];
        }
        return { lum: l / n, warm: w / n };
      };
      const a = mean(pano.base), b = mean(src.base);
      const tall = (f) => f.height > f.width;
      return alone === null ? "a merge of one photo was not refused"
        : basename(r.path) !== "a-pano.dng" ? `the merge wrote ${basename(r.path)}, not a-pano.dng`
        : r.image?.path !== r.path ? "the DNG was not imported"
        : r.used !== 2 ? `the panorama holds ${r.used} of the 2 photos`
        : !fresh ? "the DNG opens with an edit"
        : tall(pano.base) !== tall(src.base) ? "the DNG is turned from the raw"
        : Math.abs(a.lum - b.lum) > 4 ? `the DNG renders ${(a.lum - b.lum).toFixed(1)} brighter than the raw`
        : Math.abs(a.warm - b.warm) > 4 ? `the DNG renders ${(a.warm - b.warm).toFixed(1)} warmer than the raw` : null;
    });
  }

  // an AI selection's model runs on a thread of the engine's while the
  // photo is edited, and a color edit leaves its result standing for the
  // next selection (main.c, _ai_run, _mask_cache). on the first photo
  // only: BiRefNet takes seconds on the CPU
  const SUBJECT = "mask-subject-birefnet-lite";
  if (photo === args.photos[0]) {
    if (!args.models || !existsSync(join(args.models, SUBJECT, "config.json"))) {
      record({ check: "decisions", photo: basename(photo), id: "AI selections run beside editing", status: "skip",
               detail: `no ${SUBJECT} in build/ai-models: use Select Subject once in a dev build` });
    } else await decide("AI selections run beside editing", async () => {
      // an engine of its own, so the others' config never has AI on
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        const o = await open(fresh(photo));
        await o.after(() => o.s.endBaseline());
        await invoke("ai_model_ensure", { id: SUBJECT });
        // by the time each takes, as replies that come together settle in
        // no telling order
        const t0 = performance.now();
        let end = null;
        const selecting = invoke("ai_mask", { kind: "subject" }).finally(() => { end = performance.now() - t0; });
        const f = await o.after(() => o.s.set("exposure", 0.5));
        const framed = performance.now() - t0;
        const paths = await selecting;
        const t1 = performance.now();
        const again = await invoke("ai_mask", { kind: "subject" });
        const twice = performance.now() - t1;
        await o.s.close();
        return !paths?.length ? "Select Subject found nothing"
          : !f ? "an edit made during the selection rendered no frame"
          : framed > end / 2 ? `an edit made during the selection took ${framed.toFixed(0)} ms, the selection ${end.toFixed(0)} ms`
          : twice > end / 2 ? `after a color edit, Subject again took ${twice.toFixed(0)} ms, the first ${end.toFixed(0)} ms`
          : JSON.stringify(again) !== JSON.stringify(paths) ? "after a color edit, Subject again found another outline" : null;
      } finally {
        await restart();
      }
    });
  }

  // an AI selection's outline is traced at twice the model's size and
  // moved onto the photo's own edges (main.c, _snap_edges). a made-up
  // photo whose subject's rim is known, toothed finer than the model sees:
  // the outline's corners lie 1.7 px from it on average, and 3.8 px when
  // traced at the model's size unsnapped. by default it is traced half a
  // feather inside (0.003 of the shorter side, _trace_json), so the mask
  // is about half on at the rim, and its feather goes little past it
  const RIM = "AI outlines follow the photo's edges";
  if (photo === args.photos[0]) {
    if (!args.models || !existsSync(join(args.models, SUBJECT, "config.json"))) {
      record({ check: "decisions", photo: basename(photo), id: RIM, status: "skip",
               detail: `no ${SUBJECT} in build/ai-models: use Select Subject once in a dev build` });
    } else await decide(RIM, async () => {
      const W = 3000, H = 2000, R = 600, A = 25, N = 48;
      const rim = (t) => R + A * Math.sin(N * t);
      const px = Buffer.alloc(3 * W * H);
      let seed = 1;
      const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 40;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const dx = x - W / 2, dy = y - H / 2, k = 3 * (y * W + x);
          const c = Math.hypot(dx, dy) < rim(Math.atan2(dy, dx)) ? [230, 150, 40] : [70, 90, 80].map((v) => v + noise());
          for (let i = 0; i < 3; i++) px[k + i] = Math.max(0, Math.min(255, Math.round(c[i])));
        }
      const dir = join(args.work, "rim");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "rim.ppm");
      writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]));
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        await request({ cmd: "open", path, imgid: -1 });
        await invoke("ai_model_ensure", { id: SUBJECT });
        // how far inside the rim the corners lie, on average, and how far
        // from that they stray
        const inside = (paths) => {
          const d = (paths ?? []).flatMap((p) => p.points.map(([x, y]) => {
            const dx = x * W - W / 2, dy = y * H - H / 2;
            return rim(Math.atan2(dy, dx)) - Math.hypot(dx, dy);
          }));
          const mean = (f) => d.reduce((a, b) => a + f(b), 0) / Math.max(1, d.length);
          return { n: d.length, by: mean((v) => v), off: (at) => mean((v) => Math.abs(v - at)) };
        };
        const edge = inside(await invoke("ai_mask", { kind: "subject", inset: false }));
        const half = 0.5 * 0.003 * Math.min(W, H);
        const inset = inside(await invoke("ai_mask", { kind: "subject" }));
        return !edge.n || !inset.n ? "Select Subject found nothing"
          : edge.off(0) > 2.5 ? `the outline lies ${edge.off(0).toFixed(2)} px from the subject's rim on average`
          // more on this rim's teeth, whose tips an inset takes more off
          : inset.by < half - 1.5 || inset.by > 2 * half + 1.5
            ? `traced to be added, the outline lies ${inset.by.toFixed(2)} px inside the rim, not about ${half}` : null;
      } finally {
        await restart();
      }
    });
  }

  // a selection that starts a mask over a plain, colorful background takes
  // that color out of its feather: the edge outline less the color, or the
  // inset outline (main.c, _backdrop and _object_shapes). darktable
  // feathers the outline outward, so the inset one alone still lifts the
  // background beside it, a halo at +1 EV; on a stilt over water its fringe
  // fell from 9% to under 1%. a made-up subject over plain blue, with a
  // blue patch of its own: the range is round the blue, the mask in the
  // 1-4 px outside the rim falls from about 43%, the 1-3 px inside keeps
  // its part, and so does the patch, which a hue range over the whole mask
  // cut out (as it did a stilt's blue-shaded chest). inverted with a range,
  // where darktable inverts the backdrop's shape too, the rim is the same
  // mask inverted. over gray, pale cream, or stripes of four colors, there
  // is no backdrop, and the outline stays inset: cream's hue is too faint
  // to hold still in the noise, and speckles the edge. Fit to Background
  // turned off, the mask is the one a selection without a backdrop gets,
  // and opened again it is still off (MasksPanel.tsx)
  const BACKDROP = "a subject over a plain background takes its color out";
  if (photo === args.photos[0]) {
    if (!args.models || !existsSync(join(args.models, SUBJECT, "config.json"))) {
      record({ check: "decisions", photo: basename(photo), id: BACKDROP, status: "skip",
               detail: `no ${SUBJECT} in build/ai-models: use Select Subject once in a dev build` });
    } else await decide(BACKDROP, async () => {
      const W = 3000, H = 2000, R = 600, A = 25, N = 48;
      const rim = (t) => R + A * Math.sin(N * t);
      // the patch, inside the disc's right side
      const PX = W / 2 + 330, PY = H / 2, PR = 110;
      const dir = join(args.work, "backdrop");
      mkdirSync(dir, { recursive: true });
      const made = (name, back) => {
        const px = Buffer.alloc(3 * W * H);
        let seed = 1;
        const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32 - 0.5) * 30;
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const dx = x - W / 2, dy = y - H / 2, k = 3 * (y * W + x);
            const c = Math.hypot(x - PX, y - PY) < PR ? [40, 80, 170]
              : Math.hypot(dx, dy) < rim(Math.atan2(dy, dx)) ? [230, 150, 40] : back(x).map((v) => v + noise());
            for (let i = 0; i < 3; i++) px[k + i] = Math.max(0, Math.min(255, Math.round(c[i])));
          }
        const path = join(dir, `${name}.ppm`);
        writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${W} ${H}\n255\n`), px]));
        return path;
      };
      const STRIPES = [[60, 140, 60], [40, 80, 170], [170, 60, 140], [200, 190, 60]];
      const blue = made("blue", () => [40, 80, 170]);
      const gray = made("gray", () => [120, 120, 120]), cream = made("cream", () => [185, 180, 165]), stripes = made("stripes", (x) => STRIPES[Math.floor(x / 150) % 4]);
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        await invoke("ai_model_ensure", { id: SUBJECT });
        const select = async (path) => {
          await request({ cmd: "open", path: fresh(path), imgid: -1 });
          return invoke("ai_mask", { kind: "subject", backdrop: true });
        };
        const got = await select(blue), back = (await invoke("sample", { x: 0.05, y: 0.5 })).hue;
        const inset = await invoke("ai_mask", { kind: "subject" });
        const grayGot = (await select(gray)).backdrop, creamGot = (await select(cream)).backdrop;
        const stripesGot = (await select(stripes)).backdrop;
        if (!got.paths?.length) return "Select Subject found nothing";
        if (!got.backdrop) return "over plain blue, no backdrop";
        const [, lo, hi] = got.backdrop.range;
        if (back < lo || back > hi) return `the range ${lo.toFixed(3)}-${hi.toFixed(3)} leaves out the blue's hue ${back.toFixed(3)}`;
        if (grayGot) return "over gray, a backdrop";
        if (creamGot) return "over pale cream, a backdrop";
        if (stripesGot) return "over stripes of four colors, a backdrop";
        // darktable's mask at full size over the disc's right side: how much
        // it holds 1-4 px outside the rim, 1-3 px inside, and over the patch
        const VX = 1700, VY = 600, VW = 700, VH = 800;
        const rimMask = async (shapes, invert = false) => {
          const o = await open(fresh(blue));
          await o.after(() => o.s.addMask("M", shapes));
          await o.after(() => o.s.setLocal("M", "l_exposure", 1));
          if (invert) await o.after(() => o.s.setInvert("M", true));
          const map = new Uint8Array(await invoke("mask_map", { name: "M", width: VW, height: VH,
                                                                view: { x: VX, y: VY, scale: 1 } }), 8);
          const kept = (await invoke("masks", { fields: {} })).find((m) => m.name === "M")?.shapes[0];
          await o.s.close();
          const sum = { out: 0, no: 0, in: 0, ni: 0, patch: 0, np: 0 };
          for (let y = 0; y < VH; y++)
            for (let x = 0; x < VW; x++) {
              const dx = VX + x + 0.5 - W / 2, dy = VY + y + 0.5 - H / 2;
              const d = Math.hypot(dx, dy) - rim(Math.atan2(dy, dx));
              if (d > 1 && d < 4) { sum.out += map[y * VW + x]; sum.no++; }
              if (d < -1 && d > -3) { sum.in += map[y * VW + x]; sum.ni++; }
              if (Math.hypot(VX + x + 0.5 - PX, VY + y + 0.5 - PY) < PR - 10) { sum.patch += map[y * VW + x]; sum.np++; }
            }
          return { out: sum.out / sum.no / 255, in: sum.in / sum.ni / 255, patch: sum.patch / sum.np / 255, kept };
        };
        if (!got.backdrop.plain?.length) return "no plain outline comes with the backdrop";
        const subject = { type: "object", paths: got.paths,
                          backdrop: { range: got.backdrop.range, paths: got.backdrop.paths, plain: got.backdrop.plain } };
        const was = await rimMask([{ type: "object", paths: inset }]);
        const now = await rimMask([subject]);
        const off = await rimMask([{ ...subject, backdrop: { ...subject.backdrop, off: true } }]);
        const inv = await rimMask([subject, { type: "luminance", lo: null, hi: null, feather: 1 }], true);
        const pct = (v) => `${(100 * v).toFixed(0)}%`;
        // its paths show only the inset outline, so the overlay is the
        // engine's map, as the engine adds the backdrop: under a first shape
        const mask = (shapes) => ({ name: "m", shapes, invert: false, values: {} });
        const lum = { type: "luminance", lo: null, hi: null, feather: 1 };
        return !readsBackdrop(mask([lum, subject])) ? "its overlay is drawn from its paths, which show the inset outline alone"
          : readsBackdrop(mask([{ type: "object", paths: inset }, subject])) ? "under another shape, its overlay waits on a backdrop the engine leaves out"
          : readsBackdrop(mask([{ ...subject, backdrop: { ...subject.backdrop, off: true } }])) ? "turned off, its overlay waits on the backdrop"
          : now.out > 0.6 * was.out ? `outside the rim the mask holds ${pct(now.out)}, against ${pct(was.out)} inset`
          : now.in < was.in - 0.02 ? `inside the rim the mask holds ${pct(now.in)}, against ${pct(was.in)} inset`
          : now.patch < was.patch - 0.02 ? `over the subject's blue the mask holds ${pct(now.patch)}, against ${pct(was.patch)} inset`
          : Math.abs(1 - inv.out - now.out) > 0.05 ? `inverted with a range, outside the rim it holds ${pct(inv.out)}, against ${pct(1 - now.out)}`
          : Math.abs(off.out - was.out) > 0.02 || Math.abs(off.in - was.in) > 0.02
            ? `turned off, the rim holds ${pct(off.out)} outside and ${pct(off.in)} inside, against ${pct(was.out)} and ${pct(was.in)} without a backdrop`
          : !off.kept?.backdrop?.off ? "turned off, it reads back on"
          : now.kept?.backdrop?.off !== false || !now.kept.backdrop.plain?.length ? "on, it reads back off or without its plain outline"
          : null;
      } finally {
        await restart();
      }
    });
  }

  // a frame shown before comes back without a render when the image does:
  // back from the Before view, or a slider put back. the engine names it by
  // darktable's hash (session.ts, frames; _render's `have` in engine/main.c)
  await decide("frames shown before come back unrendered", async () => {
    const o = await open(fresh(photo));
    o.s.endBaseline();
    const a = await o.after(() => o.s.set("exposure", 0.5));
    await o.after(() => o.s.showBefore(() => false));
    const back = await o.after(() => o.s.showBefore(null));
    const b = await o.after(() => o.s.set("exposure", 1));
    const again = await o.after(() => o.s.set("exposure", 0.5));
    // zoomed in, the whole-image copy the windows are cut from comes back too
    await zoomed(o);
    let copy = null;
    o.s.onCopy = (f) => { copy = f; };
    const copied = async () => {
      copy = null;
      o.s.requestCopy(1, { w: o.base.fullWidth, h: o.base.fullHeight });
      await o.frame();
      return copy;
    };
    const first = await copied();
    await o.after(() => o.s.showBefore(() => false));
    await o.after(() => o.s.showBefore(null));
    const copyBack = await copied();
    await o.s.close();
    await drained();
    return back.pixels.buffer !== a.pixels.buffer ? "back from the Before view, the frame was rendered again"
      : b.pixels.buffer === a.pixels.buffer ? "a new Exposure showed the old frame"
      : again.pixels.buffer !== a.pixels.buffer ? "Exposure put back, the frame was rendered again"
      : !first ? "zoomed in, no copy was made"
      : copyBack?.pixels.buffer !== first.pixels.buffer ? "back from the Before view, the copy was rendered again" : null;
  });

  // the photos the arrow keys open next are decoded ahead, a few at once
  // (App.tsx, prefetchNext; main.c, _prefetch). each, opened while its
  // decode is still under way, waits for it, and renders as a photo opened
  // cold does: the first of the list and the last, decoded beside it
  await decide("a prefetched photo opens as it would cold", async () => {
    const cold = fresh(photo), ahead = [fresh(photo), fresh(photo), fresh(photo)];
    const { images } = await request({ cmd: "import", files: [cold, ...ahead] });
    const pixels = async (path) => {
      await request({ cmd: "open", path, imgid: -1 });
      const px = new Uint8Array((await invoke("render", { width: 512, height: 512 })).slice(FRAME_HEAD));
      await request({ cmd: "close" });
      return px;
    };
    const differs = (a, b) => a.length !== b.length || a.some((v, k) => v !== b[k]);
    const a = await pixels(cold);
    await request({ cmd: "prefetch", imgids: ahead.map((p) => images.find((e) => e.path === p).imgid) });
    const last = await pixels(ahead[2]), first = await pixels(ahead[0]);
    return differs(a, last) ? "the last of the list rendered differently from the photo opened cold"
      : differs(a, first) ? "the first of the list rendered differently from the photo opened cold" : null;
  });

  // a photo edited in darktable keeps all of its edit: modules Immage has
  // no controls for, and the fields of its own modules its sliders don't
  // set (README, Which darktable module does what)
  await decide("darktable's edit is kept", async () => {
    const path = fresh(photo);
    await request({ cmd: "open", path, imgid: -1 });
    await request({ cmd: "set", op: "velvia", params: { strength: 40 }, enabled: true });
    await request({ cmd: "set", op: "grain", params: { strength: 20, midtones_bias: 40 }, enabled: true });
    await request({ cmd: "save" });
    const o = await open(path);
    await o.after(() => { o.s.endBaseline(); o.s.setMany([["exposure", 0.5], ["grain_amount", 60]]); });
    await o.s.close();
    await restart();
    await request({ cmd: "open", path, imgid: -1 });
    const { modules: got } = await request({ cmd: "get", modules: { velvia: ["strength"],
                                                                    grain: ["strength", "midtones_bias"] } });
    return !got.velvia?.enabled || Math.abs(got.velvia.params.strength - 40) > 0.01
      ? `velvia came back ${JSON.stringify(got.velvia?.params ?? null)}, ${got.velvia?.enabled ? "on" : "off"}`
      : Math.abs(got.grain.params.midtones_bias - 40) > 0.01 ? `grain's mid-tones bias came back ${got.grain.params.midtones_bias}`
      : Math.abs(got.grain.params.strength - 30) > 0.01 ? `Grain did not take (strength ${got.grain.params.strength})` : null;
  });

  // the History panel switches off, undoes and deletes a module darktable
  // set that Immage has no sliders for; deleted, it is gone from the
  // sidecar's history (user guide, History)
  await decide("history rows switch off and delete", async () => {
    const path = fresh(photo);
    await request({ cmd: "open", path, imgid: -1 });
    await request({ cmd: "set", op: "velvia", params: { strength: 60 }, enabled: true });
    await request({ cmd: "save" });
    let o = await open(path);
    const h = o.s.history.find((x) => x.op === "velvia");
    if (!h || h.priority === undefined || h.fixed || h.masked) return `velvia's row came as ${JSON.stringify(h ?? null)}`;
    const off = await o.after(() => o.s.setModuleState(h, { enabled: false }));
    const back = await o.after(() => o.s.setModuleState(h, { restore: "opened" }));
    const offBy = compare(off, o.base).mad, backBy = compare(back, o.base).mad;
    if (offBy <= THRESHOLD.roundtrip) return `switched off, the photo stayed the same (mean |Δ| ${offBy})`;
    if (backBy > THRESHOLD.roundtrip) return `undone, the photo stayed different (mean |Δ| ${backBy})`;
    await o.after(() => { o.s.deleted.add(`velvia#${h.priority}`); o.s.setModuleState(h, { enabled: false }); });
    await o.s.close();
    await restart();
    o = await open(path);
    const left = o.s.history.filter((x) => x.op === "velvia");
    await o.s.close();
    return left.length ? `deleted, it came back: ${JSON.stringify(left)}` : null;
  });

  // a photo that already uses one of a tool's modules keeps it, whatever
  // Preferences › Modules picks (README)
  await decide("a photo keeps its tool's module", async () => {
    const c = m.MODULE_CHOICES.find((x) => x.id === "tone_regions");
    const other = c.options.find((x) => x.value !== m.preferredChoice(c)).value;
    const path = fresh(photo);
    localStorage.setItem("immage.modules.mode", "custom");
    localStorage.setItem("immage.modules.choices", JSON.stringify({ [c.id]: other }));
    try {
      const o = await open(path);
      await o.after(() => { o.s.endBaseline(); o.s.set("highlights", -40); });
      await o.s.close();
    } finally {
      localStorage.removeItem("immage.modules.mode");
      localStorage.removeItem("immage.modules.choices");
    }
    const o = await open(path);
    const { [c.control]: tool, highlights } = o.s.values;
    await o.s.close();
    return tool !== other ? `opened under the default, Highlights moved to option ${tool}`
      : Math.abs(highlights + 40) > 1.5 ? `Highlights read back ${highlights}` : null;
  });

  // Whites on AgX moves AgX's shoulder and color balance rgb's highlights
  // brilliance together, as a mask's Whites does; an edit from before that
  // opens on its shoulder alone and gains no brilliance until Whites moves
  // (manifest.ts, WHITES_BRILLIANCE)
  await decide("whites adds brilliance on agx", async () => {
    const get = async () => (await request({ cmd: "get", modules: {
      agx: ["curve_shoulder_power"], colorbalancergb: ["brilliance_highlights"] } })).modules;
    const brilliance = (got) => (got.colorbalancergb?.enabled ? got.colorbalancergb.params.brilliance_highlights : 0);
    let path = fresh(photo);
    let o = await open(path);
    if (o.s.values.tm_mode !== 1) return `a new photo opened on tone mapper ${o.s.values.tm_mode}`;
    await o.after(() => { o.s.endBaseline(); o.s.set("whites", 50); });
    await o.s.close();
    await drained();
    await request({ cmd: "open", path, imgid: -1 });
    let got = await get();
    if (Math.abs(brilliance(got) - 0.1) > 1e-3) return `Whites +50 set brilliance ${brilliance(got)}, not 0.1`;
    path = fresh(photo);
    o = await open(path);
    await o.s.close();
    await drained();
    await request({ cmd: "open", path, imgid: -1 });
    const shoulder = (await get()).agx.params.curve_shoulder_power;
    await request({ cmd: "set", op: "agx", params: { curve_shoulder_power: shoulder * 2 ** 0.3 }, enabled: true });
    await request({ cmd: "save" });
    o = await open(path);
    const whites = o.s.values.whites;
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.3); });
    await o.s.close();
    await drained();
    await request({ cmd: "open", path, imgid: -1 });
    got = await get();
    return Math.abs(whites - 30) > 1.5 ? `an older Whites of 30 opened as ${whites}`
      : Math.abs(brilliance(got)) > 1e-6 ? `an older Whites gained brilliance ${brilliance(got)} on another edit` : null;
  });

  // a parametric tone curve saved before Midtones opens on the same four
  // sliders, Midtones at 0. the nodes are what the four-region curve()
  // wrote for these settings
  await decide("a four-region tone curve keeps its sliders", async () => {
    const ys = [0, 0.03831, 0.09292, 0.17374, 0.26784, 0.34759, 0.41279, 0.47604, 0.56, 0.64263, 0.69399,
                0.71523, 0.73462, 0.78382, 0.85068, 0.92329, 1];
    const want = { tc_mode: 0, tc_shadows: -30, tc_darks: 20, tc_lights: 40, tc_highlights: -20, tc_midtones: 0,
                   tc_split1: 20, tc_split2: 50, tc_split3: 70 };
    const path = fresh(photo);
    await request({ cmd: "open", path, imgid: -1 });
    await request({ cmd: "set", op: "tonecurve", enabled: true, params: {
      "tonecurve_nodes[0]": ys.length, tonecurve_autoscale_ab: 3,
      ...Object.fromEntries(ys.flatMap((y, k) => [[`tonecurve[0][${k}].x`, k / (ys.length - 1)], [`tonecurve[0][${k}].y`, y]])),
    } });
    await request({ cmd: "save" });
    await restart();
    const o = await open(path);
    const got = Object.fromEntries(Object.keys(want).map((k) => [k, o.s.values[k]]));
    await o.s.close();
    return Object.entries(want).every(([k, v]) => got[k] === v) ? null : `opened as ${JSON.stringify(got)}`;
  });

  // a drag's frame is the release's, less what the Preview setting leaves
  // out of drags (Session's DRAFT_SKIP); the harness renders at Quality
  await decide("drag frames match", async () => {
    const o = await open(fresh(photo));
    await o.after(() => o.s.set("exposure", 0.5));
    const full = await o.frame();
    o.view = { ...VIEW, draft: true };
    try {
      const f = await o.after(() => {});
      const d = compare(f, full);
      return d.max > 0 ? `a drag frame differs from the full one (max |Δ| ${d.max})` : null;
    } finally {
      o.view = VIEW;
      await o.s.close();
    }
  });

  // a drag's drafts step down in size while darktable takes longer than the
  // target on them, not on the first draft at a size (which ran from the
  // raw) nor on one darktable had cached (a value shown before), never
  // below the smallest step, and back up once the size above would fit
  // (Session.draftView)
  await decide("slow drags get smaller drafts", async () => {
    const o = await open(fresh(photo));
    let limits = { target: 0, smallest: 0.5 };
    o.s.draftLimits = () => limits;
    o.view = { ...VIEW, draft: true };
    // one draft a move, as a drag sends them: after() would render another
    // with no edit, which pays for a new size in its place
    const widths = [];
    const move = async (v) => { o.s.set("exposure", v); widths.push((await o.frame()).width); };
    try {
      for (let k = 1; k <= 5; k++) await move(k / 10);
      limits = { target: 0.5, smallest: 0.5 };
      for (const v of [0.6, 0.5, 0.7]) await move(v);
      limits = { target: 1e6, smallest: 0.5 };
      for (let k = 8; k <= 11; k++) await move(k / 10);
    } finally {
      o.view = VIEW;
      await o.s.close();
    }
    const want = [1024, 1024, 717, 717, 512, 512, 512, 512, 512, 717, 717, 1024];
    return widths.join() === want.join() ? null : `draft widths ${widths.join(", ")}, not ${want.join(", ")}`;
  });

  // a drag on the GPU starts each frame from the dragged module's input in
  // the pipe cache, not from the raw: darktable keeps GPU results there only
  // for its GUI's focused module, and headless every frame reran demosaic
  // (patches/darktable-engine.patch, important_input; main.c, _set's
  // history_last_module). once, on the first raw, where OpenCL works
  if (photo === args.photos.find((p) => /\.(arw|cr2|cr3|nef|nrw|orf|pef|raf|rw2|srw)$/i.test(p))) {
    const GPU_DRAG = "GPU drags start from the module dragged";
    let err = null, skip = null;
    const lines = [];
    await stopEngine();
    startApp(join(args.work, "gpu-engine"), null, { gpu: true, onPerf: (l) => lines.push(l) });
    try {
      const o = await open(fresh(photo));
      o.view = { ...VIEW, draft: true };
      for (const v of [0.1, 0.2]) { o.s.set("exposure", v); await o.frame(); }
      lines.length = 0;
      o.s.set("exposure", 0.3);
      await o.frame();
      // its timings are all printed once the engine starts on the next request
      await request({ cmd: "version", perf_mark: 1 });
      for (let t = 0; t < 100 && !lines.some((l) => l.includes('"perf_mark"')); t++) await new Promise((r) => setTimeout(r, 20));
      await o.s.close();
      const ran = lines.map((l) => /processed `([^']+)' on (GPU|CPU)/.exec(l)).filter(Boolean);
      if (!ran.some((r) => r[2] === "GPU")) skip = "no module ran on the GPU: no OpenCL here";
      else if (!ran.some((r) => r[1] === "exposure")) err = `the last frame's timings lack exposure: ${ran.map((r) => r[1]).join(", ")}`;
      else if (ran.some((r) => r[1] === "demosaic")) err = `the last drag frame ran from the raw: ${ran.map((r) => r[1]).join(", ")}`;
    } catch (e) {
      err = String(e?.stack ?? e);
    } finally {
      await restart();
    }
    record({ check: "decisions", photo: basename(photo), id: GPU_DRAG, status: skip ? "skip" : err ? "fail" : "pass",
             detail: skip ?? err ?? "" });
  }

  // trying a setting, as a preset's tile does, never touches the edit or
  // the main pipe (architecture.md, Engine); and a frame of an unchanged edit
  // carries the same hash, which keeps the sharper base on zooming out
  await decide("previews leave the edit", async () => {
    const o = await open(fresh(photo));
    const p = await o.s.preview(256, { exposure: 2 });
    const f = await o.after(() => {});
    const moved = await o.after(() => o.s.set("exposure", 0.5));
    await o.s.close();
    const d = compare(f, o.base);
    return !p.width ? "the preview came back empty"
      : d.max > 0 ? `after a preview the frame differs (max |Δ| ${d.max})`
      : f.hash !== o.base.hash ? "the same edit rendered with another hash"
      : moved.hash === o.base.hash ? "a changed edit rendered with the same hash" : null;
  });

  // the Export dialog's preview is a draft, downscaled after demosaic as
  // the darkroom does, many times quicker on an edited photo; an export
  // runs the whole pipe at full size (main.rs, export_preview; _export's
  // `draft`). both come out the same size
  await decide("the export preview is a draft", async () => {
    const o = await open(fresh(photo));
    await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); });
    const exported = async (draft) => {
      const out = join(args.work, "export", `${copies}-preview-${draft}.jpg`);
      mkdirSync(dirname(out), { recursive: true });
      await request({ cmd: "export", imgid: o.s.imgid, out, format: "jpeg", color_space: "srgb", quality: 90,
                      long_edge: 512, frame: { borders: [{ top: 5, left: 5, right: 5, bottom: 5, unit: "short",
                                                          color: "#ffffff" }] }, draft });
      const file = readFileSync(out);
      // the size from the frame header (SOF0/SOF2), the data after it
      const sof = file.findIndex((b, i) => b === 0xff && (file[i + 1] === 0xc0 || file[i + 1] === 0xc2));
      return { size: `${file.readUInt16BE(sof + 7)}x${file.readUInt16BE(sof + 5)}`,
               data: file.subarray(file.indexOf(Buffer.from([0xff, 0xda]))) };
    };
    const full = await exported(false), draft = await exported(true);
    await o.s.close();
    return draft.size !== full.size ? `the draft is ${draft.size}, the export ${full.size}`
      : draft.data.equals(full.data) ? "the preview rendered as the export does, at full size" : null;
  });

  // Preferences' exposure compensation goes on a raw's own exposure
  // instance, as App.tsx's new-photo defaults set it: Exposure still reads 0,
  // its moves add to the compensation, and the photo keeps both (user guide,
  // Preferences › New photos)
  const COMP = "exposure compensation adds under Exposure";
  const path = fresh(photo);
  let o = await open(path);
  if (!o.s.raw) {
    await o.s.close();
    record({ check: "decisions", photo: basename(photo), id: COMP, status: "skip", detail: "raws only" });
  } else await decide(COMP, async () => {
    const comp = await o.after(() => o.s.setMany([["exp_comp", 1]]));
    if (Math.abs(o.s.values.exposure) > 1e-6) return `with the compensation, Exposure reads ${o.s.values.exposure}`;
    const err = brighter(comp, o.base);
    if (err) return `the compensation: ${err}`;
    const both = await o.after(() => { o.s.endBaseline(); o.s.set("exposure", 0.5); });
    await o.s.close();
    await drained();
    const p = await open(fresh(photo));
    const alone = await p.after(() => { p.s.endBaseline(); p.s.set("exposure", 1.5); });
    await p.s.close();
    // not to the bit: Exposure's own instance has a raw's black level and
    // the compensation's none, and exposure scales by 1 / (2^-EV - black)
    // (exposure.c), so EV split over the two lands a twentieth of a level
    // off on some photos. no change a control could be told by
    const by = compare(both, alone).mad;
    if (by > THRESHOLD.change) return `+1 EV compensation and Exposure +0.5 differ from Exposure +1.5 (mean |Δ| ${by})`;
    o = await open(path);
    const { exposure, exp_comp } = o.s.values;
    const row = o.s.history.find((h) => h.op === "exposure" && h.label === "compensation");
    await o.s.close();
    return Math.abs(exposure - 0.5) > 0.005 || Math.abs(exp_comp - 1) > 0.005
      ? `opened again, Exposure reads ${exposure} and the compensation ${exp_comp}`
      : !row ? "opened again, the history has no compensation row" : null;
  });

  // Profile's Color Balance RGB looks, darktable's "basic colorfulness"
  // presets, each change the photo's color visibly from AgX Default. most
  // add color; Natural Skin takes it out of bright colors, so on a bright
  // photo it can remove about as much as it adds (colorbalancergb.c,
  // init_presets), and the change is measured per pixel rather than as the
  // mean chroma, which would hide it
  const LOOKS = "color balance rgb looks change color";
  o = await open(fresh(photo));
  const plain = meanChroma(o.base);
  if (!o.s.raw || plain < 1.5) {
    await o.s.close();
    record({ check: "decisions", photo: basename(photo), id: LOOKS, status: "skip",
             detail: o.s.raw ? "a black and white photo" : "raws only" });
  } else await decide(LOOKS, async () => {
    const weak = [];
    for (const pr of m.PROFILES) {
      const by = chromaChange(o.base, await o.after(() => o.s.set("profile", pr.value))) / plain;
      if (by < 0.03) weak.push(`${pr.label} ${(by * 100).toFixed(1)}%`);
    }
    await o.s.close();
    return weak.length ? `chroma moved from AgX Default, needs 3%: ${weak.join(", ")}` : null;
  });

  if (photo !== args.photos[0]) return;

  // Default in Preferences › Modules is darktable's AgX workflow (README)
  await decide("default modules", async () => {
    const want = { contrast: "agx", tone_regions: "toneequal", blacks: "agx", saturation: "agx",
                   bw: "channelmixerrgb#bw", sharpening: "sharpen", defringe: "cacorrectrgb" };
    const wrong = m.MODULE_CHOICES.map((c) => [c.id, c.options.find((x) => x.value === m.preferredChoice(c)).op])
      .filter(([id, op]) => want[id] !== op).map(([id, op]) => `${id}: ${op}, not ${want[id] ?? "listed here"}`);
    return wrong.join(", ") || null;
  });

  // masks share instances of the costly local modules only, and only masks
  // that can (backlog.md, Decisions, 2026-10-19): Clarity, Dehaze and the
  // cheap ones stay one instance a mask
  await decide("shared local modules", async () => {
    const want = ["cacorrectrgb", "colorbalancergb", "colorequal", "denoiseprofile", "diffuse"];
    const got = [...new Set(m.localMaps.filter((l) => l.merge).map((l) => l.op.split("#")[0]))].sort();
    return got.join() === want.join() ? null : `shared: ${got.join(", ")}; decided: ${want.join(", ")}`;
  });

  // Auto's Blacks places a photo's dark end, its darkest 0.5%, near black.
  // a dark end well above it is no black at all, a plane against clear sky,
  // and is left; one just off the target is left too (backlog.md,
  // Decisions, 2026-10-22)
  await decide("auto blacks leaves a frame with no black", async () => {
    // 1% of the frame at `dark`, 5% white, the rest at `mid`
    const frame = (dark, mid) => {
      const w = 100, h = 100, px = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const v = Math.round(255 * (i < 100 ? dark : i < 600 ? 1 : mid));
        px.set([v, v, v, 255], 4 * i);
      }
      return autoTone(px, w, h);
    };
    const got = { sky: frame(0.36, 0.45).blacks, near: frame(0.035, 0.4).blacks, flat: frame(0.07, 0.4).blacks };
    const wrong = [got.sky !== 0 && `a sky-only frame, dark end 36%, gets ${got.sky}`,
                   got.near !== 0 && `a dark end of 3.5%, just off the target, gets ${got.near}`,
                   got.flat >= 0 && `a flat frame, dark end 7%, gets ${got.flat}, not deepened`].filter(Boolean);
    return wrong.join("; ") || null;
  });
  await decide("masks that keep their own instances", async () => {
    const range = { type: "luminance", lo: -3, hi: null, feather: 1 };
    const mask = (shapes, more = {}) => ({ name: "x", shapes, invert: false, values: {}, ...more });
    const cases = [
      ["a drawn mask", mask([MASK]), true],
      ["an inverted mask with a range", mask([MASK, range], { invert: true }), false],
      ["a range alone", mask([range]), false],
      ["refine Contrast", mask([MASK], { refine: { feather: 0, blur: 0, detail: 0, contrast: 0.3 } }), false],
    ];
    const wrong = cases.filter(([, mk, can]) => canMerge(mk) !== can)
      .map(([label, , can]) => `${label} ${can ? "cannot" : "can"} share`);
    return wrong.join(", ") || null;
  });

  // a brush adding to a mask shows its overlay, toggle or not, but O still
  // hides it, and an adjustment hides it until the next stroke
  // (masks.md, The mask list)
  await decide("O and adjustments hide a brush's overlay", async () => {
    const off = { on: false, hold: null };
    const steps = (t, adding, ...evs) => evs.reduce((x, ev) => overlayStep(x, adding, ev), t);
    const cases = [
      ["a brush in hand shows it", overlayShown(off, true), true],
      ["O hides it", overlayShown(steps(off, true, "key"), true), false],
      ["O again shows it", overlayShown(steps(off, true, "key", "key"), true), true],
      ["O hides it after a stroke", overlayShown(steps(off, true, "key", "stroke"), true), false],
      ["an adjustment hides it", overlayShown(steps(off, true, "adjust"), true), false],
      ["the next stroke shows it", overlayShown(steps(off, true, "adjust", "stroke"), true), true],
      ["no tool in hand, O shows it", overlayShown(steps(off, false, "key"), false), true],
      ["no tool in hand, an adjustment leaves it on", overlayShown(steps({ on: true, hold: null }, false, "adjust"), false), true],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want).map(([label]) => label);
    return wrong.length ? `not so: ${wrong.join(", ")}` : null;
  });

  // a switch clicked last, Fit to Background or Invert, keeps only its
  // Space: it kept every key, so O did nothing and the overlay stayed up
  // (keys.ts, fieldKeeps)
  await decide("O works after a switch is clicked", async () => {
    const box = { tagName: "INPUT", type: "checkbox" }, slider = { tagName: "INPUT", type: "range" };
    const cases = [
      ["a switch leaves O", fieldKeeps(box, "o"), false],
      ["a switch keeps Space", fieldKeeps(box, " "), true],
      ["a slider keeps its arrows", fieldKeeps(slider, "ArrowLeft"), true],
      ["a slider leaves O", fieldKeeps(slider, "o"), false],
      ["a text field keeps O", fieldKeeps({ tagName: "INPUT", type: "text" }, "o"), true],
      ["a text area keeps O", fieldKeeps({ tagName: "TEXTAREA" }, "o"), true],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want).map(([label]) => label);
    return wrong.length ? `not so: ${wrong.join(", ")}` : null;
  });

  // a mask an AI selection just made shows its overlay while it is
  // selected, toggle off, until O or an adjustment (masks.md, The mask list)
  await decide("a new AI mask shows its overlay", async () => {
    const fresh = { on: false, hold: null, fresh: "Sky" };
    const steps = (t, ...evs) => evs.reduce((x, ev) => overlayStep(x, false, ev, "Sky"), t);
    const cases = [
      ["it shows", overlayShown(fresh, false, "Sky"), true],
      ["not while another mask is selected", overlayShown(fresh, false, "Brush"), false],
      ["O hides it", overlayShown(steps(fresh, "key"), false, "Sky"), false],
      ["O again shows it", overlayShown(steps(fresh, "key", "key"), false, "Sky"), true],
      ["an adjustment hides it", overlayShown(steps(fresh, "adjust"), false, "Sky"), false],
      ["a brush stroke leaves it", overlayShown(steps(fresh, "stroke"), false, "Sky"), true],
    ];
    const wrong = cases.filter(([, got, want]) => got !== want).map(([label]) => label);
    return wrong.length ? `not so: ${wrong.join(", ")}` : null;
  });

  // a new Sky or Landscape mask starts at Edge Aware 20, which takes in
  // the sky between branches the traced outline leaves out without the
  // halo a wider one leaves; a subject, people or an object start with none
  // (masks.ts, aiRefine)
  await decide("Sky and Landscape masks start edge aware", async () => {
    const edge = (k) => (aiRefine(k)?.feather ?? 0) / 2.5;
    const cases = [...["sky", "water", "vegetation", "mountains", "ground", "architecture", "artificial_ground"]
                     .map((k) => [k, edge(k), 20]),
                   ...["subject", "background", "people", "object", "depth"].map((k) => [k, edge(k), 0])];
    const wrong = cases.filter(([, got, want]) => got !== want).map(([k, got, want]) => `${k} starts at ${got}, not ${want}`);
    return wrong.length ? wrong.join(", ") : null;
  });

  // a converted negative turns off the modules that would change the
  // negative ahead of negadoctor, and the tone mappers; Contrast,
  // Saturation, Highlights and Shadows run after it; it opens again so, and
  // turned back, every module is as it was (negative.md; manifest.ts,
  // NEG_OFF and NEG_CHOICES)
  await decide("a converted negative turns its modules off, and back", async () => {
    const path = fresh(photo);
    const ops = [...m.NEG_OFF, "negadoctor"];
    const fields = m.boundFields();
    const state = async () => (await invoke("get_params", {
      modules: Object.fromEntries(ops.map((op) => [op, fields[op]])) })).modules;
    let o = await open(path);
    const was = await state();
    await o.after(() => o.s.setMany([["neg_on", 1], ...nd.toValues(nd.PRESETS[nd.FILM_COLOR]),
                                     ...Object.entries(m.NEG_CHOICES)]));
    const on = (st) => ops.filter((op) => st[op]?.enabled !== (op === "negadoctor"));
    const converted = on(await state());
    await o.s.close();
    o = await open(path);
    const reopened = on(await state());
    const choices = Object.entries(m.NEG_CHOICES).filter(([id, v]) => o.s.values[id] !== v).map(([id]) => id);
    const negOn = o.s.values.neg_on;
    await o.after(() => o.s.setMany([["neg_on", 0],
                                     ...Object.keys(m.NEG_CHOICES).map((id) => [id, o.s.neutral[id]])]));
    const back = await state();
    await o.s.close();
    const changed = ops.filter((op) => op !== "negadoctor").flatMap((op) => {
      if (back[op].enabled !== was[op].enabled) return [`${op} ${was[op].enabled ? "on" : "off"} → ${back[op].enabled ? "on" : "off"}`];
      const moved = was[op].enabled ? Object.keys(was[op].params)
        .filter((f) => Math.abs(back[op].params[f] - was[op].params[f]) > 1e-5) : [];
      return moved.length ? [`${op} ${moved.map((f) => `${f} ${was[op].params[f]} → ${back[op].params[f]}`).join(", ")}`] : [];
    });
    return converted.length ? `converted, these are not as they should be: ${converted.join(", ")}`
      : negOn !== 1 ? "opened again, it is not a negative"
      : reopened.length ? `opened again, these are not as they should be: ${reopened.join(", ")}`
      : choices.length ? `opened again, these tools are back on modules a negative turns off: ${choices.join(", ")}`
      : changed.length ? `turned back, these are not as they were: ${changed.join(", ")}` : null;
  });

  // a camera scan's blue, under the orange mask, reads the film's densest
  // parts as noise around zero: White Point is set from the other channels,
  // not by that one, which darkened the whole print (negadoctor.ts,
  // autoDmax; P5290024, a Portra scan, read 8.4 against red's 1.2)
  await decide("a starved channel does not set the negative's White Point", async () => {
    const p = nd.autoDmax(nd.PRESETS[nd.FILM_COLOR], {
      min: [0.0629, 0.0154, -0.00003], mean: [0.25, 0.068, 0.0095], max: [0.81, 0.27, 0.048] });
    const want = Math.log10(nd.PRESETS[nd.FILM_COLOR].dmin[1] / 0.0154);
    return Math.abs(p.dmax - want) > 1e-6 ? `White Point ${p.dmax.toFixed(3)}, not green's ${want.toFixed(3)}` : null;
  });

  // the Negative panel's pickers read negadoctor's input, the negative,
  // which its own settings leave as it is (negadoctor.c reads its picker
  // at its input; engine `sample`, stage "negadoctor")
  await decide("the negative's pickers read the negative", async () => {
    const o = await open(fresh(photo));
    const box = [0.3, 0.3, 0.7, 0.7];
    const read = async (stage) => {
      const r = await invoke("sample", { x: 0.5, y: 0.5, area: box, stage });
      return r.picker?.mean ?? ["R", "G", "B"].map((k) => r.channels[k].mean);
    };
    await o.after(() => o.s.setMany([["neg_on", 1], ...nd.toValues(nd.PRESETS[nd.FILM_COLOR])]));
    const neg = await read("negadoctor"), pos = await read(null);
    await o.after(() => o.s.set("neg_dmax", 3));
    const neg2 = await read("negadoctor"), pos2 = await read(null);
    await o.s.close();
    const same = (a, b) => a.every((x, i) => Math.abs(x - b[i]) <= 1e-6 * Math.max(1, Math.abs(x)));
    return !same(neg, neg2) ? `negadoctor's own setting changed what its pickers read: ${neg} → ${neg2}`
      : same(pos, pos2) ? "the mask stage did not change either: the check cannot tell the stages apart" : null;
  });

  // the Zone System's Color mask narrows a zone mask to an object boxed on
  // the photo, as it does to Sky, and the mask keeps the object in its name
  // and shapes (zone-system.md, Color mask). on the first photo only: it
  // encodes the photo with SAM on the CPU
  const SAM = "mask-object-sam21-small", OBJECT = "a zone mask narrowed to an object";
  if (photo === args.photos[0]) {
    if (!args.models || !existsSync(join(args.models, SAM, "config.json"))) {
      record({ check: "decisions", photo: basename(photo), id: OBJECT, status: "skip",
               detail: `no ${SAM} in build/ai-models: use Select Object once in a dev build` });
    } else await decide(OBJECT, async () => {
      // an engine of its own, so the others' config never has AI on
      await stopEngine();
      startApp(join(args.work, "ai-engine"), args.models);
      try {
        const path = fresh(photo);
        let o = await open(path);
        const paths = await invoke("ai_object", { points: [], box: [0.3, 0.3, 0.7, 0.7] });
        if (!paths?.length) return "Select Object found nothing in the middle of the photo";
        // the object's own edge: the outline added is traced half a
        // feather inside it, so little of the feather passes it (main.c,
        // _trace_json)
        const edge = await invoke("ai_object", { points: [], box: [0.3, 0.3, 0.7, 0.7], inset: false });
        const name = z.zoneMaskName([0, 10], { kind: "object:A", invert: false });
        await o.after(() => o.s.addMask(name, [z.zoneShape([0, 10], 1), { type: "object", paths, mode: "add" }]));
        const f = await o.after(() => o.s.setLocal(name, "l_exposure", 1));
        const err = brighter(f, o.base, inPaths(paths, true));
        if (err) return `inside the object: ${err}`;
        const out = compare(f, o.base, inPaths(edge, false));
        if (!(out.mad <= THRESHOLD.outside)) return `outside the object, the photo changed (mean |Δ| ${out.mad})`;
        await o.s.close();
        await drained();
        o = await open(path);
        const back = o.s.masks.find((x) => x.name === name);
        await o.s.close();
        const part = back && z.zonePartOf(back.name);
        return part?.kind !== "object:A" ? `opened again, ${name} reads as ${JSON.stringify(part ?? back?.name ?? null)}`
          : !back.shapes.some((s) => s.type === "object") || !z.zoneOfMask(back) ? "opened again, the mask lost its object or its zones"
          : null;
      } finally {
        await restart();
      }
    });
  }
}

// each option of each of Preferences › Modules' choices that isn't the
// default: the tool's sliders, global and on a mask, on that module
async function choices(photo) {
  const name = basename(photo);
  for (const c of m.MODULE_CHOICES) {
    for (const opt of c.options) {
      if (opt.value === m.preferredChoice(c)) continue;
      const tag = `${c.id}=${opt.label ?? opt.value}`;
      localStorage.setItem("immage.modules.mode", "custom");
      localStorage.setItem("immage.modules.choices", JSON.stringify({ [c.id]: opt.value }));
      try {
        const o = await maskOpen(photo);
        if (o.s.values[c.control] !== opt.value) {
          record({ check: "choices", photo: name, id: tag, status: "fail",
                   detail: `a new photo took ${o.s.values[c.control]}, not the module Preferences picked` });
          continue;
        }
        const globals = new Set(m.modules.filter((x) => x.choice?.control === c.control && x.choice.value === opt.value)
          .flatMap((x) => x.controls).filter((id) => !m.isModuleSetting(id)));
        for (const cc of controls()) {
          if (!globals.has(cc.id)) continue;
          const spec = GLOBAL[cc.id] ?? {};
          if (spec.skip || ((cc.rawOnly || spec.raw) && !o.s.raw)) continue;
          try { await trialGlobal(o, name, cc, spec, `choices ${tag}`); }
          catch (e) { record({ check: `choices ${tag}`, photo: name, id: cc.id, status: "fail", detail: String(e) }); }
        }
        const locals = m.localMaps.filter((x) => x.choice?.control === c.control && x.choice.value === opt.value)
          .flatMap((x) => x.controls);
        // a mask's trials are judged against the masked frame, made before the
        // global trials moved anything
        o.masked = await o.frame();
        await localSliders(o, name, `choices ${tag}`, locals);
        await o.s.close();
      } catch (e) {
        record({ check: "choices", photo: name, id: tag, status: "fail", detail: String(e) });
      } finally {
        localStorage.removeItem("immage.modules.mode");
        localStorage.removeItem("immage.modules.choices");
      }
    }
  }
}

// a mixed edit saved, the engine restarted (as the app quitting and
// starting again), and the photo opened: the same values and the same frame
const ROUNDTRIP = {
  exposure: 0.7, contrast: 30, highlights: -40, shadows: 35, whites: 20, blacks: -15, vibrance: 20, saturation: -10,
  clarity: 25, dehaze: 10, cg_highlights_sat: 30, cg_highlights_hue: 40, cg_shadows_lum: -20, hsl_sat_blue: 30,
  hsl_lum_orange: 15, vig_amount: -20, grain_amount: 15, usm_amount: 40, nr_luminance: 20,
};
const ROUNDTRIP_MASKS = [
  { name: "Round", shape: MASK, values: { l_exposure: 0.5, l_highlights: -30, l_shadows: 25, l_whites: 20,
                                          l_saturation: 15, l_cg_highlights_lum: 20, l_clarity: 15 } },
  { name: "Line", shape: { type: "gradient", x: 0.5, y: 0.3, angle: 90, width: 0.2 },
    values: { l_temp: -30, l_contrast: 20, l_blacks: -20, l_hsl_sat_blue: 25 } },
];

function sidecar(path) {
  const dir = join(path, "..");
  const x = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".xmp"));
  return x ? join(dir, x) : null;
}

async function roundtrip(photo) {
  const name = basename(photo);
  const path = fresh(photo);
  const o = await open(path);
  const temp = o.s.values.temp + 600;
  const want = { ...ROUNDTRIP, temp };
  await o.after(() => o.s.setMany(Object.entries(want)));
  for (const mk of ROUNDTRIP_MASKS) {
    await o.after(() => o.s.addMask(mk.name, [mk.shape]));
    await o.after(() => { for (const [k, v] of Object.entries(mk.values)) o.s.setLocal(mk.name, k, v); });
  }
  const before = await o.frame();
  await o.s.close();
  await stopEngine();
  startApp(engineHome);
  const again = await open(path);
  const wrong = [];
  for (const [id, v] of Object.entries(want)) {
    const c = m.controlById.get(id);
    const tol = Math.max(1.5 * c.step, 0.005 * (c.max - c.min));
    if (!(Math.abs(again.s.values[id] - v) <= tol)) wrong.push(`${id} ${v} → ${again.s.values[id]}`);
  }
  for (const mk of ROUNDTRIP_MASKS) {
    const got = again.s.masks.find((x) => x.name === mk.name);
    if (!got) { wrong.push(`mask ${mk.name} missing`); continue; }
    for (const [id, v] of Object.entries(neutralise(mk.values))) {
      const c = m.LOCAL_CONTROLS.find((x) => x.id === id);
      const tol = Math.max(1.5 * c.step, 0.01);
      if (!(Math.abs(got.values[id] - v) <= tol)) wrong.push(`${mk.name} ${id} ${v} → ${got.values[id]}`);
    }
  }
  record({ check: "roundtrip", photo: name, id: "values", status: wrong.length ? "fail" : "pass",
           detail: wrong.join(", ") });
  const d = compare(again.base, before);
  record({ check: "roundtrip", photo: name, id: "frame", status: d.mad <= THRESHOLD.roundtrip ? "pass" : "fail",
           detail: d.mad <= THRESHOLD.roundtrip ? "" : `opened again, it renders differently (mean |Δ| ${d.mad})`, trials: [d] });
  await again.s.close();
  return { path, frame: before };
}

// every local control, the ones not set at neutral: a value read back that
// should be 0 catches one control's field showing up as another's
function neutralise(values) {
  return { ...Object.fromEntries(m.LOCAL_CONTROLS.map((c) => [c.id, c.neutral ?? 0])), ...values };
}

// the roundtrip's edit as a release saved it, rendered by this build
async function reference(photo, saved) {
  const name = basename(photo);
  const dir = join(args.references, name);
  if (args.accept) {
    if (!saved) return;
    mkdirSync(dir, { recursive: true });
    copyFileSync(sidecar(saved.path), join(dir, "edit.xmp"));
    writeFileSync(join(dir, "frame.rgba"), Buffer.from(saved.frame.pixels.buffer, saved.frame.pixels.byteOffset,
                                                       saved.frame.pixels.byteLength));
    writeFileSync(join(dir, "frame.json"), JSON.stringify({ width: saved.frame.width, height: saved.frame.height,
                                                            git: args.git, date: new Date().toISOString() }));
    record({ check: "reference", photo: name, id: "recorded", status: "pass", detail: `kept in ${dir}` });
    return;
  }
  if (!existsSync(join(dir, "edit.xmp"))) {
    record({ check: "reference", photo: name, id: "edit", status: "skip", detail: "no reference yet: run with --accept" });
    return;
  }
  const meta = JSON.parse(readFileSync(join(dir, "frame.json"), "utf8"));
  const path = fresh(photo);
  copyFileSync(join(dir, "edit.xmp"), path + ".xmp");
  const o = await open(path);
  const ref = { ...meta, pixels: new Uint8ClampedArray(readFileSync(join(dir, "frame.rgba"))) };
  const d = compare(o.base, ref);
  record({ check: "reference", photo: name, id: `edit from ${meta.git}`, status: d.mad <= THRESHOLD.reference ? "pass" : "fail",
           detail: d.mad <= THRESHOLD.reference ? "" : `renders differently from when it was recorded (mean |Δ| ${d.mad}, max ${d.max})`,
           trials: [d] });
  await o.s.close();
}

// photos that are not raws, made from one by darktable's export, as the
// app's export_images asks (main.rs): a color JPEG (cameras' own can be
// black and white, which color tools rightly leave alone) and a 16-bit
// TIFF, as film scans come
async function rendered(raw) {
  const dir = join(args.work, "jpeg");
  mkdirSync(dir, { recursive: true });
  const { imgid } = await request({ cmd: "open", path: fresh(raw), imgid: -1 });
  const stem = join(dir, `${basename(raw).replace(/\.[^.]+$/, "")}-color`);
  const out = [];
  for (const [ext, format] of [["jpg", { format: "jpeg", quality: 92 }], ["tif", { format: "tiff", bpp: 16 }]]) {
    const path = `${stem}.${ext}`;
    await request({ cmd: "export", imgid, out: path, color_space: "srgb", long_edge: 3000, ...format });
    if (!existsSync(path)) throw new Error(`the ${format.format} was not exported`);
    out.push(path);
  }
  return out;
}

const CHECKS = { sliders, masks, choices, fixes, decisions };
try {
  if (args.rendered) args.photos.push(...await rendered(args.rendered));
  for (const photo of args.photos) {
    for (const check of args.checks) {
      if (!CHECKS[check]) continue;
      const t0 = performance.now();
      log(`${basename(photo)}: ${check}`);
      try { await CHECKS[check](photo); }
      catch (e) { record({ check, photo: basename(photo), id: "-", status: "fail", detail: String(e?.stack ?? e) }); }
      log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
    }
    let saved = null;
    if (args.checks.includes("roundtrip") || args.checks.includes("reference")) {
      try { saved = await roundtrip(photo); }
      catch (e) { record({ check: "roundtrip", photo: basename(photo), id: "-", status: "fail", detail: String(e?.stack ?? e) }); }
    }
    if (args.checks.includes("reference")) {
      try { await reference(photo, saved); }
      catch (e) { record({ check: "reference", photo: basename(photo), id: "-", status: "fail", detail: String(e?.stack ?? e) }); }
    }
  }
} finally {
  await stopEngine();
}

// a control that only some photos show (a color band) passes on any one of
// them; any other fails on any one
const groups = new Map();
for (const r of results) {
  const k = `${r.check}\u0000${r.id}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const summary = [...groups.values()].map((rs) => {
  const ran = rs.filter((r) => r.status !== "skip");
  const passed = ran.filter((r) => r.status === "pass");
  const status = !ran.length ? "skip"
    : rs[0].anyPhoto ? (passed.length ? "pass" : "fail")
    : passed.length === ran.length ? "pass" : "fail";
  return { check: rs[0].check, id: rs[0].id, status,
           detail: status === "fail" ? ran.filter((r) => r.status === "fail").map((r) => `${r.photo}: ${r.detail}`).join("; ")
             : status === "skip" ? rs[0].detail : "" };
});
writeFileSync(args.out, JSON.stringify({ results, summary }, null, 1));
