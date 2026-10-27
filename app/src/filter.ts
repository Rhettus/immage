// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the filmstrip's filter over a folder's photos: the toolbar's stars,
// flags and labels, and the Filters popup's fields. Immich results are
// narrowed by the server instead (immich.ts), all but the stars and type
import { shutter } from "./exportTokens";
import { fileKind, takenAt, type ImageEntry } from "./library";

export const EXPOSURE = ["iso", "aperture", "focal", "shutter"] as const;
export type ExposureKey = typeof EXPOSURE[number];

// `rejected` hides rejected photos or shows only them; `edited` picks those
// darktable counts as altered, or those it does not; `kinds` are file kinds
// as fileKind() names them; an empty list means all
export type Filter = {
  minRating: number; rejected: "all" | "hide" | "only"; edited: "all" | "edited" | "unedited";
  labels: number; unlabeled: boolean;
  // any of each list, as a photo has one of each; keywords all of them;
  // exposure settings as exposureLabel() writes them
  kinds: string[]; cameras: string[]; lenses: string[]; keywords: string[];
  takenFrom: string; takenTo: string;       // YYYY-MM-DD, "" for open
} & Record<ExposureKey, string[]>;

export const NO_FILTER: Filter = {
  minRating: 0, rejected: "all", edited: "all", labels: 0, unlabeled: false, kinds: [], cameras: [], lenses: [],
  keywords: [], takenFrom: "", takenTo: "", iso: [], aperture: [], focal: [], shutter: [],
};

export const cameraOf = (i: ImageEntry) => `${i.exif.maker} ${i.exif.model}`.trim();

// the exposure value each setting reads; 0 where the camera did not record it
const value = (i: ImageEntry, k: ExposureKey) =>
  k === "iso" ? i.exif.iso : k === "aperture" ? i.exif.aperture : k === "focal" ? i.exif.focal_length
    : i.exif.exposure;

// a setting as the camera shows it, which is what is picked: 1/250 is one
// value whatever the exact fraction recorded, and f/2.8 is not f/2.79
export const exposureLabel = (k: ExposureKey, v: number) =>
  !(v > 0) ? "" : k === "iso" ? String(Math.round(v)) : k === "aperture" ? `f/${Number(v.toFixed(1))}`
    : k === "focal" ? `${Number(v.toFixed(0))} mm` : shutter(v);

// a keyword is chosen with everything under it, as darktable's "a|b"
// hierarchy nests b in a
const hasKeyword = (i: ImageEntry, k: string) => (i.keywords ?? []).some((x) => x === k || x.startsWith(`${k}|`));

// "YYYY:MM:DD HH:MM:SS" as YYYY-MM-DD
const day = (i: ImageEntry) => takenAt(i).slice(0, 10).replace(/:/g, "-");

export const passes = (i: ImageEntry, f: Filter) =>
  (f.rejected === "all" || (f.rejected === "only") === i.rejected)
  && (f.edited === "all" || (f.edited === "edited") === i.edited)
  && (!f.kinds.length || f.kinds.includes(fileKind(i.filename)))
  && (f.minRating === 0 || (!i.rejected && i.rating >= f.minRating))
  // label filters admit an image carrying any of the chosen labels
  && ((!f.labels && !f.unlabeled) || (i.labels & f.labels) !== 0 || (f.unlabeled && i.labels === 0))
  && (!f.cameras.length || f.cameras.includes(cameraOf(i)))
  && (!f.lenses.length || f.lenses.includes(i.exif.lens))
  && f.keywords.every((k) => hasKeyword(i, k))
  && (!f.takenFrom || (!!takenAt(i) && day(i) >= f.takenFrom))
  && (!f.takenTo || (!!takenAt(i) && day(i) <= f.takenTo))
  && EXPOSURE.every((k) => !f[k].length || f[k].includes(exposureLabel(k, value(i, k))));

// the popup's fields in use, one each, for its button and the toolbar
export const popupCount = (f: Filter) =>
  [f.kinds.length, f.cameras.length, f.lenses.length, f.keywords.length, f.takenFrom || f.takenTo]
    .filter(Boolean).length + EXPOSURE.filter((k) => f[k].length).length;

// whether the filter asks for what only reading the file tells: everything
// but the file type, which its name gives
export const needsRead = (f: Filter) =>
  !!(f.minRating || f.rejected !== "all" || f.edited !== "all" || f.labels || f.unlabeled)
  || popupCount(f) > (f.kinds.length ? 1 : 0);

export type Facets = {
  kinds: [string, number][]; cameras: [string, number][]; lenses: [string, number][];
  keywords: [string, number][];
  months: [string, number][];              // YYYY-MM, newest first
} & Record<ExposureKey, [string, number][]>;

const counted = (values: Iterable<string>) => {
  const m = new Map<string, number>();
  for (const v of values) if (v) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
};
const byName = (m: Map<string, number>) => [...m].sort(([a], [b]) => a.localeCompare(b));

// what the shown photos hold, to choose from, with how many of each
export function facets(images: ImageEntry[]): Facets {
  const kinds = [...counted(images.map((i) => fileKind(i.filename)))]
    // RAW first, then the rest by name
    .sort(([a], [b]) => (a === "RAW" ? -1 : b === "RAW" ? 1 : a.localeCompare(b)));
  // a keyword counts its photo once, and each level above it counts it too
  const keywords = counted(images.flatMap((i) => [...new Set((i.keywords ?? []).flatMap((k) =>
    k.split("|").map((_, n, parts) => parts.slice(0, n + 1).join("|"))))]));
  // exposure settings from lowest to highest
  const settings = (k: ExposureKey): [string, number][] => {
    const m = new Map<string, { v: number; n: number }>();
    for (const i of images) {
      const v = value(i, k), l = exposureLabel(k, v);
      if (l) m.set(l, { v, n: (m.get(l)?.n ?? 0) + 1 });
    }
    return [...m].sort(([, a], [, b]) => a.v - b.v).map(([l, { n }]) => [l, n]);
  };
  return {
    kinds, cameras: byName(counted(images.map(cameraOf))), lenses: byName(counted(images.map((i) => i.exif.lens))),
    keywords: byName(keywords),
    months: [...counted(images.map((i) => takenAt(i) && day(i).slice(0, 7)))].sort(([a], [b]) => b.localeCompare(a)),
    iso: settings("iso"), aperture: settings("aperture"), focal: settings("focal"), shutter: settings("shutter"),
  };
}

// what the photos the rest of a filter leaves hold, so choosing a camera
// narrows the lenses to those used on it. `clear` takes out the list being
// shown's own choice, or choosing one value would hide the others
export const facetsWithin = (images: ImageEntry[], f: Filter, clear: Partial<Filter>) =>
  facets(images.filter((i) => passes(i, { ...f, ...clear })));
