// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Windows and Linux: rendered frames handed over in shared memory rather
// than in render's reply, which WebView2 and WebKitGTK copy across
// processes at a fraction of the Mac's speed. render then replies with the
// frame's header alone. on Windows the whole frame arrives as a
// "sharedbufferreceived" event tagged with the id it was asked for
// (main.rs, shared_frame); on Linux render wrote it to /dev/shm, and the
// window's web extension reads it in (main.rs, shm_frame; webext/frames.c)
import { invoke } from "@tauri-apps/api/core";

type SharedBufferEvent = { getBuffer(): ArrayBuffer; additionalData: { frame?: number } | null };
type WebView2 = {
  addEventListener(type: "sharedbufferreceived", f: (e: SharedBufferEvent) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
};
// the bytes before a frame's pixels (main.rs, render)
export const FRAME_HEAD = 64;

const webview = (window as unknown as { chrome?: { webview?: WebView2 } }).chrome?.webview;

// the web extension's, when it was loaded (main.rs, webext_dir)
const shmFrame = (window as unknown as { immageFrame?: (name: string) => Uint8Array | null }).immageFrame;
// names this page's frames apart from another window's or another copy's
const token = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

// WebView2's shared buffers since runtime 1.0.1661, or the web extension
export const sharedFramesAvailable = (!!webview && typeof webview.releaseBuffer === "function")
  || typeof shmFrame === "function";

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
  const head = await invoke<ArrayBuffer>("render", { ...args, shared: id, ...(shmFrame ? { token } : {}) });
  const v = new DataView(head);
  const pixels = 4 * v.getUint32(0, true) * v.getUint32(4, true);
  if (head.byteLength !== FRAME_HEAD || pixels === 0) {
    if (head.byteLength > FRAME_HEAD) failed = true;
    last = "invoke";
    return head;
  }
  last = "shared";
  if (shmFrame) {
    const frame = shmFrame(`immage-frame-${token}-${id}`);
    if (frame?.byteLength === FRAME_HEAD + pixels) return frame.buffer as ArrayBuffer;
    // the extension can't reach the file: asked again, through the reply
    // from now on; the pipe's cache makes the second render quick. the
    // edits are in already
    failed = true;
    last = "invoke";
    return invoke<ArrayBuffer>("render", { ...args, edits: null });
  }
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
