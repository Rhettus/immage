// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run after building the engine: IMMAGE_RAW=<raw with white balance presets> node --test verify/wb-in-module.test.mjs
//
// Session.wbInModule, the note for a photo whose white balance is set in the
// white balance module with color calibration off: temperature on, a setting
// other than camera reference and as shot to reference, channelmixerrgb off.
// it is checked on open and again once edits pause (Session.changed)
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
const raw = process.env.IMMAGE_RAW;

test("Session.wbInModule", { timeout: 300000 }, async (t) => {
  if (!existsSync(engine)) { t.skip(`no engine at ${engine}`); return; }
  const dir = mkdtempSync(join(tmpdir(), "immage-wbnote-"));
  startEngine(engine, join(dir, "runtime"));
  try {
    const open = async (src) => {
      const path = join(dir, src.slice(src.lastIndexOf("/") + 1));
      copyFileSync(src, path);
      const { imgid } = await request({ cmd: "open", path });
      const s = await Session.open(path, imgid, view, () => {}, () => {});
      await s.settled();
      s.endBaseline();
      return s;
    };
    let s = await open(join(root, "app/sample/stairs-to-mountain.jpg"));
    assert.equal(s.wbInModule, false, "a JPEG has white balance off");
    await s.close();
    if (!raw) { t.diagnostic("IMMAGE_RAW not set: the raw cases are skipped"); return; }
    s = await open(raw);
    assert.equal(s.wbInModule, false, "a raw starts as shot to reference with color calibration on");
    let notified = 0;
    s.onModules = () => notified++;
    // the cards are loaded as the Advanced panel loads them
    await s.loadAdvanced("temperature", 0, ["wb_setting"]);
    await s.loadAdvanced("channelmixerrgb", 0, ["illuminant"]);
    s.setFields("temperature", 0, { wb_setting: 0 });
    s.setAdvancedEnabled("channelmixerrgb", 0, false);
    await s.settled();
    // the edits schedule the check themselves
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(s.wbInModule, true, "as shot with color calibration off");
    assert.ok(notified > 0, "the panels are told");
    s.setFields("temperature", 0, { wb_setting: 3 });
    await s.settled();
    await s.refreshWb();
    assert.equal(s.wbInModule, false, "camera reference");
    s.setFields("temperature", 0, { wb_setting: 0 });
    s.setAdvancedEnabled("channelmixerrgb", 0, true);
    await s.settled();
    await s.refreshWb();
    assert.equal(s.wbInModule, false, "color calibration back on");
    await s.close();
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
