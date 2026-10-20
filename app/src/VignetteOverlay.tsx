// Post-Crop Vignetting's guides on the image, as darktable's vignette draws
// them: where the fall-off starts and ends (dashed), its midpoint, and its
// center. a drag on the midpoint moves it, a drag on either edge sets the
// Feather around it, and the center drags the whole vignette. they show
// while the pointer is over the photo, one of them is being dragged, or one
// of the vignette's sliders is moving
import { useEffect, useRef, useState } from "react";
import { VIG_MID, VIG_WIDTH, vignetteMap, type ImageContext, type Values } from "./manifest";

const STEPS = 128;
const clamp100 = (v: number) => Math.round(Math.min(100, Math.max(0, v)));

export function VignetteOverlay({ image, values, ctx, sliding, onChange }: {
  image: { w: number; h: number };   // the shown frame at 100%, the one vignette.c sees
  values: Values;
  ctx: ImageContext;
  sliding: boolean;   // one of the vignette's sliders is moving
  onChange: (entries: [string, number][]) => void;
}) {
  const W = image.w, H = image.h;
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<"mid" | "edge" | "center" | null>(null);
  // the box's width on screen, so the center's dot keeps its size at any zoom
  const [cssWidth, setCssWidth] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCssWidth(el.clientWidth || 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const unit = W / cssWidth;  // image pixels per CSS pixel
  // the pointer over the photo, as MaskOverlay tracks it. zoomed in, the box
  // runs under the side panels, so only the part inside the viewer counts
  const [hover, setHover] = useState(false);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = svg.current;
      const r = el?.getBoundingClientRect(), v = el?.closest(".viewer")?.getBoundingClientRect();
      const within = (b: DOMRect | undefined) => !!b
        && e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom;
      setHover(within(r) && within(v));
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // the params the engine gets, and the half-axes of the radius-1 curve as
  // fractions of the frame, after vignette.c's process(): an automatic ratio
  // follows the frame, a set one scales by the longer side
  const p = vignetteMap.write(values, {}, ctx);
  const M = Math.max(W, H);
  const [su, sv] = p.autoratio ? [0.5, 0.5]
    : p.whratio <= 1 ? [(p.whratio * M) / (2 * W), M / (2 * H)]
    : [M / (2 * W), ((2 - p.whratio) * M) / (2 * H)];
  const q = 2 / Math.max(p.shape, 0.001);   // the superellipse's exponent
  const start = p.scale / 100, end = start + p.falloff_scale / 100;
  const mid = VIG_MID(values.vig_midpoint ?? 50);
  // where the center sits, as a fraction of the frame
  const cu = ((values.vig_cx ?? 0) + 1) / 2, cv = ((values.vig_cy ?? 0) + 1) / 2;

  const curve = (r: number) => {
    const pts: string[] = [];
    for (let k = 0; k < STEPS; k++) {
      const t = (2 * Math.PI * k) / STEPS, c = Math.cos(t), s = Math.sin(t);
      const x = cu + r * su * Math.sign(c) * Math.abs(c) ** (2 / q);
      const y = cv + r * sv * Math.sign(s) * Math.abs(s) ** (2 / q);
      pts.push(`${x * W},${y * H}`);
    }
    return pts.join(" ");
  };
  const pointer = (e: React.PointerEvent): [number, number] => {
    const b = svg.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
  };
  // the radius whose curve passes through the pointer
  const radiusAt = (e: React.PointerEvent) => {
    const [u, v] = pointer(e);
    return (Math.abs((u - cu) / su) ** q + Math.abs((v - cv) / sv) ** q) ** (1 / q);
  };
  const grab = (kind: "mid" | "edge" | "center") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = kind;
    setPressed(true);
  };

  const line = (r: number, kind: "mid" | "edge", key: string) => (
    <g key={key}>
      <polygon className={`vig-line under${kind === "edge" ? " edge" : ""}`} points={curve(r)} />
      <polygon className={`vig-line${kind === "edge" ? " edge" : ""}`} points={curve(r)} />
      <polygon className={`vig-hit ${kind}`} points={curve(r)} onPointerDown={grab(kind)} />
    </g>
  );

  return (
    <svg ref={svg} className="mask-svg vig-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
         onPointerMove={(e) => {
           const d = drag.current;
           if (!d) return;
           if (d === "center") {
             const [u, v] = pointer(e);
             const at = (f: number) => Math.round(Math.min(1, Math.max(-1, 2 * f - 1)) * 1000) / 1000;
             onChange([["vig_cx", at(u)], ["vig_cy", at(v)]]);
             return;
           }
           const r = radiusAt(e);
           if (d === "mid") onChange([["vig_midpoint", clamp100((r - VIG_MID(0)) * 100)]]);
           else onChange([["vig_feather", clamp100(((2 * Math.abs(r - mid) - VIG_WIDTH(0)) * 100) / 1.35)]]);
         }}
         onPointerUp={(e) => { if (drag.current) e.stopPropagation(); drag.current = null; setPressed(false); }}>
      {(hover || pressed || sliding) && <>
        {/* a transition clipped at the center has no inner edge to show */}
        {start > 0 && line(start, "edge", "start")}
        {line(end, "edge", "end")}
        {line(mid, "mid", "mid")}
        <g className="vig-center">
          <circle className="vig-line under" cx={cu * W} cy={cv * H} r={7 * unit} />
          <circle className="vig-dot" cx={cu * W} cy={cv * H} r={6 * unit}
                  onPointerDown={grab("center")} />
        </g>
      </>}
    </svg>
  );
}
