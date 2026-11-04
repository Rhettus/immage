// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// film simulation through darktable's spektrafilm (src/iop/spektrafilm.c,
// darktable 879067695e): its params as the Film Simulation panel shows
// them, how it names a stock, and its presets. the module's film and paper
// lists are made by its GUI alone, so the engine reads the data pack's
// profiles for them (`spektra_stocks`, engine main.c)

import type { Values } from "./manifest";

// a profile in the pack: a film (printing false) or a paper
export type Stock = {
  hash: number; stock: string; name: string; printing: boolean; positive: boolean; bw: boolean;
  target_print: string; dev_times: number[];
};
export type Pack = { dir: string; lut_id: string; lut_hash: number; hand_installed: boolean };
export type Stocks = { pack: Pack | null; stocks: Stock[] };
export type FetchStatus = { state: "idle" | "running" | "done" | "failed"; message: string; progress: number;
                            started?: boolean };

// the module's _name_hash(): darktable's dt_hash (djb2, xor variant) of the
// stock name, folded to 32 bits, 0 kept for "the default stock"
export function stockHash(stock: string): number {
  let h = 5381n;
  for (const b of new TextEncoder().encode(stock)) h = (((h << 5n) + h) ^ BigInt(b)) & 0xffffffffffffffffn;
  const folded = Number((h ^ (h >> 32n)) & 0xffffffffn);
  return folded || 1;
}

// the film a hash of 0, or one the pack no longer has, renders with
// (spektrafilm.c, _current_film_entry(), _resolve_stock())
export function filmOf(stocks: Stock[], hash: number): Stock | undefined {
  const films = stocks.filter((s) => !s.printing);
  return (hash ? films.find((s) => s.hash === hash) : undefined)
    ?? films.find((s) => s.stock === "kodak_gold_200") ?? films[0];
}
// the paper "auto" prints on: the film's target print, else a paper of its
// channel model, else the first (spektrafilm.c, _auto_paper_entry())
export function autoPaper(stocks: Stock[], film: Stock | undefined): Stock | undefined {
  const papers = stocks.filter((s) => s.printing);
  return (film?.target_print ? papers.find((s) => s.stock === film.target_print) : undefined)
    ?? (film ? papers.find((s) => s.bw === film.bw) : undefined) ?? papers[0];
}
export function paperOf(stocks: Stock[], hash: number, film: Stock | undefined): Stock | undefined {
  return (hash ? stocks.find((s) => s.printing && s.hash === hash) : undefined) ?? autoPaper(stocks, film);
}
// a stock's representative development time, which choosing it sets
// (spektrafilm.c, _development_default()); 0 is the stock's own default
export const developmentDefault = (s: Stock | undefined) =>
  s && s.dev_times.length > 1 ? s.dev_times[Math.floor((s.dev_times.length - 1) / 2)] : 0;

// what choosing a film sets, as the module's _film_changed() does: its
// development time, and a positive's direct scan with its black and white
// point fitted; a negative goes back to the print, its paper's time set again
// when the paper follows the film
export function filmChanges(stocks: Stock[], v: Values, film: Stock): [string, number][] {
  const out: [string, number][] = [["sf_film_hash", film.hash], ["sf_development_min", developmentDefault(film)]];
  if ((v.sf_scan_film === 1) !== film.positive) {
    const on = film.positive ? 1 : 0;
    out.push(["sf_scan_film", on], ["sf_scan_black_correction", on], ["sf_scan_white_correction", on]);
  }
  if (!v.sf_paper_hash) out.push(["sf_print_development_min", developmentDefault(autoPaper(stocks, film))]);
  return out;
}
// the paper menu's entries that are not papers
export const PAPER_AUTO = 0;
export const PAPER_SCAN = -1;
// what choosing a paper sets (spektrafilm.c, _paper_changed())
export function paperChanges(stocks: Stock[], v: Values, pick: number): [string, number][] {
  const scan: [string, number] = ["sf_scan_film", pick === PAPER_SCAN ? 1 : 0];
  if (pick === PAPER_AUTO || pick === PAPER_SCAN)
    return [scan, ["sf_paper_hash", 0],
            ["sf_print_development_min", developmentDefault(autoPaper(stocks, filmOf(stocks, v.sf_film_hash)))]];
  const paper = stocks.find((s) => s.printing && s.hash === pick);
  return paper ? [scan, ["sf_paper_hash", paper.hash], ["sf_print_development_min", developmentDefault(paper)]] : [];
}

// a param as a control: sf_<field>. the range is darktable's soft range,
// where it has one, with values past it kept (readsPast); `bool` a switch,
// `menu` one of the diffusion filters
export type SfField = {
  field: string; label: string; min: number; max: number; step: number; digits: number;
  unit?: string; signed?: boolean; bool?: boolean; menu?: boolean; soft?: boolean; note: string;
};
const f = (field: string, label: string, min: number, max: number, step: number, digits: number, note: string,
           extra: Partial<SfField> = {}): SfField => ({ field, label, min, max, step, digits, note, ...extra });
const bool = (field: string, label: string, note: string): SfField =>
  ({ field, label, min: 0, max: 1, step: 1, digits: 0, bool: true, note });
export const DIFFUSION_FILTERS: [string, number][] = [["Black Pro-Mist", 0], ["Glimmerglass", 1], ["Pro-Mist", 2],
                                                       ["CineBloom", 3]];
export const SF_FIELDS: SfField[] = [
  // the stocks: hashes, chosen from the pack's lists (FilmPanel.tsx)
  f("film_hash", "Film Stock", 0, 0xffffffff, 1, 0, "darktable: film stock"),
  f("paper_hash", "Print Paper", 0, 0xffffffff, 1, 0, "darktable: print paper"),
  bool("scan_film", "Scan the Film", "the developed film scanned directly, without a print (darktable: scan the film (skip print))"),
  f("film_format_mm", "Frame Size", 8, 130, 0.1, 1, "the frame's long edge on the film: smaller frames show more grain "
    + "and halation (darktable: frame long edge)", { unit: " mm", soft: true }),
  // film
  f("exposure_ev", "Film Exposure", -4, 4, 0.01, 2, "the exposure given to the film (darktable: film exposure)",
    { unit: " EV", signed: true, soft: true }),
  f("push_pull_stops", "Push / Pull", -4, 4, 0.05, 2, "development pushed for more contrast, or pulled for less "
    + "(darktable: push/pull)", { unit: " stops", signed: true }),
  f("development_min", "Development Time", 0, 15, 0.5, 1, "for black and white stocks measured at several "
    + "times; 0 is the stock's own (darktable: development time)", { unit: " min" }),
  f("film_gamma_factor", "Development Gamma", 0.25, 2, 0.01, 2, "darktable: development gamma", { soft: true }),
  f("film_gamma_factor_fast", "Fast Layer Gamma", 0.25, 2, 0.01, 2, "darktable: fast layer gamma", { soft: true }),
  f("film_gamma_factor_slow", "Slow Layer Gamma", 0.25, 2, 0.01, 2, "darktable: slow layer gamma", { soft: true }),
  f("film_developer_exhaustion", "Developer Exhaustion", 0, 1, 0.01, 2, "darktable: developer exhaustion"),
  f("couplers_amount", "DIR Couplers", 0, 1, 0.01, 2, "the film's own color separation and edge "
    + "sharpness (darktable: DIR couplers)"),
  f("couplers_inhibition_same", "Same-Layer Inhibition", 0, 3, 0.01, 2, "darktable: same-layer inhibition"),
  f("couplers_inhibition_inter", "Interlayer Inhibition", 0, 3, 0.01, 2, "darktable: interlayer inhibition"),
  f("couplers_diffusion_um", "Inhibitor Spread", 0, 60, 0.1, 1, "darktable: inhibitor spread", { unit: " µm" }),
  f("couplers_tail_um", "Spread Tail", 0, 400, 1, 0, "darktable: spread tail", { unit: " µm" }),
  f("couplers_tail_weight", "Tail Weight", 0, 1, 0.01, 2, "darktable: tail weight"),
  bool("diffusion_on", "Diffusion Filter", "a diffusion filter on the camera's lens (darktable: enable diffusion filter)"),
  f("diffusion_filter_family", "Filter Type", 0, 3, 1, 0, "darktable: diffusion filter type", { menu: true }),
  f("diffusion_strength", "Diffusion Strength", 0, 2, 0.001, 3, "darktable: diffusion strength"),
  f("diffusion_scale", "Diffusion Size", 0.2, 4, 0.01, 2, "darktable: diffusion size"),
  f("diffusion_warmth", "Halo Warmth", -1.5, 1.5, 0.01, 2, "darktable: diffusion halo warmth", { signed: true }),
  bool("adaptation_bandwidth", "Bandwidth Adaptation", "darktable: bandwidth adaptation"),
  bool("adaptation_surface", "Surface Adaptation", "darktable: surface adaptation"),
  bool("gamut_compress", "Gamut Compression", "keeps saturated colors and the brightest highlights inside the "
    + "output: off, both run further (darktable: gamut compression)"),
  // print
  f("print_exposure_ev", "Print Exposure", -3, 3, 0.01, 2, "the enlarger's exposure, or with Auto Print Exposure "
    + "a change to it (darktable: print exposure compensation)", { unit: " EV", signed: true }),
  bool("print_auto_exposure", "Auto Print Exposure", "darktable: auto print exposure"),
  f("print_contrast", "Print Contrast", 0.5, 2, 0.01, 2, "darktable: print gamma"),
  f("print_development_min", "Print Development Time", 0, 15, 0.5, 1, "for papers measured at several times; 0 is "
    + "the paper's own (darktable: development time)", { unit: " min" }),
  f("print_gamma_r", "Red Contrast", 0.5, 2, 0.01, 2, "darktable: print gamma red"),
  f("print_gamma_g", "Green Contrast", 0.5, 2, 0.01, 2, "darktable: print gamma green"),
  f("print_gamma_b", "Blue Contrast", 0.5, 2, 0.01, 2, "darktable: print gamma blue"),
  f("filter_m", "Magenta Filtration", -60, 60, 0.01, 2, "the enlarger's magenta filter: right adds magenta to the "
    + "print, left green (darktable: filtration M)", { unit: " CC", signed: true }),
  f("filter_y", "Yellow Filtration", -60, 60, 0.01, 2, "the enlarger's yellow filter: right adds yellow to the "
    + "print, left blue (darktable: filtration Y)", { unit: " CC", signed: true }),
  f("preflash_exposure", "Preflash", 0, 0.5, 0.01, 2, "a flash of light on the paper before the print, which "
    + "lifts the shadows (darktable: preflash exposure)", { soft: true }),
  f("preflash_m_shift", "Preflash Magenta", -60, 60, 0.01, 2, "darktable: preflash M filter shift",
    { unit: " CC", signed: true }),
  f("preflash_y_shift", "Preflash Yellow", -60, 60, 0.01, 2, "darktable: preflash Y filter shift",
    { unit: " CC", signed: true }),
  bool("print_diffusion_on", "Print Diffusion", "a diffusion filter on the enlarger (darktable: enable print diffusion)"),
  f("print_diffusion_filter_family", "Print Filter Type", 0, 3, 1, 0, "darktable: print diffusion filter type",
    { menu: true }),
  f("print_diffusion_strength", "Print Diffusion Strength", 0, 2, 0.001, 3, "darktable: print diffusion strength"),
  f("print_diffusion_scale", "Print Diffusion Size", 0.2, 4, 0.01, 2, "darktable: print diffusion size"),
  f("print_diffusion_warmth", "Print Halo Warmth", -1.5, 1.5, 0.01, 2, "darktable: print diffusion halo warmth",
    { signed: true }),
  // grain
  bool("grain_on", "Grain", "darktable: enable grain"),
  f("grain_amount", "Grain Strength", 0, 2, 0.01, 2, "darktable: grain strength", { soft: true }),
  f("grain_granularity", "Grain Size", 0.25, 2.5, 0.01, 2, "bigger crystals, fewer of them: coarser grain "
    + "(darktable: granularity)", { soft: true }),
  f("grain_uniformity", "Uniformity", 0.9, 1.02, 0.001, 3, "darktable: uniformity", { soft: true }),
  f("grain_sublayer_scale", "Sublayer Particle Scale", 0, 2, 0.01, 2, "darktable: sublayer particle scale"),
  f("grain_density_min", "Density Floor", 0.25, 2.5, 0.01, 2, "darktable: density floor", { soft: true }),
  f("grain_blur", "Grain Softness", 0.2, 4, 0.01, 2, "softens the grain without making it coarser "
    + "(darktable: grain blur)"),
  f("grain_dye_cloud", "Dye Cloud Size", 0, 4, 0.01, 2, "darktable: dye cloud size"),
  f("grain_usm_sigma", "Recovery Radius", 0, 3, 0.01, 2, "darktable: recovery radius"),
  f("grain_usm_amount", "Recovery Strength", 0, 2, 0.01, 2, "darktable: recovery strength"),
  // halation
  bool("halation_on", "Halation", "light scattered in the film and reflected off its base: a red glow around "
    + "bright edges (darktable: enable halation and scatter)"),
  f("halation_amount", "Halation Strength", 0, 2, 0.01, 2, "darktable: halation strength", { soft: true }),
  f("halation_scale", "Halation Size", 0.2, 4, 0.01, 2, "darktable: halation size"),
  f("scatter_amount", "Scatter", 0, 1, 0.01, 2, "darktable: scatter amount"),
  f("scatter_scale", "Scatter Size", 0.2, 1.5, 0.01, 2, "darktable: scatter size", { soft: true }),
  f("boost_ev", "Highlight Boost", 0, 10, 0.01, 2, "darktable: highlight boost", { unit: " EV" }),
  f("boost_range", "Boost Range", 0, 1, 0.01, 2, "darktable: boost range"),
  f("protect_ev", "Boost Protect", 0, 6, 0.01, 2, "darktable: boost protect", { unit: " EV" }),
  // scanner
  f("output_luminance_boost", "Brightness", 0.5, 4, 0.01, 2, "brightens before the gamut compression, which also "
    + "softens the most saturated colors (darktable: pre-compression boost)"),
  f("output_scale", "Output Level", 0.5, 4, 0.01, 2, "brightens after the gamut compression, keeping the colors "
    + "(darktable: post-compression scale)"),
  f("scan_blur", "Scanner Blur", 0, 4, 0.01, 2, "darktable: scanner blur"),
  f("scan_usm_sigma", "Sharpen Radius", 0, 3, 0.01, 2, "darktable: scanner sharpen radius"),
  f("scan_usm_amount", "Sharpen Strength", 0, 2, 0.01, 2, "darktable: scanner sharpen strength"),
  f("glare_percent", "Viewing Glare", 0, 1, 0.01, 2, "light reflected off the print as it is viewed, which lifts "
    + "its blacks (darktable: viewing glare)"),
  bool("scan_black_correction", "Black Point Correction", "darktable: black point correction"),
  f("scan_black_level", "Black Level", -0.1, 1, 0.001, 3, "darktable: black level"),
  bool("scan_white_correction", "White Point Correction", "darktable: white point correction"),
  f("scan_white_level", "White Level", 0, 1, 0.001, 3, "darktable: white level"),
  // no control in darktable either: the presets set it (spektrafilm.c)
  f("grain_blur_base", "Grain Blur Base", 0.5, 1.5, 0.01, 2, "darktable: the grain's base blur"),
];
export const sfId = (field: string) => `sf_${field}`;

// _preset_defaults(): the presets' starting point, each field not named
// here at 0. not the $DEFAULTs, which have moved on since the presets were
// made (grain_blur_base)
const PRESET_BASE: Record<string, number> = {
  print_contrast: 1, print_gamma_r: 1, print_gamma_g: 1, print_gamma_b: 1, grain_blur_base: 0.8,
  scan_black_level: 0.01, scan_white_level: 0.98, couplers_amount: 1, couplers_diffusion_um: 20,
  couplers_tail_um: 200, couplers_tail_weight: 0.03, couplers_inhibition_same: 1, couplers_inhibition_inter: 1,
  halation_on: 1, scatter_amount: 1, scatter_scale: 1, halation_amount: 1, halation_scale: 1, boost_range: 0.3,
  protect_ev: 4, diffusion_strength: 0.5, diffusion_scale: 1, print_diffusion_strength: 0.5,
  print_diffusion_scale: 1, grain_on: 1, grain_amount: 1, grain_blur: 1, grain_granularity: 1,
  grain_uniformity: 1, grain_sublayer_scale: 1, grain_density_min: 1, grain_dye_cloud: 1, film_format_mm: 36,
  output_luminance_boost: 1, output_scale: 1, grain_usm_sigma: 0.7, grain_usm_amount: 1.5, film_gamma_factor: 1,
  film_gamma_factor_fast: 1, film_gamma_factor_slow: 1, scan_usm_sigma: 0.7, scan_usm_amount: 0.7,
  adaptation_bandwidth: 1, gamut_compress: 1,
};

// init_presets(): darktable's built-in presets, "group|name", each over
// PRESET_BASE, the stocks by name
export type SfPreset = { name: string; film: string | null; paper: string | null; params: Record<string, number> };
export const SF_PRESETS: SfPreset[] = [
  { name: "scene-referred default", film: null, paper: null,
    params: { grain_blur_base: 0.89 } },
  { name: "look|crisp black and white", film: "kodak_trix", paper: null,
    params: { exposure_ev: 1.05, couplers_diffusion_um: 5, couplers_tail_um: 30, scan_film: 1, scan_black_correction: 1, scan_white_correction: 1, halation_amount: 2, halation_scale: 4, diffusion_on: 1, diffusion_strength: 0.375, grain_amount: 0.7, grain_blur: 0.75, grain_granularity: 0.7, grain_uniformity: 0.9, film_format_mm: 24, output_luminance_boost: 1.3, output_scale: 1.3, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.9, film_gamma_factor_fast: 1.3, film_gamma_factor_slow: 2, push_pull_stops: 1.3, scan_usm_sigma: 1.7, scan_usm_amount: 1, adaptation_bandwidth: 0 } },
  { name: "film|black and white", film: "kodak_trix", paper: null,
    params: { exposure_ev: -0.7, couplers_diffusion_um: 5, couplers_tail_um: 30, scan_film: 1, scan_black_correction: 1, scan_white_correction: 1, grain_blur: 0.75, grain_granularity: 0.4, output_scale: 1.65, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 1.7, film_gamma_factor_fast: 0.4, film_gamma_factor_slow: 0.6, push_pull_stops: -0.7, scan_usm_sigma: 1.7, scan_usm_amount: 1, adaptation_bandwidth: 0 } },
  { name: "look|split-toned", film: "kodak_doublex", paper: "fujifilm_crystal_archive_typeii",
    params: { exposure_ev: -0.7, filter_m: 5, filter_y: -3, couplers_diffusion_um: 5, couplers_tail_um: 30, preflash_exposure: 0.03, diffusion_on: 1, diffusion_strength: 0.25, grain_blur: 0.75, grain_granularity: 0.5, output_scale: 1.2, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 1.7, film_gamma_factor_fast: 0.5, film_gamma_factor_slow: 0.7, push_pull_stops: -1, scan_usm_sigma: 1.7, scan_usm_amount: 1, glare_percent: 0.03, development_min: 6.5, adaptation_bandwidth: 0 } },
  { name: "look|bleach bypass", film: "kodak_vision3_200t", paper: "kodak_2393",
    params: { exposure_ev: 1.39, filter_m: 4.43, filter_y: -0.15, couplers_amount: 0.99, couplers_inhibition_same: 3, couplers_inhibition_inter: 0, preflash_m_shift: -1.07, preflash_y_shift: -0.76, diffusion_on: 1, diffusion_filter_family: 3, diffusion_strength: 0.183, diffusion_scale: 4, diffusion_warmth: 0.01, film_format_mm: 24.89, film_gamma_factor: 0.72, film_gamma_factor_fast: 0.52, film_gamma_factor_slow: 1.69, push_pull_stops: 1.25, scan_usm_sigma: 2.73 } },
  { name: "film|cinema", film: "kodak_vision3_250d", paper: null,
    params: { exposure_ev: 0.26, filter_m: -3.75, filter_y: -7.5, couplers_inhibition_same: 1.93, couplers_inhibition_inter: 0.5, preflash_exposure: 0.02, preflash_m_shift: -30.22, preflash_y_shift: 35.74, output_luminance_boost: 1.19 } },
  { name: "look|kino 250D", film: "kodak_vision3_250d", paper: "kodak_2383",
    params: { exposure_ev: -0.7, print_contrast: 1.2, filter_m: -3, filter_y: -4.5, couplers_diffusion_um: 5, couplers_tail_um: 30, couplers_inhibition_same: 0.7, couplers_inhibition_inter: 0.6, preflash_exposure: 0.03, preflash_m_shift: 5, preflash_y_shift: 10, halation_amount: 2, halation_scale: 4, diffusion_on: 1, diffusion_strength: 0.125, diffusion_scale: 0.5, diffusion_warmth: -1.5, grain_amount: 0.5, grain_granularity: 0.9, output_luminance_boost: 1.9, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.9, film_gamma_factor_fast: 0.7, film_gamma_factor_slow: 1.1, push_pull_stops: -0.85, scan_usm_sigma: 1.4, scan_usm_amount: 0.8 } },
  { name: "film|classic", film: "kodak_kodachrome_64", paper: null,
    params: { couplers_diffusion_um: 23.6, couplers_inhibition_same: 1.54, couplers_inhibition_inter: 0.3, scan_film: 1, scan_black_correction: 1, scan_white_correction: 1, film_gamma_factor_slow: 1.32 } },
  { name: "film|contrast", film: "fujifilm_c200", paper: "kodak_endura_premier",
    params: { exposure_ev: 1.05, couplers_amount: 0.5, grain_amount: 2, film_format_mm: 24, film_gamma_factor: 0.9, film_gamma_factor_fast: 0.8, glare_percent: 0.75, adaptation_surface: 1 } },
  { name: "film|neutral", film: "fujifilm_xtra_400", paper: null,
    params: { couplers_amount: 0.5, output_luminance_boost: 1.5, output_scale: 1.2056, glare_percent: 0.25, adaptation_surface: 1 } },
  { name: "film|soft pastel", film: "fujifilm_c200", paper: "fujifilm_crystal_archive_typeii",
    params: { exposure_ev: 1, print_exposure_ev: -0.2, filter_m: 5, filter_y: -1, couplers_amount: 0.75, couplers_diffusion_um: 5, couplers_tail_um: 15, couplers_inhibition_inter: 0.9, preflash_exposure: 0.05, preflash_m_shift: -23.5, preflash_y_shift: -30, halation_scale: 3, print_diffusion_on: 1, print_diffusion_strength: 0.75, print_diffusion_scale: 0.5, grain_amount: 1.3, grain_granularity: 1.7, output_luminance_boost: 1.25, output_scale: 1.05, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.9, film_gamma_factor_fast: 0.9, film_gamma_factor_slow: 1.7, push_pull_stops: 0.8, scan_usm_sigma: 1.2, scan_usm_amount: 1 } },
  { name: "film|warm", film: "kodak_portra_800", paper: null,
    params: { exposure_ev: 0.53, print_exposure_ev: 0.13, filter_m: 10.37, filter_y: -2.87, couplers_inhibition_same: 1.51, couplers_inhibition_inter: 0.81, preflash_exposure: 0.04, preflash_m_shift: -28.46, preflash_y_shift: -33.97, output_luminance_boost: 1.64, film_gamma_factor_slow: 1.32, push_pull_stops: -0.32 } },
  { name: "film|portrait", film: "kodak_portra_400", paper: "kodak_endura_premier",
    params: { exposure_ev: 1.4, couplers_amount: 0.3, output_luminance_boost: 1.3, output_scale: 1.3, film_gamma_factor_fast: 0.64, film_gamma_factor_slow: 0.44, film_developer_exhaustion: 0.5, adaptation_surface: 1 } },
  { name: "film|portrait contrast", film: "kodak_portra_400", paper: "kodak_endura_premier",
    params: { couplers_amount: 0.25, film_developer_exhaustion: 0.45, glare_percent: 0.82 } },
  { name: "look|vivid", film: "fujifilm_velvia_100", paper: null,
    params: { exposure_ev: 0.9, couplers_diffusion_um: 5, couplers_tail_um: 15, couplers_inhibition_same: 1.2, couplers_inhibition_inter: 0.6, scan_film: 1, scan_black_correction: 1, scan_white_correction: 1, halation_scale: 4, output_scale: 1.3, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.8, film_gamma_factor_fast: 1.1, film_gamma_factor_slow: 2, push_pull_stops: 0.7, scan_usm_sigma: 1.5, scan_usm_amount: 1, adaptation_bandwidth: 0 } },
  { name: "look|skodachrome", film: "kodak_kodachrome_64", paper: null,
    params: { exposure_ev: 1.1, couplers_amount: 0.6, couplers_diffusion_um: 5, couplers_tail_um: 15, couplers_inhibition_inter: 0.6, scan_film: 1, scan_black_correction: 1, scan_white_correction: 1, halation_scale: 4, output_scale: 1.3, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.8, film_gamma_factor_fast: 1.1, film_gamma_factor_slow: 2, push_pull_stops: 0.8, scan_usm_sigma: 1.5, scan_usm_amount: 1, adaptation_bandwidth: 0 } },
  { name: "look|foliage", film: "kodak_gold_200", paper: "kodak_endura_premier",
    params: { exposure_ev: -0.2, print_contrast: 1.3, filter_m: 4.5, filter_y: 9.5, couplers_amount: 0.85, couplers_diffusion_um: 5, couplers_tail_um: 20, preflash_exposure: 0.03, diffusion_strength: 0.125, diffusion_scale: 0.5, diffusion_warmth: -1.5, grain_granularity: 1.1, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.9, film_gamma_factor_fast: 0.9, film_gamma_factor_slow: 1.1, push_pull_stops: 0.45, scan_usm_sigma: 1.2, adaptation_bandwidth: 0 } },
  { name: "look|glow", film: "kodak_gold_200", paper: "kodak_ultra_endura",
    params: { exposure_ev: 0.45, filter_m: 4, filter_y: -5, couplers_diffusion_um: 5, couplers_tail_um: 30, couplers_inhibition_same: 0.7, couplers_inhibition_inter: 0.6, preflash_exposure: 0.03, preflash_m_shift: 0.5, halation_amount: 2, halation_scale: 4, diffusion_on: 1, diffusion_strength: 0.125, diffusion_scale: 0.5, diffusion_warmth: -1.5, grain_granularity: 1.1, output_luminance_boost: 1.2, output_scale: 1.3, grain_usm_sigma: 0, grain_usm_amount: 0, film_gamma_factor: 0.9, film_gamma_factor_fast: 0.9, film_gamma_factor_slow: 1.1, push_pull_stops: 0.5, scan_usm_sigma: 1.2 } },
];
// a preset's group and name as the menu shows them: "look|vivid" → Look, Vivid
export const presetLabel = (name: string) => {
  const [group, rest] = name.includes("|") ? name.split("|") : ["", name];
  const cap = (s: string) => s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return { group: cap(group), label: cap(rest) };
};
// what a preset sets: every field, as darktable's preset replaces all of
// the module's params
export function presetValues(p: SfPreset): [string, number][] {
  const params = { ...PRESET_BASE, ...p.params };
  return SF_FIELDS.map((x): [string, number] => [sfId(x.field),
    x.field === "film_hash" ? (p.film ? stockHash(p.film) : 0)
      : x.field === "paper_hash" ? (p.paper ? stockHash(p.paper) : 0) : params[x.field] ?? 0]);
}
