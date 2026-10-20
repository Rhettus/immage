// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an RGB histogram of a rendered frame (display-referred 8-bit RGBA), drawn
// as Lightroom does: the three channels overlaid, their overlaps adding up
// toward white. the frame's other scopes, darktable's set (waveform, RGB
// parade, vectorscope and the split of the two), draw from a small copy of
// it kept alongside

export type Histogram = {
  bins: [Uint32Array, Uint32Array, Uint32Array];
  samples: number;
  // share of sampled pixels with any channel at 0 or 255
  shadowsClipped: number;
  highlightsClipped: number;
  // the frame, scaled down, for the scopes that need where a pixel is or
  // all of its channels at once
  small: { px: Uint8ClampedArray; width: number; height: number };
};

const MAX_SAMPLES = 400_000;
const SMALL_SIDE = 400;

// nearest-pixel copy at most SMALL_SIDE on the long side: enough for a
// waveform a panel wide, and for a vectorscope's few hundred cells
function shrink(px: Uint8ClampedArray, width: number, height: number) {
  const k = Math.max(1, Math.max(width, height) / SMALL_SIDE);
  const w = Math.max(1, Math.round(width / k)), h = Math.max(1, Math.round(height / k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y * k)) * width;
    for (let x = 0; x < w; x++) {
      const i = 4 * (sy + Math.min(width - 1, Math.floor(x * k))), o = 4 * (y * w + x);
      out[o] = px[i]; out[o + 1] = px[i + 1]; out[o + 2] = px[i + 2]; out[o + 3] = 255;
    }
  }
  return { px: out, width: w, height: h };
}

export function computeHistogram(px: Uint8ClampedArray, width: number, height: number): Histogram {
  const bins: [Uint32Array, Uint32Array, Uint32Array] =
    [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  const n = width * height;
  const stride = Math.max(1, Math.floor(n / MAX_SAMPLES));
  let samples = 0, low = 0, high = 0;
  for (let i = 0; i < n; i += stride) {
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2];
    bins[0][r]++; bins[1][g]++; bins[2][b]++;
    if (r === 0 || g === 0 || b === 0) low++;
    if (r === 255 || g === 255 || b === 255) high++;
    samples++;
  }
  return { bins, samples, shadowsClipped: low / samples, highlightsClipped: high / samples,
           small: shrink(px, width, height) };
}

// the share past which a clipping triangle lights
export const CLIP_SHARE = 0.0005;

// a clipping triangle's color, as Lightroom's: the channels that clip
// there mixed (red, yellow, cyan...), white when all three do, null when
// none does
export function clipColor(h: Histogram | null, end: "low" | "high"): string | null {
  if (!h) return null;
  const at = end === "low" ? 0 : 255;
  const on = h.bins.map((b) => b[at] / h.samples > CLIP_SHARE);
  if (!on.some(Boolean)) return null;
  return `rgb(${on.map((c) => (c ? 242 : 60)).join(", ")})`;
}

export type ClipShow = { low: boolean; high: boolean };

// paints dst, sized as src, with Lightroom's clipping overlay of src's
// pixels: blue where any channel is 0, red where any is 255
export function paintClipping(src: HTMLCanvasElement, dst: HTMLCanvasElement, show: ClipShow) {
  if (dst.width !== src.width || dst.height !== src.height) { dst.width = src.width; dst.height = src.height; }
  const out = dst.getContext("2d")!;
  out.clearRect(0, 0, dst.width, dst.height);
  if (!src.width || !src.height || (!show.low && !show.high)) return;
  const px = src.getContext("2d")!.getImageData(0, 0, src.width, src.height).data;
  const img = out.createImageData(src.width, src.height);
  const d = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    if (show.high && (r === 255 || g === 255 || b === 255)) {
      d[i] = 255; d[i + 3] = 255;
    } else if (show.low && (r === 0 || g === 0 || b === 0)) {
      d[i + 1] = 64; d[i + 2] = 255; d[i + 3] = 255;
    }
  }
  out.putImageData(img, 0, 0);
}

const COLORS = ["rgba(225, 70, 70, 0.9)", "rgba(80, 200, 90, 0.9)", "rgba(80, 120, 235, 0.9)"];

export type ScopeMode = "histogram" | "waveform" | "parade" | "vectorscope" | "split";
export type VecSpace = "luv" | "jzazbz" | "ryb";

// darktable's color harmonies (src/libs/scopes/vectorscope.c): each
// sector's center in turns and its length as a share of the radius
export const HARMONIES: { name: string; angle: number[]; length: number[] }[] = [
  { name: "none", angle: [], length: [] },
  { name: "monochromatic", angle: [0], length: [0.8] },
  { name: "analogous", angle: [-1 / 12, 0, 1 / 12], length: [0.5, 0.8, 0.5] },
  { name: "analogous complementary", angle: [-1 / 12, 0, 1 / 12, 6 / 12], length: [0.5, 0.8, 0.5, 0.5] },
  { name: "complementary", angle: [0, 6 / 12], length: [0.8, 0.5] },
  { name: "split complementary", angle: [0, 5 / 12, 7 / 12], length: [0.8, 0.5, 0.5] },
  { name: "dyad", angle: [-1 / 12, 1 / 12], length: [0.8, 0.8] },
  { name: "triad", angle: [0, 4 / 12, 8 / 12], length: [0.8, 0.5, 0.5] },
  { name: "tetrad", angle: [-1 / 12, 1 / 12, 5 / 12, 7 / 12], length: [0.8, 0.8, 0.5, 0.5] },
  { name: "square", angle: [0, 3 / 12, 6 / 12, 9 / 12], length: [0.8, 0.5, 0.5, 0.5] },
];
// half a sector's width in turns, by darktable's names
export const HARMONY_WIDTHS: [string, number][] =
  [["normal", 0.5 / 12], ["large", 0.75 / 12], ["narrow", 0.25 / 12], ["line", 0]];

export type ScopeSettings = {
  mode: ScopeMode;
  log: boolean;                // histogram scale
  vertical: boolean;           // waveform and parade orientation
  space: VecSpace;
  vecLog: boolean;             // vectorscope scale
  harmony: number;             // index into HARMONIES, RYB only as in darktable
  harmonyWidth: number;        // index into HARMONY_WIDTHS
  harmonyAngle: number;        // degrees
  channels: [boolean, boolean, boolean];
};

export const DEFAULT_SCOPE: ScopeSettings = {
  mode: "histogram", log: false, vertical: false, space: "luv", vecLog: true,
  harmony: 0, harmonyWidth: 0, harmonyAngle: 0, channels: [true, true, true],
};

// sizes the canvas to its box in device pixels and clears it
function prepare(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = "#181818";
  ctx.fillRect(0, 0, W, H);
  return { ctx, W, H, dpr };
}

export function drawScope(canvas: HTMLCanvasElement, h: Histogram | null, s: ScopeSettings) {
  const { ctx, W, H, dpr } = prepare(canvas);
  if (s.mode === "histogram") histogramInto(ctx, 0, 0, W, H, h, s);
  else if (s.mode === "waveform" || s.mode === "parade") waveformInto(ctx, 0, 0, W, H, h, s, s.mode === "parade");
  else if (s.mode === "vectorscope") vectorscopeInto(ctx, 0, 0, W, H, h, s, dpr);
  else {
    // darktable's split: waveform on the left, vectorscope on the right
    const half = Math.floor(W / 2);
    waveformInto(ctx, 0, 0, half - dpr, H, h, s, false);
    vectorscopeInto(ctx, half + dpr, 0, W - half - dpr, H, h, s, dpr);
  }
}

function histogramInto(ctx: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number,
                       h: Histogram | null, s: ScopeSettings) {
  ctx.strokeStyle = "#262626";
  for (const q of [0.25, 0.5, 0.75]) {
    ctx.beginPath(); ctx.moveTo(x0 + q * W, y0); ctx.lineTo(x0 + q * W, y0 + H); ctx.stroke();
  }
  if (!h) return;
  const f = s.log ? Math.log1p : (v: number) => v;
  // scale to the tallest bin away from the ends, so a clipped spike at 0 or
  // 255 does not flatten the rest
  let peak = 1;
  h.bins.forEach((b, c) => {
    if (s.channels[c]) for (let i = 2; i < 254; i++) peak = Math.max(peak, f(b[i]));
  });
  ctx.globalCompositeOperation = "screen";
  h.bins.forEach((b, c) => {
    if (!s.channels[c]) return;
    ctx.fillStyle = COLORS[c];
    ctx.beginPath();
    ctx.moveTo(x0, y0 + H);
    for (let i = 0; i < 256; i++) {
      const y = H - Math.min(1, f(b[i]) / peak) * (H - 2);
      ctx.lineTo(x0 + (i / 255) * W, y0 + y);
    }
    ctx.lineTo(x0 + W, y0 + H);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalCompositeOperation = "source-over";
}

// hybrid log-gamma, which darktable uses to lift sparse scope cells into view
function hlg(e: number) {
  if (e <= 1 / 12) return Math.sqrt(3 * e);
  return 0.17883277 * Math.log(12 * e - 0.28466892) + 0.55991073;
}

// the waveform: each column of the image (each row when vertical) becomes a
// column of the scope, whose height counts its pixels at each tone. black
// is at the bottom (left when vertical), white at the top (right). the
// parade draws the three channels side by side, each in its own third
function waveformInto(ctx: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number,
                      h: Histogram | null, s: ScopeSettings, parade: boolean) {
  const vertical = s.vertical;
  if (h) {
    const { px, width, height } = h.small;
    const span = vertical ? height : width;       // along the image
    const across = vertical ? width : height;     // pixels summed into each bin
    const panels = parade ? 3 : 1;
    // whole image pixels per bin, so the columns stay even
    const per = Math.max(1, Math.ceil(span / Math.max(1, (vertical ? H : W) / panels)));
    const bins = Math.ceil(span / per);
    const tones = 256;
    const counts = [new Uint32Array(bins * tones), new Uint32Array(bins * tones), new Uint32Array(bins * tones)];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = 4 * (y * width + x);
        const b = Math.floor((vertical ? y : x) / per) * tones;
        counts[0][b + px[i]]++; counts[1][b + px[i + 1]]++; counts[2][b + px[i + 2]]++;
      }
    }
    // darktable's brightness: a share of the tones, against the pixels
    // summed into a bin
    const scale = (tones / 40) / (across * per);
    const iw = vertical ? tones : bins * panels, ih = vertical ? bins * panels : tones;
    const img = new ImageData(iw, ih);
    const d = img.data;
    const show = parade ? [true, true, true] : s.channels;
    const level = (c: number, k: number) => (show[c] ? hlg(Math.min(1, scale * counts[c][k])) : 0);
    // a cell of the scope image for bin b, tone t, in panel p
    const at = (b: number, t: number, p: number) => vertical
      ? 4 * ((p * bins + b) * iw + t)
      : 4 * ((tones - 1 - t) * iw + p * bins + b);
    for (let b = 0; b < bins; b++) {
      for (let t = 0; t < tones; t++) {
        const k = b * tones + t;
        if (parade) {
          for (let c = 0; c < 3; c++) {
            const v = level(c, k);
            if (!v) continue;
            const o = at(b, t, c);
            // the channel's own color, lightened toward white where dense
            d[o] = 255 * Math.min(1, (c === 0 ? 0.85 : 0.3) * v + 0.25 * v * v);
            d[o + 1] = 255 * Math.min(1, (c === 1 ? 0.85 : 0.3) * v + 0.25 * v * v);
            d[o + 2] = 255 * Math.min(1, (c === 2 ? 0.95 : 0.35) * v + 0.25 * v * v);
            d[o + 3] = 255;
          }
        } else {
          const r = level(0, k), g = level(1, k), bl = level(2, k);
          if (!r && !g && !bl) continue;
          // each channel adds its own color; where they overlap the sum
          // goes toward white, as darktable's additive composite does
          const mean = 0.3 * (r + g + bl) / 3;
          const o = at(b, t, 0);
          d[o] = 255 * Math.min(1, 0.8 * r + mean);
          d[o + 1] = 255 * Math.min(1, 0.8 * g + mean);
          d[o + 2] = 255 * Math.min(1, 0.95 * bl + mean);
          d[o + 3] = 255;
        }
      }
    }
    const tmp = document.createElement("canvas");
    tmp.width = iw; tmp.height = ih;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tmp, x0, y0, W, H);
  }
  // guides at 0, 25, 50, 75 and 100% of the tones, and between the parade's
  // channels
  ctx.strokeStyle = "rgba(255, 255, 255, 0.09)";
  ctx.lineWidth = 1;
  for (const q of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    if (vertical) { ctx.moveTo(x0 + q * W, y0); ctx.lineTo(x0 + q * W, y0 + H); }
    else { ctx.moveTo(x0, y0 + q * H); ctx.lineTo(x0 + W, y0 + q * H); }
    ctx.stroke();
  }
  if (parade) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
    for (const q of [1 / 3, 2 / 3]) {
      ctx.beginPath();
      if (vertical) { ctx.moveTo(x0, y0 + q * H); ctx.lineTo(x0 + W, y0 + q * H); }
      else { ctx.moveTo(x0 + q * W, y0); ctx.lineTo(x0 + q * W, y0 + H); }
      ctx.stroke();
    }
  }
}

// --- vectorscope color math, after src/libs/scopes/vectorscope.c ---

const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

// linear sRGB to XYZ, D65
function xyz(r: number, g: number, b: number): [number, number, number] {
  return [0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
          0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
          0.0193339 * r + 0.1191920 * g + 0.9503041 * b];
}

// CIE 1976 u*v* against the frame's own D65 white (darktable adapts to D50
// first; for an sRGB frame the hues land in the same places)
function luv(r: number, g: number, b: number): [number, number] {
  const [X, Y, Z] = xyz(r, g, b);
  const den = X + 15 * Y + 3 * Z;
  if (den <= 0) return [0, 0];
  const L = Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y;
  return [13 * L * (4 * X / den - 0.1978398), 13 * L * (9 * Y / den - 0.4683363)];
}

// Az, Bz of JzAzBz, as dt_XYZ_2_JzAzBz (common/colorspaces_inline_conversions.h)
function jzazbz(r: number, g: number, b: number): [number, number] {
  const [X0, Y0, Z0] = xyz(r, g, b);
  const X = 1.15 * X0 - 0.15 * Z0, Y = 0.66 * Y0 + 0.34 * X0, Z = Z0;
  const pq = (v: number) => {
    const t = Math.max(0, v * 1e-4) ** 0.159301758;
    return ((0.8359375 + 18.8515625 * t) / (1 + 18.6875 * t)) ** 134.034375;
  };
  const l = pq(0.41478972 * X + 0.579999 * Y + 0.014648 * Z);
  const m = pq(-0.20151 * X + 1.120649 * Y + 0.0531008 * Z);
  const s = pq(-0.0166008 * X + 0.2648 * Y + 0.6684799 * Z);
  return [3.524 * l - 4.066708 * m + 0.542708 * s, 0.199076 * l + 1.096799 * m - 1.295875 * s];
}

// a natural cubic spline through (xs, ys), tabulated for speed
function splineTable(xs: number[], ys: number[], n = 1024) {
  const k = xs.length, y2 = new Array(k).fill(0), u = new Array(k).fill(0);
  for (let i = 1; i < k - 1; i++) {
    const sig = (xs[i] - xs[i - 1]) / (xs[i + 1] - xs[i - 1]);
    const p = sig * y2[i - 1] + 2;
    y2[i] = (sig - 1) / p;
    u[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) - (ys[i] - ys[i - 1]) / (xs[i] - xs[i - 1]);
    u[i] = (6 * u[i] / (xs[i + 1] - xs[i - 1]) - sig * u[i - 1]) / p;
  }
  for (let i = k - 2; i >= 0; i--) y2[i] = y2[i] * y2[i + 1] + u[i];
  return Float32Array.from({ length: n + 1 }, (_, j) => {
    const x = j / n;
    let i = 0;
    while (i < k - 2 && x > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i], a = (xs[i + 1] - x) / hh, bb = (x - xs[i]) / hh;
    return a * ys[i] + bb * ys[i + 1] + ((a ** 3 - a) * y2[i] + (bb ** 3 - bb) * y2[i + 1]) * hh * hh / 6;
  });
}
// the Gossett paint-mixing hue map, common/color_ryb.h and vectorscope.c
const RYB_X = [0, 1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1];
const RGB_TO_RYB = splineTable(RYB_X, [0, 1 / 3, 0.472217, 0.611105, 0.715271, 5 / 6, 1]);
const RYB_TO_RGB = splineTable(RYB_X, [0, 0.083333, 0.166667, 0.383838, 0.586575, 5 / 6, 1]);
const lookup = (t: Float32Array, x: number) => t[Math.round(Math.min(1, Math.max(0, x)) * (t.length - 1))];

function hue(r: number, g: number, b: number) {
  const mx = Math.max(r, g, b), c = mx - Math.min(r, g, b);
  if (c <= 0) return 0;
  const h = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
  return h / 6;
}

// the painter's wheel: hue mapped through the spline, chroma kept, on the
// same 0.01 radius darktable uses
function ryb(r: number, g: number, b: number): [number, number] {
  const c = Math.max(r, g, b) - Math.min(r, g, b);
  const a = 2 * Math.PI * lookup(RGB_TO_RYB, hue(r, g, b));
  return [Math.cos(a) * c * 0.01, Math.sin(a) * c * 0.01];
}

const CHROMA = { luv, jzazbz, ryb };

// fully saturated color at a hue in [0, 1)
function hueColor(hh: number): [number, number, number] {
  const k = (n: number) => (n + hh * 6) % 6;
  const f = (n: number) => 1 - Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}

// the gamut's hue ring: the edges of the RGB cube that touch neither black
// nor white, as darktable traces it; and the widest radius on it
const HUES = 48;
function hueRing(space: VecSpace) {
  const pts: { x: number; y: number; rgb: [number, number, number] }[] = [];
  let max = 0;
  for (let k = 0; k < 6 * HUES; k++) {
    const t = k / (6 * HUES);
    let x: number, y: number, rgb: [number, number, number];
    if (space === "ryb") {
      const a = 2 * Math.PI * t;
      x = Math.cos(a) * 0.01; y = Math.sin(a) * 0.01;
      rgb = hueColor(lookup(RYB_TO_RGB, t));
    } else {
      rgb = hueColor(t);
      [x, y] = CHROMA[space](rgb[0], rgb[1], rgb[2]);
    }
    pts.push({ x, y, rgb });
    max = Math.max(max, Math.hypot(x, y));
  }
  return { pts, max };
}
const RINGS = new Map<VecSpace, ReturnType<typeof hueRing>>();
const ringOf = (space: VecSpace) => {
  let r = RINGS.get(space);
  if (!r) { r = hueRing(space); RINGS.set(space, r); }
  return r;
};

// darktable's logarithmic radius, base 30
const baselog = (r: number, bound: number) => Math.log1p(29 * r / bound) / Math.log(30) * bound;

// the vectorscope: every pixel placed by its chromaticity, gray at the
// center, hue around it and chroma outward. oriented as darktable's default
// (red up, yellow left in u*v*); the cells take the average color of the
// pixels in them, the hue ring marks the gamut's edge
function vectorscopeInto(ctx: CanvasRenderingContext2D, x0: number, y0: number, W: number, H: number,
                         h: Histogram | null, s: ScopeSettings, dpr: number) {
  const ring = ringOf(s.space);
  const R = ring.max;
  const radius = (Math.min(W, H) - 6 * dpr) / 2;
  // a canvas not laid out yet has no room, and a negative radius throws
  if (radius < 4 * dpr) return;
  const cx = x0 + W / 2, cy = y0 + H / 2;
  // a chromaticity, log scaled if asked, to the canvas
  const place = (a: number, b: number): [number, number] => {
    let k = 1;
    if (s.vecLog) { const r = Math.hypot(a, b); if (r > 1e-12) k = baselog(r, R) / r; }
    return [cx - b * k / R * radius, cy - a * k / R * radius];
  };

  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, W, H); ctx.clip();
  const bg = ctx.createRadialGradient(cx, cy, radius, cx, cy, Math.hypot(W, H) / 2);
  bg.addColorStop(0, "#1c1c1c"); bg.addColorStop(1, "#141414");
  ctx.fillStyle = bg; ctx.fillRect(x0, y0, W, H);

  // concentric circles as a scale
  const step = s.space === "luv" ? 100 : 0.01;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = dpr;
  for (let i = 1; i < 1 + Math.ceil(R / step); i++) {
    let r = step * i;
    if (s.vecLog) r = baselog(r, R);
    ctx.beginPath(); ctx.arc(cx, cy, r / R * radius, 0, 2 * Math.PI); ctx.stroke();
  }

  // the samples, binned into cells of about two device pixels
  const n = Math.max(32, Math.min(256, Math.round(radius)));
  let graph: HTMLCanvasElement | null = null;
  if (h) {
    const { px, width, height } = h.small;
    const count = new Uint32Array(n * n), sum = new Float32Array(n * n * 3);
    const f = CHROMA[s.space];
    const total = width * height;
    for (let i = 0; i < total; i++) {
      const o = 4 * i;
      const r = TO_LINEAR[px[o]], g = TO_LINEAR[px[o + 1]], b = TO_LINEAR[px[o + 2]];
      const [a, bb] = f(r, g, b);
      const [x, y] = place(a, bb);
      const gx = Math.floor(((x - cx) / radius * 0.5 + 0.5) * n), gy = Math.floor(((y - cy) / radius * 0.5 + 0.5) * n);
      if (gx < 0 || gy < 0 || gx >= n || gy >= n) continue;
      const k = gy * n + gx;
      count[k]++;
      sum[3 * k] += r; sum[3 * k + 1] += g; sum[3 * k + 2] += b;
    }
    // darktable's gain: a thirtieth of the cells' share of the samples
    const gain = (1 / 30) * (n * n) / total;
    const img = new ImageData(n, n);
    const d = img.data;
    for (let k = 0; k < n * n; k++) {
      if (!count[k]) continue;
      const v = hlg(Math.min(1, gain * count[k]));
      const r = sum[3 * k], g = sum[3 * k + 1], b = sum[3 * k + 2];
      const mx = Math.max(r, g, b, 1e-6);
      // the cell's hue at full brightness, then lightened, as darktable
      // masks the hue background and lays white over it
      for (let c = 0; c < 3; c++) {
        const col = [r, g, b][c] / mx;
        d[4 * k + c] = 255 * Math.min(1, v * (0.55 + 0.45 * col) + 0.15 * v);
      }
      d[4 * k + 3] = 255;
    }
    graph = document.createElement("canvas");
    graph.width = n; graph.height = n;
    graph.getContext("2d")!.putImageData(img, 0, 0);
  }

  // harmony guides: darktable shows them on the RYB wheel only, dimming
  // the scope outside their sectors
  const hm = s.space === "ryb" ? HARMONIES[s.harmony] : undefined;
  const hw = HARMONY_WIDTHS[s.harmonyWidth]?.[1] ?? HARMONY_WIDTHS[0][1];
  let sectors: Path2D | null = null;
  if (hm && hm.angle.length) {
    sectors = new Path2D();
    const rot = s.harmonyAngle / 360;
    hm.angle.forEach((ang, i) => {
      const span1 = i > 0 ? Math.min(hw, (ang - hm.angle[i - 1]) / 2) : hw;
      const span2 = i < hm.angle.length - 1 ? Math.min(hw, (hm.angle[i + 1] - ang) / 2) : hw;
      let len = hm.length[i] * R;
      if (s.vecLog) len = baselog(len, R);
      const r = len / R * radius;
      // chroma angle a sits at canvas direction (-sin a, -cos a)
      const pt = (t: number): [number, number] => {
        const a = 2 * Math.PI * (t + rot);
        return [cx - Math.sin(a) * r, cy - Math.cos(a) * r];
      };
      sectors!.moveTo(cx, cy);
      const steps = Math.max(2, Math.ceil((span1 + span2) * 96));
      for (let j = 0; j <= steps; j++) {
        const [x, y] = pt(ang - span1 + (span1 + span2) * j / steps);
        sectors!.lineTo(x, y);
      }
      sectors!.closePath();
    });
  }

  if (graph) {
    ctx.imageSmoothingEnabled = true;
    ctx.globalCompositeOperation = "lighter";
    const drawGraph = () => ctx.drawImage(graph!, cx - radius, cy - radius, 2 * radius, 2 * radius);
    if (sectors && hw > 0) {
      // full strength inside the sectors, dimmed outside (darktable's 0.7)
      ctx.save(); ctx.clip(sectors); drawGraph(); ctx.restore();
      ctx.save();
      const outside = new Path2D();
      outside.rect(x0, y0, W, H);
      outside.addPath(sectors);
      ctx.clip(outside, "evenodd");
      ctx.globalAlpha = 0.3; drawGraph();
      ctx.restore();
    } else {
      drawGraph();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  // the hue ring, in the colors it stands for
  ctx.lineWidth = 1.2 * dpr;
  ctx.globalAlpha = 0.55;
  const pts = ring.pts.map((p) => ({ xy: place(p.x, p.y), rgb: p.rgb }));
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    ctx.strokeStyle = `rgb(${a.rgb.map((c) => Math.round(c * 255)).join(",")})`;
    ctx.beginPath(); ctx.moveTo(a.xy[0], a.xy[1]); ctx.lineTo(b.xy[0], b.xy[1]); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // primary and secondary nodes
  for (let k = 0; k < 6; k++) {
    const p = pts[k * HUES];
    ctx.beginPath(); ctx.arc(p.xy[0], p.xy[1], 2.5 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = `rgb(${p.rgb.map((c) => Math.round(c * 255)).join(",")})`;
    ctx.fill();
    ctx.strokeStyle = "#555"; ctx.lineWidth = dpr; ctx.stroke();
  }
  if (sectors) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = dpr;
    ctx.stroke(sectors);
  }
  // the center
  ctx.fillStyle = "#666";
  ctx.beginPath(); ctx.arc(cx, cy, 2 * dpr, 0, 2 * Math.PI); ctx.fill();
  ctx.restore();
}

// the histogram as one filled area for a W x H graph: the channels
// averaged, scaled to the tallest bin away from the clipped ends. drawn
// behind the tone curve, whose x axis it shares
export function histogramPath(h: Histogram | null, W: number, H: number,
                              channel: 0 | 1 | 2 | null = null): string | null {
  if (!h) return null;
  // one channel's, or the channels averaged
  const avg = Array.from({ length: 256 }, (_, i) =>
    channel === null ? (h.bins[0][i] + h.bins[1][i] + h.bins[2][i]) / 3 : h.bins[channel][i]);
  let peak = 1;
  for (let i = 2; i < 254; i++) peak = Math.max(peak, avg[i]);
  const pts = avg.map((v, i) => `L${((i / 255) * W).toFixed(1)},${(H - Math.min(1, v / peak) * H * 0.9).toFixed(1)}`);
  return `M0,${H} ${pts.join(" ")} L${W},${H} Z`;
}
