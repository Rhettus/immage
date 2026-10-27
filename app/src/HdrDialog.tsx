// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Merge to HDR's dialog, as Lightroom's HDR Merge asks: whether to align
// the brackets, before darktable's HDR merge writes the DNG (App.tsx,
// runHdrMerge). alignment needs an engine built with OpenCV (hdr_can_align)
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const ALIGN_KEY = "immage.hdrAlign";
function loadAlign(): boolean {
  try { return localStorage.getItem(ALIGN_KEY) !== "false"; } catch { return true; }
}

export function HdrDialog({ count, onRun, onClose }: {
  count: number;
  onRun: (align: boolean) => void;
  onClose: () => void;
}) {
  const [align, setAlign] = useState(loadAlign);
  // null until the engine answers
  const [canAlign, setCanAlign] = useState<boolean | null>(null);
  useEffect(() => { invoke<boolean>("hdr_can_align").then(setCanAlign).catch(() => setCanAlign(false)); }, []);
  const run = () => {
    try { localStorage.setItem(ALIGN_KEY, String(align)); } catch { /* not kept */ }
    onClose();
    onRun(align && !!canAlign);
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal hdr-merge">
        <div className="modal-head"><h2>HDR Merge</h2></div>
        <div className="modal-body">
          <label className="row check" title={canAlign === false ? "this build cannot align photos" : undefined}>
            <input type="checkbox" checked={align && canAlign !== false} disabled={!canAlign}
                   onChange={(e) => setAlign(e.target.checked)} />
            Auto Align
          </label>
          <p className="note-plain">
            darktable's HDR merge combines the {count} raw exposures into a new DNG beside the first, with
            the range of them all. Auto Align lines up photos taken handheld; a tripod's need none
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" autoFocus onClick={run}>Merge</button>
        </div>
      </div>
    </div>
  );
}
