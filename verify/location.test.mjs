// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, stopEngine, request } from "./shim.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
test("GPS edits survive XMP round trips and removal preserves other metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-location-"));
  const path = join(dir, "photo.jpg");
  // Minimal EXIF GPS IFD gives the source camera coordinates without an external tool.
  const tiff = Buffer.alloc(160);
  tiff.write("II"); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10); tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14); tiff.writeUInt32LE(26, 18);
  tiff.writeUInt16LE(6, 26);
  for (let i = 0; i < 6; i++) {
    const at = 28 + i * 12, rational = i % 2 === 1;
    tiff.writeUInt16LE(i + 1, at); tiff.writeUInt16LE(rational ? 5 : i === 4 ? 1 : 2, at + 2);
    tiff.writeUInt32LE(i === 5 || i === 4 ? 1 : rational ? 3 : 2, at + 4);
    if (rational) tiff.writeUInt32LE(i === 1 ? 104 : i === 3 ? 128 : 152, at + 8);
    else if (i !== 4) tiff.write(i === 0 ? "N" : "W", at + 8);
  }
  for (let i = 0; i < 7; i++) {
    tiff.writeUInt32LE(i === 0 ? 40 : i === 3 ? 70 : i === 6 ? 50 : 0, 104 + i * 8);
    tiff.writeUInt32LE(1, 108 + i * 8);
  }
  const segment = Buffer.alloc(10);
  segment[0] = 0xff; segment[1] = 0xe1; segment.writeUInt16BE(168, 2);
  segment.write("Exif", 4);
  const jpeg = readFileSync(join(root, "app/sample/stairs-to-mountain.jpg"));
  writeFileSync(path, Buffer.concat([jpeg.subarray(0, 2), segment, tiff, jpeg.subarray(2)]));
  const start = () => startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"));
  const meta = async (imgid) => (await request({ cmd: "meta", imgid })).image;
  const edit = (imgid, fields) => request({ cmd: "meta_set", imgid, ...fields });
  start();
  try {
    let { imgid } = await request({ cmd: "open", path });
    assert.deepEqual((await meta(imgid)).location, { latitude: 40, longitude: -70 });
    await edit(imgid, { title: "GPS regression", rating: 3 });
    await edit(imgid, { location: { latitude: 40, longitude: -70 } });
    assert.match(readFileSync(path + ".xmp", "utf8"), /exif:GPSAltitude/);
    for (const location of [{ latitude: 37.7749, longitude: -122.4194 },
                            { latitude: -33.8688, longitude: 151.2093 },
                            { latitude: 0, longitude: 0 },
                            { latitude: 90, longitude: -180 }]) {
      await edit(imgid, { location });
      assert.deepEqual((await meta(imgid)).location, location);
      assert.match(readFileSync(path + ".xmp", "utf8"), /exif:GPSLatitude/);
      await stopEngine(); start();
      ({ imgid } = await request({ cmd: "open", path }));
      const roundtrip = (await meta(imgid)).location;
      assert.ok(Math.abs(roundtrip.latitude - location.latitude) < 1e-6);
      assert.ok(Math.abs(roundtrip.longitude - location.longitude) < 1e-6);
      await edit(imgid, { title: "GPS regression" });
      assert.doesNotMatch(readFileSync(path + ".xmp", "utf8"), /exif:GPSAltitude/);
    }
    for (const location of [{ latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 },
                            { latitude: "3", longitude: 0 }, { latitude: 2 }, "invalid"]) {
      await assert.rejects(edit(imgid, { location }));
      assert.deepEqual((await meta(imgid)).location, { latitude: 90, longitude: -180 });
    }
    await edit(imgid, { location: null });
    await stopEngine(); start();
    ({ imgid } = await request({ cmd: "open", path }));
    await edit(imgid, { description: "Location removed" });
    await stopEngine(); start();
    ({ imgid } = await request({ cmd: "open", path }));
    const cleared = await meta(imgid);
    assert.equal(cleared.location, null);
    assert.equal(cleared.metadata.title, "GPS regression");
    assert.equal(cleared.rating, 3);
    assert.doesNotMatch(readFileSync(path + ".xmp", "utf8"), /exif:GPS(?:Latitude|Longitude|Altitude)/);
  } finally { await stopEngine(); rmSync(dir, { recursive: true, force: true }); }
});
