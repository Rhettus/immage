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
import { basename, join } from "node:path";
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
const { startEngine, stopEngine, request, requestTagged, invoke, progressLog } = await import("./shim.mjs");

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

test("print cells layout: 38 on a Letter page, spacing, counts, custom size, pages", () => {
  const letter = P.PDF_PAPERS.find((p) => p.label === "Letter");
  const s = { ...P.defaultPrintSettings(), layout: "cells", orientation: "portrait",
              margins: { top: 12.7, bottom: 12.7, left: 12.7, right: 12.7 } };
  const inside = (l, what) => {
    for (const { box, label } of l.slots) {
      for (const r of [box, ...(label ? [label] : [])]) {
        assert.ok(r.x >= l.area.x - 1e-6 && r.y >= l.area.y - 1e-6 && r.x + r.width <= l.area.x + l.area.width + 1e-6
                  && r.y + r.height <= l.area.y + l.area.height + 1e-6, `${what}: inside the margins`);
      }
    }
    for (let i = 0; i < l.slots.length; i++) for (let j = i + 1; j < l.slots.length; j++) {
      const a = l.slots[i].box, b = l.slots[j].box;
      assert.ok(a.x + a.width <= b.x + 1e-6 || b.x + b.width <= a.x + 1e-6 || a.y + a.height <= b.y + 1e-6
                || b.y + b.height <= a.y + 1e-6, `${what}: cells ${i} and ${j} do not touch`);
    }
  };
  // 38 photos, names on: one Letter page, a grid that holds them all
  let l = P.cellsLayout(letter, s, 38);
  assert.equal(l.pages, 1); assert.ok(l.perPage >= 38, `holds 38: ${l.perPage}`);
  assert.equal(`${l.columns}x${l.rows}`, "6x7");
  inside(l, "38 up");
  // equal gaps both ways, 3 mm by default
  const [a, b] = [l.slots[0].box, l.slots[1].box];
  near(b.x - (a.x + a.width), 3, "horizontal gap");
  const below = l.slots[l.columns].box;
  near(below.y - (a.y + a.height + P.LABEL_HEIGHT), 3, "vertical gap, past the filename strip");
  // the names add a strip, off they do not
  assert.ok(l.slots[0].label);
  assert.equal(P.cellsLayout(letter, { ...s, names: false }, 38).slots[0].label, null);
  // more than a page goes on to the next, a page per grid
  l = P.cellsLayout(letter, s, 80);
  assert.equal(l.perPage, 42); assert.equal(l.pages, 2);
  const pages = P.sheetPages(l, Array.from({ length: 80 }, (_, i) => ({ imgid: i, name: `p${i}` })));
  assert.deepEqual(pages.map((p) => p.length), [42, 38]);
  assert.equal(pages[1][0].photo.imgid, 42);
  // a few photos get big cells; every one fits its photo box
  l = P.cellsLayout(letter, s, 4);
  assert.equal(l.pages, 1); assert.ok(l.cell.width > 60, `bigger cells: ${l.cell.width}`);
  inside(l, "4 up");
  // a count of cells asked for, and a column count
  l = P.cellsLayout(letter, { ...s, cellCount: 6, columns: 2 }, 20);
  assert.equal(l.slots.length, 6); assert.equal(l.columns, 2); assert.equal(l.pages, 4);
  inside(l, "6 in 2 columns");
  // the user's case: 2 cells in a 50 mm border, sized by hand, shared out evenly
  const border = { top: 50, bottom: 50, left: 50, right: 50 };
  l = P.cellsLayout(letter, { ...s, margins: border, cellCount: 2, cellSize: { width: 80, height: 60 }, names: false }, 2);
  assert.equal(l.slots.length, 2); assert.equal(l.columns, 1);
  inside(l, "2 cells");
  const [c0, c1] = l.slots.map((x) => x.box);
  near(c0.width, 80, "the width asked for"); near(c0.height, 60, "the height asked for");
  const top = c0.y - l.area.y, mid = c1.y - (c0.y + c0.height), bottom = l.area.y + l.area.height - (c1.y + c1.height);
  near(top, mid, "even: top edge and between"); near(mid, bottom, "even: between and bottom edge");
  near(c0.x - l.area.x, l.area.x + l.area.width - (c0.x + c0.width), "centered across");
  // a size too big for the border is held inside it
  l = P.cellsLayout(letter, { ...s, margins: border, cellCount: 2, cellSize: { width: 300, height: 300 } }, 2);
  inside(l, "oversized");
  // margins that leave no room
  assert.ok(!P.cellsLayout(letter, { ...s, margins: { top: 10, bottom: 10, left: 150, right: 150 } }, 5).fits);
  // the request: boxes and labels per page, in millimeters
  const req = P.sheetRequest({ ...s, printer: P.PDF }, letter, P.cellsLayout(letter, s, 3),
                             [{ imgid: 1, name: "a.CR3" }, { imgid: 2, name: "b.CR3" }, { imgid: 3, name: "c.CR3" }],
                             "Contact sheet", "", true);
  assert.equal(req.pages.length, 1); assert.equal(req.pages[0].length, 3);
  assert.equal(req.pages[0][2].label.text, "c.CR3");
  assert.equal(req.pdf, undefined, "the path is asked for by Rust, not sent by the page");
  assert.equal(req.dpi, s.dpi);
  // settings saved by an earlier version load with the new fields' defaults
  store.set("immage.print", JSON.stringify({ dpi: 240 }));
  const old = P.loadPrintSettings();
  assert.equal(old.layout, "single"); assert.equal(old.names, true); assert.equal(old.cellSize, null);
  store.delete("immage.print");
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
    const r = await invoke("print_photo", { imgid, request: P.printRequest(settings, A4, l, "photo.jpg", "", true),
                                            pdf_name: "photo.pdf" });
    const pdf = r.pdf;
    assert.equal(basename(pdf), "photo.pdf", "written where the save dialog's answer says");
    near(r.width, Math.round(l.image.width / 25.4 * 150), "rendered at the area's size", 2);
    const data = readFileSync(pdf);
    assert.ok(data.subarray(0, 4).toString() === "%PDF", "a PDF");
    const page = l.landscape ? "/MediaBox [0 0 842 595]" : "/MediaBox [0 0 595 842]";
    assert.ok(data.includes(page), `the page ${page}`);
    assert.ok(data.includes("/ICCBased"), "tagged with the printer profile");

    await s.close();

    // the Cells layout through print_sheet, as the panel asks: a dozen distinct photos on a Letter page,
    // each held like an export's (a photo is taken once per job)
    const letter = P.PDF_PAPERS.find((p) => p.label === "Letter");
    const cellSettings = { ...P.defaultPrintSettings(), layout: "cells", printer: P.PDF, paper: letter.name, dpi: 100,
                           orientation: "portrait", margins: { top: 12.7, bottom: 12.7, left: 12.7, right: 12.7 } };
    const photos = [];
    for (let i = 0; i < 12; i++) {
      const copy = join(dir, `sheet-${i}.jpg`);
      copyFileSync(path, copy);
      photos.push({ imgid: (await request({ cmd: "open", path: copy })).imgid, name: `IMG_${String(i + 1).padStart(4, "0")}.CR3` });
    }
    const cl = P.cellsLayout(letter, cellSettings, photos.length);
    assert.equal(cl.pages, 1);
    const sheetRun = invoke("print_sheet", { imgids: photos.map((p) => p.imgid),
                                             request: P.sheetRequest(cellSettings, letter, cl, photos, "Contact sheet", "", true),
                                             pdf_name: "sheet.pdf" });
    // thumbnails asked for meanwhile, as the preview does: each whole, the size its reply says
    const thumbs = [];
    for (const [n, p] of photos.entries()) {
      const out = join(dir, `thumb-${n}.rgba`);
      const t = await requestTagged({ cmd: "thumb", imgid: p.imgid, size: 240, out });
      thumbs.push({ t, bytes: readFileSync(out).length });
    }
    for (const { t, bytes } of thumbs) assert.equal(bytes, t.width * t.height * 4, `a whole thumbnail: ${JSON.stringify(t)} ${bytes}`);
    const sr = await sheetRun;
    assert.equal(sr.pages, 1); assert.equal(sr.photos, 12);
    // one progress line before the first photo and one as each is placed, for the activity line
    const steps = progressLog.filter((p) => p.stage === "photos").map((p) => p.done);
    assert.deepEqual(steps, Array.from({ length: 13 }, (_, i) => i), `progress per photo: ${steps}`);
    assert.ok(progressLog.every((p) => p.total === 12));
    const sdata = readFileSync(sr.pdf);
    assert.ok(sdata.subarray(0, 4).toString() === "%PDF", "a sheet PDF");
    assert.ok(sdata.includes("/MediaBox [0 0 612 792]"), "a Letter page");

  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
