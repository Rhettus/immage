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
// where a size was dragged to: its top left corner in the window. Absolute, not
// relative to the default place, as the area moves with the side panels (an
// auto-hidden one shown over it), and a place left must be the place found
export type Pos = { x: number; y: number };
export type FindLayout = { size: FindSize; pos: Partial<Record<FindSize, Pos>> };

export const STRIP_WIDTH = 640;
export const STRIP_HEIGHT = 56;        // the strip's one row, until it is measured: its height is the content's
export const DOCK_WIDTH = 380;
const GAP = 8;

export const DEFAULT_LAYOUT: FindLayout = { size: "dock", pos: {} };

// the rectangle a size takes before any dragging. The strip is centered
// over the grid area and sits above the anchor (the toolbar's Find button)
// when there is one; the dock is at the inline end of the area (the left in
// a right-to-left language), full height; Fill covers the area
export function defaultRect(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl = false, stripHeight = STRIP_HEIGHT): Rect {
  const bw = Math.max(0, b.right - b.left), bh = Math.max(0, b.bottom - b.top);
  switch (size) {
    case "minimize": {
      const width = Math.min(STRIP_WIDTH, Math.max(0, bw - 2 * GAP));
      const bottom = anchorTop === undefined ? b.bottom - GAP : Math.min(b.bottom - GAP, anchorTop - 6);
      return { left: b.left + (bw - width) / 2, top: bottom - stripHeight, width, height: stripHeight };
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

// where a size is: where it was dragged to, or its default place, clamped into
// the bounds (and back out again when they grow, as the stored place stays).
// Fill never moves. `height` is the strip's measured height
export function placeRect(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl: boolean, pos?: Pos, height?: number): Rect {
  const d = defaultRect(size, b, anchorTop, rtl, height);
  if (size === "fill" || !pos) return clampRect(d, b);
  return clampRect({ ...d, left: pos.x, top: pos.y }, b);
}

// the place to keep for a corner dragged to `want`, clamped as placeRect does
export function posFor(size: FindSize, b: Bounds, anchorTop: number | undefined, rtl: boolean, want: { left: number; top: number }, height?: number): Pos {
  const r = clampRect({ ...defaultRect(size, b, anchorTop, rtl, height), left: want.left, top: want.top }, b);
  return { x: r.left, y: r.top };
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
      if (p && num(p.x) && num(p.y)) pos[s] = { x: p.x, y: p.y };
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
