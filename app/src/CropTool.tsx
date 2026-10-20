// Lightroom's crop overlay: the whole image with the crop drawn over it,
// the outside dimmed, a rule-of-thirds grid inside, handles on the corners
// and edges. the rectangle is in fractions of the uncropped frame, which
// are crop's own left/top/right/bottom
import { useRef } from "react";

export type CropRect = { l: number; t: number; r: number; b: number };
export const FULL: CropRect = { l: 0, t: 0, r: 1, b: 1 };

// Lightroom's presets. a fixed ratio is [long side, short side]; it is laid
// landscape or portrait by the crop's orientation
export type Aspect = { id: string; label: string; ratio: [number, number] | "original" | null };
export const ASPECTS: Aspect[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "original", label: "Original", ratio: "original" },
  { id: "1:1", label: "1 × 1", ratio: [1, 1] },
  { id: "5:4", label: "4 × 5 / 8 × 10", ratio: [5, 4] },
  { id: "7:5", label: "5 × 7", ratio: [7, 5] },
  { id: "3:2", label: "2 × 3 / 4 × 6", ratio: [3, 2] },
  { id: "4:3", label: "3 × 4", ratio: [4, 3] },
  { id: "16:9", label: "16 × 9", ratio: [16, 9] },
  { id: "16:10", label: "16 × 10", ratio: [16, 10] },
  { id: "2:1", label: "1 × 2", ratio: [2, 1] },
  { id: "3:1", label: "1 × 3", ratio: [3, 1] },
];

// an aspect typed in, decimals and all ("1 × 2.35"); crop keeps its ratio
// as whole numbers, so it is stored in hundredths, reduced
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const shown = (v: number) => `${Math.round(v * 100) / 100}`;
export function customAspect(a: number, b: number): Aspect | null {
  if (!(a > 0) || !(b > 0)) return null;
  const long = Math.max(a, b), short = Math.min(a, b);
  const L = Math.round(long * 100), S = Math.round(short * 100);
  if (S < 1) return null;
  const g = gcd(L, S);
  // beyond what crop_rd/crop_rn hold (manifest.ts)
  if (L / g > 10000) return null;
  return { id: `custom:${L / g}:${S / g}`, label: `${shown(short)} × ${shown(long)}`, ratio: [L / g, S / g] };
}

// the last few customs, most recent first, as Lightroom keeps them
const CUSTOM_KEY = "immage.cropCustoms";
const CUSTOM_KEEP = 5;
export function loadCustomAspects(): Aspect[] {
  try {
    const list = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    return Array.isArray(list)
      ? list.filter((a) => typeof a?.id === "string" && typeof a?.label === "string" && Array.isArray(a?.ratio))
      : [];
  } catch {
    return [];
  }
}
export function rememberCustomAspect(a: Aspect, list: Aspect[]): Aspect[] {
  const next = [a, ...list.filter((x) => x.id !== a.id)].slice(0, CUSTOM_KEEP);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(next)); } catch { /* not kept */ }
  return next;
}

export const findAspect = (id: string, customs: Aspect[]): Aspect =>
  ASPECTS.find((a) => a.id === id) ?? customs.find((a) => a.id === id) ?? ASPECTS[0];

const MIN = 0.02;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// the pixel aspect (width / height) an aspect asks for, or null for free
export function pixelAspect(a: Aspect, portrait: boolean, frame: { w: number; h: number }): number | null {
  if (a.ratio === null) return null;
  const [long, short] = a.ratio === "original"
    ? [Math.max(frame.w, frame.h), Math.min(frame.w, frame.h)] : a.ratio;
  return portrait ? short / long : long / short;
}

// the largest rectangle of that aspect around the current one's center
export function fitAspect(rect: CropRect, aspect: number, frame: { w: number; h: number }): CropRect {
  const cx = (rect.l + rect.r) / 2, cy = (rect.t + rect.b) / 2;
  // half sizes as fractions, limited by the frame edges around the center
  const maxHw = Math.min(cx, 1 - cx), maxHh = Math.min(cy, 1 - cy);
  let hw = maxHw;
  let hh = (hw * frame.w) / (frame.h * aspect);
  if (hh > maxHh) { hh = maxHh; hw = (hh * frame.h * aspect) / frame.w; }
  return { l: cx - hw, r: cx + hw, t: cy - hh, b: cy + hh };
}

type Handle = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

// how far past square a corner drag goes before the aspect turns, so it
// does not flicker at the diagonal
const FLIP_MARGIN = 1.05;

export function CropOverlay({ rect, box, frame, aspect, onChange, onOrient }: {
  rect: CropRect;
  box: { left: number; top: number; width: number; height: number }; // the image on screen
  frame: { w: number; h: number };  // its pixel size, for the aspect
  aspect: number | null;
  onChange: (r: CropRect) => void;
  onOrient: (portrait: boolean) => void;  // a corner dragged across the diagonal turned the aspect
}) {
  // the aspect is kept with the drag, so a move that comes before the
  // turned aspect is drawn does not turn it back
  const drag = useRef<{ handle: Handle; x: number; y: number; start: CropRect; aspect: number | null } | null>(null);

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / box.width, dy = (e.clientY - d.y) / box.height;
    const s = d.start;
    if (d.handle === "move") {
      const w = s.r - s.l, h = s.b - s.t;
      const l = clamp(s.l + dx, 0, 1 - w), t = clamp(s.t + dy, 0, 1 - h);
      onChange({ l, t, r: l + w, b: t + h });
      return;
    }
    let { l, t, r, b } = s;
    if (d.handle.includes("w")) l = clamp(s.l + dx, 0, s.r - MIN);
    if (d.handle.includes("e")) r = clamp(s.r + dx, s.l + MIN, 1);
    if (d.handle.includes("n")) t = clamp(s.t + dy, 0, s.b - MIN);
    if (d.handle.includes("s")) b = clamp(s.b + dy, s.t + MIN, 1);
    // as in Lightroom, a corner dragged across the diagonal turns the aspect
    // between landscape and portrait
    if (d.aspect !== null && Math.abs(d.aspect - 1) > 1e-3 && d.handle.length === 2) {
      const w = (r - l) * frame.w, h = (b - t) * frame.h;
      if (d.aspect > 1 ? h > w * FLIP_MARGIN : w > h * FLIP_MARGIN) {
        d.aspect = 1 / d.aspect;
        onOrient(d.aspect < 1);
      }
    }
    if (d.aspect !== null) ({ l, t, r, b } = constrain(d.handle, { l, t, r, b }, s, d.aspect, frame));
    onChange({ l, t, r, b });
  };

  const handles: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const px = (f: number, size: number) => `${f * size}px`;
  return (
    <div className="crop-overlay" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
         onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
      {/* the dimmed outside, as four bands */}
      <div className="crop-shade" style={{ left: 0, top: 0, right: 0, height: px(rect.t, box.height) }} />
      <div className="crop-shade" style={{ left: 0, bottom: 0, right: 0, height: px(1 - rect.b, box.height) }} />
      <div className="crop-shade" style={{ left: 0, top: px(rect.t, box.height), width: px(rect.l, box.width),
                                            height: px(rect.b - rect.t, box.height) }} />
      <div className="crop-shade" style={{ right: 0, top: px(rect.t, box.height), width: px(1 - rect.r, box.width),
                                            height: px(rect.b - rect.t, box.height) }} />
      <div className="crop-rect"
           style={{ left: px(rect.l, box.width), top: px(rect.t, box.height),
                    width: px(rect.r - rect.l, box.width), height: px(rect.b - rect.t, box.height) }}
           onPointerDown={(e) => {
             (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
             drag.current = { handle: "move", x: e.clientX, y: e.clientY, start: rect, aspect };
           }}>
        <div className="crop-grid" />
        {handles.map((h) => (
          <span key={h} className={`crop-handle ${h}`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  (e.currentTarget.closest(".crop-overlay") as HTMLElement).setPointerCapture(e.pointerId);
                  drag.current = { handle: h, x: e.clientX, y: e.clientY, start: rect, aspect };
                }} />
        ))}
      </div>
    </div>
  );
}

// keep the aspect while a handle is dragged: a corner keeps the opposite
// corner fixed, an edge keeps the rectangle centered across it
function constrain(handle: Handle, r: CropRect, start: CropRect, aspect: number,
                   frame: { w: number; h: number }): CropRect {
  // height fraction for a width fraction, and back
  const hFor = (w: number) => (w * frame.w) / (frame.h * aspect);
  const wFor = (h: number) => (h * frame.h * aspect) / frame.w;
  let w = r.r - r.l, h = r.b - r.t;
  if (handle === "n" || handle === "s") w = wFor(h);
  else if (handle === "e" || handle === "w") h = hFor(w);
  else if (hFor(w) > h) h = hFor(w); else w = wFor(h);

  // anchor at the fixed side, then shrink to stay inside the frame
  const anchorX = handle.includes("w") ? start.r : handle.includes("e") ? start.l : (start.l + start.r) / 2;
  const anchorY = handle.includes("n") ? start.b : handle.includes("s") ? start.t : (start.t + start.b) / 2;
  const roomX = handle.includes("w") ? anchorX : handle.includes("e") ? 1 - anchorX
              : 2 * Math.min(anchorX, 1 - anchorX);
  const roomY = handle.includes("n") ? anchorY : handle.includes("s") ? 1 - anchorY
              : 2 * Math.min(anchorY, 1 - anchorY);
  if (w > roomX) { w = roomX; h = hFor(w); }
  if (h > roomY) { h = roomY; w = wFor(h); }

  const l = handle.includes("w") ? anchorX - w : handle.includes("e") ? anchorX : anchorX - w / 2;
  const t = handle.includes("n") ? anchorY - h : handle.includes("s") ? anchorY : anchorY - h / 2;
  return { l, t, r: l + w, b: t + h };
}
