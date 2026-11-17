// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the wavelet curve editor's rules, ported from denoiseprofile.c and
// rawdenoise.c (the two share them): one curve per channel over the module's
// bands, `x[ch][k]` fixed at k / (bands - 1) and `y[ch][k]` the noise force
// at each band. ModuleBands.tsx draws them
import { curveFn } from "./tonecurve";

export const RES = 64;   // DT_IOP_*_RES: samples of a drawn curve

// the radius a drag affects, as a share of the graph's width
export const startRadius = (bands: number) => 1 / (bands * 2);

// *_scrolled: a notch down (dy > 0) shrinks the radius by 10%, up grows it,
// between 0.2 / bands and 1
export const wheelRadius = (radius: number, dy: number, bands: number) =>
  Math.min(1, Math.max(0.2 / bands, radius * (1 - 0.1 * dy)));

// the curve of one channel as it is drawn and applied (denoiseprofile.c
// commit_params and denoiseprofile_draw, rawdenoise.c likewise): a
// Catmull-Rom spline through the bands, with a node before the first at the
// second to last band's x less one and the first band's y, and one after the
// last at the second band's x plus one and the last band's y
export function bandCurve(xs: number[], ys: number[]): (x: number) => number {
  const n = xs.length;
  return curveFn(1, [[xs[n - 2] - 1, ys[0]], ...xs.map((x, k): [number, number] => [x, ys[k]]), [xs[1] + 1, ys[n - 1]]]);
}

// *_get_params: the bands near mouse x are pulled toward mouse y, by a
// gaussian of the bands' distance over the radius
export function pull(xs: number[], ys: number[], mouseX: number, mouseY: number, radius: number): number[] {
  return ys.map((y, k) => {
    const f = Math.exp(-((mouseX - xs[k]) * (mouseX - xs[k])) / (radius * radius));
    return (1 - f) * y + f * mouseY;
  });
}

// the highlighted region under the pointer: the curve with the pull at its
// lowest (mouse y 0) and its highest (mouse y 1), sampled over RES points
export function pullRange(xs: number[], ys: number[], mouseX: number, radius: number): [number[], number[]] {
  const at = (v: number) => {
    const c = bandCurve(xs, pull(xs, ys, mouseX, v, radius));
    return Array.from({ length: RES }, (_, k) => c(k / (RES - 1)));
  };
  return [at(0), at(1)];
}

// *_button_press: where the pointer grabs the curve is kept as an offset, so a
// drag moves the curve by the pointer's travel, not to the pointer
export const grabOffset = (xs: number[], ys: number[], mouseX: number, mouseY: number) =>
  bandCurve(xs, ys)(mouseX) - mouseY;
