// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's module cards are generated from darktable's introspection,
// which says what a module's fields are but not how darktable's own GUI lays
// them out: the order, which fields are hidden, the soft slider ranges, the
// units and when a field shows. This is that part, written by hand from each
// module's gui_init and gui_changed, one entry per module.
export type LayoutField = {
  path: string;    // a schema path, or "name[i]" for one element of an array
  label: string;
  tab?: string;      // darktable's notebook page the field is on
  section?: string;  // a section heading darktable shows above the field
  // the slider's range as darktable first shows it; typing a value or an
  // edit made elsewhere can go past it, up to the schema's min and max
  soft?: [number, number];
  unit?: string;
  digits?: number;
  // darktable's slider shows value * factor + offset (a 0..1 param as %)
  factor?: number;
  offset?: number;
  // the enum values darktable's combobox offers, when it leaves some out
  options?: number[];
  // darktable shows the field only for some settings of the others
  showIf?: (params: Record<string, number>) => boolean;
};

export type ModuleLayout = {
  op: string;
  group: string;   // the panel (manifest.ts) whose Advanced group holds the card
  title: string;
  fields: LayoutField[];
};

export const LAYOUTS: ModuleLayout[] = [
  {
    // temperature.c gui_init: its "channel coefficients" section (red, green,
    // blue, various at 3 digits). left out for now: the settings combobox,
    // whose entries (as shot, camera reference, the camera's presets) are
    // built per photo rather than from an enum, and the temperature and tint
    // sliders, which darktable computes from the coefficients
    op: "temperature", group: "basic", title: "White balance",
    fields: [
      { path: "red", label: "Red", section: "Channel coefficients", digits: 3 },
      { path: "green", label: "Green", section: "Channel coefficients", digits: 3 },
      { path: "blue", label: "Blue", section: "Channel coefficients", digits: 3 },
      // the fourth channel of a 4-color sensor (darktable labels it emerald
      // there); other sensors leave it at 0 and darktable hides it
      { path: "various", label: "Emerald", section: "Channel coefficients", digits: 3, showIf: (p) => p.various > 0 },
    ],
  },
  {
    // channelmixerrgb.c gui_init (its notebook pages, NOTEBOOK_PAGE with no
    // swap, so input R/G/B are elements 0/1/2) and _update_illuminants for
    // what the CAT page shows. the auto-detect illuminants (8, 9) need
    // AI_ACTIVATED, which channelmixerrgb.c leaves undefined. left out: the
    // hue and chroma sliders of the custom illuminant (darktable converts
    // them to x and y), the CCT label, picker, area color mapping and color
    // checker sections; an "as shot in camera" illuminant greys adaptation
    // out, which depends on the photo
    op: "channelmixerrgb", group: "basic", title: "Color calibration",
    fields: [
      { path: "adaptation", label: "Adaptation", tab: "CAT" },
      { path: "illuminant", label: "Illuminant", tab: "CAT", options: [0, 1, 2, 3, 4, 5, 6, 7, 10], showIf: (p) => p.adaptation !== 4 },
      { path: "illum_fluo", label: "F source", tab: "CAT", showIf: (p) => p.adaptation !== 4 && p.illuminant === 4 },
      { path: "illum_led", label: "LED source", tab: "CAT", showIf: (p) => p.adaptation !== 4 && p.illuminant === 5 },
      { path: "temperature", label: "Temperature", tab: "CAT", soft: [3000, 7000], unit: "K", digits: 0, showIf: (p) => p.adaptation !== 4 && (p.illuminant === 2 || p.illuminant === 6) },
      { path: "gamut", label: "Gamut compression", tab: "CAT", soft: [0, 4] },
      { path: "clip", label: "Clip negative RGB from gamut", tab: "CAT" },
      { path: "red[0]", label: "Input R", tab: "R", digits: 3 },
      { path: "red[1]", label: "Input G", tab: "R", digits: 3 },
      { path: "red[2]", label: "Input B", tab: "R", digits: 3 },
      { path: "normalize_R", label: "Normalize channels", tab: "R" },
      { path: "green[0]", label: "Input R", tab: "G", digits: 3 },
      { path: "green[1]", label: "Input G", tab: "G", digits: 3 },
      { path: "green[2]", label: "Input B", tab: "G", digits: 3 },
      { path: "normalize_G", label: "Normalize channels", tab: "G" },
      { path: "blue[0]", label: "Input R", tab: "B", digits: 3 },
      { path: "blue[1]", label: "Input G", tab: "B", digits: 3 },
      { path: "blue[2]", label: "Input B", tab: "B", digits: 3 },
      { path: "normalize_B", label: "Normalize channels", tab: "B" },
      { path: "saturation[0]", label: "Input R", tab: "Colorfulness", digits: 3, soft: [-1, 1] },
      { path: "saturation[1]", label: "Input G", tab: "Colorfulness", digits: 3, soft: [-1, 1] },
      { path: "saturation[2]", label: "Input B", tab: "Colorfulness", digits: 3, soft: [-1, 1] },
      { path: "normalize_sat", label: "Normalize channels", tab: "Colorfulness" },
      { path: "version", label: "Saturation algorithm", tab: "Colorfulness" },
      { path: "lightness[0]", label: "Input R", tab: "Brightness", digits: 3, soft: [-1, 1] },
      { path: "lightness[1]", label: "Input G", tab: "Brightness", digits: 3, soft: [-1, 1] },
      { path: "lightness[2]", label: "Input B", tab: "Brightness", digits: 3, soft: [-1, 1] },
      { path: "normalize_light", label: "Normalize channels", tab: "Brightness" },
      { path: "grey[0]", label: "Input R", tab: "Gray", digits: 3, soft: [0, 1] },
      { path: "grey[1]", label: "Input G", tab: "Gray", digits: 3, soft: [0, 1] },
      { path: "grey[2]", label: "Input B", tab: "Gray", digits: 3, soft: [0, 1] },
      { path: "normalize_grey", label: "Normalize channels", tab: "Gray" },
    ],
  },
  {
    // exposure.c gui_init (the mode combobox over a manual and a deflicker
    // page, then black level); the mode stack is gui_changed's showIf
    op: "exposure", group: "basic", title: "Exposure",
    fields: [
      { path: "mode", label: "Mode" },
      { path: "compensate_exposure_bias", label: "Compensate camera exposure", showIf: (p) => p.mode !== 1 },
      { path: "exposure", label: "Exposure", soft: [-3, 4], unit: "EV", digits: 3, showIf: (p) => p.mode !== 1 },
      { path: "deflicker_percentile", label: "Percentile", unit: "%", digits: 1, showIf: (p) => p.mode === 1 },
      { path: "deflicker_target_level", label: "Target level", unit: "EV", digits: 1, showIf: (p) => p.mode === 1 },
      { path: "black", label: "Black level correction", soft: [-0.1, 0.1], digits: 4 },
    ],
  },
  {
    // highlights.c gui_init (widget order) and gui_changed (visibility).
    // darktable builds the method list per sensor (a JPEG gets clip only,
    // guided laplacians needs a Bayer sensor) and falls back to inpaint
    // opposed for a method the sensor cannot use; the card lists them all
    op: "highlights", group: "basic", title: "Highlight reconstruction",
    fields: [
      { path: "mode", label: "Method" },
      { path: "clip", label: "Clipping threshold", digits: 3 },
      { path: "combine", label: "Combine", digits: 0, showIf: (p) => p.mode === 4 },
      { path: "candidating", label: "Candidating", unit: "%", factor: 100, digits: 0, showIf: (p) => p.mode === 4 },
      { path: "recovery", label: "Rebuild", showIf: (p) => p.mode === 4 },
      { path: "strength", label: "Strength", unit: "%", factor: 100, digits: 0, showIf: (p) => p.mode === 4 && p.recovery !== 0 },
      { path: "noise_level", label: "Noise level", showIf: (p) => p.mode === 3 || (p.mode === 4 && p.recovery !== 0) },
      { path: "iterations", label: "Iterations", showIf: (p) => p.mode === 3 },
      { path: "solid_color", label: "Inpaint a flat color", unit: "%", factor: 100, digits: 0, showIf: (p) => p.mode === 3 },
      { path: "scales", label: "Diameter of reconstruction", showIf: (p) => p.mode === 3 },
    ],
  },
  {
    // contrastntexture.c gui_init; no gui_changed rule hides a field. left
    // out: the mask preview buttons on detail level and the three gain
    // sliders, which toggle a display mode rather than set a parameter
    op: "contrastntexture", group: "basic", title: "Contrast & texture",
    fields: [
      { path: "detail_level", label: "Base detail level", soft: [1, 10] },
      { path: "gain_highlights", label: "Highlights", soft: [-2, 2] },
      { path: "gain_shadows", label: "Shadows", soft: [-2, 2] },
      { path: "gain_coarse", label: "Coarse details", section: "Local contrast", soft: [-1, 1.5], unit: "%" },
      { path: "gain_medium", label: "Medium details", section: "Local contrast", soft: [-1, 1.5], unit: "%" },
      { path: "gain_fine", label: "Fine details", section: "Local contrast", soft: [-1, 1.5], unit: "%" },
      { path: "halo_control", label: "Halo control", section: "Filter settings", soft: [-5, 5], unit: "%" },
      { path: "noise_bias", label: "Noise bias", section: "Filter settings", soft: [0, 0.2], digits: 4 },
    ],
  },
];

export const layoutFor = (op: string, group: string) => LAYOUTS.find((l) => l.op === op && l.group === group);

// a group's cards sit in LAYOUTS order (Simple's sections), not pipe order
export const layoutRank = (op: string, group: string) => LAYOUTS.findIndex((l) => l.op === op && l.group === group);
export const groupLayouts = (group: string) => LAYOUTS.filter((l) => l.group === group);

// the schema field a layout path reads: "red[2]" is an element of array "red"
export const fieldPath = (path: string) => path.replace(/\[\d+\]$/, "");
