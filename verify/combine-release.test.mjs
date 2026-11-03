// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Regression: replacing a group's members (a combined mask's, or a mask's
// ranges group) chose the new marker's id while the group still held its
// freed members, which darktable walks (masks.c, _id_taken). releasing a
// shared instance, `combine` with no members, crashed the engine
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, stopEngine, request as send, enginePid } from "./shim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

// an object outline as darktable path points, [x, y, ctrl1, ctrl2]
const blob = (cx, cy, r, n) => ({ points: Array.from({ length: n }, (_, i) => {
  const a = (i / n) * 2 * Math.PI, x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
  return [x, y, x, y, x, y];
}) });
// a walk over freed members can spin rather than crash: a request that
// takes this long has hung the engine, which is killed so the check fails
const DEADLINE = 30000;
let hung = false;
const request = (req) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => {
      hung = true;
      process.kill(enginePid(), "SIGKILL");
      reject(new Error(`the engine hung on ${req.cmd}`));
    }, DEADLINE);
  });
  return Promise.race([send(req), late]).finally(() => clearTimeout(timer));
};
const LUMA = { type: "luminance", lo: -6, hi: null, feather: 1 };

test("a combined mask's members and a mask's ranges can be replaced and released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-combine-"));
  const path = join(dir, "photo.jpg");
  copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
  // glibc fills freed memory, so a walk over freed members fails every time
  // rather than when the allocator happens to have reused them
  startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"), null,
              { env: { MALLOC_PERTURB_: "165" } });
  try {
    await request({ cmd: "open", path });
    // an object less a radial gradient, with a range: drawn twice, so its
    // ranges group is rebuilt over members it already has
    const shapes = [{ type: "object", paths: [blob(0.5, 0.5, 0.25, 80)], mode: "add" },
                    { type: "ellipse", x: 0.55, y: 0.45, rx: 0.12, ry: 0.12, angle: 0, feather: 0.3, mode: "subtract" },
                    LUMA];
    await request({ cmd: "mask", name: "Object", shapes });
    await request({ cmd: "mask", name: "Object", shapes });
    await request({ cmd: "set", op: "exposure", instance: "Object", mask: "Object", invert: false, opacity: 100,
                    enabled: true, params: { black: 0.0002, exposure: 1.49 } });
    const group = "colorbalancergb 1", instance = `immage local: ${group}`;
    for (let i = 0; i < 3; i++) {
      // as Session sends a shared instance: its members, the instance, and
      // with no mask sharing it any more, no members (session.ts)
      await request({ cmd: "combine", name: group, members: [{ mask: "Object", opacity: 1, invert: false }],
                      ranges: [LUMA] });
      await request({ cmd: "set", op: "colorbalancergb", instance, mask: group, invert: false, opacity: 100,
                      enabled: true, params: { brilliance_highlights: -0.02 } });
      await request({ cmd: "combine", name: group, members: [], ranges: null });
    }
    const masks = (await request({ cmd: "masks", fields: {} })).masks;
    assert.deepEqual(masks.map((m) => m.name), ["Object"]);
  } finally {
    // a killed engine takes no quit, which would wait behind its last request
    if (!hung) await stopEngine();
    rmSync(dir, { recursive: true, force: true });
  }
});
