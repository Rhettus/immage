// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { BanIcon, FilterIcon, GridIcon, PanelIcon, ResetIcon, SlidersIcon, StarIcon, icon } from "./icons";
import { type Filter, NO_FILTER, popupCount } from "./filter";
import { type Bounds as FilterBounds, FilterPopup, type ImmichFilters } from "./FilterPopup";
import { type ImageEntry, LABEL_COLORS } from "./library";
import { Layout } from "./layoutPrefs";
import { NO_SEARCH, immichFilterCount } from "./immich";
import { invert } from "./probe";
import { keys } from "./keys";
import { useEffect, useRef, useState } from "react";
import { type Zoom } from "./zoom";
import { t } from "./i18n";

// a drag handle between panels. `invert` for a panel that grows as the
// handle moves left or up (the right panel, the filmstrip)
export function Splitter({ axis, value, min, max, invert, hidden, onChange }: {
  axis: "x" | "y"; value: number; min: number; max: number; invert?: boolean; hidden?: boolean;
  onChange: (v: number) => void;
}) {
  const start = useRef<{ pos: number; value: number } | null>(null);
  return (
    <div className={`splitter ${axis}${hidden ? " off" : ""}`}
         onPointerDown={(e) => {
           (e.target as HTMLElement).setPointerCapture(e.pointerId);
           start.current = { pos: axis === "x" ? e.clientX : e.clientY, value };
         }}
         onPointerMove={(e) => {
           const s = start.current;
           if (!s) return;
           const d = (axis === "x" ? e.clientX : e.clientY) - s.pos;
           onChange(Math.round(Math.min(max, Math.max(min, s.value + (invert ? -d : d)))));
         }}
         onPointerUp={() => { start.current = null; }} />
  );
}

// everything back to the image's defaults, as one undo step
export function ResetAll({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  return (
    <button className="tool" disabled={disabled} onClick={onReset} aria-label={t("library.toolbar.reset")}
            title={keys(t("library.toolbar.resetHint"))}>
      <ResetIcon />
    </button>
  );
}

// the zoom bar: Fit rests in the middle, zooming in to 400% to the right
// and out to a quarter of Fit to the left, evenly in ratio; near the middle
// it snaps to Fit, and a double-click goes between Fit and 100%
export const ZOOM_MAX = 4;
export const ZOOM_OUT = 4;
export function ZoomBar({ disabled, register, onZoom, onToggle, fit }: {
  disabled: boolean;
  register: (show: (z: number, isFit: boolean) => void) => void;
  onZoom: (z: Zoom) => void; onToggle: () => void; fit: () => number;
}) {
  const range = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const toPos = (z: number) => {
    const f = fit();
    if (z >= f) return f >= ZOOM_MAX ? 0 : (1000 * Math.log(z / f)) / Math.log(ZOOM_MAX / f);
    return Math.max(-1000, (1000 * Math.log(z / f)) / Math.log(ZOOM_OUT));
  };
  useEffect(() => register((z, isFit) => {
    if (range.current) range.current.value = String(isFit ? 0 : toPos(z));
    if (label.current) label.current.textContent = isFit ? t("library.toolbar.fit") : `${Math.round(z * 100)}%`;
  }), []);
  return (
    <div className="tool-group zoom-bar" title={t("library.toolbar.zoomHint")} onDoubleClick={onToggle}>
      <input ref={range} type="range" min={-1000} max={1000} step={1} defaultValue={0} disabled={disabled}
             onChange={(e) => {
               const p = Number(e.target.value), f = fit();
               onZoom(Math.abs(p) < 25 ? "fit" : p > 0 ? f * (ZOOM_MAX / f) ** (p / 1000) : f * ZOOM_OUT ** (p / 1000));
             }} />
      <span ref={label} className="zoom-label">{t("library.toolbar.fit")}</span>
    </div>
  );
}

// the zoom bar in grid view sets the thumbnails' size instead, from the
// smallest at the left to the largest at the right, evenly in ratio; the
// label is the size against the default, and a double-click goes back to it
export function GridZoomBar({ size, min, max, standard, onSize }: {
  size: number; min: number; max: number; standard: number; onSize: (v: number) => void;
}) {
  const pos = (1000 * Math.log(size / min)) / Math.log(max / min);
  return (
    <div className="tool-group zoom-bar" title={t("library.toolbar.thumbnailHint")} onDoubleClick={() => onSize(standard)}>
      <input type="range" min={0} max={1000} step={1} value={Math.round(pos)} aria-label={t("library.toolbar.thumbnailSize")}
             onChange={(e) => onSize(min * (max / min) ** (Number(e.target.value) / 1000))} />
      <span className="zoom-label">{`${Math.round((size / standard) * 100)}%`}</span>
    </div>
  );
}

// the bar under the filmstrip: rate and reject the open image, filter the
// folder, and show or hide the side panels and the filmstrip
export function Toolbar({ filter: f, images, layout, zoomBar, viewTools, onFilter, onLayout, ref, pin, immich, grid, onGrid,
                   filterBounds, onFiltered }: {
  ref: React.RefObject<HTMLDivElement | null>;
  viewTools: React.ReactNode;               // undo, redo, before/after, compare
  grid: boolean;
  onGrid?: () => void;                      // none while there are no photos to show
  filterBounds: () => FilterBounds | undefined; // where the Filters popup may go
  onFiltered: () => void;                   // the Filters popup's Search, which shows the grid
  pin: React.ReactNode;
  // with Immich results, which carry no reject flag or labels, the stars and
  // the Filters popup set the server's search
  immich: ImmichFilters | null;
  filter: Filter; layout: Layout; zoomBar: React.ReactNode;
  images: ImageEntry[];                     // the folder's photos, whose cameras, lenses and so on the Filters popup lists
  onFilter: (f: Filter) => void;
  onLayout: (k: "left" | "strip" | "right") => void;
}) {
  const remote = !!immich;
  const stars = immich ? immich.form.minRating : f.minRating;
  const filtering = f.minRating > 0 || f.rejected !== "all" || f.edited !== "all" || f.labels !== 0 || f.unlabeled
    || popupCount(f) > 0 || (!!immich && (stars > 0 || immichFilterCount(immich.form) > 0));
  // what the reject filter now shows, said for a moment above it
  // (fixed to the window: the toolbar scrolls, and would clip it)
  const [note, setNote] = useState<{ text: string; x: number; y: number } | null>(null);
  const noteTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const say = (text: string, e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setNote({ text, x: r.left + r.width / 2, y: r.top });
    window.clearTimeout(noteTimer.current);
    noteTimer.current = window.setTimeout(() => setNote(null), 1600);
  };
  const clearFilters = (e: React.MouseEvent<HTMLButtonElement>) => {
    onFilter(NO_FILTER);
    if (immich) {
      const s = immich.form;
      immich.update({ ...NO_SEARCH, mode: s.mode, text: s.text, library: s.library, source: s.source, scope: s.scope, subject: s.subject });
    }
    say(t("library.toolbar.filtersCleared"), e);
  };
  const cycleRejected = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next = f.rejected === "all" ? "hide" : f.rejected === "hide" ? "only" : "all";
    onFilter({ ...f, rejected: next });
    say(t(next === "all" ? "library.toolbar.showAll" : next === "hide" ? "library.toolbar.hideRejected" : "library.toolbar.onlyRejected"), e);
  };
  const cycleEdited = (e: React.MouseEvent<HTMLButtonElement>) => {
    const next = f.edited === "all" ? "edited" : f.edited === "edited" ? "unedited" : "all";
    onFilter({ ...f, edited: next });
    say(t(next === "all" ? "library.toolbar.showAll" : next === "edited" ? "library.toolbar.onlyEdited" : "library.toolbar.onlyUnedited"), e);
  };
  return (
    <div className="toolbar" ref={ref}>
      <div className={`tool-group filter${filtering ? " active" : ""}`}>
        <button className={`tool${filtering ? " on" : ""}`} title={filtering ? t("library.toolbar.clearFilters") : t("library.toolbar.noFilters")}
                onClick={clearFilters}><FilterIcon /></button>
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} className="tool" title={t("library.toolbar.starsAndUp", { count: n })}
                  onClick={() => immich ? immich.update({ minRating: stars === n ? 0 : n })
                                        : onFilter({ ...f, minRating: f.minRating === n ? 0 : n })}>
            <StarIcon filled={stars >= n} />
          </button>
        ))}
        {!remote && <>
        <span className="sep" />
        {/* all, then without the rejected, then only them (to delete) */}
        <button className={`tool${f.rejected === "hide" ? " on" : f.rejected === "only" ? " on only-rejected" : ""}`}
                title={t(f.rejected === "all" ? "library.toolbar.hideRejected" : f.rejected === "hide" ? "library.toolbar.rejectedHidden" : "library.toolbar.onlyRejected")}
                onClick={cycleRejected}>
          <BanIcon />
          {note && <span className="filter-note" key={note.text} style={{ left: note.x, top: note.y }}>{note.text}</span>}
        </button>
        {/* all, then the edited, then the ones still untouched */}
        <button className={`tool${f.edited === "edited" ? " on" : f.edited === "unedited" ? " on only-unedited" : ""}`}
                title={t(f.edited === "all" ? "library.toolbar.onlyEdited" : f.edited === "edited" ? "library.toolbar.editedOnly" : "library.toolbar.onlyUnedited")}
                onClick={cycleEdited}>
          <SlidersIcon />
        </button>
        <span className="sep" />
        {LABEL_COLORS.map((c, k) => (
          <button key={c} className={`swatch${f.labels & (1 << k) ? " on" : ""}`} style={{ background: c }}
                  title={t("library.toolbar.withLabel")} onClick={() => onFilter({ ...f, labels: f.labels ^ (1 << k) })} />
        ))}
        <button className={`swatch${f.unlabeled ? " on" : ""}`} style={{ background: "#9ca3af" }}
                title={t("library.toolbar.withoutLabel")} onClick={() => onFilter({ ...f, unlabeled: !f.unlabeled })} />
        </>}
        <span className="sep" />
        <FilterPopup filter={f} images={images} onFilter={onFilter} immich={immich} bounds={filterBounds} onSearch={onFiltered} />
        {filtering && (
          <button className="tool clear-filters" title={t("library.toolbar.showEveryPhoto")} onClick={clearFilters}>{t("library.filters.clear")}</button>
        )}
      </div>

      {zoomBar}
      {/* down here rather than over the photo, where they covered the crop
          handles and whatever was being edited in that corner */}
      <div className="tool-group view-tools">
        {viewTools}
        <span className="sep" />
        {/* named, not an icon alone: new users missed the arrow it replaces, and G with it */}
        <button className={`tool grid-toggle${grid ? " on" : ""}`} disabled={!onGrid}
                title={t(grid ? "library.toolbar.filmstrip" : "library.toolbar.grid")} onClick={onGrid}>
          <GridIcon />{t("library.toolbar.gridLabel")}
        </button>
        <span className="sep" />
        <button className={`tool${layout.left ? " on" : ""}`} title={t("library.toolbar.libraryPanel")}
                onClick={() => onLayout("left")}><PanelIcon side="left" /></button>
        <button className={`tool${layout.strip ? " on" : ""}`} title={t("library.toolbar.filmstripLabel")}
                onClick={() => onLayout("strip")}><PanelIcon side="bottom" /></button>
        <button className={`tool${layout.right ? " on" : ""}`} title={t("library.toolbar.adjustmentsPanel")}
                onClick={() => onLayout("right")}><PanelIcon side="right" /></button>
        {/* the filmstrip's pin, after the panel switches rather than among them */}
        {pin}
      </div>
    </div>
  );
}
