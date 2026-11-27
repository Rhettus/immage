// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the filmstrip and grid draw only the cells in view, and a few lines either
// side: a folder of 140,000 photos as 140,000 cells froze the page for
// minutes, and each batch of a folder read drew them all again. the cells are
// all one size (styles.css, .thumb), so where any cell sits is arithmetic.
// a "line" is a grid row, or one cell of the strip

export type FilmGeometry = {
  cols: number;   // cells per line: the grid's columns, 1 in the strip
  step: number;   // a line's length along the scroll, with the gap after it
  gap: number;    // the gap between lines
  pad: number;    // the strip's padding before the first line
  cell: number;   // a cell's length along the scroll
};

// the grid fits as many columns as CSS's repeat(auto-fill, column) does
export function filmGeometry(grid: boolean, cell: number, column: number, gap: number, pad: number,
                             crossPad: number, cross: number): FilmGeometry {
  const cols = grid ? Math.max(1, Math.floor((cross - 2 * crossPad + gap) / (column + gap))) : 1;
  return { cols, step: cell + gap, gap, pad, cell };
}

// where a cell starts along the scroll, from the strip's content edge
export const cellStart = (g: FilmGeometry, index: number) => g.pad + Math.floor(index / g.cols) * g.step;

export type FilmWindow = {
  first: number;  // the first cell drawn
  last: number;   // one past the last cell drawn
  before: number; // the space the undrawn lines before take, gaps included
  after: number;  // the same after
};

// the cells to draw for a scroll position and view length, with `overscan`
// lines either side so a scroll shows drawn cells before the next update
export function filmWindow(g: FilmGeometry, count: number, pos: number, view: number, overscan: number): FilmWindow {
  const lines = Math.ceil(count / g.cols);
  if (!lines) return { first: 0, last: 0, before: 0, after: 0 };
  const from = Math.max(0, Math.min(lines - 1, Math.floor((pos - g.pad) / g.step) - overscan));
  const to = Math.max(from + 1, Math.min(lines, Math.ceil((pos + view - g.pad) / g.step) + overscan));
  return {
    first: from * g.cols,
    last: Math.min(count, to * g.cols),
    // a spacer's own gap follows it, so it is one gap short
    before: from ? from * g.step - g.gap : 0,
    after: to < lines ? (lines - to) * g.step - g.gap : 0,
  };
}

// the scroll position that brings a cell into view: the least scroll, or
// centered. null when it is in view already
export function revealAt(g: FilmGeometry, index: number, pos: number, view: number, center: boolean): number | null {
  const start = cellStart(g, index), end = start + g.cell;
  if (center) return (start + end) / 2 - view / 2;
  if (start < pos) return start;
  if (end > pos + view) return end - view;
  return null;
}
