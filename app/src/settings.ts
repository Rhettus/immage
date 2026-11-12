// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Synchronous settings with localStorage's shape, kept in a file by the Rust
// layer (settings_all, settings_set in main.rs). The file survives the WebView's
// storage being cleared or moved, and is shared by every window.
//
// The whole map is read once; entries await `ready` before loading anything that
// reads a setting (main.tsx loads boot.tsx after it, Splash.tsx renders after it).
// No top-level await here: pixelWorker's bundle reaches this module through
// perf.ts, and worker bundles cannot hold one. In a worker invoke is missing,
// so the map stays empty, as localStorage was missing there before.
import { invoke } from "@tauri-apps/api/core";

// keys Rust owns: it writes them, the page only reads
const NATIVE_PREFIX = "native.";
const MIGRATED = "immage.settings-migrated";
const DELAY_MS = 250;

const map = new Map<string, string>();
// a null removes the key
let pending = new Map<string, string | null>();
let timer: ReturnType<typeof setTimeout> | undefined;
let sending: Promise<void> = Promise.resolve();
let warned = false;
// false outside Tauri or when settings_all failed: writes then stay in memory,
// since a send could never succeed and its retry timer would never stop
let backed = false;
// set by discard(): a restore replaced the file, and nothing this page holds may be written over it
let discarded = false;

function browserStorage(): Storage | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; }
}

function queue(key: string, value: string | null) {
  if (!backed || discarded) return;
  pending.set(key, value);
  timer ??= setTimeout(() => { void flush(); }, DELAY_MS);
}

function send(): Promise<void> {
  // one request at a time, in order, so an older batch never lands after a newer one
  sending = sending.then(async () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (discarded || pending.size === 0) return;
    const batch = pending;
    pending = new Map();
    try {
      await invoke("settings_set", { changes: Object.fromEntries(batch) });
    } catch (e) {
      // keep the changes for the next flush, unless a newer write replaced them
      for (const [k, v] of batch) if (!pending.has(k)) pending.set(k, v);
      timer ??= setTimeout(() => { void flush(); }, DELAY_MS * 8);
      if (!warned) { warned = true; console.warn("settings: could not save, will retry", e); }
    }
  });
  return sending;
}

function flush(): Promise<void> {
  return send();
}

async function init() {
  let loaded = false;
  try {
    const all = await invoke<Record<string, string>>("settings_all");
    for (const [k, v] of Object.entries(all ?? {})) map.set(k, String(v));
    loaded = true;
    backed = true;
  } catch { /* outside Tauri, or the file is unreadable */ }
  const ls = browserStorage();
  if (!ls) return;
  // Copy localStorage in once. It stays as it is, so an older build still finds
  // its settings. Keys already in the file win, which also makes a second window
  // racing this one harmless. The marker that says it was done is kept in
  // localStorage too: with it only in the file, deleting settings.json to reset
  // would bring the old values back instead of the defaults.
  let copied = false;
  try { copied = ls.getItem(MIGRATED) === "1"; } catch { /* storage blocked */ }
  const migrate = !loaded || (!copied && !map.has(MIGRATED));
  if (!migrate) return;
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k === null || k.startsWith(NATIVE_PREFIX) || map.has(k)) continue;
      const v = ls.getItem(k);
      if (v === null) continue;
      map.set(k, v);
      if (loaded) pending.set(k, v);
    }
  } catch { /* storage blocked */ }
  if (loaded) {
    map.set(MIGRATED, "1");
    pending.set(MIGRATED, "1");
    await send();
    // only once the file holds the copy; a failed send copies again next start
    if (pending.size === 0) {
      try { ls.setItem(MIGRATED, "1"); } catch { /* copies again next start */ }
    }
  }
}

export const ready: Promise<void> = init();

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // best effort: the request may not finish as the page goes away
  window.addEventListener("pagehide", () => { void flush(); });
  window.addEventListener("beforeunload", () => { void flush(); });
}

// Drops the unsent changes and stops sending any more until the page reloads.
// A restore calls it before replacing settings.json, then reloads, so the
// page's own copy cannot be written back over the restored file.
function discard() {
  discarded = true;
  pending = new Map();
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
}

export const settings = {
  get(key: string): string | null { return map.get(key) ?? null; },
  set(key: string, value: string) {
    if (key.startsWith(NATIVE_PREFIX)) throw new Error(`settings: ${key} is written by the app, not the page`);
    value = String(value);
    if (map.get(key) === value) return;
    map.set(key, value);
    queue(key, value);
  },
  remove(key: string) {
    if (key.startsWith(NATIVE_PREFIX)) throw new Error(`settings: ${key} is written by the app, not the page`);
    if (!map.delete(key)) return;
    queue(key, null);
  },
  keys(): string[] { return [...map.keys()]; },
  flush,
  discard,
  ready,
};

export default settings;
