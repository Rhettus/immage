// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's eight HSL bands on darktable's color equalizer. colorequal.c
// puts its eight nodes every 45° of hue and draws a smooth curve through
// them (_periodic_RBF_interpolate); Lightroom's bands sit unevenly, its
// Blue nearer the equalizer's lavender node than its blue one. so each
// slider sets the mix of nodes whose curve comes closest to its band: its
// full effect at its own hue, falling to none at the bands either side.
// Blue and Purple are 16° apart here, too close for the curve to keep
// them apart: each still reaches about 40% at the other's hue

const NODES = 8;

// Lightroom's band hues (HSV 0, 30, 60, 120, 180, 240, 270, 300) as the
// equalizer measures hue: darktable UCS, with red at 0 (colorequal.c's
// ANGLE_SHIFT). each is the mean over sRGB colors of that hue from 20% to
// 100% saturation
const CENTERS = [-3, 32, 80, 118, 175, 260, 276, 298];

// how much each center weighs in the fit against the rest of the circle,
// in degrees of it. the bands then reach 80-95% of their effect at their
// own hue, where an unweighted fit reaches 75-90%; fitting the centers
// exactly swings the nodes past ±3, far outside darktable's ranges
const CENTER_WEIGHT = 22.5;

// colorequal.c's radial basis at the smoothing it gives saturation and
// brightness, and hue at its default curve (smoothing_hue 1)
const SMOOTHING = Math.PI;
const TERMS = Math.ceil(3 * Math.sqrt(SMOOTHING));
const rad = (deg: number) => (deg * Math.PI) / 180;
const phi = (d: number) => {
  let s = 0;
  for (let l = 0; l < TERMS; l++) s += Math.exp((-l * l) / SMOOTHING) * Math.cos(l * Math.abs(d));
  return Math.exp(s);
};
// _get_hue_node: node k at k·45° plus ANGLE_SHIFT, at the default node placement
const nodeHue = (k: number) => rad(k * 45 + 20);

// A X = B by Gauss-Jordan elimination, for these 8×8 systems
function solve(a: number[][], b: number[][]): number[][] {
  const n = a.length, m = a.map((row, i) => [...row, ...b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c];
    for (let j = c; j < m[c].length; j++) m[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c || !m[r][c]) continue;
      const f = m[r][c];
      for (let j = c; j < m[r].length; j++) m[r][j] -= f * m[c][j];
    }
  }
  return m.map((row) => row.slice(n));
}
const identity = (n: number) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
const apply = (p: number[][], v: number[]) => p.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));

// signed degrees from b to a, around the circle
const delta = (a: number, b: number) => ((((a - b + 180) % 360) + 360) % 360) - 180;

// the fit: nodes = P · slider effects, over every degree of hue
function fit(): number[][] {
  const lambda = solve(Array.from({ length: NODES }, (_, i) =>
    Array.from({ length: NODES }, (_, j) => phi(nodeHue(i) - nodeHue(j)))), identity(NODES));
  const ata = Array.from({ length: NODES }, () => new Array(NODES).fill(0));
  const atb = Array.from({ length: NODES }, () => new Array(NODES).fill(0));
  for (let h = 0; h < 360; h++) {
    // the curve each node alone draws at h, and each band's target there
    const basis = Array.from({ length: NODES }, (_, n) =>
      lambda.reduce((s, row, i) => s + row[n] * phi(rad(h + 20) - nodeHue(i)), 0));
    const target = CENTERS.map((c, j) => {
      const d = delta(h, c);
      const width = d <= 0 ? delta(c, CENTERS[(j + NODES - 1) % NODES]) : delta(CENTERS[(j + 1) % NODES], c);
      return Math.max(0, 1 - Math.abs(d) / width);
    });
    const w = 1 + (CENTERS.some((c) => (((Math.round(c) % 360) + 360) % 360) === h) ? CENTER_WEIGHT : 0);
    for (let i = 0; i < NODES; i++) for (let j = 0; j < NODES; j++) {
      ata[i][j] += w * basis[i] * basis[j];
      atb[i][j] += w * basis[i] * target[j];
    }
  }
  return solve(ata, atb);
}

const P = fit();
const P_INV = solve(P, identity(NODES));

// the equalizer's eight node offsets, red to magenta, for the eight
// sliders' effects in the same units
export const toNodes = (effects: number[]) => apply(P, effects);
// the sliders' effects that set these node offsets. exact for any nodes,
// so a band darktable or an older Immage set reads as a mix of sliders
export const fromNodes = (nodes: number[]) => apply(P_INV, nodes);
