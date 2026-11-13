// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the wavelet curve editor of an Advanced card for denoiseprofile and
// rawdenoise (the layout's `bands`), after denoiseprofile.c and rawdenoise.c:
// a curve per channel over the module's bands, dragged by pulling the bands
// near the pointer (a radius the wheel changes), a double-click resetting the
// channel. no histogram is drawn behind it, as darktable draws none
import { useEffect, useRef, useState } from "react";
import { bandCurve, grabOffset, pull, pullRange, RES, startRadius, wheelRadius } from "./bands";
import type { ModuleLayout } from "./advancedLayout";
import type { AdvancedState } from "./session";

type Bands = NonNullable<ModuleLayout["bands"]>;

const W = 260, H = 130, INSET = 5, PW = W - 2 * INSET, PH = H - 2 * INSET;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function ModuleBands({ op, bands, state, disabled, onFields }: {
  op: string; bands: Bands; state: AdvancedState; disabled: boolean;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const p = state.params, d = state.defaults;
  const tabs = bands.tabs(p);
  const [tab, setTab] = useState(0);
  const key = tabs.map((t) => t.ch).join();
  // the tab set changed (RGB to Y0U0V0 and back): gui_changed picks the first
  useEffect(() => { setTab(0); }, [key]);
  const cur = tabs[Math.min(tab, tabs.length - 1)];
  const ch = cur.ch;
  const read = (c: number) => ({
    xs: Array.from({ length: bands.count }, (_, k) => p[`x[${c}][${k}]`] ?? d[`x[${c}][${k}]`] ?? k / (bands.count - 1)),
    ys: Array.from({ length: bands.count }, (_, k) => p[`y[${c}][${k}]`] ?? d[`y[${c}][${k}]`] ?? 0.5),
  });
  const { xs, ys } = read(ch);

  const svg = useRef<SVGSVGElement>(null);
  const [radius, setRadius] = useState(startRadius(bands.count));
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // a drag works from the bands as they were at the press (drag_params), with
  // the pointer's x held where it began
  const grab = useRef<{ x: number; pick: number; ys: number[]; last: number[] } | null>(null);
  const id = `${op}-bands-${ch}`;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const px = (e.clientX - r.left) * (W / r.width) - INSET, py = (e.clientY - r.top) * (H / r.height) - INSET;
    return { x: clamp01(px / PW), y: 1 - clamp01(py / PH) };
  };
  const send = (v: number[], coalesce: boolean) =>
    onFields(Object.fromEntries(v.map((y, k) => [`y[${ch}][${k}]`, y])), coalesce, id);

  // the wheel needs preventDefault, which React's passive listener cannot do
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    if (disabled) return;
    e.preventDefault();
    const dy = e.deltaMode === 0 ? e.deltaY / 100 : e.deltaY;
    if (e.altKey) {
      // alt+scroll switches the channel tab
      if (dy) setTab((t) => (Math.min(t, tabs.length - 1) + (dy > 0 ? 1 : tabs.length - 1)) % tabs.length);
      return;
    }
    if (dy) setRadius((r) => wheelRadius(r, dy, bands.count));
  };
  useEffect(() => {
    const el = svg.current;
    const f = (e: WheelEvent) => wheel.current(e);
    el?.addEventListener("wheel", f, { passive: false });
    return () => el?.removeEventListener("wheel", f);
  }, []);

  const px = (x: number) => INSET + x * PW, py = (y: number) => INSET + (1 - y) * PH;
  const line = (ysamples: number[]) => ysamples.map((v, k) => `${k ? "L" : "M"}${px(k / (RES - 1))},${py(v)}`).join("");
  const curveY = (xv: number[], yv: number[]) => {
    const f = bandCurve(xv, yv);
    return Array.from({ length: RES }, (_, k) => f(k / (RES - 1)));
  };
  // the highlighted region and focus circle show while hovering or dragging
  const active = hover && (hover.y > 0 || grab.current) ? hover : null;
  const mx = grab.current ? grab.current.x : active?.x ?? 0;
  const range = active && !disabled ? pullRange(xs, ys, mx, radius) : null;
  const unselected = tabs.filter((t) => t.ch !== ch);

  return (
    <div className="module-card-curve module-card-bands" data-bands={op}>
      <div className="segmented small module-card-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button key={t.ch} role="tab" aria-selected={t.ch === ch} className={t.ch === ch ? "active" : ""} title={t.title}
                  data-bands-channel={t.label} onClick={() => setTab(i)}>{t.label}</button>
        ))}
      </div>
      <svg ref={svg} className={`curve bands-area${disabled ? " disabled" : ""}`} viewBox={`0 0 ${W} ${H}`}
           aria-label={`${op} ${cur.label} wavelet curve`}
           onPointerMove={(e) => {
             if (disabled) return;
             const m = at(e);
             if (grab.current) {
               // the pointer's x stays where the drag began
               const g = grab.current;
               g.last = pull(xs, g.ys, g.x, m.y + g.pick, radius);
               send(g.last, true);
               setHover({ x: g.x, y: m.y });
               return;
             }
             setHover(m);
           }}
           onPointerLeave={() => { if (!grab.current) setHover(null); }}
           onPointerDown={(e) => {
             if (disabled || e.button !== 0) return;
             const m = at(e);
             grab.current = { x: m.x, pick: grabOffset(xs, ys, m.x, m.y), ys, last: ys };
             setHover(m);
             svg.current!.setPointerCapture(e.pointerId);
           }}
           onPointerUp={() => {
             if (!grab.current) return;
             const last = grab.current.last;
             grab.current = null;
             send(last, false);   // the release ends the undo step
           }}
           onDoubleClick={() => {
             if (disabled) return;
             // double-click puts the channel's bands back to the module's defaults
             grab.current = null;
             onFields(Object.fromEntries(Array.from({ length: bands.count }, (_, k) => [
               [`x[${ch}][${k}]`, d[`x[${ch}][${k}]`] ?? k / (bands.count - 1)],
               [`y[${ch}][${k}]`, d[`y[${ch}][${k}]`] ?? 0.5]]).flat()), false, id);
           }}>
        <rect x={0} y={0} width={W} height={H} className="bands-frame" />
        <rect x={INSET} y={INSET} width={PW} height={PH} className="bands-bg" />
        {Array.from({ length: 7 }, (_, i) => (i + 1) / 8).flatMap((g) => [
          <line key={`v${g}`} x1={px(g)} y1={INSET} x2={px(g)} y2={INSET + PH} className="grid" />,
          <line key={`h${g}`} x1={INSET} y1={py(g)} x2={INSET + PW} y2={py(g)} className="grid" />])}
        {range && <path d={`${line(range[0])}${range[1].map((v, k) => `L${px((RES - 1 - k) / (RES - 1))},${py(range[1][RES - 1 - k])}`).join("")}Z`}
                        className="bands-range" />}
        {/* the other channels faintly, the selected one last and solid */}
        {unselected.map((t) => {
          const r = read(t.ch);
          return <path key={t.ch} d={line(curveY(r.xs, r.ys))} stroke={t.color} className="bands-curve bands-curve-dim" />;
        })}
        <path d={line(curveY(xs, ys))} stroke={cur.color} className="bands-curve" />
        {xs.map((x, k) => <circle key={k} cx={px(x)} cy={py(ys[k])} r={3} className="bands-knot" />)}
        {active && !disabled && (
          <circle cx={px(mx)} cy={py(bandCurve(xs, ys)(mx))} r={radius * PW} className="bands-focus" />
        )}
        <text className="bands-label" transform={`translate(${INSET + 0.02 * PW + 8},${INSET + PH / 2}) rotate(-90)`} textAnchor="middle">coarse</text>
        <text className="bands-label" transform={`translate(${INSET + 0.98 * PW - 2},${INSET + PH / 2}) rotate(-90)`} textAnchor="middle">fine</text>
        <text className="bands-label" x={INSET + PW / 2} y={INSET + 0.08 * PH + 4} textAnchor="middle">smooth</text>
        <text className="bands-label" x={INSET + PW / 2} y={INSET + 0.97 * PH - 2} textAnchor="middle">noisy</text>
      </svg>
    </div>
  );
}
