// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run after building the engine: node --test verify/whites-brilliance.test.mjs
//
// Whites: Advanced's Highlight Brilliance on AgX, through the app's Session:
// the share of color balance rgb's highlights brilliance Whites adds, saved
// and read back, 0% leaving brilliance at 0, and an edit from before the
// setting (a share of 100%) reading as 100%
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

test("Whites: Advanced's Highlight Brilliance", { timeout: 300000 }, async (t) => {
  if (!existsSync(engine)) { t.skip(`no engine at ${engine}`); return; }
  const dir = mkdtempSync(join(tmpdir(), "immage-whites-"));
  startEngine(engine, join(dir, "runtime"));
  try {
    const path = join(dir, "photo.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
    const { imgid } = await request({ cmd: "open", path });
    const open = async () => {
      const s = await Session.open(path, imgid, view, () => {}, () => {}, true);
      await s.settled();
      return s;
    };
    const brilliance = async () => (await request({ cmd: "get", modules: { colorbalancergb: ["brilliance_highlights"] } }))
      .modules.colorbalancergb.params.brilliance_highlights;

    let s = await open();
    s.endBaseline();
    assert.equal(s.values.whites_brilliance, 100, "a new photo starts at 100%");
    // Whites alone: today's brilliance, as before the setting
    s.setMany([["tm_mode", 1], ["whites", 50]]);
    await s.settled();
    const full = await brilliance();
    assert.ok(full > 0, "Whites adds brilliance on AgX");
    await s.close();
    s = await open();
    assert.equal(s.values.whites, 50);
    assert.equal(s.values.whites_brilliance, 100, "an edit at the old share reads as 100%");

    s.setMany([["whites_brilliance", 40]]);
    await s.settled();
    assert.ok(Math.abs(await brilliance() - full * 0.4) < 1e-4, "40% adds 40% of it");
    await s.close();
    s = await open();
    assert.equal(s.values.whites, 50, "Whites is unchanged by the share");
    assert.equal(s.values.whites_brilliance, 40, "the share reads back");

    s.setMany([["whites_brilliance", 0]]);
    await s.settled();
    assert.equal(await brilliance(), 0, "0% adds none");
    await s.close();
    s = await open();
    assert.equal(s.values.whites, 50);
    assert.equal(s.values.whites_brilliance, 0, "0% reads back while Whites is set");
    await s.close();
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
