// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the levels widget's handle rules, ported from rgblevels.c: black, gray and
// white points of one channel (`levels[c][0..2]`, 0..1), and the pure steps
// ModuleLevels.tsx draws on top of

export type Levels = [number, number, number];

// rgblevels.c _rgblevels_move_handle. `share` is where gray sat between black
// and white when the drag began (drag_start_percentage, taken while the
// pointer only hovered): moving black or white carries gray along at that
// share. black and white keep 0.05 apart, gray stays 0.05 inside them. the
// float divisions are as darktable's, a share of 0 or 1 included
export function moveHandle(levels: Levels, handle: number, pos: number, share: number): Levels {
  if (handle < 0 || handle > 2) return levels;
  const l: Levels = [...levels];
  let min = 0, max = 1;
  switch (handle) {
    case 0:
      max = Math.min(l[2] - 0.05 / share, 1);
      max = Math.min((l[2] * (1 - share) - 0.05) / (1 - share), max);
      break;
    case 1:
      min = l[0] + 0.05;
      max = l[2] - 0.05;
      break;
    default:
      min = Math.max(0.05 / share + l[0], 0);
      min = Math.max((l[0] * (1 - share) + 0.05) / (1 - share), min);
      break;
  }
  l[handle] = Math.min(max, Math.max(min, pos));
  if (handle !== 1) l[1] = l[0] + share * (l[2] - l[0]);
  return l;
}

// _area_motion_notify_callback: the handle nearest the pointer is the one a
// press or the wheel moves (the first of equals)
export function nearestHandle(levels: Levels, x: number): number {
  let k = 0, dist = Math.abs(levels[0] - x);
  for (let i = 1; i < 3; i++) {
    const d = Math.abs(levels[i] - x);
    if (d < dist) { k = i; dist = d; }
  }
  return k;
}

// where gray sits between black and white (drag_start_percentage)
export const grayShare = (l: Levels) => (l[1] - l[0]) / (l[2] - l[0]);

// _area_scroll_callback: 0.002 a notch, times the key speed (dt_accel_get_speed_multiplier:
// 10 with shift, 0.1 with ctrl); a notch down (dy > 0) lowers the handle
export const wheelPosition = (level: number, dy: number, speed = 1) => level - 0.002 * speed * dy;
