// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the editors Find's accordion opens under a filter's row: one per category
// (stars and labels, file types, keywords, Exposure, capture dates, the Immich
// pickers, ...). Each writes through findModel.ts's functions, as the Filters
// popup's bodies did; the facets they list are computed when one is open.
// FindFilters.tsx draws the rows, FindPanel.tsx the panel
import { Flag } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type Named } from "./commands";
import { aspectRatio, bodyLabel, dateOfBound, EXPOSURE, facetsWithin, ORIENTATIONS, rejectedOptions, TEXT_FIELDS, timeOfBound,
         type ExposureKey, type Facets, type Filter, type GpsFilter, type Orientation, type TextField } from "./filter";
import { MOST_USED, shownValues, type LibraryFacets } from "./libraryFacets";
import { pickKinds, setKinds, setRawOnly, setStars, setTaken, type CategoryKey, type FindState } from "./findModel";
import { StarIcon } from "./icons";
import { fileKind, LABEL_COLORS, PICK_KEYWORD, type ImageEntry } from "./library";
import type { ImmichSearch } from "./immich";
import { formatDate, formatNumber, t } from "./i18n";

// values to tick, any of them, with how many photos have each; a long list
// scrolls in its own box (CSS) and gets a box to find one in. Past MOST_USED
// values only the most used are drawn, with the chosen ones, and the box finds
// the rest in the whole list. `byName`: the items are not in the reader's
// order (the library's lists come in code point order), so what is drawn is
// sorted by name here
export function Ticks({ items, chosen, onChange, show = (v) => v, empty, find, counts = true, indent, byName, busy }: {
  items: [string, number][]; chosen: string[]; onChange: (v: string[]) => void;
  show?: (v: string) => string; empty: string;
  find?: string;                           // the find box's placeholder
  counts?: boolean;
  indent?: (v: string) => boolean;         // rows set in under the one before
  byName?: boolean;
  busy?: boolean;                          // new values are on their way
}) {
  const [words, setWords] = useState("");
  const w = words.trim().toLowerCase();
  const { shown, cut } = shownValues(items, chosen, w, show, !!byName);
  const all = shown;
  return (
    <>
      {find && items.length > 8 && (
        <input className="field find" type="search" spellCheck={false} placeholder={find} aria-label={find} value={words}
               onChange={(e) => setWords(e.target.value)} />
      )}
      <div className="filter-ticks" aria-busy={busy || undefined}>
        {all.map(([v, n]) => (
          <button key={v} role="checkbox" aria-checked={chosen.includes(v)} className={`${chosen.includes(v) ? "on" : ""}${indent?.(v) ? " indent" : ""}`}
                  onClick={() => onChange(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v])}>
            <span className="tick" aria-hidden="true">{chosen.includes(v) ? "✓" : ""}</span><span className="name" title={show(v)}>{show(v)}</span>
            {counts && <span className="count">{formatNumber(n)}</span>}</button>
        ))}
        {!all.length && <div className="empty">{w ? t("library.filters.noMatch") : empty}</div>}
        {cut && <div className="empty" role="note">{t("library.filters.mostUsedOnly")}</div>}
      </div>
    </>
  );
}

export const EXPOSURE_LABEL: Record<ExposureKey, string> = { iso: "ISO", aperture: t("library.filters.aperture"),
                                                            focal: t("library.filters.focalLength"), shutter: t("library.filters.shutterSpeed") };

// a list's summary: its one value, or how many
export const chosen = (v: string[], name: (x: string) => string = (x) => x) =>
  v.length === 1 ? name(v[0]) : v.length ? t("library.filters.chosen", { count: v.length }) : "";
export const keyword = (k: string) => k.split("|").join(" › ");

type List = (key: keyof Facets, clear: Partial<Filter>) => [string, number][];

// the exposure settings as tabs, and the values of the one chosen under them
function Exposure({ v, set, list, byName, busy }: {
  v: Filter; set: (p: Partial<Filter>) => void; list: List; byName: boolean; busy: boolean;
}) {
  const [shown, setShown] = useState<ExposureKey>("iso");
  return (
    <>
      <div className="segmented small fe-tabs" role="group" aria-label={t("library.filters.exposure")}>
        {EXPOSURE.map((k) => (
          <button key={k} className={shown === k ? "active" : ""} aria-pressed={shown === k}
                  aria-label={v[k].length ? t("library.find.tabSet", { name: EXPOSURE_LABEL[k] }) : undefined}
                  onClick={() => setShown(k)}>
            {EXPOSURE_LABEL[k]}{v[k].length > 0 && <span className="fe-mark" aria-hidden="true" />}
          </button>
        ))}
      </div>
      <Ticks key={shown} items={list(shown, { [shown]: [] })} chosen={v[shown]} onChange={(x) => set({ [shown]: x })}
             empty={t("library.filters.noneRecorded")} find={t("library.filters.findSetting")} byName={byName} busy={busy} />
    </>
  );
}

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
const boundLabel = (bound: string) => {
  const time = timeOfBound(bound);
  const date = new Date(`${dateOfBound(bound)}T${time || "00:00"}:00Z`);
  return Number.isNaN(date.valueOf()) ? bound
    : formatDate(date, { dateStyle: "medium", timeStyle: time ? "short" : undefined, timeZone: "UTC" });
};
// a span by its name where it has one
export const dates = (from: string, to: string) => {
  if (!from && !to) return "";
  const named = recent().find((s) => same(s, from, to))
    ?? (/^\d{4}-01-01$/.test(from) && same(yearSpan(from.slice(0, 4)), from, to) ? yearSpan(from.slice(0, 4)) : undefined)
    ?? (/-01$/.test(from) && same(monthSpan(from.slice(0, 7)), from, to) ? monthSpan(from.slice(0, 7)) : undefined);
  return named ? named.label : from && to ? `${boundLabel(from)} – ${boundLabel(to)}`
    : from ? t("library.filters.fromDate", { date: boundLabel(from) }) : t("library.filters.toDate", { date: boundLabel(to) });
};

export const gpsLabel = (v: GpsFilter) => v === "any" ? t("library.filters.any")
  : v === "has" ? t("library.filters.hasGps") : t("library.filters.noGps");

export function textFieldLabel(field: TextField): string {
  switch (field) {
    case "any": return t("library.filters.allTextFields");
    case "title": return t("dialogs.metadata.field.title");
    case "description": return t("dialogs.metadata.field.caption");
    case "creator": return t("dialogs.metadata.field.creator");
    case "publisher": return t("library.filters.publisher");
    case "rights": return t("dialogs.metadata.field.copyright");
    case "notes": return t("library.filters.notes");
    case "version_name": return t("library.filters.versionName");
  }
}

export const orientationLabel = (v: Orientation) => {
  switch (v) {
    case "landscape": return t("dialogs.print.orientation.landscape");
    case "portrait": return t("dialogs.print.orientation.portrait");
    case "square": return t("library.filters.square");
  }
};

const RATIOS = ["1:1", "5:4", "4:3", "3:2", "16:9"];
export const ratioLabel = (v: string) => v.split(":").map((n) => formatNumber(Number(n))).join(":");
type DimensionKey = "width" | "height" | "minMegapixels" | "maxMegapixels";
const dimensionKeys: DimensionKey[] = ["width", "height", "minMegapixels", "maxMegapixels"];
export const dimensionLabel = (key: DimensionKey) => {
  switch (key) {
    case "width": return t("library.filters.pixelWidth");
    case "height": return t("library.filters.pixelHeight");
    case "minMegapixels": return t("library.filters.minMegapixels");
    case "maxMegapixels": return t("library.filters.maxMegapixels");
  }
};

function Geometry({ filter, set }: { filter: Filter; set: (p: Partial<Filter>, now?: boolean) => void }) {
  const [custom, setCustom] = useState("");
  const ratio = aspectRatio(custom);
  const addRatio = () => {
    if (!ratio) return;
    if (!filter.aspectRatios.includes(ratio)) set({ aspectRatios: [...filter.aspectRatios, ratio] });
    setCustom("");
  };
  return (
    <>
      <div className="fe-sec">
        <div className="fe-label">{t("library.filters.orientation")}</div>
        <div className="segmented small" role="group" aria-label={t("library.filters.orientation")}>
          {ORIENTATIONS.map((v) => {
            const active = filter.orientations.includes(v);
            return <button key={v} className={active ? "active" : ""} aria-pressed={active}
                           onClick={() => set({ orientations: active ? filter.orientations.filter((o) => o !== v) : [...filter.orientations, v] })}>
              {orientationLabel(v)}
            </button>;
          })}
        </div>
      </div>
      <div className="fe-sec">
        <div className="fe-label">{t("library.filters.aspectRatio")}</div>
        <Ticks items={[...new Set([...RATIOS, ...filter.aspectRatios])].map((v) => [v, 0])} chosen={filter.aspectRatios}
               onChange={(aspectRatios) => set({ aspectRatios })} show={ratioLabel} empty="" counts={false} />
        <div className="filter-custom-ratio">
          <input className="field" aria-label={t("library.filters.customAspectRatio")} placeholder={t("library.filters.customAspectRatio")}
                 value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => {
                   if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
                   e.stopPropagation();
                   addRatio();
                 }} />
          <button className="btn" type="button" disabled={!ratio} onClick={addRatio}>{t("library.filters.addAspectRatio")}</button>
        </div>
      </div>
      <div className="fe-sec meta-grid">
        {dimensionKeys.map((key) => {
          const pixels = key === "width" || key === "height";
          return (
            <label className="filter-field-pair" key={key}>
              <span>{dimensionLabel(key)}</span>
              <input className="field" type="number" min={0} max={pixels ? 4294967295 : undefined}
                     step={pixels ? 1 : "any"} value={filter[key] || ""}
                     onChange={(e) => {
                       if (e.target.validity.valid) set({ [key]: e.target.valueAsNumber || 0 }, false);
                     }} />
            </label>
          );
        })}
      </div>
    </>
  );
}

// the capture dates: typed, or picked from recent spans, years and the
// months of the year picked. `months` are those the photos hold, with
// counts; without them (Immich), the last ten years and every month
function Captured({ from, to, months, onChange }: {
  from: string; to: string; months: [string, number][] | null; onChange: (from: string, to: string) => void;
}) {
  const dateFrom = dateOfBound(from), dateTo = dateOfBound(to);
  const timeFrom = timeOfBound(from), timeTo = timeOfBound(to);
  const bound = (date: string, time: string) => date && time ? `${date}T${time}` : date;
  const selectedFrom = months ? from : dateFrom, selectedTo = months ? to : dateTo;
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
    <button key={s.label} role="checkbox" aria-checked={same(s, selectedFrom, selectedTo)} className={`${same(s, selectedFrom, selectedTo) ? "on" : ""}${indent ? " indent" : ""}`}
            onClick={() => (same(s, selectedFrom, selectedTo) ? onChange("", "") : onChange(s.from, s.to))}>
      <span className="tick" aria-hidden="true">{same(s, selectedFrom, selectedTo) ? "✓" : ""}</span><span className="name">{s.label}</span>
      {n !== null && <span className="count">{formatNumber(n)}</span>}</button>
  );
  return (
    <>
      <div className="filter-range">
        <input className="field" type="date" aria-label={t("library.filters.from")} value={dateFrom}
               onChange={(e) => onChange(bound(e.target.value, months ? timeFrom : ""), to)} />
        <span>{t("library.filters.to")}</span>
        <input className="field" type="date" aria-label={t("library.filters.through")} value={dateTo}
               onChange={(e) => onChange(from, bound(e.target.value, months ? timeTo : ""))} />
        {months && <>
          <input className="field" type="time" aria-label={t("library.filters.fromTime")} value={timeFrom} disabled={!dateFrom}
                 onChange={(e) => onChange(bound(dateFrom, e.target.value.slice(0, 5)), to)} />
          <span aria-hidden="true" />
          <input className="field" type="time" aria-label={t("library.filters.toTime")} value={timeTo} disabled={!dateTo}
                 onChange={(e) => onChange(from, bound(dateTo, e.target.value.slice(0, 5)))} />
        </>}
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
      <select className="field" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
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
const ids = (all: Named[], picked: string[], onChange: (ids: string[]) => void, empty: string) => (
  <Ticks items={all.map((x) => [x.id, 0] as [string, number])} chosen={picked} onChange={onChange} empty={empty}
         show={(id) => all.find((x) => x.id === id)?.name ?? "…"} find={t("library.filters.find")} counts={false} />
);

const LABEL_NAMES = ["red", "yellow", "green", "blue", "purple"] as const;

// Rejected: three exclusive choices, as radios (arrows move between them)
function RejectedRadios({ images, f, patch }: { images: ImageEntry[]; f: Filter; patch: (p: Partial<Filter>) => void }) {
  const names = { all: t("library.search.allPhotos"), hide: t("library.filters.hideRejected"), only: t("library.filters.onlyRejected") };
  const opts = rejectedOptions(images, f);
  const move = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const at = opts.findIndex((o) => o.value === f.rejected);
    const next = opts[(at + d + opts.length) % opts.length];
    patch({ rejected: next.value });
    (e.currentTarget.querySelectorAll<HTMLElement>("[role=radio]")[opts.indexOf(next)])?.focus();
  };
  return (
    <div className="fe-radios" role="radiogroup" aria-label={t("library.filters.rejected")} onKeyDown={move}>
      {opts.map(({ value, count: n }) => (
        <button key={value} role="radio" aria-checked={f.rejected === value} tabIndex={f.rejected === value ? 0 : -1}
                className={f.rejected === value ? "on" : ""} onClick={() => patch({ rejected: value })}>
          <span className="fe-dot" aria-hidden="true" /><span className="name">{names[value]}</span>
          <span className="count">{formatNumber(n)}</span>
        </button>
      ))}
    </div>
  );
}

function Rating({ state, send, images, local }: {
  state: FindState; send: (n: FindState) => void; images: ImageEntry[]; local: boolean;
}) {
  const f = state.filter;
  const stars = f.minRating || state.search.minRating;
  const picked = f.keywords.includes(PICK_KEYWORD);
  const patch = (p: Partial<Filter>) => send({ ...state, filter: { ...f, ...p } });
  return (
    <>
      <div className="fe-sec">
        <div className="fe-stars" role="group" aria-label={t("library.find.minRating")}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={stars >= n ? "on" : ""} aria-label={t("library.toolbar.starsAndUp", { count: n })}
                    title={t("library.toolbar.starsAndUp", { count: n })} aria-pressed={stars === n}
                    onClick={() => send(setStars(state, stars === n ? 0 : n))}>
              <StarIcon filled={stars >= n} />
            </button>
          ))}
        </div>
      </div>
      {local && <>
        <div className="fe-sec">
          <div className="fe-swatches" role="group" aria-label={t("library.find.colorLabel")}>
            {LABEL_COLORS.map((c, k) => {
              const on = !!(f.labels & (1 << k)), name = t(`library.menu.label-${LABEL_NAMES[k]}`);
              return (
                <button key={c} className={on ? "on" : ""} aria-label={name} title={name} aria-pressed={on}
                        onClick={() => patch({ labels: f.labels ^ (1 << k) })}>
                  <i style={{ background: c }}>{on && <span aria-hidden="true">✓</span>}</i>
                </button>
              );
            })}
            <button className={f.unlabeled ? "on" : ""} aria-label={t("library.find.noLabel")} title={t("library.find.noLabel")}
                    aria-pressed={f.unlabeled} onClick={() => patch({ unlabeled: !f.unlabeled })}>
              <i className="none">{f.unlabeled && <span aria-hidden="true">✓</span>}</i>
            </button>
          </div>
        </div>
        <div className="fe-sec">
          <button type="button" className="fe-pick-filter" aria-pressed={picked}
                  onClick={() => patch({ keywords: picked
                    ? f.keywords.filter((keyword) => keyword !== PICK_KEYWORD) : [...f.keywords, PICK_KEYWORD] })}>
            <Flag aria-hidden="true" fill={picked ? "currentColor" : "none"} />
            {t("library.filters.picked")}
          </button>
          <div className="fe-label"><span>{t("library.filters.rejected")}</span></div>
          <RejectedRadios images={images} f={f} patch={patch} />
        </div>
      </>}
    </>
  );
}

export type EditorProps = {
  cat: CategoryKey;
  state: FindState;
  send: (next: FindState, now?: boolean) => void;
  images: ImageEntry[];
  local: boolean;        // this computer's photos are searched
  server: boolean;       // the server's pickers stand in for the folder's lists
  people: Named[]; tags: Named[]; albums: Named[];
  // Search in = All folders: the library's lists, which stand in for what the
  // loaded photos hold; `busy` while newer ones are on their way
  library?: LibraryFacets | null;
  busy?: boolean;
};

// the editor of one category; the facets it lists are worked out here, so
// only the one open is
export function FilterEditor({ cat, state, send, images, local, server, people, tags, albums, library, busy = false }: EditorProps) {
  const { search: s, filter: f } = state;
  const patchSearch = (p: Partial<ImmichSearch>) => send({ ...state, search: { ...s, ...p } });
  const patchFilter = (p: Partial<Filter>, now = true) => send({ ...state, filter: { ...f, ...p } }, now);
  // a list from the library when it has one, else from the photos shown
  const list: List = (key, clear) => library?.[key] ?? facetsWithin(images, f, clear)[key];
  const byName = !!library;
  switch (cat) {
    case "rating":
      return <Rating state={state} send={send} images={images} local={local} />;
    case "edits":
      return (
        <>
          <p className="fe-hint">{t("library.find.editStatusHint")}</p>
          <div className="segmented small" role="group" aria-label={t("library.find.editStatus")}>
            {(["all", "edited", "unedited"] as const).map((v) => (
              <button key={v} className={f.edited === v ? "active" : ""} aria-pressed={f.edited === v} onClick={() => patchFilter({ edited: v })}>
                {v === "all" ? t("library.filters.any") : v === "edited" ? t("library.find.editedOnly") : t("library.find.uneditedOnly")}
              </button>
            ))}
          </div>
        </>
      );
    case "kinds":
      return server
        ? <div className="meta-grid filter-immich">
            <span className="k">{t("library.find.rawOnly")}</span>
            <input type="checkbox" className="switch" aria-label={t("library.find.rawOnly")} checked={s.rawOnly}
                   onChange={(e) => send(setRawOnly(state, e.target.checked))} />
          </div>
        : <Ticks items={list("kinds", { kinds: [] })} chosen={f.kinds} onChange={(kinds) => send(setKinds(state, pickKinds(f.kinds, kinds)))}
                 show={(v) => v === "RAW" ? t("library.find.allRaw") : v} indent={(v) => v !== "RAW" && fileKind(`.${v}`) === "RAW"}
                 empty={t("library.filters.noPhotos")} />;
    case "keywords": {
      if (server) return ids(tags, s.tagIds, (tagIds) => patchSearch({ tagIds }), t("library.filters.noTags"));
      const items = list("keywords", { keywords: [] });
      const picked = f.keywords.includes(PICK_KEYWORD);
      return <Ticks items={items.filter(([value]) => value !== PICK_KEYWORD)} chosen={f.keywords.filter((value) => value !== PICK_KEYWORD)}
                    onChange={(keywords) => patchFilter({ keywords: picked ? [...keywords, PICK_KEYWORD] : keywords })}
                    show={keyword} empty={t("library.keywording.none")} find={t("library.filters.findKeyword")} byName={byName} busy={busy} />;
    }
    case "cameras":
      return server
        ? <Camera v={s} set={patchSearch} />
        : <Ticks items={list("cameras", { cameras: [] })} chosen={f.cameras} onChange={(cameras) => patchFilter({ cameras })}
                 empty={t("library.filters.noneRecorded")} find={t("library.filters.findCamera")} byName={byName} busy={busy} />;
    case "bodies":
      return (
        <div className="filter-bodies">
          <Ticks items={list("bodies", { bodies: [] })} chosen={f.bodies} onChange={(bodies) => patchFilter({ bodies })}
                 show={bodyLabel} empty={t("library.filters.noPhotos")} find={t("library.filters.findModelSerial")} byName={byName} busy={busy} />
          <p className="fe-hint after">{t("library.filters.bodyHint")}</p>
        </div>
      );
    case "lenses":
      return server
        ? <Camera v={s} set={patchSearch} />
        : <Ticks items={list("lenses", { lenses: [] })} chosen={f.lenses} onChange={(lenses) => patchFilter({ lenses })}
                 empty={t("library.filters.noneRecorded")} find={t("library.filters.findLens")} byName={byName} busy={busy} />;
    case "exposure":
      return <Exposure v={f} set={patchFilter} list={list} byName={false} busy={busy} />;
    case "taken":
      return <Captured from={f.takenFrom || s.takenFrom} to={f.takenTo || s.takenTo}
                       months={local ? list("months", { takenFrom: "", takenTo: "" }) : null}
                       onChange={(from, to) => send(setTaken(state, from, to))} />;
    case "gps":
      return (
        <div className="segmented small" role="group" aria-label={t("library.filters.gps")}>
          {(["any", "has", "none"] as const).map((gps) => (
            <button key={gps} className={f.gps === gps ? "active" : ""} aria-pressed={f.gps === gps}
                    onClick={() => patchFilter({ gps })}>{gpsLabel(gps)}</button>
          ))}
        </div>
      );
    case "geometry":
      return <Geometry filter={f} set={patchFilter} />;
    case "metadata":
      return (
        <div className="meta-grid filter-text-meta">
          <label className="filter-field-pair">
            <span>{t("library.filters.textField")}</span>
            <select className="field" value={f.textField} onChange={(e) => patchFilter({ textField: e.target.value as TextField })}>
              {TEXT_FIELDS.map((field) => <option key={field} value={field}>{textFieldLabel(field)}</option>)}
            </select>
          </label>
          <label className="filter-field-pair">
            <span>{t("library.filters.textContains")}</span>
            <input className="field" type="search" value={f.textQuery}
                   onChange={(e) => patchFilter({ textQuery: e.target.value }, false)}
                   onKeyDown={(e) => { if (e.code === "Enter" || e.code === "NumpadEnter") send(state); }} />
          </label>
        </div>
      );
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
          <input type="checkbox" className="switch" aria-label={t("library.filters.favorites")} checked={s.favorites}
                 onChange={(e) => patchSearch({ favorites: e.target.checked })} />
        </div>
      );
  }
}
