// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Panorama Merge's dialog, as Lightroom's Photo Merge › Panorama asks: the
// projection and Auto Crop, before the engine stitches the photos with
// OpenCV (App.tsx, runPanoMerge). stitching needs an engine built with
// OpenCV's stitching module (pano_can_merge)
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type Projection = "auto" | "spherical" | "cylindrical" | "perspective";

const PROJECTIONS: { id: Projection; label: string; title: string }[] = [
  { id: "auto", label: "Auto", title: "chosen from how wide the panorama is" },
  { id: "spherical", label: "Spherical", title: "for very wide panoramas, and several rows" },
  { id: "cylindrical", label: "Cylindrical", title: "for wide panoramas: keeps vertical lines straight" },
  { id: "perspective", label: "Perspective", title: "for architecture: keeps straight lines straight, up to about 100°" },
];

const PROJECTION_KEY = "immage.panoProjection";
const CROP_KEY = "immage.panoCrop";
function loadProjection(): Projection {
  try {
    const v = localStorage.getItem(PROJECTION_KEY);
    return PROJECTIONS.some((p) => p.id === v) ? v as Projection : "auto";
  } catch { return "auto"; }
}
function loadCrop(): boolean {
  try { return localStorage.getItem(CROP_KEY) !== "false"; } catch { return true; }
}

export function PanoDialog({ count, onRun, onClose }: {
  count: number;
  onRun: (projection: Projection, crop: boolean) => void;
  onClose: () => void;
}) {
  const [projection, setProjection] = useState(loadProjection);
  const [crop, setCrop] = useState(loadCrop);
  // null until the engine answers
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => { invoke<boolean>("pano_can_merge").then(setCan).catch(() => setCan(false)); }, []);
  const run = () => {
    try {
      localStorage.setItem(PROJECTION_KEY, projection);
      localStorage.setItem(CROP_KEY, String(crop));
    } catch { /* not kept */ }
    onClose();
    onRun(projection, crop);
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal pano-merge">
        <div className="modal-head"><h2>Panorama Merge</h2></div>
        <div className="modal-body">
          <div className="segmented choice">
            {PROJECTIONS.map((p) => (
              <button key={p.id} className={projection === p.id ? "active" : ""} title={p.title}
                      onClick={() => setProjection(p.id)}>{p.label}</button>
            ))}
          </div>
          <label className="row check">
            <input type="checkbox" checked={crop} onChange={(e) => setCrop(e.target.checked)} />
            Auto Crop
          </label>
          {can === false
            ? <p className="note-plain warn">this build cannot stitch panoramas</p>
            : <p className="note-plain">
                the {count} raws are stitched, with OpenCV, into a new DNG beside the first, with their lens
                corrections. it opens as the first raw does, to be edited as one photo. Auto Crop cuts the empty
                edges
              </p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" autoFocus disabled={!can} onClick={run}>Merge</button>
        </div>
      </div>
    </div>
  );
}
