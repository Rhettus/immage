// Lightroom's masks: each is a set of shapes, added or subtracted, with its
// own adjustment sliders. shapes live in the shown image's units (0-1
// across its width and height; radii and brush sizes as fractions of its
// width), which the engine turns into darktable's drawn masks
import { LOCAL_CONTROLS, type Values } from "./manifest";

type Mode = { mode?: "add" | "subtract" };
export type Ellipse = { type: "ellipse"; x: number; y: number; rx: number; ry: number; angle: number;
                        feather: number } & Mode;
// full effect on the side `angle` points away from, fading out across
// `width` (a fraction of the shown image's diagonal) toward `angle`
export type Gradient = { type: "gradient"; x: number; y: number; angle: number; width: number } & Mode;
export type Brush = { type: "brush"; points: [number, number][]; size: number; hardness: number;
                      density: number } & Mode;
// range components narrow the drawn shapes (or, alone, the whole image) to
// a band of scene luminance in EV, or of hue (0-1 around the circle), as
// darktable's parametric masks; their values come from the engine's sample
// (an end may be open, null, as the Zone System's zones 0 and X are)
export type LuminanceRange = { type: "luminance"; lo: number | null; hi: number | null; feather: number } & Mode;
export type ColorRange = { type: "color"; hue: number; width: number; feather: number; chroma: number } & Mode;
// darktable's parametric mask: per channel of its scene-referred input tabs,
// the four markers in the boosted 0-1 scale (the outer two where the mask
// starts to rise, the inner two where it is whole), the polarity and the
// boost in EV, as its blend parameters hold them
export type BlendifChannel = "g" | "R" | "G" | "B" | "Jz" | "Cz" | "hz";
export type ChannelRange = { p: [number, number, number, number]; invert: boolean; boost: number };
export type ParametricRange = { type: "parametric"; channels: Partial<Record<BlendifChannel, ChannelRange>> } & Mode;
export type Range = LuminanceRange | ColorRange | ParametricRange;
// an AI-selected object: its outline as darktable paths, each point
// [x, y, ctrl1x, ctrl1y, ctrl2x, ctrl2y] in shown-image units; holes cut out.
// a Depth Range is one too, traced around the band of depth it covers
// (0-1, from the nearest), with its edges feathered by `feather`
export type ObjectShape = { type: "object"; paths: { hole: boolean; points: number[][] }[];
                            depth?: [number, number]; feather?: number } & Mode;
export type Shape = Ellipse | Gradient | Brush | Range | ObjectShape;
export const isRange = (s: Shape): s is Range => s.type === "luminance" || s.type === "color" || s.type === "parametric";

// darktable's starting boost for Jz and Cz, whose values are small
// (blend.c's _blend_init_blendif_boost_parameters)
export const JZ_BOOST = -6.64385619;
export const defaultBoost = (c: BlendifChannel) => (c === "Jz" || c === "Cz" ? JZ_BOOST : 0);
export const neutralChannel = (c: BlendifChannel): ChannelRange =>
  ({ p: [0, 0, 1, 1], invert: false, boost: defaultBoost(c) });
// a channel that spans everything selects all, whatever its polarity
export const channelActive = (r: ChannelRange | undefined) => !!r && !(r.p[1] <= 0 && r.p[2] >= 1);

// limits in the channel's own units into a channel, boosted so they fit
// (as the engine's _set_channel)
function channel(lim: number[], invert: boolean): ChannelRange {
  const top = Math.max(lim[2], lim[3], 1e-6);
  const boost = top > 1 ? Math.ceil(Math.log2(top)) : 0;
  const k = 2 ** boost;
  return { p: lim.map((v) => Math.min(1, Math.max(0, v / k))) as ChannelRange["p"], invert, boost };
}

// a luminance or color range as the parametric channels it stands for, so
// a parametric component can take it over (the engine's _ranges_into)
export function rangeChannels(r: LuminanceRange | ColorRange): ParametricRange["channels"] {
  if (r.type === "luminance") {
    const f = Math.max(0.05, r.feather);
    const lim = [r.lo === null ? 0 : 2 ** (r.lo - f), r.lo === null ? 0 : 2 ** r.lo,
                 r.hi === null ? 2 ** 20 : 2 ** r.hi, r.hi === null ? 2 ** 20 : 2 ** (r.hi + f)];
    return { g: channel(lim, false) };
  }
  const w = Math.min(0.45, Math.max(0.005, r.width)), f = Math.min(0.25, Math.max(0.002, r.feather));
  let hz = channel([r.hue - w - f, r.hue - w, r.hue + w, r.hue + w + f], false);
  if (r.hue - w - f < 0 || r.hue + w + f > 1) {
    // a band across 0/1 cannot be one window; its complement can, inverted
    const c = r.hue < 0.5 ? r.hue + 0.5 : r.hue - 0.5, cw = 0.5 - w - f;
    hz = channel([c - cw - f, c - cw, c + cw, c + cw + f], true);
  }
  const cmin = Math.max(0, r.chroma);
  return { hz, Cz: channel([cmin * 0.5, cmin, 1e3, 1e3], false) };
}

// darktable's mask refinements, as its blend parameters hold them: feather
// and blur radii in pixels, detail and contrast -1-1
export type Refine = { feather: number; blur: number; detail: number; contrast: number };
export const NO_REFINE: Refine = { feather: 0, blur: 0, detail: 0, contrast: 0 };
export const isRefined = (m: Mask) => !!m.refine && Object.values(m.refine).some((v) => v !== 0);

// opacity 0-100, how strongly the adjustments apply; missing is 100.
// a hidden mask keeps its settings with its adjustments off
export type Mask = { name: string; shapes: Shape[]; invert: boolean; opacity?: number; hidden?: boolean;
                     refine?: Refine; values: Values };

export const neutralLocal = (): Values => Object.fromEntries(LOCAL_CONTROLS.map((c) => [c.id, c.neutral ?? 0]));

// "mask 1", "mask 2", ...: the first free one
// a new mask's name: what it is ("Sky", "Linear"), numbered from 2 when
// that name is taken (the caller renames the first to "<name> 1")
export function nextMaskName(masks: Mask[], base = "Mask"): string {
  if (!masks.some((m) => m.name === base || m.name === `${base} 1`)) return base;
  for (let k = 2; ; k++) if (!masks.some((m) => m.name === `${base} ${k}`)) return `${base} ${k}`;
}

// what a mask is called after its first shape
export const MASK_KIND_NAMES: Record<Shape["type"], string> = {
  ellipse: "Radial", gradient: "Linear", brush: "Brush", color: "Color Range", luminance: "Luminance Range",
  parametric: "Parametric", object: "Object",
};
export const maskKindName = (s: Shape) => (s.type === "object" && s.depth ? "Depth" : MASK_KIND_NAMES[s.type]);

// a shape's mode as drawn on what is shown: on an inverted mask, adding to
// what shows takes away from the shapes underneath, and the other way round
export const flipMode = (mode: Shape["mode"]): Shape["mode"] => (mode === "subtract" ? "add" : "subtract");

export const SHAPE_LABELS: Record<Shape["type"], string> = {
  ellipse: "Radial Gradient", gradient: "Linear Gradient", brush: "Brush",
  color: "Color Range", luminance: "Luminance Range", parametric: "Parametric", object: "Object",
};
export const shapeLabel = (s: Shape) => (s.type === "object" && s.depth ? "Depth Range" : SHAPE_LABELS[s.type]);

// what the engine's range map says over the shown image (0-255 per point)
// `at`: the part of the image the map covers, {x0, y0, x1, y1} as fractions
// of it; the whole image without
export type Region = [number, number, number, number];
export type RangeMap = { width: number; height: number; data: Uint8Array; at?: Region };

// --------------------------------------------------------- the overlay
// the mask drawn over the image as Lightroom's red overlay, computed here
// from the shapes rather than rendered by the engine. close to darktable's
// own falloffs, not identical

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// how strongly a shape covers the point (u, v) of a W x H image (u, v in
// 0-1); lengths are measured in pixels so circles stay round
// an object's outline filled, small, by the canvas: its Bézier paths as
// darktable draws them (a segment runs from a corner by its ctrl2 and the
// next corner's ctrl1), holes left out by the even-odd rule
const OBJECT_RASTER = 512;
const objectRasters = new WeakMap<ObjectShape, { w: number; h: number; a: Uint8ClampedArray }>();
function objectRaster(s: ObjectShape, W: number, H: number) {
  const hit = objectRasters.get(s);
  if (hit) return hit;
  const w = OBJECT_RASTER, h = Math.max(1, Math.round((OBJECT_RASTER * H) / W));
  const c = new OffscreenCanvas(w, h), ctx = c.getContext("2d")!;
  const path = new Path2D();
  for (const p of s.paths) {
    const pts = p.points;
    if (pts.length < 2) continue;
    path.moveTo(pts[0][0] * w, pts[0][1] * h);
    for (let k = 0; k < pts.length; k++) {
      const a = pts[k], b = pts[(k + 1) % pts.length];
      path.bezierCurveTo(a[4] * w, a[5] * h, b[2] * w, b[3] * h, b[0] * w, b[1] * h);
    }
    path.closePath();
  }
  ctx.fillStyle = "#fff";
  ctx.fill(path, "evenodd");
  // darktable feathers a path outward from its outline, by `feather` of
  // the image's shorter side: the outline widened by half that and
  // blurred by the other half comes close
  const border = (s.feather ?? 0) * Math.min(w, h);
  if (border >= 1) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = border;
    ctx.stroke(path);
  }
  const data = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8ClampedArray(w * h);
  for (let k = 0; k < w * h; k++) a[k] = data[4 * k + 3];
  if (border >= 2) boxBlur(a, w, h, Math.round(border / 4));
  const r = { w, h, a };
  objectRasters.set(s, r);
  return r;
}

// two box blurs of radius r, across then down each time: near enough a
// Gaussian for a soft edge
function boxBlur(a: Uint8ClampedArray, w: number, h: number, r: number) {
  const tmp = new Float32Array(Math.max(w, h));
  const pass = (n: number, len: number, at: (i: number, k: number) => number) => {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[at(i, Math.min(len - 1, Math.max(0, k)))];
      for (let k = 0; k < len; k++) {
        tmp[k] = sum / (2 * r + 1);
        sum += a[at(i, Math.min(len - 1, k + r + 1))] - a[at(i, Math.max(0, k - r))];
      }
      for (let k = 0; k < len; k++) a[at(i, k)] = tmp[k];
    }
  };
  for (let t = 0; t < 2; t++) {
    pass(h, w, (j, i) => j * w + i);
    pass(w, h, (i, j) => j * w + i);
  }
}

function coverage(s: Exclude<Shape, Range>, u: number, v: number, W: number, H: number): number {
  if (s.type === "object") {
    const r = objectRaster(s, W, H);
    const i = Math.min(r.w - 1, Math.floor(u * r.w)), j = Math.min(r.h - 1, Math.floor(v * r.h));
    return r.a[j * r.w + i] / 255;
  }
  const px = u * W, py = v * H;
  if (s.type === "ellipse") {
    const a = (s.angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    const dx = px - s.x * W, dy = py - s.y * H;
    const lx = (dx * cos + dy * sin) / (s.rx * W), ly = (-dx * sin + dy * cos) / (s.ry * W);
    const r = Math.hypot(lx, ly);
    const inner = 1 - s.feather;
    return r <= inner ? 1 : r >= 1 ? 0 : smooth((1 - r) / (1 - inner));
  }
  if (s.type === "gradient") {
    const a = (s.angle * Math.PI) / 180;
    const along = ((px - s.x * W) * Math.cos(a) + (py - s.y * H) * Math.sin(a)) / Math.hypot(W, H);
    return Math.min(1, Math.max(0, 0.5 - along / s.width));
  }
  // a brush stroke: distance to the polyline against its radius
  const r = (s.size / 2) * W;
  let best = Infinity;
  for (let k = 0; k < s.points.length; k++) {
    const [ax, ay] = s.points[k], [bx, by] = s.points[Math.min(k + 1, s.points.length - 1)];
    const x0 = ax * W, y0 = ay * H, x1 = bx * W, y1 = by * H;
    const lx = x1 - x0, ly = y1 - y0, len2 = lx * lx + ly * ly;
    const t = len2 ? Math.min(1, Math.max(0, ((px - x0) * lx + (py - y0) * ly) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (x0 + t * lx), py - (y0 + t * ly)));
  }
  const hard = s.hardness * r;
  const c = best <= hard ? 1 : best >= r ? 0 : smooth((r - best) / (r - hard));
  return c * s.density;
}

// the range map's value at (u, v), 0-1
const rangeAt = (ranges: RangeMap, u: number, v: number) => {
  const i = Math.min(ranges.width - 1, Math.floor(u * ranges.width));
  const j = Math.min(ranges.height - 1, Math.floor(v * ranges.height));
  return ranges.data[j * ranges.width + i] / 255;
};

export function maskAt(m: Mask, u: number, v: number, W: number, H: number, ranges: RangeMap | null): number {
  const drawn = m.shapes.filter((s): s is Exclude<Shape, Range> => !isRange(s));
  // ranges alone cover the whole image, then narrow it; so does a shape
  // taking away before any adds (the engine's whole-frame base)
  let a = !drawn.length || drawn[0].mode === "subtract" ? 1 : 0;
  for (const s of drawn) {
    const c = coverage(s, u, v, W, H);
    a = s.mode === "subtract" ? a * (1 - c) : Math.max(a, c);
  }
  if (ranges && m.shapes.some(isRange)) a *= rangeAt(ranges, u, v);
  return m.invert ? 1 - a : a;
}

// ------------------------------------------------- the overlay, kept
// each shape's coverage of an overlay's grid, kept between redraws, so a
// redraw while a shape is drawn or dragged computes that shape alone, and a
// brush stroke being painted only around its newest segment. measuring every
// pixel against every point of every stroke on each pointer move took half
// a second a move for a mask of one stroke, four for ten

// the overlay's pixels: `w` x `h` over the part `at` of a W x H image
type Grid = { w: number; h: number; at: Region; W: number; H: number; key: string };
const gridOf = (w: number, h: number, at: Region, W: number, H: number): Grid =>
  ({ w, h, at, W, H, key: `${w}x${h}@${at.join()}/${W}x${H}` });

// by the shape, or for a brush by its points, which a mask keeps when it
// takes a painted stroke as its own ({ ...stroke, mode }); a few grids each,
// the fitted overlay's and a zoomed one's
const covers = new WeakMap<object, Map<string, Uint8Array>>();
const coverKey = (s: Exclude<Shape, Range>, g: Grid) =>
  s.type === "brush" ? `${g.key}|${s.size},${s.hardness},${s.density}` : g.key;
const coverOwner = (s: Exclude<Shape, Range>): object => (s.type === "brush" ? s.points : s);
function keep(s: Exclude<Shape, Range>, g: Grid, cov: Uint8Array) {
  const byGrid = covers.get(coverOwner(s)) ?? new Map<string, Uint8Array>();
  covers.set(coverOwner(s), byGrid);
  byGrid.delete(coverKey(s, g));
  byGrid.set(coverKey(s, g), cov);
  if (byGrid.size > 2) byGrid.delete(byGrid.keys().next().value!);
}

// the brush stroke last stamped on each grid, which the next pointer move
// extends by its new points
type Stroke = { points: [number, number][]; size: number; hardness: number; density: number;
                dist: Float32Array; cov: Uint8Array };
const strokes = new Map<string, Stroke>();

// a brush's coverage as coverage() computes it, but only for the pixels
// within the brush's radius of its segments `from` on: each keeps the
// distance to the nearest segment so far
function stamp(st: Stroke, g: Grid, from: number) {
  const { w, h, at: [x0, y0, x1, y1], W, H } = g;
  const r = (st.size / 2) * W, hard = st.hardness * r;
  const pts = st.points;
  // a pixel's center in image pixels, and back
  const px = (i: number) => (x0 + ((i + 0.5) / w) * (x1 - x0)) * W;
  const py = (j: number) => (y0 + ((j + 0.5) / h) * (y1 - y0)) * H;
  const col = (x: number) => ((x / W - x0) / (x1 - x0)) * w - 0.5;
  const row = (y: number) => ((y / H - y0) / (y1 - y0)) * h - 0.5;
  for (let k = from; k < pts.length; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[Math.min(k + 1, pts.length - 1)];
    const sx = ax * W, sy = ay * H, lx = bx * W - sx, ly = by * H - sy, len2 = lx * lx + ly * ly;
    const i0 = Math.max(0, Math.floor(col(Math.min(sx, sx + lx) - r))), i1 = Math.min(w - 1, Math.ceil(col(Math.max(sx, sx + lx) + r)));
    const j0 = Math.max(0, Math.floor(row(Math.min(sy, sy + ly) - r))), j1 = Math.min(h - 1, Math.ceil(row(Math.max(sy, sy + ly) + r)));
    for (let j = j0; j <= j1; j++) {
      const y = py(j);
      for (let i = i0; i <= i1; i++) {
        const x = px(i), n = j * w + i;
        const t = len2 ? Math.min(1, Math.max(0, ((x - sx) * lx + (y - sy) * ly) / len2)) : 0;
        const d = Math.hypot(x - (sx + t * lx), y - (sy + t * ly));
        if (d >= st.dist[n]) continue;
        st.dist[n] = d;
        st.cov[n] = Math.round(255 * st.density * (d <= hard ? 1 : d >= r ? 0 : smooth((r - d) / (r - hard))));
      }
    }
  }
}

function brushCover(s: Brush, g: Grid): Uint8Array {
  let st = strokes.get(g.key);
  const n = st?.points.length ?? 0;
  const extended = !!st && s.size === st.size && s.hardness === st.hardness && s.density === st.density
    && s.points.length > n && s.points[n - 1] === st.points[n - 1];
  if (extended) {
    // its buffers move on to the longer stroke; the shorter one is gone
    covers.get(st!.points)?.delete(coverKey(s, g));
    st!.points = s.points;
  } else {
    st = { points: s.points, size: s.size, hardness: s.hardness, density: s.density,
           dist: new Float32Array(g.w * g.h).fill(Infinity), cov: new Uint8Array(g.w * g.h) };
  }
  // the fitted overlay's grid and a zoomed one's, as `covers` keeps
  strokes.delete(g.key);
  strokes.set(g.key, st!);
  if (strokes.size > 2) strokes.delete(strokes.keys().next().value!);
  stamp(st!, g, extended ? n - 1 : 0);
  return st!.cov;
}

function cover(s: Exclude<Shape, Range>, g: Grid): Uint8Array {
  const hit = covers.get(coverOwner(s))?.get(coverKey(s, g));
  if (hit) return hit;
  let cov: Uint8Array;
  if (s.type === "brush") cov = brushCover(s, g);
  else {
    const { w, h, at: [x0, y0, x1, y1], W, H } = g;
    cov = new Uint8Array(w * h);
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++)
        cov[j * w + i] = Math.round(255 * coverage(s, x0 + ((i + 0.5) / w) * (x1 - x0), y0 + ((j + 0.5) / h) * (y1 - y0), W, H));
  }
  keep(s, g, cov);
  return cov;
}

// the overlay's color: darktable's yellow, Lightroom's red or one picked, as
// chosen in Preferences, or a parametric channel's own while it is edited
export type Rgb = [number, number, number];
export const OVERLAY_COLORS = { yellow: [250, 220, 20] as Rgb, red: [230, 40, 40] as Rgb };
const OVERLAY_RED = OVERLAY_COLORS.red;

// the overlay as RGBA, `w` pixels wide, for an image of aspect W:H: of the
// whole image, or of the part `at` of it
export function overlayPixels(m: Mask, w: number, W: number, H: number, ranges: RangeMap | null = null,
                              color = OVERLAY_RED, at: Region = [0, 0, 1, 1]): ImageData {
  const [x0, y0, x1, y1] = at;
  const h = Math.max(1, Math.round((w * (y1 - y0) * H) / ((x1 - x0) * W)));
  // maskAt(), from each shape's coverage as kept (cover())
  const g = gridOf(w, h, at, W, H);
  const drawn = m.shapes.filter((s): s is Exclude<Shape, Range> => !isRange(s));
  const covs = drawn.map((s) => cover(s, g));
  const sub = drawn.map((s) => s.mode === "subtract");
  const start = !drawn.length || sub[0] ? 1 : 0;
  const ranged = !!ranges && m.shapes.some(isRange);
  return tint(w, h, (i, j) => {
    const k = j * w + i;
    let a = start;
    for (let n = 0; n < covs.length; n++) {
      const c = covs[n][k] / 255;
      a = sub[n] ? a * (1 - c) : Math.max(a, c);
    }
    if (ranged) a *= rangeAt(ranges!, x0 + ((i + 0.5) / w) * (x1 - x0), y0 + ((j + 0.5) / h) * (y1 - y0));
    return m.invert ? 1 - a : a;
  }, color);
}

// the overlay from a map of the whole mask, as the engine's mask_map makes it
export const mapPixels = (map: RangeMap, color = OVERLAY_RED): ImageData =>
  tint(map.width, map.height, (i, j) => map.data[j * map.width + i] / 255, color);

function tint(w: number, h: number, at: (i: number, j: number) => number, [r, g, b]: Rgb): ImageData {
  const img = new ImageData(w, h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = 4 * (j * w + i);
      img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b;
      img.data[k + 3] = Math.round(at(i, j) * 140);
    }
  return img;
}

// a mask's thumbnail for the Masks panel, white on black, as an image URL.
// a range mask whose map has not come yet shows its ranges as half on
const thumbs = new WeakMap<Mask, { key: string; ranges: RangeMap | null; url: string }>();
const HALF: RangeMap = { width: 1, height: 1, data: new Uint8Array([128]) };
export function maskThumb(m: Mask, w: number, W: number, H: number, ranges: RangeMap | null): string {
  const key = `${w}:${W}:${H}`;
  const hit = thumbs.get(m);
  if (hit && hit.key === key && hit.ranges === ranges) return hit.url;
  const h = Math.max(1, Math.round((w * H) / W));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const img = new ImageData(w, h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const v = Math.round(255 * maskAt(m, (i + 0.5) / w, (j + 0.5) / h, W, H, ranges ?? HALF));
      const k = 4 * (j * w + i);
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  c.getContext("2d")!.putImageData(img, 0, 0);
  const url = c.toDataURL();
  thumbs.set(m, { key, ranges, url });
  return url;
}
