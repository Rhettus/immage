// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { PanelIcon, ResetIcon } from "./icons";
import { Layout, PanelKey } from "./layoutPrefs";
import { invert } from "./probe";
import { keys } from "./keys";
import { useEffect, useRef } from "react";
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
// and out to half of Fit (1:2) to the left, evenly in ratio; near the middle
// it snaps to Fit, and a double-click goes between Fit and 100%
export const ZOOM_MAX = 4;
export const ZOOM_OUT = 2;
export function ZoomBar({ disabled, register, onZoom, onToggle, fit }: {
  disabled: boolean;
  register: (show: (z: number, isFit: boolean) => void) => void;
  onZoom: (z: Zoom) => void; onToggle: () => void; fit: () => number;
}) {
  const range = useRef<HTMLInputElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const toPos = (z: number) => {
    const f = fitRef.current();
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
             aria-label={t("library.toolbar.zoomHint")}
             onChange={(e) => {
               const p = Number(e.target.value), f = fit();
               onZoom(Math.abs(p) < 25 ? "fit" : p <= -1000 ? "half" : p > 0 ? f * (ZOOM_MAX / f) ** (p / 1000) : f * ZOOM_OUT ** (p / 1000));
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

// The bottom bar marks the selection and controls zoom and panels.
export function Toolbar({ marking,
                   layout, zoomBar, viewTools, onLayout, ref, pin, grid, rightPanel, rightPanelTitle }: {
  ref: React.RefObject<HTMLDivElement | null>;
  viewTools: React.ReactNode;
  grid: boolean;
  pin: React.ReactNode;
  marking: React.ReactNode;
  layout: Layout; zoomBar: React.ReactNode;
  rightPanel: "right" | "find"; rightPanelTitle?: string;
  onLayout: (k: PanelKey) => void;
}) {
  return (
    <div className="toolbar" ref={ref}>
      {marking}
      {zoomBar}
      {/* down here rather than over the photo, where they covered the crop
          handles and whatever was being edited in that corner */}
      <div className="tool-group view-tools">
        {viewTools}
        <span className="sep" />
        <div className="panel-toggles" role="group" aria-label={t("library.toolbar.panels")}>
          {([ ["left", "library.toolbar.libraryPanel", "left"], ["strip", "library.toolbar.filmstripLabel", "bottom"], [rightPanel, rightPanel === "find" ? "library.toolbar.findPanel" : "library.toolbar.adjustmentsPanel", "right"] ] as const).map(([key, labelKey, side]) => {
            const visible = layout[key];
            const label = rightPanel === key && rightPanelTitle ? rightPanelTitle : t(labelKey);
            return <button key={key} className={`tool panel-toggle${visible ? " on" : ""}`} data-panel-toggle={key}
                          title={t(visible ? "library.toolbar.hidePanel" : "library.toolbar.showPanel", { panel: label })}
                          aria-label={t(visible ? "library.toolbar.hidePanel" : "library.toolbar.showPanel", { panel: label })}
                          aria-pressed={visible} onClick={() => onLayout(key)}>
              <PanelIcon side={side} />
            </button>;
          })}
        </div>
        {/* the filmstrip's pin, after the panel switches rather than among them */}
        {pin}
      </div>
    </div>
  );
}
