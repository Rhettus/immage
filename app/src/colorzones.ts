// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's color zones curves (colorzones.c): three pages, each a curve
// over the "select by" axis, and what its graph draws and edits
import { curveFn, type Point } from "./tonecurve";

export const CZ_PAGES = ["Lightness", "Chroma", "Hue"] as const;
export type CzPage = 0 | 1 | 2;
export const CZ_HUE = 2;            // select by hue (channel 2): the x axis of every page wraps
export const CZ_V1 = 0;             // splines_version: the old end-node scheme
export const CZ_MAX_NODES = 20;     // DT_IOP_COLORZONES_MAXNODES
export const CZ_MIN_X = 0.0025;     // DT_IOP_COLORZONES_MIN_X_DISTANCE
export const CZ_CATMULL_ROM = 1;    // the curve_type _reset_parameters sets

// _colorzones_nodes: the stored count clamped to what the arrays and the
// version allow (V1 reads nodes - 2, so it needs two)
export const czMinNodes = (version: number) => (version === CZ_V1 ? 2 : 1);

// _reset_nodes with _reset_parameters' two nodes: the ends are touched for
// V1 or a select by other than hue, else the nodes sit at (k + 0.5) / n
export function czDefaultPoints(version: number, selectHue: boolean): Point[] {
  const n = 2;
  return Array.from({ length: n }, (_, k): Point =>
    [version === CZ_V1 || !selectHue ? k / (n - 1) : (k + 0.5) / n, 0.5]);
}

// ---- darktable's V2 sampling, ported from src/common/splines.cpp: the
// interpol:: spline_base (operator(), lines 61-177), Catmull_Rom_spline (183),
// monotone_hermite_spline (249), monotone_hermite_spline_variant (366) and
// smooth_cubic_spline (457), then CurveDataSampleV2 (749) for the open curve
// and CurveDataSampleV2Periodic (847). only the float rounding of the
// 16-bit sample table is left out. type: 0 cubic spline, 1 Catmull-Rom,
// 2 monotone Hermite (the variant, in the periodic sampler)
type KP = { x: number; y: number; dy: number };

function tangents(kind: "cubic" | "catmull" | "mono" | "variant", pts: KP[], periodic: boolean, period: number) {
  const N = pts.length;
  if (N === 1) { pts[0].dy = 0; return; }
  const Dx = (i: number) => pts[i + 1].x - pts[i].x;
  const wrapDx = pts[0].x - pts[N - 1].x + period;
  if (kind === "catmull") {
    if (periodic) {
      pts[0].dy = (pts[1].y - pts[N - 1].y) / (pts[1].x - pts[N - 1].x + period);
      for (let i = 1; i < N - 1; i++) pts[i].dy = (pts[i + 1].y - pts[i - 1].y) / (pts[i + 1].x - pts[i - 1].x);
      pts[N - 1].dy = (pts[0].y - pts[N - 2].y) / (pts[0].x - pts[N - 2].x + period);
    } else {
      pts[0].dy = (pts[1].y - pts[0].y) / Dx(0);
      for (let i = 1; i < N - 1; i++) pts[i].dy = (pts[i + 1].y - pts[i - 1].y) / (pts[i + 1].x - pts[i - 1].x);
      pts[N - 1].dy = (pts[N - 1].y - pts[N - 2].y) / (pts[N - 1].x - pts[N - 2].x);
    }
  } else if (kind === "mono") {
    const eps = 1.1920929e-7;
    const Delta: number[] = [];
    for (let i = 0; i < N - 1; i++) Delta.push((pts[i + 1].y - pts[i].y) / Dx(i));
    const limit = (i: number, j: number) => {
      if (Math.abs(Delta[i]) < eps) { pts[i].dy = pts[j].dy = 0; return; }
      const a = pts[i].dy / Delta[i], b = pts[j].dy / Delta[i], tau = a * a + b * b;
      if (tau > 9) { pts[i].dy = 3 * a * Delta[i] / Math.sqrt(tau); pts[j].dy = 3 * b * Delta[i] / Math.sqrt(tau); }
    };
    if (periodic) {
      Delta.push((pts[0].y - pts[N - 1].y) / wrapDx);
      pts[0].dy = Delta[N - 1] * Delta[0] <= 0 ? 0 : (Delta[N - 1] + Delta[0]) / 2;
      for (let i = 1; i < N; i++) pts[i].dy = Delta[i - 1] * Delta[i] <= 0 ? 0 : (Delta[i - 1] + Delta[i]) / 2;
      for (let i = 0; i < N; i++) limit(i, i + 1 < N ? i + 1 : 0);
    } else {
      pts[0].dy = Delta[0];
      for (let i = 1; i < N - 1; i++) pts[i].dy = Delta[i - 1] * Delta[i] <= 0 ? 0 : (Delta[i - 1] + Delta[i]) / 2;
      pts[N - 1].dy = Delta[N - 2];
      for (let i = 0; i < N - 1; i++) limit(i, i + 1);
    }
  } else if (kind === "variant") {
    const G = (S1: number, S2: number, h1: number, h2: number) => {
      if (S1 * S2 > 0) { const a = (h1 + 2 * h2) / (3 * (h1 + h2)); return S1 * S2 / (a * S2 + (1 - a) * S1); }
      return 0;
    };
    const h: number[] = [], Delta: number[] = [];
    for (let i = 0; i < N - 1; i++) { h.push(Dx(i)); Delta.push((pts[i + 1].y - pts[i].y) / Dx(i)); }
    if (periodic) {
      h.push(wrapDx); Delta.push((pts[0].y - pts[N - 1].y) / wrapDx);
      pts[0].dy = G(Delta[N - 1], Delta[0], h[N - 1], h[0]);
      for (let i = 1; i < N; i++) pts[i].dy = G(Delta[i - 1], Delta[i], h[i - 1], h[i]);
    } else {
      pts[0].dy = Delta[0];
      for (let i = 1; i < N - 1; i++) pts[i].dy = G(Delta[i - 1], Delta[i], h[i - 1], h[i]);
      pts[N - 1].dy = Delta[N - 2];
    }
  } else {
    const dX: number[] = [], dY: number[] = [];
    for (let i = 0; i < N - 1; i++) { dX.push(Dx(i)); dY.push(pts[i + 1].y - pts[i].y); }
    if (periodic) { dX.push(wrapDx); dY.push(pts[0].y - pts[N - 1].y); }
    // the second derivatives at the knots (matrix A, vector b), solved without pivoting
    const A = Array.from({ length: N }, () => new Array<number>(N).fill(0));
    const b = new Array<number>(N).fill(0);
    for (let i = 1; i < N - 1; i++) {
      A[i][i - 1] = dX[i - 1] / 6;
      A[i][i] = (dX[i - 1] + dX[i]) / 3;
      A[i][i + 1] = dX[i] / 6;
      b[i] = dY[i] / dX[i] - dY[i - 1] / dX[i - 1];
    }
    if (periodic) {
      A[0][0] = (dX[N - 1] + dX[0]) / 3;
      A[N - 1][N - 1] = (dX[N - 2] + dX[N - 1]) / 3;
      b[0] = dY[0] / dX[0] - dY[N - 1] / dX[N - 1];
      b[N - 1] = dY[N - 1] / dX[N - 1] - dY[N - 2] / dX[N - 2];
      if (N > 2) {
        A[0][1] = dX[0] / 6;
        A[N - 1][N - 2] = dX[N - 2] / 6;
        A[0][N - 1] = A[N - 1][0] = dX[N - 1] / 6;
      } else A[0][1] = A[1][0] = (dX[0] + dX[1]) / 6;
    } else { A[0][0] = 1; A[N - 1][N - 1] = 1; }
    for (let i = 0; i + 1 < N; i++) {
      const t = A[i][i];
      if (t === 0) break;                        // LU_factor: singular, b stays as is
      for (let k = i + 1; k < N; k++) {
        A[k][i] /= t;
        for (let j = i + 1; j < N; j++) A[k][j] -= A[k][i] * A[i][j];
      }
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < i; k++) b[i] -= A[i][k] * b[k];
    for (let i = N - 1; i >= 0; i--) {
      for (let k = i + 1; k < N; k++) b[i] -= A[i][k] * b[k];
      b[i] /= A[i][i];
    }
    let c = 0;
    for (let i = 0; i < N - 1; i++) {
      c = dY[i] / dX[i] - dX[i] / 6 * (b[i + 1] - b[i]);
      pts[i].dy = -dX[i] * b[i] / 2 + c;
    }
    pts[N - 1].dy = periodic ? dX[N - 2] * b[N - 1] / 2 + c : c;
  }
}

// spline_base: the interpolant through the nodes, over x in [xMin, xMax],
// its y clamped to [0, 1]
function splineBase(kind: Parameters<typeof tangents>[0], nodes: Point[], xMin: number, xMax: number, periodic: boolean) {
  const period = xMax - xMin;
  const pts: KP[] = [];
  for (const [nx, ny] of nodes) {
    if (periodic) { let x = nx % period; if (x < 0) x += period; pts.push({ x, y: ny, dy: 0 }); }
    else if (xMin <= nx && nx <= xMax) pts.push({ x: nx, y: ny, dy: 0 });
  }
  pts.sort((a, b) => a.x - b.x);
  if (!pts.length) throw new Error("empty set of interpolation points");
  tangents(kind, pts, periodic, period);
  const N = pts.length;
  const upper = (x: number) => { let i = 0; while (i < N && pts[i].x <= x) i++; return i; };
  const clamp = (y: number) => Math.min(1, Math.max(0, y));
  return (xIn: number): number => {
    if (N === 1) return pts[0].y;
    let x = xIn, n0 = 0, n1 = 0, h = 0;
    if (periodic) {
      x = x % period;
      if (x < pts[0].x) x += period;
      n0 = upper(x);
      n0 = n0 > 0 ? n0 - 1 : N - 1;
      n1 = n0 + 1 < N ? n0 + 1 : 0;
      h = n1 > n0 ? pts[n1].x - pts[n0].x : pts[n1].x - (pts[n0].x - period);
    } else {
      x = Math.min(Math.max(x, xMin), xMax);
      if (x >= pts[0].x) { n0 = upper(x); if (n0 > 0) n0 = Math.min(n0 - 1, N - 2); }
      n1 = n0 + 1;
      h = pts[n1].x - pts[n0].x;
    }
    let y: number;
    if (!periodic && (x <= pts[0].x || x >= pts[N - 1].x)) {
      const P = x <= pts[0].x ? pts[0] : pts[N - 1];
      y = P.y + (x - P.x) * P.dy;
    } else {
      const dx = (x - pts[n0].x) / h, dx2 = dx * dx, dx3 = dx2 * dx;
      y = (2 * dx3 - 3 * dx2 + 1) * pts[n0].y + (dx3 - 2 * dx2 + dx) * h * pts[n0].dy
        + (-2 * dx3 + 3 * dx2) * pts[n1].y + (dx3 - dx2) * h * pts[n1].dy;
    }
    return clamp(y);
  };
}

// CurveDataSampleV2 (open, holding the end values outside the first and last
// node) and CurveDataSampleV2Periodic (the curve wraps over 0..1), as a
// function of x. an empty node list is the straight line CurveDataSampleV2 makes
export function czSampleV2(type: number, nodes: Point[], periodic: boolean): (x: number) => number {
  if (!nodes.length) return (x) => x;
  const kind = type === 0 ? "cubic" : type === 1 ? "catmull" : periodic ? "variant" : "mono";
  if (periodic) return splineBase(kind, nodes, 0, 1, true);
  const first = nodes[0], last = nodes[nodes.length - 1];
  const s = splineBase(kind, nodes, first[0], last[0], false);
  return (x) => (x < first[0] ? first[1] : x > last[0] ? last[1] : s(x));
}

// the drawn curve, as colorzones.c builds its minmax_curve. V1 pads the
// nodes with the one before the last (one period earlier) and the second
// (one later) and samples them with CurveDataSample (colorzones.c 1161-1214,
// dt_draw_curve_calc_values), which curveFn ports; V2 (1216-1243) samples
// the nodes themselves with dt_draw_curve_calc_values_V2, periodic when
// select by is hue
export function czCurveFn(type: number, points: Point[], version: number, hue: boolean): (x: number) => number {
  const n = points.length;
  if (n < 1) return () => 0.5;
  if (version === CZ_V1) {
    if (n < 2) return () => points[0][1];
    const head: Point = [points[n - 2][0] - 1, hue ? points[n - 2][1] : points[0][1]];
    const tail: Point = [points[1][0] + 1, hue ? points[1][1] : points[n - 1][1]];
    return curveFn(type, [head, ...points, tail]);
  }
  return czSampleV2(type, points, hue);
}

// the band under the axis, colorzones.c _bottom_area_draw_callback (1564-1650):
// 64 cells of LCh at the select-by channel's L, C and hue, through
// COLORZONES_DRAW_BACKGROUD_BOX (1043-1068: LCh -> Lab, the gamut cap, XYZ
// D50, sRGB, as colorspaces_inline_conversions.h). the picked color, unset,
// is _select_base_display_color's sRGB (0, 0.3, 0.7) (857-890). chroma
// is normalize_C = 128 * sqrt(2), bg_sat_factor not applied to this band
const D50 = [0.9642, 1, 0.8249];
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
const labFInv = (f: number) => (f > 0.20689655172413796 ? f * f * f : (116 * f - 16) * (27 / 24389));
const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);
export function czLabToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const X = D50[0] * labFInv(fx), Y = labFInv(fy), Z = D50[2] * labFInv(fz);
  return [
    3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z,
    -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z,
    0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z,
  ].map(linearToSrgb) as [number, number, number];
}
function pickedLCh(): [number, number, number] {
  const [r, g, b] = [0, 0.3, 0.7].map(srgbToLinear);
  const X = 0.4360747 * r + 0.3850649 * g + 0.1430804 * b;
  const Y = 0.2225045 * r + 0.7168786 * g + 0.0606169 * b;
  const Z = 0.0139322 * r + 0.0971045 * g + 0.7141733 * b;
  const fx = labF(X / D50[0]), fy = labF(Y), fz = labF(Z / D50[2]);
  const L = 116 * fy - 16, a = 500 * (fx - fy), bb = -200 * (fz - fy);
  const h = Math.atan2(bb, a);
  return [L, Math.hypot(a, bb), h > 0 ? h / (2 * Math.PI) : 1 - Math.abs(h) / (2 * Math.PI)];
}
export function czBandColors(channel: number, cells = 64): string[] {
  const picked = pickedLCh();
  const normC = 128 * Math.SQRT2;
  return Array.from({ length: cells }, (_, i) => {
    const ii = (i + 0.5) / (cells - 1), iih = i / (cells - 1);
    let L: number, C: number, h: number;
    if (channel === 0) { L = 100 * ii; C = normC * 0.5; h = picked[2]; }
    else if (channel === 1) { L = 50; C = picked[1] * 2 * ii; h = picked[2]; }
    else { L = 50; C = normC * 0.5; h = iih; }
    let a = Math.cos(2 * Math.PI * h) * C, b = Math.sin(2 * Math.PI * h) * C;
    const L0 = L, Lwhite = 100, Lclip = 20, Lcap = Math.min(100, L);
    const clip = 1 - (Lcap - L0) * (1 / 100) * Math.min(Lwhite - Lclip, Math.max(0, L - Lclip)) / (Lwhite - Lclip);
    const clip2 = clip * clip * clip;
    a *= L / L0 * clip2; b *= L / L0 * clip2;
    const [r, g, bl] = czLabToSrgb(L, a, b).map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
    return `rgb(${r} ${g} ${bl})`;
  });
}
// a gradient of those cells as hard stops
export const czBandGradient = (channel: number, cells = 64) =>
  `linear-gradient(to right, ${czBandColors(channel, cells).map((c, i) =>
    `${c} ${(i / cells * 100).toFixed(3)}% ${((i + 1) / cells * 100).toFixed(3)}%`).join(", ")})`;
