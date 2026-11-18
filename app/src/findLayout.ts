// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// where the Find popup sits: docked at the inline end of the grid area by
// default, and where the user dragged it to, all inside the grid area.
// Pure, apart from the settings pair at the end; FindPanel.tsx draws it
import { settings } from "./settings";

export type Bounds = { left: number; right: number; top: number; bottom: number };
export type Rect = { left: number; top: number; width: number; height: number };
// where the dock was dragged to: its top left corner in the window. Absolute, not
// relative to the default place, as the area moves with the side panels (an
// auto-hidden one shown over it), and a place left must be the place found
export type Pos = { x: number; y: number };
export type FindLayout = { pos: Pos | null };

export const DOCK_WIDTH = 380;
const GAP = 8;

export const DEFAULT_LAYOUT: FindLayout = { pos: null };

// the rectangle the dock takes before any dragging: at the inline end of the
// area (the left in a right-to-left language), full height
export function defaultRect(b: Bounds, rtl = false): Rect {
  const bw = Math.max(0, b.right - b.left), bh = Math.max(0, b.bottom - b.top);
  const width = Math.min(DOCK_WIDTH, Math.max(0, bw - 2 * GAP));
  return { left: rtl ? b.left + GAP : b.right - GAP - width, top: b.top + GAP, width, height: Math.max(0, bh - 2 * GAP) };
}

// the rectangle moved the least that puts it inside the bounds; one larger
// than they are keeps to their start
export function clampRect(r: Rect, b: Bounds): Rect {
  const fit = (start: number, size: number, lo: number, hi: number) => Math.max(lo, Math.min(start, hi - size));
  return { ...r, left: fit(r.left, r.width, b.left, b.right), top: fit(r.top, r.height, b.top, b.bottom) };
}

// where the dock is: where it was dragged to, or its default place, clamped into
// the bounds (and back out again when they grow, as the stored place stays)
export function placeRect(b: Bounds, rtl: boolean, pos?: Pos | null): Rect {
  const d = defaultRect(b, rtl);
  return clampRect(pos ? { ...d, left: pos.x, top: pos.y } : d, b);
}

// the place to keep for a corner dragged to `want`, clamped as placeRect does
export function posFor(b: Bounds, rtl: boolean, want: { left: number; top: number }): Pos {
  const r = clampRect({ ...defaultRect(b, rtl), left: want.left, top: want.top }, b);
  return { x: r.left, y: r.top };
}

// ---- stored ----------------------------------------------------------

const KEY = "immage.findLayout";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const point = (p: any): Pos | null => (p && num(p.x) && num(p.y) ? { x: p.x, y: p.y } : null);

// bad or missing storage gives the defaults. Versions with three sizes stored
// `{ size, pos: { minimize, dock } }`: the size is dropped (the dock is the only
// layout) and the dock's place kept
export function parseLayout(raw: string | null): FindLayout {
  try {
    const v = JSON.parse(raw ?? "null");
    if (!v || typeof v !== "object") return { pos: null };
    return { pos: point(v.pos?.dock) ?? point(v.pos) };
  } catch {
    return { pos: null };
  }
}

export function loadLayout(): FindLayout {
  try { return parseLayout(settings.get(KEY)); } catch { return { pos: null }; }
}

export function storeLayout(l: FindLayout) {
  try { settings.set(KEY, JSON.stringify(l)); } catch { /* kept for this session only */ }
}
