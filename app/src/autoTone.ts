// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Basic's Auto, after Exposure and AgX's auto tune levels: Blacks,
// Whites, Shadows, Highlights and Contrast from the rendered frame with
// all five at 0. the frame is display-referred, so its luminance is the
// tone the sliders are judged by. an experiment: the targets and gains
// are guesses to tune by eye
import { blacksFromLinear, type Values } from "./manifest";
import type { ZoneData } from "./zones";

export const AUTO_TONE_IDS = ["contrast", "highlights", "shadows", "whites", "blacks"];

const SAMPLES = 120_000;

// Exposure first, from the engine's zones at the tone mapper's input: the
// scene's mean log2 luminance brought part way toward middle gray, but no
// further than the photo's own range allows. brightening stops once the
// bright end (BRIGHT_PCT) reaches BRIGHT_ROOM over gray, so a night scene
// whose lights are already placed stays dark; darkening stops once the dark
// end (DARK_PCT) reaches DARK_ROOM under gray, so snow or a sunlit coast
// with real shadows stays bright. a photo off at both ends, too dark or too
// bright all over, still moves the whole way. scored by eye over the corpus
// with benchmarking/autoexp.py
const KEY_STRENGTH = 0.75;
const BRIGHT_PCT = 0.99, BRIGHT_ROOM = 2.5;
const DARK_PCT = 0.05, DARK_ROOM = -1.5;
const EXPOSURE_LIMIT = 3;   // EV either way from where it was
// how much of the move the range held back before a scene counts as wholly
// low- or high-key: autoTone() then leaves its dark or bright end alone
const KEY_WITHHELD = 1;

export type SceneKey = { lowKey: number; highKey: number };
export type AutoExposure = SceneKey & { exposure: number };

// a share of the zones map as EV from middle gray (engine/main.c, _zones)
const evAt = (sorted: Uint8Array, q: number) => sorted[Math.floor(q * (sorted.length - 1))] / 20 - 6;

export function autoExposure(current: number, z: ZoneData): AutoExposure {
  const sorted = Uint8Array.from(z.map).sort();
  const key = z.stats.mean - 5;
  const want = KEY_STRENGTH * -key;
  const up = Math.max(0, BRIGHT_ROOM - evAt(sorted, BRIGHT_PCT));
  const down = Math.max(0, evAt(sorted, DARK_PCT) - DARK_ROOM);
  const move = Math.max(-EXPOSURE_LIMIT, Math.min(EXPOSURE_LIMIT, Math.max(-down, Math.min(up, want))));
  const held = want - move;
  return {
    exposure: Math.round(100 * (current + move)) / 100,
    lowKey: Math.min(1, Math.max(0, held / KEY_WITHHELD)),
    highKey: Math.min(1, Math.max(0, -held / KEY_WITHHELD)),
  };
}

const LO_PCT = 0.005, HI_PCT = 0.995;  // the ends Blacks and Whites place
const BLACK_TARGET = 0.03;             // just short of clipping either end
const WHITE_TARGET = 0.96;
const BLACKS_GAIN = 300;               // linear Blacks units per unit of lightness
const BLACKS_BAND = 0.015;             // a dark end this close to the target is left
const BLACKS_NONE = 0.15;              // a dark end above this has no black to place:
                                       // deepening it would darken the subject, a sky
const WHITES_GAIN = 300;

const SHADOW_EDGE = 0.25, SHADOW_SHARE = 0.2, SHADOWS_GAIN = 150;     // more dark than this lifts
const HIGHLIGHT_EDGE = 0.75, HIGHLIGHT_SHARE = 0.1, HIGHLIGHTS_GAIN = 200;  // more bright than this pulls
const CONTRAST_SPREAD = 0.22, CONTRAST_GAIN = 300;  // a flatter spread than this adds contrast

const LIMIT = 60;
const clamp = (v: number, lim = LIMIT) => Math.round(Math.max(-lim, Math.min(lim, v)));

// `key` is how low- or high-key autoExposure() found the scene: a dark
// scene keeps its Shadows and Blacks unlifted, a bright one its Highlights
// and Whites unpulled and its Blacks undeepened, rather than being
// stretched toward the middle or down to black
export function autoTone(px: Uint8ClampedArray, width: number, height: number,
                         key: SceneKey = { lowKey: 0, highKey: 0 }): Values | null {
  const n = width * height, stride = Math.max(1, Math.floor(n / SAMPLES));
  const hist = new Uint32Array(256);
  let count = 0, sum = 0, sum2 = 0, dark = 0, bright = 0;
  for (let i = 0; i < n; i += stride) {
    const l = (0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2]) / 255;
    hist[Math.min(255, Math.round(l * 255))]++;
    sum += l;
    sum2 += l * l;
    if (l < SHADOW_EDGE) dark++;
    if (l > HIGHLIGHT_EDGE) bright++;
    count++;
  }
  if (!count) return null;
  const pct = (q: number) => {
    let acc = 0;
    for (let k = 0; k < 256; k++) if ((acc += hist[k]) >= q * count) return k / 255;
    return 1;
  };
  const mean = sum / count;
  const spread = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
  const lo = pct(LO_PCT), off = BLACK_TARGET - lo;
  const blacks = lo > BLACKS_NONE ? 0
    : clamp(Math.sign(off) * Math.max(0, Math.abs(off) - BLACKS_BAND) * BLACKS_GAIN);
  const whites = clamp((WHITE_TARGET - pct(HI_PCT)) * WHITES_GAIN);
  const lift = 1 - key.lowKey, pull = 1 - key.highKey;
  return {
    blacks: Math.round(blacksFromLinear(blacks * (blacks > 0 ? lift : pull))),
    whites: Math.round(whites < 0 ? whites * pull : whites),
    shadows: Math.round(clamp(Math.max(0, dark / count - SHADOW_SHARE) * SHADOWS_GAIN) * lift),
    highlights: Math.round(clamp(-Math.max(0, bright / count - HIGHLIGHT_SHARE) * HIGHLIGHTS_GAIN) * pull),
    contrast: clamp((CONTRAST_SPREAD - spread) * CONTRAST_GAIN, 40),
  };
}
