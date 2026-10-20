// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Heal and Clone spots, kept by darktable's retouch module. in
// shown-image units, as masks are: 0-1 across the width and height, sizes
// as fractions of the width. (sx, sy) is where the center, or a stroke's
// first point, copies from
type Common = { mode: "heal" | "clone"; sx: number; sy: number; feather: number; opacity: number };
export type CircleSpot = { type: "circle"; x: number; y: number; r: number } & Common;
export type BrushSpot = { type: "brush"; points: [number, number][]; size: number } & Common;
export type Spot = CircleSpot | BrushSpot;

// the spot's anchor (the circle's center, the stroke's first point)
export const anchorOf = (s: Spot): [number, number] => (s.type === "circle" ? [s.x, s.y] : s.points[0]);

// the spot moved by (dx, dy), its source with it or not
export function moveSpot(s: Spot, dx: number, dy: number, withSource: boolean): Spot {
  const src = withSource ? { sx: s.sx + dx, sy: s.sy + dy } : {};
  if (s.type === "circle") return { ...s, x: s.x + dx, y: s.y + dy, ...src };
  return { ...s, points: s.points.map(([x, y]) => [x + dx, y + dy] as [number, number]), ...src };
}

// the same spot drawn where its source is
export function sourceOf(s: Spot): Spot {
  const [ax, ay] = anchorOf(s);
  return moveSpot(s, s.sx - ax, s.sy - ay, false);
}

// the spot's radius: a circle's, or half the stroke's width
export const radiusOf = (s: Spot) => (s.type === "circle" ? s.r : s.size / 2);

// a spot before its source is found
export type NewSpot = Omit<CircleSpot, "sx" | "sy"> | Omit<BrushSpot, "sx" | "sy">;
