// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
    const imgids = images.map(i => i.imgid);
    const previews = new Map();
    for (const projection of ["auto", "perspective", "cylindrical", "spherical"]) {
      const preview = await requestTagged({ cmd: "pano_preview", imgids, projection });
      assert.equal(preview.used, 2);
      if (projection === "auto") assert.ok(["perspective", "cylindrical", "spherical"].includes(preview.projection));
      else assert.equal(preview.projection, projection);
      assert.ok(preview.width > 0 && preview.height > 0);
      assert.ok(Math.max(preview.width, preview.height) <= 1602, "bounded preview canvas");
      const rgba = Buffer.from(preview.rgba, "base64");
      assert.equal(rgba.length, preview.width * preview.height * 4);
      const [x, y, w, h] = preview.crop;
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0);
      assert.ok(x + w <= preview.width && y + h <= preview.height);
      for (let cy = y; cy < y + h; cy++)
        for (let cx = x; cx < x + w; cx++)
          assert.equal(rgba[(cy * preview.width + cx) * 4 + 3], 255, "Auto Crop must contain no empty pixels");
      previews.set(projection, preview);
    }
    const spherical = Buffer.from(previews.get("spherical").rgba, "base64");
    assert.ok(spherical.some((value, i) => i % 4 === 3 && value === 0), "empty edges need transparent coverage");
    assert.notDeepEqual(previews.get("spherical").crop, previews.get("perspective").crop,
      "projection must change the stitched geometry");
    assert.ok(!readdirSync(dir).some(name => name.includes("-pano")), "preview must not write a DNG");
    await assert.rejects(requestTagged({ cmd: "pano_preview", imgids: [imgids[0], imgids[0]] }),
      /two photos or more/, "duplicate inputs cannot make a panorama");
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
