// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// where the Find popup sits: its three sizes, where each is put by default,
// and where the user dragged it to (kept per size), all inside the grid area.
// Pure, apart from the settings pair at the end; FindPanel.tsx draws it
import { settings } from "./settings";

export type FindSize = "minimize" | "dock" | "fill";
export const SIZES: FindSize[] = ["minimize", "dock", "fill"];

export type Bounds = { left: number; right: number; top: number; bottom: number };
export type Rect = { left: number; top: number; width: number; height: number };
// how far a size was dragged from its default place, in pixels
export type Pos = { dx: number; dy: number };
export type FindLayout = { size: FindSize; pos: Partial<Record<FindSize, Pos>> };

export const STRIP_WIDTH = 640;
export const STRIP_HEIGHT = 56;        // the strip's one row; its height is the content's
export const DOCK_WIDTH = 380;
const GAP = 8;

export const DEFAULT_LAYOUT: FindLayout = { size: "dock", pos: {} };

// the rectangle a size takes before any dragging. The strip is centered
// over the grid area and sits above the anchor (the toolbar's Find button)
// when there is one; the dock is at the inline end of the area (the left in
// a right-to-left language), full height; Fill covers the area
export function defaultRect(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl = false): Rect {
  const bw = Math.max(0, b.right - b.left), bh = Math.max(0, b.bottom - b.top);
  switch (size) {
    case "minimize": {
      const width = Math.min(STRIP_WIDTH, Math.max(0, bw - 2 * GAP));
      const bottom = anchorTop === undefined ? b.bottom - GAP : Math.min(b.bottom - GAP, anchorTop - 6);
      return { left: b.left + (bw - width) / 2, top: bottom - STRIP_HEIGHT, width, height: STRIP_HEIGHT };
    }
    case "dock": {
      const width = Math.min(DOCK_WIDTH, Math.max(0, bw - 2 * GAP));
      return { left: rtl ? b.left + GAP : b.right - GAP - width, top: b.top + GAP, width, height: Math.max(0, bh - 2 * GAP) };
    }
    case "fill":
      return { left: b.left + GAP, top: b.top + GAP, width: Math.max(0, bw - 2 * GAP), height: Math.max(0, bh - 2 * GAP) };
  }
}

// the rectangle moved the least that puts it inside the bounds; one larger
// than they are keeps to their start
export function clampRect(r: Rect, b: Bounds): Rect {
  const fit = (start: number, size: number, lo: number, hi: number) => Math.max(lo, Math.min(start, hi - size));
  return { ...r, left: fit(r.left, r.width, b.left, b.right), top: fit(r.top, r.height, b.top, b.bottom) };
}

// where a size is: its default place and its dragged offset, clamped into the bounds.
// Fill never moves
export function placeRect(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl: boolean, pos?: Pos): Rect {
  const d = defaultRect(size, b, anchorTop, rtl);
  if (size === "fill" || !pos) return clampRect(d, b);
  return clampRect({ ...d, left: d.left + pos.dx, top: d.top + pos.dy }, b);
}

// the offset that puts a rectangle at the pointer's place, clamped as placeRect does
export function offsetFor(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl: boolean, want: { left: number; top: number }): Pos {
  const d = defaultRect(size, b, anchorTop, rtl);
  const r = clampRect({ ...d, left: want.left, top: want.top }, b);
  return { dx: r.left - d.left, dy: r.top - d.top };
}

// ---- stored ----------------------------------------------------------

const KEY = "immage.findLayout";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// bad or missing storage gives the defaults, field by field
export function parseLayout(raw: string | null): FindLayout {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return { size: "dock", pos: {} };
    const pos: FindLayout["pos"] = {};
    for (const s of ["minimize", "dock"] as const) {
      const p = v.pos?.[s];
      if (p && num(p.dx) && num(p.dy)) pos[s] = { dx: p.dx, dy: p.dy };
    }
    return { size: SIZES.includes(v.size) ? v.size : "dock", pos };
  } catch {
    return { size: "dock", pos: {} };
  }
}

export function loadLayout(): FindLayout {
  try { return parseLayout(settings.get(KEY)); } catch { return { size: "dock", pos: {} }; }
}

export function storeLayout(l: FindLayout) {
  try { settings.set(KEY, JSON.stringify(l)); } catch { /* kept for this session only */ }
}
