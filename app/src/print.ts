// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Print panel's settings, papers and page layout, and the soft proof
// they share. the engine prints (engine/print.c): darktable's printer
// profiles, PDF writer and CUPS or the Windows spooler. the Single Photo
// layout puts one photo on each page, fitted inside the margins or at a size
// of its own, at one of nine places; the Cells layout puts many on a page in a
// grid of cells (a contact sheet by default)
import { commands, type Printer as PrinterEntry, type PrintProfile } from "./commands";
import { settings } from "./settings";

export type Unit = "mm" | "in";
export type Orientation = "auto" | "portrait" | "landscape";
// darktable's dt_iop_color_intent_t: 0 perceptual, 1 relative colorimetric
export type Intent = 0 | 1;
export type ProofMode = "off" | "proof" | "gamut";
export type Margins = { top: number; bottom: number; left: number; right: number };

// a paper, portrait, in millimeters; `name` is what the printer calls it
export type Paper = { name: string; label: string; width: number; height: number };
export type Medium = { name: string; label: string };
export type Profile = PrintProfile;
export type Printer = PrinterEntry;
export type PrinterInfo = {
  resolution: number; margins: Margins; defaultPaper: string; papers: Paper[]; media: Medium[];
};

export const PDF = "";  // the destination that saves a PDF rather than printing

export type PrintLayout = "single" | "cells";

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
  layout: PrintLayout;
  // the Cells layout: filenames under the photos; the gap between cells in
  // millimeters (Auto cell size); cells per page and columns, 0 for Auto; the
  // cell's photo box in millimeters, or null for Auto
  names: boolean;
  gap: number;
  cellCount: number;
  columns: number;
  cellSize: { width: number; height: number } | null;
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
    layout: "single", names: true, gap: 3, cellCount: 0, columns: 0, cellSize: null,
  };
}

export function loadPrintSettings(): PrintSettings {
  const d = defaultPrintSettings();
  try {
    const saved = JSON.parse(settings.get(KEY) ?? "null");
    if (!saved || typeof saved !== "object") return d;
    const size = saved.cellSize && saved.cellSize.width > 0 && saved.cellSize.height > 0 ? saved.cellSize : null;
    return { ...d, ...saved, cellSize: size, margins: { ...d.margins, ...(saved.margins ?? {}) } };
  } catch { return d; }
}

// whether the panel has been used: a first visit picks the default printer
export function hasPrintSettings(): boolean {
  try { return settings.get(KEY) !== null; } catch { return false; }
}

export function storePrintSettings(s: PrintSettings) {
  try { settings.set(KEY, JSON.stringify(s)); } catch { /* not kept */ }
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

// the Cells layout. a page is a grid of slots, each a photo box with the
// filename's strip under it; the engine is sent each page as a list of
// boxes and labels and knows nothing of columns or gaps (print_sheet in
// engine/print.c), so another generator can follow this one
export const LABEL_HEIGHT = 4;      // mm, the filename's strip under a photo box
export const LABEL_POINTS = 7;      // its type size
export const CONTACT_CAPACITY = 38; // photos an Auto page holds, Letter at its default margins

export type Slot = { box: Rect; label: Rect | null };
export type CellsLayout = {
  page: { width: number; height: number };
  landscape: boolean;
  area: Rect;
  slots: Slot[];      // one page's cells, in reading order
  columns: number;
  rows: number;
  perPage: number;    // photos a page takes: the slots, or fewer when a count was asked for
  pages: number;
  cell: { width: number; height: number };  // the photo box
  borderless: boolean;
  fits: boolean;
};

// the grid for `count` cells in an area. Auto size fills the area with `gap`
// between cells and takes the columns that make the photo boxes largest;
// a Custom size keeps the box and shares the space left equally between the
// cells and the area's edges
// `fill`: the last row's empty cells are slots too, as an Auto page is full at its grid
function grid(area: Rect, s: PrintSettings, count: number, fill: boolean):
    Pick<CellsLayout, "slots" | "columns" | "rows" | "cell"> {
  const strip = s.names ? LABEL_HEIGHT : 0;
  const make = (columns: number, rows: number, w: number, h: number, gx: number, gy: number, x0: number, y0: number) => {
    const slots: Slot[] = [];
    for (let k = 0; k < (fill ? columns * rows : count); k++) {
      const x = x0 + (k % columns) * (w + gx), y = y0 + Math.floor(k / columns) * (h + strip + gy);
      slots.push({ box: { x, y, width: w, height: h }, label: strip ? { x, y: y + h, width: w, height: strip } : null });
    }
    return { slots, columns, rows, cell: { width: w, height: h } };
  };
  if (s.cellSize) {
    // the box as asked, kept inside the area
    const w0 = Math.min(s.cellSize.width, area.width), h0 = Math.min(s.cellSize.height, area.height - strip);
    const columns = Math.max(1, Math.min(count, s.columns > 0 ? s.columns : Math.floor(area.width / w0)));
    const rows = Math.ceil(count / columns);
    const w = Math.min(w0, area.width / columns), h = Math.min(h0, area.height / rows - strip);
    const gx = (area.width - columns * w) / (columns + 1), gy = (area.height - rows * (h + strip)) / (rows + 1);
    return make(columns, rows, w, h, gx, gy, area.x + gx, area.y + gy);
  }
  const gap = Math.max(0, s.gap);
  const fit = (columns: number) => {
    const rows = Math.ceil(count / columns);
    return { columns, rows, w: (area.width - (columns - 1) * gap) / columns,
             h: (area.height - (rows - 1) * gap) / rows - strip };
  };
  let best = fit(Math.max(1, Math.min(count, s.columns > 0 ? s.columns : 1)));
  if (!(s.columns > 0)) {
    for (let c = 2; c <= count; c++) {
      const f = fit(c);
      // the larger smaller side wins; on a tie, the grid with fewer empty cells
      const side = Math.min(f.w, f.h), top = Math.min(best.w, best.h);
      if (side > top + 1e-6 || (Math.abs(side - top) <= 1e-6 && f.columns * f.rows < best.columns * best.rows))
        best = f;
    }
  }
  return make(best.columns, best.rows, Math.max(0, best.w), Math.max(0, best.h), gap, gap, area.x, area.y);
}

// `photos` how many photos are to print; the page is portrait unless asked
export function cellsLayout(paper: Paper, s: PrintSettings, photos: number, hw?: Margins): CellsLayout {
  const landscape = s.orientation === "landscape";
  const width = landscape ? paper.height : paper.width;
  const height = landscape ? paper.width : paper.height;
  const m = s.margins;
  const area = { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom };
  const fits = area.width > 1 && area.height > 1;
  const n = Math.max(1, photos);
  // Auto: as many as the photos need, up to a full page of them
  const want = s.cellCount > 0 ? s.cellCount : Math.min(n, CONTACT_CAPACITY);
  const g = fits ? grid(area, s, want, s.cellCount <= 0)
                 : { slots: [], columns: 1, rows: 1, cell: { width: 0, height: 0 } };
  const perPage = Math.max(1, g.slots.length);
  const slots = g.slots;
  const h = hw && landscape ? { top: hw.right, right: hw.bottom, bottom: hw.left, left: hw.top } : hw;
  const borderless = !!h && (m.top < h.top || m.bottom < h.bottom || m.left < h.left || m.right < h.right);
  return { page: { width, height }, landscape, area, slots, columns: g.columns, rows: g.rows, perPage,
           pages: Math.max(1, Math.ceil(n / perPage)), cell: g.cell, borderless, fits };
}

// a photo to print in the Cells layout, and the text under it
export type SheetPhoto = { imgid: number; name: string };

// the pages' photos, a slot each (a named photo sits at the bottom of its box); short last pages leave slots empty
export function sheetPages(l: CellsLayout, photos: SheetPhoto[]): { slot: Slot; photo: SheetPhoto }[][] {
  const pages: { slot: Slot; photo: SheetPhoto }[][] = [];
  for (let p = 0; p < Math.max(1, l.pages); p++) {
    const cells: { slot: Slot; photo: SheetPhoto }[] = [];
    for (let k = 0; k < l.perPage; k++) {
      const photo = photos[p * l.perPage + k];
      if (photo && l.slots[k]) cells.push({ slot: l.slots[k], photo });
    }
    pages.push(cells);
  }
  return pages;
}

// the photo's pixels per inch at its printed size
export const sourcePpi = (pixelWidth: number, printedWidthMm: number) =>
  printedWidthMm > 0 ? pixelWidth / (printedWidthMm / INCH) : 0;

// what the engine is sent (print_image in engine/print.c)
export function printRequest(s: PrintSettings, paper: Paper, l: Layout, title: string, medium: string,
                             pdf: boolean) {
  return {
    page: l.page,
    area: l.image,
    alignment: 4,
    profile: s.profile,
    intent: s.intent,
    bpc: s.bpc,
    title,
    // the PDF's path is not sent: Rust asks for it (print_photo, print_sheet)
    ...(pdf
      ? { dpi: s.dpi }
      : { printer: s.printer, paper: { name: paper.name, common_name: paper.label, width: paper.width,
                                       height: paper.height }, medium }),
  };
}

// what the engine is sent for the Cells layout (print_sheet in engine/print.c):
// the pages' boxes and labels in millimeters, from the page's top left
export function sheetRequest(s: PrintSettings, paper: Paper, l: CellsLayout, photos: SheetPhoto[], title: string,
                             medium: string, pdf: boolean) {
  return {
    page: l.page,
    profile: s.profile,
    intent: s.intent,
    bpc: s.bpc,
    title,
    label_points: LABEL_POINTS,
    pages: sheetPages(l, photos).map((cells) => cells.map(({ slot, photo }) => ({
      imgid: photo.imgid, box: slot.box,
      // a photo with a name sits at the bottom of its box, so the name is right under it
      ...(slot.label ? { valign: "bottom", label: { ...slot.label, text: photo.name } } : {}),
    }))),
    // the PDF's path is not sent: Rust asks for it (print_photo, print_sheet)
    ...(pdf
      ? { dpi: s.dpi }
      : { printer: s.printer, paper: { name: paper.name, common_name: paper.label, width: paper.width,
                                       height: paper.height }, medium }),
  };
}

export async function printerInfo(name: string): Promise<PrinterInfo> {
  const r = await commands.printerInfo(name);
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
  return commands.softproof(p.profile ? p.mode : "off", p.profile, p.intent);
}
