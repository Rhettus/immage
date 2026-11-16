// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the toolbar's Filters button and the popup it opens above it: a list of
// what can be filtered by (file type, camera, lens, keywords, capture date
// and exposure, over the folder's photos) beside a panel of the options of
// the one chosen, taken with its Search. on Immich results the same popup
// holds the server search's filters instead, as only the server sees all
// of its photos
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { commands, type Named } from "./commands";
import { bodyLabel, EXPOSURE, facetsWithin, NO_FILTER, popupCount, rejectedOptions, type ExposureKey, type Facets, type Filter } from "./filter";
import type { ImageEntry } from "./library";
import { immichFilterCount, NO_SEARCH, type ImmichSearch } from "./immich";
import { formatDate, formatNumber, t } from "./i18n";

export type ImmichFilters = { form: ImmichSearch; update: (patch: Partial<ImmichSearch>, now?: boolean) => void };

// the least the popup takes; at least half the filmstrip's width too, and
// wider as what it shows needs
const LEAST = 560;

// where the popup sits, fixed to the window as the toolbar scrolls and
// would clip it: centered on the filmstrip, from above the button up to the
// top of the photo area at most, so it covers no side panel while it has
// the room
type At = { center: number; bottom: number; height: number; minWidth: number; maxWidth: number };
// the filmstrip's left and right, and the photo area's top
export type Bounds = { left: number; right: number; top: number };

export function FilterPopup({ filter: f, images, onFilter, immich, bounds, onSearch }: {
  filter: Filter; onFilter: (f: Filter) => void;
  images: ImageEntry[];                    // the folder's photos, to filter by what they hold
  immich: ImmichFilters | null;            // the grid shows Immich results
  bounds: () => Bounds | undefined;
  onSearch: () => void;                    // after Search, to show the grid
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // laid out again as the window or the panels beside it change size
  const [, relayout] = useState(0);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const resize = () => relayout((n) => n + 1);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);
  const count = immich ? immichFilterCount(immich.form) : popupCount(f);
  const searched = () => { setOpen(false); onSearch(); };
  const at = ((): At | null => {
    const r = open && button.current?.getBoundingClientRect();
    if (!r) return null;
    const b = bounds() ?? { left: 0, right: window.innerWidth, top: 0 };
    // past the filmstrip, over a panel, only when it is narrower than the
    // popup at its least
    const room = b.right - b.left - 16 >= LEAST ? b : { left: 0, right: window.innerWidth };
    const maxWidth = Math.max(LEAST, room.right - room.left - 16);
    return { center: (room.left + room.right) / 2, bottom: window.innerHeight - r.top + 6, maxWidth,
             height: Math.max(160, Math.min(560, r.top - 6 - b.top - 8)),
             minWidth: Math.min(maxWidth, Math.max(LEAST, (b.right - b.left) / 2)) };
  })();
  return (
    <div className="kind-filter" ref={box}>
      <button ref={button} className={`tool kind-button${count ? " on" : ""}`}
              title={t(immich ? "library.filters.immichTitle" : "library.filters.folderTitle")}
              onClick={() => setOpen(!open)}>{count ? t("library.filters.count", { count }) : t("library.filters.title")}</button>
      {/* over everything, as the toolbar's own layer sits under the side panels */}
      {at && createPortal(
        <div className="filter-pop" ref={pop}
             style={{ left: at.center, bottom: at.bottom, height: at.height, minWidth: at.minWidth, maxWidth: at.maxWidth }}>
          {immich ? <ImmichCategories {...immich} onSearch={searched} />
            : <FolderCategories filter={f} images={images} onFilter={onFilter} onSearch={searched} />}
        </div>, document.body)}
    </div>
  );
}

// one thing to filter by: its row in the popup, what it is set to there
// ("" when unset), and its options in the panel beside it
type Category<T> = {
  key: string; title: string; summary: (v: T) => string;
  clear: Partial<T>;
  body: (v: T, set: (patch: Partial<T>) => void) => React.ReactNode;
};

// the popup's rows, and the panel of the one chosen. the rows and panel
// work on a copy, which Search (or Enter in a field) takes, Clear and
// Clear all too
function Categories<T>({ title, value, none, apply, cats, onSearch }: {
  title: string; value: T; none: T; apply: (v: T) => void;
  cats: Category<T>[]; onSearch: () => void;
}) {
  const [shown, setShown] = useState(cats[0].key);
  const [draft, setDraft] = useState(value);
  // read by Search right after a field takes what was typed into it
  const draftRef = useRef(value);
  const set = (patch: Partial<T>) => { draftRef.current = { ...draftRef.current, ...patch }; setDraft(draftRef.current); };
  const cat = cats.find((c) => c.key === shown) ?? cats[0];
  const search = () => { apply(draftRef.current); onSearch(); };
  // one panel, as Preferences: the rows down the left, the chosen one's
  // options beside them
  return (
    <>
      <nav className="filter-nav">
        <h2>{title}</h2>
        {cats.map((c) => <Row key={c.key} title={c.title} summary={c.summary(draft)} shown={shown === c.key}
                              onClick={() => setShown(c.key)} />)}
      </nav>
      <div className="filter-pane"
           onKeyDown={(e) => {
             if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") search();
           }}>
        <h3>{cat.title}</h3>
        <div className="filter-body">{cat.body(draft, set)}</div>
        <div className="filter-foot">
          <button className="btn small clear-all" title={t("library.filters.clearAll")} disabled={!cats.some((c) => c.summary(draft))}
                  onClick={() => set(none)}>{t("library.filters.clearAll")}</button>
          <button className="btn small" title={t("library.filters.clearCategory", { category: cat.title })} disabled={!cat.summary(draft)}
                  onClick={() => set(cat.clear)}>{t("library.filters.clear")}</button>
          <button className="btn small primary" onClick={search}>{t("library.filters.search")}</button>
        </div>
      </div>
    </>
  );
}

// a row to choose, with what it is set to
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

function FolderCategories({ filter: f, images, onFilter, onSearch }: {
  filter: Filter; images: ImageEntry[]; onFilter: (f: Filter) => void; onSearch: () => void;
}) {
  const within = (v: Filter, clear: Partial<Filter>) => facetsWithin(images, v, clear);
  const cats: Category<Filter>[] = [
    { key: "rejected", title: t("library.filters.rejected"), summary: (v) => v.rejected === "all" ? "" : v.rejected === "hide" ? t("library.filters.hidden") : t("library.filters.onlyRejected"),
      clear: { rejected: "all" },
      body: (v, set) => {
        const labels = { all: t("library.search.allPhotos"), hide: t("library.filters.hideRejected"), only: t("library.filters.rejected") };
        const options = rejectedOptions(images, v).map((o) => ({ ...o, label: labels[o.value] }));
        return (
          <div className="filter-ticks">
            {options.map(({ value, label, count }) => (
              <button key={value} className={v.rejected === value ? "on" : ""}
                      aria-pressed={v.rejected === value} onClick={() => set({ rejected: value })}>
                <span className="tick">{v.rejected === value ? "✓" : ""}</span>
                <span className="name">{label}</span>
                <span className="count">{formatNumber(count)}</span>
              </button>
            ))}
          </div>
        );
      } },
    { key: "kinds", title: t("library.filters.fileType"), summary: (v) => chosen(v.kinds), clear: { kinds: [] },
      body: (v, set) => <Ticks items={within(v, { kinds: [] }).kinds} chosen={v.kinds} onChange={(kinds) => set({ kinds })} empty={t("library.filters.noPhotos")} /> },
    { key: "cameras", title: t("library.filters.camera"), summary: (v) => chosen(v.cameras), clear: { cameras: [] },
      body: (v, set) => <Ticks items={within(v, { cameras: [] }).cameras} chosen={v.cameras} onChange={(cameras) => set({ cameras })}
                               empty={t("library.filters.noneRecorded")} /> },
    { key: "bodies", title: t("library.filters.cameraBody"), summary: (v) => chosen(v.bodies, bodyLabel), clear: { bodies: [] },
      body: (v, set) => <div className="filter-bodies">
        <Ticks items={within(v, { bodies: [] }).bodies} chosen={v.bodies} onChange={(bodies) => set({ bodies })}
               show={bodyLabel} empty={t("library.filters.noPhotos")} find={t("library.filters.findModelSerial")} />
        <p className="hint">{t("library.filters.bodyHint")}</p>
      </div> },
    { key: "lenses", title: t("library.filters.lens"), summary: (v) => chosen(v.lenses), clear: { lenses: [] },
      body: (v, set) => <Ticks items={within(v, { lenses: [] }).lenses} chosen={v.lenses} onChange={(lenses) => set({ lenses })}
                               empty={t("library.filters.noneRecorded")} /> },
    { key: "keywords", title: t("library.keywording.title"), summary: (v) => chosen(v.keywords, keyword), clear: { keywords: [] },
      // every one ticked, and a keyword covers those under it
      body: (v, set) => <Ticks items={within(v, { keywords: [] }).keywords} chosen={v.keywords} onChange={(keywords) => set({ keywords })}
                               show={keyword} empty={t("library.keywording.none")} find={t("library.filters.findKeyword")} /> },
    { key: "taken", title: t("library.filters.captured"), summary: (v) => dates(v.takenFrom, v.takenTo), clear: { takenFrom: "", takenTo: "" },
      body: (v, set) => <Captured from={v.takenFrom} to={v.takenTo} months={within(v, { takenFrom: "", takenTo: "" }).months}
                                  onChange={(takenFrom, takenTo) => set({ takenFrom, takenTo })} /> },
    { key: "exposure", title: t("library.filters.exposure"),
      summary: (v) => EXPOSURE.filter((k) => v[k].length).map((k) => EXPOSURE_LABEL[k]).join(", "),
      clear: Object.fromEntries(EXPOSURE.map((k) => [k, []])),
      body: (v, set) => <Exposure v={v} set={set} within={(clear) => within(v, clear)} /> },
  ];
  return (
    <Categories title={t("library.filters.title")} value={f} apply={onFilter} cats={cats} onSearch={onSearch}
                none={{ ...NO_FILTER, minRating: f.minRating, edited: f.edited, labels: f.labels,
                        unlabeled: f.unlabeled }} />
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

// the Immich search's filters, which the Immich card's words and library
// go with; each list is the server's, asked for as the popup opens
function ImmichCategories({ form, update, onSearch }: ImmichFilters & { onSearch: () => void }) {
  const [people, setPeople] = useState<Named[]>([]);
  const [tags, setTags] = useState<Named[]>([]);
  const [albums, setAlbums] = useState<Named[]>([]);
  // a key without the permission for one just leaves it empty
  useEffect(() => {
    commands.immichPeople().then(setPeople).catch(() => {});
    commands.immichTags().then(setTags).catch(() => {});
    commands.immichAlbums().then(setAlbums).catch(() => {});
  }, []);
  const names = (all: Named[]) => (id: string) => all.find((x) => x.id === id)?.name ?? "…";
  const cats: Category<ImmichSearch>[] = [
    { key: "taken", title: t("library.filters.captured"), summary: (v) => dates(v.takenFrom, v.takenTo), clear: { takenFrom: "", takenTo: "" },
      body: (v, set) => <Captured from={v.takenFrom} to={v.takenTo} months={null}
                                  onChange={(takenFrom, takenTo) => set({ takenFrom, takenTo })} /> },
    { key: "only", title: t("library.filters.showOnly"),
      summary: (v) => [v.favorites && t("library.filters.favorites"), v.rawOnly && "RAW"].filter(Boolean).join(", "),
      clear: { favorites: false, rawOnly: false },
      body: (v, set) => (
        <div className="meta-grid filter-immich">
          <span className="k">{t("library.filters.favorites")}</span>
          <input type="checkbox" className="switch" checked={v.favorites} onChange={(e) => set({ favorites: e.target.checked })} />
          <span className="k">RAW</span>
          <input type="checkbox" className="switch" checked={v.rawOnly} onChange={(e) => set({ rawOnly: e.target.checked })} />
        </div>
      ) },
    { key: "camera", title: t("library.filters.camera"), summary: (v) => [v.make, v.model, v.lens].filter(Boolean).join(", "),
      clear: { make: "", model: "", lens: "" }, body: (v, set) => <Camera v={v} set={set} /> },
    { key: "keywords", title: t("library.keywording.title"), summary: (v) => chosen(v.tagIds, names(tags)), clear: { tagIds: [] },
      body: (v, set) => ids(tags, v.tagIds, (tagIds) => set({ tagIds }), t("library.filters.noTags")) },
    { key: "people", title: t("library.filters.people"), summary: (v) => chosen(v.personIds, names(people)), clear: { personIds: [] },
      body: (v, set) => ids(people, v.personIds, (personIds) => set({ personIds }), t("library.filters.noPeople")) },
    { key: "albums", title: t("library.filters.albums"), summary: (v) => chosen(v.albumIds, names(albums)), clear: { albumIds: [] },
      body: (v, set) => ids(albums, v.albumIds, (albumIds) => set({ albumIds }), t("library.filters.noAlbums")) },
    { key: "place", title: t("library.filters.place"), summary: (v) => [v.city, v.country].filter(Boolean).join(", "),
      clear: { country: "", city: "" }, body: (v, set) => <Place v={v} set={set} /> },
  ];
  return (
    <Categories title={t("library.filters.immichSearch")} value={form} apply={(v) => update(v, true)} cats={cats}
                onSearch={onSearch}
                none={{ ...NO_SEARCH, mode: form.mode, text: form.text, library: form.library, minRating: form.minRating, source: form.source, scope: form.scope, subject: form.subject }} />
  );
}
