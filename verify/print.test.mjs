// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run after building the engine: node --test verify/print.test.mjs
//
// the Print panel's app side: the page layout (print.ts), the soft proof
// through the app's Session (a redraw after the engine's view changes, and
// back to the same pixels), and a PDF written through print_photo as the
// panel asks for it. verify/print.py checks the engine's side in more depth
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { narrowPrinterProfile } from "./gui/support/icc.mjs";

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
const P = await import("../app/src/print.ts");
const { startEngine, stopEngine, request, invoke } = await import("./shim.mjs");

const near = (a, b, what, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not ${b}`);
const A4 = P.PDF_PAPERS.find((p) => p.label === "A4");

test("print layout: orientation, margins, size, place and borderless", () => {
  const s = { ...P.defaultPrintSettings(), margins: { top: 10, bottom: 10, left: 10, right: 10 }, size: null, alignment: 4 };
  // a 3:2 photo turns an auto page landscape and fills the width inside the margins
  let l = P.layout(A4, { ...s, orientation: "auto" }, 1.5);
  assert.ok(l.landscape && l.page.width === 297 && l.page.height === 210);
  near(l.image.width, Math.min(277, 190 * 1.5), "landscape width");
  near(l.image.height, l.image.width / 1.5, "height follows the aspect");
  near(l.image.y, 10 + (190 - l.image.height) / 2, "centered vertically");
  // portrait forced: the width binds
  l = P.layout(A4, { ...s, orientation: "portrait" }, 1.5);
  assert.ok(!l.landscape);
  near(l.image.width, 190, "portrait width"); near(l.image.x, 10, "fills to the left margin");
  // a long edge of its own, placed bottom right
  l = P.layout(A4, { ...s, orientation: "portrait", size: 150, alignment: 8 }, 1.5);
  near(l.image.width, 150, "long edge"); near(l.image.x + l.image.width, 200, "at the right margin");
  near(l.image.y + l.image.height, 287, "at the bottom margin");
  // a portrait photo's long edge is its height
  l = P.layout(A4, { ...s, orientation: "portrait", size: 150 }, 2 / 3);
  near(l.image.height, 150, "portrait long edge");
  // margins wider than the page leave no room
  assert.ok(!P.layout(A4, { ...s, margins: { top: 10, bottom: 10, left: 150, right: 150 } }, 1.5).fits);
  // hardware margins turn with a landscape page: a 3 mm left one is the top
  const hw = { top: 0, bottom: 0, left: 3, right: 0 };
  assert.ok(!P.layout(A4, { ...s, orientation: "portrait", margins: { top: 0, bottom: 0, left: 5, right: 0 } }, 1.5, hw).borderless);
  assert.ok(P.layout(A4, { ...s, orientation: "landscape", margins: { top: 2, bottom: 0, left: 5, right: 0 } }, 1.5, hw).borderless);
  // units
  near(P.fromUnit(P.toUnit(25.4, "in"), "in"), 25.4, "inches round trip");
  assert.equal(P.shown(25.4, "in"), "1 in");
  // settings come back as stored, with defaults for what is missing
  P.storePrintSettings({ ...s, dpi: 360 });
  assert.equal(P.loadPrintSettings().dpi, 360);
  assert.ok(P.hasPrintSettings());
});

test("soft proof through the Session, and a PDF through print_photo", { timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-print-"));
  startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"));
  try {
    const icc = join(dir, "narrow.icc");
    writeFileSync(icc, narrowPrinterProfile());
    const added = await invoke("print_profile_add", { path: icc });
    assert.equal(added.name, "Immage test narrow printer");
    assert.ok((await invoke("print_profiles")).some((p) => p.file === added.file), "listed");

    const path = join(dir, "photo.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
    const { imgid } = await request({ cmd: "open", path });
    let last = null;
    const s = await Session.open(path, imgid, () => ({ width: 160, height: 160 }), (f) => { last = f; }, () => {});
    await s.settled();
    s.endBaseline();
    await s.settled();
    const chroma = (f) => {
      let c = 0;
      for (let i = 0; i < f.pixels.length; i += 4)
        c += Math.max(f.pixels[i], f.pixels[i + 1], f.pixels[i + 2]) - Math.min(f.pixels[i], f.pixels[i + 1], f.pixels[i + 2]);
      return c / (f.pixels.length / 4);
    };
    const shot = async () => { await s.settled(); assert.ok(last, "a frame"); return { ...last, pixels: Uint8ClampedArray.from(last.pixels) }; };
    const plain = await shot();

    assert.equal(await P.applyProof({ mode: "proof", profile: added.file, intent: 1 }), true);
    s.redraw();
    const proofed = await shot();
    assert.notEqual(proofed.hash, plain.hash, "a new frame, not the one held");
    // the photo's colors are mostly inside even this gamut: those outside come in
    assert.ok(chroma(proofed) < chroma(plain), `the proof pulls the colors in: ${chroma(plain)} -> ${chroma(proofed)}`);
    assert.equal(await P.applyProof({ mode: "gamut", profile: added.file, intent: 1 }), true);
    s.redraw();
    const gamut = await shot();
    let cyan = 0;
    for (let i = 0; i < gamut.pixels.length; i += 4)
      if (gamut.pixels[i] < 40 && gamut.pixels[i + 1] > 200 && gamut.pixels[i + 2] > 200) cyan++;
    assert.ok(cyan > 0, "the gamut warning marks the colors outside cyan");

    assert.equal(await P.applyProof(P.NO_PROOF), true);
    s.redraw();
    const back = await shot();
    assert.equal(back.hash, plain.hash, "off again: the frame from before");

    // the panel's request, as a PDF
    const settings = { ...P.defaultPrintSettings(), printer: P.PDF, paper: A4.name, profile: added.file, dpi: 150,
                       margins: { top: 10, bottom: 10, left: 10, right: 10 } };
    const l = P.layout(A4, settings, plain.fullWidth / plain.fullHeight);
    const pdf = join(dir, "photo.pdf");
    const r = await invoke("print_photo", { imgid, request: P.printRequest(settings, A4, l, "photo.jpg", "", pdf) });
    near(r.width, Math.round(l.image.width / 25.4 * 150), "rendered at the area's size", 2);
    const data = readFileSync(pdf);
    assert.ok(data.subarray(0, 4).toString() === "%PDF", "a PDF");
    const page = l.landscape ? "/MediaBox [0 0 842 595]" : "/MediaBox [0 0 595 842]";
    assert.ok(data.includes(page), `the page ${page}`);
    assert.ok(data.includes("/ICCBased"), "tagged with the printer profile");
    await s.close();
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
