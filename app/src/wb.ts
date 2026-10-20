// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// white balance as Lightroom shows it (Temp in K, Tint) <-> darktable's color
// calibration illuminant. the formulas are ports of src/common/illuminants.h,
// so a black-body point computed here is the one darktable renders

export const ILLUMINANT_D = 2;
export const ILLUMINANT_BB = 6;
export const ILLUMINANT_CUSTOM = 7;

// one Lightroom tint unit, as a distance from the Planckian locus in xy
const TINT_SCALE = 0.0002;

export const TEMP_MIN = 2000;
export const TEMP_MAX = 25000;

// CCT_to_xy_blackbody(), valid for 1667-25000 K
export function blackbodyXY(t: number): [number, number] {
  let x = 0;
  if (t >= 1667 && t <= 4000)
    x = ((-0.2661239e9 / t - 0.2343589e6) / t + 0.8776956e3) / t + 0.17991;
  else if (t > 4000 && t <= 25000)
    x = ((-3.0258469e9 / t + 2.1070379e6) / t + 0.2226347e3) / t + 0.24039;
  let y = 0;
  if (t >= 1667 && t <= 2222)
    y = ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683;
  else if (t > 2222 && t <= 4000)
    y = ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867;
  else if (t > 4000 && t <= 25000)
    y = ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  return [x, y];
}

// CCT_to_xy_daylight(), valid for 4000-25000 K
export function daylightXY(t: number): [number, number] {
  let x = 0;
  if (t >= 4000 && t <= 7000) x = ((-4.607e9 / t + 2.9678e6) / t + 0.09911e3) / t + 0.244063;
  else if (t > 7000 && t <= 25000) x = ((-2.0064e9 / t + 1.9018e6) / t + 0.24748e3) / t + 0.23704;
  return [x, (-3 * x + 2.87) * x - 0.275];
}

// planckian_normal()
function normal(x: number, t: number): number {
  if (t >= 1667 && t <= 2222) return (-3.3191442 * x - 2.6962204) * x + 2.18555832;
  if (t > 2222 && t <= 4000) return (-2.8648428 * x - 2.74837186) * x + 2.09137015;
  if (t > 4000 && t < 25000) return (9.245274 * x - 11.7467734) * x + 3.75112997;
  return 0;
}

// blackbody_xy_to_tinted_xy()
function tinted(t: number, dtTint: number): [number, number] {
  const [x, y] = blackbodyXY(t);
  const n = normal(x, t);
  const norm = Math.sqrt(1 + n * n);
  return [x + (dtTint * n) / norm, y - dtTint / norm];
}

// get_tint_from_tinted_xy(), but taking the normal at the locus point, as
// tinted() does: darktable's own takes it at the tinted point, so reading back
// a tint it wrote drifts by a few percent
function tintOf(y: number, t: number): number {
  const [bx, by] = blackbodyXY(t);
  const n = normal(bx, t);
  const norm = Math.sqrt(1 + n * n);
  return -(y - by) * norm;
}

// the temperature whose locus point is nearest (x, y): a golden-section
// search over mireds, where the locus is close to uniform
function nearestCCT(x: number, y: number): number {
  const dist = (mired: number) => {
    const [bx, by] = blackbodyXY(1e6 / mired);
    return (bx - x) ** 2 + (by - y) ** 2;
  };
  let a = 1e6 / TEMP_MAX, b = 1e6 / TEMP_MIN;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 60; i++) {
    const c = b - g * (b - a), d = a + g * (b - a);
    if (dist(c) < dist(d)) b = d; else a = c;
  }
  return 1e6 / ((a + b) / 2);
}

type Params = Record<string, number>;
export type WB = { temp: number; tint: number };

// a color calibration illuminant as Temp/Tint
export function readWB(p: Params): WB {
  if (p.illuminant === ILLUMINANT_BB) return { temp: p.temperature, tint: 0 };
  // below 4000 K the daylight model has no answer, and darktable renders
  // the black body instead (illuminant_to_xy(), illuminants.h)
  const [x, y] = p.illuminant !== ILLUMINANT_D ? [p.x, p.y]
    : p.temperature >= 4000 ? daylightXY(p.temperature) : blackbodyXY(p.temperature);
  const t = nearestCCT(x, y);
  return { temp: t, tint: -tintOf(y, t) / TINT_SCALE };
}

// Temp/Tint as an illuminant. the image's own as-shot setting is written
// back untouched, so a reset is exact; a pure temperature stays a
// black-body illuminant, the path darktable's own module takes
export function writeWB(wb: WB, defaults: Params): Params {
  const asShot = readWB(defaults);
  if (Math.abs(wb.temp - asShot.temp) < 0.5 && Math.abs(wb.tint - asShot.tint) < 0.5)
    return { illuminant: defaults.illuminant, x: defaults.x, y: defaults.y, temperature: defaults.temperature };
  if (wb.tint === 0)
    return { illuminant: ILLUMINANT_BB, temperature: wb.temp };
  const [x, y] = tinted(wb.temp, -wb.tint * TINT_SCALE);
  return { illuminant: ILLUMINANT_CUSTOM, x, y, temperature: wb.temp };
}

// the illuminant a Temp/Tint stands for, as writeWB() would set it
export function illuminantXY(wb: WB): [number, number] {
  return wb.tint === 0 ? blackbodyXY(wb.temp) : tinted(wb.temp, -wb.tint * TINT_SCALE);
}

// Bradford cone response, and display sRGB to XYZ
const BRADFORD = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];
const BRADFORD_INV = [[0.9869929, -0.1470543, 0.1599627], [0.4323053, 0.5183603, 0.0492912],
                      [-0.0085287, 0.0400428, 0.9684867]];
const SRGB_TO_XYZ = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]];
const mul = (m: number[][], v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

// the Temp/Tint that would render neutral a color that renders as `rgb`
// (display sRGB, 0-1) under `wb`. color calibration adapts its illuminant
// to white, so a cast left in the render is a cast in the illuminant: scale
// the illuminant's cone response by the color's against white. the tone
// mapper and other modules bend this a little, so callers render again and
// repeat until it settles. null for a color too dark to judge
export function neutralize(wb: WB, rgb: [number, number, number]): WB | null {
  const lin = rgb.map(srgbToLinear);
  if (Math.max(...lin) < 0.002) return null;
  const lms = mul(BRADFORD, mul(SRGB_TO_XYZ, lin));
  const white = mul(BRADFORD, mul(SRGB_TO_XYZ, [1, 1, 1]));
  const [x, y] = illuminantXY(wb);
  const ill = mul(BRADFORD, [x / y, 1, (1 - x - y) / y]);
  const n = mul(BRADFORD_INV, ill.map((v, i) => (v * lms[i]) / white[i]));
  const s = n[0] + n[1] + n[2];
  const nx = n[0] / s, ny = n[1] / s;
  const temp = Math.min(TEMP_MAX, Math.max(TEMP_MIN, nearestCCT(nx, ny)));
  const tint = Math.min(150, Math.max(-150, -tintOf(ny, temp) / TINT_SCALE));
  return { temp: Math.round(temp), tint: Math.round(tint) };
}

// Auto's estimate of the light: the mean of the brightest 2% of the frame's
// unclipped pixels, in linear light, as display sRGB. scored against neutral
// patches by benchmarking/awb.py, it missed by 3° on average where the gray
// world it replaced missed by 5°, and it leaves a sunset or a field of green
// largely alone. null when nothing in the frame is usable
export function whitePatch(px: Uint8ClampedArray, width: number, height: number): [number, number, number] | null {
  const n = width * height, stride = Math.max(1, Math.floor(n / 200_000));
  const lut = new Float32Array(256);
  for (let v = 0; v < 256; v++) lut[v] = srgbToLinear(v / 255);
  const rgb: number[] = [], peak: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2];
    // a clipped channel no longer says what color the light was
    if (r >= 250 || g >= 250 || b >= 250) continue;
    const m = lut[Math.max(r, g, b)];
    if (m <= 0.002) continue;
    rgb.push(lut[r], lut[g], lut[b]);
    peak.push(m);
  }
  if (!peak.length) return null;
  const cut = Float32Array.from(peak).sort()[Math.floor(peak.length * 0.98)];
  const sum = [0, 0, 0];
  let k = 0;
  for (let j = 0; j < peak.length; j++) {
    if (peak[j] < cut) continue;
    sum[0] += rgb[3 * j]; sum[1] += rgb[3 * j + 1]; sum[2] += rgb[3 * j + 2];
    k++;
  }
  // as a display color, which neutralize() takes; scaled so it neither clips nor vanishes
  const top = Math.max(...sum);
  const enc = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return k && top > 0 ? [enc((0.5 * sum[0]) / top), enc((0.5 * sum[1]) / top), enc((0.5 * sum[2]) / top)] : null;
}

// Auto on a photo the camera balanced itself: its setting, moved a quarter
// of the way toward the estimate and no more than 15 mireds and 10 tint.
// the camera's own auto white balance beat every estimator on the corpus
// (benchmarking/awb.py), so it is the anchor rather than the estimate
export function anchored(shot: WB, est: WB): WB {
  const m0 = 1e6 / shot.temp;
  const clamp = (v: number, c: number) => Math.max(-c, Math.min(c, v));
  const dm = clamp(0.25 * (1e6 / est.temp - m0), 15);
  const dt = clamp(0.25 * (est.tint - shot.tint), 10);
  return { temp: Math.round(1e6 / (m0 + dm)), tint: Math.round(shot.tint + dt) };
}

// Lightroom's white balance presets for raw files
export const WB_PRESETS: [string, WB][] = [
  ["Daylight", { temp: 5500, tint: 10 }],
  ["Cloudy", { temp: 6500, tint: 10 }],
  ["Shade", { temp: 7500, tint: 10 }],
  ["Tungsten", { temp: 2850, tint: 0 }],
  ["Fluorescent", { temp: 3800, tint: 21 }],
  ["Flash", { temp: 5500, tint: 0 }],
];

// a mask's Temp and Tint: a second color calibration adapts from an
// illuminant near the pipeline's own white (D50), so 0/0 leaves the area
// as it is. warming the area means telling it the light was cooler, so
// +Temp moves the illuminant up in kelvin
const D50: [number, number] = [0.3457, 0.3585];
const LOCAL_MIRED_PER_STEP = 0.6;    // ±100 is about 3800-7100 K around D50
const LOCAL_TINT_SCALE = TINT_SCALE; // as the global Tint
const D50_CCT = nearestCCT(D50[0], D50[1]);
const D50_TINT = tintOf(D50[1], D50_CCT);

export function localIlluminant(temp: number, tint: number): [number, number] {
  const t = 1e6 / (1e6 / D50_CCT - LOCAL_MIRED_PER_STEP * temp);
  // +Tint turns the area magenta, so the light is taken for greener, as the
  // global Tint does it
  return tinted(Math.min(TEMP_MAX, Math.max(TEMP_MIN, t)), D50_TINT - tint * LOCAL_TINT_SCALE);
}

export function readLocalIlluminant(x: number, y: number): WB {
  const t = nearestCCT(x, y);
  return {
    temp: (1e6 / D50_CCT - 1e6 / t) / LOCAL_MIRED_PER_STEP,
    tint: (D50_TINT - tintOf(y, t)) / LOCAL_TINT_SCALE,
  };
}
