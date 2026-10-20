// Lightroom's point curve: click to add a point, drag to move it between its
// neighbors, double-click or drag it off the graph to remove it. the end
// points stay but may move
import { useRef } from "react";
import { MAX_NODES, monotone, type Point } from "./tonecurve";
import { histogramPath, type Histogram } from "./histogram";

const W = 260, H = 260, R = 5;
const GAP = 0.01; // the least x distance between neighbors

// a point on a W x H curve graph, with guides to both axes
export type CurveMark = { x: number; y: number };
export function CurveMarkView({ mark: { x, y }, W, H }: { mark: CurveMark; W: number; H: number }) {
  const px = x * W, py = (1 - y) * H;
  return (
    <g className="probe-mark">
      <line x1={px} y1={H} x2={px} y2={py} />
      <line x1={0} y1={py} x2={px} y2={py} />
      <circle cx={px} cy={py} r={4} />
    </g>
  );
}

export function PointCurve({ points, disabled, histogram, channel = null, draw = monotone, mark = null, onChange }: {
  points: Point[]; disabled: boolean; histogram: Histogram | null;
  mark?: CurveMark | null;                        // the photo under the pointer, on the curve
  channel?: 0 | 1 | 2 | null;                     // whose histogram, and the curve's color
  draw?: (p: Point[]) => (x: number) => number;   // the curve as it will be applied
  onChange: (p: Point[]) => void;
}) {
  const hist = histogramPath(histogram, W, H, channel);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);

  const at = (e: React.MouseEvent): Point => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  };
  const clampAt = (pts: Point[], k: number, [x, y]: Point): Point => {
    const lo = k === 0 ? 0 : pts[k - 1][0] + GAP;
    const hi = k === pts.length - 1 ? 1 : pts[k + 1][0] - GAP;
    return [Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))];
  };
  const nearest = (p: Point) => {
    let best = -1, dist = Infinity;
    points.forEach(([x, y], k) => {
      const d = Math.hypot((x - p[0]) * W, (y - p[1]) * H);
      if (d < dist) { dist = d; best = k; }
    });
    return dist <= 3 * R ? best : -1;
  };

  const f = draw(points);
  const d = Array.from({ length: 101 }, (_, i) => i / 100)
    .map((x, i) => `${i ? "L" : "M"}${(x * W).toFixed(1)},${((1 - Math.min(1, Math.max(0, f(x)))) * H).toFixed(1)}`)
    .join(" ");

  return (
    <svg ref={svg} className={`curve point-curve${disabled ? " disabled" : ""}`} viewBox={`0 0 ${W} ${H}`}
         preserveAspectRatio="none"
         onPointerDown={(e) => {
           if (disabled) return;
           const p = at(e);
           let k = nearest(p);
           if (k < 0) {
             if (points.length >= MAX_NODES) return;
             // a new point lands where clicked, between its neighbors
             k = points.findIndex(([x]) => x > p[0]);
             if (k <= 0) return;
             const next = [...points.slice(0, k), p, ...points.slice(k)];
             next[k] = clampAt(next, k, p);
             onChange(next);
           }
           drag.current = k;
           svg.current!.setPointerCapture(e.pointerId);
         }}
         onPointerMove={(e) => {
           const k = drag.current;
           if (k === null) return;
           const p = at(e);
           const inner = k > 0 && k < points.length - 1;
           // dragged well off the graph: an inner point goes
           if (inner && (p[1] < -0.15 || p[1] > 1.15)) {
             drag.current = null;
             onChange(points.filter((_, i) => i !== k));
             return;
           }
           const next = points.slice();
           next[k] = clampAt(next, k, p);
           onChange(next);
         }}
         onPointerUp={() => { drag.current = null; }}
         onDoubleClick={(e) => {
           const k = nearest(at(e));
           if (k > 0 && k < points.length - 1) onChange(points.filter((_, i) => i !== k));
         }}>
      {hist && <path d={hist} className="hist" />}
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g}>
          <line x1={g * W} y1={0} x2={g * W} y2={H} className="grid" />
          <line x1={0} y1={g * H} x2={W} y2={g * H} className="grid" />
        </g>
      ))}
      <line x1={0} y1={H} x2={W} y2={0} className="identity" />
      <path d={d} className={`line${channel === null ? "" : ` ch${channel}`}`} />
      {mark && <CurveMarkView mark={mark} W={W} H={H} />}
      {points.map(([x, y], k) => (
        <circle key={k} cx={x * W} cy={(1 - y) * H} r={R} className={`pt${channel === null ? "" : ` ch${channel}`}`} />
      ))}
    </svg>
  );
}
