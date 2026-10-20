// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card: searches the server (immich_search.rs),
// turns its assets into filmstrip entries, and builds links into Immich's
// web app. the key stays in the backend; the page only sees the URL
import { invoke } from "@tauri-apps/api/core";
import { api } from "@immporter/api";
import type { Exif, ImageEntry } from "./library";

export type ImmichSearch = {
  mode: "smart" | "filename";
  text: string;
  library: string;            // "external", "all" or a library id
  takenFrom: string;          // YYYY-MM-DD, "" for none
  takenTo: string;
  minRating: number;          // 0 for any
  favorites: boolean;
  rawOnly: boolean;
  make: string; model: string; lens: string;
  country: string; city: string;
  personIds: string[]; tagIds: string[]; albumIds: string[];
};

export const NO_SEARCH: ImmichSearch = {
  mode: "smart", text: "", library: "external", takenFrom: "", takenTo: "", minRating: 0, favorites: false,
  rawOnly: false, make: "", model: "", lens: "", country: "", city: "", personIds: [], tagIds: [], albumIds: [],
};

const SEARCH_KEY = "immage.immichSearch";
export function loadSearch(): ImmichSearch {
  try { return { ...NO_SEARCH, ...JSON.parse(localStorage.getItem(SEARCH_KEY) ?? "{}") }; } catch { return NO_SEARCH; }
}
export function storeSearch(s: ImmichSearch) {
  try { localStorage.setItem(SEARCH_KEY, JSON.stringify(s)); } catch { /* not kept */ }
}

// where the server's paths are on this computer. unset, it is the
// importer's: its Path prefix in Immich, and the folder it imports to
export type PathMap = { immich: string; local: string };
const MAP_KEY = "immage.immichPathMap";
export function storedPathMap(): Partial<PathMap> {
  try { return JSON.parse(localStorage.getItem(MAP_KEY) ?? "{}"); } catch { return {}; }
}
export function storePathMap(m: Partial<PathMap>) {
  try { localStorage.setItem(MAP_KEY, JSON.stringify(m)); } catch { /* not kept */ }
}
export async function importerPathMap(): Promise<PathMap> {
  const [immich, ui] = await Promise.all([api.getImmichSettings().catch(() => null), api.getSettings().catch(() => null)]);
  return { immich: immich?.pathPrefix ?? "", local: ui?.destRoot ?? "" };
}
export async function pathMap(): Promise<PathMap> {
  const stored = storedPathMap(), dflt = await importerPathMap();
  return { immich: stored.immich || dflt.immich, local: stored.local || dflt.local };
}

// the server's URL when Immich is set up (a URL and a stored key), else null
export async function immichUrl(): Promise<string | null> {
  try {
    const s = await api.getImmichSettings();
    return s.url.trim() && s.hasKey ? s.url.trim().replace(/\/+$/, "").replace(/\/api$/, "") : null;
  } catch { return null; }
}

type Asset = {
  id: string; name: string; path: string; localPath: string | null; date: string | null; rating: number;
  favorite: boolean; width: number; height: number;
  exif: { make: string | null; model: string | null; lens: string | null; iso: number | null; aperture: number | null;
          exposure: string | null; focal: number | null; datetime: string | null };
};
export type Page = { entries: ImageEntry[]; next: string | null };

// "1/250" or "0.5" as seconds
const seconds = (s: string | null) => {
  if (!s) return 0;
  const [a, b] = s.split("/").map(Number);
  return b ? a / b : a || 0;
};

// result entries take ids below zero, which the engine never gives, so the
// filmstrip, selection and thumbnails tell them apart; a search's ids stay
// unique for the session, so an old result's bitmap is never taken for a new one
let nextId = -1;
const assets = new Map<number, string>();
export const assetOf = (imgid: number) => assets.get(imgid);

function entry(a: Asset): ImageEntry {
  const imgid = nextId--;
  assets.set(imgid, a.id);
  const exif: Exif = {
    maker: a.exif.make ?? "", model: a.exif.model ?? "", lens: a.exif.lens ?? "", exposure: seconds(a.exif.exposure),
    aperture: a.exif.aperture ?? 0, iso: a.exif.iso ?? 0, focal_length: a.exif.focal ?? 0, exposure_bias: 0,
    focus_distance: 0, datetime: a.exif.datetime ?? a.date ?? "",
  };
  return {
    imgid, path: `immich:${a.path}`, filename: a.name, rating: Math.min(5, a.rating), rejected: false, labels: 0,
    edited: false, width: a.width, height: a.height, exif,
    remote: { assetId: a.id, originalPath: a.path, localPath: a.localPath },
  };
}

export async function search(s: ImmichSearch, next: string | null): Promise<Page> {
  const args = {
    ...s, takenFrom: s.takenFrom || null, takenTo: s.takenTo || null, minRating: s.minRating || null,
    make: s.make || null, model: s.model || null, lens: s.lens || null, country: s.country || null,
    city: s.city || null, next, size: 250,
  };
  const r = await invoke<{ items: Asset[]; next: string | null }>("immich_search", { args, map: await pathMap() });
  return { entries: r.items.map(entry), next: r.next };
}

// an entry not yet opened: a search result, still the server's
export const isRemote = (i: ImageEntry) => i.imgid < 0;

export async function fetchImmichThumb(imgid: number): Promise<ImageBitmap> {
  const id = assets.get(imgid);
  if (!id) throw new Error("not an Immich result");
  const buf = await invoke<ArrayBuffer>("immich_thumb", { id });
  // WebKit decodes a Blob by its type, not its bytes: named from the
  // signature (Immich sends WebP, or JPEG when set to)
  const b = new Uint8Array(buf, 0, Math.min(12, buf.byteLength));
  const type = b[0] === 0xff && b[1] === 0xd8 ? "image/jpeg"
    : String.fromCharCode(...b.slice(8, 12)) === "WEBP" ? "image/webp" : "image/png";
  return createImageBitmap(new Blob([buf], { type }));
}

// the file to open for a result: its own, or the downloaded original
export async function resolve(i: ImageEntry): Promise<{ path: string; downloaded: boolean }> {
  const r = i.remote!;
  return invoke("immich_resolve", { id: r.assetId, name: i.filename, path: r.originalPath, map: await pathMap() });
}

export const photoUrl = (base: string, assetId: string) => `${base}/photos/${assetId}`;

// the search in Immich's web app, which reads its search page's query as
// the older flat search fields. it has no "any external library" or raw
// filter, so those two do not carry over
export function searchUrl(base: string, s: ImmichSearch): string {
  const q: Record<string, unknown> = {};
  const text = s.text.trim();
  if (text) q[s.mode === "smart" ? "query" : "originalFileName"] = text;
  if (s.library !== "external" && s.library !== "all") q.libraryId = s.library;
  if (s.takenFrom) q.takenAfter = `${s.takenFrom}T00:00:00.000Z`;
  if (s.takenTo) q.takenBefore = `${s.takenTo}T23:59:59.999Z`;
  if (s.minRating) q.rating = s.minRating;
  if (s.favorites) q.isFavorite = true;
  for (const [k, v] of [["make", s.make], ["model", s.model], ["lensModel", s.lens], ["country", s.country],
                        ["city", s.city]] as const) if (v) q[k] = v;
  if (s.personIds.length) q.personIds = s.personIds;
  if (s.tagIds.length) q.tagIds = s.tagIds;
  if (s.albumIds.length) q.albumIds = s.albumIds;
  return `${base}/search?query=${encodeURIComponent(JSON.stringify(q))}`;
}
