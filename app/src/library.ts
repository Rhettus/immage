// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the open folder's images as the engine's in-memory library reports them,
// and their thumbnails
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { fetchImmichThumb } from "./immich";

export type Exif = {
  maker: string; model: string; lens: string;
  exposure: number; aperture: number; iso: number; focal_length: number;
  exposure_bias: number; focus_distance: number; datetime: string;
  // the file's modified time, sent only when there is no capture time
  file_datetime?: string;
};

// when a photo was taken, for its order and the date filters: its file's
// modified time when the camera recorded none. "YYYY:MM:DD HH:MM:SS", or ""
export const takenAt = (i: Known) => i.exif.datetime || i.exif.file_datetime || "";

export type ImageEntry = {
  imgid: number;
  path: string;
  filename: string;
  rating: number;     // 0-5
  rejected: boolean;
  labels: number;     // bits: red 1, yellow 2, green 4, blue 8, purple 16
  edited: boolean;
  width: number;
  height: number;
  exif: Exif;
  keywords?: string[];  // darktable's tags, "|" between levels (absent on Immich results)
  // darktable's version of the file: Lightroom's virtual copies are every
  // version but the lowest, which is the original (absent on Immich results)
  version?: number;
  copy?: boolean;
  // an Immich search result (immich.ts): the server's asset, and the file on
  // this computer when its external library is here too
  remote?: { assetId: string; originalPath: string; localPath: string | null };
};

// an image as the folder's last read found it (open_folder's snapshot),
// shown before this read has reached it; the engine's imgid comes then
export type Known = Omit<ImageEntry, "imgid">;
// a known image's thumbnail in the ThumbLoader, until it has an imgid
export const knownKey = (i: Known) => `${i.version ?? 0}:${i.path}`;

export const LABEL_COLORS = ["#e5484d", "#f5c518", "#46a758", "#3e7bfa", "#9b5de5"];

// with `recursive`, the photos of its subfolders too, as Lightroom's
// Include Photos from Subfolders. `onBatch` hears each batch as the engine
// reads it, with how far it has got, and once before the first with every
// file to be read (`files`, in the order they will come). before that, for
// a folder read before, it hears what the last read found (`known`). `skip` lists
// subfolders taken off the folder tree, left out of `recursive`. opening
// another folder stops this one, which then rejects with "superseded"
let folderToken = 0;
export async function openFolder(path: string, recursive = false, skip: string[] = [],
                                 onBatch?: (images: ImageEntry[], done: number, total: number, files?: string[],
                                            known?: Known[]) => void,
): Promise<ImageEntry[]> {
  const token = ++folderToken;
  type Progress = { token: number; done: number; total: number; images: ImageEntry[]; files?: string[]; known?: Known[] };
  const off = await listen<Progress>("folder-progress", (e) => {
    const p = e.payload;
    if (p.token === token) onBatch?.(p.images, p.done, p.total, p.files, p.known);
  });
  try {
    const reply = await invoke<{ images: ImageEntry[] }>("open_folder", { path, recursive, skip, token });
    return reply.images;
  } finally {
    off();
  }
}

// a folder's photos by capture time, as Lightroom's default sort. the
// engine's "YYYY:MM:DD HH:MM:SS" sorts as text; a photo without one goes by
// its file's time (takenAt), photos with neither go last, and ties keep the
// name order the folder was read in
export function byCaptureTime<T extends Known>(images: T[]): T[] {
  return [...images].sort((a, b) => {
    const p = takenAt(a), q = takenAt(b);
    return !p || !q ? Number(!p) - Number(!q) : p < q ? -1 : p > q ? 1 : 0;
  });
}

// the photos read so far and the known ones not yet read, in the order the
// read will end with, so a known cell keeps its place when its photo is
// read. the read ones go first: they are the folder's first files, so ties
// keep the folder's order
export const withKnown = (read: ImageEntry[], unread: Known[]) => byCaptureTime<ImageEntry | Known>([...read, ...unread]);

// the file's kind as the filmstrip's badge and the type filter name it:
// its extension, but every raw format is "RAW"
const NOT_RAW: Record<string, string> = {
  jpg: "JPEG", jpeg: "JPEG", jpe: "JPEG", tif: "TIFF", tiff: "TIFF", heic: "HEIF", heif: "HEIF", hif: "HEIF",
  png: "PNG", avif: "AVIF", webp: "WEBP", jxl: "JXL", exr: "EXR", pfm: "PFM", ppm: "PNM", pgm: "PNM",
  pnm: "PNM", gif: "GIF", j2k: "JPEG 2000", jp2: "JPEG 2000", qoi: "QOI", bmp: "BMP",
};
export const fileKind = (filename: string) => {
  const ext = filename.match(/\.([^.]+)$/)?.[1].toLowerCase() ?? "";
  return NOT_RAW[ext] ?? "RAW";
};

// a camera's RAW+JPEG (or RAW+HEIF) pair shares its folder and name; this
// is that shared part, the same for both files
export const pairKey = (path: string) => path.replace(/\.[^./\\]+$/, "").toLowerCase();
// what stacks behind a raw: its JPEG or HEIF, and an OM System / Olympus
// .ORI (the original frame kept beside a High Res Shot's .ORF), which is a
// raw of its own when alone
export const isCompanion = (name: string) => {
  const kind = fileKind(name);
  return kind === "JPEG" || kind === "HEIF" || /\.ori$/i.test(name);
};
// a raw that others can stack behind
export const isPrimaryRaw = (name: string) => fileKind(name) === "RAW" && !/\.ori$/i.test(name);

// with pairs stacked: each raw that has companions of the same name, by
// imgid, with those companions. a name with two raws stacks nothing
export function pairPartners(images: ImageEntry[]): Map<number, ImageEntry[]> {
  const groups = new Map<string, ImageEntry[]>();
  for (const i of images) {
    // a virtual copy stands alone, as Lightroom shows one
    if (i.copy || (!isPrimaryRaw(i.filename) && !isCompanion(i.filename))) continue;
    const k = pairKey(i.path);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const out = new Map<number, ImageEntry[]>();
  for (const g of groups.values()) {
    const raws = g.filter((i) => isPrimaryRaw(i.filename));
    if (raws.length === 1 && g.length > 1) out.set(raws[0].imgid, g.filter((i) => i !== raws[0]));
  }
  return out;
}

const SUBFOLDERS_KEY = "immage.includeSubfolders";
export function loadIncludeSubfolders(): boolean {
  try { return localStorage.getItem(SUBFOLDERS_KEY) === "1"; } catch { return false; }
}
export function storeIncludeSubfolders(on: boolean) {
  try { localStorage.setItem(SUBFOLDERS_KEY, on ? "1" : "0"); } catch { /* not kept */ }
}

const THUMB_SIZE = 240; // device pixels; the engine picks the next cached size up

// an image as darktable's thumbnail pipe renders it, edits and all, at the
// cached size next up from this one. given its entry, the thumbnail is also
// kept on disk for fetchCachedThumb()
export async function fetchThumb(imgid: number, size: number, entry?: ImageEntry): Promise<ImageBitmap> {
  const buf = await invoke<ArrayBuffer>("thumb", { imgid, size, path: entry?.path ?? null, version: entry?.version ?? 0 });
  const head = new DataView(buf, 0, 8);
  const w = head.getUint32(0, true), h = head.getUint32(4, true);
  return createImageBitmap(new ImageData(new Uint8ClampedArray(buf, 8), w, h));
}

// the thumbnail kept on disk for the file as it is now (its sidecar too),
// without the engine; null when there is none
async function fetchCachedThumb(entry: ImageEntry, size: number): Promise<ImageBitmap | null> {
  const buf = await invoke<ArrayBuffer>("thumb_cached", { path: entry.path, version: entry.version ?? 0, size });
  return buf.byteLength ? createImageBitmap(new Blob([buf], { type: "image/jpeg" })) : null;
}

// the thumbnail last made of the file, found by its path alone, which on
// a network share is quicker than looking at the file; it may be of the file
// as it was, so it stands in until fetchCachedThumb() or the engine says
async function fetchKnownThumb(key: string, size: number): Promise<ImageBitmap | null> {
  const at = key.indexOf(":");
  const buf = await invoke<ArrayBuffer>("thumb_known", { path: key.slice(at + 1), version: Number(key.slice(0, at)), size });
  return buf.byteLength ? createImageBitmap(new Blob([buf], { type: "image/jpeg" })) : null;
}

// fetches thumbnails: those kept on disk first, several at a time, then
// the rest from the engine, ENGINE_THUMBS at a time. the engine builds them
// on threads of its own (main.c, _thumb_run), so they come in while a photo
// is edited, and no render waits behind one. past `limit` bytes (Preferences' Thumbnail memory), those off screen
// longest are let go, and come back from disk when scrolled to.
// a known image's thumbnail goes by its knownKey() until the image has an
// imgid, then stands in for it until checked (fetchKnownThumb)
const ENGINE_THUMBS = 2; // the engine's thumbnail threads, main.c's _THUMB_THREADS

type Id = number | string;

export class ThumbLoader {
  private cache = new Map<Id, ImageBitmap>();
  private bytes = 0;
  // on screen now (show), and when each was last
  private visible = new Set<Id>();
  private seen = new Map<Id, number>();
  private clock = 0;
  private queue: Id[] = [];
  private running = false;
  // engine thumbnails under way, and run() waiting for one to finish
  private inFlight = 0;
  private wake: (() => void) | null = null;
  // edited images whose cached thumbnail is out of date; it stays on show
  // until the fresh one is ready, so the filmstrip does not flicker
  private stale = new Set<number>();
  private refreshTimers = new Map<number, number>();
  // known thumbnails standing in for these until the disk or the engine
  // has one of the file as it is now
  private unverified = new Set<number>();
  // known thumbnails whose images have been read: theirs now go by imgid
  private adopted = new Set<string>();
  // the folder's thumbnails asked for since it opened, and those done
  // (loaded, or found to have none), for the progress shown
  private asked = new Set<number>();
  private done = new Set<number>();
  // looked for on disk already; a miss goes to the engine
  private tried = new Set<Id>();
  // a clear() while disk reads are out makes their results another folder's
  private generation = 0;
  // each filmstrip cell hears of its own thumbnail, so one landing redraws
  // that cell rather than the window
  private watchers = new Map<Id, Set<() => void>>();
  private progressWatchers = new Set<() => void>();

  constructor(private entryOf: (imgid: number) => ImageEntry | undefined,
              private limit: () => number,
              private onFailed?: (imgid: number, error: unknown) => void) {}

  get(imgid: Id) { return this.cache.get(imgid); }

  // `on` is called when the image's thumbnail arrives or is let go
  watch(imgid: Id, on: () => void) {
    let set = this.watchers.get(imgid);
    if (!set) this.watchers.set(imgid, set = new Set());
    set.add(on);
    return () => {
      set.delete(on);
      if (!set.size) this.watchers.delete(imgid);
    };
  }

  // `on` is called as progress() moves
  watchProgress(on: () => void) {
    this.progressWatchers.add(on);
    return () => { this.progressWatchers.delete(on); };
  }

  private changed(imgid: Id) {
    this.watchers.get(imgid)?.forEach((on) => on());
  }

  private progressed() {
    this.progressWatchers.forEach((on) => on());
  }

  // load these, in this order, after anything already asked for first
  request(ids: Id[], first = false) {
    for (const id of ids) if (typeof id === "number") this.adopt(id);
    const wanted = ids.filter((id) => !this.cache.has(id) || (typeof id === "number" && this.unverified.has(id)));
    wanted.forEach((id) => { if (typeof id === "number") this.asked.add(id); });
    this.queue = first ? [...wanted, ...this.queue.filter((id) => !wanted.includes(id))]
                       : [...this.queue, ...wanted.filter((id) => !this.queue.includes(id))];
    if (wanted.length) this.progressed();
    void this.run();
  }

  // an image just read takes its known thumbnail, unchecked
  private adopt(id: number) {
    if (this.cache.has(id)) return;
    const entry = this.entryOf(id);
    if (!entry) return;
    const key = knownKey(entry);
    this.adopted.add(key);
    this.visible.delete(key);
    const bitmap = this.cache.get(key);
    if (!bitmap) return;
    this.cache.delete(key);
    this.cache.set(id, bitmap);
    this.seen.set(id, this.seen.get(key) ?? 0);
    this.unverified.add(id);
    this.changed(id);
  }

  // these came on screen, or went off it
  show(ids: Id[], on: boolean) {
    for (const id of ids) {
      if (on) {
        this.visible.add(id);
        this.seen.set(id, ++this.clock);
      } else this.visible.delete(id);
    }
  }

  // the image was edited: render a fresh thumbnail once edits have paused
  // for a while, as each one is a full render on the shared engine
  invalidate(imgid: number) {
    window.clearTimeout(this.refreshTimers.get(imgid));
    this.refreshTimers.set(imgid, window.setTimeout(() => {
      this.refreshTimers.delete(imgid);
      this.stale.add(imgid);
      this.queue = [imgid, ...this.queue.filter((id) => id !== imgid)];
      void this.run();
    }, 2000));
  }

  // how many of the folder's thumbnails are ready, of how many
  progress() { return { done: this.done.size, total: this.asked.size }; }

  clear() {
    this.generation++;
    this.tried.clear();
    this.asked.clear();
    this.done.clear();
    this.cache.clear();
    this.bytes = 0;
    this.visible.clear();
    this.seen.clear();
    this.queue = [];
    this.stale.clear();
    this.unverified.clear();
    this.adopted.clear();
    this.refreshTimers.forEach((t) => window.clearTimeout(t));
    this.refreshTimers.clear();
    [...this.watchers.keys()].forEach((id) => this.changed(id));
    this.progressed();
  }

  // up to eight queued that may be on disk, with their entries (none for
  // a known thumbnail)
  private nextOnDisk(): [Id, ImageEntry | null][] {
    const out: [Id, ImageEntry | null][] = [];
    for (const id of this.queue) {
      if (out.length === 8) break;
      if (typeof id === "string") {
        if (this.tried.has(id) || this.cache.has(id) || this.adopted.has(id)) continue;
        this.tried.add(id);
        out.push([id, null]);
        continue;
      }
      if (id < 0 || this.tried.has(id) || this.stale.has(id) || (this.cache.has(id) && !this.unverified.has(id))) continue;
      this.tried.add(id);
      const entry = this.entryOf(id);
      if (entry) out.push([id, entry]);
    }
    return out;
  }

  private keep(id: Id, bitmap: ImageBitmap) {
    const old = this.cache.get(id);
    if (old) this.bytes -= old.width * old.height * 4;
    this.cache.set(id, bitmap);
    this.bytes += bitmap.width * bitmap.height * 4;
    if (typeof id === "number" && this.asked.has(id)) this.done.add(id);
    this.changed(id);
    this.trim();
  }

  // over the limit, down to 90% of it, so a folder being read does not
  // sort the cache for every thumbnail; never one on screen
  private trim() {
    const limit = this.limit();
    if (this.bytes <= limit) return;
    const gone = [...this.cache.keys()].filter((id) => !this.visible.has(id))
      .sort((a, b) => (this.seen.get(a) ?? 0) - (this.seen.get(b) ?? 0));
    for (const id of gone) {
      if (this.bytes <= limit * 0.9) break;
      const b = this.cache.get(id)!;
      this.bytes -= b.width * b.height * 4;
      this.cache.delete(id);
      // read from disk again when it is next asked for
      this.tried.delete(id);
      this.changed(id);
    }
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        // eight reads from disk at a time, ahead of any render, and one
        // redraw for them all
        const disk = this.nextOnDisk();
        if (disk.length) {
          const generation = this.generation;
          const got = await Promise.all(disk.map(([id, entry]) =>
            (entry ? fetchCachedThumb(entry, THUMB_SIZE) : fetchKnownThumb(id as string, THUMB_SIZE)).catch(() => null)));
          if (generation !== this.generation) continue;
          let any = false;
          disk.forEach(([id], k) => {
            const bitmap = got[k];
            // a known thumbnail is the disk's or none; the engine has no imgid for it
            if (typeof id === "string") {
              this.queue = this.queue.filter((q) => q !== id);
              // its image was read meanwhile, and has it from the disk or the engine
              if (!bitmap || this.adopted.has(id)) return;
            } else {
              // an edit while it was read wants a fresh render
              if (!bitmap || this.stale.has(id)) return;
              this.queue = this.queue.filter((q) => q !== id);
              this.unverified.delete(id);
            }
            this.keep(id, bitmap);
            any = true;
          });
          if (any) this.progressed();
          continue;
        }
        if (this.inFlight >= ENGINE_THUMBS) {
          await new Promise<void>((r) => { this.wake = r; });
          continue;
        }
        const id = this.queue.shift()!;
        if (typeof id === "string" || (this.cache.has(id) && !this.stale.has(id) && !this.unverified.has(id))) continue;
        this.stale.delete(id);
        this.unverified.delete(id);
        this.inFlight++;
        void this.fetch(id).finally(() => {
          this.inFlight--;
          const wake = this.wake;
          this.wake = null;
          wake?.();
        });
      }
    } finally {
      this.running = false;
    }
  }

  private async fetch(id: number) {
    const generation = this.generation;
    try {
      // below zero, an Immich result: the server's own thumbnail
      const bitmap = id < 0 ? await fetchImmichThumb(id) : await fetchThumb(id, THUMB_SIZE, this.entryOf(id));
      if (generation === this.generation) this.keep(id, bitmap);
    } catch (e) {
      if (generation !== this.generation) return;
      // an image without a thumbnail keeps its placeholder
      this.onFailed?.(id, e);
      if (this.asked.has(id)) this.done.add(id);
    }
    this.progressed();
  }
}
