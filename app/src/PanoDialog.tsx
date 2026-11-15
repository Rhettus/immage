// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Panorama Merge's dialog, as Lightroom's Photo Merge › Panorama asks: the
// projection and Auto Crop, before the engine stitches the photos with
// OpenCV (App.tsx, runPanoMerge). stitching needs an engine built with
// OpenCV's stitching module (pano_can_merge)
import { useEffect, useRef, useState } from "react";
import { commands, type PanoPreview as Preview } from "./commands";
import { settings } from "./settings";
import { t, formatNumber } from "./i18n";

export type Projection = "auto" | "spherical" | "cylindrical" | "perspective";

const PROJECTIONS: { id: Projection; label: string; title: string }[] = [
  { id: "auto", label: t("dialogs.pano.auto"), title: t("dialogs.pano.autoHint") },
  { id: "spherical", label: t("dialogs.pano.spherical"), title: t("dialogs.pano.sphericalHint") },
  { id: "cylindrical", label: t("dialogs.pano.cylindrical"), title: t("dialogs.pano.cylindricalHint") },
  { id: "perspective", label: t("dialogs.pano.perspective"), title: t("dialogs.pano.perspectiveHint") },
];

// Separate from background job IDs, including across page reloads.
let nextPreviewJob = Date.now() * 1000;
// Serialize across dialog mounts: cancellation finishes before new work starts.
let pendingPreview: Promise<void> = Promise.resolve();

const PROJECTION_KEY = "immage.panoProjection";
const CROP_KEY = "immage.panoCrop";
function loadProjection(): Projection {
  try {
    const v = settings.get(PROJECTION_KEY);
    return PROJECTIONS.some((p) => p.id === v) ? v as Projection : "auto";
  } catch { return "auto"; }
}
function loadCrop(): boolean {
  try { return settings.get(CROP_KEY) !== "false"; } catch { return true; }
}

export function PanoDialog({ photos, onRun, onClose }: {
  photos: readonly { imgid: number }[];
  onRun: (projection: Projection, crop: boolean) => void;
  onClose: () => void;
}) {
  const [projection, setProjection] = useState(loadProjection);
  const [crop, setCrop] = useState(loadCrop);
  // null until the engine answers
  const [can, setCan] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const cache = useRef(new Map<string, Preview>());
  const selection = photos.map((p) => p.imgid).join(",");
  const count = photos.length;

  useEffect(() => {
    if(!can) return;
    let active = true, started = false;
    const key = `${selection}/${projection}`;
    const cached = cache.current.get(key);
    setPreview(cached ?? null);
    setError("");
    setBusy(!cached);
    if(cached) return;
    const job = nextPreviewJob++;
    // Debounce quick changes, then queue one request. Stale queued work never
    // starts, and stale replies never replace the current projection.
    const timer = window.setTimeout(() => {
      pendingPreview = pendingPreview.then(async () => {
        if(!active) return;
        started = true;
        try {
          const result = await commands.panoPreview(job, selection.split(",").map(Number), projection);
          if(active) {
            cache.current.set(key, result);
            setPreview(result);
          }
        } catch(e) {
          if(active) setError(String(e));
        } finally {
          started = false;
          if(active) setBusy(false);
        }
      });
    }, 200);
    return () => {
      active = false;
      window.clearTimeout(timer);
      if(started) void commands.mergeCancel(job).catch(() => {});
    };
  }, [can, selection, projection, retry]);

  useEffect(() => {
    const c = canvas.current;
    if(!c || !preview) return;
    const raw = atob(preview.rgba);
    const pixels = Uint8ClampedArray.from(raw, (v) => v.charCodeAt(0));
    const [x, y, w, h] = crop ? preview.crop : [0, 0, preview.width, preview.height];
    c.width = w;
    c.height = h;
    c.getContext("2d")?.putImageData(new ImageData(pixels, preview.width, preview.height), -x, -y);
  }, [preview, crop]);
  useEffect(() => { commands.panoCanMerge().then(setCan).catch(() => setCan(false)); }, []);
  const run = () => {
    try {
      settings.set(PROJECTION_KEY, projection);
      settings.set(CROP_KEY, String(crop));
    } catch { /* not kept */ }
    onClose();
    onRun(projection, crop);
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pano-merge" role="dialog" aria-modal="true" aria-labelledby="pano-title"
           onKeyDown={(e) => { if(e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <div className="modal-head"><h2 id="pano-title">{t("dialogs.pano.title")}</h2>
          <span className="pano-count">{t("dialogs.pano.selectedCount", { count: formatNumber(count) })}</span></div>
        <div className="modal-body">
          <div className="pano-preview" aria-busy={busy}>
            {preview && <canvas ref={canvas} aria-label={t("dialogs.pano.previewAlt")} />}
            {preview && <span className="pano-badge">{t("dialogs.common.preview")}</span>}
            {!preview && <div className="pano-preview-state" role="status">
              {can === false ? t("dialogs.pano.previewUnavailableBuild")
                : error ? <>{t("dialogs.pano.previewUnavailable", { error })}<button className="btn" onClick={() => setRetry((v) => v + 1)}>{t("dialogs.common.retry")}</button></>
                : <>{busy && <span className="spinner" />}{t("dialogs.pano.preparingPreview")}</>}
            </div>}
          </div>
          <div className="pano-preview-meta" aria-live="polite">
            <span>{preview ? `${projection === "auto" ? `${t("dialogs.pano.auto")} → ` : ""}${PROJECTIONS.find((p) => p.id === preview.projection)?.label}`
                          : busy ? t("dialogs.pano.buildingPreview") : ""}</span>
            <span>{preview && (crop ? t("dialogs.pano.cropOn") : t("dialogs.pano.cropOff"))}</span>
          </div>
          {preview && preview.used < count && <p className="note-plain warn" role="status">
            {t("dialogs.pano.previewOverlap", { used: formatNumber(preview.used), count: formatNumber(count) })}
          </p>}
          <div className="pano-label">{t("dialogs.pano.projection")}</div>
          <div className="segmented choice" role="group" aria-label={t("dialogs.pano.projection")}>
            {PROJECTIONS.map((p) => (
              <button key={p.id} className={projection === p.id ? "active" : ""} title={p.title} aria-pressed={projection === p.id}
                      onClick={() => setProjection(p.id)}>{p.label}</button>
            ))}
          </div>
          <p className="pano-hint">{PROJECTIONS.find((p) => p.id === projection)?.title}</p>
          <label className="row check">
            <input type="checkbox" checked={crop} onChange={(e) => setCrop(e.target.checked)} />
            <span>{t("dialogs.pano.autoCrop")}<small className="pano-crop-hint">{t("dialogs.pano.trimEdges")}</small></span>
          </label>
          {can === false
            ? <p className="note-plain warn">{t("dialogs.pano.cannotStitch")}</p>
            : <p className="note-plain">
                {t("dialogs.pano.description")}
              </p>}
        </div>
        <div className="modal-foot">
          <span className="pano-foot-status">{busy ? t("dialogs.pano.preparingPreview") : preview ? t("dialogs.pano.previewReady") : ""}</span>
          <button className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
          <button className="btn primary" autoFocus disabled={!can} onClick={run}>{t("dialogs.common.merge")}</button>
        </div>
      </div>
    </div>
  );
}
