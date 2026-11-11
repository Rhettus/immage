// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { ActivityBar } from "./ActivityBar";
import { type ImageEntry, type Known, LABEL_COLORS, ThumbLoader, fetchThumb, isPrimaryRaw, knownKey, pairKey } from "./library";
import { SlidersIcon } from "./icons";
import { baseName } from "./paths";
import { captureDate, known, shutter } from "./MetadataPanel";
import { end } from "./activity";
import { isRemote } from "./immich";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

// the pair names (pairKey()) that have a raw among these files
export const pairedRaws = (files: string[]) => new Set(files.filter((p) => isPrimaryRaw(p)).map(pairKey));

// the folder's images along the bottom, as Lightroom's filmstrip: a cell
// each with the file's name and type above its thumbnail, and its reject
// flag and stars below, shown on hover or once it has a rating
export function Filmstrip({ images, partners, pending, empty, current, loader, height, grid, selection, candidate, onPick, onDouble,
                     onOpenKnown, onMenu, onMeta, more, onBackMenu }: {
  // photos, and those known from the folder's last read (library.ts)
  images: (ImageEntry | Known)[]; current: number | null; loader: ThumbLoader; height: number;
  pending: string[];                      // files not yet read, shown as empty cells
  partners: Map<number, ImageEntry[]>;    // a stacked raw's JPEG or HEIF, by its imgid
  empty: string;                          // what an empty grid says
  grid: boolean;                          // spread over the editing area, in rows
  selection: Set<number>;
  candidate: number | null;               // the photo compared with the open one
  onPick: (i: ImageEntry, e: React.MouseEvent) => void;
  onDouble: (i: ImageEntry) => void;
  onOpenKnown: (k: Known, double: boolean) => void;
  onMenu: (e: React.MouseEvent, imgid: number) => void;
  onMeta: (i: ImageEntry, fields: Partial<ImageEntry>) => void;
  more?: () => void;                      // there are more results: called as the end scrolls into view
  onBackMenu: (e: React.MouseEvent) => void; // right-click beside the photos
}) {
  const strip = useRef<HTMLDivElement>(null);
  // the cell after the last, which asks for the next page of results
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = strip.current, el = end.current;
    if (!root || !el || !more) return;
    const seen = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) more(); },
                                          { root, rootMargin: grid ? "600px 0px" : "0px 600px" });
    seen.observe(el);
    return () => seen.disconnect();
  }, [more, images, grid]);
  // keep the open image in view as the arrows step through the folder.
  // the strip alone scrolls: scrollIntoView would also scroll its
  // ancestors, and a hidden floating strip, parked below the center
  // column, then pushes the whole column up out of its overflow: hidden
  useEffect(() => {
    const root = strip.current;
    const cell = root?.querySelector(".thumb.active");
    if (!root || !cell) return;
    const r = root.getBoundingClientRect();
    const c = cell.getBoundingClientRect();
    if (c.left < r.left) root.scrollLeft -= r.left - c.left;
    else if (c.right > r.right) root.scrollLeft += c.right - r.right;
    if (c.top < r.top) root.scrollTop -= r.top - c.top;
    else if (c.bottom > r.bottom) root.scrollTop += c.bottom - r.bottom;
  }, [current, grid]);
  // thumbnails scrolled into view jump the loader's queue
  useEffect(() => {
    const root = strip.current;
    if (!root) return;
    const visible = new Set<number | string>();
    const seen = new IntersectionObserver((entries) => {
      // a known photo's cell by its knownKey()
      const id = (e: IntersectionObserverEntry) => {
        const d = (e.target as HTMLElement).dataset;
        return d.imgid !== undefined ? Number(d.imgid) : d.known!;
      };
      const ids = entries.filter((e) => e.isIntersecting).map(id);
      ids.forEach((id) => visible.add(id));
      const hidden = entries.filter((e) => !e.isIntersecting).map(id);
      hidden.forEach((id) => visible.delete(id));
      loader.show(ids, true);
      loader.show(hidden, false);
      if (ids.length) loader.request(ids, true);
    }, { root });
    root.querySelectorAll<HTMLElement>(".thumb[data-imgid], .thumb[data-known]").forEach((el) => seen.observe(el));
    return () => {
      seen.disconnect();
      loader.show([...visible], false);
    };
  }, [images, loader, grid]);
  // a grid's cells are a fixed height, and share each row's width
  // (styles.css, .filmstrip.grid); the strip's follow its height
  const cellSize = grid ? 200 : Math.round((height - 12) * 1.15);
  const cell = useMemo(() => (grid ? { height: cellSize } : { width: cellSize }), [grid, cellSize]);
  // the cells are memoized, and call through this, so a folder's next
  // batch or a new selection redraws only the cells that changed
  const on = useRef({ onPick, onDouble, onMenu, onMeta });
  on.current = { onPick, onDouble, onMenu, onMeta };
  const openKnown = useRef(onOpenKnown);
  openKnown.current = onOpenKnown;
  // an empty grid still covers the photo, and says why it is empty
  if (!images.length && !pending.length) {
    return grid ? <div className="filmstrip grid empty" onContextMenu={onBackMenu}><div className="grid-empty">{empty}</div></div>
      : null;
  }
  return (
    <div className={`filmstrip${grid ? " grid" : ""}`} ref={strip} style={grid ? undefined : { height }}
         onContextMenu={onBackMenu}
         onWheel={(e) => { if (strip.current && !grid) strip.current.scrollLeft += e.deltaY + e.deltaX; }}>
      {images.map((i) => !("imgid" in i)
        ? <KnownCell key={`k${knownKey(i)}`} entry={i} loader={loader} cell={cell} open={openKnown} doubleOpens={grid} />
        : (
        <FilmCell key={i.imgid} entry={i} loader={loader} cell={cell} on={on}
                  types={[i, ...(partners.get(i.imgid) ?? [])]
                    .map((f) => (f.filename.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase()).join("+")}
                  active={i.imgid === current} selected={selection.size > 1 && selection.has(i.imgid)}
                  candidate={i.imgid === candidate} doubleOpens={grid || candidate !== null} />
      ))}
      {pending.map((p) => <GhostCell key={p} path={p} cell={cell} />)}
      {more && <div ref={end} className="thumb ghost more" style={cell} />}
    </div>
  );
}

// `dogEar` turns the bottom left corner over, as Lightroom marks a virtual
// copy: drawn on the thumbnail, which the cell fits, so it sits on the
// photo's own corner whatever its shape
export type CellHandlers = Pick<Parameters<typeof Filmstrip>[0], "onPick" | "onDouble" | "onMenu" | "onMeta">;

// one photo's filmstrip cell
export const FilmCell = memo(function FilmCell({ entry: i, loader, cell, on, types, active, selected, candidate, doubleOpens }: {
  entry: ImageEntry; loader: ThumbLoader; cell: React.CSSProperties; on: React.RefObject<CellHandlers>;
  types: string; active: boolean; selected: boolean; candidate: boolean; doubleOpens: boolean;
}) {
  return (
    <div className={`thumb${active ? " active" : ""}${i.rejected ? " rejected" : ""}`
                    + `${i.rating || i.rejected ? " rated" : ""}${selected ? " selected" : ""}`
                    + `${candidate ? " candidate" : ""}`}
         style={cell}
         title={i.filename} data-imgid={i.imgid} onClick={(e) => on.current!.onPick(i, e)}
         onDoubleClick={() => { if (doubleOpens) on.current!.onDouble(i); }}
         onContextMenu={(e) => { e.stopPropagation(); on.current!.onMenu(e, i.imgid); }}>
      <div className="thumb-head">
        <span className="thumb-name">{i.filename.replace(/\.[^.]+$/, "")}</span>
        {/* altered, as darktable counts it, so its lighttable agrees */}
        {i.edited && <span className="thumb-edited" title="edited"><SlidersIcon /></span>}
        <span className="thumb-type">{types}{copyName(i)}</span>
      </div>
      <div className="thumb-image"><ThumbCanvas loader={loader} imgid={i.imgid} dogEar={!!i.copy} /></div>
      {/* rated without opening the photo, as Lightroom's filmstrip does;
          an Immich result shows Immich's rating, set only once opened */}
      <div className={`thumb-foot${isRemote(i) ? " read-only" : ""}`} onClick={(e) => e.stopPropagation()}>
        {!isRemote(i) && <button className={`thumb-reject${i.rejected ? " on" : ""}`} title="reject (X)"
                onClick={() => on.current!.onMeta(i, { rejected: !i.rejected })}>✕</button>}
        <span className="thumb-stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={!i.rejected && i.rating >= n ? "on" : ""}
                    title={isRemote(i) ? "Immich's rating: open the photo to change it" : `${n} star${n > 1 ? "s" : ""}`}
                    disabled={isRemote(i)}
                    onClick={() => on.current!.onMeta(i, { rating: i.rating === n ? 0 : n, rejected: false })}>★</button>
          ))}
        </span>
        <span className="labels">
          {LABEL_COLORS.map((c, k) => (i.labels & (1 << k)
            ? <span key={k} className="dot" style={{ background: c }} /> : null))}
        </span>
      </div>
    </div>
  );
});

// a photo known from the folder's last read, not yet read by this one: as
// it was then, and read-only until it is read, when a FilmCell takes its place
export const KnownCell = memo(function KnownCell({ entry: i, loader, cell, open, doubleOpens }: {
  entry: Known; loader: ThumbLoader; cell: React.CSSProperties;
  open: React.RefObject<(k: Known, double: boolean) => void>; doubleOpens: boolean;
}) {
  return (
    <div className={`thumb known${i.rejected ? " rejected" : ""}${i.rating || i.rejected ? " rated" : ""}`} style={cell}
         title={i.filename} data-known={knownKey(i)} onClick={() => { if (!doubleOpens) open.current!(i, false); }}
         onDoubleClick={() => { if (doubleOpens) open.current!(i, true); }}>
      <div className="thumb-head">
        <span className="thumb-name">{i.filename.replace(/\.[^.]+$/, "")}</span>
        {i.edited && <span className="thumb-edited" title="edited"><SlidersIcon /></span>}
        <span className="thumb-type">{(i.filename.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase()}{copyName(i)}</span>
      </div>
      <div className="thumb-image"><ThumbCanvas loader={loader} imgid={knownKey(i)} dogEar={!!i.copy} /></div>
      <div className="thumb-foot read-only">
        {i.rejected && <button className="thumb-reject on" disabled>✕</button>}
        <span className="thumb-stars">
          {[1, 2, 3, 4, 5].map((n) => <button key={n} className={!i.rejected && i.rating >= n ? "on" : ""} disabled>★</button>)}
        </span>
        <span className="labels">
          {LABEL_COLORS.map((c, k) => (i.labels & (1 << k)
            ? <span key={k} className="dot" style={{ background: c }} /> : null))}
        </span>
      </div>
    </div>
  );
});

// a file not yet read, shown as an empty cell
export const GhostCell = memo(function GhostCell({ path, cell }: { path: string; cell: React.CSSProperties }) {
  const name = baseName(path);
  return (
    <div className="thumb ghost" style={cell} title={name}>
      <div className="thumb-head">
        <span className="thumb-name">{name.replace(/\.[^.]+$/, "")}</span>
        <span className="thumb-type">{(name.match(/\.([^.]+)$/)?.[1] ?? "").toUpperCase()}</span>
      </div>
      <div className="thumb-image"><ThumbCanvas /></div>
      <div className="thumb-foot" />
    </div>
  );
});

// the folder's thumbnails loading, redrawn a few times a second rather
// than for each one
export function ThumbProgress({ loader }: { loader: ThumbLoader }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    let timer = 0;
    const off = loader.watchProgress(() => {
      if (!timer) timer = window.setTimeout(() => { timer = 0; setTick((n) => n + 1); }, 250);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, [loader]);
  const t = loader.progress();
  return t.done < t.total ? <ActivityBar what="Loading thumbnails" done={t.done} total={t.total} /> : null;
}

// the image's thumbnail as the loader has it, redrawn when that changes
// a print cell's photo: the engine's thumbnail at the size the cell shows it
// (the filmstrip's is 240 pixels, soft in a big cell), soft proofed when the
// proof is on. it lasts as long as the cell, so it is not kept in the loader
export function CellCanvas({ loader, imgid, proof, proofKey, pixels }:
                    { loader?: ThumbLoader; imgid: number; proof: boolean; proofKey: string; pixels: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  // the engine could not make it: the library's thumbnail stands in, unproofed
  const [failed, setFailed] = useState(false);
  // the cached sizes are steps; asking in steps keeps a resize from refetching
  const size = Math.min(1440, Math.max(256, Math.ceil(pixels / 128) * 128));
  useEffect(() => {
    let stale = false;
    fetchThumb(imgid, size, undefined, proof).then((bitmap) => {
      const c = ref.current;
      if (stale || !c) return;
      c.width = bitmap.width;
      c.height = bitmap.height;
      c.getContext("2d", { willReadFrequently: true })!.drawImage(bitmap, 0, 0);
      setReady(true);
      setFailed(false);
    }).catch((e) => { if (!stale) { console.error(`print cell thumbnail ${imgid}: ${e}`); setFailed(true); } });
    return () => { stale = true; };
  }, [imgid, size, proofKey]);
  return <>
    <canvas ref={ref} style={ready ? undefined : { display: "none" }} />
    {!ready && <ThumbCanvas loader={failed ? loader : undefined} imgid={failed ? imgid : undefined} />}
  </>;
}

export function ThumbCanvas({ loader, imgid, dogEar = false }: { loader?: ThumbLoader; imgid?: number | string; dogEar?: boolean }) {
  const [bitmap, setBitmap] = useState(() => (imgid === undefined ? undefined : loader?.get(imgid)));
  useEffect(() => {
    if (!loader || imgid === undefined) return;
    setBitmap(loader.get(imgid));
    return loader.watch(imgid, () => setBitmap(loader.get(imgid)));
  }, [loader, imgid]);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !bitmap?.width) return;
    c.width = bitmap.width;
    c.height = bitmap.height;
    // WebKitGTK stops showing GPU-backed thumbnail canvases once a photo is
    // open, though their pixels are intact; unaccelerated ones are painted
    // with the page
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0);
    if (!dogEar) return;
    const d = Math.round(Math.max(c.width, c.height) * 0.09), h = c.height;
    // the corner cut away, showing the cell behind, and the flap folded over
    g.globalCompositeOperation = "destination-out";
    g.beginPath(); g.moveTo(0, h - d); g.lineTo(d, h); g.lineTo(0, h); g.closePath(); g.fill();
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#d9d9d9";
    g.beginPath(); g.moveTo(0, h - d); g.lineTo(d, h - d); g.lineTo(d, h); g.closePath(); g.fill();
  }, [bitmap, dogEar]);
  // a photo's outline until its thumbnail is built
  return bitmap ? <canvas ref={ref} /> : (
    <div className="placeholder">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
           strokeLinejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.6" /><path d="m4 17 5-4.5 3.5 3 3-2.5 4.5 4" /></svg>
    </div>
  );
}

// a virtual copy's name after its file's, as Lightroom's "Copy 1"
// the info over the photo, as Lightroom's I cycles it: 0 the file (its
// folder, capture time and size), 1 the exposure and lens, 2 none
export const INFO_MODE_KEY = "immage.infoMode";
export function loadInfoMode(): number {
  try { const v = Number(localStorage.getItem(INFO_MODE_KEY)); return v >= 0 && v <= 2 ? v : 0; } catch { return 0; }
}
export function InfoOverlay({ mode, name, dir, entry }: { mode: number; name: string; dir: string; entry: ImageEntry | null }) {
  const e = entry?.exif;
  const lines = mode === 0
    ? [dir, e?.datetime ? captureDate(e.datetime) : "",
       entry && entry.width > 0 && entry.height > 0 ? `${entry.width} × ${entry.height}` : ""]
    : [[shutter(e?.exposure ?? 0),
        e && known(e.aperture) && e.aperture > 0 ? `ƒ / ${e.aperture.toFixed(1)}` : "",
        e && known(e.iso) && e.iso > 0 ? `ISO ${Math.round(e.iso)}` : ""]
         .filter(Boolean).join(", ").replace(/^(.*sec), (ƒ)/, "$1 at $2"),
       [e && known(e.focal_length) && e.focal_length > 0 ? `${+e.focal_length.toFixed(0)} mm` : "",
        e?.lens ? `(${e.lens})` : ""].filter(Boolean).join(" ")];
  return (
    <div className="info-overlay">
      <div className="info-name">{name}</div>
      {lines.filter(Boolean).map((l, k) => <div key={k}>{l}</div>)}
    </div>
  );
}

export const copyName = (i: Known | null | undefined) => (i?.copy ? ` · Copy ${i.version}` : "");
