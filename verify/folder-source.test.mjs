import test from "node:test";
import assert from "node:assert/strict";
import { isOffline, mirrorChangeTouches, within } from "../app/src/folderSource.ts";

test("within compares whole path parts", () => {
  assert.ok(within("/mnt/nas", "/mnt/nas"));
  assert.ok(within("/mnt/nas", "/mnt/nas/2024/a.arw"));
  assert.ok(within("/mnt/nas/", "/mnt/nas/2024"));
  assert.ok(within("C:\\nas", "C:\\nas\\2024\\a.arw"));
  assert.ok(!within("/mnt/nas", "/mnt/nas2/a.arw"));
  assert.ok(!within("/mnt/nas/2024", "/mnt/nas/2024b"));
  assert.ok(within("/", "/anything"));
});

test("only photos under an offline mapped root show the offline dot", () => {
  const source = { root: "/mnt/nas", offline: true };
  assert.ok(isOffline("/mnt/nas/2024/a.arw", source));
  assert.ok(!isOffline("/Users/me/local.arw", source));
  assert.ok(!isOffline("/mnt/nas/2024/a.arw", { root: "/mnt/nas", offline: false }));
  assert.ok(!isOffline("/mnt/nas/2024/a.arw", null));
});

test("a change of the local copy re-reads only a folder it touches", () => {
  const root = "/mnt/nas";
  const change = { dirs: ["/mnt/nas/2024", "/mnt/nas/2024/june"] };
  assert.ok(mirrorChangeTouches("/mnt/nas/2024", false, root, change));
  assert.ok(!mirrorChangeTouches("/mnt/nas/2024/may", false, root, change));
  // a subfolder's change counts only with subfolders included
  assert.ok(!mirrorChangeTouches("/mnt/nas", false, root, change));
  assert.ok(mirrorChangeTouches("/mnt/nas", true, root, change));
  // a sibling with the same prefix is not a descendant
  assert.ok(!mirrorChangeTouches("/mnt/nas/202", true, root, change));
  assert.ok(!mirrorChangeTouches("/Users/me", true, root, change));
  assert.ok(!mirrorChangeTouches(null, true, root, change));
  assert.ok(!mirrorChangeTouches("/mnt/nas/2024", false, null, change));
});

test("too many changes to name touch every folder shown from the mapped root", () => {
  const all = { dirs: [], all: true };
  assert.ok(mirrorChangeTouches("/mnt/nas/2024", false, "/mnt/nas", all));
  assert.ok(mirrorChangeTouches("/mnt", true, "/mnt/nas", all));
  assert.ok(!mirrorChangeTouches("/mnt", false, "/mnt/nas", all));
  assert.ok(!mirrorChangeTouches("/Users/me", true, "/mnt/nas", all));
});
