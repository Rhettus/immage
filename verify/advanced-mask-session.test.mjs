// SPDX-License-Identifier: GPL-3.0-or-later
// Advanced mask lifecycle through the actual Session and isolated headless engine.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../app/package.json", import.meta.url));
const { transformSync } = await import(require.resolve("rolldown/experimental"));
const shim = new URL("./shim.mjs", import.meta.url).href;
registerHooks({
  load(url, ctx, next) {
    if (!url.startsWith("file:") || !/\.tsx?$/.test(url)) return next(url, ctx);
    const path = fileURLToPath(url);
    return { format: "module", source: transformSync(path, readFileSync(path, "utf8"), { jsx: { runtime: "automatic" } }).code,
             shortCircuit: true };
  },
  resolve(spec, ctx, next) {
    if (spec.startsWith("@tauri-apps/") || spec === "@immporter/api") return next(shim, ctx);
    if (/^\.\.?\//.test(spec) && !/\.[cm]?[jt]sx?$/.test(spec))
      for (const ext of [".ts", ".tsx"]) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    return next(spec, ctx);
  },
});
globalThis.window = globalThis;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)),
                            removeItem: (k) => store.delete(k) };
globalThis.addEventListener ??= () => {};
globalThis.requestAnimationFrame = (f) => setTimeout(() => f(performance.now()), 0);
globalThis.cancelAnimationFrame = clearTimeout;
const { Session } = await import("../app/src/session.ts");
const { startEngine, stopEngine, request } = await import("./shim.mjs");

const view = () => ({ width: 128, height: 128 });
const engine = process.env.IMMAGE_TEST_ENGINE ?? join(root, "build/bin/darktable-engine");

const { replaceMasks } = await import("../app/src/batchPaste.ts");
const { localFields } = await import("../app/src/manifest.ts");
process.env.OMP_NUM_THREADS = "2";

test("Advanced mask Session lifecycle", { timeout: 300000 }, async (t) => {
  if (!existsSync(engine)) { t.skip(`no engine at ${engine}`); return; }
  const dir = mkdtempSync(join(tmpdir(), "immage-mask-session-"));
  const errors = [];
  startEngine(engine, join(dir, "runtime"));
  try {
    const path = join(dir, "photo.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
    const open = async (advanced = true) => {
      const s = await Session.open(path, null, view, () => {}, (e) => errors.push(String(e)), true);
      await s.settled();
      if (advanced) await s.loadInstances();
      s.endBaseline();
      return s;
    };
    let s = await open();
    const settle = async () => { await s.settled(); assert.deepEqual(errors, []); };
    const masks = async () => (await request({ cmd: "masks", fields: localFields() })).masks;
    const own = async (name, op) => (await request({ cmd: "instances" })).instances.find(i => i.mask === name && i.op === op);
    const params = async (name, op, fields) => {
      const i = await own(name, op);
      assert.ok(i, `${name}/${op} exists`);
      return (await request({ cmd: "get", modules: { [`${op}@${i.priority}`]: fields } })).modules[`${op}@${i.priority}`];
    };
    s.addMask("Sky", [{type:"ellipse", x:.5,y:.5,rx:.3,ry:.3,angle:0,feather:.2}]);
    await settle();
    s.addMaskModule("Sky", "colorzones");
    await settle();
    let i = await own("Sky", "colorzones");
    assert.ok(i, "Add module creates a mask-owned instance");
    await s.loadAdvanced("colorzones", i.priority, ["strength"]);
    s.setFields("colorzones", i.priority, { strength: .7 });
    await settle();
    assert.equal((await masks()).find(m=>m.name==="Sky").instances.colorzones.extra, true);
    assert.ok(s.masks.find(m=>m.name==="Sky").extra?.includes("colorzones"));
    assert.ok(Math.abs((await params("Sky", "colorzones", ["strength"])).params.strength-.7)<1e-5);

    s.setLocal("Sky", "l_contrast", 20);
    await settle();
    i = await own("Sky", "colorbalancergb");
    assert.ok(i);
    await s.loadAdvanced(i.op, i.priority, ["contrast", "chroma_global"]);
    s.setFields(i.op, i.priority, { chroma_global: .25, contrast: .1234567 });
    await settle();
    assert.ok(s.masks.find(m=>m.name==="Sky").extra?.includes("colorbalancergb"));
    s.setLocal("Sky", "l_exposure", 1.5);
    await settle();
    assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["chroma_global"])).params.chroma_global-.25)<1e-5,
      "Simple slider preserves the unmapped card edit");
    assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["contrast"])).params.contrast-.1234567)<1e-7,
      "the full card value is preserved without a Simple-slider round trip");
    s.setLocal("Sky", "l_saturation", 10); await settle();
    assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["contrast"])).params.contrast-.1234567)<1e-7,
      "another Simple control on the same module preserves untouched Advanced fields");

    s.setLocalMany("Sky", [["l_cg_global_hue", 135], ["l_cg_global_sat", 42]]);
    await settle();
    const graded = (await params("Sky", "colorbalancergb", ["global_H", "global_C", "contrast"])).params;
    assert.equal(graded.global_H, 135);
    assert.ok(Math.abs(graded.global_C - .084) < 1e-7);
    assert.ok(Math.abs(graded.contrast - .1234567) < 1e-7,
      "the wheel batch preserves other edits on the same module");

    const snapshot = structuredClone(s.masks);
    for (const hide of [true,false]) {
      s.setHidden("Sky", hide); await settle();
      assert.equal((await own("Sky","colorzones")).enabled, !hide, "mask hide applies to advanced-only modules");
      assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["contrast"])).params.contrast-.1234567)<1e-7,
        "mask visibility preserves exact advanced parameters");
    }
    s.showBefore(()=>false); await settle();
    assert.equal((await own("Sky","colorzones")).enabled,false);
    s.showBefore(null); await settle();
    assert.equal((await own("Sky","colorzones")).enabled,true);
    i = await own("Sky", "colorzones");
    s.setAdvancedEnabled(i.op, i.priority, false); await settle();
    s.setHidden("Sky", true); await settle();
    s.setHidden("Sky", false); await settle();
    assert.equal((await own("Sky", "colorzones")).enabled, false,
      "mask hide and unhide preserve a card switched off by the user");
    s.setAdvancedEnabled(i.op, i.priority, true); await settle();
    s.setLocal("Sky", "l_exposure", .75);
    const pendingSnapshot = structuredClone(s.masks);
    s.setLocal("Sky", "l_exposure", 1.25);
    await settle();
    replaceMasks(s, pendingSnapshot); await settle();
    assert.ok(Math.abs((await params("Sky", "exposure", ["exposure"])).params.exposure-.75)<1e-5,
      "undo preserves a local slider snapshot taken while its native write was pending");
    replaceMasks(s, snapshot); await settle();
    const beforeAdd = { masks: structuredClone(s.masks), instances: s.instanceLayout(), advanced: new Map(s.advanced) };
    s.addMaskModule("Sky", "bloom"); await settle();
    const afterAdd = { masks: structuredClone(s.masks), instances: s.instanceLayout(), advanced: new Map(s.advanced) };
    replaceMasks(s, beforeAdd.masks);
    s.restoreInstances(beforeAdd.instances);
    s.restoreAdvanced(beforeAdd.advanced);
    await settle();
    assert.equal(await own("Sky", "bloom"), undefined, "undo Add module removes the mask instance");
    replaceMasks(s, afterAdd.masks);
    s.restoreInstances(afterAdd.instances);
    s.restoreAdvanced(afterAdd.advanced);
    await settle();
    assert.ok(await own("Sky", "bloom"), "redo Add module restores the mask instance");
    replaceMasks(s, beforeAdd.masks);
    s.restoreInstances(beforeAdd.instances);
    s.restoreAdvanced(beforeAdd.advanced);
    await settle();
    s.duplicateMask("Sky","Copy",true); await settle();
    assert.ok(Math.abs((await params("Copy","colorzones",["strength"])).params.strength-.7)<1e-5,
      "duplicate preserves full advanced-only parameters");
    assert.ok(Math.abs((await params("Copy","colorbalancergb",["chroma_global"])).params.chroma_global-.25)<1e-5);
    s.renameMask("Copy","Cloud"); await settle();
    assert.ok(await own("Cloud","colorzones"));
    s.deleteMask("Cloud"); await settle();
    assert.equal(await own("Cloud","colorzones"),undefined);
    replaceMasks(s,snapshot); await settle();
    const cardSnapshot = new Map(s.advanced);
    const layoutSnapshot = s.instanceLayout();
    i = await own("Sky", "colorzones");
    s.resetAdvanced(i.op, i.priority); await settle();
    assert.equal((await params("Sky", "colorzones", ["strength"])).params.strength, 0,
      "card Reset restores darktable defaults");
    replaceMasks(s, snapshot);
    s.restoreInstances(layoutSnapshot);
    s.restoreAdvanced(cardSnapshot);
    await settle();
    assert.ok(Math.abs((await params("Sky", "colorzones", ["strength"])).params.strength-.7)<1e-5,
      "undo of card Reset restores its full parameters");
    s.resetMaskAdjustments("Sky"); await settle();
    replaceMasks(s,snapshot); await settle();
    assert.ok(Math.abs((await params("Sky","colorzones",["strength"])).params.strength-.7)<1e-5,
      "snapshot restoration preserves full advanced-only parameters");

    const beforeRemove = s.instanceLayout();
    s.removeMaskModule("Sky","colorzones"); await settle();
    assert.equal(await own("Sky","colorzones"),undefined);
    s.restoreInstances(beforeRemove); await settle();
    assert.ok(await own("Sky","colorzones"), "undo restores a removed mask module");
    s.removeMaskModule("Sky", "colorzones"); await settle();
    s.addMaskModule("Sky", "colorzones"); await settle();
    assert.ok(await own("Sky", "colorzones"), "a removed module can be added again");
    replaceMasks(s, snapshot); await settle();
    const copied = structuredClone(s.masks);
    await s.close();
    s = await open(false);
    assert.ok(Math.abs((await params("Sky","colorzones",["strength"])).params.strength-.7)<1e-5,
      "save and reopen retain advanced-only edits");
    assert.ok(s.masks.find(m=>m.name==="Sky").extra?.includes("colorbalancergb"));
    s.setHidden("Sky", true); await settle();
    s.setHidden("Sky", false); await settle();
    assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["contrast"])).params.contrast-.1234567)<1e-7,
      "Simple mode preserves exact advanced edits after reopening");
    await s.close();
    const destination = join(dir, "destination.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), destination);
    s = await Session.open(destination, null, view, () => {}, e => errors.push(String(e)), true);
    await settle();
    replaceMasks(s, copied); await settle();
    assert.ok(Math.abs((await params("Sky", "colorzones", ["strength"])).params.strength-.7)<1e-5,
      "Copy Settings preserves advanced-only parameters on another photo");
    assert.ok(Math.abs((await params("Sky", "colorbalancergb", ["chroma_global"])).params.chroma_global-.25)<1e-5,
      "Copy Settings preserves unmapped parameters on another photo");
    s.addMask("Neutral", [{type:"ellipse", x:.3,y:.3,rx:.2,ry:.2,angle:0,feather:.2}]);
    await settle();
    s.addMaskModule("Neutral", "exposure"); await settle();
    assert.equal((await own("Neutral", "exposure")).enabled, true,
      "Add module enables a Simple-mapped module even before its first adjustment");
    i = await own("Neutral", "exposure");
    await s.loadAdvanced(i.op, i.priority, ["exposure", "black", "mode"]);
    assert.equal(s.advanced.get(`${i.op}#${i.priority}`).enabled, true);
    const preset = "_builtin_magic lantern defaults";
    assert.ok((await s.loadPresets(i.op, i.priority)).some((p) => p.name === preset && p.applicable));
    s.setHidden("Neutral", true); await settle();
    s.applyPreset(i.op, i.priority, preset); await settle();
    assert.equal(s.advanced.get(`${i.op}#${i.priority}`).params.mode, 1);
    assert.ok(s.masks.find((m) => m.name === "Neutral").extra?.includes("exposure"));
    assert.equal((await own("Neutral", "exposure")).enabled, false, "presets preserve hidden masks");
    s.setHidden("Neutral", false); await settle();
    assert.equal((await own("Neutral", "exposure")).enabled, true, "the card is still enabled after unhiding");
    assert.equal((await params("Neutral", "exposure", ["mode"])).params.mode, 1);
    const name = "Mask Exposure";
    const saved = (await s.loadPresets(i.op, i.priority, { action: "save", name })).find(p => p.name === name);
    assert.ok(saved?.active);
    s.applyPreset(i.op, i.priority, name); await settle();
    assert.equal((await own("Neutral", "exposure")).name, i.name);
    assert.equal((await own("Neutral", "exposure")).enabled, true);
    const remaining = await s.loadPresets(i.op, i.priority, { action: "delete", name, version: saved.version });
    assert.ok(!remaining.some(p => p.name === name));
    await s.close();
  } finally {
    await stopEngine();
    if (process.env.KEEP) console.log(dir); else rmSync(dir,{recursive:true,force:true});
  }
});
