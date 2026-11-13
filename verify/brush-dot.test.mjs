// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Regression: a brush mask of one click is a stroke of one point, which
// darktable's brush renders over the whole image (its own brush tool adds a
// second point to a click, masks/brush.c). an adjustment on such a mask
// changed the whole photo. a new stroke gets the second point, and one saved
// by an older Immage gets it when the photo opens
//   node --test verify/brush-dot.test.mjs   (IMMAGE_ENGINE=path for another engine)
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import { startEngine, stopEngine, request } from "./shim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = process.env.IMMAGE_ENGINE ?? join(root, "build/bin/darktable-engine");
const W = 192, H = 128;

// the share of the frame's pixels `a` and `b` differ in
const changed = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) n++;
  return n / (a.length / 4);
};

// darktable's encoded blobs (exif.cc, dt_exif_xmp_encode): hex, or "gz", a
// two-digit factor, then zlib-compressed bytes in base64
const decode = (v) => v.startsWith("gz") ? inflateSync(Buffer.from(v.slice(4), "base64")) : Buffer.from(v, "hex");
const encode = (bytes, like) => {
  if (!like.startsWith("gz")) return bytes.toString("hex");
  const z = deflateSync(bytes);
  return `gz${String(Math.min(99, Math.ceil(bytes.length / z.length))).padStart(2, "0")}${z.toString("base64")}`;
};

// every brush in the sidecar cut back to its first point, as an older
// Immage saved a click (a dt_masks_point_brush_t is 44 bytes)
const oneClick = (xmp) => xmp.replace(/<rdf:li\b[^>]*?darktable:mask_type="64"[^>]*?\/>/gs, (li) =>
  li.replace(/darktable:mask_nb="\d+"/, 'darktable:mask_nb="1"')
    .replace(/darktable:mask_points="([^"]+)"/, (_, v) => `darktable:mask_points="${encode(decode(v).subarray(0, 44), v)}"`));

test("a brush mask of one click changes only where it was clicked", { timeout: 300000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-brush-dot-"));
  const path = join(dir, "photo.jpg"), rgba = join(dir, "frame.rgba");
  copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
  const render = async () => {
    await request({ cmd: "render", width: W, height: H, rgba });
    return readFileSync(rgba);
  };
  const dot = async () => (await request({ cmd: "masks", fields: {} })).masks.find((m) => m.name === "Dot");
  try {
    startEngine(engine, join(dir, "runtime"));
    await request({ cmd: "open", path });
    const plain = await render();
    await request({ cmd: "mask", name: "Dot",
                    shapes: [{ type: "brush", mode: "add", size: 0.04, hardness: 0.5, density: 1, points: [[0.3, 0.5]] }] });
    await request({ cmd: "set", op: "exposure", instance: "Dot", mask: "Dot", invert: false, opacity: 100,
                    enabled: true, params: { exposure: 2 } });
    const lit = changed(plain, await render());
    assert.ok(lit > 0, "the click brightens where it was made");
    assert.ok(lit < 0.05, `the click brightens ${(lit * 100).toFixed(1)}% of the photo, not just its spot`);
    assert.equal((await dot()).shapes[0].points.length, 2, "the click is stored as two points");
    await request({ cmd: "save" });
    await stopEngine();

    // the sidecar as an older Immage wrote it, read into a new library
    const xmp = `${path}.xmp`, old = oneClick(readFileSync(xmp, "utf8"));
    assert.notEqual(old, readFileSync(xmp, "utf8"), "the sidecar holds the brush");
    writeFileSync(xmp, old);
    startEngine(engine, join(dir, "runtime-old"));
    await request({ cmd: "open", path });
    const reopened = changed(plain, await render());
    assert.ok(reopened > 0 && reopened < 0.05,
              `a saved click brightens ${(reopened * 100).toFixed(1)}% of the photo, not just its spot`);
    assert.equal((await dot()).shapes[0].points.length, 2, "a saved click opens as two points");
  } finally {
    await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
