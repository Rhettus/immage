// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's manual Transform as darktable's rotate and perspective (ashift)
// in its generic lens model. ashift computes its automatic crop only in its
// GUI (ashift.c, _do_crop() writes gui data), so headless the crop has to be
// supplied with the params; without it a rotation leaves black corners.
// homography() is a port of ashift.c's _homography() for the generic model
// (focal length 28 mm, no lens dependence), with its aspect adjustment

type Mat = number[][];
type Vec = [number, number, number];

const mul = (a: Mat, b: Mat): Mat =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((t, v, k) => t + v * b[k][j], 0)));
const apply = (m: Mat, p: Vec): Vec =>
  [0, 1, 2].map((i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2]) as Vec;

const DEFAULT_F_LENGTH = 28;

export function homography(angleDeg: number, shiftV: number, shiftH: number,
                           width: number, height: number, aspect = 1): Mat {
  const u = width, v = height;
  const phi = (angleDeg * Math.PI) / 180;
  const cosi = Math.cos(phi), sini = Math.sin(phi);
  const f = DEFAULT_F_LENGTH;
  const horifac = 1, vertifac = 1; // 1 - orthocorr/100 with orthocorr 0
  const ascale = Math.sqrt(aspect);

  const expV = Math.exp(shiftV);
  const radV = (f / (14.4 + (v / u - 1) * 7.2)) * (expV - 1) / (expV + 1);
  const rtV = Math.sin(0.5 * Math.max(-1.5, Math.min(1.5, Math.atan(radV))));
  const rV = Math.max(0.1, 2 * (horifac - 1) * rtV * rtV + 1);

  const expH = Math.exp(shiftH);
  const radH = (f / (14.4 + (u / v - 1) * 7.2)) * (expH - 1) / (expH + 1);
  const rtH = Math.sin(0.5 * Math.max(-1.5, Math.min(1.5, Math.atan(radH))));
  const rH = Math.max(0.1, 2 * (vertifac - 1) * rtH * rtH + 1);

  const flip: Mat = [[0, 1, 0], [1, 0, 0], [0, 0, 1]];
  const steps: Mat[] = [
    flip,
    [[cosi, -sini, -0.5 * v * cosi + 0.5 * u * sini + 0.5 * v],
     [sini, cosi, -0.5 * v * sini - 0.5 * u * cosi + 0.5 * u],
     [0, 0, 1]],
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], // shear 0
    [[expV, 0, 0],
     [(0.5 * ((expV - 1) * u)) / v, (2 * expV) / (expV + 1), (-0.5 * ((expV - 1) * u)) / (expV + 1)],
     [(expV - 1) / v, 0, 1]],
    [[1, 0, 0], [0, rV, 0.5 * u * (1 - rV)], [0, 0, 1]],
    flip,
    [[expH, 0, 0],
     [(0.5 * ((expH - 1) * v)) / u, (2 * expH) / (expH + 1), (-0.5 * ((expH - 1) * v)) / (expH + 1)],
     [(expH - 1) / u, 0, 1]],
    [[1, 0, 0], [0, rH, 0.5 * v * (1 - rH)], [0, 0, 1]],
    [[ascale, 0, 0], [0, 1 / ascale, 0], [0, 0, 1]],
  ];
  // each step multiplies onto the left, as the C code's mwork * minput
  let m = steps[0];
  for (const s of steps.slice(1)) m = mul(s, m);

  // step 10: shift so no corner lands at negative coordinates
  let umin = Infinity, vmin = Infinity;
  for (const y of [0, height - 1])
    for (const x of [0, width - 1]) {
      const p = apply(m, [x, y, 1]);
      umin = Math.min(umin, p[0] / p[2]);
      vmin = Math.min(vmin, p[1] / p[2]);
    }
  return mul([[1, 0, -umin], [0, 1, -vmin], [0, 0, 1]], m);
}

export type Crop = { cl: number; cr: number; ct: number; cb: number };

// the largest rectangle of the image's own aspect inside the transformed
// image, as fractions of the output's bounding box (ashift's cl/cr/ct/cb)
export function autoCrop(angleDeg: number, shiftV: number, shiftH: number,
                         width: number, height: number, aspectAdjust = 1): Crop {
  if (angleDeg === 0 && shiftV === 0 && shiftH === 0 && aspectAdjust === 1) return { cl: 0, cr: 1, ct: 0, cb: 1 };
  const m = homography(angleDeg, shiftV, shiftH, width, height, aspectAdjust);
  const quad = ([[0, 0], [0, height], [width, height], [width, 0]] as const).map(([x, y]) => {
    const p = apply(m, [x, y, 1]);
    return [p[0] / p[2], p[1] / p[2]] as [number, number];
  });
  const xs = quad.map((q) => q[0]), ys = quad.map((q) => q[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const owd = xmax - xmin, oht = ymax - ymin;

  // inside a convex quad: on the same side of every edge as its winding
  const area = quad.reduce((a, [x, y], i) => {
    const [x2, y2] = quad[(i + 1) % 4];
    return a + x * y2 - x2 * y;
  }, 0);
  const sign = Math.sign(area);
  const inside = (x: number, y: number) => quad.every(([x1, y1], i) => {
    const [x2, y2] = quad[(i + 1) % 4];
    return sign * ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) >= -1e-6;
  });

  const aspect = width / height;
  const fits = (cx: number, cy: number, hw: number) => {
    const hh = hw / aspect;
    return inside(cx - hw, cy - hh) && inside(cx + hw, cy - hh)
        && inside(cx + hw, cy + hh) && inside(cx - hw, cy + hh);
  };
  // a keystone moves the best center off the middle, so search a grid of
  // centers around it, the largest half-width for each by bisection. near
  // 45 degrees several centers fit the same size; the nearest the middle
  // is searched first and kept unless another fits a larger one
  const steps: [number, number][] = [];
  for (let i = -6; i <= 6; i++) for (let j = -6; j <= 6; j++) steps.push([i, j]);
  steps.sort((p, q) => Math.hypot(p[0], p[1]) - Math.hypot(q[0], q[1]));
  let best = { cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2, hw: 0 };
  for (const [i, j] of steps) {
    const cx = (xmin + xmax) / 2 + (i / 6) * 0.15 * owd;
    const cy = (ymin + ymax) / 2 + (j / 6) * 0.15 * oht;
    if (!inside(cx, cy)) continue;
    let lo = 0, hi = owd / 2;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (fits(cx, cy, mid)) lo = mid; else hi = mid;
    }
    if (lo > best.hw * (1 + 1e-6)) best = { cx, cy, hw: lo };
  }
  const hh = best.hw / aspect;
  return {
    cl: (best.cx - best.hw - xmin) / owd,
    cr: (best.cx + best.hw - xmin) / owd,
    ct: (best.cy - hh - ymin) / oht,
    cb: (best.cy + hh - ymin) / oht,
  };
}
