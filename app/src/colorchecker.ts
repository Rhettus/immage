// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the patch grid editor's rules, ported from colorchecker.c: a patch has a
// source color (what it matches in the photo) and a target color (what it
// becomes), as `source_L[k]`, `source_a[k]`, `source_b[k]` and `target_*[k]`
// over `num_patches` of at most MAX_PATCHES. ModulePatches.tsx draws them
export const MAX_PATCHES = 49;
export const DEFAULT_PATCHES = 24;   // colorchecker_patches

export type Patches = (path: string) => number;
const CH = ["L", "a", "b"] as const;
type Edit = Record<string, number>;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// checker_draw: more than 24 patches make a 7 x 7 grid, else 6 x 4
export const gridOf = (n: number) => (n > 24 ? { cx: 7, cy: 7 } : { cx: 6, cy: 4 });

// checker_button_press and checker_motion_notify: the patch under a point
// given as shares of the area's width and height (it can be past the last)
export function patchAt(x: number, y: number, n: number): number {
  const { cx, cy } = gridOf(n);
  return Math.floor(clamp(x, 0, 1) * cx) + cx * Math.floor(clamp(y, 0, 1) * cy);
}

// dt_Lab_to_XYZ (D50) and dt_XYZ_to_sRGB, which the patches are drawn with;
// the result is not clipped here, the canvas does that
const D50 = [0.9642, 1.0, 0.8249];
const labInv = (x: number) => (x > 0.20689655172413796 ? x * x * x : (116 * x - 16) / (24389 / 27));
export function labToSrgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const X = D50[0] * labInv(fx), Y = D50[1] * labInv(fy), Z = D50[2] * labInv(fz);
  const lin = [
    3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z,
    -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z,
    0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z,
  ];
  return lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) as [number, number, number];
}

const src = (p: Patches, k: number) => CH.map((c) => p(`source_${c}[${k}]`));
const tgt = (p: Patches, k: number) => CH.map((c) => p(`target_${c}[${k}]`));

// checker_draw: a patch with a target other than its source gets an outline
export const altered = (p: Patches, k: number) => {
  const s = src(p, k), t = tgt(p, k);
  return s.some((v, i) => Math.abs(t[i] - v) > 1e-5);
};

// the highlight on the selected patch is black over light patches
export const highlightGray = (p: Patches, k: number) => (p(`source_L[${k}]`) > 80 ? 0 : 1);

// _colorchecker_update_sliders: lightness, green-magenta, blue-yellow and
// saturation, absolute or as offsets from the source
export function sliderValues(p: Patches, k: number, absolute: boolean) {
  const [sL, sa, sb] = src(p, k), [tL, ta, tb] = tgt(p, k);
  const Cout = Math.hypot(ta, tb);
  return absolute ? { L: tL, a: ta, b: tb, C: Cout }
    : { L: tL - sL, a: ta - sa, b: tb - sb, C: Cout - Math.hypot(sa, sb) };
}

// target_L_callback, target_a_callback, target_b_callback: the new target
// (a and b clamped to +-128) for a slider value
export function editChannel(p: Patches, k: number, ch: "L" | "a" | "b", v: number, absolute: boolean): Edit {
  const s = p(`source_${ch}[${k}]`);
  const t = absolute ? v : s + v;
  return { [`target_${ch}[${k}]`]: ch === "L" ? t : clamp(t, -128, 128) };
}

// target_C_callback: the saturation slider scales target a and b together
export function editSaturation(p: Patches, k: number, v: number, absolute: boolean): Edit {
  const [, sa, sb] = src(p, k), [, ta, tb] = tgt(p, k);
  const Cin = Math.hypot(sa, sb), Cout = Math.max(1e-4, Math.hypot(ta, tb));
  const Cnew = clamp(absolute ? v : Cin + v, 0.01, 128);
  return { [`target_a[${k}]`]: clamp(ta * Cnew / Cout, -128, 128), [`target_b[${k}]`]: clamp(tb * Cnew / Cout, -128, 128) };
}

// a double-click: the patch's target back to its source
export function resetPatch(p: Patches, k: number): Edit {
  return Object.fromEntries(CH.map((c) => [`target_${c}[${k}]`, p(`source_${c}[${k}]`)]));
}

// a right-click: the patch is deleted and the ones after it move up one
// (the last element of each array is left as it was)
export function deletePatch(p: Patches, k: number): Edit {
  const n = p("num_patches"), edit: Edit = { num_patches: n - 1 };
  for (const kind of ["target", "source"]) for (const c of CH) {
    for (let i = k; i < n - 1; i++) edit[`${kind}_${c}[${i}]`] = p(`${kind}_${c}[${i + 1}]`);
  }
  return edit;
}

// the paths the editor reads and writes, which a card snapshots for undo
export const patchPaths = () => [
  "num_patches",
  ...["source", "target"].flatMap((kind) => CH.flatMap((c) => Array.from({ length: MAX_PATCHES }, (_, k) => `${kind}_${c}[${k}]`))),
];
