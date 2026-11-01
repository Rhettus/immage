// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, stopEngine, request, requestTagged } from "./shim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("JPEG panoramas retain color and reopen with neutral, editable defaults", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "immage-pano-"));
  startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"));
  try {
    if (!(await request({ cmd: "version" })).pano) return t.skip("OpenCV stitching unavailable");
    const source = join(dir, "source.jpg");
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), source);
    const opened = await request({ cmd: "open", path: source });
    const a = join(dir, "a.jpg"), b = join(dir, "b.jpg");
    await request({ cmd: "export", imgid: opened.imgid, out: a, format: "jpeg", long_edge: 1000, quality: 100 });
    copyFileSync(a, b);
    const { images } = await request({ cmd: "import", files: [a, b] });
    const result = await requestTagged({ cmd: "pano_merge", imgids: images.map(i => i.imgid), projection: "perspective", crop: true });
    assert.equal(result.path, join(dir, "a-pano.dng"));
    assert.equal(result.used, 2);
    assert.ok(result.image.imgid > 0);
    const mean = async (path, name) => {
      await request({ cmd: "open", path });
      for (const op of ["agx", "sigmoid", "filmicrgb", "basecurve", "exposure", "channelmixerrgb"])
        await request({ cmd: "set", op, enabled: false, params: {} });
      const rgba = join(dir, name + ".rgba");
      await request({ cmd: "render", width: 256, height: 256, rgba });
      const pixels = readFileSync(rgba), sum = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 4)
        for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
      return sum.map(v => v / (pixels.length / 4));
    };
    const original = await mean(a, "source");
    const imported = await request({ cmd: "open", path: result.path });
    assert.equal(imported.fresh, false, "neutral history prevents RAW defaults being reapplied");
    const state = await request({ cmd: "get", modules: { exposure: [], agx: [], sigmoid: [] } });
    for (const info of Object.values(state.modules)) assert.equal(info.enabled, false);
    const merged = await mean(result.path, "merged");
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(original[c] - merged[c]) < 5,
      `channel ${c}: source ${original[c]}, panorama ${merged[c]}`);
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
