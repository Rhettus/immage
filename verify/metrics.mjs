// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// how two rendered frames (8-bit RGBA, display referred) differ, over the
// whole frame or the pixels a region takes (x, y in 0-1 of the frame)

// a band's mean when fewer pixels than this sit in it says nothing
const MIN_PIXELS = 200;

const luma = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

// a - b, so a positive value means `a` has more of it. bands are taken
// from b, the frame before the change: lumHi the highlights, lumLo the
// shadows. null where a band has too few pixels to judge
export function compare(a, b, region = null) {
  if (a.width !== b.width || a.height !== b.height) return { geometry: true, mad: Infinity };
  const { width: w, height: h } = a;
  const pa = a.pixels, pb = b.pixels;
  let n = 0, mad = 0, lum = 0, chroma = 0, warm = 0, magenta = 0, max = 0;
  let nHi = 0, hi = 0, nLo = 0, lo = 0;
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      if (region && !region((x + 0.5) / w, fy, w / h)) continue;
      const i = 4 * (y * w + x);
      const d = Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]);
      mad += d / 3;
      if (d / 3 > max) max = d / 3;
      const la = luma(pa, i), lb = luma(pb, i);
      lum += la - lb;
      chroma += (Math.max(pa[i], pa[i + 1], pa[i + 2]) - Math.min(pa[i], pa[i + 1], pa[i + 2]))
              - (Math.max(pb[i], pb[i + 1], pb[i + 2]) - Math.min(pb[i], pb[i + 1], pb[i + 2]));
      warm += (pa[i] - pa[i + 2]) - (pb[i] - pb[i + 2]);
      magenta += ((pa[i] + pa[i + 2]) / 2 - pa[i + 1]) - ((pb[i] + pb[i + 2]) / 2 - pb[i + 1]);
      if (lb > 170) { nHi++; hi += la - lb; }
      if (lb < 85) { nLo++; lo += la - lb; }
      n++;
    }
  }
  const r = (v) => Math.round(v * 1000) / 1000;
  if (!n) return { mad: 0, pixels: 0 };
  return {
    mad: r(mad / n), max: r(max), lum: r(lum / n), chroma: r(chroma / n), warm: r(warm / n),
    magenta: r(magenta / n), lumHi: nHi >= MIN_PIXELS ? r(hi / nHi) : null,
    lumLo: nLo >= MIN_PIXELS ? r(lo / nLo) : null, pixels: n,
  };
}

// the frame's mean saturation-ish spread, for "is this black and white"
export function meanChroma(f) {
  const p = f.pixels;
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s += Math.max(p[i], p[i + 1], p[i + 2]) - Math.min(p[i], p[i + 1], p[i + 2]);
  return s / (p.length / 4);
}

// how far each pixel's chroma moves from frame a to frame b, on average:
// a change that takes color from some pixels and adds it to others, which
// the mean chroma can hide, counts in full
export function chromaChange(a, b) {
  const p = a.pixels, q = b.pixels;
  const c = (x, i) => Math.max(x[i], x[i + 1], x[i + 2]) - Math.min(x[i], x[i + 1], x[i + 2]);
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s += Math.abs(c(q, i) - c(p, i));
  return s / (p.length / 4);
}

// inside an ellipse of shown-image units: radii as fractions of the width,
// as masks.ts keeps them; `aspect` is the frame's width over its height
export const inEllipse = (cx, cy, r) => (x, y, aspect) =>
  ((x - cx) / r) ** 2 + (((y - cy) / aspect) / r) ** 2 <= 1;
export const rightOf = (x0) => (x) => x >= x0;
export const leftOf = (x1) => (x) => x <= x1;
