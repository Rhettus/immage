// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Renders an edited RAW's culling-size preview in the background once the user
// leaves it, so the next cull is a disk hit (the engine's thumb command writes
// the edit- cache entry). Pure logic over injected dependencies; App.tsx binds
// the real ones. The page is single-threaded, so the queue takes no locks.
// It yields to everything the user waits on: a job starts only while the
// thumbnail loader is idle and culling is closed, and only one runs at a time,
// on the engine's background thumbnail pool.
import type { ImageEntry } from "./library";

// culling's last non-detail preview size, in device pixels (GridCulling stores it)
export const PREVIEW_SIZE_KEY = "immage.culling.previewSize";

const RECHECK_MS = 1000;

export interface EditedPreviewDeps {
  // renders the preview (and so caches it); a bitmap result is closed here
  fetch(entry: ImageEntry, size: number): Promise<{ close?: () => void } | void>;
  // no foreground thumbnail work is waiting
  idle(): boolean;
  loadSize(): number;
  kind(filename: string): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface Job { id: number; cancelled: boolean }

export function createEditedPreviews() {
  let deps: EditedPreviewDeps | null = null;
  const pending = new Map<number, ImageEntry>(); // insertion order is the run order
  let running: Job | null = null;
  let epoch = 0;
  let timer: unknown = null;
  let open = false, camera = false;

  const stopTimer = () => { if (timer !== null && deps) { deps.clearTimer(timer); timer = null; } };

  const pump = () => {
    if (!deps || running || timer !== null) return;
    const next = pending.entries().next();
    if (next.done) return;
    if (open || !deps.idle()) {
      timer = deps.setTimer(() => { timer = null; pump(); }, RECHECK_MS);
      return;
    }
    const [id, entry] = next.value;
    pending.delete(id);
    const size = deps.loadSize();
    if (!(size > 0)) { pump(); return; }
    const job: Job = { id, cancelled: false };
    running = job;
    deps.fetch(entry, size)
      // the result is only the cache write's by-product; a cancelled or
      // cleared job is simply over (its JPEG on disk is named by the file's
      // stamps, so it can never be a stale hit)
      .then((bitmap) => bitmap?.close?.())
      .catch(() => {})
      .finally(() => { running = null; pump(); });
  };

  return {
    configure(d: EditedPreviewDeps) { deps = d; },
    // after the photo is closed and saved
    schedule(entry: ImageEntry) {
      if (!deps || open || !entry.edited || deps.kind(entry.filename) !== "RAW" || camera || !(deps.loadSize() > 0)) return;
      pending.delete(entry.imgid);
      pending.set(entry.imgid, entry);
      pump();
    },
    // the photo is open again: a render now would be stale
    cancel(imgid: number) {
      pending.delete(imgid);
      if (running?.id === imgid) running.cancelled = true;
    },
    // another folder, or culling opening: drop everything queued
    clear() {
      pending.clear();
      epoch++;
      stopTimer();
    },
    // culling's state: opening it clears the queue, as culling fetches its own
    culling(isOpen: boolean, cameraPreviews: boolean) {
      camera = cameraPreviews;
      if (isOpen && !open) this.clear();
      open = isOpen;
    },
    pending: () => [...pending.keys()],
    running: () => running?.id ?? null,
  };
}

export const editedPreviews = createEditedPreviews();
