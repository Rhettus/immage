// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Ansel Adams' Zone System on the scene-referred black and white image:
// zone V is middle gray (18.45%), one stop per zone, 0 and X open-ended.
// zones are measured where Immage's masks measure luminance (the engine's
// mask anchor, before the tone mapper), so what the histogram counts, what
// the overlay shows and what a zone mask selects are the same pixels

export const ZONE_GRAY = 0.1845;
export const ZONE_COUNT = 11;
export const ROMAN = ["0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
// EV across which a zone fades into its neighbors
export const DEFAULT_TRANSITION = 0.5;

// first and last zone, inclusive
export type ZoneRange = [number, number];

export type ZoneStats = {
  zones: number[];     // each zone's share of the image, soft: they add up to 1
  fine: number[];      // tenths of a zone from -0.5 to 10.5, hard counts
  below: number;       // darker than zone 0's band
  above: number;       // brighter than zone X's band
  mean: number;
  p5: number;
  p50: number;
  p95: number;
};
// the engine's zone of each point of a grid over the shown image, a byte
// per point as (z + 1) * 20
export type ZoneData = { width: number; height: number; map: Uint8Array; stats: ZoneStats };

export const zoneOfByte = (v: number) => v / 20 - 1;

// the zone at (ix, iy), 0-1 across the image: the nearest grid point, since
// a mean across an edge would name a zone neither side is in
export function zoneAt(d: ZoneData, ix: number, iy: number): number | null {
  if (ix < 0 || ix > 1 || iy < 0 || iy > 1 || !d.width || !d.height) return null;
  return zoneOfByte(d.map[Math.round(iy * (d.height - 1)) * d.width + Math.round(ix * (d.width - 1))]);
}

export function parseZones(buf: ArrayBuffer): ZoneData {
  const head = new DataView(buf, 0, 12);
  const width = head.getUint32(0, true), height = head.getUint32(4, true), len = head.getUint32(8, true);
  const stats = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 12, len))) as ZoneStats;
  return { width, height, stats, map: new Uint8Array(buf, 12 + len, width * height) };
}

export const rangeLabel = ([a, b]: ZoneRange) => (a === b ? `Zone ${ROMAN[a]}` : `Zones ${ROMAN[a]}–${ROMAN[b]}`);
// a continuous zone as "V.4"
export const zoneText = (z: number) => {
  const k = Math.max(0, Math.min(ZONE_COUNT - 1, Math.floor(z + 0.05)));
  const tenth = Math.round((z - k) * 10);
  return z < -0.5 ? "below 0" : z >= ZONE_COUNT - 0.5 ? "above X" : `${ROMAN[k]}${tenth > 0 ? `.${tenth}` : ""}`;
};

// how much a range of zones selects at zone z: ramps linear in luminance,
// as darktable's parametric masks are, `w` EV across each edge
export function rangeWeight(z: number, [a, b]: ZoneRange, w: number): number {
  const Y = 2 ** (z - 5);
  let f = 1;
  if (a > 0) {
    const lo = 2 ** (a - 5 - 0.5 - w / 2), hi = 2 ** (a - 5 - 0.5 + w / 2);
    f = Y <= lo ? 0 : Y < hi ? (Y - lo) / (hi - lo) : 1;
  }
  if (b < ZONE_COUNT - 1) {
    const lo = 2 ** (b - 5 + 0.5 - w / 2), hi = 2 ** (b - 5 + 0.5 + w / 2);
    f *= Y <= lo ? 1 : Y < hi ? (hi - Y) / (hi - lo) : 0;
  }
  return f;
}

// the range's weight for each map byte
export function weightTable(range: ZoneRange, w: number): Float32Array {
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++) t[v] = rangeWeight(zoneOfByte(v), range, w);
  return t;
}

// the range as a tint over the image: `rgb` at `opacity` (0-1) where it
// selects fully
// `cover`, when given, is a color mask over the same grid (0-1) that the
// range is narrowed by, as the engine multiplies them
export const paintRange = (d: ZoneData, range: ZoneRange, w: number, rgb: [number, number, number],
                           opacity: number, cover: Float32Array | null = null) =>
  paintWeights(d, weightTable(range, w), rgb, opacity, cover);

// a weight per map byte, as paintRange paints a range's
export function paintWeights(d: ZoneData, t: Float32Array, rgb: [number, number, number], opacity: number,
                             cover: Float32Array | null = null): ImageData {
  const img = new ImageData(d.width, d.height);
  const px = img.data;
  for (let k = 0; k < d.map.length; k++) {
    px[4 * k] = rgb[0];
    px[4 * k + 1] = rgb[1];
    px[4 * k + 2] = rgb[2];
    px[4 * k + 3] = Math.round(t[d.map[k]] * (cover ? cover[k] : 1) * opacity * 255);
  }
  return img;
}

// the range as a grayscale mask, white where it selects
export const grayRange = (d: ZoneData, range: ZoneRange, w: number, cover: Float32Array | null = null) =>
  grayWeights(d, weightTable(range, w), cover);

export function grayWeights(d: ZoneData, t: Float32Array, cover: Float32Array | null = null): ImageData {
  const img = new ImageData(d.width, d.height);
  const px = img.data;
  for (let k = 0; k < d.map.length; k++) {
    const g = Math.round(t[d.map[k]] * (cover ? cover[k] : 1) * 255);
    px[4 * k] = px[4 * k + 1] = px[4 * k + 2] = g;
    px[4 * k + 3] = 255;
  }
  return img;
}

// the range's share of the image and the mean zone of what it selects
export function rangeStats(d: ZoneData, range: ZoneRange, w: number, cover: Float32Array | null = null):
  { share: number; mean: number } {
  const t = weightTable(range, w);
  let s = 0, m = 0;
  for (let k = 0; k < d.map.length; k++) {
    const f = t[d.map[k]] * (cover ? cover[k] : 1);
    s += f;
    m += f * zoneOfByte(d.map[k]);
  }
  return { share: s / Math.max(1, d.map.length), mean: s > 0 ? m / s : NaN };
}

// how the overlay shows: on while a zone is pinned, its color and strength
export type ZoneOverlay = { show: boolean; color: string; opacity: number };
export const ZONE_COLORS: [string, [number, number, number]][] = [
  ["Blue", [64, 128, 255]], ["Red", [240, 56, 56]], ["Green", [48, 200, 96]], ["Yellow", [250, 210, 40]],
  ["Magenta", [230, 64, 220]],
];
const DEFAULT_OVERLAY: ZoneOverlay = { show: true, color: "Blue", opacity: 0.6 };
const OVERLAY_KEY = "immage.zoneOverlay";
export function loadZoneOverlay(): ZoneOverlay {
  try { return { ...DEFAULT_OVERLAY, ...JSON.parse(localStorage.getItem(OVERLAY_KEY) ?? "{}") }; }
  catch { return DEFAULT_OVERLAY; }
}
export function saveZoneOverlay(o: ZoneOverlay) {
  try { localStorage.setItem(OVERLAY_KEY, JSON.stringify(o)); } catch { /* not kept */ }
}
export const overlayRgb = (o: ZoneOverlay) => (ZONE_COLORS.find(([n]) => n === o.color) ?? ZONE_COLORS[0])[1];

// ------------------------------------------------------------ placement
// zones are placed by a tone equalizer of Immage's own, run on the black
// and white image ahead of the mask anchor. its nine nodes are set so they
// sit on zones II-X (its mask exposure puts zone X at its 0 EV node); zones
// 0 and I take zone II's placement. a node's value is the zone's shift in
// EV, within the equalizer's ±2

export const PLACEMENT_OP = "toneequal#zone placement";
export const PLACE_FIRST = 2;
export const PLACE_NODES = 9;
export const PLACE_MAX = 2;
// the equalizer's nodes, -8 to 0 EV, darkest first
export const PLACE_FIELDS = ["noise", "ultra_deep_blacks", "deep_blacks", "blacks", "shadows", "midtones",
                             "highlights", "whites", "speculars"];
export const PLACE_BOOST = -5 - Math.log2(ZONE_GRAY);
export const placeId = (k: number) => `zp_${k}`;
export const placeIds = Array.from({ length: PLACE_NODES }, (_, i) => placeId(PLACE_FIRST + i));
export const offsetsOf = (v: Record<string, number>) => placeIds.map((id) => v[id] ?? 0);

// the equalizer's curve, as toneequal.c makes it: eight gaussians, sigma
// its default smoothing, fitted by least squares to the nodes' gains
const SIGMA = Math.SQRT2;
const DENOM = 2 * SIGMA * SIGMA;
const NODE_EV = Array.from({ length: PLACE_NODES }, (_, i) => -8 + i);
const GAUSS_EV = Array.from({ length: 8 }, (_, j) => -8 + (8 * j) / 7);
const gauss = (d: number) => Math.exp(-(d * d) / DENOM);

export function placementFit(offsets: number[]): number[] {
  const n = GAUSS_EV.length;
  const A = NODE_EV.map((e) => GAUSS_EV.map((g) => gauss(e - g)));
  const f = offsets.map((o) => 2 ** o);
  const M = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) =>
    A.reduce((s, row) => s + row[i] * row[j], 0)));
  const y = Array.from({ length: n }, (_, i) => A.reduce((s, row, k) => s + row[i] * f[k], 0));
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    [y[c], y[p]] = [y[p], y[c]];
    for (let r = c + 1; r < n; r++) {
      const t = M[r][c] / M[c][c];
      for (let k = c; k < n; k++) M[r][k] -= t * M[c][k];
      y[r] -= t * y[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let c = n - 1; c >= 0; c--) {
    let s = y[c];
    for (let k = c + 1; k < n; k++) s -= M[c][k] * x[k];
    x[c] = s / M[c][c];
  }
  return x;
}

// where the equalizer puts zone z
export function placedZone(z: number, fit: number[]): number {
  const ev = Math.min(0, Math.max(-8, z - 10));
  let g = 0;
  for (let j = 0; j < fit.length; j++) g += fit[j] * gauss(ev - GAUSS_EV[j]);
  return z + Math.log2(Math.min(4, Math.max(0.25, g)));
}

// the first zone where a brighter tone comes out darker, if any
export function placementCrossing(fit: number[]): number | null {
  let last = placedZone(-0.5, fit);
  for (let z = -0.45; z <= 10.5; z += 0.05) {
    const p = placedZone(z, fit);
    if (p < last - 1e-3) return z;
    last = p;
  }
  return null;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// neighbors may fall behind by less than a zone, or tones cross over
const STEP = 0.6;

// the nodes with `range` moved by `delta` EV more than in `base`, fading
// out over `transition` zones on either side, then eased so no zone is
// placed below the one under it
export function applyPlacement(base: number[], range: ZoneRange, delta: number, transition: number): number[] {
  // zones 0 and I move with zone II, whose node they share
  const a = Math.max(range[0], PLACE_FIRST), b = Math.max(range[1], PLACE_FIRST);
  const out = base.map((o, i) => {
    const k = PLACE_FIRST + i;
    const d = k < a ? a - k : k > b ? k - b : 0;
    return Math.max(-PLACE_MAX, Math.min(PLACE_MAX, o + delta * smooth(1 - d / (transition + 1))));
  });
  // outward from the range: above may not drop a zone below, below may
  // not rise a zone above
  const lo = a - PLACE_FIRST, hi = Math.min(PLACE_NODES - 1, b - PLACE_FIRST);
  for (let i = hi + 1; i < PLACE_NODES; i++) out[i] = Math.max(out[i], out[i - 1] - STEP);
  for (let i = lo - 1; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] + STEP);
  return out;
}

// how much of a placement of `range` zone z follows (0-1), as
// applyPlacement fades the nodes over `transition` zones; zones 0 and I
// follow zone II, and the equalizer holds zone X's node above X
export function placeWeight(z: number, range: ZoneRange, transition: number): number {
  const a = Math.max(range[0], PLACE_FIRST), b = Math.max(range[1], PLACE_FIRST);
  const k = Math.min(ZONE_COUNT - 1, Math.max(PLACE_FIRST, z));
  const d = k < a ? a - k : k > b ? k - b : 0;
  return smooth(1 - d / (transition + 1));
}

export function placeTable(range: ZoneRange, transition: number): Float32Array {
  const t = new Float32Array(256);
  for (let v = 0; v < 256; v++) t[v] = placeWeight(zoneOfByte(v), range, transition);
  return t;
}

// the placement, its transition widened as far as it takes for the
// equalizer's curve to keep every tone in order
export function placeInOrder(base: number[], range: ZoneRange, delta: number, transition: number):
  { offsets: number[]; transition: number } {
  let t = transition, offsets = applyPlacement(base, range, delta, t);
  while (t < 8 && placementCrossing(placementFit(offsets)) !== null) {
    t += 0.5;
    offsets = applyPlacement(base, range, delta, t);
  }
  return { offsets, transition: t };
}

export const rangeCenter = ([a, b]: ZoneRange) => (a + b) / 2;

// ------------------------------------------------------------ zone masks
// a zone's local adjustments are an ordinary Immage mask whose shape is the
// zones' luminance range; it is known again by its name and its range's
// edges sitting on zone edges

const centerEV = (k: number) => Math.log2(ZONE_GRAY) + k - 5;

export type ZoneShape = { type: "luminance"; lo: number | null; hi: number | null; feather: number };
export const zoneShape = ([a, b]: ZoneRange, w: number): ZoneShape => ({
  type: "luminance",
  lo: a === 0 ? null : centerEV(a) - 0.5 + w / 2,
  hi: b === ZONE_COUNT - 1 ? null : centerEV(b) + 0.5 - w / 2,
  feather: w,
});

// the zones and transition of a luminance range, when it is a zone range
export function zonesOfShape(s: { type: string; lo?: number | null; hi?: number | null; feather?: number }):
  { range: ZoneRange; w: number } | null {
  if (s.type !== "luminance" || s.feather === undefined) return null;
  const w = s.feather;
  const a = s.lo === null || s.lo === undefined ? 0 : s.lo - w / 2 + 0.5 - Math.log2(ZONE_GRAY) + 5;
  const b = s.hi === null || s.hi === undefined ? ZONE_COUNT - 1 : s.hi + w / 2 - 0.5 - Math.log2(ZONE_GRAY) + 5;
  const ra = Math.round(a), rb = Math.round(b);
  if (Math.abs(a - ra) > 0.02 || Math.abs(b - rb) > 0.02 || ra < 0 || rb > ZONE_COUNT - 1 || ra > rb) return null;
  return { range: [ra, rb], w };
}

// a zone mask narrowed to a part of the photo by an AI mask, which sees the
// photo in color (the engine renders it without the black and white for
// the models): the kind is kept in the mask's name, "Zone V · Sky", or
// "Zone V · not Sky" for the rest of the photo
export const ZONE_PARTS: [string, string][] = [["sky", "Sky"], ["mountains", "Rocks"], ["vegetation", "Vegetation"],
                                               ["subject", "Subject"]];
export type ZonePart = { kind: string; invert: boolean };
export const zoneMaskName = (r: ZoneRange, part: ZonePart | null = null) => {
  const label = part && ZONE_PARTS.find(([k]) => k === part.kind)?.[1];
  return label ? `${rangeLabel(r)} · ${part!.invert ? "not " : ""}${label}` : rangeLabel(r);
};
export function zonePartOf(name: string): ZonePart | null {
  const m = /· (not )?(.+?)(?: \d+)?$/.exec(name);
  const kind = m && ZONE_PARTS.find(([, l]) => l === m[2])?.[0];
  return kind ? { kind, invert: !!m![1] } : null;
}
export const samePart = (a: ZonePart | null, b: ZonePart | null) =>
  (!a && !b) || (!!a && !!b && a.kind === b.kind && a.invert === b.invert);
export function zoneOfMask(m: { name: string; shapes: { type: string }[] }): { range: ZoneRange; w: number } | null {
  if (!m.name.startsWith("Zone")) return null;
  const lum = m.shapes.filter((s) => s.type === "luminance");
  return lum.length === 1 ? zonesOfShape(lum[0]) : null;
}

// whether a local exposure of `ev` at `strength` (0-1) turns tones around
// at the range's edges: darktable blends the brightened or darkened pixels
// in by the mask, which across a ramp of `w` EV can fall behind the tones
// just outside it
export function localReverses([a, b]: ZoneRange, ev: number, w: number, strength: number): boolean {
  const ramp = 1 / (1 - 2 ** -Math.max(0.05, w));
  if (ev < 0 && a > 0) return strength * (1 - 2 ** ev) * (1 + ramp) >= 1;
  if (ev > 0 && b < ZONE_COUNT - 1) return strength * (2 ** ev - 1) * ramp >= 1;
  return false;
}
