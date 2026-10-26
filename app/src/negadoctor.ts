// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// film negatives through darktable's negadoctor: its presets, and its
// pickers, which darktable runs only from its GUI. the pickers are ports of
// the apply_auto_* functions of src/iop/negadoctor.c (darktable 2747ed2a0d),
// fed what the engine's `sample` reads over a box at negadoctor's input, so a
// pick here sets what the same pick sets in darktable

import type { Values } from "./manifest";

export const FILM_BW = 0;
export const FILM_COLOR = 1;

export type RGB = [number, number, number];
// negadoctor's params, as the Negative panel works on them; exposure is the
// linear factor darktable stores, which the panel shows in EV
export type NegParams = {
  film: number;
  dmin: RGB;
  dmax: number;
  offset: number;
  wbLow: RGB;
  wbHigh: RGB;
  black: number;
  grade: number;
  gloss: number;
  exposure: number;
};
// a box's least, mean and most of each channel, at negadoctor's input, as
// darktable's picker reads them (engine `sample`'s `picker`)
export type Stats = { min: RGB; mean: RGB; max: RGB };

// negadoctor.c's THRESHOLD, -32 EV
const THRESHOLD = 2 ** -32;

// init_presets(): what a film type starts from before its pickers
export const PRESETS: Record<number, NegParams> = {
  [FILM_COLOR]: { film: FILM_COLOR, dmin: [1.13, 0.49, 0.27], dmax: 1.6, offset: -0.05, wbLow: [1, 1, 1],
                  wbHigh: [1, 1, 1], black: 0.0755, grade: 4, gloss: 0.75, exposure: 0.9245 },
  [FILM_BW]: { film: FILM_BW, dmin: [1, 1, 1], dmax: 2.2, offset: -0.05, wbLow: [1, 1, 1],
               wbHigh: [1, 1, 1], black: 0.0755, grade: 5, gloss: 0.75, exposure: 1 },
};

const RGB_IDS = ["r", "g", "b"] as const;

export function fromValues(v: Values): NegParams {
  const rgb = (k: string) => RGB_IDS.map((c) => v[`neg_${k}_${c}`]) as RGB;
  return { film: v.neg_film, dmin: rgb("dmin"), dmax: v.neg_dmax, offset: v.neg_offset, wbLow: rgb("wbl"),
           wbHigh: rgb("wbh"), black: v.neg_black, grade: v.neg_grade, gloss: v.neg_gloss,
           exposure: 2 ** v.neg_exposure };
}

// each field's $MIN and $MAX in dt_iop_negadoctor_params_t: a pick on a box
// that holds no image (all border, or clipped) can land outside them
export const NEG_RANGES: Record<string, [number, number]> = {
  dmin: [0.00001, 1.5], dmax: [0.1, 6], offset: [-1, 1], wbl: [0.25, 2], wbh: [0.25, 2], black: [-0.5, 0.5],
  grade: [1, 8], gloss: [0.0001, 1], exposure: [-1, 1],
};
const clamp = (k: string, x: number) =>
  Number.isFinite(x) ? Math.min(NEG_RANGES[k][1], Math.max(NEG_RANGES[k][0], x)) : (NEG_RANGES[k][0] + NEG_RANGES[k][1]) / 2;

export function toValues(p: NegParams): [string, number][] {
  const rgb = (k: string, x: RGB) => RGB_IDS.map((c, i): [string, number] => [`neg_${k}_${c}`, clamp(k, x[i])]);
  return [["neg_film", p.film], ...rgb("dmin", p.dmin), ["neg_dmax", clamp("dmax", p.dmax)],
          ["neg_offset", clamp("offset", p.offset)], ...rgb("wbl", p.wbLow), ...rgb("wbh", p.wbHigh),
          ["neg_black", clamp("black", p.black)], ["neg_grade", clamp("grade", p.grade)],
          ["neg_gloss", clamp("gloss", p.gloss)], ["neg_exposure", clamp("exposure", Math.log2(p.exposure))]];
}

// commit_params() runs black and white film on Dmin's first channel alone;
// the pickers read the same, where darktable's read all three and then
// render with one
const dminOf = (p: NegParams): RGB => (p.film === FILM_BW ? [p.dmin[0], p.dmin[0], p.dmin[0]] : p.dmin);
const density = (dmin: number, x: number) => Math.log10(dmin / Math.max(x, THRESHOLD));

// the film base, from the mean of a box on the unexposed border
export function autoDmin(p: NegParams, s: Stats): NegParams {
  const m = s.mean;
  return { ...p, dmin: p.film === FILM_BW ? [m[0], m[0], m[0]] : [m[0], m[1], m[2]] };
}

// the film's density range, from the box's least. darktable takes the
// max of the channels, so as not to clip the whites; a camera scan's blue,
// under the orange mask, reads its densest parts as noise around zero,
// which as the max darkened the whole print. the middle channel leaves
// one such channel out
export function autoDmax(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  const dens = [0, 1, 2].map((c) => density(d[c], s.min[c])).sort((a, b) => a - b);
  return { ...p, dmax: dens[1] };
}

// the scan's black, from the box's most: the min of the channels, which
// does not clip the blacks
export function autoOffset(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  return { ...p, offset: Math.min(...[0, 1, 2].map((c) => density(d[c], s.max[c]) / p.dmax)) };
}

// the shadows' cast, from the mean of a box that should be neutral black
export function autoWbLow(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  const r = [0, 1, 2].map((c) => density(d[c], s.mean[c]) / p.dmax);
  const least = Math.min(...r);
  return { ...p, wbLow: r.map((x) => least / x) as RGB };
}

// the highlights' white balance, from the mean of a box that should be
// neutral
export function autoWbHigh(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  const r = [0, 1, 2].map((c) => Math.abs(-1 / (p.offset * p.wbLow[c] - density(d[c], s.mean[c]) / p.dmax)));
  const least = Math.min(...r);
  return { ...p, wbHigh: r.map((x) => x / least) as RGB };
}

// the paper black, from the box's most: what maps to black, a little
// short of it for the paper grade that follows
export function autoBlack(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  const v = [0, 1, 2].map((c) => {
    const x = (-density(d[c], s.max[c]) * p.wbHigh[c]) / p.dmax + p.wbLow[c] * p.offset * p.wbHigh[c];
    return 0.1 - (1 - 10 ** x);
  });
  return { ...p, black: Math.max(...v) };
}

// the print exposure, from the box's least: the brightest at 0.96. the
// offset term goes without wb_high here, as in apply_auto_exposure()
export function autoExposure(p: NegParams, s: Stats): NegParams {
  const d = dminOf(p);
  const v = [0, 1, 2].map((c) => {
    const x = (-density(d[c], s.min[c]) * p.wbHigh[c]) / p.dmax + p.wbLow[c] * p.offset;
    return 0.96 / (1 - 10 ** x + p.black);
  });
  return { ...p, exposure: Math.min(...v) };
}

// the photo area's pickers in darktable's order, each from what the one
// before it set: density range, scan black, paper black, print exposure
export function autoArea(p: NegParams, s: Stats): NegParams {
  return autoExposure(autoBlack(autoOffset(autoDmax(p, s), s), s), s);
}
