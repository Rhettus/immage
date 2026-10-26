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
    if (spec === "@tauri-apps/api/core" || spec === "@tauri-apps/api/event" || spec === "@immporter/api") return next(SHIM, ctx);
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(spec)) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

// what the WebView would have: the timers Session and activity.ts use, and
// localStorage, which holds Preferences › Modules
const store = new Map();
globalThis.window = globalThis;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 16);
globalThis.cancelAnimationFrame = (t) => clearTimeout(t);

const args = JSON.parse(process.argv[2]);
const { startEngine, stopEngine, request, invoke, sent, models, FRAME_HEAD } = await import(SHIM);
const { Session } = await import("../app/src/session.ts");
const { withModel } = await import("../app/src/aiModel.ts");
const m = await import("../app/src/manifest.ts");
const { canMerge } = await import("../app/src/localMerge.ts");
const { overlayShown, overlayStep } = await import("../app/src/masks.ts");
const { ILLUMINANT_D } = await import("../app/src/wb.ts");
const { autoTone } = await import("../app/src/autoTone.ts");
const { dueIn } = await import("../app/src/activity.ts");
const { byCaptureTime } = await import("../app/src/library.ts");
const { NO_FILTER, exposureLabel, facetsWithin, passes } = await import("../app/src/filter.ts");
const z = await import("../app/src/zones.ts");
const nd = await import("../app/src/negadoctor.ts");
const { compare, meanChroma, inEllipse, rightOf } = await import("./metrics.mjs");
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

let engineHome = join(args.work, "runtime");
startEngine(args.engine, engineHome);

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
  startEngine(args.engine, engineHome);
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
      startEngine(args.engine, join(args.work, "ai-engine"), dir);
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
}

// what Immage decided it does, as README.md, the code map and the
// backlog's Decisions record it. changing one is deliberate, and changes
// its check with it
async function decisions(photo) {
  const decide = (id, run) => outcome("decisions", basename(photo), id, run);

  // the new-photo defaults never mark a photo edited, in Immage or in
  // darktable, and apply once; the user's first change does mark it
  // (code-map.md, Engine; backlog.md, 0.23.2)
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
  // name order, and photos without a capture time go last (user guide,
  // library.md, The filmstrip and the grid)
  await decide("the filmstrip is in capture order", async () => {
    const { images: [e] } = await request({ cmd: "import", files: [fresh(photo)] });
    const t = e?.exif.datetime ?? "";
    if (!/^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d/.test(t)) return `the engine gave capture time ${JSON.stringify(t)}`;
    const at = (filename, datetime) => ({ ...e, filename, exif: { ...e.exif, datetime } });
    const later = `${Number(t.slice(0, 4)) + 1}${t.slice(4)}`;
    const got = byCaptureTime([at("a", ""), at("b", later), at("c", t), at("d", t)]).map((i) => i.filename).join("");
    return got === "cdba" ? null : `sorted as ${got}, not cdba`;
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

  // the photo is never written, only its sidecar (code-map.md, Where data
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

  // trying a setting, as a preset's tile does, never touches the edit or
  // the main pipe (code-map.md, Engine); and a frame of an unchanged edit
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
    const by = compare(both, alone).mad;
    if (by > THRESHOLD.roundtrip) return `+1 EV compensation and Exposure +0.5 differ from Exposure +1.5 (mean |Δ| ${by})`;
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
  // photo it can remove more than it adds (colorbalancergb.c, init_presets)
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
      const by = meanChroma(await o.after(() => o.s.set("profile", pr.value))) / plain;
      if (Math.abs(by - 1) < 0.03) weak.push(`${pr.label} ${((by - 1) * 100).toFixed(1)}%`);
    }
    await o.s.close();
    return weak.length ? `chroma against AgX Default, needs 3% either way: ${weak.join(", ")}` : null;
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
      startEngine(args.engine, join(args.work, "ai-engine"), args.models);
      try {
        const path = fresh(photo);
        let o = await open(path);
        const paths = await invoke("ai_object", { points: [], box: [0.3, 0.3, 0.7, 0.7] });
        if (!paths?.length) return "Select Object found nothing in the middle of the photo";
        const name = z.zoneMaskName([0, 10], { kind: "object:A", invert: false });
        await o.after(() => o.s.addMask(name, [z.zoneShape([0, 10], 1), { type: "object", paths, mode: "add" }]));
        const f = await o.after(() => o.s.setLocal(name, "l_exposure", 1));
        const err = brighter(f, o.base, inPaths(paths, true));
        if (err) return `inside the object: ${err}`;
        const out = compare(f, o.base, inPaths(paths, false));
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
  startEngine(args.engine, engineHome);
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
