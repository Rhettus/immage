// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Zone System module under Black & White: the image's tones as zones
// 0-X, a zone under the pointer shown over the photo, a click pinning it
// (shift-click or a drag pinning a run of zones), and the zone of the
// photo under the pointer lit in the histogram
import { useEffect, useMemo, useRef, useState } from "react";
import type { Control } from "./manifest";
import { useProbe } from "./probe";
import {
  DEFAULT_TRANSITION, PLACE_FIRST, PLACE_MAX, PLACE_NODES, ROMAN, ZONE_COLORS, ZONE_COUNT, placeInOrder,
  grayRange, grayWeights, localReverses, placeTable, placedZone, placementCrossing, placementFit, rangeCenter,
  rangeLabel, rangeStats,
  zoneMaskName as zoneMaskNameOf, zoneText, type ZoneData, type ZoneOverlay, type ZonePart, type ZoneRange,
} from "./zones";

const SOURCE_NOTE = "measured on the black and white image in scene-referred light, before the tone mapper: "
  + "zone V is 18% middle gray and each zone is one stop";

const span = (a: number, b: number): ZoneRange => [Math.min(a, b), Math.max(a, b)];
const inRange = (k: number, r: ZoneRange | null) => !!r && k >= r[0] && k <= r[1];

export function ZoneSystem({ data, unplaced, stale, error, disabled, pinned, onPin, onHover, transition, cover,
                             reach, overlay, onOverlay, onReset, children }: {
  cover: Float32Array | null;  // the part of the photo the pinned zones are narrowed to
  reach: number | null;        // the placement's transition, zones, while Placement is open
  data: ZoneData | null;
  unplaced: ZoneData | null;   // the zones before the placement, while there is one
  transition: number;          // the pinned zones' mask's, EV
  stale: boolean;           // an edit since: the bars dim until the next arrives
  error: string | null;
  disabled: boolean;
  pinned: ZoneRange | null;
  onPin: (r: ZoneRange | null) => void;
  onHover: (r: ZoneRange | null) => void;
  overlay: ZoneOverlay;
  onOverlay: (o: ZoneOverlay) => void;
  onReset?: () => void;         // every zone adjustment and the placement gone; missing when there are none
  children?: React.ReactNode;   // the adjustments of what is pinned
}) {
  const [hover, setHover] = useState<number | null>(null);
  // a drag across the bars: the zone it started from
  const dragFrom = useRef<number | null>(null);
  const [advanced, setAdvanced] = useState(false);
  // the zone of the photo under the pointer, as a whole zone: zone k holds
  // k-0.5 to k+0.5, and below 0 or above X has no column of its own
  const probeZone = useProbe(true)?.zone ?? null;
  const probed = probeZone === null ? null : probeZone < -0.5 ? "below" : probeZone >= ZONE_COUNT - 0.5 ? "above"
    : Math.round(probeZone);
  const zones = data?.stats.zones ?? new Array<number>(ZONE_COUNT).fill(0);
  const top = Math.max(1e-6, ...zones);

  const hoverRange = (k: number | null): ZoneRange | null =>
    k === null ? null : dragFrom.current !== null ? span(dragFrom.current, k) : [k, k];
  useEffect(() => { onHover(hoverRange(hover)); }, [hover]);   // eslint-disable-line react-hooks/exhaustive-deps

  const down = (k: number, e: React.PointerEvent) => {
    if (disabled) return;
    if (e.shiftKey && pinned) {
      onPin([Math.min(pinned[0], k), Math.max(pinned[1], k)]);
      return;
    }
    dragFrom.current = k;
    (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
  };
  const up = (k: number) => {
    if (dragFrom.current === null) return;
    const r = span(dragFrom.current, k);
    dragFrom.current = null;
    // a click on the pinned zone alone unpins it
    onPin(pinned && r[0] === r[1] && pinned[0] === r[0] && pinned[1] === r[1] ? null : r);
  };
  // pointer capture sends every move to the strip: find the zone under it
  const zoneAt = (e: React.PointerEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.max(0, Math.min(ZONE_COUNT - 1, Math.floor(((e.clientX - box.left) / box.width) * ZONE_COUNT)));
  };
  const key = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Escape") { onPin(null); return; }
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const d = e.key === "ArrowLeft" ? -1 : 1;
    const clamp = (k: number) => Math.max(0, Math.min(ZONE_COUNT - 1, k));
    if (!pinned) { onPin([5, 5]); return; }
    // shift grows or shrinks the run at its right end
    if (e.shiftKey) onPin(span(pinned[0], clamp(pinned[1] + d)));
    else onPin([clamp(pinned[0] + d), clamp(pinned[1] + d)]);
  };

  // the fine distribution as a line over the bars, and before the
  // placement, dashed
  const fine = data?.stats.fine ?? [];
  const ghost = unplaced?.stats.fine ?? [];
  const fineTop = Math.max(1e-6, ...fine, ...ghost);
  const W = 220, H = 64;
  const path = (f: number[]) => f.length
    ? f.map((v, k) => `${k ? "L" : "M"}${(((k + 0.5) / f.length) * W).toFixed(1)},${(H - (v / fineTop) * H * 0.95).toFixed(1)}`).join(" ")
    : "";
  const line = path(fine), ghostLine = path(ghost);

  const shown = hoverRange(hover) ?? pinned;
  const shownW = shown === pinned ? transition : DEFAULT_TRANSITION;
  const shownCover = shown === pinned ? cover : null;
  const sel = data && shown ? rangeStats(data, shown, shownW, shownCover) : null;
  const thumb = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = thumb.current;
    if (!c) return;
    if (!data || !shown) { c.getContext("2d")?.clearRect(0, 0, c.width, c.height); return; }
    c.width = data.width;
    c.height = data.height;
    // Placement shows how much of a move each pixel follows, measured on
    // the tones as they come in
    c.getContext("2d")!.putImageData(shown === pinned && reach !== null
      ? grayWeights(unplaced ?? data, placeTable(shown, reach))
      : grayRange(data, shown, shownW, shownCover), 0, 0);
  }, [data, unplaced, shown?.[0], shown?.[1], shownW, shownCover, reach]);   // eslint-disable-line react-hooks/exhaustive-deps

  const s = data?.stats;
  return (
    <section className={`zones${disabled ? " disabled" : ""}`}>
      <div className={`zone-hist${stale ? " stale" : ""}`} tabIndex={disabled ? -1 : 0} onKeyDown={key}
           role="listbox" aria-label="zones" title={SOURCE_NOTE}>
        <div className="zone-bars"
             onPointerMove={(e) => setHover(zoneAt(e))}
             onPointerLeave={() => { if (dragFrom.current === null) setHover(null); }}
             onPointerUp={(e) => { up(zoneAt(e)); setHover(null); }}>
          <svg className="zone-fine" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {ghostLine && <path d={ghostLine} className="ghost" />}
            {line && <path d={line} />}
          </svg>
          {zones.map((v, k) => (
            <div key={k} role="option" aria-selected={inRange(k, pinned)}
                 aria-label={`zone ${ROMAN[k]}: ${(v * 100).toFixed(1)}%`}
                 className={`zone-col${inRange(k, pinned) ? " pinned" : ""}${inRange(k, hoverRange(hover)) ? " hover" : ""}`
                   + `${probed === k ? " probed" : ""}`}
                 onPointerDown={(e) => down(k, e)}>
              <div className="zone-bar" style={{ height: `${(v / top) * 100}%`, background: `hsl(0 0% ${12 + k * 7.5}%)` }} />
            </div>
          ))}
        </div>
        <div className="zone-labels">
          {ROMAN.map((r, k) => (
            <span key={r} className={`${inRange(k, pinned) ? "pinned" : ""}${probed === k ? " probed" : ""}`}>{r}</span>
          ))}
        </div>
        {s && (s.below > 0.001 || s.above > 0.001) && (
          <div className="zone-clips">
            <span className={`${s.below > 0.001 ? "" : "none"}${probed === "below" ? " probed" : ""}`}
                  title="darker than zone 0">◀ {(s.below * 100).toFixed(1)}%</span>
            <span className={`${s.above > 0.001 ? "" : "none"}${probed === "above" ? " probed" : ""}`}
                  title="brighter than zone X">{(s.above * 100).toFixed(1)}% ▶</span>
          </div>
        )}
      </div>
      {error && <div className="note">{error}</div>}

      <div className="zone-inspect">
        <canvas ref={thumb} className="zone-thumb" title="the selection's mask: white is fully selected" />
        <div className="zone-facts">
          {shown && sel ? (
            <>
              <div className="zone-name">{rangeLabel(shown)}{shown === pinned ? "" : " (hover)"}</div>
              <div>{(sel.share * 100).toFixed(1)}% of the image</div>
              {!Number.isNaN(sel.mean) && <div>mean {zoneText(sel.mean)}</div>}
            </>
          ) : (
            <div className="zone-hint">point at a zone to see where it is; click to pin it, shift-click or drag for a run</div>
          )}
          {probeZone !== null && <div className="zone-probe">pointer: zone {zoneText(probeZone)}</div>}
          {s && <div className="zone-image">image: median {zoneText(s.p50)} · 5–95% {zoneText(s.p5)}–{zoneText(s.p95)}</div>}
        </div>
      </div>

      <label className="toggle">
        <span>Show mask overlay</span>
        <input type="checkbox" className="switch" checked={overlay.show} disabled={disabled}
               onChange={(e) => onOverlay({ ...overlay, show: e.target.checked })} />
      </label>

      {children}

      <button className="zone-advanced" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? "▾" : "▸"} Advanced
      </button>
      {advanced && (
        <div className="zone-adv">
          <div className="zone-adv-row">
            <span>Overlay color</span>
            <div className="presets">
              {ZONE_COLORS.map(([name, [r, g, b]]) => (
                <button key={name} className={`swatch${overlay.color === name ? " on" : ""}`} title={name}
                        aria-label={name} style={{ background: `rgb(${r},${g},${b})` }}
                        onClick={() => onOverlay({ ...overlay, color: name })} />
              ))}
            </div>
          </div>
          <label className="zone-adv-row">
            <span>Overlay opacity</span>
            <input type="range" min={10} max={100} step={5} value={Math.round(overlay.opacity * 100)}
                   onChange={(e) => onOverlay({ ...overlay, opacity: Number(e.target.value) / 100 })} />
            <span className="zone-num">{Math.round(overlay.opacity * 100)}%</span>
          </label>
          {unplaced && <div className="zone-source">dashed: the zones before Placement moved them</div>}
          <div className="zone-row">
            <button className="btn small" disabled={disabled || !onReset} onClick={onReset}
                    title="remove the placement and every zone adjustment; other edits stay">Reset zones</button>
          </div>
          <div className="zone-source">{SOURCE_NOTE}</div>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------ adjustments
// Placement moves the pinned zones to another zone on a tone curve that
// keeps tones in order (zones.ts); Local adjusts them on a zone mask of
// their own

export type ZoneMaskInfo = { name: string; range: ZoneRange; w: number; values: Record<string, number>;
                             opacity: number; edge: number; part: ZonePart | null };
type RenderSlider = (c: Control, v: number, onChange: (v: number) => void) => React.ReactNode;

// a new zone mask's transition, in EV: a wider ramp than the histogram's,
// as an exposure under it turns tones around sooner the steeper it is
export const LOCAL_TRANSITION = 1;

const sameRange = (a: ZoneRange | null, b: ZoneRange | null) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);

const ctl = (id: string, label: string, min: number, max: number, step: number, neutral: number,
             format: (v: number) => string, note?: string): Control => ({ id, label, min, max, step, neutral, format, note });
const signed = (d: number, unit = "") => (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(d)}${unit}`;

export function ZoneAdjust({ pinned, offsets, onPlace, zoneMasks, selected: sel, part, parts, partBusy, onPart,
                             onLocal, onOpacity, onTransition, onEdge, onPickMask, onDeleteMask, renderSlider,
                             onReach, disabled }: {
  pinned: ZoneRange | null;
  onReach: (transition: number | null) => void;   // the placement's transition while Placement is open
  offsets: number[];                       // the placement nodes, zones II-X, EV
  onPlace: (offsets: number[]) => void;
  zoneMasks: ZoneMaskInfo[];
  selected: ZoneMaskInfo | null;           // the pinned zones' mask for the chosen part, if made
  part: ZonePart | null;                   // the part of the photo Local narrows the zones to
  parts: [string, string][];               // the AI kinds to choose from: [kind, label]
  partBusy: boolean;
  onPart: (kind: string | null, invert: boolean) => void;
  onLocal: (range: ZoneRange, id: string, v: number) => void;
  onOpacity: (range: ZoneRange, v: number) => void;
  onTransition: (range: ZoneRange, w: number) => void;
  onEdge: (range: ZoneRange, v: number) => void;
  onPickMask: (range: ZoneRange, part: ZonePart | null) => void;
  onDeleteMask: (name: string) => void;
  renderSlider: RenderSlider;
  disabled: boolean;
}) {
  const [tab, setTab] = useState<"placement" | "local">("placement");
  const [transition, setTransition] = useState(1.5);
  // a placement is worked out from the nodes as they were when it began, so
  // a drag back returns them; an edit from elsewhere (undo) starts anew
  const base = useRef<{ offsets: number[]; range: ZoneRange; wrote: number[]; target: number } | null>(null);
  const fit = useMemo(() => placementFit(offsets), [offsets]);
  const crossing = useMemo(() => placementCrossing(fit), [fit]);

  // the range's shift as its nodes have it (zones 0 and I take zone II's)
  const shiftOf = (o: number[], r: ZoneRange) => {
    let s = 0;
    for (let k = r[0]; k <= r[1]; k++) s += o[Math.max(0, Math.min(PLACE_NODES - 1, k - PLACE_FIRST))];
    return s / (r[1] - r[0] + 1);
  };
  const live = (r: ZoneRange) => {
    const b = base.current;
    return b && sameRange(b.range, r) && same(b.wrote, offsets) ? b : null;
  };
  // the range's middle to zone `target`
  // the transition the last move needed, when wider than asked for
  const [widened, setWidened] = useState<number | null>(null);
  const reach = tab === "placement" ? widened ?? transition : null;
  useEffect(() => { onReach(reach); }, [reach]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onReach(null), []);   // eslint-disable-line react-hooks/exhaustive-deps
  const place = (r: ZoneRange, target: number, t: number) => {
    const b = live(r) ?? { offsets, range: r, wrote: offsets, target };
    const next = placeInOrder(b.offsets, r, target - rangeCenter(r) - shiftOf(b.offsets, r), t);
    setWidened(next.transition > t ? next.transition : null);
    base.current = { ...b, wrote: next.offsets, target };
    onPlace(next.offsets);
  };

  // the curve: where each zone goes, over the zones as they come in
  const W = 220, H = 120;
  const x = (z: number) => ((z + 0.5) / ZONE_COUNT) * W, y = (z: number) => H - ((z + 0.5) / ZONE_COUNT) * H;
  const curve = Array.from({ length: 111 }, (_, i) => -0.5 + i / 10)
    .map((z, i) => `${i ? "L" : "M"}${x(z).toFixed(1)},${y(Math.max(-0.5, Math.min(10.5, placedZone(z, fit)))).toFixed(1)}`).join(" ");

  const lv = (id: string) => sel?.values[id] ?? 0;
  const w = sel?.w ?? LOCAL_TRANSITION;
  const reverses = pinned && localReverses(pinned, lv("l_exposure"), w, (sel?.opacity ?? 100) / 100);

  return (
    <div className="zone-adjust">
      <div className="segmented tabs">
        <button className={tab === "placement" ? "active" : ""} onClick={() => setTab("placement")}>Placement</button>
        <button className={tab === "local" ? "active" : ""} onClick={() => setTab("local")}>Local</button>
      </div>

      {tab === "placement" && (
        <>
          <svg className="zone-curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
               aria-label="where each zone is placed">
            {pinned && <rect x={x(pinned[0] - 0.5)} y={0} width={x(pinned[1] + 0.5) - x(pinned[0] - 0.5)} height={H}
                             className="band" />}
            {Array.from({ length: ZONE_COUNT - 1 }, (_, k) => (
              <line key={k} x1={x(k + 0.5)} x2={x(k + 0.5)} y1={0} y2={H} className="grid" />
            ))}
            <line x1={0} y1={H} x2={W} y2={0} className="diag" />
            <path d={curve} className="placed" />
          </svg>
          {pinned ? (() => {
            const c = rangeCenter(pinned);
            const shift = shiftOf(offsets, pinned);
            const lo = Math.max(-0.5, c - PLACE_MAX), hi = Math.min(10.5, c + PLACE_MAX);
            const target = ctl("zp_target", "Place at", lo, hi, 0.05, c, zoneText,
                               "the zone the pinned zones' middle goes to");
            const spread = ctl("zp_transition", "Transition", 0.5, 4, 0.5, 1.5, (v) => `${v.toFixed(1)} zones`,
                               "how many zones either side follow the move, fading out");
            return (
              <>
                <div className="zone-readout">
                  {rangeLabel(pinned)} → {zoneText(c + shift)}
                  <span className="zone-dim"> (comes out at {zoneText(placedZone(c, fit))})</span>
                </div>
                {renderSlider(target, c + shift, (v) => place(pinned, v, transition))}
                {renderSlider(spread, transition, (v) => {
                  setTransition(v);
                  const b = live(pinned);
                  if (b) place(pinned, b.target, v);
                })}
                {pinned[1] < PLACE_FIRST && <div className="note">zones 0 and I move with zone II</div>}
                {widened !== null && (
                  <div className="note">transition widened to {widened.toFixed(1)} zones to keep tones in order</div>
                )}
              </>
            );
          })() : <div className="zone-hint">pin a zone or a run of zones to place it</div>}
          {crossing !== null && (
            <div className="note">tones cross over near zone {zoneText(crossing)}: widen the transition</div>
          )}
          <div className="zone-row">
            <button className="btn small" disabled={disabled || offsets.every((o) => o === 0)}
                    onClick={() => { base.current = null; onPlace(offsets.map(() => 0)); }}>Reset placement</button>
          </div>
        </>
      )}

      {tab === "local" && (
        <>
          {zoneMasks.length > 0 && (
            <div className="zone-chips">
              {zoneMasks.map((m) => (
                <span key={m.name} className={`zone-chip${m.name === sel?.name ? " on" : ""}`}>
                  <button onClick={() => onPickMask(m.range, m.part)} title="pin these zones">{m.name}</button>
                  <button className="x" onClick={() => onDeleteMask(m.name)} aria-label={`delete ${m.name}`}
                          title="delete this adjustment">×</button>
                </span>
              ))}
            </div>
          )}
          <div className="zone-parts" title="narrow the zones to a part of the photo, found by AI in its original colors">
            <span className="zone-parts-label">Color mask</span>
            <div className="segmented small">
              <button className={!part ? "active" : ""} disabled={disabled} onClick={() => onPart(null, false)}>All</button>
              {parts.map(([kind, label]) => (
                <button key={kind} className={part?.kind === kind ? "active" : ""} disabled={disabled || partBusy}
                        onClick={() => onPart(kind, part?.invert ?? false)}>{label}</button>
              ))}
            </div>
            {part && (
              <label className="zone-invert">
                <input type="checkbox" checked={part.invert} disabled={disabled}
                       onChange={(e) => onPart(part.kind, e.target.checked)} />
                everything but it
              </label>
            )}
          </div>
          {pinned ? (
            <>
              <div className="zone-readout">{zoneMaskNameOf(pinned, part)}</div>
              {renderSlider(ctl("l_exposure", "Exposure", -2, 2, 0.01, 0, signed(2, " EV")), lv("l_exposure"),
                            (v) => onLocal(pinned, "l_exposure", v))}
              {renderSlider(ctl("l_contrast", "Contrast", -100, 100, 1, 0, signed(0), "around the zones' middle"),
                            lv("l_contrast"), (v) => onLocal(pinned, "l_contrast", v))}
              {renderSlider(ctl("z_strength", "Mask strength", 0, 100, 1, 100, (v) => `${Math.round(v)}%`),
                            sel?.opacity ?? 100, (v) => onOpacity(pinned, v))}
              {renderSlider(ctl("z_transition", "Transition", 0.1, 2, 0.05, LOCAL_TRANSITION, (v) => `${v.toFixed(2)} EV`,
                                "how softly the mask fades into the neighboring zones"),
                            w, (v) => onTransition(pinned, v))}
              {renderSlider(ctl("z_edge", "Edge aware", 0, 100, 1, 0, (v) => `${Math.round(v)}`,
                                "follow the photo's edges, so the change does not halo across them"),
                            sel?.edge ?? 0, (v) => onEdge(pinned, v))}
              {reverses && (
                <div className="note">this much exposure turns tones around at the zones' edge: widen the
                  transition, lower the strength, or move them with Placement</div>
              )}
            </>
          ) : <div className="zone-hint">pin a zone or a run of zones to adjust it</div>}
        </>
      )}
    </div>
  );
}
