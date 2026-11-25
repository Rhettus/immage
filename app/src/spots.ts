// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Heal and Clone spots, and Fill and Blur ones, kept by darktable's retouch module. in
// shown-image units, as masks are: 0-1 across the width and height, sizes
// as fractions of the width. (sx, sy) is where the center, or a stroke's
// first point, copies from; a fill or blur spot has no source, but a color or
// a blur of its own, and the settings its photo's fill and blur spots share
// the types come from the Rust layer's (spots, spot_source)
import type { FillSettings, NewSpot as NewSpotShape, Spot } from "./commands";
export type { Spot };
export type CircleSpot = Extract<Spot, { type: "circle" }>;
export type BrushSpot = Extract<Spot, { type: "brush" }>;

// whether a spot copies from a source: heal and clone do, fill and blur
// (which add retouch's own color or blur) do not
export const hasSource = (s: Pick<Spot, "mode">) => s.mode === "heal" || s.mode === "clone";

// the spot's anchor (the circle's center, the stroke's first point)
export const anchorOf = (s: Spot): [number, number] => (s.type === "circle" ? [s.x, s.y] : s.points[0]);

// the spot moved by (dx, dy), its source with it or not
export function moveSpot(s: Spot, dx: number, dy: number, withSource: boolean): Spot {
  const src = withSource && s.sx != null && s.sy != null ? { sx: s.sx + dx, sy: s.sy + dy } : {};
  if (s.type === "circle") return { ...s, x: s.x + dx, y: s.y + dy, ...src };
  return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]), ...src };
}

// the same spot drawn where its source is (a spot with none stays where it is)
export function sourceOf(s: Spot): Spot {
  if (s.sx == null || s.sy == null) return s;
  const [ax, ay] = anchorOf(s);
  return moveSpot(s, s.sx - ax, s.sy - ay, false);
}

// the spot's radius: a circle's, or half the stroke's width
export const radiusOf = (s: Spot) => (s.type === "circle" ? s.r : s.size / 2);

// a spot before its source is found
export type NewSpot = NewSpotShape;

// the settings a photo's fill and blur spots share (one retouch instance in
// darktable): "chromaticity" changes only the color, "normal" color and tone;
// strength is 0-100; ranges limit it to a color, as a mask's do (masks.ts)
export type { FillSettings };
export const DEFAULT_FILL: FillSettings = { blend: "chromaticity", opacity: 100, ranges: [] };

// the engine keeps heal and clone spots first, then fill and blur ones, so the
// page does too (a spot is then at the same place in both, whatever the order
// it was made in)
export const orderSpots = (spots: Spot[]): Spot[] =>
  [...spots.filter((s) => hasSource(s)), ...spots.filter((s) => !hasSource(s))];
