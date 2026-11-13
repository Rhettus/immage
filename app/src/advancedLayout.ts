// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's module cards are generated from darktable's introspection,
// which says what a module's fields are but not how darktable's own GUI lays
// them out: the order, which fields are hidden, the soft slider ranges, the
// units and when a field shows. This is that part, written by hand from each
// module's gui_init and gui_changed, one entry per module.
import { autoCrop } from "./transform";
import type { Turn } from "./manifest";

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
  // an int field darktable shows as a combobox filled by hand
  // (dt_bauhaus_combobox_add), with these names and values; on an enum,
  // the names of the values offered, which darktable gives the menu itself
  choices?: [string, number][];
  // input color profile's profile menus: the engine's own field over the
  // module's type and file name (session.c), with the profiles this photo
  // can use as its choices
  profiles?: "input" | "working";
  // darktable shows the field only for some settings of the others
  showIf?: (params: Record<string, number>) => boolean;
};

export type ModuleLayout = {
  op: string;
  group: string;   // the panel (manifest.ts) whose Advanced group holds the card
  title: string;
  fields: LayoutField[];
  // the card is for Immage's instance so named (Simple's B&W "bw"), which
  // the module's other cards leave out; Add module sets these Simple values,
  // which make it
  instance?: { name: string; add: [string, number][] };
  // fields every edit on the card also sets, as the module's gui_changed
  // does, except an edit of one of `except` (lens: darktable renders its
  // defaults until has_been_set is on, which the method alone leaves off)
  touch?: { set: [string, number][]; except?: string[] };
  // fields every edit recomputes from the module's params after it, as the
  // module's gui_changed does (ashift's crop box); `size` is the sensor's,
  // `before` the params before the edit (darktable's `previous`)
  derive?: (params: Record<string, number>, size: { width: number; height: number },
            before: Record<string, number>) => Record<string, number>;
  // buttons above the fields that turn the photo as the toolbar does, so the
  // crop and mask shapes turn with it (flip's darktable buttons)
  turns?: { label: string; how: Turn }[];
};

// what an edit of `path` to `v` sends: the field, what the card's edits
// also set and what they recompute (`params`, the instance's before it)
export function editOf(l: ModuleLayout, path: string, v: number, params: Record<string, number>,
                       size: { width: number; height: number }): Record<string, number> {
  const also = l.touch && !l.touch.except?.includes(path) ? Object.fromEntries(l.touch.set) : {};
  const edit = { ...also, [path]: v };
  return { ...edit, ...l.derive?.({ ...params, ...edit }, size, params) };
}

// diffuse or sharpen's settings, shared by its Basic and Detail cards.
// diffuse.c gui_init, whose sections are the ones below; no gui_changed
// rule hides a field. all 15 parameters are on the card
const DIFFUSE: LayoutField[] = [
  { path: "iterations", label: "Iterations", section: "Properties", soft: [1, 128] },
  { path: "radius_center", label: "Central radius", section: "Properties", soft: [0, 512], unit: "px" },
  { path: "radius", label: "Radius span", section: "Properties", soft: [1, 512], unit: "px" },
  { path: "first", label: "1st order speed", section: "Speed (sharpen/diffuse)", digits: 2, unit: "%" },
  { path: "second", label: "2nd order speed", section: "Speed (sharpen/diffuse)", digits: 2, unit: "%" },
  { path: "third", label: "3rd order speed", section: "Speed (sharpen/diffuse)", digits: 2, unit: "%" },
  { path: "fourth", label: "4th order speed", section: "Speed (sharpen/diffuse)", digits: 2, unit: "%" },
  { path: "anisotropy_first", label: "1st order anisotropy", section: "Direction", digits: 2, unit: "%" },
  { path: "anisotropy_second", label: "2nd order anisotropy", section: "Direction", digits: 2, unit: "%" },
  { path: "anisotropy_third", label: "3rd order anisotropy", section: "Direction", digits: 2, unit: "%" },
  { path: "anisotropy_fourth", label: "4th order anisotropy", section: "Direction", digits: 2, unit: "%" },
  { path: "sharpness", label: "Sharpness", section: "Edge management", soft: [-0.25, 0.25], digits: 1, unit: "%" },
  { path: "regularization", label: "Edge sensitivity", section: "Edge management" },
  { path: "variance_threshold", label: "Edge threshold", section: "Edge management" },
  { path: "threshold", label: "Luminance masking threshold", section: "Diffusion spatiality", unit: "%" },
];

// demosaic's passthrough methods have no smoothing, green matching or
// capture sharpening; capture's controls show while it is on
const PASSING = (p: Record<string, number>) => [3, 4, 1027, 1029].includes(p.demosaicing_method);
const CAPTURE = (p: Record<string, number>) => p.cs_enabled === 1 && !PASSING(p);

// color calibration's settings, shared by its Basic and B&W cards
const CALIBRATION: LayoutField[] = [
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
];

// the color equalizer's settings, shared by its HSL / Color and B&W cards
const COLOREQUAL: LayoutField[] = [
  { path: "hue_shift", label: "Node placement", unit: "°", digits: 0 },
  { path: "hue_red", label: "Red", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_orange", label: "Orange", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_yellow", label: "Yellow", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_green", label: "Green", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_cyan", label: "Cyan", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_blue", label: "Blue", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_lavender", label: "Lavender", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "hue_magenta", label: "Magenta", tab: "Hue", section: "Control sliders", unit: "°", digits: 2 },
  { path: "sat_red", label: "Red", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_orange", label: "Orange", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_yellow", label: "Yellow", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_green", label: "Green", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_cyan", label: "Cyan", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_blue", label: "Blue", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_lavender", label: "Lavender", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "sat_magenta", label: "Magenta", tab: "Saturation", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_red", label: "Red", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_orange", label: "Orange", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_yellow", label: "Yellow", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_green", label: "Green", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_cyan", label: "Cyan", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_blue", label: "Blue", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_lavender", label: "Lavender", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "bright_magenta", label: "Magenta", tab: "Brightness", section: "Control sliders", unit: "%", offset: -100, digits: 2 },
  { path: "white_level", label: "White level", section: "Options", soft: [-2, 2], unit: "EV" },
  { path: "smoothing_hue", label: "Hue curve", section: "Options" },
  { path: "use_filter", label: "Use guided filter", section: "Options" },
  { path: "chroma_size", label: "Hue analysis radius", section: "Options", unit: "px", digits: 1, showIf: (p) => !!p.use_filter },
  { path: "threshold", label: "Saturation threshold", section: "Options", unit: "%", digits: 3, showIf: (p) => !!p.use_filter },
  { path: "contrast", label: "Contrast", section: "Options", digits: 3, showIf: (p) => !!p.use_filter },
  { path: "param_size", label: "Effect radius", section: "Options", unit: "px", digits: 1, showIf: (p) => !!p.use_filter },
];

// color balance rgb's settings, shared by its Basic and Color Grading cards
const COLORBALANCERGB: LayoutField[] = [
  { path: "hue_angle", label: "Hue shift", tab: "Master", unit: "°" },
  { path: "vibrance", label: "Global vibrance", tab: "Master", soft: [-0.5, 0.5], digits: 2, unit: "%" },
  { path: "contrast", label: "Contrast", tab: "Master", soft: [-0.5, 0.5], digits: 2, unit: "%" },
  { path: "chroma_global", label: "Global chroma", tab: "Master", section: "Linear chroma grading", soft: [-0.5, 0.5], digits: 2, unit: "%" },
  { path: "chroma_shadows", label: "Shadows", tab: "Master", section: "Linear chroma grading", digits: 2, unit: "%" },
  { path: "chroma_midtones", label: "Mid-tones", tab: "Master", section: "Linear chroma grading", digits: 2, unit: "%" },
  { path: "chroma_highlights", label: "Highlights", tab: "Master", section: "Linear chroma grading", digits: 2, unit: "%" },
  { path: "saturation_global", label: "Global saturation", tab: "Master", section: "Perceptual saturation grading", digits: 2, unit: "%" },
  { path: "saturation_shadows", label: "Shadows", tab: "Master", section: "Perceptual saturation grading", digits: 2, unit: "%" },
  { path: "saturation_midtones", label: "Mid-tones", tab: "Master", section: "Perceptual saturation grading", digits: 2, unit: "%" },
  { path: "saturation_highlights", label: "Highlights", tab: "Master", section: "Perceptual saturation grading", digits: 2, unit: "%" },
  { path: "brilliance_global", label: "Global brilliance", tab: "Master", section: "Perceptual brilliance grading", digits: 2, unit: "%" },
  { path: "brilliance_shadows", label: "Shadows", tab: "Master", section: "Perceptual brilliance grading", digits: 2, unit: "%" },
  { path: "brilliance_midtones", label: "Mid-tones", tab: "Master", section: "Perceptual brilliance grading", digits: 2, unit: "%" },
  { path: "brilliance_highlights", label: "Highlights", tab: "Master", section: "Perceptual brilliance grading", digits: 2, unit: "%" },
  { path: "global_Y", label: "Luminance", tab: "4 ways", section: "Global offset", soft: [-0.05, 0.05], digits: 2, unit: "%" },
  { path: "global_H", label: "Hue", tab: "4 ways", section: "Global offset", unit: "°" },
  { path: "global_C", label: "Chroma", tab: "4 ways", section: "Global offset", soft: [0, 0.01], digits: 2, unit: "%" },
  { path: "shadows_Y", label: "Luminance", tab: "4 ways", section: "Shadows lift", soft: [-1, 1], digits: 2, unit: "%" },
  { path: "shadows_H", label: "Hue", tab: "4 ways", section: "Shadows lift", unit: "°" },
  { path: "shadows_C", label: "Chroma", tab: "4 ways", section: "Shadows lift", soft: [0, 0.5], digits: 2, unit: "%" },
  { path: "highlights_Y", label: "Luminance", tab: "4 ways", section: "Highlights gain", soft: [-0.5, 0.5], digits: 2, unit: "%" },
  { path: "highlights_H", label: "Hue", tab: "4 ways", section: "Highlights gain", unit: "°" },
  { path: "highlights_C", label: "Chroma", tab: "4 ways", section: "Highlights gain", soft: [0, 0.2], digits: 2, unit: "%" },
  { path: "midtones_Y", label: "Luminance", tab: "4 ways", section: "Power", soft: [-0.25, 0.25], digits: 2, unit: "%" },
  { path: "midtones_H", label: "Hue", tab: "4 ways", section: "Power", unit: "°" },
  { path: "midtones_C", label: "Chroma", tab: "4 ways", section: "Power", soft: [0, 0.1], digits: 2, unit: "%" },
  { path: "saturation_formula", label: "Saturation formula", tab: "Masks" },
  { path: "shadows_weight", label: "Shadows fall-off", tab: "Masks", section: "Luminance ranges", digits: 2, unit: "%" },
  { path: "mask_grey_fulcrum", label: "Mask middle-gray fulcrum", tab: "Masks", section: "Luminance ranges", digits: 2, unit: "%" },
  { path: "highlights_weight", label: "Highlights fall-off", tab: "Masks", section: "Luminance ranges", digits: 2, unit: "%" },
  { path: "white_fulcrum", label: "White fulcrum", tab: "Masks", section: "Threshold", soft: [-2, 2], unit: "EV" },
  { path: "grey_fulcrum", label: "Contrast gray fulcrum", tab: "Masks", section: "Threshold", soft: [0.1, 0.5], digits: 2, unit: "%" },
];

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
    fields: CALIBRATION,
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
    // agx.c gui_init, _add_exposure_box, _create_basic_curve_controls_box, _create_advanced_box,
    // _add_look_box, _create_primaries_page, _update_redraw_dynamic_gui; default preferences, so
    // no Curve tab. left out: the curve graph, all pickers and the read exposure, reset primaries
    // and set from above buttons (not params). pivot x shows offset + x * range in EV from the
    // white and black params (_update_pivot_slider_settings), so only its hard range is static
    op: "agx", group: "basic", title: "AgX",
    fields: [
      { path: "range_white_relative_ev", label: "White relative exposure", tab: "Settings", section: "Input exposure range", soft: [1, 10], unit: "EV", digits: 2 },
      { path: "range_black_relative_ev", label: "Black relative exposure", tab: "Settings", section: "Input exposure range", soft: [-20, -1], unit: "EV", digits: 2 },
      { path: "dynamic_range_scaling", label: "Dynamic range scaling", tab: "Settings", section: "Input exposure range", soft: [-0.5, 0.5], unit: "%", digits: 2 },
      { path: "curve_pivot_x", label: "Pivot relative exposure", tab: "Settings", section: "Basic curve parameters", unit: "EV", digits: 2 },
      { path: "curve_pivot_y_linear_output", label: "Pivot target output", tab: "Settings", section: "Basic curve parameters", unit: "%", digits: 2 },
      { path: "curve_contrast_around_pivot", label: "Contrast", tab: "Settings", section: "Basic curve parameters", soft: [0.1, 5] },
      { path: "curve_shoulder_power", label: "Shoulder power", tab: "Settings", section: "Basic curve parameters", soft: [1, 5] },
      { path: "curve_toe_power", label: "Toe power", tab: "Settings", section: "Basic curve parameters", soft: [1, 5] },
      { path: "curve_linear_ratio_above_pivot", label: "Shoulder start", tab: "Settings", section: "Advanced curve parameters", unit: "%", digits: 2 },
      { path: "curve_target_display_white_ratio", label: "Target white", tab: "Settings", section: "Advanced curve parameters", soft: [0.5, 1], unit: "%", digits: 2 },
      { path: "target_white_from_output", label: "Follow output peak", tab: "Settings", section: "Advanced curve parameters", showIf: (p) => !p.target_white_from_output },
      { path: "hdr_purity", label: "HDR purity", tab: "Settings", section: "Advanced curve parameters", unit: "%", digits: 0, showIf: (p) => !!p.target_white_from_output },
      { path: "curve_linear_ratio_below_pivot", label: "Toe start", tab: "Settings", section: "Advanced curve parameters", unit: "%", digits: 2 },
      { path: "curve_target_display_black_ratio", label: "Target black", tab: "Settings", section: "Advanced curve parameters", soft: [0, 0.025], unit: "%", digits: 2 },
      { path: "auto_gamma", label: "Keep the pivot on the diagonal", tab: "Settings", section: "Advanced curve parameters" },
      { path: "curve_gamma", label: "Curve y gamma", tab: "Settings", section: "Advanced curve parameters", soft: [1, 5], showIf: (p) => !p.auto_gamma },
      { path: "look_slope", label: "Slope", tab: "Settings", section: "Look", soft: [0, 2] },
      { path: "look_lift", label: "Lift", tab: "Settings", section: "Look", soft: [-0.5, 0.5], digits: 2 },
      { path: "look_brightness", label: "Brightness", tab: "Settings", section: "Look", soft: [0, 2] },
      { path: "look_saturation", label: "Saturation", tab: "Settings", section: "Look", soft: [0, 2], unit: "%", digits: 2 },
      { path: "look_original_hue_mix_ratio", label: "Preserve hue", tab: "Settings", section: "Look", unit: "%", digits: 2 },
      { path: "base_primaries", label: "Base primaries", tab: "Primaries" },
      { path: "disable_primaries_adjustments", label: "Disable adjustments", tab: "Primaries" },
      // the two sections below and everything in them hide with disable_primaries_adjustments
      { path: "red_inset", label: "Red attenuation", tab: "Primaries", section: "Before tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "red_rotation", label: "Red rotation", tab: "Primaries", section: "Before tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "green_inset", label: "Green attenuation", tab: "Primaries", section: "Before tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "green_rotation", label: "Green rotation", tab: "Primaries", section: "Before tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "blue_inset", label: "Blue attenuation", tab: "Primaries", section: "Before tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "blue_rotation", label: "Blue rotation", tab: "Primaries", section: "Before tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments },
      { path: "completely_reverse_primaries", label: "Reverse all", tab: "Primaries", section: "After tone mapping", showIf: (p) => !p.disable_primaries_adjustments },
      { path: "master_outset_ratio", label: "Master purity boost", tab: "Primaries", section: "After tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "master_unrotation_ratio", label: "Master rotation reversal", tab: "Primaries", section: "After tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "red_outset", label: "Red purity boost", tab: "Primaries", section: "After tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "red_unrotation", label: "Red reverse rotation", tab: "Primaries", section: "After tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "green_outset", label: "Green purity boost", tab: "Primaries", section: "After tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "green_unrotation", label: "Green reverse rotation", tab: "Primaries", section: "After tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "blue_outset", label: "Blue purity boost", tab: "Primaries", section: "After tone mapping", unit: "%", digits: 2, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
      { path: "blue_unrotation", label: "Blue reverse rotation", tab: "Primaries", section: "After tone mapping", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => !p.disable_primaries_adjustments && !p.completely_reverse_primaries },
    ],
  },
  {
    // sigmoid.c gui_init (look, color processing, collapsible primaries then display luminance
    // sections) and gui_changed (visibility); nothing is left out: every param has a widget
    // and no custom editor is needed. the percent sliders with hard max <= 10 get factor 100
    // from dt_bauhaus_slider_set_format, so it is not repeated
    op: "sigmoid", group: "basic", title: "Sigmoid",
    fields: [
      { path: "middle_grey_contrast", label: "Contrast", soft: [0.7, 3], digits: 3 },
      { path: "contrast_skewness", label: "Skew" },
      { path: "color_processing", label: "Color processing" },
      { path: "hue_preservation", label: "Preserve hue", unit: "%", showIf: (p) => p.color_processing === 0 },
      { path: "base_primaries", label: "Base primaries", section: "Primaries", showIf: (p) => p.color_processing === 0 },
      { path: "red_inset", label: "Red attenuation", section: "Primaries", soft: [0, 0.5], unit: "%", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "red_rotation", label: "Red rotation", section: "Primaries", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "green_inset", label: "Green attenuation", section: "Primaries", soft: [0, 0.5], unit: "%", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "green_rotation", label: "Green rotation", section: "Primaries", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "blue_inset", label: "Blue attenuation", section: "Primaries", soft: [0, 0.5], unit: "%", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "blue_rotation", label: "Blue rotation", section: "Primaries", factor: 57.29578, unit: "°", digits: 1, showIf: (p) => p.color_processing === 0 },
      { path: "purity", label: "Recover purity", section: "Primaries", unit: "%", digits: 0, showIf: (p) => p.color_processing === 0 },
      { path: "display_black_target", label: "Target black", section: "Display luminance", soft: [0, 1], unit: "%", digits: 4 },
      { path: "display_white_target", label: "Target white", section: "Display luminance", soft: [50, 100], unit: "%" },
      { path: "white_target_from_output", label: "Follow output peak", section: "Display luminance", showIf: (p) => !p.white_target_from_output },
    ],
    // per channel hides hue_preservation and the whole primaries section; follow output peak
    // shows only for edits that predate HDR output (it is off there)
  },
  {
    // filmicrgb.c gui_init (graph over a notebook of five pages) and gui_changed (hardness,
    // custom gray, color science rules); "%" sliders get no factor because their hard max is
    // above 10. left out: the curve graph, the auto tune levels picker, the three scene
    // pickers, the display reconstruction mask button; compensate_icc_black and spline_version
    // have no widget; no custom editor needed. reconstruction sliders are only greyed, not hidden
    op: "filmicrgb", group: "basic", title: "Filmic rgb",
    fields: [
      { path: "grey_point_source", label: "Middle gray luminance", tab: "Scene", soft: [0.1, 36], unit: "%", showIf: (p) => p.custom_grey === 1 },
      { path: "white_point_source", label: "White relative exposure", tab: "Scene", soft: [2, 8], unit: "EV" },
      { path: "black_point_source", label: "Black relative exposure", tab: "Scene", soft: [-14, -3], unit: "EV" },
      { path: "security_factor", label: "Dynamic range scaling", tab: "Scene", soft: [-50, 50], unit: "%" },
      { path: "enable_highlight_reconstruction", label: "Enable highlight reconstruction", tab: "Reconstruct", section: "Highlights clipping" },
      { path: "reconstruct_threshold", label: "Threshold", tab: "Reconstruct", section: "Highlights clipping", unit: "EV" },
      { path: "reconstruct_feather", label: "Transition", tab: "Reconstruct", section: "Highlights clipping", unit: "EV" },
      { path: "reconstruct_structure_vs_texture", label: "Structure ↔ texture", tab: "Reconstruct", section: "Balance", unit: "%" },
      { path: "reconstruct_bloom_vs_details", label: "Bloom ↔ reconstruct", tab: "Reconstruct", section: "Balance", unit: "%" },
      { path: "reconstruct_grey_vs_color", label: "Gray ↔ colorful details", tab: "Reconstruct", section: "Balance", unit: "%" },
      { path: "contrast", label: "Contrast", tab: "Look", soft: [0.5, 3], digits: 3 },
      { path: "output_power", label: "Hardness", tab: "Look", showIf: (p) => p.auto_hardness === 0 },
      { path: "latitude", label: "Linear region", tab: "Look", soft: [0.1, 90], unit: "%" },
      { path: "balance", label: "Shadows ↔ highlights balance", tab: "Look", unit: "%" },
      // label follows version (gui_changed): 0 and 3 extreme luminance saturation, 1 and 2
      // mid-tones saturation, 4 highlights saturation mix; the default version is 4
      { path: "saturation", label: "Highlights saturation mix", tab: "Look", soft: [-50, 50], unit: "%" },
      { path: "black_point_target", label: "Target black luminance", tab: "Display", digits: 4, unit: "%" },
      { path: "grey_point_target", label: "Target middle gray", tab: "Display", digits: 4, unit: "%", showIf: (p) => p.custom_grey === 1 },
      { path: "white_point_target", label: "Target white luminance", tab: "Display", soft: [0, 100], digits: 4, unit: "%" },
      { path: "version", label: "Color science", tab: "Options" },
      // hidden when color science is v7 (4); the legacy euclidean norm (4) is removed from the list
      { path: "preserve_color", label: "Preserve chrominance", tab: "Options", options: [0, 1, 2, 3, 5], showIf: (p) => p.version !== 4 },
      { path: "highlights", label: "Contrast in highlights", tab: "Options" },
      { path: "shadows", label: "Contrast in shadows", tab: "Options" },
      { path: "custom_grey", label: "Use custom middle-gray values", tab: "Options" },
      { path: "auto_hardness", label: "Auto adjust hardness", tab: "Options" },
      { path: "high_quality_reconstruction", label: "Iterations of high-quality reconstruction", tab: "Options" },
      { path: "noise_level", label: "Add noise in highlights", tab: "Options" },
      { path: "noise_distribution", label: "Type of noise", tab: "Options" },
    ],
    // moving threshold or transition turns reconstruction on, and security factor, gray source
    // and auto hardness rewrite other sliders (white, black, hardness) in gui_changed; none of
    // that is a showIf rule
  },
  {
    // basecurve.c gui_init, gui_changed and gui_update (the two fusion sliders show only
    // while fusion is not none). left out: basecurve, basecurve_nodes and basecurve_type
    // (the curve graph, which needs a curve editor with node add, drag, remove and curve type)
    // and the scale for graph slider (a graph view setting, not a param)
    op: "basecurve", group: "basic", title: "Base curve",
    fields: [
      { path: "preserve_colors", label: "Preserve colors" },
      { path: "exposure_fusion", label: "Fusion", choices: [["None", 0], ["Two exposures", 1], ["Three exposures", 2]] },
      { path: "exposure_stops", label: "Exposure shift", digits: 3, showIf: (p) => p.exposure_fusion !== 0 },
      // the slider's double-click default is set to 0 in gui_init though the param default is 1
      { path: "exposure_bias", label: "Exposure bias", digits: 3, showIf: (p) => p.exposure_fusion !== 0 },
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
  {
    // bilat.c gui_init and gui_changed: coarseness and contrast show for the
    // bilateral grid, highlights and shadows (the same sigma_s and sigma_r,
    // hard max 2 in gui_init, so a soft max here) and midtone range for the
    // local laplacian. gui_init also gives coarseness and contrast their own
    // hard min and default, which the card cannot express (soft min only)
    op: "bilat", group: "basic", title: "Local contrast",
    fields: [
      { path: "mode", label: "Mode" },
      { path: "detail", label: "Detail", unit: "%", offset: 100 },
      { path: "sigma_s", label: "Coarseness", soft: [3, 100], digits: 0, showIf: (p) => p.mode !== 1 },
      { path: "sigma_r", label: "Contrast", soft: [1, 100], digits: 0, showIf: (p) => p.mode !== 1 },
      { path: "sigma_r", label: "Highlights", soft: [0, 2], unit: "%", factor: 100, showIf: (p) => p.mode === 1 },
      { path: "sigma_s", label: "Shadows", soft: [0, 2], unit: "%", factor: 100, showIf: (p) => p.mode === 1 },
      { path: "midtone", label: "Midtone range", digits: 3, showIf: (p) => p.mode === 1 },
    ],
  },
  {
    // hazeremoval.c gui_init: strength, then distance. left out: the
    // compatibility mode and adaptive flags, which darktable never shows and
    // gui_changed resets whenever one of these sliders moves
    op: "hazeremoval", group: "basic", title: "Haze removal",
    fields: [
      { path: "strength", label: "Strength" },
      { path: "distance", label: "Distance", digits: 3 },
    ],
  },
  {
    // Simple's Texture drives its first instance
    op: "diffuse", group: "basic", title: "Diffuse or sharpen",
    fields: DIFFUSE,
  },
  {
    // colorbalancergb.c gui_init (a notebook of master, 4 ways and masks
    // pages); gui_changed only repaints slider backgrounds. left out: the
    // luminance range graph, the mask preview and hue picker buttons, and the
    // mask preview settings (checker colors and size, kept in darktablerc)
    op: "colorbalancergb", group: "basic", title: "Color balance rgb",
    fields: COLORBALANCERGB,
  },
  {
    // tonecurve.c gui_init and gui_changed (preserve colors shows only for
    // RGB, linked channels). left out: the curve graph (tonecurve,
    // tonecurve_nodes, tonecurve_type), which needs a curve editor; the
    // interpolation method, which sets all three curves' type at once; the
    // scale for graph slider and the pickers
    op: "tonecurve", group: "tonecurve", title: "Tone curve",
    fields: [
      { path: "tonecurve_autoscale_ab", label: "Color space" },
      { path: "preserve_colors", label: "Preserve colors", showIf: (p) => p.tonecurve_autoscale_ab === 3 },
    ],
  },
  {
    // rgbcurve.c gui_init and _rgbcurve_show_hide_controls (preserve colors
    // shows only for linked channels). left out: the curve graph (curve_nodes,
    // curve_num_nodes, curve_type), which needs a curve editor; the
    // interpolation method, which sets all three curves' type at once; the pickers
    op: "rgbcurve", group: "tonecurve", title: "RGB curve",
    fields: [
      { path: "curve_autoscale", label: "Mode" },
      { path: "compensate_middle_grey", label: "Compensate middle gray" },
      { path: "preserve_colors", label: "Preserve colors", showIf: (p) => p.curve_autoscale === 0 },
    ],
  },
  {
    // rgblevels.c gui_init and _rgblevels_show_hide_controls (preserve colors
    // shows only for linked channels). left out: levels, the black, gray and
    // white handles, which need the levels widget; the pickers, auto levels
    // and select region
    op: "rgblevels", group: "tonecurve", title: "RGB levels",
    fields: [
      { path: "autoscale", label: "Mode" },
      { path: "preserve_colors", label: "Preserve colors", showIf: (p) => p.autoscale === 0 },
    ],
  },
  {
    // toneequal.c gui_init (the simple, advanced and masking pages) and
    // show_guiding_controls (the guided filter settings hide for no filter,
    // and mask contrast compensation shows only for the guided filter and
    // EIGF). left out: the advanced page's curve graph, which needs a curve
    // editor; curve smoothing (a slider computed from smoothing, not the
    // param itself); the mask display toggle and the two auto-adjust buttons
    op: "toneequal", group: "tonecurve", title: "Tone equalizer",
    fields: [
      // dt_bauhaus_widget_set_label names the simple page's bands by their EV
      { path: "noise", label: "-8 EV", tab: "Simple", unit: "EV" },
      { path: "ultra_deep_blacks", label: "-7 EV", tab: "Simple", unit: "EV" },
      { path: "deep_blacks", label: "-6 EV", tab: "Simple", unit: "EV" },
      { path: "blacks", label: "-5 EV", tab: "Simple", unit: "EV" },
      { path: "shadows", label: "-4 EV", tab: "Simple", unit: "EV" },
      { path: "midtones", label: "-3 EV", tab: "Simple", unit: "EV" },
      { path: "highlights", label: "-2 EV", tab: "Simple", unit: "EV" },
      { path: "whites", label: "-1 EV", tab: "Simple", unit: "EV" },
      { path: "speculars", label: "+0 EV", tab: "Simple", unit: "EV" },
      { path: "exposure_boost", label: "Mask exposure compensation", tab: "Advanced", soft: [-4, 4], unit: "EV" },
      { path: "contrast_boost", label: "Mask contrast compensation", tab: "Advanced", soft: [-2, 2], unit: "EV",
        showIf: (p) => p.details === 2 || p.details === 4 },
      // DT_TONEEQ_LAST (7) closes the enum and is no estimator
      { path: "method", label: "Luminance estimator", tab: "Masking", options: [0, 1, 2, 3, 4, 5, 6] },
      { path: "details", label: "Preserve details", tab: "Masking" },
      { path: "iterations", label: "Filter diffusion", tab: "Masking", soft: [1, 5], showIf: (p) => p.details !== 0 },
      { path: "blending", label: "Smoothing diameter", tab: "Masking", soft: [1, 45], unit: "%", showIf: (p) => p.details !== 0 },
      { path: "feathering", label: "Edges refinement/feathering", tab: "Masking", soft: [0.1, 50], showIf: (p) => p.details !== 0 },
      { path: "quantization", label: "Mask quantization", tab: "Masking", unit: "EV", showIf: (p) => p.details !== 0 },
    ],
  },
  {
    // shadhi.c gui_init; nothing hides a field. left out: flags (the
    // unbounded and filter bits, no widget), order, reserved2 and
    // low_approximation (no widget either)
    op: "shadhi", group: "tonecurve", title: "Shadows and highlights",
    fields: [
      { path: "shadows", label: "Shadows" },
      { path: "highlights", label: "Highlights" },
      { path: "whitepoint", label: "White point adjustment" },
      { path: "shadhi_algo", label: "Soften with" },
      { path: "radius", label: "Radius" },
      { path: "compress", label: "Compress", unit: "%" },
      { path: "shadows_ccorrect", label: "Shadows color adjustment", unit: "%" },
      { path: "highlights_ccorrect", label: "Highlights color adjustment", unit: "%" },
    ],
  },
  {
    // colorequal.c gui_init, _init_sliders and gui_changed: node placement
    // under the graph, then the collapsible "control sliders" (a notebook of
    // hue, saturation and brightness pages, one slider per hue node) and the
    // collapsible "options". the percent sliders have a hard max <= 10, so
    // set_format gives them factor 100 (not repeated); _init_sliders offsets
    // saturation and brightness by -100 so 1.0 reads 0%. the four guided
    // filter sliders hide with use_filter (gui_changed). smoothing_hue shows
    // only on the graph's hue page (g->channel, a gui state not a param), so
    // it is listed unconditionally. left out: the hue/saturation/brightness
    // graph itself (needs a custom editor, drawn with a node-dragging curve
    // per page), the node placement and white level pickers and the two mask
    // preview quad buttons (not params)
    op: "colorequal", group: "hsl", title: "Color equalizer",
    fields: COLOREQUAL,
  },
  {
    // satcurvergb.c gui_init and gui_changed: the formula combobox, then the
    // collapsible "guided filter" section. gui_changed only greys the section
    // out (not hidden): it needs the darktable UCS formula, and its sliders
    // also need use_guided_filter. left out: channel (the saturation and
    // brilliance curves, which need a custom curve editor with node add, drag
    // and remove, two pages), gf_protect_from and gf_protect_to (darktable
    // shows them as the computed "protect near-neutrals" center and
    // "protection transition width" sliders, not params), and the picker and
    // mask display buttons
    op: "satcurvergb", group: "hsl", title: "Saturation curve",
    fields: [
      { path: "formula", label: "Saturation formula" },
      { path: "use_guided_filter", label: "Use guided filter", section: "Guided filter" },
      { path: "gf_radius", label: "Filter radius", section: "Guided filter", unit: "px", digits: 1 },
      { path: "gf_feathering", label: "Edge feathering", section: "Guided filter", digits: 1 },
      { path: "noise_protection", label: "Noise protection", section: "Guided filter", unit: "%", digits: 2 },
    ],
  },
  {
    // velvia.c gui_init: two sliders, nothing hidden. strength has no
    // description in introspection; darktable labels it from its field name
    op: "velvia", group: "hsl", title: "Velvia",
    fields: [
      { path: "strength", label: "Strength", unit: "%" },
      { path: "bias", label: "Mid-tones bias" },
    ],
  },
  {
    // colorcontrast.c gui_init: the two steepness sliders. left out: a_offset,
    // b_offset and unbound, which have no widget
    op: "colorcontrast", group: "hsl", title: "Color contrast",
    fields: [
      { path: "a_steepness", label: "Green-magenta contrast" },
      { path: "b_steepness", label: "Blue-yellow contrast" },
    ],
  },
  {
    // colorzones.c gui_init: the three from_params widgets under the graph
    // (select by, process mode, mix); gui_changed hides nothing. left out:
    // curve, curve_num_nodes and curve_type (the three channel curves, which
    // need a custom curve editor with the lightness, chroma and hue pages,
    // node add, drag and remove, and the interpolation combobox that edits
    // curve_type of the shown channel), splines_version (no widget), and the
    // channel notebook, pickers, edit by area and display selection (not
    // params). enum value 3 of channel has no description and is not offered
    op: "colorzones", group: "hsl", title: "Color zones",
    fields: [
      { path: "channel", label: "Select by", options: [0, 1, 2] },
      { path: "mode", label: "Process mode" },
      { path: "strength", label: "Mix", unit: "%" },
    ],
  },
  {
    // colorharmonizer.c gui_init and _update_visibility: rule, node count
    // (custom rule only), the four pull sliders, then the collapsible
    // "saturation" section. a saturation slider shows for each harmony node:
    // the node count of the rule (get_harmony_nodes with the color_harmony.h
    // sector table: monochromatic 1, analogous 3, analogous complementary 4,
    // complementary 2, split complementary 3, dyad 2, triad 3, tetrad 4,
    // square 4) or num_custom_nodes for custom. left out: anchor_hue and
    // custom_hue[0..3] (darktable shows them as degrees on an RYB wheel via
    // _ucs_to_ryb_fast, a nonlinear conversion from the stored UCS hue, so
    // they need a custom hue editor), the node swatches, the auto detect and
    // vectorscope sync buttons, and the anchor hue and custom hue pickers
    op: "colorharmonizer", group: "hsl", title: "Color harmonizer",
    fields: [
      { path: "rule", label: "Harmony rule" },
      { path: "num_custom_nodes", label: "Nodes", digits: 0, showIf: (p) => p.rule === 9 },
      { path: "pull_strength", label: "Pull strength" },
      { path: "pull_width", label: "Pull width", digits: 2 },
      { path: "neutral_protection", label: "Neutral color protection", digits: 2 },
      { path: "smoothing", label: "Smoothing", digits: 2 },
      { path: "node_saturation[0]", label: "Hue 1", section: "Saturation", unit: "%", factor: 100, digits: 0, showIf: (p) => (p.rule === 9 ? Math.min(4, Math.max(2, p.num_custom_nodes)) : [1, 3, 4, 2, 3, 2, 3, 4, 4][p.rule]) > 0 },
      { path: "node_saturation[1]", label: "Hue 2", section: "Saturation", unit: "%", factor: 100, digits: 0, showIf: (p) => (p.rule === 9 ? Math.min(4, Math.max(2, p.num_custom_nodes)) : [1, 3, 4, 2, 3, 2, 3, 4, 4][p.rule]) > 1 },
      { path: "node_saturation[2]", label: "Hue 3", section: "Saturation", unit: "%", factor: 100, digits: 0, showIf: (p) => (p.rule === 9 ? Math.min(4, Math.max(2, p.num_custom_nodes)) : [1, 3, 4, 2, 3, 2, 3, 4, 4][p.rule]) > 2 },
      { path: "node_saturation[3]", label: "Hue 4", section: "Saturation", unit: "%", factor: 100, digits: 0, showIf: (p) => (p.rule === 9 ? Math.min(4, Math.max(2, p.num_custom_nodes)) : [1, 3, 4, 2, 3, 2, 3, 4, 4][p.rule]) > 3 },
    ],
  },
  {
    // primaries.c gui_init (_setup_hue_slider and _setup_purity_slider): hue
    // and purity per primary, then the achromatic tint. hues are stored in
    // radians and shown in degrees (RAD_2_DEG, 57.29578), their soft range is
    // +-20 degrees; purity is shown as an offset percentage (1.0 reads 0%).
    // gui_changed only repaints slider backgrounds. every param has a widget,
    // no custom editor needed
    op: "primaries", group: "hsl", title: "RGB primaries",
    fields: [
      { path: "red_hue", label: "Red hue", soft: [-0.349066, 0.349066], factor: 57.29578, unit: "°", digits: 1 },
      { path: "red_purity", label: "Red purity", soft: [0.5, 1.5], factor: 100, offset: -100, unit: "%", digits: 1 },
      { path: "green_hue", label: "Green hue", soft: [-0.349066, 0.349066], factor: 57.29578, unit: "°", digits: 1 },
      { path: "green_purity", label: "Green purity", soft: [0.5, 1.5], factor: 100, offset: -100, unit: "%", digits: 1 },
      { path: "blue_hue", label: "Blue hue", soft: [-0.349066, 0.349066], factor: 57.29578, unit: "°", digits: 1 },
      { path: "blue_purity", label: "Blue purity", soft: [0.5, 1.5], factor: 100, offset: -100, unit: "%", digits: 1 },
      { path: "achromatic_tint_hue", label: "Tint hue", factor: 57.29578, unit: "°", digits: 1 },
      { path: "achromatic_tint_purity", label: "Tint purity", soft: [0, 0.2], factor: 100, unit: "%", digits: 1 },
    ],
  },
  {
    // colorcorrection.c gui_init: the a/b grid, then one saturation slider.
    // left out: hia, hib, loa and lob, which darktable only edits by dragging
    // the highlight and shadow handles on the grid (they need a custom grid
    // editor); the slider has no description, darktable labels it from the
    // field name
    op: "colorcorrection", group: "hsl", title: "Color correction",
    fields: [
      { path: "saturation", label: "Saturation" },
    ],
  },
  {
    // colorchecker.c gui_init: a patch grid and a patch combobox (not params),
    // then lightness, green-magenta offset, blue-yellow offset and saturation
    // sliders plus a relative/absolute target combobox, all callbacks that
    // edit the target_L, target_a and target_b element of the selected patch
    // (and num_patches' patch list). a static layout cannot address "the
    // selected patch", so every widget is left out; this needs a custom
    // editor (the patch grid with source_* and target_* arrays, 24 or 49
    // patches). the params source_L/a/b, target_L/a/b and num_patches have
    // no widget of their own
    op: "colorchecker", group: "hsl", title: "Color look up table",
    fields: [],
  },
  {
    // lut3d.c gui_init: file chooser button and file combobox, then (with
    // gmic) a LUT name entry and list, then the color space and interpolation
    // comboboxes. darktable hides the color space combobox when the module
    // sits outside the colorin to colorout stretch of the pipe (_show_hide_
    // colorspace, which depends on the module order, not on params), so it is
    // listed unconditionally. left out: filepath and lutname (strings set by
    // the file picker and the LUT list, which need a custom file chooser; the
    // LUT folder comes from preferences), nb_keypoints and c_clut (the
    // compressed LUT data, no widget)
    op: "lut3d", group: "hsl", title: "LUT 3D",
    fields: [
      { path: "colorspace", label: "Application color space" },
      { path: "interpolation", label: "Interpolation" },
    ],
  },
  {
    // colormapping.c gui_init: source and target cluster previews and the
    // acquire buttons, then three sliders; gui_changed hides nothing (it only
    // clears the stored clusters when the cluster count moves, so changing
    // "number of clusters" discards an acquired source and target). left out:
    // flag, source_* and target_* (the acquired histograms, means, variances
    // and weights, which need a custom editor showing the two cluster previews
    // and the acquire as source and acquire as target buttons, which analyze
    // the image on screen)
    op: "colormapping", group: "hsl", title: "Color mapping",
    fields: [
      { path: "n", label: "Number of clusters", digits: 0 },
      { path: "dominance", label: "Color dominance", unit: "%" },
      { path: "equalization", label: "Histogram equalization", unit: "%" },
    ],
  },
  {
    // Simple's B&W conversion with color calibration: its own instance, a
    // gray mix, so darktable's Gray page comes first
    op: "channelmixerrgb", group: "bw", title: "Color calibration",
    instance: { name: "bw", add: [["bw_mode", 1], ["mod_bw", 0]] },
    fields: [...CALIBRATION.filter((f) => f.tab === "Gray"), ...CALIBRATION.filter((f) => f.tab !== "Gray")],
  },
  {
    // the color equalizer's first instance, which HSL / Color's card shows
    // too: Simple's B&W conversion with the color equalizer desaturates every
    // band, and its mix is the brightness page, so that page comes first
    op: "colorequal", group: "bw", title: "Color equalizer",
    fields: [...COLOREQUAL.filter((f) => !f.tab && !f.section), ...COLOREQUAL.filter((f) => f.tab === "Brightness"),
             ...COLOREQUAL.filter((f) => f.tab && f.tab !== "Brightness"), ...COLOREQUAL.filter((f) => !f.tab && f.section)],
  },
  {
    // monochrome.c gui_init: the highlights slider under the filter graph.
    // left out: a, b and size, the virtual color filter's place and size,
    // which the graph sets by dragging and scrolling
    op: "monochrome", group: "bw", title: "Monochrome",
    fields: [
      { path: "highlights", label: "Highlights" },
    ],
  },
  {
    // the same instance as Basic's card: Simple's Color Grading wheels set
    // its 4 ways page, so that page comes first
    op: "colorbalancergb", group: "colorgrading", title: "Color balance rgb",
    fields: [...COLORBALANCERGB.filter((f) => f.tab === "4 ways"), ...COLORBALANCERGB.filter((f) => f.tab !== "4 ways")],
  },
  {
    // colorbalance.c gui_init, set_visible_widgets and _configure_slider_blocks
    // (the list layout's section headings); the master section hides in the
    // legacy sRGB mode. index 0 of lift, gamma and gain is the factor, 1-3
    // red, green and blue (CHANNEL_*). left out: the color control sliders
    // combobox, a darktablerc preference (HSL by default, which hides the RGB
    // sliders here), the hue and saturation sliders it shows instead, which
    // darktable computes from the RGB factors, the block layout preference,
    // the auto optimizers (slope, offset, power only) and the pickers
    op: "colorbalance", group: "colorgrading", title: "Color balance",
    fields: [
      { path: "mode", label: "Mode" },
      { path: "saturation", label: "Input saturation", section: "Master", soft: [0.5, 1.5], digits: 2, unit: "%", showIf: (p) => p.mode !== 2 },
      { path: "saturation_out", label: "Output saturation", section: "Master", soft: [0.5, 1.5], digits: 2, unit: "%", showIf: (p) => p.mode !== 2 },
      { path: "grey", label: "Contrast fulcrum", section: "Master", unit: "%", showIf: (p) => p.mode !== 2 },
      { path: "contrast", label: "Contrast", section: "Master", soft: [0.5, 1.5], factor: -100, offset: 100, digits: 2, unit: "%", showIf: (p) => p.mode !== 2 },
      { path: "lift[0]", label: "Factor", section: "Shadows: lift / offset", soft: [0.95, 1.05], factor: 100, offset: -100, digits: 2, unit: "%" },
      { path: "lift[1]", label: "Red", section: "Shadows: lift / offset", soft: [0.95, 1.05], offset: -1, digits: 5 },
      { path: "lift[2]", label: "Green", section: "Shadows: lift / offset", soft: [0.95, 1.05], offset: -1, digits: 5 },
      { path: "lift[3]", label: "Blue", section: "Shadows: lift / offset", soft: [0.95, 1.05], offset: -1, digits: 5 },
      { path: "gamma[0]", label: "Factor", section: "Mid-tones: gamma / power", soft: [0.5, 1.5], factor: 100, offset: -100, digits: 2, unit: "%" },
      { path: "gamma[1]", label: "Red", section: "Mid-tones: gamma / power", soft: [0.5, 1.5], offset: -1, digits: 5 },
      { path: "gamma[2]", label: "Green", section: "Mid-tones: gamma / power", soft: [0.5, 1.5], offset: -1, digits: 5 },
      { path: "gamma[3]", label: "Blue", section: "Mid-tones: gamma / power", soft: [0.5, 1.5], offset: -1, digits: 5 },
      { path: "gain[0]", label: "Factor", section: "Highlights: gain / slope", soft: [0.5, 1.5], factor: 100, offset: -100, digits: 2, unit: "%" },
      { path: "gain[1]", label: "Red", section: "Highlights: gain / slope", soft: [0.5, 1.5], offset: -1, digits: 5 },
      { path: "gain[2]", label: "Green", section: "Highlights: gain / slope", soft: [0.5, 1.5], offset: -1, digits: 5 },
      { path: "gain[3]", label: "Blue", section: "Highlights: gain / slope", soft: [0.5, 1.5], offset: -1, digits: 5 },
    ],
  },
  {
    // splittoning.c gui_init and gui_init_section: shadows and highlights,
    // each a hue in degrees and a saturation, then the properties section.
    // left out: the color buttons and pickers beside each section
    op: "splittoning", group: "colorgrading", title: "Split-toning",
    fields: [
      { path: "shadow_hue", label: "Hue", section: "Shadows", factor: 360, unit: "°" },
      { path: "shadow_saturation", label: "Saturation", section: "Shadows" },
      { path: "highlight_hue", label: "Hue", section: "Highlights", factor: 360, unit: "°" },
      { path: "highlight_saturation", label: "Saturation", section: "Highlights" },
      { path: "balance", label: "Balance", section: "Properties", factor: -100, offset: 100, digits: 4 },
      { path: "compress", label: "Compress", section: "Properties", unit: "%" },
    ],
  },
  {
    // colorize.c gui_init: four sliders, nothing hidden. left out: the hue
    // picker and version, which darktable keeps internally
    op: "colorize", group: "colorgrading", title: "Colorize",
    fields: [
      { path: "hue", label: "Hue", factor: 360, unit: "°" },
      { path: "saturation", label: "Saturation", unit: "%" },
      { path: "lightness", label: "Lightness", unit: "%" },
      { path: "source_lightness_mix", label: "Source mix", unit: "%" },
    ],
  },
  {
    // demosaic.c gui_init and gui_changed. darktable shows one of four method
    // comboboxes over the one demosaicing_method param, by the photo's sensor
    // (bayer, bayer4, X-Trans, monochrome), so the card lists every method.
    // sensor rules that read the image are left out: bayer4 hides color
    // smoothing and capture sharpen, and darktable rewrites a method from the
    // other sensor type. 3, 4, 1027 and 1029 are the passthrough methods,
    // 1024 the X-Trans and 2048 the dual flag. left out: moire_thrs and
    // moire_mix, which have no widget, and the mask view and auto radius
    // buttons beside the sliders
    op: "demosaic", group: "detail", title: "Demosaic",
    fields: [
      { path: "demosaicing_method", label: "Method" },
      { path: "dual_thrs", label: "Dual threshold", digits: 2, showIf: (p) => (p.demosaicing_method & 2048) !== 0 },
      { path: "median_thrs", label: "Edge threshold", digits: 3, showIf: (p) => p.demosaicing_method === 0 },
      { path: "lmmse_refine", label: "LMMSE refine", showIf: (p) => p.demosaicing_method === 6 },
      { path: "color_smoothing", label: "Color smoothing",
        showIf: (p) => !PASSING(p) && (p.demosaicing_method & 2048) === 0 && p.demosaicing_method !== 7 },
      { path: "green_eq", label: "Match greens",
        showIf: (p) => !PASSING(p) && (p.demosaicing_method & 1024) === 0 && p.demosaicing_method !== 7 },
      { path: "cs_enabled", label: "Capture sharpen", showIf: (p) => !PASSING(p) },
      { path: "cs_iter", label: "Iterations", section: "Capture sharpen controls", showIf: (p) => CAPTURE(p) },
      { path: "cs_radius", label: "Radius", section: "Capture sharpen controls", unit: "px", digits: 2, showIf: (p) => CAPTURE(p) },
      { path: "cs_thrs", label: "Contrast sensitivity", section: "Capture sharpen controls", showIf: (p) => CAPTURE(p) },
      { path: "cs_boost", label: "Corner boost", section: "Capture sharpen controls", unit: "px", digits: 2, showIf: (p) => CAPTURE(p) },
      { path: "cs_center", label: "Sharp center", section: "Capture sharpen controls", unit: "%", digits: 0,
        showIf: (p) => CAPTURE(p) && p.cs_boost !== 0 },
    ],
  },
  {
    // sharpen.c gui_init: three sliders, no visibility rules. Simple's
    // Sharpening with sharpen drives the first instance
    op: "sharpen", group: "detail", title: "Sharpen",
    fields: [
      { path: "radius", label: "Radius", soft: [0, 8], digits: 3 },
      { path: "amount", label: "Amount", digits: 3 },
      { path: "threshold", label: "Threshold", digits: 3 },
    ],
  },
  {
    // Simple's Sharpening with diffuse or sharpen: its own instance, from
    // darktable's "sharpness | normal" preset; Add module makes it at that
    // preset's 3 iterations
    op: "diffuse", group: "detail", title: "Diffuse or sharpen",
    instance: { name: "sharpen", add: [["mod_sharpening", 1], ["sharp_amount", 3]] },
    fields: DIFFUSE,
  },
  {
    // denoiseprofile.c gui_init, gui_changed and gui_update: the toggles and
    // mode, the non-local means box, the wavelets box, then the sliders under
    // them. mode 2 (compute variance) is offered only with darktable's
    // show_compute_variance_mode preference, off by default; compensate
    // highlight preservation shows only for photos whose ISO shifts
    // highlight preservation (_get_iso_highlight_preservation_shift).
    // left out: the profile combobox (a and b, from the noise profile
    // database for the camera and ISO), the variance labels, and the wavelet
    // curves (x and y, behind RGB and Y0U0V0 tabs), which need a curve editor
    op: "denoiseprofile", group: "detail", title: "Denoise (profiled)",
    fields: [
      { path: "compensate_hilite_pres", label: "Compensate highlight preservation" },
      { path: "wb_adaptive_anscombe", label: "Whitebalance-adaptive transform" },
      { path: "mode", label: "Mode", options: [0, 3, 1, 4] },
      { path: "radius", label: "Patch size", soft: [0, 8], digits: 0, showIf: (p) => p.mode === 0 },
      { path: "nbhood", label: "Search radius", digits: 0, showIf: (p) => p.mode === 0 },
      { path: "scattering", label: "Scattering", soft: [0, 1], showIf: (p) => p.mode === 0 },
      { path: "central_pixel_weight", label: "Central pixel weight", soft: [0, 1], showIf: (p) => p.mode === 0 || p.mode === 3 },
      { path: "wavelet_color_mode", label: "Color mode", showIf: (p) => (p.mode === 1 || p.mode === 4) && p.use_new_vst === 1 },
      { path: "overshooting", label: "Adjust autoset parameters", soft: [0.001, 4], showIf: (p) => p.mode === 3 || p.mode === 4 },
      { path: "strength", label: "Strength", soft: [0.001, 4], digits: 3 },
      { path: "shadows", label: "Preserve shadows", showIf: (p) => p.use_new_vst === 1 && p.mode !== 3 && p.mode !== 4 },
      { path: "bias", label: "Bias correction", soft: [-10, 10], showIf: (p) => p.use_new_vst === 1 && p.mode !== 3 && p.mode !== 4 },
      // old edits' upgrades, shown only while off
      { path: "fix_anscombe_and_nlmeans_norm", label: "Fix various bugs in algorithm", showIf: (p) => p.fix_anscombe_and_nlmeans_norm === 0 },
      { path: "use_new_vst", label: "Upgrade profiled transform", showIf: (p) => p.use_new_vst === 0 },
    ],
  },
  {
    // highpass.c gui_init. both sliders are "%" over 0-100, so darktable
    // shows them unscaled
    op: "highpass", group: "detail", title: "Highpass",
    fields: [
      { path: "sharpness", label: "Sharpness", unit: "%" },
      { path: "contrast", label: "Contrast boost", unit: "%" },
    ],
  },
  {
    // nlmeans.c gui_init: four sliders, no visibility rules. strength's max
    // is 100000, so its "%" shows it unscaled
    op: "nlmeans", group: "detail", title: "Astrophoto denoise",
    fields: [
      { path: "radius", label: "Patch size", soft: [0, 4], digits: 0 },
      { path: "strength", label: "Strength", soft: [0, 100], unit: "%", digits: 0 },
      { path: "luma", label: "Luma", unit: "%", digits: 0 },
      { path: "chroma", label: "Chroma", unit: "%", digits: 0 },
    ],
  },
  {
    // rawdenoise.c gui_init. left out: the wavelet curves (x and y, behind
    // the all, R, G and B tabs), which need a curve editor
    op: "rawdenoise", group: "detail", title: "Raw denoise",
    fields: [
      { path: "threshold", label: "Noise threshold", soft: [0, 0.1], digits: 3 },
    ],
  },
  {
    // bilateral.cc gui_init: four sliders, no visibility rules
    op: "bilateral", group: "detail", title: "Surface blur",
    fields: [
      { path: "radius", label: "Radius", soft: [1, 30] },
      { path: "red", label: "Red", soft: [0.0001, 0.1], digits: 4 },
      { path: "green", label: "Green", soft: [0.0001, 0.1], digits: 4 },
      { path: "blue", label: "Blue", soft: [0.0001, 0.1], digits: 4 },
    ],
  },
  {
    // atrous.c gui_init: a luma, chroma and edges notebook over the curve
    // graph, then mix. left out: the curves (x and y), which need
    // ContrastEqualizer's graph, and octaves, which has no widget
    op: "atrous", group: "detail", title: "Contrast equalizer",
    fields: [
      { path: "mix", label: "Mix" },
    ],
  },
  {
    // lowpass.c gui_init: five widgets, no visibility rules. left out: order
    // and unbound, which have no widget
    op: "lowpass", group: "detail", title: "Lowpass",
    fields: [
      { path: "radius", label: "Radius" },
      { path: "lowpass_algo", label: "Soften with" },
      { path: "contrast", label: "Contrast" },
      { path: "brightness", label: "Brightness" },
      { path: "saturation", label: "Saturation" },
    ],
  },
  {
    // lens.cc gui_init and gui_changed: the method picks one of three pages
    // (Lensfun, embedded metadata, only the manual vignette), the vignette
    // section is under all three. darktable lists embedded metadata only
    // for a photo that has it, and hides the TCA override for monochrome
    // and the fine-tuning of what a DNG lacks; those rules read the image
    // and are left out. left out too: the camera and lens pickers and the
    // focal length, aperture and distance menus (Simple's Lens Corrections
    // picks the lens), and "use latest algorithm", which is not a param.
    // Simple drives the first instance. gui_changed sets has_been_set on
    // every edit but the method's: until it is on, darktable renders the
    // defaults
    op: "lens", group: "lens", title: "Lens correction",
    touch: { set: [["has_been_set", 1]], except: ["method"] },
    fields: [
      { path: "method", label: "Correction method" },
      { path: "modify_flags", label: "Corrections", showIf: (p) => p.method !== 2 },
      { path: "target_geom", label: "Target geometry", options: [1, 2, 3, 4, 5, 6, 7, 8], showIf: (p) => p.method === 1 },
      { path: "scale", label: "Scale", digits: 3, showIf: (p) => p.method === 1 },
      { path: "inverse", label: "Mode", showIf: (p) => p.method === 1 },
      { path: "tca_override", label: "TCA override", showIf: (p) => p.method === 1 },
      { path: "tca_r", label: "TCA red", digits: 5, showIf: (p) => p.method === 1 && p.tca_override === 1 },
      { path: "tca_b", label: "TCA blue", digits: 5, showIf: (p) => p.method === 1 && p.tca_override === 1 },
      { path: "cor_dist_ft", label: "Distortion", section: "Fine-tuning", digits: 3, showIf: (p) => p.method === 0 },
      { path: "cor_vig_ft", label: "Vignetting", section: "Fine-tuning", digits: 3, showIf: (p) => p.method === 0 },
      // version 2 of the metadata algorithm, md_version 1
      { path: "cor_ca_r_ft", label: "TCA red", section: "Fine-tuning", digits: 3, showIf: (p) => p.method === 0 && p.md_version >= 1 },
      { path: "cor_ca_b_ft", label: "TCA blue", section: "Fine-tuning", digits: 3, showIf: (p) => p.method === 0 && p.md_version >= 1 },
      { path: "scale_md", label: "Image scale", section: "Fine-tuning", digits: 4, showIf: (p) => p.method === 0 },
      { path: "v_strength", label: "Strength", section: "Manual vignette correction", unit: "%", digits: 1 },
      { path: "v_radius", label: "Radius", section: "Manual vignette correction", unit: "%", digits: 1 },
      { path: "v_steepness", label: "Steepness", section: "Manual vignette correction", unit: "%", digits: 1 },
    ],
  },
  {
    // cacorrectrgb.c gui_init: no visibility rules. Simple's Defringe drives
    // the first instance
    op: "cacorrectrgb", group: "lens", title: "Chromatic aberrations",
    fields: [
      { path: "guide_channel", label: "Guide" },
      { path: "radius", label: "Radius" },
      { path: "strength", label: "Strength" },
      { path: "mode", label: "Correction mode", section: "Advanced parameters" },
      { path: "refine_manifolds", label: "Very large chromatic aberration", section: "Advanced parameters" },
    ],
  },
  {
    // cacorrect.c gui_init. darktable shows the two only for bayer raws,
    // a rule that reads the image and is left out
    op: "cacorrect", group: "lens", title: "Raw chromatic aberrations",
    fields: [
      { path: "iterations", label: "Iterations" },
      { path: "avoidshift", label: "Avoid colorshift" },
    ],
  },
  {
    // hotpixels.c gui_init, for raws only (a rule that reads the image).
    // left out: the count of pixels fixed beside the mark toggle. Simple's
    // Hot Pixels drives it, with the sliders times 100
    op: "hotpixels", group: "lens", title: "Hot pixels",
    fields: [
      { path: "threshold", label: "Threshold", digits: 4 },
      { path: "strength", label: "Strength", digits: 4 },
      { path: "permissive", label: "Detect by 3 neighbors" },
      { path: "markfixed", label: "Mark fixed pixels" },
    ],
  },
  {
    // ashift.c gui_init and gui_changed: rotation and the crop mode, then the
    // manual perspective section, whose lens model, focal length and crop
    // factor show for the specific model only. gui_changed refits the crop
    // box (do_crop) on every edit; derive does that with Simple's autoCrop,
    // which fits the photo's own aspect (darktable's "original format") and
    // knows no shear or lens model, so the card leaves out the automatic
    // cropping menu, shear and the lens model and sets Simple's: the
    // specific model at 28 mm, crop factor 1 and no lens dependence renders
    // as generic does and applies the aspect adjust. darktable names the
    // lens shifts the other way round for a photo turned a quarter, a rule
    // that reads the image. left out too: lens dependence (hidden in
    // darktable), the structure and fit buttons (Simple's Upright) and the
    // crop box and drawn lines. Simple's Transform panel drives the module
    op: "ashift", group: "transform", title: "Rotate and perspective",
    touch: { set: [["mode", 1], ["f_length", 28], ["crop_factor", 1], ["orthocorr", 0]] },
    derive: (p, size) => autoCrop(p.rotation, p.lensshift_v, p.lensshift_h, size.width, size.height, p.aspect),
    fields: [
      { path: "rotation", label: "Rotation", soft: [-10, 10], factor: -1, unit: "°" },
      { path: "lensshift_v", label: "Lens shift (vertical)", section: "Manual perspective", soft: [-1, 1], digits: 3 },
      { path: "lensshift_h", label: "Lens shift (horizontal)", section: "Manual perspective", soft: [-1, 1], digits: 3 },
      { path: "aspect", label: "Aspect adjust", section: "Manual perspective" },
    ],
  },
  {
    // flip.c gui_init: a reset label and four buttons, which set the
    // orientation; it is not a slider. the buttons run the toolbar's turn,
    // whose crop and mask shapes turn too
    op: "flip", group: "transform", title: "Orientation",
    turns: [
      { label: "Rotate 90 degrees CCW", how: "ccw" },
      { label: "Rotate 90 degrees CW", how: "cw" },
      { label: "Flip horizontally", how: "h" },
      { label: "Flip vertically", how: "v" },
    ],
    fields: [],
  },
  {
    // scalepixels.c gui_init, its one slider
    op: "scalepixels", group: "transform", title: "Scale pixels",
    fields: [
      { path: "pixel_aspect_ratio", label: "Pixel aspect ratio" },
    ],
  },
  {
    // enlargecanvas.c gui_init; "%" over a 0-100 range keeps the value as
    // it is. the color enum's count has no description and is not offered
    op: "enlargecanvas", group: "transform", title: "Enlarge canvas",
    fields: [
      { path: "percent_left", label: "Percent left", unit: "%" },
      { path: "percent_right", label: "Percent right", unit: "%" },
      { path: "percent_top", label: "Percent top", unit: "%" },
      { path: "percent_bottom", label: "Percent bottom", unit: "%" },
      { path: "color", label: "Color", options: [0, 1, 2, 3, 4] },
    ],
  },
  {
    // vignette.c gui_init (four sliders, a "position / form" section, then center, shape,
    // automatic ratio, ratio and dithering); gui_changed/gui_update only grey out the
    // ratio slider while autoratio is on (insensitive, not hidden), so there is no showIf
    // omitted: unbound (no widget)
    op: "vignette", group: "effects", title: "Vignetting",
    fields: [
      { path: "scale", label: "Fall-off start", unit: "%" },
      { path: "falloff_scale", label: "Fall-off radius", unit: "%" },
      { path: "brightness", label: "Brightness", digits: 3 },
      { path: "saturation", label: "Saturation", digits: 3 },
      { path: "center.x", label: "Horizontal center", section: "Position / form", digits: 3 },
      { path: "center.y", label: "Vertical center", section: "Position / form", digits: 3 },
      { path: "shape", label: "Shape", section: "Position / form" },
      { path: "autoratio", label: "Automatic ratio", section: "Position / form" },
      { path: "whratio", label: "Width/height ratio", section: "Position / form", digits: 3 },
      { path: "dithering", label: "Dithering", section: "Position / form" },
    ],
  },
  {
    // grain.c gui_init; the slider shows scale * GRAIN_SCALE_FACTOR (213.2) as ISO, 0 digits
    // omitted: channel (the enum has no widget in gui_init, it keeps its default)
    op: "grain", group: "effects", title: "Grain",
    fields: [
      { path: "scale", label: "Coarseness", factor: 213.2, unit: "ISO", digits: 0 },
      { path: "strength", label: "Strength", unit: "%" },
      { path: "midtones_bias", label: "Mid-tones bias", unit: "%" },
    ],
  },
  {
    // bloom.c gui_init
    op: "bloom", group: "effects", title: "Bloom",
    fields: [
      { path: "size", label: "Size", unit: "%" },
      { path: "threshold", label: "Threshold", unit: "%" },
      { path: "strength", label: "Strength", unit: "%" },
    ],
  },
  {
    // soften.c gui_init
    op: "soften", group: "effects", title: "Soften",
    fields: [
      { path: "size", label: "Size", unit: "%" },
      { path: "saturation", label: "Saturation", unit: "%" },
      { path: "brightness", label: "Brightness", unit: "EV" },
      { path: "amount", label: "Mix", unit: "%" },
    ],
  },
  {
    // blurs.c gui_init and gui_changed (the type combobox picks which sliders show; the
    // kernel preview drawing area above the sliders is not a param and is omitted)
    // radius has a soft max of 64 because run time grows with its square (gui_init comment)
    // rotation and angle display radians as degrees (RAD_2_DEG; angle is negated)
    op: "blurs", group: "effects", title: "Blurs",
    fields: [
      { path: "radius", label: "Blur radius", soft: [4, 64], unit: "px" },
      { path: "type", label: "Blur type" },
      { path: "blades", label: "Diaphragm blades", showIf: (p) => p.type === 0 },
      { path: "concavity", label: "Concavity", showIf: (p) => p.type === 0 },
      { path: "linearity", label: "Linearity", showIf: (p) => p.type === 0 },
      { path: "rotation", label: "Rotation", factor: 180 / Math.PI, unit: "°", showIf: (p) => p.type === 0 },
      { path: "angle", label: "Direction", factor: -180 / Math.PI, unit: "°", showIf: (p) => p.type === 1 },
      { path: "curvature", label: "Curvature", showIf: (p) => p.type === 1 },
      { path: "offset", label: "Offset", showIf: (p) => p.type === 1 },
    ],
  },
  {
    // lowlight.c gui_init: a custom curve graph, then the blueness slider
    // omitted: transition_x[6] and transition_y[6] (the graph's curve nodes; needs a custom
    // curve editor)
    op: "lowlight", group: "effects", title: "Lowlight vision",
    fields: [
      { path: "blueness", label: "Blue shift", unit: "%" },
    ],
  },
  {
    // graduatednd.c gui_init; gui_changed only redraws the line/saturation gradient
    // rotation is negated (factor -1) and hue shows 0..1 as degrees (factor 360)
    // not params (omitted): the on-canvas line (drag to define position and rotation),
    // the hue slider's color picker button
    // offset has no widget (set only by dragging the line on the canvas)
    op: "graduatednd", group: "effects", title: "Graduated density",
    fields: [
      { path: "density", label: "Density", unit: "EV" },
      { path: "hardness", label: "Hardness", unit: "%" },
      { path: "rotation", label: "Rotation", factor: -1, unit: "°" },
      { path: "hue", label: "Hue", factor: 360, unit: "°" },
      { path: "saturation", label: "Saturation", unit: "%" },
    ],
  },
  {
    // censorize.c gui_init: four plain sliders, no units or digits set
    op: "censorize", group: "effects", title: "Censorize",
    fields: [
      { path: "radius_1", label: "Input blur radius" },
      { path: "pixelate", label: "Pixelization radius" },
      { path: "radius_2", label: "Output blur radius" },
      { path: "noise", label: "Noise level" },
    ],
  },
  {
    // borders.c gui_init and gui_changed
    // the aspect, horizontal position and vertical position comboboxes are presets (not
    // params): picking one writes aspect / pos_h / pos_v and moves the slider below it
    // (_aspect_changed, _position_h_changed, _position_v_changed); gui_changed moves the
    // combobox back to the matching preset, or to "custom...", when the slider is edited;
    // the aspect_text, pos_h_text and pos_v_text char arrays have no widget of their own;
    // the frame line widgets are greyed out (not hidden) unless size > 0 and 0 < pos_h < 1
    // and 0 < pos_v < 1, so there is no showIf
    // omitted: color[3] and frame_color[3] (color buttons with image pickers; need a color
    // picker), max_border_size (no widget)
    op: "borders", group: "effects", title: "Framing",
    fields: [
      { path: "basis", label: "Basis" },
      { path: "size", label: "Border size", unit: "%", digits: 4 },
      { path: "aspect", label: "Aspect ratio" },
      { path: "aspect_orient", label: "Orientation" },
      { path: "pos_h", label: "Horizontal offset" },
      { path: "pos_v", label: "Vertical offset" },
      { path: "frame_size", label: "Frame line size", unit: "%", digits: 4 },
      { path: "frame_offset", label: "Frame line offset", unit: "%", digits: 4 },
    ],
  },
  {
    // watermark.c gui_init and gui_changed: a marker/text/font/color grid, then opacity, a
    // "placement" section (rotate, scale, scale on, 3x3 alignment grid, offsets); the two
    // advanced scale combos only show for scale_base "advanced options" (gui_changed)
    // rotate displays negated (factor -1); scale has a soft max of 100
    // omitted: filename (marker file chooser with a refresh button), text (entry), font
    // (font button), color[3] (color button and picker), alignment (int param edited by a 3x3
    // toggle grid, needs a custom editor)
    op: "watermark", group: "effects", title: "Watermark",
    fields: [
      { path: "opacity", label: "Opacity", unit: "%" },
      { path: "rotate", label: "Rotation", section: "Placement", factor: -1, unit: "°" },
      { path: "scale", label: "Scale", section: "Placement", soft: [1, 100], unit: "%" },
      { path: "scale_base", label: "Scale on", section: "Placement" },
      { path: "scale_img", label: "Scale marker to", section: "Placement", showIf: (p) => p.scale_base === 4 },
      { path: "scale_svg", label: "Scale marker reference", section: "Placement", showIf: (p) => p.scale_base === 4 },
      { path: "xoffset", label: "X offset", section: "Placement", digits: 3 },
      { path: "yoffset", label: "Y offset", section: "Placement", digits: 3 },
    ],
  },
  {
    // overlay.c gui_init and gui_changed: a source-photo drop area, then opacity, a
    // "placement" section (rotate, scale, scale on, 3x3 alignment grid, offsets); the two
    // advanced scale combos only show for scale_base "advanced options" (gui_changed)
    // rotate displays negated (factor -1); scale has a soft max of 100
    // omitted: imgid and filename (set by dropping a photo on the thumbnail area), alignment
    // (int param edited by a 3x3 toggle grid, needs a custom editor), compositing (no widget)
    op: "overlay", group: "effects", title: "Composite",
    fields: [
      { path: "opacity", label: "Opacity", unit: "%" },
      { path: "rotate", label: "Rotation", section: "Placement", factor: -1, unit: "°" },
      { path: "scale", label: "Scale", section: "Placement", soft: [1, 100], unit: "%" },
      { path: "scale_base", label: "Scale on", section: "Placement" },
      { path: "scale_img", label: "Scale marker to", section: "Placement", showIf: (p) => p.scale_base === 4 },
      { path: "scale_svg", label: "Scale marker reference", section: "Placement", showIf: (p) => p.scale_base === 4 },
      { path: "xoffset", label: "X offset", section: "Placement", digits: 3 },
      { path: "yoffset", label: "Y offset", section: "Placement", digits: 3 },
    ],
  },
  {
    // dither.c gui_init and gui_changed: damping is added first, then the method combobox;
    // damping is only visible for the random method (value 0)
    // omitted: palette, random.radius, random.range[4] (their widgets are under #if 0)
    op: "dither", group: "effects", title: "Dither or posterize",
    fields: [
      { path: "random.damping", label: "Damping", unit: "dB", digits: 3, showIf: (p) => p.dither_type === 0 },
      { path: "dither_type", label: "Method" },
    ],
  },
  {
    // rawprepare.c gui_init: four black levels (labels from
    // dt_bauhaus_widget_set_label), the white point, flat field correction
    // image-dependent, not on the card: a monochrome sensor shows only black
    // level 0 and an sRaw hides black level 3 (gui_update); flat field shows
    // only when the photo has gain maps; a non-raw photo shows a note instead
    // left out: the crop margins, which gui_init adds only with the preference
    // plugins/darkroom/rawprepare/allow_editing_crop (off by default)
    op: "rawprepare", group: "technical", title: "Raw black/white point",
    fields: [
      { path: "raw_black_level_separate[0]", label: "Black level 0", soft: [0, 16384] },
      { path: "raw_black_level_separate[1]", label: "Black level 1", soft: [0, 16384] },
      { path: "raw_black_level_separate[2]", label: "Black level 2", soft: [0, 16384] },
      { path: "raw_black_level_separate[3]", label: "Black level 3", soft: [0, 16384] },
      { path: "raw_white_point", label: "White point", soft: [0, 16384] },
      { path: "flat_field", label: "Flat field correction" },
    ],
  },
  {
    // colorreconstruction.c gui_init and gui_changed/gui_update (hue is shown
    // only for the hue precedence); labels are the schema descriptions where
    // set (spatial extent, range extent), else the param name
    // image-dependent (not modeled): for monochrome images the card shows only
    // "not applicable" and hides the enable button
    // hue is drawn as a rainbow slider shown in degrees (factor 360)
    op: "colorreconstruct", group: "technical", title: "Color reconstruction",
    fields: [
      { path: "threshold", label: "Threshold" },
      { path: "spatial", label: "Spatial extent" },
      { path: "range", label: "Range extent" },
      { path: "precedence", label: "Precedence" },
      { path: "hue", label: "Hue", factor: 360, unit: "°", showIf: (p) => p.precedence === 2 },
    ],
  },
];

export const layoutFor = (op: string, group: string) => LAYOUTS.find((l) => l.op === op && l.group === group);

// whether a group's card for `op` shows instance `i`: a named card only its
// instance, the others every instance no named card claims
export function shows(l: ModuleLayout, i: { op: string; name: string; hand_edited: boolean }) {
  const named = (n: string) => i.hand_edited && i.name === n;
  return l.instance ? named(l.instance.name) : !LAYOUTS.some((o) => o.op === i.op && o.instance && named(o.instance.name));
}

// a group's cards sit in LAYOUTS order (Simple's sections), not pipe order
export const layoutRank = (op: string, group: string) => LAYOUTS.findIndex((l) => l.op === op && l.group === group);
export const groupLayouts = (group: string) => LAYOUTS.filter((l) => l.group === group);

// the schema field a layout path reads: "red[2]" is an element of array "red"
export const fieldPath = (path: string) => path.replace(/\[\d+\]$/, "");
