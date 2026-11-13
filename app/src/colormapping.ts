// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the color mapping card's cluster previews, ported from colormapping.c's
// cluster_preview_draw: each of the n clusters (at most MAXN) is a 3 x 3 grid
// of swatches at Lab L 53.39, whose a and b are the cluster's mean plus -1, 0
// or +1 of its deviation, side by side in a box one third as high as wide.
// The clusters are the params `source_mean[k][j]` and `source_var[k][j]` (and
// `target_*`), j 0 for a and 1 for b, which the card reads; the engine's
// fields `cm_source` and `cm_target` carry the whole acquired set (histogram,
// weights too) as a number, 0 for none (engine/cmapping.c)
import { labToSrgb } from "./colorchecker";

export const MAXN = 5;
export const PREVIEW_W = 300, PREVIEW_H = 100;   // the box, in its own units
const INSET = 5, SEP = 2;                        // cluster_preview_draw: inset, sep
const LIGHTNESS = 53.390011;

export type Side = "source" | "target";
export type Params = Record<string, number>;

// every cluster param a preview reads, which the card snapshots for undo
export const clusterPaths = () => [
  "cm_source", "cm_target",
  ...(["source", "target"] as const).flatMap((s) => ["mean", "var"].flatMap((k) =>
    Array.from({ length: MAXN }, (_, c) => [0, 1].map((j) => `${s}_${k}[${c}][${j}]`)).flat())),
];

const clamp = (v: number) => Math.min(1, Math.max(0, v));

export type Swatch = { x: number; y: number; w: number; h: number; color: string };

// the swatches of n clusters (clamped to 0..MAXN as the draw does), from the
// param values `p`
export function clusterSwatches(p: (path: string) => number, side: Side, n: number): Swatch[] {
  n = Math.min(MAXN, Math.max(0, Math.round(n)));
  const width = PREVIEW_W - 2 * INSET, height = PREVIEW_H - 2 * INSET;
  const qwd = (width - (n - 1) * SEP) / n;
  const out: Swatch[] = [];
  for (let cl = 0; cl < n; cl++) {
    const ma = p(`${side}_mean[${cl}][0]`), mb = p(`${side}_mean[${cl}][1]`);
    const va = p(`${side}_var[${cl}][0]`), vb = p(`${side}_var[${cl}][1]`);
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const [r, g, b] = labToSrgb(LIGHTNESS, ma + i * va, mb + j * vb).map((v) => Math.round(clamp(v) * 255));
      out.push({ x: INSET + cl * (qwd + SEP) + qwd * (i + 1) / 3, y: INSET + height * (j + 1) / 3,
                 w: qwd / 3 - 0.5, h: height / 3 - 0.5, color: `rgb(${r},${g},${b})` });
    }
  }
  return out;
}

// the edit of a "number of clusters" change: gui_changed discards the acquired
// source and target, as the engine's fields clear them
export const clearsOnClusters = { cm_source: 0, cm_target: 0 };
