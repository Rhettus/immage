// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the one way the page calls the Rust layer's typed commands. bindings.ts is
// generated from the Rust signatures (src-tauri/src/bindings.rs; regenerate it
// with `IMMAGE_WRITE_BINDINGS=1 cargo test bindings` in app/src-tauri, which
// plain `cargo test` also checks), so a renamed argument or a changed reply
// fails the type check here. calls reject with the command's error string, as
// `invoke` does. the page calls no command by name: verify/typed-commands.test.mjs
// fails when a file other than bindings.ts imports `invoke`.
//
// binary replies (mapTile, later frames) come back as an ArrayBuffer
//
// every call is tracked for the stall watch (src-tauri/src/stall_watch.rs):
// once a second the page reports the calls still waiting after 2 s, the ones
// that came back after over 1 s, and how long its own timer was held up, so
// engine.log says what a frozen window was waiting on
import { commands as raw } from "./bindings";
export type * from "./bindings";

type Pending = { name: string; start: number };
type Slow = { name: string; ms: number; failed: boolean };

const BEAT_MS = 1000;
const PENDING_MS = 2000;
const SLOW_MS = 1000;
// a timer this late means the page's script was blocked
const GAP_MS = 1500;

const pending = new Map<number, Pending>();
let slow: Slow[] = [];
let slowMore = 0;
// slow calls named per beat; the rest are counted, so a long slow read
// cannot fill engine.log
const SLOW_LISTED = 10;
// the last calls started, named when the script turns out to have been blocked
const started: string[] = [];
let nextId = 1;

function track<F extends (...args: never[]) => unknown>(name: string, fn: F): F {
  return ((...args: Parameters<F>) => {
    const id = nextId++;
    const start = performance.now();
    pending.set(id, { name, start });
    started.push(name);
    if (started.length > 8) started.shift();
    const done = (failed: boolean) => {
      pending.delete(id);
      const ms = performance.now() - start;
      if (ms <= SLOW_MS) return;
      if (slow.length < SLOW_LISTED) slow.push({ name, ms: Math.round(ms), failed });
      else slowMore++;
    };
    const out = fn(...args);
    if (out instanceof Promise) out.then(() => done(false), () => done(true));
    else done(false);
    return out;
  }) as F;
}

export const commands: typeof raw = Object.fromEntries(
  Object.entries(raw).map(([name, fn]) =>
    [name, name === "stallBeat" ? fn : track(name, fn as (...a: never[]) => unknown)]),
) as typeof raw;

// starts the once-a-second report (boot.tsx)
export function watchStalls() {
  let last = performance.now();
  // a hidden window's timers are throttled, which is no stall: start the
  // count again when it shows
  document.addEventListener("visibilitychange", () => { last = performance.now(); });
  setInterval(() => {
    const now = performance.now();
    const late = now - last - BEAT_MS;
    last = now;
    const visible = document.visibilityState === "visible";
    const gapMs = late > GAP_MS && visible ? Math.round(late) : 0;
    const waiting = [...pending].filter(([, p]) => now - p.start > PENDING_MS)
      .slice(0, 20)
      .map(([id, p]) => ({ id, name: p.name, ms: Math.round(now - p.start) }));
    const report = { pending: waiting, slow, slowMore, gapMs, beforeGap: gapMs ? started.slice() : [], visible };
    slow = [];
    slowMore = 0;
    raw.stallBeat(report).catch(() => {});
  }, BEAT_MS);
}
