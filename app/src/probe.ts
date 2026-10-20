// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the photo under the pointer, as the Tone Curve, HSL and B&W Mix cards
// and the Zone System read it: its display color, where it sits on a
// curve, which color bands it falls in, and its zone
import { useSyncExternalStore } from "react";
import { BANDS } from "./manifest";

export type RGB = [number, number, number]; // display values, 0-255

// what the cards are shown: the display color under the pointer, in
// black and white the color it had before the treatment took it out, and
// while the Zone System is open the zone it falls in
export type Probe = { rgb: RGB; orig: RGB | null; zone: number | null };

// held outside React state: the pointer moves every frame, and only the
// cards that read it should render again
let current: Probe | null = null;
const listeners = new Set<() => void>();
export function setProbe(p: Probe | null) {
  if (p === current) return;
  current = p;
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
// the probe, for a card that reads it; the others always see null and so
// never render again for it
export function useProbe(reads: boolean): Probe | null {
  return useSyncExternalStore(subscribe, () => (reads ? current : null));
}

// the mean over a few pixels round (ix, iy), 0-1 across the image
export function pixelAt(px: Uint8ClampedArray, width: number, height: number, ix: number, iy: number): RGB | null {
  if (ix < 0 || ix > 1 || iy < 0 || iy > 1 || !width || !height) return null;
  const cx = Math.round(ix * (width - 1)), cy = Math.round(iy * (height - 1));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - 1); y <= Math.min(height - 1, cy + 1); y++)
    for (let x = Math.max(0, cx - 1); x <= Math.min(width - 1, cx + 1); x++) {
      const i = 4 * (y * width + x);
      sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2];
      n++;
    }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// CIE lightness L*/100 of a display (sRGB) color: the master curve's axis
export function lightness([r, g, b]: RGB): number {
  const Y = 0.2126 * toLinear(r / 255) + 0.7152 * toLinear(g / 255) + 0.0722 * toLinear(b / 255);
  return Y > 216 / 24389 ? 1.16 * Math.cbrt(Y) - 0.16 : (Y * 24389) / 27 / 100;
}

// the input whose output is y, for a curve that never falls: bisection
export function invert(f: (x: number) => number, y: number): number {
  let lo = 0, hi = 1;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < y) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// a curve given as nodes joined by straight lines, as the parametric graph
// draws it
export function polyline(nodes: [number, number][]): (x: number) => number {
  return (x) => {
    if (x <= nodes[0][0]) return nodes[0][1];
    for (let k = 1; k < nodes.length; k++) {
      const [x0, y0] = nodes[k - 1], [x1, y1] = nodes[k];
      if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-9, x1 - x0);
    }
    return nodes[nodes.length - 1][1];
  };
}

export function hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

// below this saturation a color is taken as gray, as B&W Auto does
export const NEUTRAL_SAT = 0.15;

// how much each of BANDS a color belongs to: the two bands either side of
// its hue share it by distance, as colorequal blends neighboring nodes.
// null for a near-gray color, which the bands barely move
export function bandWeights([r, g, b]: RGB): number[] | null {
  const [h, s] = hsl(r / 255, g / 255, b / 255);
  if (s < NEUTRAL_SAT) return null;
  const n = BANDS.length, w = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const c0 = BANDS[k][2], c1 = BANDS[(k + 1) % n][2] + (k + 1 === n ? 360 : 0);
    const hh = h < c0 ? h + 360 : h;
    if (hh >= c0 && hh < c1) {
      const t = (hh - c0) / (c1 - c0);
      w[k] = 1 - t;
      w[(k + 1) % n] = t;
      break;
    }
  }
  return w;
}
