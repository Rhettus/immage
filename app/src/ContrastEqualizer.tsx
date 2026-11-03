// SPDX-License-Identifier: GPL-3.0-or-later
import { useRef, useState } from "react";
import { EQ_CHANNELS, EQ_IDS, type Values } from "./manifest";
// the graph's 260×140 plot, with room round it for a point's handle: a
// point at either end, or at the top or bottom, was drawn half outside the
// box, cut in half, and the last one hard to hit
const PAD = 6, W = 260 + 2 * PAD, H = 140 + 2 * PAD;
// a pointer's place in plot units
const plot = (e: React.PointerEvent<SVGSVGElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  return { x: (e.clientX - r.left) / r.width * W - PAD, y: (e.clientY - r.top) / r.height * H - PAD };
};
export function ContrastEqualizer({ values, disabled, onChange }: {
  values: Values; disabled: boolean; onChange: (entries: [string, number][]) => void;
}) {
  const [channel, setChannel] = useState(0);
  const drag = useRef<number | null>(null);
  const neutral = channel < 3 ? .5 : 0;
  const id = (k: number) => `ce_${channel}_${k}`;
  const bands = Array.from({ length: 6 }, (_, k) => values[id(k)] ?? neutral);
  const update = (e: React.PointerEvent<SVGSVGElement>, k: number) => {
    onChange([[id(k), Math.round(Math.max(0, Math.min(1, 1 - plot(e).y / 140)) * 1000) / 1000]]);
  };
  const curve = bands.slice(1).reduce((path, y, i) => {
    const previous = bands[Math.max(0, i - 1)], next = bands[Math.min(5, i + 2)];
    return `${path} C${i * 52 + 52 / 3},${(1 - bands[i] - (y - previous) / 6) * 140} ${(i + 1) * 52 - 52 / 3},${(1 - y + (next - bands[i]) / 6) * 140} ${(i + 1) * 52},${(1 - y) * 140}`;
  }, `M0,${(1 - bands[0]) * 140}`);
  return <div className="contrast-equalizer">
    <div className="equalizer-heading"><span>Contrast equalizer</span><button disabled={disabled}
      onClick={() => onChange(EQ_IDS.map((id, i) => [id, i < 18 ? .5 : 0]))}>Reset</button></div>
    <select aria-label="Equalizer channel" disabled={disabled} value={channel} onChange={(e) => setChannel(+e.target.value)}>
      {EQ_CHANNELS.map((label, c) => <option key={c} value={c}>{label}</option>)}
    </select>
    <svg className="equalizer-graph" viewBox={`${-PAD} ${-PAD} ${W} ${H}`} preserveAspectRatio="none" aria-label="Contrast equalizer"
      onPointerDown={(e) => {
        if (disabled || e.button !== 0) return;
        e.preventDefault();
        const k = Math.max(0, Math.min(5, Math.round(plot(e).x / 52)));
        drag.current = k; e.currentTarget.setPointerCapture(e.pointerId); update(e, k);
      }}
      onPointerMove={(e) => { if (!disabled && drag.current !== null) update(e, drag.current); }}
      onPointerUp={(e) => {
        if (!disabled && drag.current !== null) update(e, drag.current);
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      {[.25, .5, .75].map((y) => <line key={y} x1="0" x2="260" y1={y * 140} y2={y * 140} className="eq-grid" />)}
      {bands.map((_, k) => <line key={k} x1={k * 52} x2={k * 52} y1="0" y2="140" className="eq-grid" />)}
      <line x1="0" x2="260" y1={(1 - neutral) * 140} y2={(1 - neutral) * 140} className="eq-neutral" />
      <path d={curve} />
      {bands.map((y, k) => <circle key={k} cx={k * 52} cy={(1 - y) * 140} r="4" role="slider"
        tabIndex={disabled ? -1 : 0} aria-label={`${EQ_CHANNELS[channel]} band ${k + 1}`}
        aria-valuemin={0} aria-valuemax={1} aria-valuenow={y} aria-disabled={disabled}
        onKeyDown={(e) => {
          if (disabled || !["ArrowUp", "ArrowDown", "Home"].includes(e.key)) return;
          e.preventDefault();
          onChange([[id(k), e.key === "Home" ? neutral : Math.max(0, Math.min(1,
            Math.round((y + (e.key === "ArrowUp" ? .01 : -.01)) * 1000) / 1000))]]);
        }} />)}
    </svg>
    <div className="equalizer-scale"><span>Coarse</span><span>Fine</span></div>
    <div className="equalizer-hint">Pull up to boost, down to reduce. Arrow keys adjust a focused point.</div>
  </div>;
}
