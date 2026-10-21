// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// @tauri-apps/api/core for the app's Session (app/src/session.ts) run under
// Node: invoke() goes straight to a darktable-engine child, as the Rust
// commands in app/src-tauri/src/main.rs would send it. those commands are
// one-line pass-throughs; where one shapes its request or reply, the table
// below does the same
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// main.rs's FRAME_HEAD: six u32 of geometry, six f32 of timings, the u64 hash
const FRAME_HEAD = 56;

let engine = null, frame = null;
const waiting = [];

// one engine for the process, in its own runtime folder, on the CPU so
// frames are the same from run to run
export function startEngine(binary, home) {
  mkdirSync(home, { recursive: true });
  frame = join(home, "frame.rgba");
  const me = spawn(binary, ["--core", "--configdir", join(home, "config"), "--cachedir", join(home, "cache"),
                            "--conf", "opencl=false"], { stdio: ["pipe", "pipe", "ignore"] });
  engine = me;
  exited = new Promise((r) => me.on("exit", r));
  createInterface({ input: me.stdout }).on("line", (line) => waiting.shift()?.(line));
  // only this engine's requests fail with it: a restart's are the next one's
  me.on("exit", () => { if (engine === me) for (const w of waiting.splice(0)) w(null); });
}
let exited = Promise.resolve();

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

export async function stopEngine() {
  if (!engine) return;
  await request({ cmd: "quit" }).catch(() => {});
  // it saves the open photo and writes its library before it exits
  await exited;
  engine = null;
}

// the header render() puts ahead of the frame
function framed(r) {
  const pixels = readFileSync(frame);
  const out = new ArrayBuffer(FRAME_HEAD + pixels.length);
  const v = new DataView(out);
  ["width", "height", "full_width", "full_height", "x", "y"].forEach((k, i) => v.setUint32(4 * i, r[k] ?? 0, true));
  v.setBigUint64(48, BigInt("0x" + (r.hash || "0")), true);
  new Uint8Array(out, FRAME_HEAD).set(pixels);
  return out;
}

const COMMANDS = {
  open_image: ({ path, imgid }) => request({ cmd: "open", path, imgid: imgid ?? -1 }),
  get_params: ({ modules }) => request({ cmd: "get", modules }),
  history: async ({ saved } = {}) => (await request({ cmd: "history", saved: saved ?? false })).items,
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
  render: async ({ width, height, scale, x, y, skip, draft }) => {
    const req = { cmd: "render", width, height, rgba: frame };
    if (skip) req.skip = skip;
    if (draft) req.draft = true;
    if (scale != null) Object.assign(req, { scale, x: x ?? 0, y: y ?? 0 });
    return framed(await request(req));
  },
  save: () => request({ cmd: "save" }),
  baseline_end: () => request({ cmd: "baseline_end" }),
  before_view: ({ on }) => request({ cmd: "before", on }),
  look_amount: ({ amount }) => request({ cmd: "look_amount", amount }),
  look_apply: async ({ path }) => (await request({ cmd: "look", path })).look,
  // only the idle base can be canceled, and the harness never asks for one
  cancel_base: () => Promise.resolve(),
};

export async function invoke(cmd, args = {}) {
  const f = COMMANDS[cmd];
  if (!f) throw new Error(`verify/shim.mjs has no ${cmd}`);
  return f(args);
}
