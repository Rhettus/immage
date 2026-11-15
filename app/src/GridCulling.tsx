// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { easeZoom, ZOOM_EASE } from "./zoom";
import { loadReadAhead } from "./Preferences";
import { BanIcon, StarIcon } from "./icons";
import { commands } from "./commands";
import { fitLightbox, keywordTargets, previewNeighbors, PreviewQueue } from "./culling";
import { LABEL_COLORS, fetchCachedThumb, fetchThumb, type ImageEntry } from "./library";
import { KeywordingPanel, parseKeyword } from "./Keywording";

export function GridCulling({ images, allImages, selection, anchor, thumbnail, prepare, onEdit, onMeta, onKeywords }: {
  images: ImageEntry[]; allImages: ImageEntry[]; selection: Set<number>; anchor: number | null;
  thumbnail: (id: number) => ImageBitmap | undefined;
  prepare: (id: number) => Promise<void>; onEdit: (image: ImageEntry) => void;
  onMeta: (image: ImageEntry, fields: Partial<ImageEntry>) => void;
  onKeywords: (id: number, keywords: string[]) => void;
}) {
  const zoomAnchor = useRef<{ix: number; iy: number; sx: number; sy: number} | null>(null);
  const space = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const panClick = useRef(false);
  const [paintSize, setPaintSize] = useState({width: 300, height: 150});
  const direction = useRef<1 | -1>(1);
  const queue = useRef(new PreviewQueue());
  const header = useRef<HTMLDivElement>(null);
  const [toolbarHeight, setToolbarHeight] = useState(80);
  const [windowSize, setWindowSize] = useState({width: window.innerWidth, height: window.innerHeight});
  const [dimensions, setDimensions] = useState<{id: number; width: number; height: number} | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const keywordGeneration = useRef(0);
  const [retry, setRetry] = useState(0);
  const [detail, setDetail] = useState(false);
  const [photo, setPhoto] = useState<number | null>(null);
  const [targets, setTargets] = useState<ImageEntry[]>([]);
  const [lists, setLists] = useState<string[][]>([]);
  const [known, setKnown] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(false);
  const current = images.find(i => i.imgid === photo);
  const actual = dimensions?.id === photo ? dimensions : current;
  const fitted = fitLightbox((actual?.width || 1200) / devicePixelRatio,
    (actual?.height || 800) / devicePixelRatio, windowSize.width, windowSize.height, toolbarHeight);
  useEffect(() => {
    const resize = () => setWindowSize({width: window.innerWidth, height: window.innerHeight});
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    if (!header.current) return;
    const observer = new ResizeObserver(() => setToolbarHeight(header.current?.offsetHeight ?? 80));
    observer.observe(header.current);
    return () => observer.disconnect();
  }, [photo]);
  const previousIndex = useRef(0);
  useEffect(() => { if (current) previousIndex.current = images.indexOf(current); else if (photo !== null) setPhoto(images[Math.min(previousIndex.current, images.length - 1)]?.imgid ?? null); }, [images, photo]);
  const keywords = async (items: ImageEntry[]) => {
    const generation = ++keywordGeneration.current;
    setTargets(items); setLists([]); setError("");
    try {
      const [meta, all] = await Promise.all([Promise.all(items.map(i => commands.meta(i.imgid))), commands.keywords()]);
      if (generation !== keywordGeneration.current) return;
      setLists(meta.map(m => m.image.keywords)); setKnown(all);
    } catch (e) { if (generation === keywordGeneration.current) setError(String(e)); }
  };
  useEffect(() => {
    const open = (event: Event) => {
      const ids = (event as CustomEvent<number[]>).detail;
      void keywords(allImages.filter(i => ids.includes(i.imgid) && !i.remote));
    };
    window.addEventListener("grid-keywords", open);
    return () => window.removeEventListener("grid-keywords", open);
  });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (targets.length && k === "escape") {
        if (writing) { e.preventDefault(); e.stopImmediatePropagation(); return; }
        e.preventDefault(); e.stopImmediatePropagation(); ++keywordGeneration.current; setTargets([]); return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest("input,textarea,[contenteditable=true]")) return;
      if (document.querySelector(".modal-backdrop") && !photo && !targets.length) return;
      if (photo !== null && !targets.length && k === " ") {
        e.preventDefault(); e.stopImmediatePropagation(); space.current = true; setSpaceHeld(true); return;
      }
      const hovered = document.querySelector(".filmstrip.grid .thumb:hover")?.getAttribute("data-imgid");
      const chosen = keywordTargets(allImages, selection);
      const target = images.find(i => i.imgid === (hovered === null || hovered === undefined ? NaN : Number(hovered))) ?? images.find(i => i.imgid === anchor && selection.has(i.imgid)) ?? images.find(i => selection.has(i.imgid));
      if (photo !== null && !["f","k","escape","arrowleft","arrowright","0","1","2","3","4","5","6","7","8","9","x"].includes(k)) { e.stopImmediatePropagation(); return; }
      if (!["f","k","escape","arrowleft","arrowright","0","1","2","3","4","5","6","7","8","9","x"].includes(k)) return;
      if (!photo && !targets.length && k !== "f" && k !== "k") return;
      if (targets.length && k !== "escape") return;
      if (!photo && !target && !chosen.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (k === "escape") { if (targets.length) setTargets([]); else setPhoto(null); }
      else if (k === "f") { direction.current = 1; setPhoto(photo ? null : target?.imgid ?? null); }
      else if (k === "k") void keywords(current ? [current] : keywordTargets(allImages, selection, target?.imgid));
      else if (current && (k === "arrowleft" || k === "arrowright")) {
        direction.current = k === "arrowleft" ? -1 : 1;
        const next = images[images.indexOf(current) + direction.current];
        if (next) setPhoto(next.imgid);
      } else if (current && /^[0-5]$/.test(k)) onMeta(current, { rating: Number(k), rejected: false });
      else if (current && /^[6-9]$/.test(k)) onMeta(current, { labels: current.labels ^ (1 << (Number(k) - 6)) });
      else if (current && k === "x") onMeta(current, { rejected: !current.rejected });
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  useEffect(() => {
    const release = () => { space.current = false; setSpaceHeld(false); };
    const up = (e: KeyboardEvent) => { if (e.key === " ") release(); };
    window.addEventListener("keyup", up); window.addEventListener("blur", release);
    return () => { window.removeEventListener("keyup", up); window.removeEventListener("blur", release); };
  }, []);
  useEffect(() => {
    const image = canvas.current, box = viewport.current;
    if (!image || !box || !current) return;
    // Animate the available pixels immediately; native detail replaces them
    // without making click-to-zoom wait for the independent render.
    const w = zoom ? (detail ? paintSize.width : current.width) / devicePixelRatio : paintSize.width;
    const h = zoom ? (detail ? paintSize.height : current.height) / devicePixelRatio : paintSize.height;
    const factor = zoom ? 1 : Math.min(box.clientWidth / Math.max(1,w), box.clientHeight / Math.max(1,h));
    const targetWidth = Math.max(1, w * factor), targetHeight = Math.max(1, h * factor);
    let width = image.getBoundingClientRect().width || targetWidth;
    let height = image.getBoundingClientRect().height || targetHeight;
    let frame = 0;
    const step = () => {
      width = easeZoom(width, targetWidth); height = easeZoom(height, targetHeight);
      image.style.width = width + "px"; image.style.height = height + "px";
      if (!zoom) { box.scrollLeft *= 1 - ZOOM_EASE; box.scrollTop *= 1 - ZOOM_EASE; }
      else {
        const anchor = zoomAnchor.current ?? {ix:.5, iy:.5, sx:box.clientWidth/2, sy:box.clientHeight/2};
        box.scrollLeft = width * anchor.ix - anchor.sx + Math.max(0, (box.clientWidth - width) / 2);
        box.scrollTop = height * anchor.iy - anchor.sy + Math.max(0, (box.clientHeight - height) / 2);
      }
      if (width !== targetWidth || height !== targetHeight) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [zoom, detail, paintSize, fitted.width, fitted.height, photo]);
  useEffect(() => {
    if (!current) return;
    let stale = false;
    const q = queue.current;
    q.replace();
    setDetail(false); setBusy(true); setError("");
    if (!zoom && canvas.current) canvas.current.getContext("2d")?.clearRect(0, 0, canvas.current.width, canvas.current.height);
    const box = viewport.current;
    const size = zoom ? 0 : Math.ceil(Math.max(box?.clientWidth ?? window.innerWidth * .86,
      box?.clientHeight ?? window.innerHeight * .86) * devicePixelRatio);
    const draw = (bitmap: ImageBitmap) => {
      if (!stale && canvas.current) {
        if (!zoom) setDimensions({id: current.imgid, width: bitmap.width, height: bitmap.height});
        setPaintSize({width: bitmap.width, height: bitmap.height});
        canvas.current.width = bitmap.width; canvas.current.height = bitmap.height;
        canvas.current.getContext("2d")?.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    };
    // Borrow the grid bitmap only for this synchronous draw; its loader owns it.
    // A virtual copy is looked up by imgid, never by the shared original path.
    const small = thumbnail(current.imgid);
    if (!zoom && small && canvas.current) {
      setPaintSize({width: small.width, height: small.height});
      canvas.current.width = small.width; canvas.current.height = small.height;
      canvas.current.getContext("2d")?.drawImage(small, 0, 0);
    }
    const load = async (entry: ImageEntry, requested: number) =>
      await fetchCachedThumb(entry, requested) ?? await fetchThumb(entry.imgid, requested, entry);
    void q.enqueue(async () => {
      await prepare(current.imgid);
      if (stale) return;
      draw(await load(current, size));
      if (!stale) setDetail(zoom);
    }).then(() => {
      if (stale || zoom) return;
      const { count, both } = loadReadAhead();
      for (const neighbor of previewNeighbors(images, current.imgid, direction.current, count, both)) {
        if (neighbor) void q.enqueue(async () => { (await load(neighbor, size)).close(); }).catch(() => {});
      }
    }).catch(e => { if (!stale) setError(String(e)); }).finally(() => { if (!stale) setBusy(false); });
    return () => { stale = true; q.replace(); };
  }, [current?.imgid, current?.version, current?.edited, zoom, retry]);
  useEffect(() => { setZoom(false); }, [photo]);
  useEffect(() => () => { queue.current.replace(); ++keywordGeneration.current; }, []);
  useEffect(() => {
    if (targets.length && lists.length === targets.length)
      document.querySelector<HTMLInputElement>('[aria-label="Grid keywords"] input')?.focus();
  }, [targets, lists.length]);
  const change = async (add: string[], remove: string[]) => {
    if (writing) return;
    setWriting(true); setError("");
    try {
      const result = await Promise.allSettled(targets.map(async i => {
        const list = await commands.keywordsSet(i.imgid, [...new Set(add.map(parseKeyword).filter(Boolean))], remove);
        onKeywords(i.imgid, list); return list;
      }));
      setLists(result.map((r, n) => r.status === "fulfilled" ? r.value : lists[n] ?? []));
      if (result.some(r => r.status === "rejected")) setError("Some photos could not be updated. Retry the change.");
    } finally { setWriting(false); }
  };
  const shared = lists.length === targets.length ? (lists[0] ?? []).filter(k => lists.every(l => l.includes(k))) : [];
  return <>
    {current && <div className="modal-backdrop" style={{ zIndex: 1000, background: "rgba(0, 0, 0, .65)" }}
      onClick={e => { if (e.target === e.currentTarget) setPhoto(null); }} role="dialog" aria-modal="true" aria-label="Culling preview">
      {([-1, 1] as const).map(dir => {
        const next = images[images.indexOf(current) + dir];
        return <button key={dir} className={`culling-arrow ${dir < 0 ? "previous" : "next"}`}
          style={dir < 0 ? { left: `max(4px, calc(50% - ${fitted.width / 2 + 40}px))` }
            : { right: `max(4px, calc(50% - ${fitted.width / 2 + 40}px))` }}
          disabled={!next} aria-label={dir < 0 ? "Previous photo (left arrow key)" : "Next photo (right arrow key)"}
          title={dir < 0 ? "Previous photo (←)" : "Next photo (→)"}
          onClick={() => { if (next) { direction.current = dir; setPhoto(next.imgid); } }} />;
      })}
      <div className="culling-lightbox" style={fitted}>
        <div ref={header}>{current.filename} · {images.indexOf(current) + 1}/{images.length}
          <button onClick={() => setPhoto(null)}>Close (F / Esc)</button><button onClick={() => void keywords([current])}>Keywords (K)</button>
          <button onClick={() => { zoomAnchor.current = null; setZoom(!zoom); }}>{zoom ? "Fit" : "100%"}</button>
          <button onClick={() => onEdit(current)}>Edit</button>
          <span className="tool-group" role="group" aria-label="Photo rating">
            <button className={`tool${current.rejected ? " on" : ""}`} aria-label="Reject photo" aria-pressed={current.rejected}
              title="Reject (X)" onClick={() => onMeta(current, { rejected: !current.rejected })}><BanIcon /></button>
            {[1, 2, 3, 4, 5].map(n => <button key={n} className="tool"
              aria-label={`${n} star${n > 1 ? "s" : ""}`} aria-pressed={!current.rejected && current.rating >= n}
              title={`${n} star${n > 1 ? "s" : ""} (${n}); click again to clear`}
              onClick={() => onMeta(current, { rating: current.rating === n ? 0 : n, rejected: false })}>
              <StarIcon filled={!current.rejected && current.rating >= n} />
            </button>)}
          </span>
          <span className="tool-group" role="group" aria-label="Photo color labels">
            {LABEL_COLORS.map((color, n) => {
              const name = ["Red", "Yellow", "Green", "Blue", "Purple"][n];
              return <button key={color} className={`swatch${current.labels & (1 << n) ? " on" : ""}`}
                style={{ background: color }} aria-label={`${name} label`} aria-pressed={!!(current.labels & (1 << n))}
                title={`${name} label${n < 4 ? ` (${n + 6})` : ""}`}
                onClick={() => onMeta(current, { labels: current.labels ^ (1 << n) })} />;
            })}
          </span></div>
        <div ref={viewport} style={{ flex: 1, overflow: "auto", minHeight: 0,
          cursor: zoom && spaceHeld ? (panning ? "grabbing" : "grab") : zoom ? "zoom-out" : "zoom-in" }}
          onClick={e => {
            if (panClick.current || space.current) { panClick.current = false; return; }
            if (e.detail === 1) {
              const image = canvas.current?.getBoundingClientRect();
              const box = e.currentTarget.getBoundingClientRect();
              if (image && image.width && image.height) zoomAnchor.current = {
                ix: Math.max(0, Math.min(1, (e.clientX - image.left) / image.width)),
                iy: Math.max(0, Math.min(1, (e.clientY - image.top) / image.height)),
                sx: e.clientX - box.left, sy: e.clientY - box.top,
              };
              setZoom(z => !z);
            }
          }}
          onDoubleClick={() => { if (!panClick.current && !space.current) onEdit(current); }}
          onPointerDown={e => {
            panClick.current = false;
            if (!zoom || !space.current || e.button !== 0) return;
            panClick.current = true; setPanning(true);
            const el = e.currentTarget; el.setPointerCapture(e.pointerId);
            const x = e.clientX, y = e.clientY, left = el.scrollLeft, top = el.scrollTop;
            const move = (event: PointerEvent) => { el.scrollLeft = left + x - event.clientX; el.scrollTop = top + y - event.clientY; };
            const end = () => { setPanning(false); el.removeEventListener("pointermove", move); el.removeEventListener("lostpointercapture", end); };
            el.addEventListener("pointermove", move); el.addEventListener("lostpointercapture", end);
          }}>
          <div style={{ minWidth: "100%", minHeight: "100%", width: "max-content", height: "max-content", display: "grid", placeItems: "center" }}>
            <canvas ref={canvas} style={{ maxWidth: "none", flexShrink: 0 }} />
          </div>
        </div>
        {busy && <div>Loading preview…</div>}{error && <div role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>Retry</button></div>}
      </div>
    </div>}
    {!!targets.length && <div className="modal-backdrop" style={{ zIndex: 1001 }} role="dialog" aria-label="Grid keywords">
      <div className="modal"><h2>Keywords · {targets.length} photos</h2>
        <fieldset disabled={writing} style={{ border: 0, padding: 0 }}>
        {lists.length === targets.length && <KeywordingPanel keywords={shared} known={known} open onToggle={() => {}}
          onAdd={names => { if (!writing) void change(names, []); }}
          onRemove={name => { if (!writing) void change([], [name]); }} />}
        </fieldset>
        {error && <p role="alert">{error}</p>}<button disabled={writing} onClick={() => { ++keywordGeneration.current; setTargets([]); }}>Close</button>
      </div>
    </div>}
  </>;
}
