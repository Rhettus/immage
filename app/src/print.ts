// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Print panel's settings, papers and page layout, and the soft proof
// they share. the engine prints (engine/print.c): darktable's printer
// profiles, PDF writer and CUPS or the Windows spooler. one photo per page,
// fitted inside the margins or at a size of its own, at one of nine places
import { invoke } from "@tauri-apps/api/core";

export type Unit = "mm" | "in";
export type Orientation = "auto" | "portrait" | "landscape";
// darktable's dt_iop_color_intent_t: 0 perceptual, 1 relative colorimetric
export type Intent = 0 | 1;
export type ProofMode = "off" | "proof" | "gamut";
export type Margins = { top: number; bottom: number; left: number; right: number };

// a paper, portrait, in millimeters; `name` is what the printer calls it
export type Paper = { name: string; label: string; width: number; height: number };
export type Medium = { name: string; label: string };
export type Profile = { name: string; file: string };
export type Printer = { name: string; description: string; default: boolean };
export type PrinterInfo = {
  resolution: number; margins: Margins; defaultPaper: string; papers: Paper[]; media: Medium[];
};

export const PDF = "";  // the destination that saves a PDF rather than printing

export type PrintSettings = {
  printer: string;   // PDF to save one
  paper: string;
  medium: string;
  orientation: Orientation;
  margins: Margins;
  // the photo's long edge in millimeters, or null to fill the margins
  size: number | null;
  alignment: number;  // 0 top left … 4 center … 8 bottom right, darktable's dt_alignment_t
  profile: string;    // a printer profile's file, or "" for the printer to manage color
  intent: Intent;
  bpc: boolean;
  dpi: number;        // a PDF's; a printer prints at its own
  unit: Unit;
};

const INCH = 25.4;
const inch = (name: string, label: string, w: number, h: number): Paper =>
  ({ name, label, width: w * INCH, height: h * INCH });
// a PDF's papers, as PWG names them so a saved choice matches a printer's
export const PDF_PAPERS: Paper[] = [
  inch("na_letter_8.5x11in", "Letter", 8.5, 11),
  inch("na_legal_8.5x14in", "Legal", 8.5, 14),
  inch("na_ledger_11x17in", "Tabloid", 11, 17),
  inch("na_govt-letter_8x10in", "8 × 10 in", 8, 10),
  inch("na_5x7_5x7in", "5 × 7 in", 5, 7),
  inch("na_index-4x6_4x6in", "4 × 6 in", 4, 6),
  inch("na_super-b_13x19in", "13 × 19 in", 13, 19),
  { name: "iso_a5_148x210mm", label: "A5", width: 148, height: 210 },
  { name: "iso_a4_210x297mm", label: "A4", width: 210, height: 297 },
  { name: "iso_a3_297x420mm", label: "A3", width: 297, height: 420 },
  { name: "oe_a3plus_329x483mm", label: "A3+", width: 329, height: 483 },
];

export const PDF_DPI = [240, 300, 360, 600];

const KEY = "immage.print";
const letterCountry = () => /-(US|CA|MX|PH)$/i.test(typeof navigator === "undefined" ? "" : navigator.language);

export function defaultPrintSettings(): PrintSettings {
  const us = letterCountry();
  return {
    printer: PDF, paper: us ? "na_letter_8.5x11in" : "iso_a4_210x297mm", medium: "", orientation: "auto",
    margins: us ? { top: 12.7, bottom: 12.7, left: 12.7, right: 12.7 } : { top: 12, bottom: 12, left: 12, right: 12 },
    size: null, alignment: 4, profile: "", intent: 0, bpc: true, dpi: 300, unit: us ? "in" : "mm",
  };
}

export function loadPrintSettings(): PrintSettings {
  const d = defaultPrintSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return d;
    return { ...d, ...saved, margins: { ...d.margins, ...(saved.margins ?? {}) } };
  } catch { return d; }
}

// whether the panel has been used: a first visit picks the default printer
export function hasPrintSettings(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}

export function storePrintSettings(s: PrintSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* not kept */ }
}

// a length for the panel, in its unit
export const toUnit = (mm: number, unit: Unit) => (unit === "in" ? mm / INCH : mm);
export const fromUnit = (v: number, unit: Unit) => (unit === "in" ? v * INCH : v);
export const shown = (mm: number, unit: Unit) =>
  unit === "in" ? `${(mm / INCH).toFixed(2).replace(/\.?0+$/, "")} in` : `${Math.round(mm)} mm`;

export type Rect = { x: number; y: number; width: number; height: number };
export type Layout = {
  page: { width: number; height: number };  // as laid out, landscape turned
  landscape: boolean;
  area: Rect;     // inside the margins
  image: Rect;    // the photo, from the page's top left
  borderless: boolean;  // a margin inside what the printer can reach
  fits: boolean;  // the margins leave room for the photo
};

// `aspect` the photo's width over its height, after crops
export function layout(paper: Paper, s: PrintSettings, aspect: number, hw?: Margins): Layout {
  const wide = aspect > 1;
  const landscape = s.orientation === "landscape" || (s.orientation === "auto" && wide);
  const width = landscape ? paper.height : paper.width;
  const height = landscape ? paper.width : paper.height;
  const m = s.margins;
  const area = { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom };
  const fits = area.width > 1 && area.height > 1;
  let iw = Math.max(0, Math.min(area.width, area.height * aspect));
  if (s.size && s.size > 0) iw = Math.min(iw, aspect >= 1 ? s.size : s.size * aspect);
  const ih = iw / aspect;
  const col = s.alignment % 3, row = Math.floor(s.alignment / 3);
  const image = {
    x: area.x + (area.width - iw) * col / 2, y: area.y + (area.height - ih) * row / 2, width: iw, height: ih,
  };
  // the printer's hardware margins turn with the page (cups_print.c, dt_get_print_layout)
  const h = hw && landscape ? { top: hw.right, right: hw.bottom, bottom: hw.left, left: hw.top } : hw;
  const borderless = !!h && (m.top < h.top || m.bottom < h.bottom || m.left < h.left || m.right < h.right);
  return { page: { width, height }, landscape, area, image, borderless, fits };
}

// the photo's pixels per inch at its printed size
export const sourcePpi = (pixelWidth: number, printedWidthMm: number) =>
  printedWidthMm > 0 ? pixelWidth / (printedWidthMm / INCH) : 0;

// what the engine is sent (print_image in engine/print.c)
export function printRequest(s: PrintSettings, paper: Paper, l: Layout, title: string, medium: string,
                             pdf: string | null) {
  return {
    page: l.page,
    area: l.image,
    alignment: 4,
    profile: s.profile,
    intent: s.intent,
    bpc: s.bpc,
    title,
    ...(pdf !== null
      ? { pdf, dpi: s.dpi }
      : { printer: s.printer, paper: { name: paper.name, common_name: paper.label, width: paper.width,
                                       height: paper.height }, medium }),
  };
}

type RawInfo = { resolution: number; margins: Margins; default_paper: string;
                 papers: { name: string; common_name: string; width: number; height: number }[];
                 media: { name: string; common_name: string }[] };

export async function printerInfo(name: string): Promise<PrinterInfo> {
  const r = await invoke<RawInfo>("printer_info", { name });
  return {
    resolution: r.resolution, margins: r.margins, defaultPaper: r.default_paper,
    papers: r.papers.map((p) => ({ name: p.name, label: p.common_name || p.name, width: p.width, height: p.height })),
    media: r.media.map((m) => ({ name: m.name, label: m.common_name || m.name })),
  };
}

// the soft proof, App's: what the engine shows, and the label over the photo
export type Proof = { mode: ProofMode; profile: string; intent: Intent };
export const NO_PROOF: Proof = { mode: "off", profile: "", intent: 0 };

export async function applyProof(p: Proof): Promise<boolean> {
  return invoke<boolean>("softproof", { mode: p.profile ? p.mode : "off", profile: p.profile, intent: p.intent });
}
