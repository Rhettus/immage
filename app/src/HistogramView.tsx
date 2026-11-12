// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { type ClipShow, DEFAULT_SCOPE, HARMONIES, HARMONY_WIDTHS, type Histogram, type ScopeMode, type ScopeSettings, type VecSpace, clipColor, drawScope } from "./histogram";
import { type Control, controlById } from "./manifest";
import { type Exif } from "./library";
import { type RGB } from "./probe";
import { Snapshot } from "./uiUpdates";
import { end } from "./activity";
import { exposureLine } from "./MetadataPanel";
import { icon } from "./icons";
import { open } from "@tauri-apps/plugin-dialog";
import { perf } from "./perf";
import { useDismiss } from "./MasksPanel";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useThemes } from "./themes";
import { zoneAt } from "./zones";
import { settings } from "./settings";

// Lightroom's histogram regions, left to right, and how far a drag across
// the whole histogram moves each
export const HIST_ZONES: { id: string; from: number; to: number; span: number }[] = [
  { id: "blacks", from: 0, to: 0.13, span: 200 },
  { id: "shadows", from: 0.13, to: 0.35, span: 200 },
  { id: "exposure", from: 0.35, to: 0.65, span: 4 },
  { id: "highlights", from: 0.65, to: 0.87, span: 200 },
  { id: "whites", from: 0.87, to: 1, span: 200 },
];

export function loadScope(): ScopeSettings {
  try { return { ...DEFAULT_SCOPE, ...JSON.parse(settings.get("immage.scope") ?? "{}") }; }
  catch { return DEFAULT_SCOPE; }
}

export const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

export const SCOPE_MODES: [ScopeMode, string][] = [
  ["histogram", "Histogram"], ["waveform", "Waveform"], ["parade", "RGB Parade"],
  ["vectorscope", "Vectorscope"], ["split", "Waveform + Vectorscope"],
];

// the histogram, or another of darktable's scopes chosen from the corner
// menu. on the histogram, dragging sideways in a region moves its Basic
// slider and a double-click resets it; on the RYB vectorscope, dragging
// turns the color harmony guides. the clipping triangles show their
// overlay on the photo: a click keeps it, hovering shows it for a while
export function HistogramView({ histograms, values, disabled, exif, neutral, onChange, clip, onClip, onClipPeek, scope, onScope: setScope }: {
  histograms: Snapshot<Histogram | null>; values: Record<string, number>; disabled: boolean; exif: Exif | null;
  neutral: (id: string) => number; onChange: (c: Control, v: number) => void;
  clip: ClipShow; onClip: (end: "low" | "high") => void; onClipPeek: (end: "low" | "high" | null) => void;
  scope: ScopeSettings; onScope: (change: Partial<ScopeSettings>) => void;
}) {
  const themeRevision = useThemes();
  const h = useSyncExternalStore(histograms.subscribe, histograms.get);
  const ref = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => setSize(c.clientWidth * 10000 + c.clientHeight));
    ro.observe(c);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { if (ref.current) perf.time("pixels.scopeDraw", () => drawScope(ref.current!, h, scope)); }, [h, scope, size, themeRevision]);
  const tones = scope.mode === "histogram";
  const turning = (scope.mode === "vectorscope" || scope.mode === "split")
    && scope.space === "ryb" && scope.harmony > 0;
  const [zone, setZone] = useState<number | null>(null);
  const drag = useRef<{ x: number; v0: number; width: number } | null>(null);
  const turn = useRef<{ a0: number; deg0: number } | null>(null);
  const [turnLabel, setTurnLabel] = useState(false);
  const zoneAt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width;
    const k = HIST_ZONES.findIndex((z) => f < z.to);
    return k < 0 ? HIST_ZONES.length - 1 : k;
  };
  // the pointer's angle around the vectorscope's center, in degrees, the
  // way drawScope measures the guides
  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const cx = scope.mode === "split" ? r.left + r.width * 0.75 : r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return (Math.atan2(-(e.clientX - cx), -(e.clientY - cy)) * 180) / Math.PI;
  };
  const z = zone === null || !tones ? null : HIST_ZONES[zone];
  const c = z ? controlById.get(z.id)! : null;
  const harmony = HARMONIES[scope.harmony];
  return (
    <div className={`histogram scope-${scope.mode}${disabled || !(tones || turning) ? "" : " live"}${turning ? " turning" : ""}`}>
      <div className="hist-area"
           onPointerDown={(e) => {
             if (disabled || !h) return;
             if (turning) {
               e.currentTarget.setPointerCapture(e.pointerId);
               turn.current = { a0: angleAt(e), deg0: scope.harmonyAngle };
               setTurnLabel(true);
               return;
             }
             if (!tones) return;
             const k = zoneAt(e);
             setZone(k);
             e.currentTarget.setPointerCapture(e.pointerId);
             drag.current = { x: e.clientX, v0: values[HIST_ZONES[k].id] ?? 0, width: ref.current!.clientWidth };
           }}
           onPointerMove={(e) => {
             if (disabled) return;
             const t = turn.current;
             if (t) {
               const deg = Math.round(t.deg0 + angleAt(e) - t.a0);
               setScope({ harmonyAngle: ((deg % 360) + 360) % 360 });
               return;
             }
             if (!tones) return;
             const d = drag.current;
             if (!d) { setZone(zoneAt(e)); return; }
             if (!z || !c) return;
             const v = d.v0 + ((e.clientX - d.x) / d.width) * z.span;
             const stepped = Math.round(v / c.step) * c.step;
             const next = Math.min(c.max, Math.max(c.min, stepped));
             if (next !== values[z.id]) onChange(c, next);
           }}
           onPointerUp={() => { drag.current = null; turn.current = null; setTurnLabel(false); }}
           onPointerLeave={() => { if (!drag.current) setZone(null); }}
           onDoubleClick={() => {
             if (disabled) return;
             if (turning) setScope({ harmonyAngle: 0 });
             else if (z && c) onChange(c, neutral(z.id));
           }}>
        <canvas ref={ref} />
        {z && c && !disabled && h && (
          <div className="hist-zone" style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }} />
        )}
      </div>
      <ScopeMenu scope={scope} onChange={setScope} />
      {/* the shot's exposure, as Lightroom shows it under the histogram; the
          zone under the pointer, and its value, take its place, as do the
          harmony guides while they turn */}
      <div className="hist-info">
        {turnLabel && turning
          ? <span className="hist-label">{cap(harmony.name)} <b>{scope.harmonyAngle}°</b></span>
          : z && c && !disabled && h
            ? <span className="hist-label">{c.label} <b>{c.format(values[z.id] ?? 0)}</b></span>
            : exif && exposureLine(exif).map((t) => <span key={t}>{t}</span>)}
      </div>
      {tones && (["low", "high"] as const).map((end) => {
        // lit in the color of the channels clipping there, as Lightroom's
        const color = clipColor(h, end);
        const share = end === "low" ? h?.shadowsClipped : h?.highlightsClipped;
        const what = end === "low" ? "shadow" : "highlight";
        return (
          <button key={end} className={`clip clip-${end}${clip[end] ? " on" : ""}`} disabled={disabled}
                  style={color ? { "--clip": color } as React.CSSProperties : undefined}
                  title={`${h ? `${((share ?? 0) * 100).toFixed(2)}% of pixels clip to ${end === "low" ? "black" : "white"}; ` : ""}`
                         + `click to ${clip[end] ? "hide" : "show"} ${what} clipping on the photo (J for both)`}
                  onClick={() => onClip(end)}
                  onPointerEnter={() => onClipPeek(end)} onPointerLeave={() => onClipPeek(null)} />
        );
      })}
    </div>
  );
}

// the scope's corner button and its menu: which scope, then that scope's
// own settings, as darktable's buttons over its scopes offer them
export function ScopeMenu({ scope: s, onChange }: {
  scope: ScopeSettings; onChange: (change: Partial<ScopeSettings>) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const seg = <T,>(options: [T, string][], value: T, set: (v: T) => void) => (
    <div className="segmented small">
      {options.map(([v, label]) => (
        <button key={label} className={v === value ? "active" : ""} onClick={() => set(v)}>{label}</button>
      ))}
    </div>
  );
  const vector = s.mode === "vectorscope" || s.mode === "split";
  const wave = s.mode === "waveform" || s.mode === "parade" || s.mode === "split";
  return (
    <div className={`scope-menu${open ? " open" : ""}`} ref={box}>
      <button className="scope-button" title="choose the scope" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 20h16M6 16l3-6 3 3 3-7 3 10" /></svg>
      </button>
      {open && (
        <div className="tile-menu scope-list">
          <span className="tool-kind">Scope</span>
          {SCOPE_MODES.map(([m, label]) => (
            <button key={m} className={m === s.mode ? "on" : ""} onClick={() => onChange({ mode: m })}>{label}</button>
          ))}
          {s.mode === "histogram" && <>
            <span className="tool-kind">Scale</span>
            {seg([[false, "Linear"], [true, "Logarithmic"]], s.log, (log) => onChange({ log }))}
          </>}
          {(s.mode === "histogram" || s.mode === "waveform" || s.mode === "split") && <>
            <span className="tool-kind">Channels</span>
            <div className="segmented small channels">
              {(["R", "G", "B"] as const).map((label, k) => (
                <button key={label} className={`ch-${label.toLowerCase()}${s.channels[k] ? " active" : ""}`}
                        onClick={() => {
                          const channels = [...s.channels] as ScopeSettings["channels"];
                          channels[k] = !channels[k];
                          onChange({ channels });
                        }}>{label}</button>
              ))}
            </div>
          </>}
          {wave && <>
            <span className="tool-kind">Orientation</span>
            {seg([[false, "Horizontal"], [true, "Vertical"]], s.vertical, (vertical) => onChange({ vertical }))}
          </>}
          {vector && <>
            <span className="tool-kind">Color space</span>
            {seg<VecSpace>([["luv", "u*v*"], ["jzazbz", "AzBz"], ["ryb", "RYB"]], s.space, (space) => onChange({ space }))}
            <span className="tool-kind">Scale</span>
            {seg([[false, "Linear"], [true, "Logarithmic"]], s.vecLog, (vecLog) => onChange({ vecLog }))}
            {s.space === "ryb" && <>
              <span className="tool-kind">Color harmony</span>
              <select value={s.harmony} onChange={(e) => onChange({ harmony: Number(e.target.value) })}>
                {HARMONIES.map((m, k) => <option key={m.name} value={k}>{cap(m.name)}</option>)}
              </select>
              {s.harmony > 0 && <>
                {seg(HARMONY_WIDTHS.map(([name], k) => [k, cap(name)] as [number, string]), s.harmonyWidth,
                     (harmonyWidth) => onChange({ harmonyWidth }))}
                <span className="scope-hint">drag on the scope to turn the guides, double-click to reset</span>
              </>}
            </>}
          </>}
        </div>
      )}
    </div>
  );
}
