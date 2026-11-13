// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's navigator zoom levels. a number is image pixels per screen
// (device) pixel, so 1 is 100%
export type Zoom = "fit" | "fill" | number;
export const ZOOMS: [Zoom, string][] = [["fit", "FIT"], ["fill", "FILL"], [1, "1:1"], [2, "2:1"]];
// the levels ⌘= and ⌘- step through, as Lightroom's do past the navigator's,
// up to the wheel's 4:1
export const KEY_ZOOMS: Zoom[] = ["fit", "fill", 1, 2, 3, 4];

// the image as last rendered, kept to place the zoomed window and the
// navigator's rectangle
export type Placement = { fullWidth: number; fullHeight: number; scale: number; x: number; y: number;
                   width: number; height: number; upscale?: number };
