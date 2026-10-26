// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Lightroom-style panels, in Lightroom's order, and how their controls map
// onto darktable modules. this file, not darktable, decides names, order and
// visibility.
//
// a ModuleMap translates between control values and one module's params,
// both ways. several maps may share a module (color balance rgb serves Basic
// and Color Grading); their params are merged into one edit. a control
// resets to `neutral` when it has one, else to what its module's own
// defaults for this image read back as, so Temp resets to "as shot"

import type { LucideIcon } from "lucide-react";
import { Contrast, Sun } from "lucide-react";
import { localIlluminant, readLocalIlluminant, readWB, writeWB, ILLUMINANT_CUSTOM, TEMP_MAX, TEMP_MIN } from "./wb";
import { channelPointsFromLinear, channelPointsToLinear, fromParams as readCurve, isIdentity, MAX_NODES,
         nodeFields, paramsToPoints, pointsToParams, toParams as writeCurve, type Parametric,
         type Point } from "./tonecurve";
import { autoCrop } from "./transform";
import { fromNodes, toNodes } from "./colorequal";
import { cbHueTrack, displayHue } from "./colorgrading";
import { PLACE_BOOST, PLACE_FIELDS, PLACE_FIRST, PLACE_MAX, PLACEMENT_OP, ROMAN, ZONE_GRAY,
         placeIds } from "./zones";

export type Values = Record<string, number>;
export type Params = Record<string, number>;

// what geometry mappings need to know about the open image. ashift works on
// the sensor frame before flip; orientation is darktable's
// dt_image_orientation_t bits (flip y 1, flip x 2, swap xy 4); camera is
// the one the camera recorded, which flip's -1 stands for
export type ImageContext = { sensorWidth: number; sensorHeight: number; orientation: number; camera: number };

const swapsAxes = (ctx: ImageContext) => (ctx.orientation & 4) !== 0;
// an odd number of reflections mirrors the image, which reverses a rotation
const mirrored = (ctx: ImageContext) =>
  ((ctx.orientation & 1) + ((ctx.orientation >> 1) & 1) + ((ctx.orientation >> 2) & 1)) % 2 === 1;
const displayed = (ctx: ImageContext) => swapsAxes(ctx)
  ? { w: ctx.sensorHeight, h: ctx.sensorWidth } : { w: ctx.sensorWidth, h: ctx.sensorHeight };

export type Control = {
  id: string;
  label: string;
  kind?: "slider" | "toggle" | "choice";
  // a choice's options, shown as a segmented control: [label, value]
  options?: [string, number][];
  // a choice's options as their buttons show them, when shorter
  optionLabels?: Record<number, string>;
  optionIcons?: Record<number, LucideIcon>;
  // the control sits beside its label on one row (Treatment)
  inline?: boolean;
  // a choice too long for a row of pills, as a drop-down
  menu?: boolean;
  // the drop-down's options under headings, in place of `options`
  optionGroups?: [string, [string, number][]][];
  // needs the raw's detail mask (darktable makes it in demosaic)
  rawOnly?: boolean;
  // what ⌥-dragging it shows, as Lightroom's sharpening sliders do: the
  // module's mask, or the photo in grayscale
  optionPreview?: "mask" | "gray";
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  neutral?: number;
  note?: string;     // tooltip, e.g. a known limitation
  // CSS background for the slider track, showing what moving the slider
  // does; a function when it follows other sliders (Color Grading's hue)
  track?: string | ((v: Values) => string);
  // a non-linear track: the input works in positions, the value is derived
  slider?: { min: number; max: number; step: number; toPos: (v: number) => number;
             fromPos: (p: number) => number };
  // read back past min and max rather than clamped: an HSL band set in
  // darktable or by an older Immage reads as a mix of sliders
  // (colorequal.ts), and clamping one would change the photo's other
  // colors at the next edit
  readsPast?: boolean;
};

export type ModuleMap = {
  op: string;
  controls: string[];
  fields: string[];
  // darktable keeps this module on for every image (exposure, the tone
  // mapper, color calibration); any other is on only while a control is moved
  keepOn: boolean;
  // `v`, when the session reads a photo, holds the values read so far from
  // the maps ahead of this one
  read: (p: Params, defaults: Params, ctx: ImageContext, v?: Values) => Values;
  write: (v: Values, defaults: Params, ctx: ImageContext) => Params;
  // overrides "on while moved", for a switch such as Enable Profile Corrections
  enabled?: (v: Values) => boolean;
  // one of a tool's modules (MODULE_CHOICES): on only while the photo's
  // choice control holds this value. an unchosen map is written with its
  // controls at neutral, so it adds nothing to a module other maps share
  choice?: { control: string; value: number };
  // overrides `choice` for when the map is on, as color balance rgb's
  // Saturation is for a photo on sigmoid, which has none of its own
  active?: (v: Values) => boolean;
  // the module is moved to run after this one, if it runs earlier
  after?: string;
  // or before this one, if it runs later
  before?: string;
  // reads the orientation. a "sensor" module runs ahead of flip, so a turn
  // keeps its params and reads them again; a "shown" one runs after it, so
  // a turn writes its values again for the new frame
  frame?: "sensor" | "shown";
  // a local map whose masks share instances (localMerge.ts) rather than
  // each running the module on an instance of its own
  merge?: boolean;
  // the controls of a merged map that a mask's strength cannot scale (a
  // hue, a pivot): masks share an instance only when these are equal
  fixed?: string[];
};

export type ControlPreset = { label: string; values: Values; swatch?: string };
// a section's presets show under its heading, as a panel's do above them
export type Section = {
  title: string; controls: Control[]; presets?: ControlPreset[];
  // sections sharing a group fold together under its name, each in its
  // own box headed by `subtitle` (or its title)
  group?: string; subtitle?: string; tag?: string;
};
export type Panel = {
  id: string;
  title: string;
  sections: Section[];
  tabs?: boolean;          // sections are shown one at a time
  hidden?: boolean;        // edited by a tool rather than listed (crop)
  // shown only for these values (the B&W Mix stands in for HSL in black and white)
  showIf?: (v: Values) => boolean;
  // buttons that set several controls at once, such as the B&W filters
  // a preset with a swatch shows as a colored circle, its label as a tooltip
  presets?: ControlPreset[];
  // a drawing above the controls, or for color grading, wheels that can
  // stand in for its sliders
  graph?: "tonecurve" | "colorwheels" | "zones";
};

const signed = (digits: number, unit = "") => (v: number) =>
  `${v > 0 && Math.abs(v) >= 0.5 * 10 ** -digits ? "+" : ""}${v.toFixed(digits)}${unit}`;
const plain = (digits: number, unit = "") => (v: number) => `${v.toFixed(digits)}${unit}`;

// a Lightroom ±100 slider: 0 is no change, whatever the module's own
// defaults. shadows and highlights defaults to shadows +50 and highlights
// -50, which as the neutral showed every untouched image at -50/+50
const lr = (id: string, label: string, extra: Partial<Control> = {}): Control => ({
  id, label, min: -100, max: 100, step: 1, neutral: 0, format: signed(0), ...extra,
});
const toggle = (id: string, label: string, neutral: number): Control => ({
  id, label, kind: "toggle", min: 0, max: 1, step: 1, neutral, format: (v) => (v ? "on" : "off"),
});

// control value v is `base + v * scale` in the field; base is the image's
// default for that field, or a fixed number
type Linear = { id: string; field: string; scale: number; base: "default" | number };

const linear = (op: string, keepOn: boolean, items: Linear[]): ModuleMap => {
  const base = (i: Linear, d: Params) => (i.base === "default" ? d[i.field] : i.base);
  return {
    op, keepOn,
    controls: items.map((i) => i.id),
    fields: items.map((i) => i.field),
    read: (p, d) => Object.fromEntries(items.map((i) => [i.id, (p[i.field] - base(i, d)) / i.scale])),
    write: (v, d) => Object.fromEntries(items.map((i) => [i.field, base(i, d) + v[i.id] * i.scale])),
  };
};

// Blacks is exposure's black level, subtracted in linear light where
// shadows sit around 0.01, so linear, nearly all of its effect was in the
// first few units. squared, ±100 is still darktable's soft range of ±0.1
// (exposure.c), and 10 is 0.001
export const BLACKS_POWER = 2;
const BLACKS_SCALE = -0.001;
const bend = (v: number, power: number) => 100 * Math.sign(v) * (Math.abs(v) / 100) ** power;

// exposure.c subtracts the black level before the exposure's gain
// ((in - black) / (white - black)), so at +3 EV every Blacks step was 8x
// larger. it is divided by the gain of the Exposure control, so Blacks does
// the same at any exposure
const exposureMap = (keepOn: boolean, exposure: string, blacks: string, base: (d: Params) => Params) => ({
  op: "exposure", keepOn,
  controls: [exposure, blacks],
  fields: ["exposure", "black"],
  read: (p, d) => {
    const b = base(d), ev = p.exposure - b.exposure;
    return { [exposure]: ev, [blacks]: bend(((p.black - b.black) * 2 ** ev) / BLACKS_SCALE, 1 / BLACKS_POWER) };
  },
  write: (v, d) => {
    const b = base(d);
    return { exposure: b.exposure + v[exposure],
             black: b.black + bend(v[blacks], BLACKS_POWER) * BLACKS_SCALE * 2 ** -v[exposure] };
  },
}) satisfies ModuleMap;

// a Blacks value from before the bend, set with Exposure at ev, as the same
// black level
export const blacksFromLinear = (v: number, ev = 0) => bend(v * 2 ** ev, 1 / BLACKS_POWER);

// the engine's name for a module's details threshold (blend params)
export const BLEND_DETAILS = "blend.details";

// denoiseprofile's band curves (denoiseprofile.c): channels Y0 and U0V0
// of y[channel][band], over its 7 bands
const NR_Y0 = 4, NR_U0V0 = 5;
const NR_BANDS = [0, 1, 2, 3, 4, 5, 6];
const nrForce = (v: number) => 0.5 * Math.sqrt(Math.max(0, v) / 50);
const nrRead = (p: Params, ch: number) => {
  const ys = NR_BANDS.map((k) => p[`y[${ch}][${k}]`]).filter(Number.isFinite);
  const y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0.5;
  return Math.round(50 * p.strength * (y / 0.5) ** 2);
};

// ---------------------------------------------------------------- Basic

// Temp moves evenly in mireds, as perceived warmth does, not in kelvin
const MIRED_MIN = 1e6 / TEMP_MAX;
const MIRED_MAX = 1e6 / TEMP_MIN;
const tempControl: Control = {
  id: "temp", label: "Temp", min: TEMP_MIN, max: TEMP_MAX, step: 1,
  format: (v) => `${Math.round(v / 10) * 10}`,
  track: "linear-gradient(90deg, #4f7fd6, #e8e3d0, #e0a640)",
  slider: {
    min: 0, max: 1000, step: 1,
    toPos: (k) => (1000 * (MIRED_MAX - 1e6 / k)) / (MIRED_MAX - MIRED_MIN),
    fromPos: (p) => 1e6 / (MIRED_MAX - (p / 1000) * (MIRED_MAX - MIRED_MIN)),
  },
};

// Whites: the tone mapper's display white target, in stops, so that +100
// brightens the top end by 0.6 EV and -100 dims it by as much
const WHITES_STOPS = 0.6;
// and on AgX, color balance rgb's highlights brilliance, which a mask's
// Whites moves twice as far: the shoulder alone reshapes the top end but
// leaves where AgX clips, and more dims the midtones at -100
const WHITES_BRILLIANCE = 0.002;

// Contrast on the tone mapper: AgX's contrast, or sigmoid's, ±100 doubling
// or halving it from the photo's default
const AGX_CONTRAST_STOPS = 1;
const SIGMOID_CONTRAST_STOPS = 0.5;
// Blacks on AgX: its lift, which the AgX workflow moves the darkest tones
// with. its toe power barely reaches them with the range Auto sets
const AGX_LIFT = 0.2;
// on sigmoid: its display black target, 0.0152% by default; +100 lifts it
// to about 2%, -100 takes it to 0
const SIGMOID_BLACK_LIFT = 2;
const sigmoidBlackWrite = (v: number, d: number) => (v >= 0 ? d + SIGMOID_BLACK_LIFT * (v / 100) ** 2 : d * (1 + v / 100));
const sigmoidBlackRead = (p: number, d: number) =>
  p >= d ? 100 * Math.sqrt((p - d) / SIGMOID_BLACK_LIFT) : 100 * (p / d - 1);

// Highlights and Shadows on the tone equalizer: its nine nodes, -8 EV to
// 0 EV of its mask (toneequal.c), each moved by a share of the slider's EV
const TONE_NODES = ["noise", "ultra_deep_blacks", "deep_blacks", "blacks", "shadows", "midtones",
                    "highlights", "whites", "speculars"];
const TONE_SHADOWS = [0.5, 0.9, 1, 0.6, 0.15, 0, 0, 0, 0];
const TONE_HIGHLIGHTS = [0, 0, 0, 0, 0, 0.3, 0.8, 1, 0.8];
const TONE_EV = 1.5;   // at a slider's full ±100, where its share is 1
// each slider reads back from a node the other leaves alone
const TONE_SHADOWS_NODE = 2, TONE_HIGHLIGHTS_NODE = 7;
const toneNodes = (shadows: number, highlights: number): Params => Object.fromEntries(TONE_NODES.map((f, k) =>
  [f, ((shadows * TONE_SHADOWS[k] + highlights * TONE_HIGHLIGHTS[k]) * TONE_EV) / 100]));
// null for curves these sliders did not draw, such as one made in darktable
const toneRead = (p: Params) => {
  const shadows = (100 * p[TONE_NODES[TONE_SHADOWS_NODE]]) / TONE_EV;
  const highlights = (100 * p[TONE_NODES[TONE_HIGHLIGHTS_NODE]]) / TONE_EV;
  const fit = toneNodes(shadows, highlights);
  return TONE_NODES.every((f) => Math.abs(p[f] - fit[f]) < 1e-3) ? { shadows, highlights } : null;
};
// the mask's exposure compensation, which the AgX workflow sets before the
// nodes: middle gray on the -4 EV node, toneequal.c's contrast fulcrum,
// so the nodes span 4 EV either side of it, a stop each. the equalizer's
// default estimator, the RGB norm, takes a gray as sqrt 3 times its
// luminance. its contrast compensation stays at 0
const TONE_MASK = { exposure_boost: -4 - Math.log2(0.18 * Math.sqrt(3)), contrast_boost: 0 };

// black and white by color calibration: a second instance, after the color
// equalizer so the B&W Mix still finds the hues it lightens or darkens.
// darktable's "monochrome | luminance-based" preset (channelmixerrgb.c):
// no white balance of its own (the pipeline's D50, XYZ), gray from Y
const D50 = [0.34567, 0.3585];
const BW_FIELDS: Params = {
  illuminant: 0, adaptation: 3, x: D50[0], y: D50[1], gamut: 0, clip: 1,
  ...Object.fromEntries(["red", "green", "blue"].flatMap((ch, i) => [0, 1, 2].map((k) => [`${ch}[${k}]`, i === k ? 1 : 0]))),
  ...Object.fromEntries(["saturation", "lightness"].flatMap((ch) => [0, 1, 2].map((k) => [`${ch}[${k}]`, 0]))),
  "grey[0]": 0, "grey[1]": 1, "grey[2]": 0, normalize_grey: 1,
};
// the color equalizer's own black and white: every band desaturated
const desaturated = (p: Params) => BANDS.every(([b]) => Math.abs(p[`sat_${b}`]) < 1e-6);

// local Defringe on chromatic aberrations: 100 is strength 2, so 25 is its
// default 0.5 (cacorrectrgb.c)
const CA_STRENGTH = 2;

// one of a tool's modules (MODULE_CHOICES) for a map of the main panel's,
// which reads back as that choice
const chosen = (m: ModuleMap, control: string, value: number, extra: Partial<ModuleMap> = {}): ModuleMap => ({
  ...m, ...extra, choice: { control, value }, controls: [...m.controls, control],
  read: (p, d, c, v) => ({ ...m.read(p, d, c, v), [control]: value }),
});

// Texture: darktable's "local contrast | fine" diffusion preset
// (diffuse.c), its four speeds scaled by the slider; negative values run the
// diffusion the other way and smooth instead. the preset's 5 iterations run
// as 3 at 5/3 the speed: the frame cannot be told apart and diffuse costs
// 3/5 (measured with benchmarking/bench.py). edits made with 5 read back the same
const TEXTURE_SPEEDS = { first: 0.0065, second: -0.25, third: -0.25, fourth: -0.2774 };
const TEXTURE_PRESET_ITERATIONS = 5;
const TEXTURE_ITERATIONS = 3;
const TEXTURE_FIXED = {
  iterations: TEXTURE_ITERATIONS, radius_center: 0, radius: 3,
  anisotropy_first: 1, anisotropy_second: 1, anisotropy_third: 1, anisotropy_fourth: 1,
  sharpness: 0, regularization: 2.15, variance_threshold: 0.22, threshold: 0,
};
const textureRead = (p: Params) =>
  (100 * p.second * Math.max(1, p.iterations)) / (TEXTURE_SPEEDS.second * TEXTURE_PRESET_ITERATIONS);
const textureWrite = (texture: number) => ({
  ...TEXTURE_FIXED,
  ...Object.fromEntries(Object.entries(TEXTURE_SPEEDS).map(([k, s]) =>
    [k, (s * texture * TEXTURE_PRESET_ITERATIONS) / (100 * TEXTURE_ITERATIONS)])),
});

// Sharpening: darktable's "sharpness | normal" diffusion preset
// (diffuse.c) but for the iterations, radius span and edge sensitivity,
// which the sliders set
const SHARPEN_MAX_ITERATIONS = 5;
const SHARPEN_RADIUS = 3;
const SHARPEN_SENSITIVITY = 2.94;
const SHARPEN_FIXED = {
  radius_center: 0, first: 0.0065, second: -0.25, third: -0.25, fourth: -0.2774,
  anisotropy_first: 1, anisotropy_second: 1, anisotropy_third: 1, anisotropy_fourth: 1,
  sharpness: 0, variance_threshold: 0, threshold: 0,
};
// or darktable's sharpen, an unsharp mask: Amount 0-100 as its amount 0-2,
// so 25 is its default 0.5; Threshold 0-100 as its threshold 0-10
const USM_AMOUNT = 50;
const USM_THRESHOLD = 10;
const USM_RADIUS = 2;

// ------------------------------------------------------- module choices
// a tool darktable can do with more than one module. the photo's choice
// control says which it uses: the module it already has on, or for a tool
// it has not used yet, the one Preferences picks (moduleChoice.ts). each
// option brings its own sliders, and the panels show only the photo's
// Preferences' Default picks each tool's `preferred` module, the one
// darktable's AgX workflow uses (avidandrew.com/agx-workflow.html)
export type ModuleOption = {
  value: number; op: string; name: string;
  preferred: boolean;         // what Preferences' Default picks
  controls: string[];         // its own sliders in the main panel
  localControls: string[];    // and in a mask's
};
// `covers`: the controls whose module the choice decides, where its
// options share the same sliders
export type ModuleChoice = { id: string; label: string; control: string; options: ModuleOption[];
                             covers?: string[] };
const MOD_SHARPEN = 0, MOD_DIFFUSE = 1;
const MOD_TONEEQ = 0, MOD_SHADHI = 1;
// the tone mapper (AgX, or sigmoid on a photo started under it), or another module
const MOD_TM = 0, MOD_CBRGB = 1, MOD_EXPOSURE = 1;
const MOD_BW_CALIBRATION = 0, MOD_BW_EQUALIZER = 1;
const MOD_CA = 0, MOD_DEFRINGE = 1;
const shared = (value: number, op: string, name: string, preferred: boolean): ModuleOption =>
  ({ value, op, name, preferred, controls: [], localControls: [] });
export const MODULE_CHOICES: ModuleChoice[] = [
  {
    id: "contrast", label: "Contrast", control: "mod_contrast", covers: ["contrast"],
    options: [shared(MOD_TM, "agx", "AgX", true), shared(MOD_CBRGB, "colorbalancergb", "color balance rgb", false)],
  },
  {
    id: "tone_regions", label: "Highlights and Shadows", control: "mod_tone",
    covers: ["highlights", "shadows", "l_highlights", "l_shadows"],
    options: [shared(MOD_TONEEQ, "toneequal", "tone equalizer", true),
              shared(MOD_SHADHI, "shadhi", "shadows and highlights", false)],
  },
  {
    id: "blacks", label: "Blacks", control: "mod_blacks", covers: ["blacks"],
    options: [shared(MOD_TM, "agx", "AgX", true), shared(MOD_EXPOSURE, "exposure", "exposure", false)],
  },
  {
    id: "saturation", label: "Saturation", control: "mod_saturation", covers: ["saturation"],
    options: [shared(MOD_TM, "agx", "AgX", true), shared(MOD_CBRGB, "colorbalancergb", "color balance rgb", false)],
  },
  {
    id: "bw", label: "Black & White", control: "mod_bw", covers: ["bw_mode"],
    options: [shared(MOD_BW_CALIBRATION, "channelmixerrgb#bw", "color calibration", true),
              shared(MOD_BW_EQUALIZER, "colorequal", "color equalizer", false)],
  },
  {
    id: "sharpening", label: "Sharpening", control: "mod_sharpening",
    options: [
      { value: MOD_SHARPEN, op: "sharpen", name: "sharpen", preferred: true,
        controls: ["usm_amount", "usm_radius", "usm_threshold"], localControls: ["l_usm"] },
      { value: MOD_DIFFUSE, op: "diffuse#sharpen", name: "diffuse or sharpen", preferred: false,
        controls: ["sharp_amount", "sharp_radius", "sharp_sensitivity"], localControls: ["l_sharpness"] },
    ],
  },
  {
    id: "defringe", label: "Defringe", control: "mod_defringe", covers: ["l_defringe"],
    options: [shared(MOD_CA, "cacorrectrgb", "chromatic aberrations", true),
              shared(MOD_DEFRINGE, "defringe", "defringe", false)],
  },
];
// which modules the photo runs on, the tone mapper's too: its own, not an
// adjustment, so reset, presets and the Before view leave them be
export const isModuleSetting = (id: string) => id === "tm_mode" || MODULE_CHOICES.some((c) => c.control === id);
export const preferredChoice = (c: ModuleChoice) => (c.options.find((o) => o.preferred) ?? c.options[0]).value;
// the controls whose module a choice decides
export const choiceCovers = (c: ModuleChoice) =>
  c.covers ?? c.options.flatMap((o) => [...o.controls, ...o.localControls]);
const optionOf = new Map(MODULE_CHOICES.flatMap((c) => c.options.flatMap((o) =>
  [...o.controls, ...o.localControls].map((id) => [id, { choice: c, option: o }] as const))));
// whether a slider is one of the photo's modules' (or belongs to no choice)
export const choiceShows = (id: string, v: Values) => {
  const at = optionOf.get(id);
  return !at || v[at.choice.control] === at.option.value;
};
export const choiceOn = (m: ModuleMap, v: Values) =>
  m.active ? m.active(v) : !m.choice || v[m.choice.control] === m.choice.value;

// ------------------------------------------------------------ slider tracks

const hsl = (h: number, s = 75, l = 50) => `hsl(${((h % 360) + 360) % 360}, ${s}%, ${l}%)`;
// a hue slider's track: the colors the band moves through
const hueRamp = (h: number, span: number) =>
  `linear-gradient(90deg, ${[-1, -0.5, 0, 0.5, 1].map((k) => hsl(h + k * span)).join(", ")})`;
const satRamp = (h: number) => `linear-gradient(90deg, ${hsl(h, 0)}, ${hsl(h, 45)}, ${hsl(h, 90)})`;
const lumRamp = (h: number) => `linear-gradient(90deg, ${hsl(h, 60, 15)}, ${hsl(h, 60, 50)}, ${hsl(h, 60, 85)})`;
const GLOBAL_SAT_TRACK =
  `linear-gradient(90deg, ${hsl(0, 0)}, ${hsl(200, 35)} 50%, ${hsl(140, 70)} 75%, ${hsl(330, 85)})`;

// ----------------------------------------------------- HSL / Color (colorequal)

// Lightroom's eight bands, with the color equalizer's node names in the
// same order and Lightroom's hue for each (HSL). the nodes sit elsewhere:
// each slider sets a mix of them (colorequal.ts)
export const BANDS: [string, string, number][] = [
  ["red", "Red", 0], ["orange", "Orange", 30], ["yellow", "Yellow", 60], ["green", "Green", 120],
  ["cyan", "Aqua", 180], ["blue", "Blue", 240], ["lavender", "Purple", 270], ["magenta", "Magenta", 300],
];
// Lightroom's ±100 as ±30° of hue, and as the node's saturation and
// brightness factors. colorequal.c doubles a saturation factor's distance
// from 1 (SAT_EFFECT), so -100 is 0.5, exactly gray; 0.01 made -50 gray
// already and -100 gray a wide hue range around it. brightness changes by
// 8 × the pixel's saturation × the factor's distance from 1
// (BRIGHT_EFFECT): at 0.0025 -100 takes a saturated red down about 2 EV,
// where 0.005 turned it black
const HSL_HUE_DEG = 0.3;
const HSL_SAT = 0.005;
const HSL_LUM = 0.0025;
// the B&W Mix's ±100 as a brightness factor of 2^±0.5: at 2^±1, -100
// turned a saturated red black, as Luminance did
const BW_SCALE = 200;

const HSL_IDS = BANDS.flatMap(([b]) => [`hsl_hue_${b}`, `hsl_sat_${b}`, `hsl_lum_${b}`]);
// one tab's eight sliders, "hsl" for the main panel's and "l_hsl" for a mask's
export const HSL_TABS = ["Hue", "Saturation", "Luminance"] as const;
export const hslControls = (prefix: string, t: typeof HSL_TABS[number]): Control[] =>
  BANDS.map(([band, label, h]) =>
    lr(`${prefix}_${t === "Hue" ? "hue" : t === "Saturation" ? "sat" : "lum"}_${band}`, label, {
      track: t === "Hue" ? hueRamp(h, 100 * HSL_HUE_DEG) : t === "Saturation" ? satRamp(h) : lumRamp(h),
      readsPast: true,
    }));
const BW_IDS = BANDS.map(([b]) => `bw_${b}`);

// the sliders' effects on one of the color equalizer's per-band fields
// (hue, sat, bright), red to magenta, and back
const nodesOf = (p: Params, field: string, base: number) => fromNodes(BANDS.map(([b]) => p[`${field}_${b}`] - base));
const fieldsOf = (field: string, base: number, effects: number[]): [string, number][] =>
  toNodes(effects).map((x, k) => [`${field}_${BANDS[k][0]}`, base + x]);
// HSL sliders, the main panel's ("hsl") or a mask's ("l_hsl"), as the
// color equalizer's params and back
const writeHSL = (prefix: string, v: Values): Params => Object.fromEntries([
  ...fieldsOf("hue", 0, BANDS.map(([b]) => v[`${prefix}_hue_${b}`] * HSL_HUE_DEG)),
  ...fieldsOf("sat", 1, BANDS.map(([b]) => v[`${prefix}_sat_${b}`] * HSL_SAT)),
  ...fieldsOf("bright", 1, BANDS.map(([b]) => v[`${prefix}_lum_${b}`] * HSL_LUM)),
]);
const readHSL = (prefix: string, p: Params): Values => {
  const hue = nodesOf(p, "hue", 0), sat = nodesOf(p, "sat", 1), lum = nodesOf(p, "bright", 1);
  return Object.fromEntries(BANDS.flatMap(([b], k) => [[`${prefix}_hue_${b}`, hue[k] / HSL_HUE_DEG],
    [`${prefix}_sat_${b}`, sat[k] / HSL_SAT], [`${prefix}_lum_${b}`, lum[k] / HSL_LUM]]));
};

// the classic contrast filters of black and white film, as B&W Mix
// settings: a filter lightens its own color and darkens its complement.
// doubled when BW_SCALE halved the mix's strength
const BW_FILTERS: [string, string, number[]][] = [
  // red, orange, yellow, green, aqua, blue, purple, magenta
  ["None", "linear-gradient(135deg, #eee 50%, #222 50%)", [0, 0, 0, 0, 0, 0, 0, 0]],
  ["Red", "#e5484d", [80, 60, 20, -40, -60, -80, -40, 20]],
  ["Orange", "#f08c2e", [60, 80, 40, -20, -60, -80, -60, 0]],
  ["Yellow", "#f5c518", [20, 40, 60, 20, -20, -60, -40, 0]],
  ["Green", "#46a758", [-60, -20, 20, 80, 20, -20, -20, -40]],
  ["Blue", "#3e7bfa", [-60, -60, -40, -20, 40, 80, 40, 0]],
];

// ------------------------------------------ Color Grading (color balance rgb)

export const RANGES: [string, string][] = [
  ["shadows", "Shadows"], ["midtones", "Midtones"], ["highlights", "Highlights"], ["global", "Global"],
];

const CG_CHROMA = 0.002;   // saturation 100 -> chroma 0.2, already a strong split tone
const CG_LUMA = 0.005;     // luminance ±100 -> ±0.5
// one range's sliders, "cg" for the main panel's and "l_cg" for a mask's
const gradingControls = (prefix: string, r: string): Control[] => [
  { id: `${prefix}_${r}_hue`, label: "Hue", min: 0, max: 359, step: 1, format: plain(0, "°"), track: cbHueTrack() },
  { id: `${prefix}_${r}_sat`, label: "Saturation", min: 0, max: 100, step: 1, format: plain(0),
    track: (v: Values) => `linear-gradient(90deg, ${hsl(displayHue(v[`${prefix}_${r}_hue`] ?? 0), 0)}, ${hsl(displayHue(v[`${prefix}_${r}_hue`] ?? 0), 90)})` },
  lr(`${prefix}_${r}_lum`, "Luminance", { track: "linear-gradient(90deg, #111, #777, #eee)" }),
];
const gradingFields = (prefix: string): Linear[] => RANGES.flatMap(([r]) => [
  { id: `${prefix}_${r}_hue`, field: `${r}_H`, scale: 1, base: 0 },
  { id: `${prefix}_${r}_sat`, field: `${r}_C`, scale: CG_CHROMA, base: 0 },
  { id: `${prefix}_${r}_lum`, field: `${r}_Y`, scale: CG_LUMA, base: 0 },
]);

// the Profile: AgX's own presets, or darktable's "basic colorfulness"
// presets of color balance rgb (colorbalancergb.c, init_presets), on an
// instance of their own so Saturation still starts at 0. saturation_formula
// 0 is JzAzBz, 1 darktable UCS
const PROFILE_FIELDS = ["saturation_formula", "chroma_global", "saturation_global",
                        "saturation_shadows", "saturation_midtones", "saturation_highlights"] as const;
export const PROFILES: { value: number; label: string; params: number[] }[] = [
  { value: 1, label: "Standard", params: [1, 0, 0.2, 0.25, 0, -0.25] },
  { value: 2, label: "Natural Skin", params: [1, 0, 0.2, 0.3, 0, -0.5] },
  { value: 3, label: "Vibrant Colors", params: [1, 0, 0.2, 0.5, 0, -0.25] },
  { value: 4, label: "Legacy", params: [0, 0.2, 0, 0.1, 0.05, -0.05] },
];

// AgX's presets (agx.c, init_presets): its primaries, which set how colors
// move toward white as they brighten, and its look and curve. 0 is the
// scene-referred default, darktable's own defaults for AgX, which adds
// nothing; on a photo on sigmoid it is no profile at all
const AGX_PRIMARY_FIELDS = ["base_primaries", "disable_primaries_adjustments", "completely_reverse_primaries",
  "red_inset", "green_inset", "blue_inset", "red_rotation", "green_rotation", "blue_rotation",
  "master_outset_ratio", "master_unrotation_ratio", "red_outset", "green_outset", "blue_outset",
  "red_unrotation", "green_unrotation", "blue_unrotation"];
// the fields a profile sets that no slider moves, which say which it is
const AGX_LOOK_FIELDS = ["look_brightness", "look_original_hue_mix_ratio", "curve_gamma", "curve_toe_power"];
// and those the sliders move from the profile's value: Contrast, Whites, Saturation
const AGX_SLIDER_FIELDS = ["curve_contrast_around_pivot", "curve_shoulder_power", "look_saturation"];
const AGX_REC2020 = 2, AGX_WORK_PROFILE = 1;
const rad = (deg: number) => (deg * Math.PI) / 180;
const agxPrimaries = (base: number, inset: number[], rotation: number[], outsetRatio: number,
                      unrotationRatio: number, outset: number[]): Params => ({
  base_primaries: base, disable_primaries_adjustments: 0, completely_reverse_primaries: 0,
  red_inset: inset[0], green_inset: inset[1], blue_inset: inset[2],
  red_rotation: rotation[0], green_rotation: rotation[1], blue_rotation: rotation[2],
  master_outset_ratio: outsetRatio, master_unrotation_ratio: unrotationRatio,
  red_outset: outset[0], green_outset: outset[1], blue_outset: outset[2],
  red_unrotation: rotation[0], green_unrotation: rotation[1], blue_unrotation: rotation[2],
});
const BLENDER_PRIMARIES = agxPrimaries(AGX_REC2020, [0.29462451, 0.25861925, 0.14641371],
  [0.03540329, -0.02108586, -0.06305724], 1, 0, [0.290776401758, 0.263155400753, 0.045810721815]);
const UNMODIFIED_PRIMARIES = { ...agxPrimaries(AGX_REC2020, [0, 0, 0], [0, 0, 0], 1, 1, [0, 0, 0]),
                               red_unrotation: 0, green_unrotation: 0, blue_unrotation: 0 };
const SMOOTH_PRIMARIES = agxPrimaries(AGX_WORK_PROFILE, [0.1, 0.1, 0.15], [rad(2), rad(-1), rad(-3)], 0, 1,
  [0.1, 0.1, 0.15]);
const AGX_LOOK: Params = { look_brightness: 1, look_original_hue_mix_ratio: 0.6, curve_gamma: 2.2, curve_toe_power: 1.5,
                           curve_contrast_around_pivot: 3, curve_shoulder_power: 3.3, look_saturation: 1 };
// Blender's contrast of 2.4 at its gamma of 2.4, as agx.c compensates it to
// the curve's gamma of 2.2 (_set_blenderlike_params)
const BLENDER_LOOK = { ...AGX_LOOK, curve_gamma: 2.4, curve_toe_power: 1.5, curve_shoulder_power: 1.5,
                       curve_contrast_around_pivot: 2.4535247 };
export const AGX_PROFILE_DEFAULT = 0;
export const AGX_PROFILES: { value: number; label: string; params: Params }[] = [
  { value: AGX_PROFILE_DEFAULT, label: "AgX Default", params: { ...AGX_LOOK, ...BLENDER_PRIMARIES } },
  { value: 11, label: "Unmodified Primaries", params: { ...AGX_LOOK, ...UNMODIFIED_PRIMARIES } },
  { value: 12, label: "Blender", params: { ...BLENDER_LOOK, ...BLENDER_PRIMARIES } },
  // Blender's punchy look: power 1.35 as darktable's brightness, more saturation
  { value: 13, label: "Blender Punchy",
    params: { ...BLENDER_LOOK, ...BLENDER_PRIMARIES, look_brightness: 1 / 1.35 ** 2, look_saturation: 1.4 } },
  { value: 14, label: "Sigmoid-like",
    params: { ...AGX_LOOK, ...BLENDER_PRIMARIES, look_original_hue_mix_ratio: 1, curve_contrast_around_pivot: 3.07,
              curve_toe_power: 1.4, curve_shoulder_power: 3.71 } },
  { value: 15, label: "Sigmoid-like Smooth",
    params: { ...AGX_LOOK, ...SMOOTH_PRIMARIES, look_original_hue_mix_ratio: 0, curve_contrast_around_pivot: 2.98,
              curve_toe_power: 1.61, curve_shoulder_power: 3.02 } },
  { value: 16, label: "Smooth", params: { ...AGX_LOOK, ...SMOOTH_PRIMARIES } },
];
const AGX_PROFILE_FIELDS = [...AGX_PRIMARY_FIELDS, ...AGX_LOOK_FIELDS, ...AGX_SLIDER_FIELDS];
// a slider's field under the photo's profile: AgX's, or the image's
// default for a color balance rgb profile, which leaves AgX at its own
const agxBase = (field: string, v: Values | undefined, d: Params) =>
  AGX_PROFILES.find((pr) => pr.value === v?.profile && pr.value !== AGX_PROFILE_DEFAULT)?.params[field] ?? d[field];

// the Profile menu: AgX's, then color balance rgb's
export const PROFILE_GROUPS: [string, [string, number][]][] = [
  ["AgX", AGX_PROFILES.map((p) => [p.label, p.value])],
  ["Color Balance RGB", PROFILES.map((p) => [p.label, p.value])],
];
export const PROFILE_OPTIONS: [string, number][] = PROFILE_GROUPS.flatMap(([, o]) => o);
export const profileLabel = (v: number) => PROFILE_OPTIONS.find(([, x]) => x === v)?.[0] ?? "AgX Default";

// ------------------------------------------------- Transform (ashift)

// Lightroom's -Vertical widens the top and -Horizontal the left side;
// ashift's negative lens shift narrows them, in the sensor frame, so the
// signs flip, and again for each flip of the axis the shift lands on
// (measured on a grid, build/spike: orientations 0, 5 and 6)
const keystoneSigns = (ctx: ImageContext): [number, number] => {
  const o = ctx.orientation, swap = (o & 4) !== 0, fy = (o & 1) !== 0, fx = (o & 2) !== 0;
  return [(swap ? fx : fy) ? 1 : -1, (swap ? fy : fx) ? 1 : -1];
};

// Upright's modes, as tf_upright holds them
export const UPRIGHT_MODES = ["Off", "Auto", "Guided", "Level", "Vertical", "Full"] as const;
export const UPRIGHT_GUIDED = 2;
// the guides Guided keeps at most, as Lightroom's
export const MAX_GUIDES = 4;
export const GUIDE_IDS = Array.from({ length: 4 * MAX_GUIDES }, (_, i) => `tf_g${i}`);

// Upright's fit and mode go in ashift's last_quad_lines, which darktable
// reads only for its rectangle tool, after this tag: the Manual sliders
// adjust on top of the fit, so it has to be kept apart from them. the fit
// is in ashift's own units, which a turn of the photo leaves as they are.
// Guided's guides go in last_drawn_lines, in the input image's pixels as
// darktable keeps its drawn lines (taken here at the sensor's size)
const UPRIGHT_TAG = 2718.25;
const QUAD = (i: number) => `last_quad_lines[${i}]`;
// Aspect as ashift's aspect adjust, 0.5-2, a stretch across the sensor frame
export const uprightAspect = (v: Values, ctx: ImageContext) =>
  2 ** (((swapsAxes(ctx) ? -1 : 1) * (v.tf_aspect ?? 0)) / 100);
// the guides kept, as x1, y1, x2, y2 in the input image (0-1)
export const guidesOf = (v: Values): [number, number, number, number][] =>
  Array.from({ length: Math.min(MAX_GUIDES, v.tf_gn ?? 0) }, (_, k) =>
    [0, 1, 2, 3].map((j) => v[GUIDE_IDS[4 * k + j]] ?? 0) as [number, number, number, number]);
const DRAWN = (i: number) => `last_drawn_lines[${i}]`;

// darktable's positive rotation turns the picture counter-clockwise;
// Lightroom's turns it clockwise. a vertical keystone on a portrait shot is a
// horizontal one in the sensor frame ashift works in, as is Aspect's
// stretch. the "specific" lens model with darktable's generic 28 mm, crop
// factor 1 and no lens dependence renders as "generic" does, which ignores
// the aspect (ashift.c, commit_params)
const transformMap: ModuleMap = {
  op: "ashift", keepOn: false, frame: "sensor",
  controls: ["tf_vertical", "tf_horizontal", "tf_rotate", "tf_aspect",
             "tf_upright", "tf_base_r", "tf_base_v", "tf_base_h", "tf_gn", ...GUIDE_IDS],
  fields: ["rotation", "lensshift_v", "lensshift_h", "cl", "cr", "ct", "cb",
           "mode", "f_length", "crop_factor", "orthocorr", "aspect", "last_drawn_lines_count",
           ...[0, 1, 2, 3, 4].map(QUAD), ...GUIDE_IDS.map((_, i) => DRAWN(i))],
  read: (p, _d, ctx) => {
    const tagged = p[QUAD(0)] === UPRIGHT_TAG;
    const [br, bv, bh] = tagged ? [p[QUAD(2)], p[QUAD(3)], p[QUAD(4)]] : [0, 0, 0];
    const sign = mirrored(ctx) ? 1 : -1;
    const [lv, lh] = [p.lensshift_v - bv, p.lensshift_h - bh];
    const [v, h] = swapsAxes(ctx) ? [lh, lv] : [lv, lh];
    const [vs, hs] = keystoneSigns(ctx);
    const aspect = p.mode === 1 && p.aspect > 0 ? p.aspect : 1;
    const gn = tagged ? Math.min(MAX_GUIDES, Math.max(0, Math.round(p.last_drawn_lines_count))) : 0;
    const guides = Object.fromEntries(GUIDE_IDS.map((id, i) => [id, i < 4 * gn
      ? p[DRAWN(i)] / (i % 2 ? ctx.sensorHeight : ctx.sensorWidth) : 0]));
    return { tf_rotate: sign * (p.rotation - br), tf_vertical: vs * v * 100, tf_horizontal: hs * h * 100,
             tf_aspect: (swapsAxes(ctx) ? -100 : 100) * Math.log2(aspect),
             tf_upright: tagged ? p[QUAD(1)] : 0, tf_base_r: br, tf_base_v: bv, tf_base_h: bh,
             tf_gn: gn, ...guides };
  },
  write: (v, _d, ctx) => {
    const rotation = (v.tf_base_r ?? 0) + (mirrored(ctx) ? 1 : -1) * v.tf_rotate;
    const [vs, hs] = keystoneSigns(ctx);
    const dv = (vs * v.tf_vertical) / 100, dh = (hs * v.tf_horizontal) / 100;
    const [sv, sh] = swapsAxes(ctx) ? [dh, dv] : [dv, dh];
    const lensshift_v = (v.tf_base_v ?? 0) + sv, lensshift_h = (v.tf_base_h ?? 0) + sh;
    const aspect = uprightAspect(v, ctx);
    const mode = v.tf_upright ?? 0, gn = mode ? v.tf_gn ?? 0 : 0;
    const quad = mode ? [UPRIGHT_TAG, mode, v.tf_base_r ?? 0, v.tf_base_v ?? 0, v.tf_base_h ?? 0] : [0, 0, 0, 0, 0];
    return {
      rotation, lensshift_v, lensshift_h, mode: 1, f_length: 28, crop_factor: 1, orthocorr: 0, aspect,
      ...autoCrop(rotation, lensshift_v, lensshift_h, ctx.sensorWidth, ctx.sensorHeight, aspect),
      ...Object.fromEntries(quad.map((x, i) => [QUAD(i), x])),
      last_drawn_lines_count: gn,
      ...Object.fromEntries(GUIDE_IDS.map((id, i) => [DRAWN(i), i < 4 * gn
        ? (v[id] ?? 0) * (i % 2 ? ctx.sensorHeight : ctx.sensorWidth) : 0])),
    };
  },
};

// --------------------------------------------------- Effects (vignette, grain)

// Midpoint places the middle of the transition and Feather sets its width,
// both in vignette's own radius units (1 is the frame's edge, the corners of
// an aspect-shaped vignette sit at sqrt 2). Roundness 0 follows the frame's
// aspect, +100 is a circle (whratio 1), and negative values square it off
// through the superellipse exponent 2/shape (vignette.c). the center, set
// by dragging it on the image, runs -1..1 across the frame.
//
// dithering is switched on for its side effect: vignette.c applies the
// cosine ease of its fall-off only inside the dithering branch, and without
// it the fall-off is a linear ramp whose corners show as a hard edge.
// 16-bit dithering adds noise of 1/65536, nothing visible
export const VIG_MID = (m: number) => 0.3 + m / 100;             // 0.3 .. 1.3
export const VIG_WIDTH = (f: number) => 0.05 + (1.35 * f) / 100; // 0.05 .. 1.4
const DITHER_16BIT = 2;

export const vignetteMap: ModuleMap = {
  op: "vignette", keepOn: false, frame: "shown",
  controls: ["vig_amount", "vig_midpoint", "vig_roundness", "vig_feather", "vig_cx", "vig_cy"],
  fields: ["brightness", "saturation", "scale", "falloff_scale", "autoratio", "whratio", "shape",
           "dithering", "center.x", "center.y"],
  read: (p, _d, ctx) => {
    const { w, h } = displayed(ctx);
    const f = Math.max(w, h) / Math.min(w, h);
    const r0 = w >= h ? 2 - 1 / f : 1 / f;
    const roundness = p.autoratio ? 0
      : p.shape < 1 ? (-100 * (1 - p.shape)) / 0.8
      : (100 * (p.whratio - r0)) / (1 - r0);
    // a transition clipped at the center reads back with its full width
    const width = p.falloff_scale / 100;
    const mid = p.scale / 100 + width / 2;
    return { vig_amount: p.brightness * 100, vig_midpoint: (mid - 0.3) * 100,
             vig_roundness: roundness, vig_feather: ((width - 0.05) * 100) / 1.35,
             vig_cx: p["center.x"], vig_cy: p["center.y"] };
  },
  write: (v, _d, ctx) => {
    const { w, h } = displayed(ctx);
    const f = Math.max(w, h) / Math.min(w, h);
    const r0 = w >= h ? 2 - 1 / f : 1 / f;
    const t = Math.max(0, v.vig_roundness) / 100;
    const mid = VIG_MID(v.vig_midpoint);
    const half = VIG_WIDTH(v.vig_feather) / 2;
    // a transition that would start before the center starts at it instead
    const start = Math.max(0, mid - half);
    return {
      brightness: v.vig_amount / 100,
      saturation: 0, // Lightroom's vignette does not desaturate; darktable's default does
      scale: 100 * start,
      falloff_scale: 100 * (mid + half - start),
      autoratio: v.vig_roundness === 0 ? 1 : 0,
      whratio: r0 + t * (1 - r0),
      shape: v.vig_roundness < 0 ? 1 - (0.8 * -v.vig_roundness) / 100 : 1,
      dithering: DITHER_16BIT,
      "center.x": v.vig_cx ?? 0,
      "center.y": v.vig_cy ?? 0,
    };
  },
  enabled: (v) => v.vig_amount !== 0,
};

// Size spans grain's coarseness logarithmically from ISO 200 to 6400
// (coarseness is stored divided by GRAIN_SCALE_FACTOR, grain.c); Amount 50 is
// darktable's default strength 25
const GRAIN_SCALE_FACTOR = 213.2;
const grainMap: ModuleMap = {
  op: "grain", keepOn: false,
  controls: ["grain_amount", "grain_size"],
  fields: ["strength", "scale"],
  read: (p) => ({
    grain_amount: p.strength * 2,
    grain_size: (100 * Math.log((p.scale * GRAIN_SCALE_FACTOR) / 200)) / Math.log(32),
  }),
  write: (v) => ({
    strength: v.grain_amount / 2,
    scale: (200 * 32 ** (v.grain_size / 100)) / GRAIN_SCALE_FACTOR,
  }),
  enabled: (v) => v.grain_amount > 0,
};

// a swatch of real noise, finer and fainter at a higher frequency
const noiseSwatch = (freq: number, alpha: number) => `url("data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36'><filter id='g'>"
  + `<feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='2' seed='3'/>`
  + "<feColorMatrix type='saturate' values='0'/>"
  + `<feComponentTransfer><feFuncA type='linear' slope='${alpha}'/></feComponentTransfer>`
  + "</filter><rect width='36' height='36' filter='url(#g)'/></svg>")}") center / cover, #7a7a7a`;
// tuned on a full-size render, each a clear step from the last; None
// leaves Size as it was
const GRAIN_PRESETS: ControlPreset[] = [
  { label: "None", swatch: "linear-gradient(135deg, #7a7a7a 44%, #eee 44% 56%, #7a7a7a 56%)",
    values: { grain_amount: 0 } },
  { label: "Low", swatch: noiseSwatch(1.1, 0.7), values: { grain_amount: 30, grain_size: 15 } },
  { label: "Medium", swatch: noiseSwatch(0.6, 1.2), values: { grain_amount: 55, grain_size: 30 } },
  { label: "Heavy", swatch: noiseSwatch(0.3, 1.8), values: { grain_amount: 85, grain_size: 50 } },
];

// ------------------------------------------------ Tone Curve parametric

// the parametric curve's settings from control values; a control a photo
// has not read yet takes its neutral value
export const parametricOf = (v: Values): Parametric => ({
  highlights: v.tc_highlights ?? 0, lights: v.tc_lights ?? 0, darks: v.tc_darks ?? 0,
  shadows: v.tc_shadows ?? 0, midtones: v.tc_midtones ?? 0,
  split1: v.tc_split1 ?? 25, split2: v.tc_split2 ?? 50, split3: v.tc_split3 ?? 75,
});

// ------------------------------------------------ Tone Curve point curve

// a point curve's points as control values: <prefix>pn of them,
// <prefix>p<k>x/y. the master curve's prefix is "tc_", the channels'
// "tc_r_", "tc_g_" and "tc_b_"
export type CurveChannel = "rgb" | "r" | "g" | "b";
export const curvePrefix = (c: CurveChannel) => (c === "rgb" ? "tc_" : `tc_${c}_`);
const pointIds = (pre: string) =>
  [`${pre}pn`, ...Array.from({ length: MAX_NODES }, (_, k) => [`${pre}p${k}x`, `${pre}p${k}y`]).flat()];
export const POINT_IDS = pointIds("tc_").slice(1);
export const pointsOf = (v: Values, c: CurveChannel = "rgb"): Point[] => {
  const pre = curvePrefix(c);
  return Array.from({ length: Math.max(2, Math.min(MAX_NODES, v[`${pre}pn`] ?? 2)) },
                    (_, k) => [v[`${pre}p${k}x`] ?? 0, v[`${pre}p${k}y`] ?? 0] as Point);
};
export const pointValues = (points: Point[], c: CurveChannel = "rgb"): Values => {
  const pre = curvePrefix(c);
  const out: Values = { [`${pre}pn`]: points.length };
  for (let k = 0; k < MAX_NODES; k++) {
    // unused slots hold the line's end, so they never read as a change
    const [x, y] = points[k] ?? [1, 1];
    out[`${pre}p${k}x`] = x;
    out[`${pre}p${k}y`] = y;
  }
  return out;
};
const LINEAR = pointValues([[0, 0], [1, 1]]);

// the R, G and B curves as rgbcurve's independent channels (0, 1, 2)
const CHANNELS = ["r", "g", "b"] as const;
const rgbcurveMap: ModuleMap = {
  // after the tone mapper, whichever it is: AgX runs just after sigmoid
  op: "rgbcurve", keepOn: false, after: "agx",
  controls: CHANNELS.flatMap((c) => pointIds(curvePrefix(c))),
  fields: ["curve_autoscale", ...CHANNELS.flatMap((_, ch) => [`curve_num_nodes[${ch}]`,
    ...Array.from({ length: MAX_NODES }, (_, k) => [`curve_nodes[${ch}][${k}].x`, `curve_nodes[${ch}][${k}].y`]).flat()])],
  // linked channels are a single curve drawn in darktable: not ours to show
  read: (p): Values => p.curve_autoscale !== 1 ? {} : Object.assign({}, ...CHANNELS.map((c, ch) => {
    const n = Math.max(2, Math.min(MAX_NODES, p[`curve_num_nodes[${ch}]`] ?? 2));
    const lin = Array.from({ length: n }, (_, k) =>
      [p[`curve_nodes[${ch}][${k}].x`], p[`curve_nodes[${ch}][${k}].y`]] as Point);
    return pointValues(channelPointsFromLinear(lin), c);
  })),
  write: (v) => {
    const out: Values = { curve_autoscale: 1 };
    CHANNELS.forEach((c, ch) => {
      const pts = channelPointsToLinear(pointsOf(v, c));
      out[`curve_num_nodes[${ch}]`] = pts.length;
      pts.forEach(([x, y], k) => {
        out[`curve_nodes[${ch}][${k}].x`] = x;
        out[`curve_nodes[${ch}][${k}].y`] = y;
      });
    });
    return out;
  },
  enabled: (v) => CHANNELS.some((c) => !isIdentity(pointsOf(v, c))),
};

// ------------------------------------------------------------------ Crop

// crop's left, top, right and bottom as fractions of its input, which is
// the image after rotate and perspective, in the orientation it is shown.
// the crop tool keeps the aspect while dragging; the ratio is stored too, as
// darktable's ratio_d:ratio_n, for its exact export sizes (crop.c): 0:0 is
// free, 1:0 the image's own
const cropMap: ModuleMap = {
  op: "crop", keepOn: false,
  controls: ["crop_l", "crop_t", "crop_r", "crop_b", "crop_rd", "crop_rn"],
  fields: ["cx", "cy", "cw", "ch", "ratio_d", "ratio_n"],
  read: (p) => ({ crop_l: p.cx, crop_t: p.cy, crop_r: p.cw, crop_b: p.ch,
                  crop_rd: p.ratio_d, crop_rn: p.ratio_n }),
  write: (v) => ({ cx: v.crop_l, cy: v.crop_t, cw: v.crop_r, ch: v.crop_b,
                   ratio_d: v.crop_rd, ratio_n: v.crop_rn }),
  enabled: (v) => v.crop_l > 0 || v.crop_t > 0 || v.crop_r < 1 || v.crop_b < 1,
};

// ------------------------------------------------------ Rotate and flip

// darktable's flip, which runs after rotate and perspective and before crop
const flipMap: ModuleMap = {
  op: "flip", keepOn: true,
  controls: ["orient"],
  fields: ["orientation"],
  read: (p, _d, ctx) => ({ orient: p.orientation >= 0 ? p.orientation : ctx.camera }),
  write: (v) => ({ orientation: v.orient }),
};

export type Turn = "ccw" | "cw" | "h" | "v";

// the orientation after a turn, as flip.c's do_rotate(), _flip_h() and
// _flip_v() work it out: a mirror of the shown image is the other axis of
// the sensor while the axes are swapped
export function turnOrientation(o: number, how: Turn): number {
  const swap = (o & 4) !== 0;
  if (how === "h") return o ^ (swap ? 1 : 2);
  if (how === "v") return o ^ (swap ? 2 : 1);
  return (o ^ ((how === "cw") === swap ? 2 : 1)) ^ 4;
}

// a crop rectangle carried along with the picture, as crop.c's
// _crop_handle_flip() moves it
export function turnRect(r: { l: number; t: number; r: number; b: number }, how: Turn) {
  if (how === "h") return { l: 1 - r.r, t: r.t, r: 1 - r.l, b: r.b };
  if (how === "v") return { l: r.l, t: 1 - r.b, r: r.r, b: 1 - r.t };
  if (how === "cw") return { l: 1 - r.b, t: r.l, r: 1 - r.t, b: r.r };
  return { l: r.t, t: 1 - r.r, r: r.b, b: 1 - r.l };
}

// --------------------------------------------------------------- the maps

export const modules: ModuleMap[] = [
  {
    op: "channelmixerrgb", keepOn: true,
    controls: ["temp", "tint"],
    fields: ["illuminant", "x", "y", "temperature"],
    read: (p) => readWB(p),
    write: (v, d) => writeWB({ temp: v.temp, tint: v.tint }, d),
  },
  {
    op: "exposure", keepOn: true,
    controls: ["exposure"],
    fields: ["exposure"],
    read: (p, d) => ({ exposure: p.exposure - d.exposure }),
    write: (v, d) => ({ exposure: d.exposure + v.exposure }),
  },
  // Preferences' exposure compensation for new photos, on an instance of
  // its own so Exposure still starts at 0 and the photo keeps its amount.
  // a new instance takes a raw's defaults (+0.7 EV, a black level and the
  // camera's bias compensated, exposure.c), which the first one has already
  {
    op: "exposure#compensation", keepOn: false, after: "exposure",
    controls: ["exp_comp"],
    fields: ["mode", "exposure", "black", "compensate_exposure_bias"],
    read: (p) => ({ exp_comp: p.exposure }),
    write: (v) => ({ mode: 0, exposure: v.exp_comp, black: 0, compensate_exposure_bias: 0 }),
  },
  // Blacks as exposure's black level, one of its modules. Exposure's map
  // shares the module, so a new Exposure sends it again for the new gain
  {
    op: "exposure", keepOn: false, choice: { control: "mod_blacks", value: MOD_EXPOSURE },
    controls: ["blacks", "mod_blacks"],
    fields: ["black"],
    read: (p, d) => ({
      mod_blacks: MOD_EXPOSURE,
      blacks: bend(((p.black - d.black) * 2 ** (p.exposure - d.exposure)) / BLACKS_SCALE, 1 / BLACKS_POWER),
    }),
    write: (v, d) => ({ black: d.black + bend(v.blacks, BLACKS_POWER) * BLACKS_SCALE * 2 ** -v.exposure }),
  },
  linear("colorbalancergb", false, [{ id: "vibrance", field: "vibrance", scale: 0.01, base: 0 }]),
  chosen(linear("colorbalancergb", false, [{ id: "contrast", field: "contrast", scale: 0.01, base: 0 }]),
         "mod_contrast", MOD_CBRGB),
  // a photo on sigmoid, which has no saturation, keeps this one
  chosen(linear("colorbalancergb", false, [{ id: "saturation", field: "saturation_global", scale: 0.01, base: 0 }]),
         "mod_saturation", MOD_CBRGB, { active: (v) => v.mod_saturation === MOD_CBRGB || v.tm_mode !== 1 }),
  chosen(linear("shadhi", false, [
    { id: "highlights", field: "highlights", scale: 1, base: 0 },
    { id: "shadows", field: "shadows", scale: 1, base: 0 },
  ]), "mod_tone", MOD_SHADHI),
  {
    // the darktable instance, ahead of color calibration where the AgX
    // workflow puts it; the Zone System's placement is another one
    op: "toneequal", keepOn: false, choice: { control: "mod_tone", value: MOD_TONEEQ },
    controls: ["highlights", "shadows", "mod_tone"],
    fields: [...TONE_NODES, "exposure_boost", "contrast_boost"],
    read: (p): Values => {
      const t = toneRead(p);
      return t ? { highlights: t.highlights, shadows: t.shadows, mod_tone: MOD_TONEEQ } : {};
    },
    write: (v) => ({ ...toneNodes(v.shadows, v.highlights), ...TONE_MASK }),
  },
  // an AgX profile, ahead of the maps whose sliders move from its values.
  // a color balance rgb profile, read after it, leaves AgX at the image's
  // defaults
  {
    op: "agx", keepOn: false,
    controls: ["profile"],
    fields: AGX_PROFILE_FIELDS,
    read: (p, d): Values => {
      const same = (want: Params) => [...AGX_PRIMARY_FIELDS, ...AGX_LOOK_FIELDS]
        .every((f) => Math.abs(p[f] - want[f]) < 1e-4);
      const pr = AGX_PROFILES.find((x) => x.value !== AGX_PROFILE_DEFAULT && same(x.params));
      return pr ? { profile: pr.value } : same(d) ? { profile: AGX_PROFILE_DEFAULT } : {};
    },
    // the sliders' fields at the profile's, which their own maps then move
    write: (v, d) => {
      const pr = AGX_PROFILES.find((x) => x.value === v.profile && x.value !== AGX_PROFILE_DEFAULT);
      return Object.fromEntries(AGX_PROFILE_FIELDS.map((f) => [f, pr ? pr.params[f] : d[f]]));
    },
    enabled: (v) => v.tm_mode === 1,
  },
  // Whites' brilliance on AgX, ahead of the tone mappers' Whites so that
  // theirs is the value read: an edit from before it opens as it was
  { ...linear("colorbalancergb", false, [{ id: "whites", field: "brilliance_highlights",
                                             scale: WHITES_BRILLIANCE, base: 0 }]),
    active: (v) => v.tm_mode === 1 },
  // the tone mapper: AgX, which new photos get, or sigmoid, which photos
  // started earlier or in darktable may have; one on and the other off.
  // Whites moves the top end under both: sigmoid's white
  // target, or AgX's shoulder power, ±100 halving or doubling it, with the
  // brilliance above. AgX's white relative exposure lifted the midtones as
  // much as the whites
  {
    op: "sigmoid", keepOn: false,
    controls: ["whites", "tm_mode"],
    fields: ["display_white_target"],
    read: (p, d) => ({ tm_mode: 0,
                       whites: (100 * Math.log2(p.display_white_target / d.display_white_target)) / WHITES_STOPS }),
    write: (v, d) => ({ display_white_target: d.display_white_target * 2 ** ((v.whites / 100) * WHITES_STOPS) }),
    enabled: (v) => v.tm_mode !== 1,
  },
  {
    op: "agx", keepOn: false,
    controls: ["whites", "tm_mode"],
    fields: ["curve_shoulder_power"],
    read: (p, d, _c, v) => ({ tm_mode: 1,
                              whites: 100 * Math.log2(p.curve_shoulder_power / agxBase("curve_shoulder_power", v, d)) }),
    write: (v, d) => ({ curve_shoulder_power: agxBase("curve_shoulder_power", v, d) * 2 ** (v.whites / 100) }),
    enabled: (v) => v.tm_mode === 1,
  },
  // Contrast, Blacks and Saturation on the tone mapper, the modules the AgX
  // workflow sets them with; sigmoid has no saturation
  chosen({
    op: "sigmoid", keepOn: false,
    controls: ["contrast", "tm_mode"],
    fields: ["middle_grey_contrast"],
    read: (p, d) => ({ tm_mode: 0,
                       contrast: (100 * Math.log2(p.middle_grey_contrast / d.middle_grey_contrast)) / SIGMOID_CONTRAST_STOPS }),
    write: (v, d) => ({ middle_grey_contrast: d.middle_grey_contrast * 2 ** ((v.contrast / 100) * SIGMOID_CONTRAST_STOPS) }),
    enabled: (v) => v.tm_mode !== 1,
  }, "mod_contrast", MOD_TM, { active: (v) => v.mod_contrast === MOD_TM && v.tm_mode !== 1 }),
  chosen({
    op: "agx", keepOn: false,
    controls: ["contrast", "tm_mode"],
    fields: ["curve_contrast_around_pivot"],
    read: (p, d, _c, v) => ({ tm_mode: 1,
      contrast: (100 * Math.log2(p.curve_contrast_around_pivot / agxBase("curve_contrast_around_pivot", v, d)))
        / AGX_CONTRAST_STOPS }),
    write: (v, d) => ({ curve_contrast_around_pivot:
      agxBase("curve_contrast_around_pivot", v, d) * 2 ** ((v.contrast / 100) * AGX_CONTRAST_STOPS) }),
    enabled: (v) => v.tm_mode === 1,
  }, "mod_contrast", MOD_TM, { active: (v) => v.mod_contrast === MOD_TM && v.tm_mode === 1 }),
  chosen({
    op: "sigmoid", keepOn: false,
    controls: ["blacks", "tm_mode"],
    fields: ["display_black_target"],
    read: (p, d) => ({ tm_mode: 0, blacks: sigmoidBlackRead(p.display_black_target, d.display_black_target) }),
    write: (v, d) => ({ display_black_target: sigmoidBlackWrite(v.blacks, d.display_black_target) }),
    enabled: (v) => v.tm_mode !== 1,
  }, "mod_blacks", MOD_TM, { active: (v) => v.mod_blacks === MOD_TM && v.tm_mode !== 1 }),
  chosen({
    op: "agx", keepOn: false,
    controls: ["blacks", "tm_mode"],
    fields: ["look_lift"],
    read: (p, d) => ({ tm_mode: 1, blacks: (100 * (p.look_lift - d.look_lift)) / AGX_LIFT }),
    write: (v, d) => ({ look_lift: d.look_lift + (AGX_LIFT * v.blacks) / 100 }),
    enabled: (v) => v.tm_mode === 1,
  }, "mod_blacks", MOD_TM, { active: (v) => v.mod_blacks === MOD_TM && v.tm_mode === 1 }),
  // AgX's saturation, from gray to twice the profile's, as Lightroom's -100..+100
  chosen({
    op: "agx", keepOn: false,
    controls: ["saturation", "tm_mode"],
    fields: ["look_saturation"],
    read: (p, d, _c, v) => ({ tm_mode: 1, saturation: (p.look_saturation / agxBase("look_saturation", v, d) - 1) * 100 }),
    write: (v, d) => ({ look_saturation: agxBase("look_saturation", v, d) * (1 + v.saturation / 100) }),
    enabled: (v) => v.tm_mode === 1,
  }, "mod_saturation", MOD_TM, { active: (v) => v.mod_saturation === MOD_TM && v.tm_mode === 1 }),
  // AgX's black and white relative exposure, set by Auto from darktable's
  // "auto tune levels" (the engine's agx_auto). the pivot keeps its
  // exposure inside the new range, as agx.c's _update_pivot_x does
  {
    op: "agx", keepOn: false,
    controls: ["agx_black", "agx_white", "tm_mode"],
    fields: ["range_black_relative_ev", "range_white_relative_ev", "curve_pivot_x"],
    read: (p) => ({ tm_mode: 1, agx_black: p.range_black_relative_ev, agx_white: p.range_white_relative_ev }),
    write: (v, d) => {
      const pivot = d.range_black_relative_ev + d.curve_pivot_x * (d.range_white_relative_ev - d.range_black_relative_ev);
      const at = Math.min(Math.max(pivot, v.agx_black), v.agx_white);
      return { range_black_relative_ev: v.agx_black, range_white_relative_ev: v.agx_white,
               curve_pivot_x: (at - v.agx_black) / (v.agx_white - v.agx_black) };
    },
    enabled: (v) => v.tm_mode === 1,
  },
  {
    op: "diffuse", keepOn: false,
    controls: ["texture"],
    fields: [...Object.keys(TEXTURE_SPEEDS), ...Object.keys(TEXTURE_FIXED)],
    read: (p) => ({ texture: textureRead(p) }),
    write: (v) => textureWrite(v.texture),
  },
  linear("bilat", false, [{ id: "clarity", field: "detail", scale: 0.01, base: 0 }]),
  linear("hazeremoval", false, [{ id: "dehaze", field: "strength", scale: 0.01, base: 0 }]),

  {
    // the curve is either parametric (Lightroom's region sliders) or a point
    // curve; tc_mode says which. a curve that is not one of the parametric
    // ones, drawn in darktable for instance, opens as points
    op: "tonecurve", keepOn: false,
    controls: ["tc_mode", "tc_highlights", "tc_lights", "tc_darks", "tc_shadows", "tc_midtones", "tc_split1",
               "tc_split2", "tc_split3", "tc_pn", ...POINT_IDS],
    fields: nodeFields(),
    read: (p): Values => {
      const c = readCurve(p);
      // every control gets a value, the other mode's at neutral. a flat
      // curve opens as points, the default mode
      if (c && [c.highlights, c.lights, c.darks, c.shadows, c.midtones].some((x) => x !== 0)) return { tc_mode: 0, tc_highlights: c.highlights, tc_lights: c.lights, tc_darks: c.darks,
                      tc_shadows: c.shadows, tc_midtones: c.midtones, tc_split1: c.split1, tc_split2: c.split2,
                      tc_split3: c.split3, ...LINEAR };
      return { tc_mode: 1, tc_highlights: 0, tc_lights: 0, tc_darks: 0, tc_shadows: 0, tc_midtones: 0,
               tc_split1: 25, tc_split2: 50, tc_split3: 75, ...pointValues(paramsToPoints(p)) };
    },
    write: (v) => v.tc_mode === 1 ? pointsToParams(pointsOf(v)) : writeCurve(parametricOf(v)),
    enabled: (v) => v.tc_mode === 1 ? !isIdentity(pointsOf(v))
      : [v.tc_highlights, v.tc_lights, v.tc_darks, v.tc_shadows, v.tc_midtones].some((x) => x !== 0),
  },

  // Black & White's two modules: color calibration's gray, which runs after
  // the color equalizer, or the color equalizer desaturating every band.
  // both are read ahead of the color equalizer's own map, which needs to
  // know whether its brightness is the B&W Mix
  {
    op: "channelmixerrgb#bw", keepOn: false, choice: { control: "mod_bw", value: MOD_BW_CALIBRATION },
    after: "colorequal",
    controls: ["bw_mode", "mod_bw"],
    fields: Object.keys(BW_FIELDS),
    read: () => ({ bw_mode: 1, mod_bw: MOD_BW_CALIBRATION }),
    write: () => BW_FIELDS,
    enabled: (v) => v.bw_mode === 1,
  },
  {
    // the color equalizer's own black and white: the map only marks it as
    // the photo's, the color equalizer's map below doing the work
    op: "colorequal", keepOn: false, choice: { control: "mod_bw", value: MOD_BW_EQUALIZER },
    controls: ["mod_bw"],
    fields: [],
    read: (p) => ({ mod_bw: MOD_BW_EQUALIZER, ...(desaturated(p) ? { bw_mode: 1 } : {}) }),
    write: () => ({}),
    enabled: () => false,
  },
  {
    // HSL in color; in black and white the B&W Mix sets how light each hue
    // renders in gray, as Lightroom's treatment does. under color
    // calibration's gray the bands keep their color for it; under the color
    // equalizer's own, every band's saturation goes to 0, and an image whose
    // bands are all desaturated reads as black and white
    op: "colorequal", keepOn: false,
    controls: ["bw_mode", ...HSL_IDS, ...BW_IDS],
    fields: BANDS.flatMap(([b]) => [`hue_${b}`, `sat_${b}`, `bright_${b}`]),
    read: (p, _d, _c, v): Values => {
      const zero = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 0]));
      if (!desaturated(p) && v?.bw_mode !== 1) return { bw_mode: 0, ...readHSL("hsl", p), ...zero(BW_IDS) };
      const mix = nodesOf(p, "bright", 1);
      return { bw_mode: 1, ...zero(HSL_IDS),
               ...Object.fromEntries(BW_IDS.map((id, k) => [id, BW_SCALE * Math.log2(Math.max(1e-3, 1 + mix[k]))])) };
    },
    write: (v) => v.bw_mode === 1
      ? Object.fromEntries([
          ...BANDS.flatMap(([b]) => [[`hue_${b}`, 0], [`sat_${b}`, v.mod_bw === MOD_BW_EQUALIZER ? 0 : 1]]),
          ...fieldsOf("bright", 1, BW_IDS.map((id) => 2 ** (v[id] / BW_SCALE) - 1))])
      : writeHSL("hsl", v),
    enabled: (v) => v.bw_mode === 1 ? v.mod_bw === MOD_BW_EQUALIZER || BW_IDS.some((id) => v[id] !== 0)
      : HSL_IDS.some((id) => v[id] !== 0),
  },

  {
    // the Zone System's placement (zones.ts): a tone equalizer on the black
    // and white image ahead of the mask anchor, its nodes on zones II-X, as a
    // plain luminance curve (no detail preservation, the RGB average, which
    // on gray is the luminance)
    // after the color equalizer and color calibration's gray, which may
    // each come last
    op: PLACEMENT_OP, keepOn: false, after: "colorequal,channelmixerrgb#bw", before: "colorbalancergb",
    controls: placeIds,
    fields: [...PLACE_FIELDS, "method", "details", "exposure_boost"],
    read: (p) => Object.fromEntries(placeIds.map((id, i) => [id, p[PLACE_FIELDS[i]]])),
    write: (v) => ({
      ...Object.fromEntries(PLACE_FIELDS.map((f, i) => [f, v[placeIds[i]] ?? 0])),
      method: 0, details: 0, exposure_boost: PLACE_BOOST,
    }),
  },
  {
    op: "colorbalancergb#profile", keepOn: false,
    controls: ["profile"],
    fields: [...PROFILE_FIELDS],
    read: (p) => ({ profile: PROFILES.find((pr) =>
      PROFILE_FIELDS.every((f, i) => Math.abs(p[f] - pr.params[i]) < 1e-4))?.value ?? 0 }),
    write: (v) => {
      const pr = PROFILES.find((x) => x.value === v.profile);
      return Object.fromEntries(PROFILE_FIELDS.map((f, i) => [f, pr ? pr.params[i] : 0]));
    },
    enabled: (v) => PROFILES.some((p) => p.value === v.profile),
  },
  linear("colorbalancergb", false, gradingFields("cg")),

  {
    // diffuse or sharpen on an instance of its own, from darktable's
    // "sharpness | normal" preset: Amount is its iterations, 0 switching it
    // off; Radius its radius span, Sensitivity its edge sensitivity
    op: "diffuse#sharpen", keepOn: false, choice: { control: "mod_sharpening", value: MOD_DIFFUSE },
    // Masking keeps it to the raw's edges: darktable's details threshold
    // (the engine's blend.details), positive for detailed areas
    controls: ["sharp_amount", "sharp_radius", "sharp_sensitivity", "sharp_masking", "mod_sharpening"],
    fields: [...Object.keys(SHARPEN_FIXED), "iterations", "radius", "regularization", BLEND_DETAILS],
    read: (p) => ({ mod_sharpening: MOD_DIFFUSE, sharp_amount: p.iterations, sharp_radius: p.radius,
                    sharp_sensitivity: p.regularization, sharp_masking: Math.max(0, p[BLEND_DETAILS] * 100) }),
    write: (v) => ({ ...SHARPEN_FIXED, iterations: Math.max(1, v.sharp_amount), radius: v.sharp_radius,
                     regularization: v.sharp_sensitivity, [BLEND_DETAILS]: v.sharp_masking / 100 }),
    enabled: (v) => v.sharp_amount > 0,
  },
  {
    // Sharpening on darktable's sharpen instead, the first instance, as
    // Immage's edits before diffuse used it. Masking as above
    op: "sharpen", keepOn: false, choice: { control: "mod_sharpening", value: MOD_SHARPEN },
    controls: ["usm_amount", "usm_radius", "usm_threshold", "sharp_masking", "mod_sharpening"],
    fields: ["amount", "radius", "threshold", BLEND_DETAILS],
    read: (p) => ({ mod_sharpening: MOD_SHARPEN, usm_amount: p.amount * USM_AMOUNT, usm_radius: p.radius,
                    usm_threshold: p.threshold * USM_THRESHOLD, sharp_masking: Math.max(0, p[BLEND_DETAILS] * 100) }),
    write: (v) => ({ amount: v.usm_amount / USM_AMOUNT, radius: v.usm_radius, threshold: v.usm_threshold / USM_THRESHOLD,
                     [BLEND_DETAILS]: v.sharp_masking / 100 }),
    enabled: (v) => v.usm_amount > 0,
  },
  {
    // darktable's capture sharpening, in demosaic: it takes back the blur of
    // the lens and the sensor's filters before anything else runs. radius
    // and contrast threshold stay the photo's defaults, the threshold set
    // for its ISO and resolution by demosaic's reload_defaults(). a radius
    // of 0 would ask darktable to measure one, but only while the photo is
    // unedited (demosaic.c's autotune), so it is left at 0.5
    op: "demosaic", keepOn: true,
    controls: ["capture"],
    fields: ["cs_enabled"],
    read: (p) => ({ capture: p.cs_enabled ? 1 : 0 }),
    write: (v) => ({ cs_enabled: v.capture }),
  },
  {
    // in darktable's default Y0U0V0 mode each wavelet band's threshold is
    // scaled by 4 force², luma by curve Y0 and chroma by U0V0, the force
    // 0.5 at its default. Luminance and Color each set their own curve flat,
    // 50 at darktable's default and 100 at twice it, under strength 1. an
    // edit made when one slider drove strength reads back as both at it.
    // Detail keeps it off the raw's edges and texture: the details
    // threshold, negative for flat areas
    op: "denoiseprofile", keepOn: false,
    controls: ["nr_luminance", "nr_color", "nr_detail"],
    fields: ["strength", ...NR_BANDS.map((k) => `y[${NR_Y0}][${k}]`), ...NR_BANDS.map((k) => `y[${NR_U0V0}][${k}]`),
             BLEND_DETAILS],
    read: (p) => ({ nr_luminance: nrRead(p, NR_Y0), nr_color: nrRead(p, NR_U0V0),
                    nr_detail: Math.max(0, -p[BLEND_DETAILS] * 100) }),
    write: (v) => ({
      strength: 1,
      [BLEND_DETAILS]: -v.nr_detail / 100,
      ...Object.fromEntries(NR_BANDS.map((k) => [`y[${NR_Y0}][${k}]`, nrForce(v.nr_luminance)])),
      ...Object.fromEntries(NR_BANDS.map((k) => [`y[${NR_U0V0}][${k}]`, nrForce(v.nr_color)])),
    }),
    enabled: (v) => v.nr_luminance > 0 || v.nr_color > 0,
  },
  {
    op: "lens", keepOn: false,
    controls: ["lens_profile", "lens_ca"],
    fields: ["modify_flags", "has_been_set"],
    // flags: TCA 1, vignetting 2, distortion 4 (lens.cc). until has_been_set,
    // commit_params ignores the params for the defaults, as darktable's GUI
    // sets it on the first change; the method stays the one the defaults
    // picked for the photo
    read: (p) => ({ lens_profile: 1, lens_ca: p.modify_flags & 1 ? 1 : 0 }),
    write: (v) => ({ modify_flags: v.lens_ca ? 7 : 6, has_been_set: 1 }),
    enabled: (v) => v.lens_profile === 1,
  },
  {
    op: "hotpixels", keepOn: false,
    controls: ["hp_enable", "hp_strength", "hp_threshold"],
    fields: ["strength", "threshold"],
    read: (p) => ({ hp_enable: 1, hp_strength: p.strength * 100, hp_threshold: p.threshold * 100 }),
    write: (v) => ({ strength: v.hp_strength / 100, threshold: v.hp_threshold / 100 }),
    enabled: (v) => v.hp_enable === 1,
  },
  transformMap,
  flipMap,
  cropMap,
  rgbcurveMap,
  vignetteMap,
  grainMap,
];

// --------------------------------------------------------------- the panels

export const panels: Panel[] = [
  {
    id: "basic", title: "Basic",
    sections: [
      {
        title: "Profile",
        controls: [{ id: "profile", label: "Profile", kind: "choice", min: 0, max: 16, step: 1,
                     neutral: AGX_PROFILE_DEFAULT, inline: true, menu: true, options: PROFILE_OPTIONS,
                     optionGroups: PROFILE_GROUPS, format: profileLabel }],
      },
      {
        title: "Treatment",
        controls: [{ id: "bw_mode", label: "Treatment", kind: "choice", min: 0, max: 1, step: 1, neutral: 0, inline: true,
                     options: [["Color", 0], ["Black & White", 1]], optionLabels: { 1: "B&W" },
                     optionIcons: { 0: Sun, 1: Contrast },
                     format: (v) => (v ? "Black & White" : "Color") }],
      },
      {
        title: "White Balance",
        controls: [
          tempControl,
          { id: "tint", label: "Tint", min: -150, max: 150, step: 1, format: signed(0),
            track: "linear-gradient(90deg, #5fb85f, #e0e0e0, #c45fc4)" },
        ],
      },
      {
        title: "Tone",
        controls: [
          { id: "exposure", label: "Exposure", min: -5, max: 5, step: 0.01, format: signed(2) },
          lr("contrast", "Contrast"),
          lr("highlights", "Highlights"),
          lr("shadows", "Shadows"),
          lr("whites", "Whites"),
          lr("blacks", "Blacks"),
        ],
      },
      {
        title: "Presence",
        controls: [
          lr("texture", "Texture"),
          lr("clarity", "Clarity"),
          lr("dehaze", "Dehaze"),
          lr("vibrance", "Vibrance", { track: GLOBAL_SAT_TRACK }),
          lr("saturation", "Saturation", { track: GLOBAL_SAT_TRACK }),
        ],
      },
    ],
  },
  {
    id: "tonecurve", title: "Tone Curve", graph: "tonecurve",
    sections: [
      {
        title: "Region",
        // named as Basic's Tone sliders, light to dark. the ids keep
        // Lightroom's region names, which presets and copied settings hold:
        // tc_highlights is Whites, tc_lights Highlights, tc_darks Shadows
        // and tc_shadows Blacks
        controls: [
          lr("tc_highlights", "Whites", { neutral: 0 }),
          lr("tc_lights", "Highlights", { neutral: 0 }),
          lr("tc_midtones", "Midtones", { neutral: 0 }),
          lr("tc_darks", "Shadows", { neutral: 0 }),
          lr("tc_shadows", "Blacks", { neutral: 0 }),
        ],
      },
      {
        title: "Split Points",
        controls: [
          { id: "tc_split1", label: "Blacks / Shadows", min: 10, max: 40, step: 5, neutral: 25, format: plain(0) },
          { id: "tc_split2", label: "Shadows / Highlights", min: 30, max: 70, step: 5, neutral: 50, format: plain(0) },
          { id: "tc_split3", label: "Highlights / Whites", min: 60, max: 90, step: 5, neutral: 75, format: plain(0) },
        ],
      },
    ],
  },
  {
    id: "hsl", title: "HSL / Color", tabs: true, showIf: (v) => v.bw_mode !== 1,
    sections: HSL_TABS.map((t) => ({ title: t, controls: hslControls("hsl", t) })),
  },
  {
    id: "bw", title: "B&W Mix", showIf: (v) => v.bw_mode === 1,
    presets: BW_FILTERS.map(([label, swatch, mix]) => ({
      label, swatch, values: Object.fromEntries(BANDS.map(([b], k) => [`bw_${b}`, mix[k]])),
    })),
    sections: [{
      title: "Black & White Mix",
      controls: BANDS.map(([band, label, h]) =>
        lr(`bw_${band}`, label, { neutral: 0, track: `linear-gradient(90deg, #111, ${hsl(h, 65, 45)})`,
                                  readsPast: true })),
    }],
  },
  // Immage's own module: zones and zone masks, drawn by ZoneSystem.tsx
  {
    // shown in its own right-hand mode (the rail's Zone System), not with the adjustments
    id: "zones", title: "Zone System", hidden: true, graph: "zones",
    // each zone's placement in EV, edited in ZoneSystem.tsx rather than as sliders
    sections: [{
      title: "Placement",
      controls: placeIds.map((id, i) => ({
        id, label: `Zone ${ROMAN[PLACE_FIRST + i]}`, min: -PLACE_MAX, max: PLACE_MAX, step: 0.01, neutral: 0,
        format: signed(2, " EV"),
      })),
    }],
  },
  {
    id: "colorgrading", title: "Color Grading", graph: "colorwheels",
    sections: RANGES.map(([r, title]) => ({ title, controls: gradingControls("cg", r) })),
  },
  {
    id: "detail", title: "Detail",
    sections: [
      {
        title: "Capture Sharpening",
        controls: [
          { ...toggle("capture", "Enable", 0), rawOnly: true,
            note: "restores the detail the lens and sensor soften, so less Sharpening is needed; on for new raws" },
        ],
      },
      {
        // each module's own sliders (MODULE_CHOICES); Masking is both's
        title: "Sharpening",
        controls: [
          { id: "usm_amount", label: "Amount", min: 0, max: 100, step: 1, neutral: 0,
            format: plain(0), optionPreview: "gray" },
          { id: "usm_radius", label: "Radius", min: 0.5, max: 3, step: 0.1, neutral: USM_RADIUS,
            format: plain(1, " px"), optionPreview: "gray" },
          { id: "usm_threshold", label: "Threshold", min: 0, max: 100, step: 1, neutral: 0.5 * USM_THRESHOLD,
            format: plain(0), optionPreview: "gray", note: "leaves differences smaller than this alone, such as noise" },
          { id: "sharp_amount", label: "Amount", min: 0, max: SHARPEN_MAX_ITERATIONS, step: 1, neutral: 0,
            format: plain(0), optionPreview: "gray" },
          { id: "sharp_radius", label: "Radius", min: 1, max: 12, step: 1, neutral: SHARPEN_RADIUS,
            format: plain(0, " px"), optionPreview: "gray" },
          { id: "sharp_sensitivity", label: "Sensitivity", min: 0, max: 4, step: 0.01,
            neutral: SHARPEN_SENSITIVITY, format: plain(2), optionPreview: "gray" },
          { id: "sharp_masking", label: "Masking", min: 0, max: 100, step: 1, neutral: 0, format: plain(0),
            rawOnly: true, optionPreview: "mask", note: "sharpens only the edges as it rises; ⌥-drag shows where" },
        ],
      },
      // its button writes a DNG (App.tsx, runDenoise), so no sliders
      { title: "AI Denoise", tag: "AI", controls: [] },
      {
        title: "Profiled Denoise",
        controls: [
          { id: "nr_luminance", label: "Luminance", min: 0, max: 100, step: 1, neutral: 0, format: plain(0), optionPreview: "gray" },
          { id: "nr_color", label: "Color", min: 0, max: 100, step: 1, neutral: 0, format: plain(0) },
          { id: "nr_detail", label: "Detail", min: 0, max: 100, step: 1, neutral: 0, format: plain(0),
            rawOnly: true, optionPreview: "mask", note: "keeps edges and texture out of the noise reduction; ⌥-drag shows where it acts" },
        ],
      },
    ],
  },
  {
    id: "lens", title: "Lens Corrections",
    sections: [
      {
        title: "Profile",
        controls: [
          { ...toggle("lens_profile", "Enable Profile Corrections", 0),
            note: "uses the lens darktable detects through lensfun" },
          toggle("lens_ca", "Remove Chromatic Aberration", 1),
        ],
      },
      {
        // a pixel is hot when strength / 2 times it is above all four
        // neighbors of its color, and it is above threshold
        // (hotpixels.c). the sliders reset to darktable's 25 and 5
        title: "Hot Pixels",
        controls: [
          { ...toggle("hp_enable", "Remove Hot Pixels", 0), rawOnly: true,
            note: "for long exposures and high ISO" },
          { id: "hp_strength", label: "Strength", min: 0, max: 100, step: 1, format: plain(0), rawOnly: true },
          { id: "hp_threshold", label: "Threshold", min: 0, max: 100, step: 1, format: plain(0), rawOnly: true,
            note: "lower finds more hot pixels" },
        ],
      },
    ],
  },
  {
    id: "transform", title: "Transform",
    sections: [
      // their buttons, and Upright's Guided tool, are the panel's own (App.tsx)
      { title: "Straighten", controls: [] },
      { title: "Upright", controls: [] },
      {
        title: "Manual",
        controls: [
          lr("tf_vertical", "Vertical", { neutral: 0 }),
          lr("tf_horizontal", "Horizontal", { neutral: 0 }),
          // Lightroom's crop Angle range, which the crop tool and Straighten share
          { id: "tf_rotate", label: "Rotate", min: -45, max: 45, step: 0.1, neutral: 0, format: signed(1, "°") },
          { ...lr("tf_aspect", "Aspect"), note: "darktable: rotate and perspective's aspect adjust, 0.5x to 2x" },
        ],
      },
    ],
  },
  // set by the Transform panel's Upright buttons and Guided tool
  {
    id: "upright", title: "Upright", hidden: true,
    sections: [{
      title: "Upright",
      controls: [
        { id: "tf_upright", label: "Upright", min: 0, max: UPRIGHT_MODES.length - 1, step: 1, neutral: 0,
          format: (v) => UPRIGHT_MODES[v] ?? "Off" },
        // ashift's own range for its fit (ashift.c, ROTATION_RANGE_SOFT
        // and LENSSHIFT_RANGE_SOFT)
        { id: "tf_base_r", label: "tf_base_r", min: -180, max: 180, step: 0.0001, neutral: 0, format: plain(4) },
        ...(["tf_base_v", "tf_base_h"] as const).map((id) => ({
          id, label: id, min: -2, max: 2, step: 0.00001, neutral: 0, format: plain(5) })),
        { id: "tf_gn", label: "tf_gn", min: 0, max: MAX_GUIDES, step: 1, neutral: 0, format: plain(0) },
        ...GUIDE_IDS.map((id) => ({ id, label: id, min: -1, max: 2, step: 0.00001, neutral: 0, format: plain(5) })),
      ],
    }],
  },
  {
    id: "effects", title: "Effects",
    sections: [
      {
        title: "Post-Crop Vignetting",
        controls: [
          lr("vig_amount", "Amount", { neutral: 0 }),
          { id: "vig_midpoint", label: "Midpoint", min: 0, max: 100, step: 1, neutral: 50, format: plain(0) },
          lr("vig_roundness", "Roundness", { neutral: 0 }),
          { id: "vig_feather", label: "Feather", min: 0, max: 100, step: 1, neutral: 50, format: plain(0) },
        ],
      },
      {
        title: "Grain", presets: GRAIN_PRESETS,
        controls: [
          { id: "grain_amount", label: "Amount", min: 0, max: 100, step: 1, neutral: 0, format: plain(0) },
          { id: "grain_size", label: "Size", min: 0, max: 100, step: 1, neutral: 25, format: plain(0) },
        ],
      },
    ],
  },
  {
    // the point curve's state, edited on the curve rather than with sliders
    id: "tonecurve-points", title: "Point Curve", hidden: true,
    sections: [{
      title: "Points",
      controls: [
        { id: "tc_mode", label: "mode", min: 0, max: 1, step: 1, neutral: 1, format: plain(0) },
        // the master curve's points, then each channel's
        ...(["rgb", ...CHANNELS] as const).flatMap((c) => {
          const pre = curvePrefix(c), lin = pointValues([[0, 0], [1, 1]], c);
          return [
            { id: `${pre}pn`, label: "points", min: 2, max: MAX_NODES, step: 1, neutral: 2, format: plain(0) },
            ...pointIds(pre).slice(1).map((id) => ({ id, label: id, min: 0, max: 1, step: 0.0001,
                                                     neutral: lin[id], format: plain(4) })),
          ];
        }),
      ],
    }],
  },
  {
    id: "crop", title: "Crop", hidden: true,
    sections: [{
      title: "Crop",
      controls: [
        ...(["crop_l", "crop_t"] as const).map((id) => ({
          id, label: id, min: 0, max: 1, step: 0.0001, neutral: 0, format: plain(4) })),
        ...(["crop_r", "crop_b"] as const).map((id) => ({
          id, label: id, min: 0, max: 1, step: 0.0001, neutral: 1, format: plain(4) })),
        // the ratio parts are whole numbers; -1 is the module's own default
        ...(["crop_rd", "crop_rn"] as const).map((id) => ({
          id, label: id, min: -1, max: 10000, step: 1, neutral: 0, format: plain(0) })),
      ],
    }],
  },
  // turned by the crop tool's buttons; darktable's dt_image_orientation_t
  {
    id: "orientation", title: "Orientation", hidden: true,
    sections: [{
      title: "Orientation",
      controls: [{ id: "orient", label: "Orientation", min: 0, max: 7, step: 1, format: plain(0) }],
    }],
  },
  // moved by dragging the vignette guides' center (VignetteOverlay)
  {
    id: "vignette-center", title: "Vignette Center", hidden: true,
    sections: [{
      title: "Vignette Center",
      controls: (["vig_cx", "vig_cy"] as const).map((id) => ({
        id, label: id, min: -1, max: 1, step: 0.001, neutral: 0, format: plain(3) })),
    }],
  },
  // what Preferences adds to a new raw's exposure; not a per-photo adjustment
  {
    id: "exposure-compensation", title: "Exposure Compensation", hidden: true,
    sections: [{
      title: "Exposure Compensation",
      controls: [{ id: "exp_comp", label: "Exposure Compensation", min: -3, max: 3, step: 0.01, neutral: 0,
                   format: signed(2, " EV") }],
    }],
  },
  // how scene light is fitted to the screen: AgX, set on a new photo, or
  // sigmoid on one started under it. not a per-photo adjustment
  {
    id: "tonemapper", title: "Tone Mapper", hidden: true,
    sections: [{
      title: "Tone Mapper",
      controls: [{ id: "tm_mode", label: "Tone Mapper", kind: "choice", min: 0, max: 1, step: 1, neutral: 0,
                   options: [["Sigmoid", 0], ["AgX", 1]], format: (v) => (v ? "AgX" : "Sigmoid") },
                 // AgX's range, no neutral of its own: the image's defaults
                 { id: "agx_black", label: "Black Relative Exposure", min: -20, max: -0.1, step: 0.01, format: signed(2, " EV") },
                 { id: "agx_white", label: "White Relative Exposure", min: 0.1, max: 20, step: 0.01, format: signed(2, " EV") }],
    }],
  },
  // which module each of MODULE_CHOICES' tools runs on for this photo. its
  // neutral is what Preferences picks, set when the photo opens
  {
    id: "modules", title: "Modules", hidden: true,
    sections: [{
      title: "Modules",
      controls: MODULE_CHOICES.map((c) => ({
        id: c.control, label: c.label, kind: "choice" as const, min: 0, max: c.options.length - 1, step: 1,
        neutral: preferredChoice(c), options: c.options.map((o) => [o.name, o.value] as [string, number]),
        format: (v: number) => c.options.find((o) => o.value === v)?.name ?? "",
      })),
    }],
  },
];

export const allControls = panels.flatMap((p) => p.sections.flatMap((s) => s.controls));
export const controlById = new Map(allControls.map((c) => [c.id, c]));
export const mapOf = new Map(modules.flatMap((m) => m.controls.map((id) => [id, m] as const)));
export const mapsFor = (op: string) => modules.filter((m) => m.op === op);
// every map a control drives: most drive one, the tone mapper's two
export const mapsWith = (id: string) => modules.filter((m) => m.controls.includes(id));

// darktable's names for the modules, as its darkroom lists them
const MODULE_NAMES: Record<string, string> = {
  agx: "AgX", ashift: "rotate and perspective", bilat: "local contrast", channelmixerrgb: "color calibration",
  cacorrectrgb: "chromatic aberrations", colorbalancergb: "color balance rgb", colorequal: "color equalizer",
  crop: "crop", defringe: "defringe", demosaic: "demosaic",
  denoiseprofile: "denoise (profiled)", diffuse: "diffuse or sharpen", exposure: "exposure", flip: "orientation",
  grain: "grain", hazeremoval: "haze removal", hotpixels: "hot pixels", lens: "lens correction", rgbcurve: "rgb curve",
  shadhi: "shadows and highlights", sharpen: "sharpen", sigmoid: "sigmoid", tonecurve: "tone curve",
  toneequal: "tone equalizer", vignette: "vignetting",
};
export const moduleName = (op: string) => {
  const real = op.split("#")[0];
  return MODULE_NAMES[real] ?? real;
};

// what Preferences' Modules tab lists: each panel's tools with the modules
// they run on, and a row for each choice between modules; choices for
// masks' sliders alone, under Masks
export type ModuleTool = { title: string; modules: string[]; choice?: ModuleChoice };
export const moduleTools = (): { panel: string; tools: ModuleTool[] }[] => {
  const listed = new Set<ModuleChoice>();
  const out = panels.filter((p) => !p.hidden).map((p) => ({
    panel: p.title,
    tools: p.sections.flatMap((s): ModuleTool[] => {
      const ids = s.controls.map((c) => c.id);
      const choices = MODULE_CHOICES.filter((c) => choiceCovers(c).some((id) => ids.includes(id)));
      choices.forEach((c) => listed.add(c));
      const covered = new Set(choices.flatMap(choiceCovers));
      // sigmoid runs only on photos started under it; new ones get AgX
      const modules = [...new Set(ids.filter((id) => !covered.has(id))
        .flatMap((id) => mapsWith(id).filter((m) => !m.choice && m.op !== "sigmoid").map((m) => moduleName(m.op))))];
      return [...(modules.length ? [{ title: s.title, modules }] : []),
              ...choices.map((c) => ({ title: c.label, modules: [], choice: c }))];
    }),
  })).filter((p) => p.tools.length);
  const masks = MODULE_CHOICES.filter((c) => !listed.has(c));
  if (masks.length) out.push({ panel: "Masks", tools: masks.map((c) => ({ title: c.label, modules: [], choice: c })) });
  return out;
};

// every mapped field, grouped by module, as the engine's `get` wants it
export const boundFields = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const m of modules) out[m.op] = [...new Set([...(out[m.op] ?? []), ...m.fields])];
  return out;
};

// ------------------------------------------------------- mask adjustments
// Lightroom's local sliders. each mask drives its own instance of these
// modules, named after the mask, starting from neutral rather than the
// image's defaults: a local exposure of 0 must add nothing, where the
// image's own exposure instance starts at darktable's +0.7 EV

const withFulcrum = (m: ModuleMap): ModuleMap => ({
  ...m,
  controls: [...m.controls, "l_fulcrum"],
  fields: [...m.fields, "grey_fulcrum"],
  read: (p, d, c) => ({ ...m.read(p, d, c), l_fulcrum: Math.log2((p.grey_fulcrum || ZONE_GRAY) / ZONE_GRAY) }),
  write: (v, d, c) => ({ ...m.write(v, d, c), grey_fulcrum: ZONE_GRAY * 2 ** (v.l_fulcrum ?? 0) }),
});

export const LOCAL_CONTROLS: Control[] = [
  { ...lr("l_temp", "Temp"), track: "linear-gradient(90deg, #4f7fd6, #e8e3d0, #e0a640)" },
  { ...lr("l_tint", "Tint"), track: "linear-gradient(90deg, #4caf50, #e8e3d0, #d05fd0)" },
  { id: "l_exposure", label: "Exposure", min: -4, max: 4, step: 0.01, neutral: 0, format: signed(2) },
  lr("l_contrast", "Contrast"),
  { id: "l_fulcrum", label: "Contrast pivot", min: -6, max: 6, step: 0.1, neutral: 0, format: signed(1, " EV") },
  lr("l_highlights", "Highlights"),
  lr("l_shadows", "Shadows"),
  lr("l_whites", "Whites"),
  lr("l_blacks", "Blacks"),
  lr("l_texture", "Texture"),
  lr("l_clarity", "Clarity"),
  lr("l_dehaze", "Dehaze"),
  { ...lr("l_hue", "Hue"), track: hueRamp(0, 180) },
  lr("l_saturation", "Saturation"),
  // as the global Amount: diffuse's iterations, 0 off
  { ...lr("l_sharpness", "Sharpening"), min: 0, max: SHARPEN_MAX_ITERATIONS, format: plain(0) },
  // or as sharpen's Amount
  { ...lr("l_usm", "Sharpening"), min: 0, format: plain(0) },
  { ...lr("l_noise", "Noise"), min: 0 },
  { ...lr("l_defringe", "Defringe"), min: 0 },
  ...HSL_TABS.flatMap((t) => hslControls("l_hsl", t)),
  ...RANGES.flatMap(([r]) => gradingControls("l_cg", r)),
].map((c) => ({ neutral: 0, ...c }));

export const localMaps: ModuleMap[] = [
  {
    op: "channelmixerrgb", keepOn: false,
    controls: ["l_temp", "l_tint"],
    fields: ["illuminant", "x", "y"],
    read: (p) => {
      if (p.illuminant !== ILLUMINANT_CUSTOM) return { l_temp: 0, l_tint: 0 };
      const wb = readLocalIlluminant(p.x, p.y);
      return { l_temp: wb.temp, l_tint: wb.tint };
    },
    write: (v) => {
      const [x, y] = localIlluminant(v.l_temp, v.l_tint);
      return { illuminant: ILLUMINANT_CUSTOM, x, y };
    },
  },
  exposureMap(false, "l_exposure", "l_blacks", () => ({ exposure: 0, black: 0 })),
  // Whites as the highlights' brilliance, as the global Whites has on AgX:
  // the tone mapper, which carries the rest of it, cannot run under a mask,
  // and the highlights' gain (highlights_Y) is Color Grading's. Hue turns
  // every hue by up to ±30 degrees
  // l_fulcrum, the contrast's pivot in EV from middle gray, has no slider:
  // a zone mask sets it to its zones' middle (ZoneSystem.tsx)
  // some 30 ms a mask's draft frame, so its masks share instances
  {
    ...withFulcrum(linear("colorbalancergb", false, [
      { id: "l_contrast", field: "contrast", scale: 0.01, base: 0 },
      { id: "l_saturation", field: "saturation_global", scale: 0.01, base: 0 },
      { id: "l_whites", field: "brilliance_highlights", scale: 0.004, base: 0 },
      { id: "l_hue", field: "hue_angle", scale: 0.3, base: 0 },
      ...gradingFields("l_cg"),
    ])),
    merge: true,
    fixed: ["l_hue", "l_fulcrum", ...RANGES.map(([r]) => `l_cg_${r}_hue`)],
  },
  // HSL as the main panel's in color, on the mask's own color equalizer
  // some 60 ms a mask's draft frame, so its masks share instances; a Hue
  // turns colors, which a mask's strength cannot scale
  {
    op: "colorequal", keepOn: false,
    controls: BANDS.flatMap(([b]) => [`l_hsl_hue_${b}`, `l_hsl_sat_${b}`, `l_hsl_lum_${b}`]),
    fields: BANDS.flatMap(([b]) => [`hue_${b}`, `sat_${b}`, `bright_${b}`]),
    read: (p) => readHSL("l_hsl", p),
    write: (v) => writeHSL("l_hsl", v),
    merge: true,
    fixed: BANDS.map(([b]) => `l_hsl_hue_${b}`),
  },
  // Highlights and Shadows as the photo's are: the tone equalizer, or
  // shadows and highlights
  {
    ...linear("shadhi", false, [
      { id: "l_highlights", field: "highlights", scale: 1, base: 0 },
      { id: "l_shadows", field: "shadows", scale: 1, base: 0 },
    ]),
    choice: { control: "mod_tone", value: MOD_SHADHI },
  },
  {
    op: "toneequal", keepOn: false, choice: { control: "mod_tone", value: MOD_TONEEQ },
    controls: ["l_highlights", "l_shadows"],
    fields: [...TONE_NODES, "exposure_boost", "contrast_boost"],
    read: (p) => ({ l_shadows: (100 * p[TONE_NODES[TONE_SHADOWS_NODE]]) / TONE_EV,
                    l_highlights: (100 * p[TONE_NODES[TONE_HIGHLIGHTS_NODE]]) / TONE_EV }),
    write: (v) => ({ ...toneNodes(v.l_shadows, v.l_highlights), ...TONE_MASK }),
  },
  // some 40 ms a mask's draft frame, so its masks share instances: the
  // speeds follow the slider in proportion, as a mask's strength scales them
  {
    op: "diffuse", keepOn: false, merge: true,
    controls: ["l_texture"],
    fields: [...Object.keys(TEXTURE_SPEEDS), ...Object.keys(TEXTURE_FIXED)],
    read: (p) => ({ l_texture: textureRead(p) }),
    write: (v) => textureWrite(v.l_texture),
  },
  linear("bilat", false, [{ id: "l_clarity", field: "detail", scale: 0.01, base: 0 }]),
  linear("hazeremoval", false, [{ id: "l_dehaze", field: "strength", scale: 0.01, base: 0 }]),
  {
    // as the global Noise Reduction: darktable's strength 1.0 at 50. Some
    // 38 ms a mask's draft frame, so its masks share instances
    op: "denoiseprofile", keepOn: false, merge: true,
    controls: ["l_noise"],
    fields: ["strength"],
    read: (p) => ({ l_noise: p.strength * 50 }),
    write: (v) => ({ strength: Math.max(0.001, v.l_noise / 50) }),
  },
  {
    // Defringe on chromatic aberrations, as the AgX workflow corrects them.
    // Some 18 ms a mask's draft frame, so its masks share instances
    op: "cacorrectrgb", keepOn: false, merge: true, choice: { control: "mod_defringe", value: MOD_CA },
    controls: ["l_defringe"],
    fields: ["strength"],
    read: (p) => ({ l_defringe: (100 * p.strength) / CA_STRENGTH }),
    write: (v) => ({ strength: (CA_STRENGTH * v.l_defringe) / 100 }),
  },
  {
    // or on defringe: more Defringe catches fainter fringes, the threshold
    // falling from 40 toward 5, at the module's default radius
    op: "defringe", keepOn: false, choice: { control: "mod_defringe", value: MOD_DEFRINGE },
    controls: ["l_defringe"],
    fields: ["thresh"],
    read: (p) => ({ l_defringe: Math.max(0, ((40 - p.thresh) / 35) * 100) }),
    write: (v) => ({ thresh: 40 - (35 * v.l_defringe) / 100 }),
  },
  {
    // as the global Sharpening, at its default radius and sensitivity, on a
    // second diffuse instance beside the mask's Texture one
    op: "diffuse#sharpen", keepOn: false, choice: { control: "mod_sharpening", value: MOD_DIFFUSE },
    controls: ["l_sharpness"],
    fields: [...Object.keys(SHARPEN_FIXED), "iterations", "radius", "regularization"],
    read: (p) => ({ l_sharpness: p.iterations }),
    write: (v) => ({ ...SHARPEN_FIXED, iterations: Math.max(1, v.l_sharpness), radius: SHARPEN_RADIUS,
                     regularization: SHARPEN_SENSITIVITY }),
  },
  {
    // or on sharpen, when the photo's Sharpening is, at its default radius
    // and threshold
    op: "sharpen", keepOn: false, choice: { control: "mod_sharpening", value: MOD_SHARPEN },
    controls: ["l_usm"],
    fields: ["amount", "radius", "threshold"],
    read: (p) => ({ l_usm: p.amount * USM_AMOUNT }),
    write: (v) => ({ amount: v.l_usm / USM_AMOUNT, radius: USM_RADIUS, threshold: 0.5 }),
  },
];

export const localControlById = new Map(LOCAL_CONTROLS.map((c) => [c.id, c]));
export const localMapOf = new Map(localMaps.flatMap((m) => m.controls.map((id) => [id, m] as const)));
// the fields to read back from each mask's instances
export const localFields = () => Object.fromEntries(localMaps.map((m) => [m.op, m.fields]));
