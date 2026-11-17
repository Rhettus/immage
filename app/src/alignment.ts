// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The 3x3 alignment grid of the Composite and Watermark cards. Both modules
// keep one int, `alignment`, 0 to 8, and both read it the same way (overlay.c
// _setup_overlay's placement and watermark.c's translation): rows 0-2 are
// the top, 3-5 the middle and 6-8 the bottom, and within a row the index
// modulo 3 is left, center or right. The grid's buttons are laid out in
// that order (gui_init: column 1 + i % 3, row i / 3)

export const ALIGNMENTS = 9;

export type Alignment = { row: 0 | 1 | 2; col: 0 | 1 | 2 };

const ROWS = ["top", "middle", "bottom"] as const;
const COLS = ["left", "center", "right"] as const;

// the grid cell an index sits in; a value outside 0..8 has none, as
// gui_update then leaves every button off
export function alignmentCell(index: number): Alignment | null {
  if (!Number.isInteger(index) || index < 0 || index >= ALIGNMENTS) return null;
  return { row: Math.floor(index / 3) as 0 | 1 | 2, col: (index % 3) as 0 | 1 | 2 };
}

export const alignmentIndex = (cell: Alignment) => cell.row * 3 + cell.col;

// "top left", "center" for the middle of the middle
export function alignmentName(index: number): string {
  const c = alignmentCell(index);
  if (!c) return "none";
  return c.row === 1 && c.col === 1 ? "center" : `${ROWS[c.row]} ${COLS[c.col]}`;
}
