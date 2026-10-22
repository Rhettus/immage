// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// what moving each control should do to the photo. a control not named
// here is still tested: moved 60% of the way to each end of its range, it
// must change the frame. what is here adds:
//   values   the values to try, in place of the 60% ones
//   with     other controls set first, as the control needs them (a hue
//            needs a saturation); the frame they make is what it is judged on
//   expect   { metric: sign } for the first value, the opposite for one on
//            the other side of neutral (metrics.mjs: lum, lumHi, lumLo,
//            chroma, warm, magenta)
//   detail   fine-detail tools (sharpening, noise, grain): judged on a 100%
//            crop, at a lower threshold
//   anyPhoto it changes only photos with the right content (a color band, a
//            lens in lensfun): a pass on one photo is enough
//   raw      raws only, as the app grays it out on a JPEG
//   skip     not tested here, and why

// mean |difference| over RGB, in 8-bit levels
export const THRESHOLD = {
  change: 0.08,    // a control moved must change the frame by more than this
  band: 0.3,       // ... or the band it is expected to move (lumHi, lumLo) by this
  detail: 0.02,    // ... or a 100% crop by this, for `detail` tools
  sign: 0.05,      // an expected direction must be at least this strong
  reset: 0.05,     // a control put back must leave the frame this close to before
  outside: 0.08,   // a mask's adjustment far outside its shape
  roundtrip: 0.05, // a saved edit opened again
  reference: 0.25, // a release's saved edit, rendered by this build
};

const UPRIGHT = "Upright's values come from its line detection (engine `upright`), which this suite does not run";
const POINTS = "covered by the point curve checks";
const CROP = "covered by the crop check";

export const GLOBAL = {
  bw_mode: { values: [1], mono: true },
  temp: { delta: [1500, -1500], expect: { warm: 1 } },
  tint: { delta: [40, -40], expect: { magenta: 1 } },
  exposure: { delta: [1, -1], expect: { lum: 1 } },
  highlights: { expect: { lumHi: 1 } },
  shadows: { expect: { lumLo: 1 } },
  whites: { expect: { lumHi: 1 } },
  blacks: { expect: { lumLo: 1 } },
  texture: { detail: true },
  vibrance: { expect: { chroma: 1 } },
  saturation: { expect: { chroma: 1 } },

  tc_highlights: { with: { tc_mode: 0 }, expect: { lumHi: 1 } },
  tc_lights: { with: { tc_mode: 0 }, expect: { lum: 1 } },
  tc_darks: { with: { tc_mode: 0 }, expect: { lum: 1 } },
  tc_shadows: { with: { tc_mode: 0 }, expect: { lumLo: 1 } },
  tc_midtones: { with: { tc_mode: 0 }, expect: { lum: 1 } },
  ...Object.fromEntries(["tc_split1", "tc_split2", "tc_split3"].map((id) =>
    [id, { with: { tc_mode: 0, tc_highlights: 60, tc_lights: 60, tc_darks: -60, tc_shadows: -60 } }])),

  ...Object.fromEntries(["red", "orange", "yellow", "green", "cyan", "blue", "lavender", "magenta"].flatMap((b) => [
    [`hsl_hue_${b}`, { anyPhoto: true }], [`hsl_sat_${b}`, { anyPhoto: true }], [`hsl_lum_${b}`, { anyPhoto: true }],
    [`bw_${b}`, { with: { bw_mode: 1 }, anyPhoto: true }],
  ])),
  ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8, 9, 10].map((z) => [`zp_${z}`, { delta: [1, -1], anyPhoto: true }])),

  ...Object.fromEntries(["shadows", "midtones", "highlights", "global"].flatMap((r) => [
    [`cg_${r}_hue`, { with: { [`cg_${r}_sat`]: 40 }, delta: [120] }],
    [`cg_${r}_sat`, { values: [50] }],
    [`cg_${r}_lum`, { expect: r === "shadows" ? { lumLo: 1 } : r === "highlights" ? { lumHi: 1 } : { lum: 1 } }],
  ])),

  capture: { toggle: true, detail: true, raw: true },
  usm_amount: { detail: true },
  usm_radius: { with: { usm_amount: 60 }, detail: true },
  usm_threshold: { with: { usm_amount: 60 }, detail: true },
  sharp_amount: { detail: true },
  sharp_radius: { with: { sharp_amount: 2 }, detail: true },
  sharp_sensitivity: { with: { sharp_amount: 2 }, detail: true },
  sharp_masking: { with: { usm_amount: 60, sharp_amount: 2 }, detail: true, raw: true },
  nr_luminance: { detail: true },
  nr_color: { detail: true },
  nr_detail: { with: { nr_luminance: 60 }, detail: true, raw: true },

  lens_profile: { toggle: true, anyPhoto: true },
  lens_ca: { with: { lens_profile: 1 }, toggle: true, anyPhoto: true, detail: true },

  vig_amount: { expect: { lum: 1 } },
  vig_midpoint: { with: { vig_amount: -60 } },
  vig_roundness: { with: { vig_amount: -60 } },
  vig_feather: { with: { vig_amount: -60 } },
  vig_cx: { with: { vig_amount: -60 }, values: [0.5, -0.5] },
  vig_cy: { with: { vig_amount: -60 }, values: [0.5, -0.5] },
  grain_amount: { detail: true },
  grain_size: { with: { grain_amount: 50 }, detail: true },

  tm_mode: { values: [0] },
  // AgX's range moved in toward the photo's tones: moved out past them all,
  // it rightly changes next to nothing
  agx_black: { delta: [2], expect: { lumLo: -1 } },
  agx_white: { delta: [-2], expect: { lumHi: -1 } },
  orient: { mirror: true },

  crop_l: { skip: CROP }, crop_t: { skip: CROP }, crop_r: { skip: CROP }, crop_b: { skip: CROP },
  crop_rd: { skip: "the crop's aspect, not a slider" }, crop_rn: { skip: "the crop's aspect, not a slider" },
};
for (const id of ["tc_mode", "tc_pn", "tc_r_pn", "tc_g_pn", "tc_b_pn"]) GLOBAL[id] = { skip: POINTS };
for (const ch of ["", "r_", "g_", "b_"])
  for (let i = 0; i < 20; i++) for (const a of ["x", "y"]) GLOBAL[`tc_${ch}p${i}${a}`] = { skip: POINTS };
for (const id of ["tf_upright", "tf_base_r", "tf_base_v", "tf_base_h", "tf_gn"]) GLOBAL[id] = { skip: UPRIGHT };
for (let i = 0; i < 16; i++) GLOBAL[`tf_g${i}`] = { skip: UPRIGHT };
for (const id of ["mod_contrast", "mod_tone", "mod_blacks", "mod_saturation", "mod_bw", "mod_sharpening", "mod_defringe"])
  GLOBAL[id] = { skip: "covered by the choices check" };

// edits made of several controls at once, as the point curve editor and
// the crop tool send them
const curve = (ch) => ({ [`tc_${ch}pn`]: 3, [`tc_${ch}p1x`]: 0.5, [`tc_${ch}p1y`]: 0.65, [`tc_${ch}p2x`]: 1, [`tc_${ch}p2y`]: 1 });
export const COMPOSITE = {
  "point curve": { set: { tc_mode: 1, ...curve("") }, expect: { lum: 1 } },
  "point curve red": { set: { tc_mode: 1, ...curve("r_") }, expect: { warm: 1 } },
  "point curve green": { set: { tc_mode: 1, ...curve("g_") }, expect: { magenta: -1 } },
  "point curve blue": { set: { tc_mode: 1, ...curve("b_") }, expect: { warm: -1 } },
  "crop": { set: { crop_l: 0.2, crop_t: 0.1, crop_r: 0.8, crop_b: 0.9 }, geometry: true },
};

// a mask's sliders: the same keys as GLOBAL, judged inside the mask's shape
// (and required to leave the far side of the photo alone)
export const LOCAL = {
  l_temp: { values: [60, -60], expect: { warm: 1 } },
  l_tint: { values: [60, -60], expect: { magenta: 1 } },
  l_exposure: { values: [1, -1], expect: { lum: 1 } },
  l_fulcrum: { with: { l_contrast: 60 }, values: [2, -2] },
  l_highlights: { expect: { lumHi: 1 } },
  l_shadows: { expect: { lumLo: 1 } },
  l_whites: { expect: { lumHi: 1 } },
  l_blacks: { expect: { lumLo: 1 } },
  l_texture: { detail: true },
  l_saturation: { expect: { chroma: 1 } },
  l_sharpness: { detail: true },
  l_usm: { detail: true },
  l_noise: { detail: true },
  l_defringe: { detail: true, anyPhoto: true },
  ...Object.fromEntries(["red", "orange", "yellow", "green", "cyan", "blue", "lavender", "magenta"].flatMap((b) =>
    ["hue", "sat", "lum"].map((k) => [`l_hsl_${k}_${b}`, { anyPhoto: true }]))),
  ...Object.fromEntries(["shadows", "midtones", "highlights", "global"].flatMap((r) => [
    [`l_cg_${r}_hue`, { with: { [`l_cg_${r}_sat`]: 40 }, values: [120] }],
    [`l_cg_${r}_sat`, { values: [50] }],
    [`l_cg_${r}_lum`, { expect: r === "shadows" ? { lumLo: 1 } : r === "highlights" ? { lumHi: 1 } : { lum: 1 } }],
  ])),
};

// the values to try for a control: `values`, `delta` from where it is, a
// toggle's other state, or 60% of the way to each end of its range
export function trialValues(c, spec, current) {
  const clamp = (v) => Math.min(c.max, Math.max(c.min, v));
  if (spec.values) return spec.values;
  if (spec.delta) return spec.delta.map((d) => clamp(current + d));
  if (spec.toggle) return [current ? 0 : 1];
  if (spec.mirror) return [current ^ 1];
  const out = [];
  const snap = (v) => Math.round(v / c.step) * c.step;
  if (c.max > current) out.push(snap(current + 0.6 * (c.max - current)));
  if (c.min < current) out.push(snap(current - 0.6 * (current - c.min)));
  return out;
}

// what a trial failed on, or null when it passed. `sign` is +1 for a value
// above where the control was, -1 below
export function judge(spec, d, sign) {
  if (d.geometry) return null;
  const floor = spec.detail ? THRESHOLD.detail : THRESHOLD.change;
  // a tool for the highlights may change little of a dark photo, but its
  // highlights clearly
  const band = Object.keys(spec.expect ?? {}).some((k) => (k === "lumHi" || k === "lumLo")
    && d[k] !== null && Math.abs(d[k]) >= THRESHOLD.band);
  if (!(d.mad > floor) && !band) return `no visible change (mean |Δ| ${d.mad}, needs > ${floor})`;
  for (const [metric, want] of Object.entries(spec.expect ?? {})) {
    const v = d[metric];
    if (v === null || v === undefined) continue;
    if (Math.sign(v) !== Math.sign(want * sign) || Math.abs(v) < THRESHOLD.sign)
      return `${metric} moved ${v}, expected ${want * sign > 0 ? "up" : "down"}`;
  }
  return null;
}
