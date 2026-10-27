// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// how much smaller drag drafts can be on a screen drawn larger than it
// shows. on Wayland at a fractional scale (125%), GTK 3 draws the window at
// 2× and the compositor shrinks it, so devicePixelRatio says 2 while the
// screen shows 1.25: a draft sized by it carries 1.6× the detail each way
// that reaches the screen, 2.5× the pixels for darktable. Rust reads the
// real scale (display_scale, scale.rs). only drafts: a full frame sized for
// the screen comes out jagged, enlarged by WebKit and then shrunk by the
// compositor

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const KEY = "immage.screenScaleDrafts";
export function loadScreenScale(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}
export function storeScreenScale(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

let real: number | null = null;

// the screen's scale, where it is less than the page's (for Preferences)
export const screenScale = (): number | null =>
  real !== null && real < (window.devicePixelRatio || 1) ? real : null;

// the screen's scale over the page's, or 1
export function draftScale(): number {
  const s = screenScale();
  return s !== null && loadScreenScale() ? s / (window.devicePixelRatio || 1) : 1;
}

// an error is a window not on a screen yet (at start): keep what was known
// and ask again
export async function refreshScreenScale(tries = 20) {
  try {
    real = await invoke<number | null>("display_scale");
  } catch {
    if (tries > 0) window.setTimeout(() => void refreshScreenScale(tries - 1), 250);
  }
}

// asked once at start, and again after the window settles on a screen
let timer = 0;
const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void refreshScreenScale(), 300); };
void refreshScreenScale();
window.addEventListener("resize", later);
try {
  const w = getCurrentWindow();
  void w.onMoved(later);
  void w.onScaleChanged(later);
} catch { /* outside Tauri */ }
