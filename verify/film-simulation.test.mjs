// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run after building the engine: node --test verify/film-simulation.test.mjs
//
// the Film Simulation panel's engine side, through the app's Session: the
// data pack (downloaded into darktable's shared data folder when it is not
// there), its stock lists and their hashes, turning the simulation on and
// back, and Export to Library. skipped, saying why, when the pack is
// missing and cannot be downloaded
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
    if (spec.startsWith("@tauri-apps/")) return next(shim, ctx);
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
const { SF_CHOICES } = await import("../app/src/manifest.ts");
const { filmChanges, presetValues, SF_PRESETS, stockHash } = await import("../app/src/spektrafilm.ts");
const { startEngine, stopEngine, request, requestTagged, invoke } = await import("./shim.mjs");

const view = () => ({ width: 128, height: 128 });
const differs = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 3 / 4);
};

// the pack, fetched once if it is missing; null when it cannot be
async function ensurePack() {
  let stocks = await invoke("spektra_stocks");
  if (stocks.pack) return stocks;
  const started = await invoke("spektra_fetch", { action: "start" });
  if (!started.started && started.state !== "running") return null;
  for (let i = 0; i < 600; i++) {
    const f = await invoke("spektra_fetch", { action: "status" });
    if (f.state === "failed") return null;
    if (f.state === "done") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  stocks = await invoke("spektra_stocks");
  return stocks.pack ? stocks : null;
}

test("film simulation: stocks, on and back, and Export to Library", { timeout: 600000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "immage-film-"));
  startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"));
  try {
    const stocks = await ensurePack();
    if (!stocks) { t.skip("no spektrafilm data pack, and it could not be downloaded"); return; }
    const films = stocks.stocks.filter((s) => !s.printing), papers = stocks.stocks.filter((s) => s.printing);
    assert.ok(films.length > 4 && papers.length > 2, "the pack lists films and papers");
    // the panel's hash must be the module's, or a preset names no stock
    for (const s of stocks.stocks) assert.equal(stockHash(s.stock), s.hash, `hash of ${s.stock}`);

    const path = join(dir, "photo.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
    const { imgid } = await request({ cmd: "open", path });
    let s = await Session.open(path, imgid, view, () => {}, () => {}, true);
    await s.settled();
    s.endBaseline();
    const rgba = join(dir, "frame.rgba");
    const render = async () => {
      await s.settled();
      await request({ cmd: "render", width: 192, height: 128, rgba });
      return readFileSync(rgba);
    };
    const get = () => request({ cmd: "get", modules: { agx: [], sigmoid: [], exposure: ["exposure"],
                                                       spektrafilm: ["film_hash"] } });
    // AgX with Contrast on it, as a new photo in the app has
    s.setMany([["tm_mode", 1], ["contrast", 20]]);
    const plain = await render();
    const tmOn = "agx";
    assert.ok((await get()).modules.agx.enabled, "the photo starts on AgX");

    // on, as the panel turns it on
    s.setMany([["sf_on", 1], ...Object.entries(SF_CHOICES)]);
    const gold = await render();
    let m = (await get()).modules;
    assert.ok(m.spektrafilm.enabled, "spektrafilm on");
    assert.ok(!m.agx.enabled && !m.sigmoid.enabled, "the tone mappers off");
    assert.ok(m.exposure.enabled, "exposure stays on");
    assert.ok(differs(plain, gold) > 2, "the simulation changes the photo (the pack is loaded)");

    // a stock by its hash renders that stock
    const portra = films.find((f) => f.stock === "kodak_portra_400") ?? films.find((f) => f.hash !== films[0].hash);
    s.setMany(filmChanges(stocks.stocks, s.values, portra));
    const other = await render();
    assert.equal((await get()).modules.spektrafilm.params.film_hash, portra.hash);
    assert.ok(differs(gold, other) > 0.5, "another film renders differently");
    // a preset sets every param, its stocks by hash
    const preset = SF_PRESETS.find((p) => p.name === "film|portrait");
    s.setMany(presetValues(preset));
    await render();
    assert.equal((await get()).modules.spektrafilm.params.film_hash, stockHash("kodak_portra_400"));

    // saved and opened again, the simulation and its tone mappers' settings hold
    await s.close();
    s = await Session.open(path, imgid, view, () => {}, () => {}, true);
    await s.settled();
    assert.equal(s.values.sf_on, 1, "opened again, it is a film simulation");
    assert.equal(s.values.sf_film_hash, stockHash("kodak_portra_400"));
    for (const [id, v] of Object.entries(SF_CHOICES)) assert.equal(s.values[id], v, `${id} on its film module`);

    // Export to Library: a positive with a neutral history
    const job = 301;
    await request({ cmd: "export_hold", job, imgids: [imgid] });
    const out = join(dir, "photo-film.tif");
    const exported = await requestTagged({ cmd: "export", job, imgid, out, format: "tiff", bpp: 32,
                                           positive_copy: true, history: false });
    await requestTagged({ cmd: "export_release", job });
    assert.equal(exported.path, out);
    assert.ok(readFileSync(out + ".xmp").length > 0, "the positive's neutral history is in its sidecar");

    // turned back, the tone mapper returns
    s.setMany([["sf_on", 0], ...Object.keys(SF_CHOICES).map((id) => [id, s.neutral[id]])]);
    await render();
    m = (await get()).modules;
    assert.ok(!m.spektrafilm.enabled, "spektrafilm off");
    assert.ok(m[tmOn].enabled, `${tmOn} back on`);
    await s.close();

    // the positive opens with nothing on that would apply the film twice
    await request({ cmd: "open", path: out });
    const pos = (await request({ cmd: "get", modules: { spektrafilm: [], agx: [], sigmoid: [] } })).modules;
    assert.ok(!pos.spektrafilm.enabled && !pos.agx.enabled && !pos.sigmoid.enabled, "the positive starts neutral");
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
