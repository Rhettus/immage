// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's parametric mask, as its blending tab shows it: a tab per
// scene-referred input channel, each a gradient slider with four markers.
// the inner two (filled, on top) are where the mask is whole, the outer
// two (open, below) where it starts to rise; a channel's polarity turns
// that round. the pickers show what the photo holds under the pointer as a
// band on the slider, or set the markers to a box dragged on it
import { useEffect, useRef, useState } from "react";
import { channelActive, defaultBoost, neutralChannel, type BlendifChannel, type ChannelRange,
         type ParametricRange, type Rgb } from "./masks";
import type { Control } from "./manifest";

export type Picked = Partial<Record<BlendifChannel, { min: number; mean: number; max: number }>>;

type Stop = [number, [number, number, number]];
const gray: Stop[] = [[0, [0, 0, 0]], [0.125, [1 / 16, 1 / 16, 1 / 16]], [0.25, [1 / 8, 1 / 8, 1 / 8]],
                      [0.5, [1 / 4, 1 / 4, 1 / 4]], [1, [1 / 2, 1 / 2, 1 / 2]]];
const ramp = (c: number): Stop[] => gray.map(([at, v]) => [at, [0, 1, 2].map((i) => (i === c ? v[0] * 1.5 : 0)) as Stop[1]]);
// darktable's slider backgrounds (blend_gui.c's _gradient_*), in display values
const CHANNELS: { id: BlendifChannel; tip: string; step: number; stops: Stop[] }[] = [
  { id: "g", tip: "gray", step: 1 / 255, stops: gray },
  { id: "R", tip: "red", step: 1 / 255, stops: ramp(0) },
  { id: "G", tip: "green", step: 1 / 255, stops: ramp(1) },
  { id: "B", tip: "blue", step: 1 / 255, stops: ramp(2) },
  { id: "Jz", tip: "luminance (of JzCzhz)", step: 1 / 100, stops: gray },
  { id: "Cz", tip: "chroma (of JzCzhz)", step: 1 / 100,
    stops: [[0, [0.5, 0.5, 0.5]], [0.125, [0.5, 0.4375, 0.5]], [0.25, [0.5, 0.375, 0.5]], [0.5, [0.5, 0.25, 0.5]],
            [1, [0.5, 0, 0.5]]] },
  { id: "hz", tip: "hue (of JzCzhz)", step: 1 / 360,
    stops: [[0, [0.75, 0.1946971, 0.3697612]], [0.082, [0.75, 0.2278141, 0.2291548]],
            [0.15, [0.75, 0.3132381, 0.165396]], [0.275, [0.7483232, 0.75, 0.1939316]],
            [0.378, [0.2642865, 0.75, 0.2642768]], [0.57, [0.023318, 0.7493543, 0.75]],
            [0.65, [0.1119025, 0.5116763, 0.75]], [0.762, [0.3331225, 0.3337235, 0.75]],
            [0.883, [0.74647, 0.2754816, 0.75]], [1, [0.75, 0.1946971, 0.3697612]]] },
];

// the mask overlay's color while a channel is edited, as darktable shows
// it: the channel's own, white for the lightness ones, and for hue the hue
// the range is centered on, from the slider's own ramp
const TINTS: Partial<Record<BlendifChannel, Rgb>> = {
  g: [235, 235, 235], R: [230, 40, 40], G: [40, 205, 60], B: [50, 110, 255], Jz: [235, 235, 235], Cz: [215, 60, 215],
};
export function channelTint(c: BlendifChannel, r: ChannelRange | undefined): Rgb {
  if (c !== "hz") return TINTS[c]!;
  const p = r?.p ?? [0, 0, 1, 1];
  let h = (p[1] + p[2]) / 2;
  // an inverted hue range selects the other side of the circle
  if (r?.invert) h = h < 0.5 ? h + 0.5 : h - 0.5;
  const stops = CHANNELS.find((x) => x.id === "hz")!.stops;
  const k = Math.max(1, stops.findIndex(([at]) => at >= h));
  const [a, va] = stops[k - 1], [b, vb] = stops[k];
  const t = b > a ? (h - a) / (b - a) : 0;
  // the ramp's colors top out at 0.75; brought up to full
  return [0, 1, 2].map((i) => Math.round(Math.min(1, (va[i] + (vb[i] - va[i]) * t) / 0.75) * 255)) as Rgb;
}

const css = (v: [number, number, number]) => `rgb(${v.map((x) => Math.round(Math.min(1, x) * 255)).join(",")})`;

// a marker's value as darktable prints it: percent of the channel's
// boosted scale, the hue in degrees
function print(c: BlendifChannel, v: number, boost: number): string {
  if (c === "hz") return `${Math.round(v * 360)}°`;
  const scaled = v * 2 ** (boost - defaultBoost(c));
  const digits = scaled < 0.0001 ? 0 : scaled < 0.01 ? 2 : scaled < 0.999 ? 1 : 0;
  return (scaled * 100).toFixed(digits);
}

// one marker moved, its neighbors pushed along so the four stay in order
function move(p: ChannelRange["p"], k: number, v: number): ChannelRange["p"] {
  const q = p.slice() as ChannelRange["p"];
  q[k] = Math.min(1, Math.max(0, v));
  for (let j = k + 1; j < 4; j++) q[j] = Math.max(q[j], q[j - 1]);
  for (let j = k - 1; j >= 0; j--) q[j] = Math.min(q[j], q[j + 1]);
  return q;
}

const PAD = 7, TRACK_TOP = 13, TRACK_H = 10, TRI = 6, HEIGHT = 36;

export function ParametricEditor({ range, picked, showing, setting, disabled, renderSlider, onChange, onShow, onSet,
                                   onTab }: {
  range: ParametricRange;
  picked: Picked | null;                       // what the show picker reads under the pointer
  showing: boolean;                            // the show picker is on
  setting: BlendifChannel | null;              // the set range picker is on, for this channel
  disabled: boolean;
  renderSlider: (c: Control, value: number, onChange: (v: number) => void) => React.ReactNode;
  onChange: (channels: ParametricRange["channels"]) => void;
  onShow: (on: boolean) => void;
  onSet: (channel: BlendifChannel | null) => void;
  onTab: (channel: BlendifChannel | null) => void;   // the channel shown, for the overlay's color; null when gone
}) {
  const [tab, setTab] = useState<BlendifChannel>("g");
  useEffect(() => { onTab(tab); }, [tab]);
  useEffect(() => () => onTab(null), []);
  const [sel, setSel] = useState(1);
  const ch = CHANNELS.find((c) => c.id === tab)!;
  const cur = range.channels[tab] ?? neutralChannel(tab);
  const set = (c: BlendifChannel, r: ChannelRange) => onChange({ ...range.channels, [c]: r });

  const box = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(240);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 240));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const span = Math.max(1, width - 2 * PAD);
  const xOf = (v: number) => PAD + v * span;
  const valueAt = (e: React.PointerEvent | React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / span));
  };
  // which markers sit on top: the whole-mask pair, or the outer pair with
  // the polarity turned round
  const upper = (k: number) => ((k === 1 || k === 2) !== cur.invert);
  const dragging = useRef(-1);

  // the marker nearest a press, from the row (above or below the track) it
  // was made in, as darktable's gradient slider picks it
  const grab = (e: React.PointerEvent<SVGSVGElement>) => {
    if (disabled) return;
    const r = box.current!.getBoundingClientRect();
    const top = e.clientY - r.top < TRACK_TOP + TRACK_H / 2;
    const v = valueAt(e);
    let best = -1;
    for (let k = 0; k < 4; k++)
      if (upper(k) === top && (best < 0 || Math.abs(cur.p[k] - v) < Math.abs(cur.p[best] - v))) best = k;
    if (best < 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = best;
    setSel(best);
    set(tab, { ...cur, p: move(cur.p, best, v) });
  };
  const nudge = (d: number) => set(tab, { ...cur, p: move(cur.p, sel, cur.p[sel] + d * ch.step) });

  const pick = picked?.[tab];
  // the picker's reading in the slider's units; a hue band across 0/1 has
  // its least above its most
  const toSlider = (v: number) => (tab === "hz" ? v : Math.min(1, Math.max(0, v / 2 ** cur.boost)));
  const band = (a: number, b: number) => (
    <rect className="pm-band" x={xOf(a)} y={TRACK_TOP} width={Math.max(1, (b - a) * span)} height={TRACK_H} />
  );
  const tri = (k: number) => {
    const x = xOf(cur.p[k]), up = upper(k), filled = k === 1 || k === 2;
    // above the track pointing down at it, or below pointing up
    const pts = up
      ? `${x - TRI / 1.4},${TRACK_TOP - TRI - 1} ${x + TRI / 1.4},${TRACK_TOP - TRI - 1} ${x},${TRACK_TOP - 1}`
      : `${x - TRI / 1.4},${TRACK_TOP + TRACK_H + TRI + 1} ${x + TRI / 1.4},${TRACK_TOP + TRACK_H + TRI + 1} ${x},${TRACK_TOP + TRACK_H + 1}`;
    return <polygon key={k} points={pts} className={`pm-marker${filled ? " filled" : ""}${k === sel ? " sel" : ""}`} />;
  };
  // the values by their markers, alternately above and below as darktable
  // sets them, held inside the slider's ends
  const label = (k: number) => (
    <span key={k} className="pm-value" style={{ left: Math.min(width - 30, Math.max(0, xOf(cur.p[k]) - 15)) }}>
      {print(tab, cur.p[k], cur.boost)}</span>
  );

  return (
    <div className="parametric">
      <div className="pm-head">
        <div className="pm-tabs">
          {CHANNELS.map((c) => (
            <button key={c.id} title={`sliders for ${c.tip}`}
                    className={`${c.id === tab ? "on" : ""}${channelActive(range.channels[c.id]) ? " changed" : ""}`}
                    onClick={() => { setTab(c.id); if (setting) onSet(c.id); }}>{c.id}</button>
          ))}
        </div>
        <button className={`pm-tool${showing ? " on" : ""}`} disabled={disabled}
                title="show what the photo holds under the pointer on the slider"
                onClick={() => onShow(!showing)}>{DROPPER}</button>
        <button className={`pm-tool${setting ? " on" : ""}`} disabled={disabled}
                title="set this channel's range: drag a box on the photo, or click it"
                onClick={() => onSet(setting ? null : tab)}>{DROPPER_SET}</button>
      </div>
      <div className="pm-row">
        <button className="pm-polarity" disabled={disabled}
                title="polarity: the range is selected (+), or everything outside it (−)"
                onClick={() => set(tab, { ...cur, invert: !cur.invert })}>{cur.invert ? "−" : "+"}</button>
        <div className="pm-slider">
          <div className="pm-values top">{label(0)}{label(2)}</div>
          <svg ref={box} height={HEIGHT} tabIndex={0}
               onPointerDown={grab}
               onPointerMove={(e) => {
                 if (dragging.current < 0) return;
                 set(tab, { ...cur, p: move(cur.p, dragging.current, valueAt(e)) });
               }}
               onPointerUp={() => { dragging.current = -1; }}
               onDoubleClick={() => !disabled && set(tab, neutralChannel(tab))}
               onWheel={(e) => { if (!disabled) { e.preventDefault(); nudge(e.deltaY < 0 ? 1 : -1); } }}
               onKeyDown={(e) => {
                 if (disabled) return;
                 const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
                 if (d) { e.preventDefault(); nudge(d * (e.shiftKey ? 10 : 1)); }
               }}>
            <defs>
              <linearGradient id={`pm-${tab}`} x1="0" x2="1" y1="0" y2="0">
                {ch.stops.map(([at, v]) => <stop key={at} offset={at} stopColor={css(v)} />)}
              </linearGradient>
            </defs>
            <rect className="pm-track" x={PAD} y={TRACK_TOP} width={span} height={TRACK_H} rx={2}
                  fill={`url(#pm-${tab})`} />
            {/* the picker's band, least to most, and a line at the mean */}
            {showing && pick && (() => {
              const a = toSlider(pick.min), b = toSlider(pick.max), m = toSlider(pick.mean);
              return (
                <g>
                  {a <= b ? band(a, b) : <>{band(0, b)}{band(a, 1)}</>}
                  <line className="pm-mean" x1={xOf(m)} x2={xOf(m)} y1={TRACK_TOP} y2={TRACK_TOP + TRACK_H} />
                </g>
              );
            })()}
            {[0, 1, 2, 3].map(tri)}
          </svg>
          <div className="pm-values">{label(1)}{label(3)}
            {showing && pick && <span className="pm-picked">({print(tab, toSlider(pick.mean), cur.boost)})</span>}</div>
        </div>
      </div>
      <div className="pm-foot">
        {/* darktable's boost lifts a channel's scale past 1, shown from its
            starting point; hue has none */}
        {tab !== "hz" && renderSlider(
          { id: `pm_boost_${tab}`, label: "Boost (EV)", min: 0, max: 18, step: 0.1, neutral: 0,
            format: (v) => v.toFixed(1) },
          Math.round((cur.boost - defaultBoost(tab)) * 10) / 10,
          (v) => set(tab, { ...cur, boost: v + defaultBoost(tab) }))}
        <button className="pm-invert-all" disabled={disabled}
                title="turn every channel's polarity round"
                onClick={() => onChange(Object.fromEntries(Object.entries(range.channels)
                  .map(([c, r]) => [c, { ...r, invert: !r.invert }])))}>Invert Polarities</button>
      </div>
    </div>
  );
}

const icon = (body: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{body}</svg>
);
export const DROPPER = icon(<><path d="M14.5 4.5l5 5" /><path d="M17.5 2.5a2.1 2.1 0 0 1 3 3l-3 3-3-3z" />
  <path d="M15.5 8.5l-9 9-3 1 1-3 9-9" /></>);
const DROPPER_SET = icon(<><path d="M17.5 2.5a2.1 2.1 0 0 1 3 3l-3 3-3-3z" /><path d="M15.5 8.5l-9 9-3 1 1-3 9-9" />
  <path d="M4 3v5M1.5 5.5h5" /></>);
