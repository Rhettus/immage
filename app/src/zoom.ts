// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the navigator's zoom levels. a number is image pixels per screen (device)
// pixel, so 1 is 100% and 0.5 (1:2) is 50%. "half" is half the size of fit,
// the wheel's and the slider's floor; like fit it follows the window. any
// view smaller than fit is centered and cannot be panned
export type Zoom = "fit" | "fill" | "half" | number;
export const ZOOMS: [Zoom, string][] = [[0.5, "1:2"], ["fit", "FIT"], ["fill", "FILL"], [1, "1:1"], [2, "2:1"]];
// the levels ⌘= and ⌘- step through, in order of scale (fit and fill depend
// on the window): from half of fit up to the wheel's 4:1
export const KEY_ZOOMS: Zoom[] = ["half", 0.5, "fit", "fill", 1, 2, 3, 4];

// the image as last rendered, kept to place the zoomed window and the
// navigator's rectangle
export type Placement = { fullWidth: number; fullHeight: number; scale: number; x: number; y: number;
                   width: number; height: number; upscale?: number };


// Shared per-frame easing and snap threshold for viewer and lightbox zoom.
export const ZOOM_EASE = 1 - 0.7 * 0.7;
export function easeZoom(value: number, target: number): number {
  const next = value + (target - value) * ZOOM_EASE;
  return Math.abs(target - next) < target * .002 ? target : next;
}
