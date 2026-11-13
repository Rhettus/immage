// SPDX-License-Identifier: GPL-3.0-or-later
import test from "node:test";
import assert from "node:assert/strict";
import { START, step, wait, reopenPlan, reopening, isEngineExit, engineText, REOPEN_GUARD_MS }
  from "../app/src/engineState.ts";

test("a restart restores once, for a new epoch only", () => {
  let r = step(START, { state: "down", epoch: 1 }, 0);
  assert.deepEqual(r.state.notice, { kind: "restarting" });
  assert.equal(r.restore, false);
  r = step(r.state, { state: "ready", epoch: 2 }, 100);
  assert.equal(r.restore, true);
  assert.equal(r.state.epoch, 2);
  assert.equal(r.state.notice, null);
  assert.equal(step(r.state, { state: "ready", epoch: 2 }, 200).restore, false);
});

test("a slow request shows a notice that Wait and ready clear", () => {
  let r = step(START, { state: "slow", op: "render", seconds: 10 }, 0);
  assert.deepEqual(r.state.notice, { kind: "slow", op: "render", seconds: 10 });
  assert.equal(wait(r.state).notice, null);
  r = step(r.state, { state: "ready", epoch: 1 }, 1);
  assert.equal(r.state.notice, null);
  assert.equal(r.restore, false);
});

test("a slow notice does not replace a restart or a failure", () => {
  const down = step(START, { state: "down", epoch: 1 }, 0).state;
  assert.equal(step(down, { state: "slow", op: "open", seconds: 30 }, 1).state.notice?.kind, "restarting");
  const failed = step(down, { state: "failed" }, 2).state;
  assert.equal(failed.notice?.kind, "failed");
  assert.equal(step(failed, { state: "slow", op: "open", seconds: 30 }, 3).state.notice?.kind, "failed");
  assert.equal(wait(failed).notice?.kind, "failed");
});

test("a second death soon after a reopen refuses that photo", () => {
  let s = reopening(START, "/a/p.nef", 1000);
  s = step(s, { state: "down", epoch: 2 }, 1000 + REOPEN_GUARD_MS - 1).state;
  assert.deepEqual(reopenPlan(s, "/a/p.nef"), { reopen: null, refused: "/a/p.nef" });
  assert.deepEqual(reopenPlan(s, "/a/q.nef"), { reopen: "/a/q.nef", refused: null });
  assert.deepEqual(reopenPlan(s, null), { reopen: null, refused: null });
});

test("a death long after a reopen reopens the photo again", () => {
  let s = reopening(START, "/a/p.nef", 1000);
  s = step(s, { state: "down", epoch: 2 }, 1000 + REOPEN_GUARD_MS).state;
  assert.deepEqual(reopenPlan(s, "/a/p.nef"), { reopen: "/a/p.nef", refused: null });
});

test("engine exit errors are recognised and lose the log path", () => {
  const e = "the engine exited; see /home/u/.local/share/immage/engine.log";
  assert.ok(isEngineExit(e));
  assert.ok(isEngineExit(`error: ${e}`));
  assert.ok(!isEngineExit("no such file"));
  assert.equal(engineText(e), "the engine restarted");
  assert.equal(engineText(`Export failed: ${e}`), "Export failed: the engine restarted");
  assert.equal(engineText("disk full"), "disk full");
});
