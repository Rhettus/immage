// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Windows: rendered frames handed over in WebView2 shared memory (main.rs,
// shared_frame) rather than in render's reply, which WebView2 copies across
// processes at a fraction of the Mac's speed. render then replies with the
// frame's header alone, and the whole frame arrives as a
// "sharedbufferreceived" event tagged with the id it was asked for
import { invoke } from "@tauri-apps/api/core";

type SharedBufferEvent = { getBuffer(): ArrayBuffer; additionalData: { frame?: number } | null };
type WebView2 = {
  addEventListener(type: "sharedbufferreceived", f: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
};
// the bytes before a frame's pixels (main.rs, render)
export const FRAME_HEAD = 56;

const webview = (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview;

// WebView2 only, and its shared buffers since runtime 1.0.1661
export const sharedFramesAvailable = !!webview && typeof webview.releaseBuffer === "function";

const KEY = "immage.sharedFrames";
export function loadSharedFrames(): boolean {
  try { return localStorage.getItem(KEY) !== "0"; } catch { return true; }
}
export function storeSharedFrames(on: boolean) {
  try { localStorage.setItem(KEY, on ? "1" : "0"); } catch { /* not kept */ }
  failed = false;
}

// Rust fell back to the reply, or a frame never came: off until restarted
let failed = false;
let next = 0;
let last: "shared" | "invoke" = "invoke";
// how the last frame came, for the GUI benchmark's report
export const frameTransport = () => last;

const arrived = new Map<number, ArrayBuffer>();
const waiting = new Map<number, (buffer: ArrayBuffer) => void>();

// copied out and released at once: a frame is kept (pixels, histogram,
// Before view) longer than the shared memory should be held, and the copy
// stays inside this process
webview?.addEventListener("sharedbufferreceived", (e) => {
  const id = e.additionalData?.frame;
  if (id === undefined) return;
  const shared = e.getBuffer();
  const buffer = shared.slice(0);
  webview.releaseBuffer(shared);
  const wake = waiting.get(id);
  if (wake) {
    waiting.delete(id);
    wake(buffer);
    return;
  }
  // before render's reply: kept for it, and only the latest few
  arrived.set(id, buffer);
  for (const old of arrived.keys()) if (arrived.size > 4) arrived.delete(old);
});

// render's reply, with the frame put back behind the header when it came by
// shared memory
export async function renderFrame(args: Record<string, unknown>): Promise<ArrayBuffer> {
  if (!sharedFramesAvailable || failed || !loadSharedFrames()) {
    last = "invoke";
    return invoke<ArrayBuffer>("render", args);
  }
  const id = ++next;
  const head = await invoke<ArrayBuffer>("render", { ...args, shared: id });
  const v = new DataView(head);
  const pixels = 4 * v.getUint32(0, true) * v.getUint32(4, true);
  if (head.byteLength !== FRAME_HEAD || pixels === 0) {
    if (head.byteLength > FRAME_HEAD) failed = true;
    last = "invoke";
    return head;
  }
  last = "shared";
  const early = arrived.get(id);
  if (early) {
    arrived.delete(id);
    return early;
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      failed = true;
      reject(new Error("the frame from shared memory never came"));
    }, 2000);
    waiting.set(id, (buffer) => { window.clearTimeout(timer); resolve(buffer); });
  });
}
