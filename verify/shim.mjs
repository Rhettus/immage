// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// @tauri-apps/api/core for the app's Session (app/src/session.ts) run under
// Node: invoke() goes straight to a darktable-engine child, as the Rust
// commands in app/src-tauri/src/main.rs would send it. those commands are
// one-line pass-throughs; where one shapes its request or reply, the table
// below does the same
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// main.rs's FRAME_HEAD: six u32 of geometry, six f32 of timings, the u64
// hash, the edits' f32 timing and padding
export const FRAME_HEAD = 64;

// the commands the Rust layer registers (main.rs, generate_handler!): one
// it lacks fails in the app, as mask_rename did before 0.10.1
const HANDLERS = new Set(readFileSync(new URL("../app/src-tauri/src/main.rs", import.meta.url), "utf8")
  .match(/generate_handler!\[([^\]]*)\]/)[1].split(",").map((s) => s.trim().split("::").pop()).filter(Boolean));

let engine = null, frame = null, preview = null, range = null, denoised = null;
const waiting = [];
// requestTagged()'s and expectTagged()'s, by tag
const tagged = new Map();
let lastTag = 0;

// one engine for the process, in its own runtime folder, started as the
// app starts it (engine.rs): OpenCL on, with edits on the GPU when `gpu`
// (Preferences, Edit on the GPU), and export and the base there either way.
// with AI models from `modelsDir` when given; `onPerf` gets each line of
// darktable's -d perf timings, for the checks that look at the pipe; `env`
// added to the engine's environment
export function startEngine(binary, home, modelsDir = null, { gpu = false, onPerf = null, env = null } = {}) {
  mkdirSync(home, { recursive: true });
  frame = join(home, "frame.rgba");
  preview = join(home, "preview.rgba");
  range = join(home, "range.bin");
  denoised = join(home, "denoise-preview.f32");
  models.dir = modelsDir;
  // the engine takes --models ahead of darktable's own options
  const me = spawn(binary, [...(modelsDir ? ["--models", modelsDir] : []), "--core", "--configdir", join(home, "config"),
                            "--cachedir", join(home, "cache"), "--conf", "opencl=true",
                            "--conf", `opencl_device_priority=${gpu ? "*//*//" : "//*//"}`,
                            "--conf", "opencl_scheduling_profile=default",
                            ...(onPerf ? ["-d", "perf"] : [])],
                   { stdio: ["pipe", "pipe", onPerf ? "pipe" : "ignore"], env: { ...process.env, ...env } });
  engine = me;
  if (onPerf) createInterface({ input: me.stderr }).on("line", onPerf);
  exited = new Promise((r) => me.on("exit", r));
  createInterface({ input: me.stdout }).on("line", (line) => {
    const tag = /^\{"tag":(\d+)/.exec(line)?.[1];
    // a merge's progress lines come ahead of its answer, with its tag
    // (main.c, _merge_report); the app shows them (engine.rs, read_stdout)
    if (tag && /^\{"tag":\d+,"progress":true/.test(line)) return;
    const w = tag && tagged.get(Number(tag));
    if (w) { tagged.delete(Number(tag)); w(line); } else waiting.shift()?.(line);
  });
  // only this engine's requests fail with it: a restart's are the next one's
  me.on("exit", () => {
    if (engine !== me) return;
    for (const w of waiting.splice(0)) w(null);
    for (const w of tagged.values()) w(null);
    tagged.clear();
  });
}
let exited = Promise.resolve();
// the running engine's process, for the checks that measure it
export const enginePid = () => engine?.pid ?? null;

// one request at a time, as the Rust layer's Mutex<Engine> serializes them
let chain = Promise.resolve();
export function request(req) {
  const run = () => new Promise((resolve, reject) => {
    waiting.push((line) => {
      if (line === null) return reject(new Error("the engine exited"));
      const r = JSON.parse(line);
      if (r.ok) resolve(r); else reject(new Error(r.error ?? "engine request failed"));
    });
    engine.stdin.write(JSON.stringify(req) + "\n");
  });
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// a request the engine serves off its main loop (main.rs, Tagged): sent at
// once, beside whatever request() waits on, and answered by its tag
export function requestTagged(req) {
  const tag = ++lastTag;
  const answer = expectTagged(tag);
  engine.stdin.write(JSON.stringify({ ...req, tag }) + "\n");
  return answer;
}

// the answer to `tag`, waited for before it is asked (engine.rs, expect):
// for a request the main loop answers first and a thread of the engine's
// later, as ai_denoise
function expectTagged(tag) {
  return new Promise((resolve, reject) => {
    tagged.set(tag, (line) => {
      if (line === null) return reject(new Error("the engine exited"));
      const r = JSON.parse(line);
      if (r.ok) resolve(r); else reject(new Error(r.error ?? "engine request failed"));
    });
  });
}

// a request the main loop answers first and a thread of the engine's later,
// with the tag (main.rs, on_engine_thread): ai_denoise, the AI selections
async function onEngineThread(req) {
  const tag = ++lastTag;
  const answer = expectTagged(tag);
  try {
    await request({ ...req, tag });
  } catch (e) {
    tagged.delete(tag);
    throw e;
  }
  const { ok, tag: _, ...r } = await answer;
  return r;
}

// main.rs, ai_outline: the paths, or with `backdrop` the paths and the
// backdrop (its hue range and edge outline)
async function aiOutline(req, backdrop) {
  if (!backdrop) return (await onEngineThread(req)).paths;
  const r = await onEngineThread({ ...req, backdrop: true });
  return { paths: r.paths, backdrop: r.backdrop ?? null };
}

// it saves the open photo and writes its library before it exits; one
// still there after `wait` ms is killed, as engine.rs's reap does, and
// stopEngine() gives false
export async function stopEngine(wait = 5000) {
  if (!engine) return true;
  const me = engine;
  await request({ cmd: "quit" }).catch(() => {});
  let timer;
  const gone = await Promise.race([exited.then(() => true), new Promise((r) => { timer = setTimeout(r, wait, false); })]);
  clearTimeout(timer);
  if (!gone) {
    me.kill();
    await exited;
  }
  engine = null;
  return gone;
}

// the header render() puts ahead of the frame
function framed(r) {
  // a frame of no size names one the client holds: no pixels follow
  const pixels = r.kept ? new Uint8Array(0) : readFileSync(frame);
  const out = new ArrayBuffer(FRAME_HEAD + pixels.length);
  const v = new DataView(out);
  ["width", "height", "full_width", "full_height", "x", "y"].forEach((k, i) => v.setUint32(4 * i, r[k] ?? 0, true));
  // the engine's timings, as main.rs places them (Session's drafts read the pipeline's)
  v.setFloat32(32, r.process_ms ?? 0, true);
  v.setFloat32(36, r.write_ms ?? 0, true);
  v.setBigUint64(48, BigInt("0x" + (r.hash || "0")), true);
  new Uint8Array(out, FRAME_HEAD).set(pixels);
  return out;
}

// a map the engine wrote to the range file, behind its size
function sized(width, height) {
  const map = readFileSync(range);
  const out = new ArrayBuffer(8 + map.length);
  const v = new DataView(out);
  v.setUint32(0, width, true);
  v.setUint32(4, height, true);
  new Uint8Array(out, 8).set(map);
  return out;
}

const COMMANDS = {
  display_scale: () => (screen.scale === "error" ? Promise.reject(new Error("not on a screen yet")) : screen.scale),
  open_image: ({ path, imgid }) => request({ cmd: "open", path, imgid: imgid ?? -1 }),
  get_params: ({ modules }) => request({ cmd: "get", modules }),
  history: async ({ saved } = {}) => (await request({ cmd: "history", saved: saved ?? false })).items,
  module_state: ({ op, priority, enabled, reset, restore }) => {
    const req = { cmd: "module_state", op, priority, reset: reset ?? false };
    if (enabled != null) req.enabled = enabled;
    if (restore != null) req.restore = restore;
    return request(req);
  },
  masks: async ({ fields }) => (await request({ cmd: "masks", fields })).masks,
  spots: async ({ spots } = {}) => (await request({ cmd: "spots", ...(spots ? { spots } : {}) })).spots,
  spots_enable: ({ on }) => request({ cmd: "spots_enable", on }),
  mask_shapes: ({ name, shapes }) => request({ cmd: "mask", name, shapes }),
  mask_rename: ({ name, to }) => request({ cmd: "mask_rename", name, to }),
  mask_delete: ({ name }) => request({ cmd: "mask_delete", name }),
  combine: ({ name, members, ranges }) => request({ cmd: "combine", name, members, ranges: ranges ?? null }),
  set_params: ({ op, params, enabled, after, before, instance, mask, invert, opacity, refine }) => {
    const req = { cmd: "set", op, params, enabled };
    if (after != null) req.after = after;
    if (before != null) req.before = before;
    if (instance != null) req.instance = instance;
    if (mask != null) {
      req.mask = mask;
      req.invert = invert ?? false;
      if (opacity != null) req.opacity = opacity;
      if (refine != null) req.refine = refine;
    }
    return request(req);
  },
  // a move's module edits go first, as set_params would send them
  render: async ({ width, height, scale, x, y, skip, draft, have, edits }) => {
    for (const e of edits ?? []) {
      const set = { cmd: "set" };
      for (const k of ["op", "params", "enabled", "after", "before", "instance"]) if (e[k] != null) set[k] = e[k];
      await request(set);
    }
    const req = { cmd: "render", width, height, rgba: frame };
    if (skip) req.skip = skip;
    if (draft) req.draft = true;
    if (have) req.have = have;
    if (scale != null) Object.assign(req, { scale, x: x ?? 0, y: y ?? 0 });
    return framed(await request(req));
  },
  // an 8-byte header, width and height, then RGBA
  preview: async ({ size, edits, withLook, look }) => {
    const req = { cmd: "preview", size, edits, rgba: preview };
    if (withLook) req.look = look;
    const r = await request(req);
    const pixels = readFileSync(preview);
    const out = new ArrayBuffer(8 + pixels.length);
    const v = new DataView(out);
    v.setUint32(0, r.width, true);
    v.setUint32(4, r.height, true);
    new Uint8Array(out, 8).set(pixels);
    return out;
  },
  sample: ({ x, y, area, stage }) => request({ cmd: "sample", x, y, box: area ?? null, stage: stage ?? null }),
  // u32 width and height, then a byte a point
  range_map: async ({ ranges, width, height }) =>
    sized(width, height, await request({ cmd: "range_map", ranges, width, height, out: range })),
  mask_map: async ({ name, op, width, height, view }) => {
    const req = { cmd: "mask_map", width, height, out: range };
    if (name != null) req.name = name;
    if (op != null) req.op = op;
    if (view) for (const k of ["x", "y", "scale"]) req[k] = view[k];
    const r = await request(req);
    return sized(r.width ?? width, r.height ?? height, r);
  },
  save: () => request({ cmd: "save" }),
  baseline_end: () => request({ cmd: "baseline_end" }),
  before_view: ({ on }) => request({ cmd: "before", on }),
  look_amount: ({ amount }) => request({ cmd: "look_amount", amount }),
  look_apply: async ({ path }) => (await request({ cmd: "look", path })).look,
  // only the idle base can be canceled, and the harness never asks for one
  cancel_base: () => Promise.resolve(),
  // a model is copied from models.source in place of the download
  ai_model_ensure: async ({ id }) => {
    if (!existsSync(join(models.dir, id, "config.json"))) cpSync(join(models.source, id), join(models.dir, id), { recursive: true });
  },
  ai_model_reinstall: async ({ id }) => {
    rmSync(join(models.dir, id), { recursive: true, force: true });
    cpSync(join(models.source, id), join(models.dir, id), { recursive: true });
  },
  // the main loop takes the edit and answers, then the denoise thread
  ai_denoise: ({ strength }) => onEngineThread({ cmd: "ai_denoise", strength }),
  ai_denoise_preview: ({ u, v, size }) =>
    request({ cmd: "ai_denoise_preview", u, v, size, out: denoised }),
  // the main loop renders the model's input and answers, then the AI thread
  ai_object: ({ points, box, inset, backdrop }) =>
    aiOutline({ cmd: "ai_object", points, ...(box ? { box } : {}), ...(inset === false ? { inset } : {}) }, backdrop),
  ai_mask: ({ kind, range, inset, backdrop }) =>
    aiOutline({ cmd: "ai_mask", kind, ...(range ? { range } : {}), ...(inset === false ? { inset } : {}) }, backdrop),
  ai_depth: ({ size }) => onEngineThread({ cmd: "ai_depth", size }),
  // on the export thread
  hdr_merge: ({ imgids, align }) => requestTagged({ cmd: "hdr_merge", imgids, align }),
  hdr_can_align: async () => (await request({ cmd: "version" })).hdr_align ?? false,
  pano_merge: ({ imgids, projection, crop }) => requestTagged({ cmd: "pano_merge", imgids, projection, crop }),
  pano_can_merge: async () => (await request({ cmd: "version" })).pano ?? false,
  meta_set: ({ imgid, fields }) => request({ cmd: "meta_set", imgid, ...fields }),
  // as main.rs, with the files removed rather than put in the trash
  trash_files: async ({ imgids }) => {
    const gone = [];
    for (const imgid of imgids) {
      const { image } = await request({ cmd: "meta", imgid });
      if (!image.rejected) throw new Error(`${image.filename} is not rejected; nothing was deleted`);
      const cmd = image.copy ? "remove_copy" : "sidecars";
      const { files } = await request({ cmd, imgid });
      for (const f of [...(image.copy ? [] : [image.path]), ...files]) rmSync(f, { force: true });
      if (!image.copy) {
        await request({ cmd: "forget", imgid });
        gone.push(image.path);
      }
    }
    return gone;
  },
};

// the engine's models folder (startEngine's), and where a check's models
// are installed from
export const models = { dir: null, source: null };

// a check's hook on each request as it goes to the engine, to change the
// edit while the engine has it, as a user can
export const sent = { hook: null };

// library.ts's imports: no events reach a check, and Immich is not reached
export const listen = async () => () => {};
export const api = {};

// the screen's scale display_scale gives (none, a number, or "error" for a
// window not on a screen yet), and pixelRatio.ts's window: it never moves
export const screen = { scale: null };
export const getCurrentWindow = () => ({ onMoved: async () => () => {}, onScaleChanged: async () => () => {} });

export async function invoke(cmd, args = {}) {
  if (!HANDLERS.has(cmd)) throw new Error(`the app registers no command ${cmd} (main.rs, generate_handler!)`);
  const f = COMMANDS[cmd];
  if (!f) throw new Error(`verify/shim.mjs has no ${cmd}`);
  const reply = f(args);
  sent.hook?.(cmd, args);
  return reply;
}
