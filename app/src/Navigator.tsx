// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useState } from "react";
import { type Zoom, type Placement, ZOOMS } from "./zoom";

// the whole image, the zoom levels, and a rectangle over the part the
// viewer shows; dragging the rectangle pans
export function Navigator({ thumb, zoom, placement: p, disabled, onZoom, onPan }: {
  thumb: React.RefObject<HTMLCanvasElement | null>; zoom: Zoom; placement: Placement | null;
  disabled: boolean; onZoom: (z: Zoom) => void; onPan: (x: number, y: number, done: boolean) => void;
}) {
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const zoomed = zoom !== "fit" && p && p.scale > 0;
  // the visible window as fractions of the image
  const rect = zoomed ? {
    w: Math.min(1, p.width / (p.fullWidth * p.scale)),
    h: Math.min(1, p.height / (p.fullHeight * p.scale)),
    x: p.x / (p.fullWidth * p.scale),
    y: p.y / (p.fullHeight * p.scale),
  } : null;
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const shown = rect && live
    ? { ...rect, x: live.x - rect.w / 2, y: live.y - rect.h / 2 } : rect;
  return (
    <div className="navigator">
      <div className="nav-head">
        <span>Navigator</span>
        <span className="segmented small nav-zooms">
          {ZOOMS.map(([z, label]) => (
            <button key={label} className={z === zoom ? "active" : ""} disabled={disabled}
                    onClick={() => onZoom(z)}>{label}</button>
          ))}
        </span>
      </div>
      <div className="nav-image">
        <div className="nav-pic"
             onPointerDown={(e) => {
               if (!zoomed) return;
               (e.target as HTMLElement).setPointerCapture(e.pointerId);
               const a = at(e); setLive(a); onPan(a.x, a.y, false);
             }}
             onPointerMove={(e) => { if (live) { const a = at(e); setLive(a); onPan(a.x, a.y, false); } }}
             onPointerUp={(e) => { if (live) { const a = at(e); setLive(null); onPan(a.x, a.y, true); } }}>
          <canvas ref={thumb} />
          {shown && (
            <div className="nav-rect" style={{
              left: `${shown.x * 100}%`, top: `${shown.y * 100}%`,
              width: `${shown.w * 100}%`, height: `${shown.h * 100}%`,
            }} />
          )}
        </div>
      </div>
    </div>
  );
}
