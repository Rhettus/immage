// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an automatic B&W Mix from the image's colors: each hue present in a
// real share of the image moves lighter or darker as its colors are
// lighter or darker than the image's colored average, so hues that would
// merge into one gray come apart. the mix is a starting point to adjust
import { BANDS, type Values } from "./manifest";
import { hsl, NEUTRAL_SAT } from "./probe";

const SAMPLES = 120_000;
const MIN_SHARE = 0.03;  // of the image's saturated weight
// doubled when the B&W Mix's units halved (manifest.ts, BW_SCALE), so the
// mix does what it did; the limit, once 60, stops at the slider's end
const GAIN = 240;        // mix units per unit of lightness difference
const LIMIT = 100;

export function autoMix(px: Uint8ClampedArray, width: number, height: number): Values {
  const weight = new Array(BANDS.length).fill(0), light = new Array(BANDS.length).fill(0);
  const n = width * height, stride = Math.max(1, Math.floor(n / SAMPLES));
  for (let i = 0; i < n; i += stride) {
    const [h, s, l] = hsl(px[4 * i] / 255, px[4 * i + 1] / 255, px[4 * i + 2] / 255);
    if (s < NEUTRAL_SAT) continue;
    // the band whose center hue is nearest, around the circle
    let band = 0, best = 360;
    BANDS.forEach(([, , c], k) => {
      const d = Math.min(Math.abs(h - c), 360 - Math.abs(h - c));
      if (d < best) { best = d; band = k; }
    });
    weight[band] += s;
    light[band] += s * l;
  }
  const total = weight.reduce((a, b) => a + b, 0);
  const mean = total ? light.reduce((a, b) => a + b, 0) / total : 0.5;
  return Object.fromEntries(BANDS.map(([b], k) => {
    if (!total || weight[k] / total < MIN_SHARE) return [`bw_${b}`, 0];
    const v = Math.round(GAIN * (light[k] / weight[k] - mean));
    return [`bw_${b}`, Math.max(-LIMIT, Math.min(LIMIT, v))];
  }));
}
