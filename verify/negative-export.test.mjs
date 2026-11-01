// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Run after building the engine: node --test verify/negative-export.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, stopEngine, request, requestTagged } from "./shim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
function meanDifference(a, b) {
  assert.equal(a.length, b.length, "pixel dimensions survive the round-trip");
  let sum = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 3 / 4);
}
function tiffTags(path) {
  const bytes = readFileSync(path);
  const le = bytes.toString("ascii", 0, 2) === "II";
  const u16 = (at) => le ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
  const u32 = (at) => le ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
  const ifd = u32(4), tags = new Map();
  for (let i = 0; i < u16(ifd); i++) {
    const at = ifd + 2 + i * 12, count = u32(at + 4);
    const size = ({ 1: 1, 3: 2, 4: 4 })[u16(at + 2)] ?? 8;
    const value = count * size <= 4 ? at + 8 : u32(at + 8);
    tags.set(u16(at), { first: u16(value), count });
  }
  return tags;
}

test("converted negatives export as editable DNG and TIFF positives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-negative-export-"));
  const binary = join(root, "build/bin/darktable-engine");
  const start = () => startEngine(binary, join(dir, "runtime"));
  const render = async (name) => {
    const rgba = join(dir, `${name}.rgba`);
    await request({ cmd: "render", width: 256, height: 256, rgba });
    return readFileSync(rgba);
  };
  start();
  try {
    // Produce a small fixture using the same engine, keeping the test fast
    // and the input independent of external image-conversion libraries.
    const source = join(dir, "source.jpg"), negative = join(dir, "negative.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), source);
    const first = await request({ cmd: "open", path: source });
    await request({ cmd: "export", imgid: first.imgid, out: negative,
                    format: "jpeg", long_edge: 256, quality: 100 });
    const opened = await request({ cmd: "open", path: negative });
    for (const op of ["channelmixerrgb", "exposure", "toneequal", "hazeremoval", "agx", "sigmoid", "filmicrgb", "basecurve"])
      await request({ cmd: "set", op, enabled: false, params: {} });
    await request({ cmd: "set", op: "negadoctor", enabled: true, params: {} });
    await request({ cmd: "set", op: "crop", enabled: true,
                    params: { cx: 0.125, cy: 0.125, cw: 0.875, ch: 0.875, ratio_d: 0, ratio_n: 0 } });
    const expected = await render("converted");
    for (const job of [101, 102])
      await request({ cmd: "export_hold", job, imgids: [opened.imgid] });
    // Exports must use the edit captured at the click, leaving subsequent
    // work on the original intact while the background job runs.
    await request({ cmd: "set", op: "exposure", enabled: true, params: { exposure: 0.5 } });
    const copies = [];
    for (const [format, job, ext, bits] of [["dng", 101, "dng", 16], ["tiff", 102, "tif", 32]]) {
      const path = join(dir, `positive.${ext}`);
      const result = await requestTagged({ cmd: "export", job, imgid: opened.imgid,
        out: path, format, bpp: 32, negative_copy: true, history: false });
      await requestTagged({ cmd: "export_release", job });
      assert.equal(result.path, path);
      assert.ok(result.image.imgid > 0);
      assert.ok(readFileSync(path + ".xmp").length > 0, "neutral history is saved in a sidecar");
      const tags = tiffTags(path);
      assert.equal(tags.get(258).first, bits);
      assert.equal(tags.get(259).first, 8, "lossless Deflate compression");
      assert.equal(tags.get(339).first, 3, "floating point samples");
      assert.ok(tags.has(format === "dng" ? 50706 : 34675), "color metadata is retained");
      copies.push({ path, format });
    }
    const original = await request({ cmd: "get", modules: { negadoctor: [], exposure: ["exposure"] } });
    assert.equal(original.modules.negadoctor.enabled, true);
    assert.equal(original.modules.exposure.params.exposure, 0.5);
    for (const copy of copies) {
      const opened = await request({ cmd: "open", path: copy.path });
      assert.equal(opened.fresh, false, "import defaults must not be reapplied");
      const state = await request({ cmd: "get", modules: { negadoctor: [], exposure: [], agx: [], sigmoid: [] } });
      for (const info of Object.values(state.modules)) assert.equal(info.enabled, false);
      assert.ok(meanDifference(expected, await render(copy.format)) < 0.1,
        `${copy.format}: positive retains the converted appearance and crop`);
      await request({ cmd: "set", op: "exposure", enabled: true, params: { exposure: 0.5 } });
      copy.edited = await render(copy.format + "-edited");
      assert.ok(meanDifference(expected, copy.edited) > 1, "normal exposure edits work on the copy");
      await request({ cmd: "save" });
    }
    await stopEngine();
    start();
    for (const copy of copies) {
      const opened = await request({ cmd: "open", path: copy.path });
      assert.equal(opened.fresh, false);
      const state = await request({ cmd: "get", modules: { negadoctor: [], exposure: [] } });
      assert.equal(state.modules.negadoctor.enabled, false);
      assert.equal(state.modules.exposure.enabled, true);
      assert.ok(meanDifference(copy.edited, await render(copy.format + "-reopened")) < 0.1,
        "further edits survive an engine restart");
    }
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
