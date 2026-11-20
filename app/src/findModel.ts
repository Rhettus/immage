// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Find popup's state and rules, without React: what is searched (the
// words, where, and how), the folder Filter and the Immich search fields
// together, which categories each source shows, the chips of what is on,
// and what a saved filter holds. FindPanel.tsx draws it; App.tsx runs it.
//
// The two halves stay as they were: `filter` narrows this computer's photos
// (and Immich results, where their fields are known: remoteFieldsKnown), and
// `search` is what the server and the local index are asked. A row that
// means the same on both (rating, capture date, RAW) writes both, so the
// server narrows its pages and `passes` still checks what comes back.
import { EXPOSURE, NO_FILTER, type Filter } from "./filter";
import { fileKind } from "./library";
import { NO_SEARCH, type ImmichSearch } from "./immich";

export type FindState = { search: ImmichSearch; filter: Filter };

export const NO_FIND: FindState = { search: NO_SEARCH, filter: NO_FILTER };

// the Search in choice: the open folder, every indexed folder, the server, or both
export type SearchIn = "folder" | "library" | "immich" | "both";

export const searchIn = (s: ImmichSearch): SearchIn =>
  s.source === "immich" ? "immich" : s.source === "both" ? "both" : s.scope === "folder" ? "folder" : "library";

// Both searches the server and every folder, as This folder is the folder
// the filmstrip already shows
export function withSearchIn(s: ImmichSearch, v: SearchIn): ImmichSearch {
  switch (v) {
    case "folder": return { ...s, source: "local", scope: "folder" };
    case "library": return { ...s, source: "local", scope: "library" };
    case "immich": return { ...s, source: "immich" };
    case "both": return { ...s, source: "both", scope: "library" };
  }
}

// Opening a folder clears the search words and returns to folder browsing.
// Keep the filter settings, including those used when searching Immich again.
export const folderSearch = (s: ImmichSearch): ImmichSearch =>
  ({ ...withSearchIn(s, "folder"), text: "" });

// which sources a search reaches; Immich only when it is set up. `skipped`
// says the state asked for Immich and it was not there (a saved filter run
// on a computer without it, or with the server down)
export type Reach = { local: boolean; immich: boolean; skipped: boolean };
export function reach(s: ImmichSearch, immichAvailable: boolean): Reach {
  const wantsImmich = s.source !== "local";
  const wantsLocal = s.source !== "immich";
  if (!immichAvailable) return { local: true, immich: false, skipped: wantsImmich };
  return { local: wantsLocal, immich: wantsImmich, skipped: false };
}

// photo-content (Smart) search needs the local CLIP model or an Immich server.
// Without either, Find searches file names only: the search that runs has mode
// "filename" whatever the stored mode says, which is left alone so Smart comes
// back by itself once one of them is ready. Everything that runs a search, or
// compares the running one with the form, goes through this
export const smartAvailable = (clipReady: boolean, immichAvailable: boolean) => clipReady || immichAvailable;
export const effectiveSearch = (s: ImmichSearch, smart: boolean): ImmichSearch =>
  smart || s.mode === "filename" ? s : { ...s, mode: "filename" };

// Find's tip about the optional CLIP model: shown only once the status is
// known (not before its first answer) to say the model is missing, and never
// after the user dismissed it
export const clipTipVisible = (known: boolean, installed: boolean, dismissed: boolean) => known && !installed && !dismissed;

// whether the grid needs a search rather than the open folder filtered in
// place: words to match, a place other than the open folder, or a server
// field (which no folder photo can satisfy). Rows that map to the Filter
// alone (ticks, stars, dates) filter the folder live without one
export function needsSearch(st: FindState, immichAvailable: boolean): boolean {
  const r = reach(st.search, immichAvailable);
  if (r.immich) return true;
  if (st.search.text.trim()) return true;
  return searchIn(r.skipped ? { ...st.search, source: "local" } : st.search) !== "folder";
}

// ---- categories ------------------------------------------------------

export type Group = "photo" | "camera" | "when" | "immich";
export const GROUPS: Group[] = ["photo", "camera", "when", "immich"];

export type CategoryKey = "rating" | "edits" | "kinds" | "keywords" | "cameras" | "bodies" | "lenses" | "exposure"
  | "taken" | "place" | "people" | "albums" | "favorites";

// `local`: needs this computer's photos (hidden for Immich-only searches);
// `immich`: a server field (shown, tagged IMMICH, once Immich is in the
// search); neither: both sources have it
export type Only = "local" | "immich" | null;

export type Category = { key: CategoryKey; group: Group; only: Only };

export const CATEGORIES: Category[] = [
  { key: "rating", group: "photo", only: null },
  { key: "edits", group: "photo", only: "local" },
  { key: "kinds", group: "photo", only: null },
  { key: "keywords", group: "photo", only: null },
  { key: "cameras", group: "camera", only: null },
  { key: "bodies", group: "camera", only: "local" },
  { key: "lenses", group: "camera", only: null },
  { key: "exposure", group: "camera", only: "local" },
  { key: "taken", group: "when", only: null },
  { key: "place", group: "when", only: "immich" },
  { key: "people", group: "immich", only: "immich" },
  { key: "albums", group: "immich", only: "immich" },
  { key: "favorites", group: "immich", only: "immich" },
];

// the categories a search shows, in order
export function visibleCategories(s: ImmichSearch, immichAvailable: boolean): Category[] {
  const r = reach(s, immichAvailable);
  return CATEGORIES.filter((c) => c.only === "local" ? r.local : c.only === "immich" ? r.immich : true);
}

// whether a shared row (camera, lens, keywords) edits the server's fields
// rather than the folder's lists: only when no local source is searched,
// as the local lists are what the folder holds and remote hits are checked
// against them by `passes`
export const serverPickers = (s: ImmichSearch, immichAvailable: boolean) => {
  const r = reach(s, immichAvailable);
  return r.immich && !r.local;
};

// the folder Filter a search checks its results with. An Immich-only search
// shows the server's pickers, so the folder's lists, flags and labels left
// from an earlier local search are hidden there and must not narrow it:
// only the fields both halves share stay
export function effectiveFilter(st: FindState, immichAvailable: boolean): Filter {
  if (!serverPickers(st.search, immichAvailable)) return st.filter;
  const f = st.filter;
  return { ...NO_FILTER, minRating: f.minRating, takenFrom: f.takenFrom, takenTo: f.takenTo, kinds: f.kinds };
}

// ---- what each category is set to ------------------------------------

const RAW_ONLY = (kinds: string[]) => kinds.length === 1 && kinds[0] === "RAW";

// a category's value as plain data, for its chip: `values` are the
// chosen items (ids for Immich people/albums/tags, as the names are the
// server's), `flags` the named switches. Empty when unset
export type Setting = {
  stars?: number;
  rejected?: Filter["rejected"]; edited?: Filter["edited"]; labels?: number; unlabeled?: boolean;
  values?: string[];
  from?: string; to?: string;
  make?: string; model?: string; lens?: string; country?: string; city?: string;
  flags?: ("favorites" | "raw")[];
};

// what a category is set to in this state, or null when it is not on.
// `server` picks the server's fields for camera, lens and keywords
export function settingOf(key: CategoryKey, st: FindState, server: boolean): Setting | null {
  const { search: s, filter: f } = st;
  switch (key) {
    case "rating": {
      const stars = f.minRating || s.minRating;
      const local = !server;
      const on = stars > 0 || (local && (f.rejected !== "all" || f.labels !== 0 || f.unlabeled));
      return on ? { stars, ...(local ? { rejected: f.rejected, labels: f.labels, unlabeled: f.unlabeled } : {}) } : null;
    }
    case "edits":
      return f.edited !== "all" ? { edited: f.edited } : null;
    case "kinds":
      if (server) return s.rawOnly ? { flags: ["raw"] } : null;
      return f.kinds.length ? { values: f.kinds } : null;
    case "keywords":
      if (server) return s.tagIds.length ? { values: s.tagIds } : null;
      return f.keywords.length ? { values: f.keywords } : null;
    case "cameras":
      if (server) return s.make || s.model ? { make: s.make, model: s.model } : null;
      return f.cameras.length ? { values: f.cameras } : null;
    case "bodies":
      return f.bodies.length ? { values: f.bodies } : null;
    case "lenses":
      if (server) return s.lens ? { lens: s.lens } : null;
      return f.lenses.length ? { values: f.lenses } : null;
    case "exposure": {
      const values = EXPOSURE.flatMap((k) => f[k].map((v) => `${k}:${v}`));
      return values.length ? { values } : null;
    }
    case "taken": {
      const from = f.takenFrom || s.takenFrom, to = f.takenTo || s.takenTo;
      return from || to ? { from, to } : null;
    }
    case "place":
      return s.country || s.city ? { country: s.country, city: s.city } : null;
    case "people":
      return s.personIds.length ? { values: s.personIds } : null;
    case "albums":
      return s.albumIds.length ? { values: s.albumIds } : null;
    case "favorites":
      return s.favorites ? { flags: ["favorites"] } : null;
  }
}

// the state with one category cleared, on both halves where it writes both
export function clearCategory(st: FindState, key: CategoryKey): FindState {
  const s = st.search, f = st.filter;
  switch (key) {
    case "rating": return { search: { ...s, minRating: 0 },
                            filter: { ...f, minRating: 0, rejected: "all", labels: 0, unlabeled: false } };
    case "edits": return { search: s, filter: { ...f, edited: "all" } };
    case "kinds": return { search: { ...s, rawOnly: false }, filter: { ...f, kinds: [] } };
    case "keywords": return { search: { ...s, tagIds: [] }, filter: { ...f, keywords: [] } };
    case "cameras": return { search: { ...s, make: "", model: "", lens: "" }, filter: { ...f, cameras: [] } };
    case "bodies": return { search: s, filter: { ...f, bodies: [] } };
    case "lenses": return { search: { ...s, lens: "" }, filter: { ...f, lenses: [] } };
    case "exposure": return { search: s, filter: { ...f, ...Object.fromEntries(EXPOSURE.map((k) => [k, []])) } };
    case "taken": return { search: { ...s, takenFrom: "", takenTo: "" }, filter: { ...f, takenFrom: "", takenTo: "" } };
    case "place": return { search: { ...s, country: "", city: "" }, filter: f };
    case "people": return { search: { ...s, personIds: [] }, filter: f };
    case "albums": return { search: { ...s, albumIds: [] }, filter: f };
    case "favorites": return { search: { ...s, favorites: false }, filter: f };
  }
}

// Clear all: every category and the search words, keeping where and how
// the search looks (source, scope, smart or file name)
export function clearAll(st: FindState): FindState {
  const r = CATEGORIES.reduce((acc, c) => clearCategory(acc, c.key), st);
  return { ...r, search: { ...r.search, text: "" } };
}

// ---- rows that write both halves -------------------------------------

// the minimum rating, on the folder filter and the server search alike
export const setStars = (st: FindState, n: number): FindState =>
  ({ search: { ...st.search, minRating: n }, filter: { ...st.filter, minRating: n } });

export const setTaken = (st: FindState, from: string, to: string): FindState =>
  ({ search: { ...st.search, takenFrom: from, takenTo: to }, filter: { ...st.filter, takenFrom: from, takenTo: to } });

// the file types: the server can narrow only to RAW, so it does when RAW is
// the one ticked; with others ticked too `passes` sorts the results by name
export const setKinds = (st: FindState, kinds: string[]): FindState =>
  ({ search: { ...st.search, rawOnly: RAW_ONLY(kinds) }, filter: { ...st.filter, kinds } });

// a File type tick: All RAW stands for every raw extension, so ticking it
// drops the raw extensions already ticked, and ticking one of them while All
// RAW is ticked narrows to it
export function pickKinds(prev: string[], next: string[]): string[] {
  const raw = (k: string) => k !== "RAW" && fileKind(`.${k}`) === "RAW";
  if (!next.includes("RAW")) return next;
  if (!prev.includes("RAW")) return next.filter((k) => !raw(k));
  return next.some((k) => raw(k) && !prev.includes(k)) ? next.filter((k) => k !== "RAW") : next;
}

// the server's RAW switch for an Immich-only search, kept in step with the
// file types so a change of source keeps the meaning
export const setRawOnly = (st: FindState, on: boolean): FindState =>
  ({ search: { ...st.search, rawOnly: on }, filter: { ...st.filter, kinds: on ? ["RAW"] : [] } });

// the toolbar and the popup set these through the folder Filter; mirror the
// fields both halves share into the search so the two never disagree
export function withFilter(st: FindState, f: Filter): FindState {
  return { filter: f, search: { ...st.search, minRating: f.minRating, takenFrom: f.takenFrom, takenTo: f.takenTo,
                                 rawOnly: RAW_ONLY(f.kinds) } };
}

// ---- chips -----------------------------------------------------------

// one filter that is on, as a removable chip. `excludes` names the source
// a Both search loses to it: a server-only field matches no photo on this
// computer, and a local-only one no Immich result
export type Chip = { key: CategoryKey; setting: Setting; excludes: "local" | "immich" | null };

// local-only fields Immich results cannot be checked against: remoteFieldsKnown
const dropsImmich = (key: CategoryKey, st: FindState) => {
  const f = st.filter;
  if (key === "rating") return f.rejected !== "all" || f.labels !== 0 || f.unlabeled;
  return key === "edits" || key === "bodies" || key === "keywords";
};

export function chips(st: FindState, immichAvailable: boolean): Chip[] {
  const r = reach(st.search, immichAvailable);
  const server = r.immich && !r.local;
  const both = r.immich && r.local;
  return visibleCategories(st.search, immichAvailable).flatMap((c) => {
    const setting = settingOf(c.key, st, server);
    if (!setting) return [];
    const excludes = !both ? null : c.only === "immich" ? "local" : dropsImmich(c.key, st) ? "immich" : null;
    return [{ key: c.key, setting, excludes }];
  });
}

// how many filters are on, for the toolbar's Find button
export const findCount = (st: FindState, immichAvailable: boolean) => chips(st, immichAvailable).length;

// ---- saved filters ---------------------------------------------------

export type SavedFilter = { id: string; name: string; state: FindState };

// a state as plain data in a fixed order, lists sorted, so two that find
// the same photos compare equal however they were reached; fields the saved
// filter does not mean (a source's leftover scope) are kept, as they come
// back when the source is switched
function canonical(st: FindState): unknown {
  const sort = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).sort().map((k) => {
    const v = o[k];
    return [k, Array.isArray(v) ? [...v].sort() : v];
  }));
  return { search: sort({ ...NO_SEARCH, ...st.search, text: st.search.text.trim() }), filter: sort({ ...NO_FILTER, ...st.filter }) };
}

export const sameFind = (a: FindState, b: FindState) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// a stored state, filled out with today's fields, so a filter saved by an
// older version still opens
export function normalizeFind(v: unknown): FindState {
  const o = (v && typeof v === "object" ? v : {}) as Partial<FindState>;
  return { search: { ...NO_SEARCH, ...(o.search ?? {}) }, filter: { ...NO_FILTER, ...(o.filter ?? {}) } };
}
