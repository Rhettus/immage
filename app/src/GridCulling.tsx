// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { easeZoom, ZOOM_EASE } from "./zoom";
import { loadReadAhead } from "./Preferences";
import { BanIcon, StarIcon } from "./icons";
import { commands } from "./commands";
import { fitLightbox, keywordTargets, previewNeighbors, PreviewQueue, wheelZoom } from "./culling";
import { LABEL_COLORS, fetchCachedThumb, fetchThumb, type ImageEntry } from "./library";
import { KeywordingPanel, parseKeyword } from "./Keywording";
import { t } from "./i18n";

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
  const previews = useRef(new Map<string, ImageBitmap>());
  const previewEpoch = useRef(0);
  const [windowSize, setWindowSize] = useState({width: window.innerWidth, height: window.innerHeight});
  const animation = useRef<{ frame: number; width: number; height: number } | null>(null);
  const targetSize = useRef({ width: 300, height: 150 });
  const zooming = useRef(false);
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
  // null is Fit; a number is the zoom multiplier (1 means 100%).
  const [zoom, setZoomState] = useState<number | null>(null);
  const zoomRef = useRef<number | null>(null);
  zoomRef.current = zoom;
  const setZoom = (value: number | null) => { zoomRef.current = value; setZoomState(value); };
  const detailed = zoom !== null;
  const current = images.find(i => i.imgid === photo);
  // The frame is fixed for the window size, independent of photo or preview
  // dimensions, so swapping photos and zooming never moves the toolbar.
  const fitted = fitLightbox(windowSize.width, windowSize.height);
  useEffect(() => {
    const resize = () => setWindowSize({width: window.innerWidth, height: window.innerHeight});
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!current) return;
      e.preventDefault();
      const image = canvas.current?.getBoundingClientRect();
      const bounds = el.getBoundingClientRect();
      if (image && image.width && image.height) zoomAnchor.current = {
        ix: Math.max(0, Math.min(1, (e.clientX - image.left) / image.width)),
        iy: Math.max(0, Math.min(1, (e.clientY - image.top) / image.height)),
        sx: e.clientX - bounds.left, sy: e.clientY - bounds.top,
      };
      const dpr = window.devicePixelRatio || 1;
      const width = (detail ? paintSize.width : current.width || paintSize.width) / dpr;
      const height = (detail ? paintSize.height : current.height || paintSize.height) / dpr;
      const fitScale = Math.min(el.clientWidth / Math.max(1, width), el.clientHeight / Math.max(1, height));
      setZoom(wheelZoom(zoomRef.current ?? fitScale, e.deltaY, e.ctrlKey, fitScale));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [current?.imgid, current?.width, current?.height, detail, paintSize]);
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
      if (photo !== null && !["f","k","z","escape","arrowleft","arrowright","0","1","2","3","4","5","6","7","8","9","x"].includes(k)) { e.stopImmediatePropagation(); return; }
      if (!["f","k","z","escape","arrowleft","arrowright","0","1","2","3","4","5","6","7","8","9","x"].includes(k)) return;
      if (!photo && !targets.length && k !== "f" && k !== "k") return;
      if (targets.length && k !== "escape") return;
      if (!photo && !target && !chosen.length) return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (k === "escape") { if (targets.length) setTargets([]); else setPhoto(null); }
      else if (k === "f") { direction.current = 1; setPhoto(photo ? null : target?.imgid ?? null); }
      else if (k === "k") void keywords(current ? [current] : keywordTargets(allImages, selection, target?.imgid));
      else if (k === "z" && current) { zoomAnchor.current = null; setZoom(zoomRef.current === null ? 1 : null); }
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
  useEffect(() => () => {
    const state = animation.current;
    if (state) cancelAnimationFrame(state.frame);
    animation.current = null;
  }, [photo]);
  // Retarget the active animation when better pixels arrive; do not restart it
  // from the current rectangle. That restart made previews visibly bounce.
  const targetWidth = detailed ? (detail ? paintSize.width : current?.width || paintSize.width) / devicePixelRatio * zoom! : paintSize.width;
  const targetHeight = detailed ? (detail ? paintSize.height : current?.height || paintSize.height) / devicePixelRatio * zoom! : paintSize.height;
  const box = viewport.current;
  const factor = detailed ? 1 : box
    ? Math.min(box.clientWidth / Math.max(1, targetWidth), box.clientHeight / Math.max(1, targetHeight)) : 1;
  targetSize.current = { width: Math.max(1, targetWidth * factor), height: Math.max(1, targetHeight * factor) };
  zooming.current = detailed;
  useEffect(() => {
    const image = canvas.current, viewportBox = viewport.current;
    if (!image || !viewportBox || !current) return;
    const w = detailed ? (detail ? paintSize.width : current.width || paintSize.width) / devicePixelRatio * zoom! : paintSize.width;
    const h = detailed ? (detail ? paintSize.height : current.height || paintSize.height) / devicePixelRatio * zoom! : paintSize.height;
    const scale = detailed ? 1 : Math.min(viewportBox.clientWidth / Math.max(1, w),
      viewportBox.clientHeight / Math.max(1, h));
    targetSize.current = { width: Math.max(1, w * scale), height: Math.max(1, h * scale) };
    if (animation.current) return;
    const rect = image.getBoundingClientRect();
    animation.current = { frame: 0, width: rect.width || targetSize.current.width,
      height: rect.height || targetSize.current.height };
    const step = () => {
      const state = animation.current;
      if (!state) return;
      const target = targetSize.current;
      state.width = easeZoom(state.width, target.width);
      state.height = easeZoom(state.height, target.height);
      image.style.width = state.width + "px"; image.style.height = state.height + "px";
      if (!zooming.current) { viewportBox.scrollLeft *= 1 - ZOOM_EASE; viewportBox.scrollTop *= 1 - ZOOM_EASE; }
      else {
        const anchor = zoomAnchor.current ?? {ix:.5, iy:.5, sx:viewportBox.clientWidth/2, sy:viewportBox.clientHeight/2};
        viewportBox.scrollLeft = state.width * anchor.ix - anchor.sx + Math.max(0, (viewportBox.clientWidth - state.width) / 2);
        viewportBox.scrollTop = state.height * anchor.iy - anchor.sy + Math.max(0, (viewportBox.clientHeight - state.height) / 2);
      }
      if (state.width !== target.width || state.height !== target.height) state.frame = requestAnimationFrame(step);
      else animation.current = null;
    };
    animation.current.frame = requestAnimationFrame(step);
  }, [zoom, detail, paintSize, fitted.width, fitted.height, photo]);
  useLayoutEffect(() => {
    if (!current) {
      ++previewEpoch.current;
      for (const bitmap of previews.current.values()) bitmap.close();
      previews.current.clear();
      return;
    }
    let stale = false;
    const epoch = previewEpoch.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = queue.current;
    q.replace();
    setDetail(false); setBusy(true); setError("");
    if (!detailed && canvas.current) canvas.current.getContext("2d")?.clearRect(0, 0, canvas.current.width, canvas.current.height);
    const box = viewport.current;
    const size = detailed ? 0 : Math.ceil(Math.max(box?.clientWidth ?? window.innerWidth * .86,
      box?.clientHeight ?? window.innerHeight * .86) * devicePixelRatio);
    const draw = (bitmap: ImageBitmap) => {
      if (!stale && canvas.current) {
        if (!detailed && viewport.current && canvas.current) {
          const scale = Math.min(viewport.current.clientWidth / bitmap.width, viewport.current.clientHeight / bitmap.height);
          canvas.current.style.width = bitmap.width * scale + "px";
          canvas.current.style.height = bitmap.height * scale + "px";
        }
        setPaintSize({width: bitmap.width, height: bitmap.height});
        canvas.current.width = bitmap.width; canvas.current.height = bitmap.height;
        canvas.current.getContext("2d")?.drawImage(bitmap, 0, 0);
      }
    };
    // Borrow the grid bitmap only for this synchronous draw; its loader owns it.
    // A virtual copy is looked up by imgid, never by the shared original path.
    const small = thumbnail(current.imgid);
    if (!detailed && small && canvas.current) {
      if (!detailed && viewport.current && canvas.current) {
        const scale = Math.min(viewport.current.clientWidth / small.width, viewport.current.clientHeight / small.height);
        canvas.current.style.width = small.width * scale + "px";
        canvas.current.style.height = small.height * scale + "px";
      }
      setPaintSize({width: small.width, height: small.height});
      canvas.current.width = small.width; canvas.current.height = small.height;
      canvas.current.getContext("2d")?.drawImage(small, 0, 0);
    }
    const key = (entry: ImageEntry, requested: number) =>
      JSON.stringify([entry.imgid, entry.path, entry.version, entry.edited, requested]);
    const load = async (entry: ImageEntry, requested: number) => {
      const id = key(entry, requested);
      const cached = previews.current.get(id);
      if (cached) return cached;
      const bitmap = await fetchCachedThumb(entry, requested) ?? await fetchThumb(entry.imgid, requested, entry);
      if (epoch !== previewEpoch.current) { bitmap.close(); return null; }
      if (requested === 0) return bitmap;
      previews.current.set(id, bitmap);
      while (previews.current.size > 8) {
        const oldest = previews.current.keys().next().value!;
        previews.current.get(oldest)!.close(); previews.current.delete(oldest);
      }
      return bitmap;
    };
    const show = async () => {
      const cached = previews.current.get(key(current, size));
      if (cached) draw(cached);
      else await q.enqueue(async () => {
        await prepare(current.imgid);
        if (stale) return;
        const bitmap = await load(current, size);
        if (bitmap) { draw(bitmap); if (size === 0) bitmap.close(); }
      });
      if (stale) return;
      setDetail(detailed); setBusy(false);
      if (detailed) return;
      // Let navigation settle before starting speculative native rendering.
      timer = setTimeout(() => {
        const { count, both } = loadReadAhead();
        for (const neighbor of previewNeighbors(images, current.imgid, direction.current, count, both)) {
          void q.enqueue(async () => { await load(neighbor, size); }).catch(() => {});
        }
      }, 180);
    };
    void show().catch(e => { if (!stale) { setError(String(e)); setBusy(false); } });
    return () => { stale = true; clearTimeout(timer); q.replace(); };
  }, [current?.imgid, current?.version, current?.edited, detailed, retry]);
  useEffect(() => { setZoom(null); }, [photo]);
  useEffect(() => () => { queue.current.replace(); ++previewEpoch.current; for (const bitmap of previews.current.values()) bitmap.close(); previews.current.clear(); ++keywordGeneration.current; }, []);
  useEffect(() => {
    if (targets.length && lists.length === targets.length)
      document.querySelector<HTMLInputElement>("[data-grid-keywords-dialog] input")?.focus();
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
      if (result.some(r => r.status === "rejected")) setError(t("library.culling.updateError"));
    } finally { setWriting(false); }
  };
  const shared = lists.length === targets.length ? (lists[0] ?? []).filter(k => lists.every(l => l.includes(k))) : [];
  return <>
    {current && <div className="modal-backdrop" style={{ zIndex: 1000, background: "rgba(0, 0, 0, .65)" }}
      onClick={e => { if (e.target === e.currentTarget) setPhoto(null); }} role="dialog" aria-modal="true" aria-label={t("library.culling.preview")}>
      {([-1, 1] as const).map(dir => {
        const next = images[images.indexOf(current) + dir];
        return <button key={dir} className={`culling-arrow ${dir < 0 ? "previous" : "next"}`}
          style={dir < 0 ? { left: `max(4px, calc(50% - ${fitted.width / 2 + 40}px))` }
            : { right: `max(4px, calc(50% - ${fitted.width / 2 + 40}px))` }}
          disabled={!next} aria-label={t(dir < 0 ? "library.culling.previous" : "library.culling.next")}
          title={t(dir < 0 ? "library.culling.previous" : "library.culling.next")}
          onClick={() => { if (next) { direction.current = dir; setPhoto(next.imgid); } }} />;
      })}
      <div className="culling-lightbox" style={fitted}>
        <div>{current.filename} · {images.indexOf(current) + 1}/{images.length}
          <button onClick={() => setPhoto(null)}>{t("library.culling.close")}</button><button onClick={() => void keywords([current])}>{t("library.culling.keywords")}</button>
          <button onClick={() => { zoomAnchor.current = null; setZoom(zoomRef.current === null ? 1 : null); }}>{detailed ? t("library.toolbar.fit") : "100%"}</button>
          <button onClick={() => onEdit(current)}>{t("library.culling.edit")}</button>
</div>
        <div ref={viewport} style={{ flex: 1, overflow: "auto", minHeight: 0,
          cursor: detailed && spaceHeld ? (panning ? "grabbing" : "grab") : detailed ? "zoom-out" : "zoom-in" }}
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
              setZoom(zoomRef.current === null ? 1 : null);
            }
          }}
          onDoubleClick={() => { if (!panClick.current && !space.current) onEdit(current); }}
          onPointerDown={e => {
            panClick.current = false;
            if (!detailed || !space.current || e.button !== 0) return;
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
        <div className="culling-bottom-bar">
          <span className="tool-group" role="group" aria-label={t("library.culling.rating")}>
            <button className={`tool${current.rejected ? " on" : ""}`} aria-label={t("library.culling.reject")} aria-pressed={current.rejected}
              title={t("library.culling.rejectShortcut")} onClick={() => onMeta(current, { rejected: !current.rejected })}><BanIcon /></button>
            {[1, 2, 3, 4, 5].map(n => <button key={n} className="tool"
              aria-label={t("library.culling.stars", { count: n })} aria-pressed={!current.rejected && current.rating >= n}
              title={t("library.culling.starsClear", { count: n })}
              onClick={() => onMeta(current, { rating: current.rating === n ? 0 : n, rejected: false })}>
              <StarIcon filled={!current.rejected && current.rating >= n} />
            </button>)}
          </span>
          <span className="tool-group" role="group" aria-label={t("library.culling.labels")}>
            {LABEL_COLORS.map((color, n) => {
              const name = t(["library.culling.red", "library.culling.yellow", "library.culling.green", "library.culling.blue", "library.culling.purple"][n]);
              return <button key={color} className={`swatch${current.labels & (1 << n) ? " on" : ""}`}
                style={{ background: color }} aria-label={t("library.culling.colorLabel", { color: name })} aria-pressed={!!(current.labels & (1 << n))}
                title={t(n < 4 ? "library.culling.colorLabelShortcut" : "library.culling.colorLabel", { color: name, key: n + 6 })}
                onClick={() => onMeta(current, { labels: current.labels ^ (1 << n) })} />;
            })}
          </span>
          <span className="culling-status" role="status">{busy ? t("library.culling.loading") : ""}</span>
        </div>
        {error && <div role="alert">{error}<button onClick={() => setRetry(n => n + 1)}>{t("library.culling.retry")}</button></div>}
      </div>
    </div>}
    {!!targets.length && <div className="modal-backdrop" data-grid-keywords-dialog role="dialog" aria-label={t("library.culling.gridKeywords")}>
      <div className="modal"><h2>{t("library.culling.keywordPhotos", { count: targets.length })}</h2>
        <fieldset disabled={writing} style={{ border: 0, padding: 0 }}>
        {lists.length === targets.length && <KeywordingPanel keywords={shared} known={known} open onToggle={() => {}}
          onAdd={names => { if (!writing) void change(names, []); }}
          onRemove={name => { if (!writing) void change([], [name]); }} />}
        </fieldset>
        {error && <p role="alert">{error}</p>}<button disabled={writing} onClick={() => { ++keywordGeneration.current; setTargets([]); }}>{t("library.culling.close")}</button>
      </div>
    </div>}
  </>;
}
