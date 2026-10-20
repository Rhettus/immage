// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// color balance rgb's hue angle is not HSL's: its own perceptual space
// spreads hues unevenly. this maps an angle to the display hue its tint
// actually produces, measured by rendering a 0.05-chroma global tint at
// every 30 degrees (build/spike/cb_hue.py) and reading the hue of the shift
const MEASURED: [number, number][] = [
  [0, 356.4], [30, 17.1], [60, 35.1], [90, 76.3], [120, 118.3], [150, 156.5],
  [180, 182.4], [210, 193.0], [240, 203.1], [270, 239.8], [300, 296.0], [330, 327.2],
];

// interpolate along the circle, unwrapping the display hues so 356 -> 17
// passes through 0 rather than back around
export function displayHue(h: number): number {
  const a = ((h % 360) + 360) % 360;
  const i = Math.floor(a / 30);
  const [h0, d0] = MEASURED[i % 12];
  const [, d1raw] = MEASURED[(i + 1) % 12];
  let d1 = d1raw;
  while (d1 < d0 - 180) d1 += 360;
  while (d1 > d0 + 180) d1 -= 360;
  const t = (a - h0) / 30;
  return (((d0 + t * (d1 - d0)) % 360) + 360) % 360;
}

// a hue slider's track for color balance rgb's 0-359
export const cbHueTrack = () =>
  `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, k) =>
    `hsl(${displayHue(k * 30).toFixed(0)}, 80%, 50%) ${((k * 30) / 359 * 100).toFixed(1)}%`).join(", ")})`;
