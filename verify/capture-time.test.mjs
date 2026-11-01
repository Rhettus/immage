// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startEngine, stopEngine, request } from "./shim.mjs";
import { captureMillis, captureStamp, captureShift } from "../app/src/captureTime.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
test("camera clock shifts preserve milliseconds across DST, midnight and leap days", () => {
  for (const [before, delta, after] of [
    ["2026:03:08 01:59:59.125", 2000, "2026:03:08 02:00:01.125"],
    ["2026:12:31 23:59:59.999", 1, "2027:01:01 00:00:00.000"],
    ["2024:03:01 00:00:00.500", -1000, "2024:02:29 23:59:59.500"],
  ]) assert.equal(captureStamp(captureMillis(before) + delta), after);
  assert.ok(Number.isNaN(captureMillis("2025:02:29 10:00:00")));
  assert.ok(Number.isNaN(captureMillis("2026:04:31 10:00:00")));
  assert.ok(Number.isNaN(captureMillis("2026:10:31 24:00:00")));
  assert.ok(Number.isNaN(captureMillis("")));
  assert.throws(() => captureStamp(captureMillis("9999:12:31 23:59:59.999") + 1));
  assert.equal(captureShift(-193125), "backward by 3 minutes, 13.125 seconds");
});

test("batch capture times persist, reject stale batches, undo, and report sidecar failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "immage-capture-time-"));
  const original = ["2026:10:31 23:59:58.125", "2026:10:31 23:59:59.625"];
  const paths = original.map((stamp, n) => {
    const path = join(dir, `photo-${n}.jpg`);
    copyFileSync(join(root, "app/sample/stairs-to-mountain.jpg"), path);
    writeFileSync(path + ".xmp", `<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:DateTimeOriginal="${stamp}"/></rdf:RDF></x:xmpmeta>`);
    return path;
  });
  const start = () => startEngine(join(root, "build/bin/darktable-engine"), join(dir, "runtime"));
  const meta = async (imgid) => (await request({ cmd: "meta", imgid })).image;
  const edit = (entries) => request({ cmd: "capture_times", entries });
  const open = async () => Promise.all(paths.map(async (path) => (await request({ cmd: "open", path })).imgid));
  start();
  try {
    let ids = await open();
    const entries = [];
    for (let n = 0; n < ids.length; n++) {
      const before = (await meta(ids[n])).exif.datetime;
      assert.equal(before, original[n]);
      entries.push({ imgid: ids[n], before, after: captureStamp(captureMillis(before) + 193125) });
    }
    await request({ cmd: "meta_set", imgid: ids[0], title: "Clock sync", rating: 3 });
    assert.equal((await edit(entries)).updates.length, 2);
    for (const e of entries) assert.equal((await meta(e.imgid)).exif.datetime, e.after);
    assert.equal(captureMillis(entries[1].after) - captureMillis(entries[0].after), 1500);
    const exported = join(dir, "corrected.jpg");
    await request({ cmd: "export", imgid: ids[1], out: exported, format: "jpeg", long_edge: 100, quality: 90 });
    const output = await request({ cmd: "open", path: exported });
    assert.equal((await meta(output.imgid)).exif.datetime, entries[1].after);
    await assert.rejects(edit(entries), /changed capture time/);
    const undo = entries.map((e) => ({ imgid: e.imgid, before: e.after, after: e.before }));
    await assert.rejects(edit([{ ...undo[0] }, { ...undo[1], after: "2026:02:30 10:00:00.000" }]), /invalid or changed/);
    assert.equal((await meta(ids[0])).exif.datetime, entries[0].after);
    await stopEngine(); start(); ids = await open();
    for (let n = 0; n < ids.length; n++) assert.equal((await meta(ids[n])).exif.datetime, entries[n].after);
    assert.equal((await meta(ids[0])).metadata.title, "Clock sync");
    assert.equal((await meta(ids[0])).rating, 3);
    await edit(undo.map((e, n) => ({ ...e, imgid: ids[n] })));
    await stopEngine(); start(); ids = await open();
    for (let n = 0; n < ids.length; n++) assert.equal((await meta(ids[n])).exif.datetime, original[n]);
    rmSync(paths[1] + ".xmp"); mkdirSync(paths[1] + ".xmp");
    const reply = await edit(entries.map((e, n) => ({ ...e, imgid: ids[n] })));
    assert.equal(reply.updates[0].after, entries[0].after);
    assert.match(reply.updates[1].error, /sidecar/);
    assert.equal((await meta(ids[1])).exif.datetime, original[1]);
    assert.match(readFileSync(paths[0] + ".xmp", "utf8"), /DateTimeOriginal/);
    const source = readFileSync(join(root, "app/sample/stairs-to-mountain.jpg"));
    for (const path of paths) assert.deepEqual(readFileSync(path), source);
  } finally { await stopEngine(); rmSync(dir, { recursive: true, force: true }); }
});
