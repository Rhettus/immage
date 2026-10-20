// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the in-app update: tauri-plugin-updater reads latest.json from the newest
// GitHub release (tauri.conf.json, plugins.updater), checks its signature
// against the public key there, and installs it over this copy. the state is
// held here, outside React, since the banner (App.tsx) and Preferences'
// About both show it
import { useSyncExternalStore } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; got: number; total: number | null }
  | { kind: "installing"; update: Update }
  // engineGone: the engine has quit for the install, so the app cannot go on
  // as it is and has to be relaunched
  | { kind: "failed"; message: string; update: Update | null; engineGone: boolean };

export const RELEASES_URL = "https://github.com/Rhettus/immage/releases";
export const releaseUrl = (version: string) => `${RELEASES_URL}/tag/v${version}`;

const DAY_MS = 24 * 3600 * 1000;
const AUTO_KEY = "immage.updates.auto";
const LAST_KEY = "immage.updates.lastCheck";
const SKIP_KEY = "immage.updates.skip";

// on unless turned off; it asks GitHub
export function loadAutoCheck(): boolean {
  try { return localStorage.getItem(AUTO_KEY) !== "0"; } catch { return true; }
}
export function storeAutoCheck(on: boolean) {
  try { localStorage.setItem(AUTO_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}
// when a check last reached GitHub, in ms since 1970, or null
export function lastChecked(): number | null {
  try { return Number(localStorage.getItem(LAST_KEY)) || null; } catch { return null; }
}

let state: UpdateState = { kind: "idle" };
// Later: the banner is put away until the app starts again or a check is
// asked for
let hidden = false;
const listeners = new Set<() => void>();
function set(next: UpdateState) {
  state = next;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export function useUpdate(): UpdateState {
  return useSyncExternalStore(subscribe, () => state);
}
export function useBannerShown(): boolean {
  return useSyncExternalStore(subscribe, () => !hidden && (state.kind === "available" || state.kind === "downloading"
    || state.kind === "installing" || (state.kind === "failed" && !!state.update)));
}

// asked for in Preferences, or the daily one; that one says nothing of a
// failure (offline, no release yet) and passes over a skipped version
export async function checkForUpdate(asked: boolean) {
  if (state.kind === "checking" || state.kind === "downloading" || state.kind === "installing") return;
  const old = "update" in state ? state.update : null;
  set({ kind: "checking" });
  try {
    const update = await check({ timeout: 20000 });
    try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch { /* not kept */ }
    if (old && old !== update) void old.close().catch(() => {});
    let skipped: string | null = null;
    try { skipped = localStorage.getItem(SKIP_KEY); } catch { /* none */ }
    if (!update) {
      set({ kind: "current" });
    } else if (!asked && update.version === skipped) {
      set({ kind: "current" });
      void update.close().catch(() => {});
    } else {
      hidden = false;
      set({ kind: "available", update });
    }
  } catch (e) {
    set(asked ? { kind: "failed", message: String(e), update: null, engineGone: false } : { kind: "idle" });
  }
}

// at start and then hourly: a check once a day at most, unless turned off.
// a dev build has nothing to install over
export function autoCheck() {
  if (import.meta.env.DEV || !loadAutoCheck()) return;
  const last = lastChecked();
  if (last && Date.now() - last < DAY_MS) return;
  void checkForUpdate(false);
}

export function later() {
  hidden = true;
  listeners.forEach((l) => l());
}

export function skipVersion() {
  if (!("update" in state) || !state.update) return;
  try { localStorage.setItem(SKIP_KEY, state.update.version); } catch { /* not kept */ }
  later();
}

// download first, while the app still works; then `prepare` saves the open
// edit and quits the engine, and the update goes in. on Windows install()
// hands over to the installer, which exits the app and starts the new one
export async function installUpdate(prepare: () => Promise<void>) {
  if (state.kind !== "available" && !(state.kind === "failed" && state.update && !state.engineGone)) return;
  const update = state.update!;
  let got = 0, total: number | null = null, shown = -1;
  set({ kind: "downloading", update, got, total });
  let engineGone = false;
  try {
    await update.download((ev) => {
      if (ev.event === "Started") total = ev.data.contentLength ?? null;
      else if (ev.event === "Progress") got += ev.data.chunkLength;
      // a render per percent, or per MB with no length known, not per chunk
      const step = total ? Math.floor((got / total) * 100) : Math.floor(got / 1e6);
      if (step !== shown) { shown = step; set({ kind: "downloading", update, got, total }); }
    });
    set({ kind: "installing", update });
    await prepare();
    engineGone = true;
    await update.install();
    await relaunch();
  } catch (e) {
    set({ kind: "failed", message: String(e), update, engineGone });
  }
}

export { relaunch };
