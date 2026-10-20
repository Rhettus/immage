// Immage's own control-to-module mapping (app/src/manifest.ts) for the
// benchmark harness, so it sends the engine the edits the app would. one JSON
// request per line on stdin, one reply per line on stdout:
//   {"cmd":"fields"}                       -> {"fields": boundFields()}
//   {"cmd":"init","info":{..},"ctx":{..}}  -> {"controls": {id: {min,max,neutral,value}}}
//   {"cmd":"set","values":{id: v}}         -> {"edits": [engine "set" requests]}
//   {"cmd":"neutralize","wb":{temp,tint},"rgb":[r,g,b]} -> {"wb": wb.ts neutralize()}
//   {"cmd":"whitePatch","path":rgba file,"width":w,"height":h} -> {"rgb": wb.ts whitePatch()}
//   {"cmd":"anchored","shot":{temp,tint},"est":{temp,tint}} -> {"wb": wb.ts anchored()}
//   {"cmd":"autoExposure","current":ev,"zones":zones reply file} -> {"auto": autoTone.ts autoExposure()}
//   {"cmd":"autoTone","path":rgba file,"width":w,"height":h,"key":{lowKey,highKey}} -> {"values": autoTone()}
//   {"cmd":"blacksFromLinear","v":v}       -> {"v": manifest.ts blacksFromLinear()}
//   {"cmd":"local","op":op,"values":{id: v}} -> {"params": the local map's write(), as Session sends a mask's}
//   {"cmd":"planMerge","masks":[Mask],"before":b} -> {"merged": {mask: [op]}, "shared": localMerge.ts planMerge()}
// it mirrors Session.open and Session.moduleEdit (app/src/session.ts) without
// foreign maps, bypasses, the Before view or edited photos' module choices,
// which the benchmark never meets
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";

// the app imports without extensions, as Vite allows
registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(spec)) {
      for (const ext of [".ts", ".tsx"]) {
        const url = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(url))) return next(url.href, ctx);
      }
    }
    return next(spec, ctx);
  },
});

const m = await import("../../app/src/manifest.ts");
const { modules, controlById, mapsFor, mapsWith, boundFields, blacksFromLinear, MODULE_CHOICES, preferredChoice,
        choiceOn, isModuleSetting } = m;
const { neutralize, whitePatch, anchored } = await import("../../app/src/wb.ts");
const { autoExposure, autoTone } = await import("../../app/src/autoTone.ts");
const { parseZones } = await import("../../app/src/zones.ts");
const { localMaps } = m;
const { planMerge } = await import("../../app/src/localMerge.ts");
const { neutralLocal } = await import("../../app/src/masks.ts");
// a mask's values as the app keeps them: every local control, neutral
// unless given
const local = (v) => ({ ...neutralLocal(), ...v });

let info = {}, ctx = null;
const values = {}, neutral = {};

function init(i, c) {
  info = i;
  ctx = c;
  for (const map of modules) {
    const mi = info[map.op];
    if (!mi) continue;
    const fromDefaults = map.read(mi.defaults, mi.defaults, ctx);
    const current = mi.enabled ? map.read(mi.params, mi.defaults, ctx, values) : {};
    for (const id of map.controls) {
      const c = controlById.get(id);
      const n = c.neutral ?? fromDefaults[id];
      neutral[id] = n;
      if (current[id] !== undefined || values[id] === undefined) values[id] = current[id] ?? n;
    }
  }
  // the benchmark's photos are unedited: each tool takes Preferences' Default
  for (const c of MODULE_CHOICES) neutral[c.control] = values[c.control] = preferredChoice(c);
  return Object.fromEntries([...controlById.values()].filter((c) => c.id in values).map((c) =>
    [c.id, { min: c.min, max: c.max, step: c.step, neutral: neutral[c.id], value: values[c.id] }]));
}

function moduleEdit(op) {
  const mi = info[op] ?? { enabled: false, defaults: {} };
  let params = {}, on = false, keepOn = false, after, before;
  for (const map of mapsFor(op)) {
    after ??= map.after;
    before ??= map.before;
    const chosen = choiceOn(map, values);
    const v = chosen ? values : { ...values, ...Object.fromEntries(map.controls
      .filter((id) => !isModuleSetting(id)).map((id) => [id, neutral[id]])) };
    params = { ...params, ...map.write(v, mi.defaults, ctx) };
    keepOn ||= map.keepOn;
    on ||= chosen && (map.enabled ? map.enabled(values) : map.controls.some((id) => values[id] !== neutral[id]));
  }
  const enabled = keepOn ? mi.enabled || on : on;
  const [real, instance] = op.split("#");
  return { op: real, params, enabled, ...(instance ? { instance } : {}), ...(after ? { after } : {}),
           ...(before ? { before } : {}) };
}

function set(vals) {
  const dirty = new Set();
  for (const [id, v] of Object.entries(vals)) {
    if (!controlById.has(id)) throw new Error(`no control '${id}'`);
    values[id] = v;
    for (const map of mapsWith(id)) dirty.add(map.op);
  }
  return [...dirty].map(moduleEdit);
}

const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let reply;
  try {
    const req = JSON.parse(line);
    if (req.cmd === "fields") reply = { fields: boundFields() };
    else if (req.cmd === "init") reply = { controls: init(req.info, req.ctx) };
    else if (req.cmd === "set") reply = { edits: set(req.values) };
    else if (req.cmd === "neutralize") reply = { wb: neutralize(req.wb, req.rgb) };
    else if (req.cmd === "whitePatch")
      reply = { rgb: whitePatch(new Uint8ClampedArray(readFileSync(req.path)), req.width, req.height) };
    else if (req.cmd === "anchored") reply = { wb: anchored(req.shot, req.est) };
    else if (req.cmd === "autoExposure") {
      const b = readFileSync(req.zones);
      reply = { auto: autoExposure(req.current, parseZones(b.buffer.slice(b.byteOffset, b.byteOffset + b.length))) };
    } else if (req.cmd === "autoTone")
      reply = { values: autoTone(new Uint8ClampedArray(readFileSync(req.path)), req.width, req.height, req.key) };
    else if (req.cmd === "blacksFromLinear") reply = { v: blacksFromLinear(req.v) };
    else if (req.cmd === "local") {
      const map = localMaps.find((l) => l.op === req.op);
      if (!map) throw new Error(`no local map '${req.op}'`);
      reply = { params: map.write(local(req.values), {}, ctx) };
    } else if (req.cmd === "planMerge") {
      const masks = req.masks.map((mk) => ({ ...mk, values: local(mk.values) }));
      const plan = planMerge(masks, values, !!req.before, ctx);
      reply = { merged: Object.fromEntries([...plan.merged].map(([k, v]) => [k, [...v]])), shared: plan.shared };
    }
    else throw new Error(`unknown cmd '${req.cmd}'`);
    reply.ok = true;
  } catch (e) {
    reply = { ok: false, error: String(e) };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
}
