// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Heal tool on the image, as Lightroom's: a click heals a round spot,
// a drag paints a stroke, and the selected spot shows where it copies from,
// both ends draggable. the others show as pins. with Visualize Spots, the
// image is replaced by its edges, where dust and specks stand out
import { useEffect, useRef, useState } from "react";
import { overlayPixels, type Region, type Rgb } from "./masks";
import { anchorOf, moveSpot, radiusOf, sourceOf, type NewSpot, type Spot } from "./spots";

export type SpotTool = { mode: "heal" | "clone"; size: number; feather: number; opacity: number };

const PIN = 6;  // a pin's radius, in CSS pixels

export function SpotOverlay({ boxRef, image, region, spots, selected, tool, visualize, base, baseTick,
                              overlayColor, onSelect, onCreate, onChange }: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  image: { w: number; h: number };       // the shown image at 100%, for its aspect
  region: Region | null;                 // zoomed in, the part of the image the sharp render shows
  spots: Spot[];
  selected: number | null;
  tool: SpotTool;
  visualize: number | null;              // Visualize Spots' threshold, 0-100, or off
  base: React.RefObject<HTMLCanvasElement | null>;  // the whole image as shown
  baseTick: number;                      // bumped when the base is redrawn
  overlayColor: Rgb;                     // the stroke's color, the masks' overlay's
  onSelect: (k: number | null) => void;
  onCreate: (spot: NewSpot) => void;
  onChange: (spots: Spot[], done: boolean) => void;
}) {
  const W = image.w, H = image.h;
  const svg = useRef<SVGSVGElement>(null);
  const edges = useRef<HTMLCanvasElement>(null);
  const paint = useRef<HTMLCanvasElement>(null);
  const fine = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(1);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const drag = useRef<{ kind: "new" | "target" | "source"; start: [number, number]; k: number; spot?: Spot;
                        points: [number, number][] } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCssWidth(el.clientWidth || 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef]);

  // Visualize Spots: a high-pass of the image's gray, light where it
  // changes; the threshold sets how faint a change shows
  useEffect(() => {
    const c = edges.current, b = base.current;
    if (!c) return;
    if (visualize === null || !b || !b.width) { c.width = 0; return; }
    const scale = Math.min(1, 1600 / b.width);
    const w = Math.max(1, Math.round(b.width * scale)), h = Math.max(1, Math.round(b.height * scale));
    const tmp = new OffscreenCanvas(w, h), tctx = tmp.getContext("2d")!;
    tctx.drawImage(b, 0, 0, w, h);
    const px = tctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let k = 0; k < w * h; k++) gray[k] = 0.299 * px[4 * k] + 0.587 * px[4 * k + 1] + 0.114 * px[4 * k + 2];
    // a 5x5 box mean, from running sums along rows then columns
    const mean = new Float32Array(w * h), row = new Float32Array(w * h), R = 2;
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        let s = 0;
        for (let d = -R; d <= R; d++) s += gray[j * w + Math.min(w - 1, Math.max(0, i + d))];
        row[j * w + i] = s / (2 * R + 1);
      }
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        let s = 0;
        for (let d = -R; d <= R; d++) s += row[Math.min(h - 1, Math.max(0, j + d)) * w + i];
        mean[j * w + i] = s / (2 * R + 1);
      }
    // low thresholds show only strong edges, high ones every speck
    const gain = 2 + (visualize / 100) * 30;
    c.width = w;
    c.height = h;
    const out = new ImageData(w, h);
    for (let k = 0; k < w * h; k++) {
      const v = Math.min(255, Math.abs(gray[k] - mean[k]) * gain);
      out.data[4 * k] = out.data[4 * k + 1] = out.data[4 * k + 2] = v;
      out.data[4 * k + 3] = 255;
    }
    c.getContext("2d")!.putImageData(out, 0, 0);
  }, [visualize, baseTick, base]);

  // the stroke being painted, as soft as it will heal, drawn as the masks'
  // brush overlay is: an SVG blur filter in the image's coordinates came out
  // blocky. zoomed in, a sharper one of the part shown is cut out of the
  // whole image's
  useEffect(() => {
    const c = paint.current, fc = fine.current;
    if (!c || !fc) return;
    if (!stroke) { c.width = 0; fc.width = 0; return; }
    const m = { name: "", invert: false, values: {},
                shapes: [{ type: "brush" as const, mode: "add" as const, points: stroke, size: tool.size,
                           hardness: 1 - tool.feather, density: 1 }] };
    const put = (cv: HTMLCanvasElement, img: ImageData) => {
      cv.width = img.width;
      cv.height = img.height;
      cv.getContext("2d")!.putImageData(img, 0, 0);
    };
    if (region) {
      put(fc, overlayPixels(m, 640, W, H, null, overlayColor, region));
      Object.assign(fc.style, { left: `${100 * region[0]}%`, top: `${100 * region[1]}%`,
                                width: `${100 * (region[2] - region[0])}%`, height: `${100 * (region[3] - region[1])}%` });
    } else fc.width = 0;
    put(c, overlayPixels(m, 320, W, H, null, overlayColor));
    c.style.clipPath = region ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${100 * region[0]}% ${100 * region[1]}%, `
      + `${100 * region[2]}% ${100 * region[1]}%, ${100 * region[2]}% ${100 * region[3]}%, ${100 * region[0]}% ${100 * region[3]}%, `
      + `${100 * region[0]}% ${100 * region[1]}%)` : "";
  }, [stroke, tool.size, tool.feather, region?.join(), W, H, overlayColor.join()]);

  const unit = W / cssWidth;  // image pixels per CSS pixel
  const at = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const near = (p: [number, number], s: Spot) => {
    const r = radiusOf(s) * W;
    if (s.type === "circle") return Math.hypot((p[0] - s.x) * W, (p[1] - s.y) * H) <= Math.max(r, PIN * unit);
    return s.points.some(([x, y]) => Math.hypot((p[0] - x) * W, (p[1] - y) * H) <= Math.max(r, PIN * unit));
  };

  // a round spot's outline; a stroke has none, as a band of its width hid
  // the very area being healed. its ends show as pins, still draggable
  // along the whole stroke (near)
  const outline = (s: Spot, cls: string) => s.type === "circle"
    ? <circle className={cls} cx={s.x * W} cy={s.y * H} r={s.r * W} />
    : null;
  const sel = selected !== null ? spots[selected] : undefined;

  return (
    <>
      <canvas ref={edges} className="spot-edges" />
      <canvas ref={paint} className="mask-tint" />
      <canvas ref={fine} className="mask-tint" />
      <svg ref={svg} className="mask-svg drawing spot-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
           onPointerDown={(e) => {
             e.stopPropagation();
             (e.target as Element).setPointerCapture(e.pointerId);
             const p = at(e);
             // the selected spot's ends first, then any pin, then a new spot
             if (sel && near(p, sourceOf(sel))) {
               drag.current = { kind: "source", start: p, k: selected!, spot: sel, points: [] };
               return;
             }
             if (sel && near(p, sel)) {
               drag.current = { kind: "target", start: p, k: selected!, spot: sel, points: [] };
               return;
             }
             const hit = spots.findIndex((s) => {
               const [x, y] = anchorOf(s);
               return Math.hypot((p[0] - x) * W, (p[1] - y) * H) <= PIN * 1.5 * unit;
             });
             if (hit >= 0) {
               onSelect(hit);
               drag.current = { kind: "target", start: p, k: hit, spot: spots[hit], points: [] };
               return;
             }
             drag.current = { kind: "new", start: p, k: -1, points: [p] };
           }}
           onPointerMove={(e) => {
             const p = at(e);
             setCursor(p);
             const d = drag.current;
             if (!d) return;
             if (d.kind === "new") {
               const [lx, ly] = d.points[d.points.length - 1];
               // a point every quarter brush width keeps the stroke smooth and small
               if (Math.hypot((p[0] - lx) * W, (p[1] - ly) * H) >= (tool.size * W) / 4) {
                 d.points = [...d.points, p];
                 setStroke(d.points);
               }
               return;
             }
             const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
             const moved = d.kind === "target"
               ? moveSpot(d.spot!, dx, dy, false)
               : { ...d.spot!, sx: d.spot!.sx + dx, sy: d.spot!.sy + dy };
             const next = spots.slice();
             next[d.k] = moved;
             onChange(next, false);
           }}
           onPointerUp={() => {
             const d = drag.current;
             drag.current = null;
             setStroke(null);
             if (!d) return;
             if (d.kind !== "new") { onChange(spots.slice(), true); return; }
             const { mode, feather, opacity, size } = tool;
             if (d.points.length < 2) onCreate({ type: "circle", x: d.start[0], y: d.start[1], r: size / 2, mode, feather, opacity });
             else onCreate({ type: "brush", points: d.points, size, mode, feather, opacity });
           }}
           onPointerLeave={() => setCursor(null)}>
        <rect className="mask-catch" x={0} y={0} width={W} height={H} />
        {spots.map((s, k) => {
          const [x, y] = anchorOf(s);
          return k === selected ? null
            : <circle key={k} className="spot-pin" cx={x * W} cy={y * H} r={PIN * unit} />;
        })}
        {sel && (
          <g className="spot-sel">
            <line className="spot-link" x1={sel.sx * W} y1={sel.sy * H} x2={anchorOf(sel)[0] * W} y2={anchorOf(sel)[1] * H} />
            {outline(sourceOf(sel), "spot-source")}
            {outline(sel, "spot-target")}
            {sel.type !== "circle" && <circle className="spot-pin source" cx={sel.sx * W} cy={sel.sy * H} r={PIN * unit} />}
            <circle className="spot-pin on" cx={anchorOf(sel)[0] * W} cy={anchorOf(sel)[1] * H} r={PIN * unit} />
          </g>
        )}
        {/* the brush's edge, and the inner circle where its feather starts */}
        {cursor && !drag.current && (
          <g className="brush-cursor">
            <circle cx={cursor[0] * W} cy={cursor[1] * H} r={(tool.size / 2) * W} />
            {tool.feather > 0.02 && (
              <circle className="inner" cx={cursor[0] * W} cy={cursor[1] * H} r={(tool.size / 2) * W * (1 - tool.feather)} />
            )}
          </g>
        )}
      </svg>
    </>
  );
}
