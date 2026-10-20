// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's parametric tone curve (four region sliders, three split
// points) as darktable tonecurve nodes. x and y are tonecurve's own axes:
// perceptual lightness L/100, applied after the tone mapper

export type Parametric = {
  highlights: number; lights: number; darks: number; shadows: number; // -100..100
  split1: number; split2: number; split3: number;                     // 0..100
};

export const NODES = 17; // tonecurve holds at most 20 per channel
const GAIN = 0.2;        // a region slider at 100 moves its center by about this much

const xs = Array.from({ length: NODES }, (_, k) => k / (NODES - 1));

// one region's influence: a cosine bump centered on the region, reaching to
// the neighbouring centers, faded to zero at black and white so the end
// points stay put
function bumps(x: number, s: [number, number, number]): number[] {
  const b = [0, s[0], s[1], s[2], 1];
  const fade = Math.sqrt(Math.sin(Math.PI * x));
  return [0, 1, 2, 3].map((i) => {
    const c = (b[i] + b[i + 1]) / 2;
    const h = Math.max(b[i + 1] - b[i], 1e-3);
    const d = (x - c) / h;
    return Math.abs(d) < 1 ? GAIN * fade * Math.cos((Math.PI / 2) * d) ** 2 : 0;
  });
}

const splits = (p: Parametric): [number, number, number] =>
  [p.split1 / 100, p.split2 / 100, p.split3 / 100];
// regions run dark to light
const amounts = (p: Parametric) => [p.shadows, p.darks, p.lights, p.highlights].map((v) => v / 100);

export function curve(p: Parametric): [number, number][] {
  const s = splits(p);
  const a = amounts(p);
  let prev = -Infinity;
  return xs.map((x, k) => {
    let y = x + bumps(x, s).reduce((acc, b, i) => acc + a[i] * b, 0);
    if (k === 0) y = 0;
    if (k === NODES - 1) y = 1;
    // tonecurve wants a monotone curve; keep each node above the last
    y = Math.min(1, Math.max(y, prev + 1e-4, 0));
    prev = y;
    return [x, y];
  });
}

// the parametric settings that best reproduce a curve: exact for curves
// written by curve() (splits on a 5% grid), a best fit for anything else.
// returns null when the curve is not one of ours
export function fit(nodes: [number, number][]): Parametric | null {
  if (nodes.length !== NODES || nodes.some(([x], k) => Math.abs(x - xs[k]) > 1e-4)) return null;
  let best: { p: Parametric; err: number } | null = null;
  const tryFit = (s1: number, s2: number, s3: number) => {
    const s: [number, number, number] = [s1 / 100, s2 / 100, s3 / 100];
    const A = xs.map((x) => bumps(x, s));
    const r = nodes.map(([x, y]) => y - x);
    const a = leastSquares(A, r);
    const err = A.reduce((e, row, k) => e + (row.reduce((t, v, i) => t + v * a[i], 0) - r[k]) ** 2, 0);
    // a flat curve fits any splits equally well; only a strictly better fit
    // may move them off the defaults tried first
    if (!best || err < best.err - 1e-9) {
      const v = a.map((t) => Math.round(Math.max(-1, Math.min(1, t)) * 100));
      best = { err, p: { shadows: v[0], darks: v[1], lights: v[2], highlights: v[3],
                         split1: s1, split2: s2, split3: s3 } };
    }
  };
  tryFit(25, 50, 75);
  for (let s1 = 10; s1 <= 40; s1 += 5)
    for (let s2 = Math.max(s1 + 10, 30); s2 <= 70; s2 += 5)
      for (let s3 = Math.max(s2 + 10, 60); s3 <= 90; s3 += 5) tryFit(s1, s2, s3);
  // accept only what regenerates the curve: a curve drawn in darktable can
  // fit closely and must still not be replaced by an approximation
  const found = best as { p: Parametric; err: number } | null;
  if (!found) return null;
  const again = curve(found.p);
  return again.every(([, y], k) => Math.abs(y - nodes[k][1]) < 5e-4) ? found.p : null;
}

// normal equations for a 4-unknown fit; tiny ridge keeps empty regions at 0
function leastSquares(A: number[][], r: number[]): number[] {
  const n = 4;
  const M = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => A.reduce((t, row) => t + row[i] * row[j], 0) + (i === j ? 1e-9 : 0)));
  const v = Array.from({ length: n }, (_, i) => A.reduce((t, row, k) => t + row[i] * r[k], 0));
  for (let i = 0; i < n; i++) {
    const piv = M[i][i];
    for (let j = i; j < n; j++) M[i][j] /= piv;
    v[i] /= piv;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      const f = M[k][i];
      for (let j = i; j < n; j++) M[k][j] -= f * M[i][j];
      v[k] -= f * v[i];
    }
  }
  return v;
}

// the most nodes tonecurve holds per channel; a point curve may use them all
export const MAX_NODES = 20;

export const nodeFields = (): string[] =>
  ["tonecurve_nodes[0]", "tonecurve_autoscale_ab",
   ...Array.from({ length: MAX_NODES }, (_, k) => [`tonecurve[0][${k}].x`, `tonecurve[0][${k}].y`]).flat()];

export type Point = [number, number];

// a point curve as tonecurve's L nodes, in RGB linked mode
export function pointsToParams(points: Point[]): Record<string, number> {
  const out: Record<string, number> = { "tonecurve_nodes[0]": points.length, tonecurve_autoscale_ab: 3 };
  points.forEach(([x, y], k) => {
    out[`tonecurve[0][${k}].x`] = x;
    out[`tonecurve[0][${k}].y`] = y;
  });
  return out;
}

export function paramsToPoints(params: Record<string, number>): Point[] {
  const n = Math.max(2, Math.min(MAX_NODES, params["tonecurve_nodes[0]"] ?? 2));
  return Array.from({ length: n }, (_, k) =>
    [params[`tonecurve[0][${k}].x`] ?? k / (n - 1), params[`tonecurve[0][${k}].y`] ?? k / (n - 1)] as Point);
}

export const isIdentity = (points: Point[]) => points.every(([x, y]) => Math.abs(x - y) < 1e-4);

// monotone cubic Hermite (Fritsch-Carlson) through the points, tonecurve's
// default interpolation, for drawing the curve as it will be applied
export function monotone(points: Point[]): (x: number) => number {
  const n = points.length;
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const d = xs.slice(0, -1).map((x, i) => (ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - x));
  const m = xs.map((_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : (d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b;
    if (h > 9) { const t = 3 / Math.sqrt(h); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
         + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

export function toParams(p: Parametric): Record<string, number> {
  // RGB, linked channels: darktable's default mode for this module
  const out: Record<string, number> = { "tonecurve_nodes[0]": NODES, tonecurve_autoscale_ab: 3 };
  curve(p).forEach(([x, y], k) => {
    out[`tonecurve[0][${k}].x`] = x;
    out[`tonecurve[0][${k}].y`] = y;
  });
  return out;
}

export function fromParams(params: Record<string, number>): Parametric | null {
  if (params["tonecurve_nodes[0]"] !== NODES) return null;
  return fit(xs.map((_, k) => [params[`tonecurve[0][${k}].x`], params[`tonecurve[0][${k}].y`]]));
}

// R, G and B curves live in rgbcurve, moved to run just after the tone
// mapper, where values are linear display light. the editor works in the
// same display-encoded tones as the histogram (sRGB's transfer curve), so
// points are converted both ways, and the curve is drawn as rgbcurve will
// apply it: interpolated in linear light, shown in display tones
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toDisplay = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export const channelPointsToLinear = (points: Point[]): Point[] =>
  points.map(([x, y]) => [toLinear(x), toLinear(y)]);
export const channelPointsFromLinear = (points: Point[]): Point[] =>
  points.map(([x, y]) => [toDisplay(x), toDisplay(y)]);
export function channelCurve(points: Point[]): (x: number) => number {
  const f = monotone(channelPointsToLinear(points));
  return (x) => toDisplay(Math.min(1, Math.max(0, f(toLinear(x)))));
}
