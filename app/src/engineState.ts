// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the engine's supervision as the page sees it (Rust's `engine-state`
// event): what to show, and when a restart has to be answered by reading
// the library and the open photo again. the page does the restoring
// (App.tsx, restoreEngine); this decides whether, and what to skip

export type EngineEvent =
  | { state: "down"; epoch: number }
  | { state: "ready"; epoch: number }
  | { state: "slow"; op: string; seconds: number }
  | { state: "failed" };

export type Notice =
  | null
  | { kind: "slow"; op: string; seconds: number }
  | { kind: "restarting" }
  | { kind: "failed" };

export type EngineState = {
  // the newest engine seen; the first is 1
  epoch: number;
  notice: Notice;
  // the photo the last restore reopened, and when
  reopened: { path: string; at: number } | null;
  // a photo the engine died on soon after it was reopened: not reopened again
  skip: string | null;
};

// the engine dying this soon after a photo was reopened is blamed on it
export const REOPEN_GUARD_MS = 30000;

export const START: EngineState = { epoch: 1, notice: null, reopened: null, skip: null };

// what a command that was in flight when the engine died is told
// (engine.rs, ENGINE_EXITED)
export const isEngineExit = (message: unknown) => String(message).includes("the engine exited");

// that error as the user reads it: the log's path is for the log
export const engineText = (message: unknown) => {
  const s = String(message);
  const at = s.indexOf("the engine exited");
  return at < 0 ? s : `${s.slice(0, at)}the engine restarted`;
};

// the new state, and whether the page now has a new engine to restore
export function step(s: EngineState, e: EngineEvent, now: number): { state: EngineState; restore: boolean } {
  switch (e.state) {
    case "down":
      return {
        state: { ...s, notice: { kind: "restarting" },
                 skip: s.reopened && now - s.reopened.at < REOPEN_GUARD_MS ? s.reopened.path : null },
        restore: false,
      };
    case "ready":
      if (e.epoch > s.epoch) return { state: { ...s, epoch: e.epoch, notice: null }, restore: true };
      // a slow request answered after all
      return { state: s.notice?.kind === "slow" ? { ...s, notice: null } : s, restore: false };
    case "slow":
      // a restart under way says more than a wait
      return { state: s.notice?.kind === "restarting" || s.notice?.kind === "failed" ? s
                      : { ...s, notice: { kind: "slow", op: e.op, seconds: e.seconds } }, restore: false };
    case "failed":
      return { state: { ...s, notice: { kind: "failed" } }, restore: false };
  }
}

// Wait: the notice goes away for this request
export const wait = (s: EngineState): EngineState => (s.notice?.kind === "slow" ? { ...s, notice: null } : s);

// the photo to reopen after a restart, or why not: `path` is the one that
// was open, `skip` the one the engine died on
export function reopenPlan(s: EngineState, path: string | null): { reopen: string | null; refused: string | null } {
  if (!path) return { reopen: null, refused: null };
  if (path === s.skip) return { reopen: null, refused: path };
  return { reopen: path, refused: null };
}

// the restore has started reopening `path`
export const reopening = (s: EngineState, path: string, now: number): EngineState =>
  ({ ...s, reopened: { path, at: now } });
