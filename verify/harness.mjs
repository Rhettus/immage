// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the release checks: the app's own Session (app/src/session.ts) driven
// headless, every slider of every panel and of a mask moved and the frame
// it renders measured. run by verify/run.py, with one JSON argument:
//   { engine, work, photos: [path], colorJpeg: raw, checks: [name], controls: [id], references, accept,
//     git, out }
// and writes `out`: every result, then the summary run.py reports
import { createRequire, registerHooks } from "node:module";
import { existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync, constants } from "node:fs";
import { basename, join } from "node:path";
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
// Tauri's invoke is the shim's
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    const out = transformSync(path, readFileSync(path, "utf8"), { jsx: { runtime: "automatic" } });
    if (out.errors?.length) throw new Error(`${path}: ${out.errors.map((e) => e.message).join("; ")}`);
    return { format: "module", source: out.code, shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec === "@tauri-apps/api/core") return next(SHIM, ctx);
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
const { startEngine, stopEngine, request } = await import(SHIM);
const { Session } = await import("../app/src/session.ts");
const m = await import("../app/src/manifest.ts");
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
  // app. done in one go, a mask's sliders can reach the engine ahead of its
  // shape: sendMaskQueues takes the shapes to send before it awaits, and
  // the sliders after
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

// a color JPEG made from a raw by darktable's export, for the JPEG path:
// cameras' own JPEGs can be black and white, which color tools rightly
// leave alone
async function colorJpeg(raw) {
  const dir = join(args.work, "jpeg");
  mkdirSync(dir, { recursive: true });
  const { imgid } = await request({ cmd: "open", path: fresh(raw), imgid: -1 });
  // as the app's export_images asks for one (main.rs)
  const path = join(dir, `${basename(raw).replace(/\.[^.]+$/, "")}-color.jpg`);
  await request({ cmd: "export", imgid, out: path, format: "jpeg", color_space: "srgb", quality: 92, long_edge: 3000 });
  if (!existsSync(path)) throw new Error("the color JPEG was not exported");
  return path;
}

const CHECKS = { sliders, masks, choices };
try {
  if (args.colorJpeg) args.photos.push(await colorJpeg(args.colorJpeg));
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
