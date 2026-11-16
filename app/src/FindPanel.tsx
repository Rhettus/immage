// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Find popup: the words to search for, where to look, every filter as a
// removable chip, and the grouped list of what can be filtered by beside the
// options of the one chosen. In the grid view it is drawn `locked`, in place of
// the right-hand panel's contents, as the Dock body alone. Every change applies at once (the state is
// findModel.ts's; App.tsx runs it). The bodies of the categories (Ticks,
// Captured, Exposure, the Immich pickers) are those of the old Filters popup
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { commands, type Named } from "./commands";
import { bodyLabel, EXPOSURE, facetsWithin, rejectedOptions, type ExposureKey, type Facets, type Filter } from "./filter";
import {
  chips, clearAll, clearCategory, GROUPS, reach, searchIn, serverPickers, setKinds, setRawOnly, setStars, setTaken,
  settingOf, visibleCategories, withSearchIn, type CategoryKey, type FindState, type SearchIn, type Setting,
} from "./findModel";
import { StarIcon } from "./icons";
import type { ImageEntry } from "./library";
import { LABEL_COLORS } from "./library";
import type { ImmichSearch } from "./immich";
import { formatDate, formatNumber, t } from "./i18n";
import { loadLayout, placeRect, posFor, SIZES, storeLayout, STRIP_HEIGHT, type FindLayout, type FindSize } from "./findLayout";

// one thing to filter by in a row of the list: what it is set to ("" when unset)
function Row({ title, summary, shown, onClick }: { title: string; summary: string; shown: boolean; onClick: () => void }) {
  return (
    <button className={`filter-cat${shown ? " shown" : ""}${summary ? " on" : ""}`} onClick={onClick}>
      <span className="name">{title}</span>
      <span className="summary">{summary || t("library.filters.any")}</span>
    </button>
  );
}

// values to tick, any of them, with how many photos have each; a long
// list gets a box to find one in
function Ticks({ items, chosen, onChange, show = (v) => v, empty, find, counts = true }: {
  items: [string, number][]; chosen: string[]; onChange: (v: string[]) => void;
  show?: (v: string) => string; empty: string;
  find?: string;                           // the find box's placeholder
  counts?: boolean;
}) {
  const [words, setWords] = useState("");
  const w = words.trim().toLowerCase();
  // a chosen value the shown photos no longer have stays to untick
  const all: [string, number][] = [...chosen.filter((c) => !items.some(([v]) => v === c)).map((c) => [c, 0] as [string, number]),
                                    ...items].filter(([v]) => !w || show(v).toLowerCase().includes(w));
  return (
    <>
      {find && items.length > 8 && (
        <input className="field find" type="search" spellCheck={false} placeholder={find} value={words}
               onChange={(e) => setWords(e.target.value)} />
      )}
      <div className="filter-ticks">
        {all.map(([v, n]) => (
          <button key={v} className={chosen.includes(v) ? "on" : ""}
                  onClick={() => onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v])}>
            <span className="tick">{chosen.includes(v) ? "✓" : ""}</span><span className="name">{show(v)}</span>
            {counts && <span className="count">{formatNumber(n)}</span>}</button>
        ))}
        {!all.length && <div className="empty">{w ? t("library.filters.noMatch") : empty}</div>}
      </div>
    </>
  );
}

const EXPOSURE_LABEL: Record<ExposureKey, string> = { iso: "ISO", aperture: t("library.filters.aperture"), focal: t("library.filters.focalLength"),
                                                     shutter: t("library.filters.shutterSpeed") };

// the exposure settings as rows, and the values of the one chosen beside them
function Exposure({ v, set, within }: {
  v: Filter; set: (p: Partial<Filter>) => void; within: (clear: Partial<Filter>) => Facets;
}) {
  const [shown, setShown] = useState<ExposureKey>("iso");
  return (
    <div className="filter-split">
      <div className="filter-sub">
        {EXPOSURE.map((k) => <Row key={k} title={EXPOSURE_LABEL[k]} summary={chosen(v[k])} shown={shown === k}
                                  onClick={() => setShown(k)} />)}
      </div>
      <div className="filter-values">
        <Ticks key={shown} items={within({ [shown]: [] })[shown]} chosen={v[shown]} onChange={(x) => set({ [shown]: x })}
               empty={t("library.filters.noneRecorded")} />
      </div>
    </div>
  );
}

// a list's summary: its one value, or how many
const chosen = (v: string[], name: (x: string) => string = (x) => x) =>
  v.length === 1 ? name(v[0]) : v.length ? t("library.filters.chosen", { count: v.length }) : "";
const keyword = (k: string) => k.split("|").join(" › ");

// a span of capture dates, YYYY-MM-DD, "" for open
type Span = { label: string; from: string; to: string };
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const yearSpan = (y: string): Span => ({ label: y, from: `${y}-01-01`, to: `${y}-12-31` });
// "YYYY-MM"
const monthSpan = (ym: string): Span => {
  const [y, m] = ym.split("-").map(Number);
  return { label: formatDate(new Date(y, m - 1, 1), { month: "long", year: "numeric" }), from: `${ym}-01`, to: ymd(new Date(y, m, 0)) };
};
// counted back from today, which they include; open at the end, so a
// photo taken since still shows
function recent(): Span[] {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth();
  const ago = (days: number) => ymd(new Date(y, m, today.getDate() - days));
  return [
    { label: t("library.filters.today"), from: ymd(today), to: "" },
    { label: t("library.filters.lastDays", { count: 7 }), from: ago(6), to: "" },
    { label: t("library.filters.lastDays", { count: 30 }), from: ago(29), to: "" },
    { label: t("library.filters.lastDays", { count: 90 }), from: ago(89), to: "" },
    { label: t("library.filters.thisMonth"), from: ymd(new Date(y, m, 1)), to: "" },
    { label: t("library.filters.lastMonth"), from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) },
    { label: t("library.filters.thisYear"), from: `${y}-01-01`, to: "" },
    { label: t("library.filters.lastYear"), from: `${y - 1}-01-01`, to: `${y - 1}-12-31` },
  ];
}
const same = (s: Span, from: string, to: string) => s.from === from && s.to === to;
// a span by its name where it has one
const dates = (from: string, to: string) => {
  if (!from && !to) return "";
  const named = recent().find((s) => same(s, from, to))
    ?? (/^\d{4}-01-01$/.test(from) && same(yearSpan(from.slice(0, 4)), from, to) ? yearSpan(from.slice(0, 4)) : undefined)
    ?? (/-01$/.test(from) && same(monthSpan(from.slice(0, 7)), from, to) ? monthSpan(from.slice(0, 7)) : undefined);
  return named ? named.label : from && to ? `${from} – ${to}` : from ? t("library.filters.fromDate", { date: from }) : t("library.filters.toDate", { date: to });
};

// the capture dates: typed, or picked from recent spans, years and the
// months of the year picked. `months` are those the photos hold, with
// counts; without them (Immich), the last ten years and every month
function Captured({ from, to, months, onChange }: {
  from: string; to: string; months: [string, number][] | null; onChange: (from: string, to: string) => void;
}) {
  const now = new Date().getFullYear();
  const years: [string, number | null][] = months
    ? [...months.reduce((m, [ym, n]) => m.set(ym.slice(0, 4), (m.get(ym.slice(0, 4)) ?? 0) + n), new Map<string, number>())]
    : Array.from({ length: 10 }, (_, k) => [String(now - k), null]);
  // the year whose months show: the one the span lies in
  const year = from && from.slice(0, 4) === to.slice(0, 4) ? from.slice(0, 4) : null;
  const inYear: [string, number | null][] = !year ? []
    : months ? months.filter(([ym]) => ym.startsWith(year))
    : Array.from({ length: 12 }, (_, k) => [`${year}-${pad(k + 1)}`, null]);
  const row = (s: Span, n: number | null, indent = false) => (
    <button key={s.label} className={`${same(s, from, to) ? "on" : ""}${indent ? " indent" : ""}`}
            onClick={() => (same(s, from, to) ? onChange("", "") : onChange(s.from, s.to))}>
      <span className="tick">{same(s, from, to) ? "✓" : ""}</span><span className="name">{s.label}</span>
      {n !== null && <span className="count">{formatNumber(n)}</span>}</button>
  );
  return (
    <>
      <div className="filter-range">
        <input className="field" type="date" aria-label={t("library.filters.from")} value={from} onChange={(e) => onChange(e.target.value, to)} />
        <span>{t("library.filters.to")}</span>
        <input className="field" type="date" aria-label={t("library.filters.through")} value={to} onChange={(e) => onChange(from, e.target.value)} />
      </div>
      <div className="filter-ticks">
        <div className="filter-group">{t("library.filters.recent")}</div>
        {recent().map((s) => row(s, null))}
        <div className="filter-group">{t("library.filters.years")}</div>
        {years.map(([y, n]) => [row(yearSpan(y), n),
                                ...(y === year ? inYear.map(([ym, c]) => row(monthSpan(ym), c, true)) : [])])}
        {!years.length && <div className="empty">{t("library.filters.noDates")}</div>}
      </div>
    </>
  );
}

type Kind = "camera-make" | "camera-model" | "camera-lens-model" | "country" | "city";

// the server's values for a field, each narrowed by the fields before it
function useSuggestions(kind: Kind, within: Record<string, string>) {
  const [values, setValues] = useState<string[] | undefined>();
  const key = JSON.stringify(within);
  useEffect(() => {
    commands.immichSuggestions(kind, within).then(setValues).catch(() => {});
  }, [kind, key]);
  return values;
}

function Pick({ label, value, options, onChange }: {
  label: string; value: string; options: string[] | undefined; onChange: (v: string) => void;
}) {
  return (
    <>
      <span className="k">{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("library.filters.any")}</option>
        {/* a stored value the server no longer lists stays choosable */}
        {value && !options?.includes(value) && <option value={value}>{value}</option>}
        {options?.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </>
  );
}

function Camera({ v, set }: { v: ImmichSearch; set: (p: Partial<ImmichSearch>) => void }) {
  const makes = useSuggestions("camera-make", {});
  const models = useSuggestions("camera-model", { make: v.make });
  const lenses = useSuggestions("camera-lens-model", { make: v.make, model: v.model });
  return (
    <div className="meta-grid filter-immich">
      <Pick label={t("library.filters.make")} value={v.make} options={makes} onChange={(make) => set({ make, model: "", lens: "" })} />
      <Pick label={t("library.filters.model")} value={v.model} options={models} onChange={(model) => set({ model, lens: "" })} />
      <Pick label={t("library.filters.lens")} value={v.lens} options={lenses} onChange={(lens) => set({ lens })} />
    </div>
  );
}

function Place({ v, set }: { v: ImmichSearch; set: (p: Partial<ImmichSearch>) => void }) {
  const countries = useSuggestions("country", {});
  const cities = useSuggestions("city", { country: v.country });
  return (
    <div className="meta-grid filter-immich">
      <Pick label={t("library.filters.country")} value={v.country} options={countries} onChange={(country) => set({ country, city: "" })} />
      <Pick label={t("library.filters.city")} value={v.city} options={cities} onChange={(city) => set({ city })} />
    </div>
  );
}

// the server's named things to tick, as the folder's keywords are
const ids = (all: Named[], chosen: string[], onChange: (ids: string[]) => void, empty: string) => (
  <Ticks items={all.map((x) => [x.id, 0] as [string, number])} chosen={chosen} onChange={onChange} empty={empty}
         show={(id) => all.find((x) => x.id === id)?.name ?? "…"} find={t("library.filters.find")} counts={false} />
);

// ---- the popup (or, locked, the grid's side panel) -------------------------------------------------------

type Bounds = { left: number; right: number; top: number; bottom: number };

// the size buttons' pictures: a strip, a panel at the side, the whole area
const SIZE_ICON: Record<FindSize, React.ReactNode> = {
  minimize: <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="8.5" width="11" height="3" rx="1" fill="none" stroke="currentColor" /></svg>,
  dock: <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" /><rect x="8" y="2" width="4.5" height="10" fill="currentColor" /></svg>,
  fill: <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="1.5" width="11" height="11" rx="1.5" fill="currentColor" stroke="currentColor" /></svg>,
};

const GROUP_TITLE: Record<(typeof GROUPS)[number], () => string> = {
  photo: () => t("library.find.group.photo"), camera: () => t("library.find.group.camera"),
  when: () => t("library.find.group.when"), immich: () => t("library.find.group.immich"),
};

export function FindPanel({ state, onChange, images, immichAvailable, count, busy, notes, onShow, onClose, saved, savedLine,
                            onSaveNew, anchor, bounds, locked, focusToken, pin, smart, clipTip }: {
  state: FindState;
  // `now`: run at once (ticks, selects, Enter); otherwise App runs it after 400 ms (typing)
  onChange: (next: FindState, now?: boolean) => void;
  images: ImageEntry[];         // photos to list facets from (folder, or local results)
  immichAvailable: boolean;     // Immich configured
  smart: boolean;               // photo-content search can run (CLIP model or Immich); else file names only
  count: number | null;         // live result count, null while unknown
  busy: boolean;                // a search is running
  notes: string[];              // extra notes from App (e.g. Immich skipped)
  onShow: () => void;           // Show N: close and show the grid
  onClose: () => void;          // Escape / click away
  saved?: React.ReactNode;      // the Saved menu button, head row
  savedLine?: React.ReactNode;  // the saved-filter name line, above the chips
  onSaveNew?: () => void;       // footer Save filter…
  anchor: () => DOMRect | undefined;   // the toolbar Find button, to place the popup above
  bounds: () => Bounds | undefined;    // the grid area
  // the grid's right-hand panel: drawn in place, filling its container, at the dock's
  // full body, with no size buttons, grip or Escape/click-away closing
  locked?: boolean;
  clipTip?: { onSetUp: () => void; onDismiss: () => void };   // the tip about the CLIP model; none to hide it
  pin?: React.ReactNode;        // locked: the right panel's pin button (auto-hide), in the head row
  focusToken?: number;          // a change focuses the search box (the toolbar's Find button in the grid)
}) {
  const pop = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const text = useRef<HTMLInputElement>(null);
  const [, relayout] = useState(0);
  const [shown, setShown] = useState<CategoryKey>("rating");
  // the size last used, and where each size was dragged to
  const [layout, setLayout] = useState<FindLayout>(loadLayout);
  const size: FindSize = locked ? "dock" : layout.size;
  const rtl = document.dir === "rtl";
  const move = (next: FindLayout) => { setLayout(next); storeLayout(next); };
  const { search: s, filter: f } = state;
  const r = reach(s, immichAvailable);
  const server = serverPickers(s, immichAvailable);
  const cats = visibleCategories(s, immichAvailable);
  const cat = cats.find((c) => c.key === shown) ?? cats[0];
  const active = chips(state, immichAvailable);

  // Escape or a press outside closes it, the filters staying; presses in the
  // lists the selects open (portaled out of the popup) and on the toolbar's
  // button (which toggles it) are not outside
  useEffect(() => {
    if (locked) return;
    const away = (e: PointerEvent) => {
      const el = e.target as Element;
      // the save and manage dialogs App draws over it are not outside either
      if (pop.current?.contains(el) || el.closest?.(".select-menu, .context-menu, .modal-backdrop")) return;
      const a = anchorRef.current();
      if (a && e.clientX >= a.left && e.clientX <= a.right && e.clientY >= a.top && e.clientY <= a.bottom) return;
      close.current();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".select-menu, .context-menu, .modal-backdrop")) return;
      // the key is Find's: App's own Escape (leaving the grid, the preview) must not run too
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    const resize = () => relayout((n) => n + 1);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", resize);
    };
  }, []);

  useEffect(() => {
    if (!focusToken) return;
    text.current?.focus();
    text.current?.select();
  }, [focusToken]);

  // the server's names and libraries, once Immich is in the search; a key
  // without the permission for one just leaves it empty
  const [people, setPeople] = useState<Named[]>([]);
  const [tags, setTags] = useState<Named[]>([]);
  const [albums, setAlbums] = useState<Named[]>([]);
  const [libraries, setLibraries] = useState<Named[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!r.immich) return;
    commands.immichPeople().then(setPeople).catch(() => {});
    commands.immichTags().then(setTags).catch(() => {});
    commands.immichAlbums().then(setAlbums).catch(() => {});
    setError(null);
    commands.immichLibraries().then(setLibraries).catch((e) => setError(String(e)));
  }, [r.immich]);
  // what the key cannot do here: thumbnails and downloads take permissions
  // beyond the importer's asset.read; asked again after each search, so a
  // key fixed in Immich meanwhile clears it
  const [lacks, setLacks] = useState<string[]>([]);
  useEffect(() => {
    if (r.immich && !busy) commands.immichBrowseCheck().then(setLacks).catch(() => {});
  }, [r.immich, busy]);

  const send = (next: FindState, now = true) => onChange(next, now);
  const patchSearch = (p: Partial<ImmichSearch>) => send({ ...state, search: { ...s, ...p } });
  const patchFilter = (p: Partial<Filter>) => send({ ...state, filter: { ...f, ...p } });
  const within = (clear: Partial<Filter>) => facetsWithin(images, f, clear);
  const nameOf = (all: Named[]) => (id: string) => all.find((x) => x.id === id)?.name ?? "…";

  const title = (key: CategoryKey): string => {
    switch (key) {
      case "rating": return t("library.find.rating");
      case "kinds": return t("library.filters.fileType");
      case "keywords": return t("library.keywording.title");
      case "cameras": return t("library.filters.camera");
      case "bodies": return t("library.filters.cameraBody");
      case "lenses": return t("library.filters.lens");
      case "exposure": return t("library.filters.exposure");
      case "taken": return t("library.filters.captured");
      case "place": return t("library.filters.place");
      case "people": return t("library.filters.people");
      case "albums": return t("library.filters.albums");
      case "favorites": return t("library.filters.favorites");
    }
  };

  // what a category is set to, in words, for its row and its chip
  const describe = (key: CategoryKey, v: Setting): string => {
    const list = v.values ?? [];
    switch (key) {
      case "rating":
        return [v.stars ? t("library.toolbar.starsAndUp", { count: v.stars }) : "",
                v.rejected === "hide" ? t("library.filters.hideRejected") : v.rejected === "only" ? t("library.filters.onlyRejected") : "",
                v.edited === "edited" ? t("library.find.editedOnly") : v.edited === "unedited" ? t("library.find.uneditedOnly") : "",
                v.labels || v.unlabeled ? t("library.find.labelsSet") : ""].filter(Boolean).join(", ");
      case "kinds": return v.flags?.includes("raw") ? "RAW" : chosen(list);
      case "keywords": return chosen(list, server ? nameOf(tags) : keyword);
      case "cameras": return list.length ? chosen(list) : [v.make, v.model].filter(Boolean).join(" ");
      case "bodies": return chosen(list, bodyLabel);
      case "lenses": return list.length ? chosen(list) : v.lens ?? "";
      case "exposure": return EXPOSURE.filter((k) => f[k].length).map((k) => EXPOSURE_LABEL[k]).join(", ");
      case "taken": return dates(v.from ?? "", v.to ?? "");
      case "place": return [v.city, v.country].filter(Boolean).join(", ");
      case "people": return chosen(list, nameOf(people));
      case "albums": return chosen(list, nameOf(albums));
      case "favorites": return t("library.filters.favorites");
    }
  };
  const summary = (key: CategoryKey) => {
    const v = settingOf(key, state, server);
    return v ? describe(key, v) : "";
  };

  // the options of the chosen category
  const stars = f.minRating || s.minRating;
  const body = (key: CategoryKey): React.ReactNode => {
    switch (key) {
      case "rating": {
        const labels = { all: t("library.search.allPhotos"), hide: t("library.filters.hideRejected"), only: t("library.filters.rejected") };
        return (
          <div className="find-rating">
            <div className="find-sub">{t("library.find.minRating")}</div>
            <div className="find-stars stars-edit">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={stars >= n ? "on" : ""} title={t("library.toolbar.starsAndUp", { count: n })}
                        aria-pressed={stars >= n} onClick={() => send(setStars(state, stars === n ? 0 : n))}>
                  <StarIcon filled={stars >= n} />
                </button>
              ))}
            </div>
            {r.local && <>
              <div className="find-sub">{t("library.filters.rejected")}</div>
              <div className="filter-ticks">
                {rejectedOptions(images, f).map(({ value, count: n }) => (
                  <button key={value} className={f.rejected === value ? "on" : ""} aria-pressed={f.rejected === value}
                          onClick={() => patchFilter({ rejected: value })}>
                    <span className="tick">{f.rejected === value ? "✓" : ""}</span>
                    <span className="name">{labels[value]}</span>
                    <span className="count">{formatNumber(n)}</span>
                  </button>
                ))}
              </div>
              <div className="find-sub">{t("library.find.editStatus")}</div>
              <div className="segmented small find-edited">
                {(["all", "edited", "unedited"] as const).map((v) => (
                  <button key={v} className={f.edited === v ? "active" : ""} onClick={() => patchFilter({ edited: v })}>
                    {v === "all" ? t("library.filters.any") : v === "edited" ? t("library.find.editedOnly") : t("library.find.uneditedOnly")}
                  </button>
                ))}
              </div>
              <div className="find-sub">{t("library.culling.labels")}</div>
              <div className="find-labels">
                {LABEL_COLORS.map((c, k) => (
                  <button key={c} className={`swatch${f.labels & (1 << k) ? " on" : ""}`} style={{ background: c }}
                          title={t("library.toolbar.withLabel")} onClick={() => patchFilter({ labels: f.labels ^ (1 << k) })} />
                ))}
                <button className={`swatch${f.unlabeled ? " on" : ""}`} style={{ background: "#9ca3af" }}
                        title={t("library.toolbar.withoutLabel")} onClick={() => patchFilter({ unlabeled: !f.unlabeled })} />
              </div>
            </>}
          </div>
        );
      }
      case "kinds":
        return server
          ? <div className="meta-grid filter-immich">
              <span className="k">{t("library.find.rawOnly")}</span>
              <input type="checkbox" className="switch" checked={s.rawOnly} onChange={(e) => send(setRawOnly(state, e.target.checked))} />
            </div>
          : <Ticks items={within({ kinds: [] }).kinds} chosen={f.kinds} onChange={(kinds) => send(setKinds(state, kinds))}
                   empty={t("library.filters.noPhotos")} />;
      case "keywords":
        return server
          ? ids(tags, s.tagIds, (tagIds) => patchSearch({ tagIds }), t("library.filters.noTags"))
          // every one ticked, and a keyword covers those under it
          : <Ticks items={within({ keywords: [] }).keywords} chosen={f.keywords} onChange={(keywords) => patchFilter({ keywords })}
                   show={keyword} empty={t("library.keywording.none")} find={t("library.filters.findKeyword")} />;
      case "cameras":
        return server
          ? <Camera v={s} set={patchSearch} />
          : <Ticks items={within({ cameras: [] }).cameras} chosen={f.cameras} onChange={(cameras) => patchFilter({ cameras })}
                   empty={t("library.filters.noneRecorded")} />;
      case "bodies":
        return (
          <div className="filter-bodies">
            <Ticks items={within({ bodies: [] }).bodies} chosen={f.bodies} onChange={(bodies) => patchFilter({ bodies })}
                   show={bodyLabel} empty={t("library.filters.noPhotos")} find={t("library.filters.findModelSerial")} />
            <p className="hint">{t("library.filters.bodyHint")}</p>
          </div>
        );
      case "lenses":
        return server
          ? <Camera v={s} set={patchSearch} />
          : <Ticks items={within({ lenses: [] }).lenses} chosen={f.lenses} onChange={(lenses) => patchFilter({ lenses })}
                   empty={t("library.filters.noneRecorded")} />;
      case "exposure":
        return <Exposure v={f} set={patchFilter} within={within} />;
      case "taken":
        return <Captured from={f.takenFrom || s.takenFrom} to={f.takenTo || s.takenTo}
                         months={r.local ? within({ takenFrom: "", takenTo: "" }).months : null}
                         onChange={(from, to) => send(setTaken(state, from, to))} />;
      case "place":
        return <Place v={s} set={patchSearch} />;
      case "people":
        return ids(people, s.personIds, (personIds) => patchSearch({ personIds }), t("library.filters.noPeople"));
      case "albums":
        return ids(albums, s.albumIds, (albumIds) => patchSearch({ albumIds }), t("library.filters.noAlbums"));
      case "favorites":
        return (
          <div className="meta-grid filter-immich">
            <span className="k">{t("library.filters.favorites")}</span>
            <input type="checkbox" className="switch" checked={s.favorites} onChange={(e) => patchSearch({ favorites: e.target.checked })} />
          </div>
        );
    }
  };

  // inside the grid area, where the size and its dragged offset put it: always
  // clamped, so a smaller window or area never leaves it out of reach
  const area = bounds() ?? { left: 0, right: window.innerWidth, top: 0, bottom: window.innerHeight };
  const anchorTop = anchor()?.top;
  // the strip's height is its content's (a wrapped head is taller), so it is measured
  const [stripH, setStripH] = useState(STRIP_HEIGHT);
  useEffect(() => {
    const el = pop.current;
    if (size !== "minimize" || !el) return;
    const measure = () => setStripH(Math.max(1, Math.round(el.getBoundingClientRect().height)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);
  const at = placeRect(size, area, anchorTop, rtl, size === "fill" ? undefined : layout.pos[size], stripH);
  // the grip drags the strip and the dock; each keeps its own place
  const drag = (e: React.PointerEvent<HTMLElement>) => {
    if (size === "fill" || e.button !== 0) return;
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const grab = { x: e.clientX - at.left, y: e.clientY - at.top };
    const go = (m: PointerEvent) => {
      const b = bounds() ?? area;
      const to = posFor(size, b, anchor()?.top, rtl, { left: m.clientX - grab.x, top: m.clientY - grab.y }, stripH);
      setLayout((l) => ({ ...l, pos: { ...l.pos, [size]: to } }));
    };
    const up = () => {
      grip.removeEventListener("pointermove", go);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      setLayout((l) => { storeLayout(l); return l; });
    };
    grip.addEventListener("pointermove", go);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };
  const resetPos = () => { if (size !== "fill") move({ ...layout, pos: { ...layout.pos, [size]: undefined } }); };

  const notice = [
    ...(lacks.length > 0 && r.immich ? [t("library.search.missingPermissions", {
      permissions: lacks.join(", "),
      details: [lacks.includes("asset.view") ? t("library.search.thumbnailsPermission") : "",
        lacks.includes("asset.download") ? t("library.search.downloadPermission") : ""].filter(Boolean).join(", "),
      pronoun: lacks.length > 1 ? t("library.search.them") : t("library.search.it"),
    })] : []),
    ...(error && r.immich ? [error] : []),
    ...notes,
  ];

  const where = searchIn(s);
  const countText = <>
    {count === null ? "…" : t("library.find.count", { n: count, count: formatNumber(count) })}
    {busy && <span className="find-spin" role="status" aria-label={t("library.find.searching")} />}
  </>;
  const popup = (
    <div className={`find-pop${locked ? " locked" : ""}`} ref={pop} role="dialog" aria-label={t("library.find.title")}
         data-size={size}
         style={locked ? undefined : { left: at.left, top: at.top, width: at.width, ...(size === "minimize" ? {} : { height: at.height }) }}>
      <div className="find-head">
        <div className="find-row">
          {!locked && <span className="find-grip" aria-hidden="true" onPointerDown={drag} onDoubleClick={resetPos}>⠿</span>}
          <input className="field find-text" type="search" spellCheck={false} autoFocus={!locked} ref={text} value={s.text}
                 aria-label={t("library.search.title")}
                 placeholder={smart ? t("library.search.example") : t("library.search.filenameExample")}
                 onChange={(e) => send({ ...state, search: { ...s, text: e.target.value } }, false)}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") send(state, true);
                   // locked, Escape only leaves the box: the next one leaves the grid, as it does elsewhere
                   else if (e.key === "Escape" && locked) e.currentTarget.blur();
                 }} />
          {smart && <div className="segmented small" title={t("library.search.matchAgainst")}>
            <button className={s.mode === "smart" ? "active" : ""} title={t("library.search.photoContent")}
                    onClick={() => send({ ...state, search: { ...s, mode: "smart" } }, s.text.trim() !== "")}>{t("library.search.smart")}</button>
            <button className={s.mode === "filename" ? "active" : ""}
                    onClick={() => send({ ...state, search: { ...s, mode: "filename" } }, s.text.trim() !== "")}>{t("library.search.filename")}</button>
          </div>}
          {saved}
          {locked && pin}
          {size === "minimize" && <span className="find-count find-mincount">{countText}</span>}
          {!locked && <div className="find-sizes">
            {SIZES.map((z) => (
              <button key={z} className={`find-size find-size-${z}${size === z ? " on" : ""}`} aria-pressed={size === z}
                      title={t(`library.find.size.${z}`)} aria-label={t(`library.find.size.${z}`)}
                      onClick={() => move({ ...layout, size: z })}>{SIZE_ICON[z]}</button>
            ))}
          </div>}
        </div>
        {size !== "minimize" && clipTip && (
          <div className="find-tip" role="note">
            <span className="find-tip-text">{t("library.find.clipTip")}</span>
            <button className="btn small find-tip-setup" onClick={clipTip.onSetUp}>{t("library.find.clipTipSetUp")}</button>
            <button className="find-tip-close" aria-label={t("library.find.clipTipDismiss")} title={t("library.find.clipTipDismiss")}
                    onClick={clipTip.onDismiss}>×</button>
          </div>
        )}
        {size !== "minimize" && <div className="find-row find-where">
          <span className="find-where-label">{t("library.find.searchIn")}</span>
          <select className="field" aria-label={t("library.find.searchIn")} value={where}
                  onChange={(e) => send({ ...state, search: withSearchIn(s, e.target.value as SearchIn) })}>
            <option value="folder">{t("library.find.thisFolder")}</option>
            <option value="library">{t("library.find.allFolders")}</option>
            {immichAvailable && <><option value="immich">Immich</option><option value="both">{t("library.find.both")}</option></>}
          </select>
          {r.local && (
            <select className="field" aria-label={t("library.search.subject")} value={s.subject}
                    onChange={(e) => patchSearch({ subject: e.target.value as ImmichSearch["subject"] })}>
              <option value="original">{t("library.search.original")}</option>
              <option value="edited">{t("library.search.edited")}</option>
            </select>
          )}
          {r.immich && (
            <select className="field" value={s.library} title={t("library.search.immichLibrary")}
                    aria-label={t("library.search.immichLibrary")} onChange={(e) => patchSearch({ library: e.target.value })}>
              <option value="external">{t("library.search.externalLibraries")}</option>
              <option value="all">{t("library.search.allPhotos")}</option>
              {libraries.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
        </div>}
        {size !== "minimize" && savedLine}
        {size !== "minimize" && <div className="find-chips">
          {active.map((c) => {
            const text = describe(c.key, c.setting);
            const tip = c.excludes === "local" ? t("library.find.excludesLocal") : c.excludes === "immich" ? t("library.find.excludesImmich") : undefined;
            return (
              <span key={c.key} className={`find-chip${c.excludes ? " excludes" : ""}`} title={tip}>
                <span className="find-chip-cat">{title(c.key)}</span>
                {text && <span className="find-chip-text">{text}</span>}
                {c.excludes && <small className="find-chip-note">{c.excludes === "local" ? t("library.find.immichOnly") : t("library.find.localOnly")}</small>}
                <button aria-label={t("library.find.removeFilter", { category: title(c.key) })}
                        onClick={() => send(clearCategory(state, c.key))}>×</button>
              </span>
            );
          })}
          {!active.length && <span className="find-none">{t("library.find.noFilters")}</span>}
        </div>}
      </div>
      {size === "fill" && (
        <div className="find-all">
          {cats.map((c) => (
            <section key={c.key} className="find-pane">
              <div className="find-pane-head">
                <h3>{title(c.key)}</h3>
                {c.only === "immich" && <span className="find-tag">{t("library.find.group.immich")}</span>}
              </div>
              <div className="find-pane-body">{body(c.key)}</div>
            </section>
          ))}
        </div>
      )}
      {size === "dock" && <div className="find-body">
        <nav className="find-nav">
          {GROUPS.map((g) => {
            const rows = cats.filter((c) => c.group === g);
            return rows.length ? (
              <div key={g} className="find-group">
                <div className="find-group-title">{GROUP_TITLE[g]()}</div>
                {rows.map((c) => {
                  const sum = summary(c.key);
                  return (
                    <button key={c.key} className={`find-cat${cat.key === c.key ? " shown" : ""}${sum ? " on" : ""}`}
                            onClick={() => setShown(c.key)}>
                      <span className="name">{title(c.key)}</span>
                      {c.only === "immich" && <span className="find-tag">{t("library.find.group.immich")}</span>}
                      <span className="summary">{sum || t("library.filters.any")}</span>
                    </button>
                  );
                })}
              </div>
            ) : null;
          })}
        </nav>
        <div className="find-pane">
          <div className="find-pane-head">
            <h3>{title(cat.key)}</h3>
            {cat.only === "immich" && <span className="find-tag">{t("library.find.group.immich")}</span>}
          </div>
          <div className="find-pane-body" key={cat.key}>{body(cat.key)}</div>
        </div>
      </div>}
      {size !== "minimize" && notice.length > 0 && <div className="find-notes">{notice.map((n, i) => <div key={i} className="find-note">{n}</div>)}</div>}
      {size !== "minimize" && <div className="find-foot">
        <span className="find-count">{countText}</span>
        <button className="btn small find-clear-all" disabled={!active.length}
                onClick={() => send(clearAll(state))}>{t("library.filters.clearAll")}</button>
        {onSaveNew && <button className="btn small find-save" onClick={onSaveNew}>{t("library.find.saveFilter")}</button>}
        {!locked && <button className="btn small primary find-show" onClick={onShow}>
          {count === null ? t("library.find.show") : t("library.find.showCount", { n: count, count: formatNumber(count) })}
        </button>}
      </div>}
    </div>
  );
  return locked ? popup : createPortal(popup, document.body);
}
