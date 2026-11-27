// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import test from "node:test";
import assert from "node:assert/strict";
import { followSelection, followRename, NO_FOLLOW } from '../app/src/selectionIdentity.ts';

const p = (imgid, path, version = 0) => ({ imgid, path, version });

test("a photo whose id changes keeps its selection and anchor", () => {
  const a = followSelection([p(1, "/a"), p(2, "/b")], new Set([2]), 2, NO_FOLLOW, 0);
  const r = followSelection([p(1, "/a"), p(9, "/b")], new Set([2]), 2, a.followed, 0);
  assert.deepEqual([...r.selection], [9]);
  assert.equal(r.anchor, 9);
});

test("a photo that is gone leaves the selection", () => {
  const a = followSelection([p(1, "/a"), p(2, "/b")], new Set([2]), 2, NO_FOLLOW, 0);
  const r = followSelection([p(1, "/a")], new Set([2]), 2, a.followed, 0);
  assert.equal(r.selection.size, 0);
  assert.equal(r.anchor, null);
});

test("a rename's selection waits for the new name and then follows its id", () => {
  const a = followSelection([p(1, "/a"), p(2, "/b")], new Set([2]), 2, NO_FOLLOW, 0);
  const f = followRename(a.followed, [p(2, "/b")], p(2, "/b"), new Map([["/b", "/c"]]), 100);
  const gap = followSelection([p(1, "/a")], new Set(), 2, f, 10);
  assert.equal(gap.selection.size, 0);
  const done = followSelection([p(1, "/a"), p(5, "/c")], gap.selection, gap.anchor, gap.followed, 20);
  assert.deepEqual([...done.selection], [5]);
  assert.equal(done.anchor, 5);
  const late = followSelection([p(1, "/a"), p(7, "/c")], done.selection, done.anchor, done.followed, 30);
  assert.deepEqual([...late.selection], [7]);
  assert.equal(late.anchor, 7);
});

test("a wait ends after its time", () => {
  const f = followRename(NO_FOLLOW, [p(2, "/b")], undefined, new Map([["/b", "/c"]]), 5);
  const r = followSelection([p(1, "/a")], new Set(), null, f, 10);
  const later = followSelection([p(1, "/a"), p(3, "/c")], r.selection, r.anchor, r.followed, 11);
  assert.equal(later.selection.size, 0);
});
