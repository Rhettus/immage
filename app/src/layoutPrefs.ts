// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { type Volume } from "./FolderTree";

// the folders added to the library panel, and the folder and image open
// last, with its version, whether the grid was showing, and the folders
// read last, newest first; remembered between launches
export type Library = { folders: string[]; current: string | null; image: string | null; expanded: string[];
                 hidden: string[]; sampled?: boolean; version?: number; grid?: boolean; recent?: string[];
                 volumes?: Record<string, Volume>; foldedVolumes?: string[]; hostNames?: Record<string, string> };
export function loadLibrary(): Library {
  try {
    return { folders: [], current: null, image: null, expanded: [], hidden: [],
             ...JSON.parse(localStorage.getItem("immage.library") ?? "{}") };
  } catch {
    return { folders: [], current: null, image: null, expanded: [], hidden: [] };
  }
}

export function saveLibrary(change: Partial<Library>) {
  try { localStorage.setItem("immage.library", JSON.stringify({ ...loadLibrary(), ...change })); }
  catch { /* not kept */ }
}

// which panels show, and how big; remembered between launches. storage can
// be unavailable, so it is only ever a convenience
export type PanelKey = "left" | "strip" | "right";
export type Layout = { left: boolean; strip: boolean; right: boolean;
                leftWidth: number; rightWidth: number; stripHeight: number };
export const DEFAULT_LAYOUT: Layout = { left: true, strip: true, right: true,
                                 leftWidth: 300, rightWidth: 360, stripHeight: 150 };
export function loadLayout(): Layout {
  try {
    return { ...DEFAULT_LAYOUT, ...JSON.parse(localStorage.getItem("immage.layout") ?? "{}") };
  } catch {
    return DEFAULT_LAYOUT;
  }
}
export function saveLayout(l: Layout) {
  try { localStorage.setItem("immage.layout", JSON.stringify(l)); } catch { /* not kept */ }
}
