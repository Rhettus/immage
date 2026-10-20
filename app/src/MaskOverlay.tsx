// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// drawing and editing a mask's shapes over the image, and its overlay.
// the container is placed over the whole image by the viewer (App's
// placeLayers), so a point here is simply a fraction of the image
import { useEffect, useRef, useState } from "react";
import { flipMode, isRange, mapPixels, overlayPixels, type Rgb, type Brush, type Ellipse, type Gradient, type Mask, type RangeMap,
         type Region, type Shape } from "./masks";

// parametric is made from the menu at once; picker is its set range picker
export type MaskTool = "ellipse" | "gradient" | "brush" | "color" | "luminance" | "parametric" | "object" | "depth"
  | "picker";
// what the AI object tool asks for: a click, or a box dragged around it
export type ObjectPrompt = { points?: [number, number, number][]; box?: [number, number, number, number] };
export type BrushSettings = { size: number; hardness: number; density: number; erase: boolean };

const HANDLE = 6; // CSS pixels

export function MaskOverlay({ boxRef, image, region, mask, peek, ranges, final, shaping, tool, brush, showOverlay, adding, newMask, subtract, selected,
                              onSelect, onChange, onCreate, onPick, onObject, onPickArea, onHoverPick, color, overlayColor }: {
  boxRef: React.RefObject<HTMLDivElement | null>;
  image: { w: number; h: number };       // the shown image at 100%, for its aspect
  region: Region | null;                 // zoomed in, the part of the image the sharp render shows
  mask: Mask | null;
  peek: Mask | null;                     // a mask whose name the pointer rests on: its overlay shows
  ranges: RangeMap | null;               // the engine's map of the shown mask's ranges
  final: RangeMap | null;                // darktable's mask, refinements and all, when it has some (or of `at`)
  shaping: boolean;                      // a slider shaping the mask is moving: its overlay shows
  tool: MaskTool | null;                 // drawing a new shape
  brush: BrushSettings;
  showOverlay: boolean;
  adding: boolean;                       // a tool in hand adds to this mask or takes from it
  newMask: boolean;                      // a drawn shape starts a mask of its own
  subtract: boolean;                     // a drawn shape takes away from the mask
  selected: number;                      // the shape with handles
  onSelect: (k: number) => void;
  onChange: (shapes: Shape[], done: boolean) => void;
  onCreate: (shape: Shape) => void;
  onPick: (x: number, y: number) => void; // a range tool's click
  onObject: (prompt: ObjectPrompt) => void;
  onPickArea: (area: [number, number, number, number] | null, at: [number, number]) => void; // the set range picker
  onHoverPick: ((at: [number, number] | null) => void) | null;  // the show picker: the pointer over the image, or off it
  color: Rgb | null;                     // the selected mask's overlay in another color than its own
  overlayColor: Rgb;                     // the overlay's color, from Preferences
}) {
  const W = image.w, H = image.h, diag = Math.hypot(W, H);
  const svg = useRef<SVGSVGElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const fine = useRef<HTMLCanvasElement>(null);
  const [cssWidth, setCssWidth] = useState(1);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  // ⌥ held: the brush takes away, as its erase switch does
  const [alt, setAlt] = useState(false);
  // a press on the image or a handle: the overlay shows whatever its toggle
  // says until the release
  const [pressed, setPressed] = useState(false);
  // the pointer over the image: the selected shape's guides show
  const [hover, setHover] = useState(false);
  const hoverPick = useRef(onHoverPick);
  hoverPick.current = onHoverPick;
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = boxRef.current?.getBoundingClientRect();
      const inside = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setHover(inside);
      hoverPick.current?.(inside ? [(e.clientX - r!.left) / r!.width, (e.clientY - r!.top) / r!.height] : null);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [boxRef]);
  const drag = useRef<{ kind: string; k: number; start: [number, number]; shape: Shape } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCssWidth(el.clientWidth || 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [boxRef]);

  // the overlay: of the whole image, computed small and stretched, and
  // zoomed in, a sharper one of the part shown, cut out of the other
  useEffect(() => {
    const c = overlay.current, fc = fine.current;
    if (!c || !fc) return;
    const clear = () => { c.width = 0; fc.width = 0; };
    const base = newMask || !mask ? { name: "", shapes: [], invert: false, values: {} } : mask;
    // the draft's mode reads on what shows; an inverted mask turns it round
    const d = draft && base.invert ? { ...draft, mode: flipMode(draft.mode) } : draft;
    const shapes = d ? [...base.shapes, d] : base.shapes;
    const peeking = peek && !draft && !pressed;
    const shown = peeking ? peek
      : (showOverlay || pressed || draft) && (mask || draft) ? { ...base, shapes } : null;
    // a hidden mask does nothing to the photo, so neither does its overlay,
    // until a shape is drawn or dragged on it, a tool adds to it, or a slider shapes it
    if (shown?.hidden && !draft && !pressed && !shaping && !(adding && !peeking)) { clear(); return; }
    if (!shown || !shown.shapes.length) { clear(); return; }
    // a range mask waits for its map: without one it would read as the whole image
    const ranged = shown.shapes.some(isRange);
    // a peeked mask is not the one being edited: it keeps the overlay's color
    const tone = (!peeking && color) || overlayColor;
    // shapes being drawn or dragged show as drawn; the engine's map would lag
    const engine = final && !draft && !pressed ? final : null;
    const at: Region | null = engine ? engine.at ?? [0, 0, 1, 1] : region && (!ranged || ranges) ? region : null;
    // a fitted view's map is the whole image, give or take its rounding
    const whole = !!at && at[0] < 0.005 && at[1] < 0.005 && at[2] > 0.995 && at[3] > 0.995;
    const paint = (cv: HTMLCanvasElement, img: ImageData) => {
      cv.width = img.width;
      cv.height = img.height;
      cv.getContext("2d")!.putImageData(img, 0, 0);
    };
    if (at) {
      paint(fc, engine ? mapPixels(engine, tone) : overlayPixels(shown, 640, W, H, ranges, tone, at));
      Object.assign(fc.style, { left: `${100 * at[0]}%`, top: `${100 * at[1]}%`,
                                width: `${100 * (at[2] - at[0])}%`, height: `${100 * (at[3] - at[1])}%` });
    } else fc.width = 0;
    if (whole || (ranged && !ranges)) { c.width = 0; return; }
    paint(c, overlayPixels(shown, 320, W, H, ranges, tone));
    // the sharp part shows through a hole, so the two tints never add up
    c.style.clipPath = at ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${100 * at[0]}% ${100 * at[1]}%, `
      + `${100 * at[2]}% ${100 * at[1]}%, ${100 * at[2]}% ${100 * at[3]}%, ${100 * at[0]}% ${100 * at[3]}%, `
      + `${100 * at[0]}% ${100 * at[1]}%)` : "";
  }, [mask, peek, ranges, final, region?.join(), shaping, adding, draft, showOverlay, pressed, newMask, W, H, color?.join(), overlayColor.join()]);

  const unit = W / cssWidth;     // image pixels per CSS pixel
  const hr = HANDLE * unit;
  const at = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };

  // a new shape from a drag between two points
  const fromDrag = (t: MaskTool, [x0, y0]: [number, number], [x1, y1]: [number, number]): Shape | null => {
    if (t === "ellipse") {
      const rx = Math.max(0.02, Math.abs(x1 - x0)), ry = Math.max(0.02, (Math.abs(y1 - y0) * H) / W);
      const moved = Math.abs(x1 - x0) + Math.abs(y1 - y0) > 0.01;
      return { type: "ellipse", x: x0, y: y0, rx: moved ? rx : 0.15, ry: moved ? ry : 0.15, angle: 0, feather: 0.5 };
    }
    if (t === "gradient") {
      const dx = (x1 - x0) * W, dy = (y1 - y0) * H, len = Math.hypot(dx, dy);
      if (len < 4 * unit) return null;
      return { type: "gradient", x: (x0 + x1) / 2, y: (y0 + y1) / 2,
               angle: (Math.atan2(dy, dx) * 180) / Math.PI, width: len / diag };
    }
    return null;
  };

  const shapes = mask?.shapes ?? [];
  const sel = shapes[selected];

  // dragging a handle of the selected shape
  const editShape = (kind: string, s: Shape, from: [number, number], to: [number, number]): Shape => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    if (isRange(s) || s.type === "object") return s;
    if (kind === "move" && s.type !== "brush") return { ...s, x: s.x + dx, y: s.y + dy };
    if (kind === "move" && s.type === "brush")
      return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
    if (s.type === "ellipse") {
      const a = (s.angle * Math.PI) / 180, px = (to[0] - s.x) * W, py = (to[1] - s.y) * H;
      const along = (px * Math.cos(a) + py * Math.sin(a)) / W, across = (-px * Math.sin(a) + py * Math.cos(a)) / W;
      if (kind === "rx") return { ...s, rx: Math.max(0.01, Math.abs(along)) };
      if (kind === "ry") return { ...s, ry: Math.max(0.01, Math.abs(across)) };
      if (kind === "rotate") return { ...s, angle: (Math.atan2(py, px) * 180) / Math.PI + 90 };
      if (kind === "feather") return { ...s, feather: Math.min(0.95, Math.max(0, 1 - Math.abs(along) / s.rx)) };
    }
    if (s.type === "gradient" && kind === "end") {
      const px = (to[0] - s.x) * W, py = (to[1] - s.y) * H;
      return { ...s, angle: (Math.atan2(py, px) * 180) / Math.PI, width: Math.max(0.005, (2 * Math.hypot(px, py)) / diag) };
    }
    return s;
  };

  const handle = (kind: string, x: number, y: number, k: number, cls = "") => (
    <circle key={kind} className={`mh ${cls}`} cx={x} cy={y} r={hr}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture(e.pointerId);
              setPressed(true);
              onSelect(k);
              drag.current = { kind, k, start: at(e), shape: shapes[k] };
            }} />
  );

  // the rotate handle: a curved double arrow around its point, along the
  // circle it turns on
  const rotateHandle = (x: number, y: number, k: number, angle: number) => {
    const r = hr * 2.2;
    const a0 = -0.55, a1 = 0.55;
    const pt = (t: number) => [x + r * Math.sin(t), y - r * Math.cos(t) + r] as const;
    const [sx, sy] = pt(a0), [ex, ey] = pt(a1);
    const head = (px: number, py: number, dir: number) => {
      const t = Math.atan2(py - (y + r), px - x) + (dir * Math.PI) / 2;
      const h = hr * 1.1;
      return `M${px + h * Math.cos(t + 2.6)},${py + h * Math.sin(t + 2.6)} L${px},${py} L${px + h * Math.cos(t - 2.6)},${py + h * Math.sin(t - 2.6)}`;
    };
    return (
      <g key="rotate" transform={`rotate(${angle} ${x} ${y})`}>
        <path className="rot-arrow" d={`M${sx},${sy} A${r},${r} 0 0 1 ${ex},${ey} ${head(sx, sy, -1)} ${head(ex, ey, 1)}`} />
        {handle("rotate", x, y, k, "rot")}
      </g>
    );
  };

  // the selected shape's outline and feather, while the pointer is near
  const guides = (s: Shape) => {
    if (s.type === "ellipse") {
      const tr = `rotate(${s.angle} ${s.x * W} ${s.y * H})`, inner = 1 - s.feather;
      return (
        <g className="guide">
          <ellipse cx={s.x * W} cy={s.y * H} rx={s.rx * W} ry={s.ry * W} transform={tr} />
          <ellipse className="feather" cx={s.x * W} cy={s.y * H} rx={s.rx * W * inner} ry={s.ry * W * inner} transform={tr} />
        </g>
      );
    }
    if (s.type === "gradient") {
      const a = (s.angle * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a), half = (s.width * diag) / 2;
      const line = (off: number, cls: string) => {
        const cx = s.x * W + c * off, cy = s.y * H + sn * off;
        return <line key={off} className={cls} x1={cx - sn * diag} y1={cy + c * diag} x2={cx + sn * diag} y2={cy - c * diag} />;
      };
      return <g className="guide">{line(-half, "")}{line(0, "feather")}{line(half, "")}</g>;
    }
    return null;
  };

  const handles = (s: Shape, k: number) => {
    if (isRange(s) || s.type === "object") return [];
    if (s.type === "ellipse") {
      const a = (s.angle * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
      const cx = s.x * W, cy = s.y * H, rx = s.rx * W, ry = s.ry * W, inner = 1 - s.feather;
      return [
        handle("move", cx, cy, k, "center"),
        handle("rx", cx + c * rx, cy + sn * rx, k),
        handle("ry", cx - sn * ry, cy + c * ry, k),
        rotateHandle(cx + sn * ry * 1.25, cy - c * ry * 1.25, k, s.angle),
        handle("feather", cx - c * rx * inner, cy - sn * rx * inner, k, "feather"),
      ];
    }
    if (s.type === "gradient") {
      const a = (s.angle * Math.PI) / 180, half = (s.width * diag) / 2;
      return [handle("move", s.x * W, s.y * H, k, "center"),
              handle("end", s.x * W + Math.cos(a) * half, s.y * H + Math.sin(a) * half, k)];
    }
    const [x, y] = s.points[0];
    return [handle("move", x * W, y * H, k, "center")];
  };

  const painting = tool === "brush";
  const boxing = tool === "object" || tool === "picker";
  const [box, setBox] = useState<[number, number, number, number] | null>(null);
  const picking = tool === "color" || tool === "luminance" || tool === "depth";
  return (
    <>
      <canvas ref={overlay} className="mask-tint" />
      <canvas ref={fine} className="mask-tint" />
      <svg ref={svg} className={`mask-svg${tool ? " drawing" : ""}${picking ? " picking" : ""}`} viewBox={`0 0 ${W} ${H}`}
           preserveAspectRatio="none"
           onPointerDown={(e) => {
             if (!tool) return;
             // drawing, not panning the viewer underneath
             e.stopPropagation();
             if (picking) {
               const [x, y] = at(e);
               onPick(x, y);
               return;
             }
             if (boxing) {
               const p = at(e);
               drag.current = { kind: "box", k: -1, start: p, shape: shapes[0] };
               setBox([p[0], p[1], p[0], p[1]]);
               return;
             }
             (e.target as Element).setPointerCapture(e.pointerId);
             const p = at(e);
             // marked from the start, so the overlay clears as it is painted
             const start: Shape = painting
               ? { type: "brush", points: [p], size: brush.size, hardness: brush.hardness, density: brush.density,
                   mode: subtract || brush.erase || e.altKey ? "subtract" : "add" }
               : fromDrag(tool, p, p) ?? { type: "gradient", x: p[0], y: p[1], angle: 90, width: 0.001 };
             drag.current = { kind: "create", k: -1, start: p, shape: start };
             setPressed(true);
             setDraft(painting ? start : null);
           }}
           onPointerMove={(e) => {
             const p = at(e);
             if (painting) { setCursor(p); setAlt(e.altKey); }
             const d = drag.current;
             if (!d) return;
             if (d.kind === "box") {
               setBox([d.start[0], d.start[1], p[0], p[1]]);
               return;
             }
             if (d.kind === "create") {
               if (painting) {
                 const b = d.shape as Brush;
                 const [lx, ly] = b.points[b.points.length - 1];
                 // a point every quarter brush width keeps the stroke smooth and small
                 if (Math.hypot((p[0] - lx) * W, (p[1] - ly) * H) >= (b.size * W) / 4) {
                   d.shape = { ...b, points: [...b.points, p] };
                   setDraft(d.shape);
                 }
               } else {
                 const s = fromDrag(tool!, d.start, p);
                 setDraft(s && subtract ? { ...s, mode: "subtract" } : s);
               }
               return;
             }
             const next = shapes.slice();
             next[d.k] = editShape(d.kind, d.shape, d.start, p);
             onChange(next, false);
           }}
           onPointerUp={(e) => {
             const d = drag.current;
             drag.current = null;
             setPressed(false);
             if (!d) return;
             if (d.kind === "box") {
               const [x0, y0] = d.start, [x1, y1] = at(e);
               setBox(null);
               // a click picks what is under it, a drag what is inside
               const click = Math.abs(x1 - x0) * W + Math.abs(y1 - y0) * H < 8 * unit;
               if (tool === "picker") {
                 onPickArea(click ? null : [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)], [x0, y0]);
                 return;
               }
               if (click) onObject({ points: [[x0, y0, 1]] });
               else onObject({ box: [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)] });
               return;
             }
             if (d.kind === "create") {
               const s = painting ? d.shape : fromDrag(tool!, d.start, at(e));
               setDraft(null);
               if (s) onCreate(s);
               return;
             }
             onChange(shapes.slice(), true);
           }}
           onPointerLeave={() => setCursor(null)}>
        {tool && <rect className="mask-catch" x={0} y={0} width={W} height={H} />}
        {/* the overlay shows the mask; guides only while the pointer is
            near, for the feather and edges the handles move */}
        {!tool && sel && (hover || pressed) && !isRange(sel) && guides(sel)}
        {!tool && sel && handles(sel, selected)}
        {/* a gradient being dragged out shows its guides and handles as it
            grows, for show only: the drag is still drawing it */}
        {tool && !painting && draft && (draft.type === "gradient" || draft.type === "ellipse") && (
          <g className="draft-handles">{guides(draft)}{handles(draft, -1)}</g>
        )}
        {box && (
          <rect className="object-box" x={Math.min(box[0], box[2]) * W} y={Math.min(box[1], box[3]) * H}
                width={Math.abs(box[2] - box[0]) * W} height={Math.abs(box[3] - box[1]) * H} />
        )}
        {/* Lightroom's brush: its edge, the inner circle where the feather
            starts, and a minus while it takes away */}
        {painting && cursor && (
          <g className="brush-cursor">
            <circle cx={cursor[0] * W} cy={cursor[1] * H} r={(brush.size / 2) * W} />
            {brush.hardness < 0.98 && (
              <circle className="inner" cx={cursor[0] * W} cy={cursor[1] * H} r={(brush.size / 2) * W * brush.hardness} />
            )}
            {(subtract || brush.erase || alt) && (
              <line x1={cursor[0] * W - 5 * unit} y1={cursor[1] * H} x2={cursor[0] * W + 5 * unit} y2={cursor[1] * H} />
            )}
          </g>
        )}
      </svg>
    </>
  );
}

export type { Brush, Ellipse, Gradient };
