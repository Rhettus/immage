// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences > Modules > 3D LUT folder: the folder the Advanced LUT 3D card
// takes its files from, darktable's plugins/darkroom/lut3d/def_path. A LUT is
// stored in the photo as a path relative to this folder, and a file outside it
// is refused. Empty is darktable's default, the home folder. The Rust layer
// reads the same key to start the engine with it (settings.rs, LUT_FOLDER)
import { settings } from "./settings";
import { commands } from "./commands";

const KEY = "immage.lutFolder";

export function loadLutFolder(): string {
  try { return settings.get(KEY) ?? ""; } catch { return ""; }
}

// the LUT 3D card lists its folder's files, so it reads them again when the
// folder changes (a card left open while Preferences changed the folder)
const listeners = new Set<() => void>();
export function onLutFolder(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

// kept, and handed to the engine at once so photos that use a LUT render from it
export function storeLutFolder(folder: string) {
  const f = folder.trim();
  try { if (f) settings.set(KEY, f); else settings.remove(KEY); } catch { /* not kept */ }
  commands.lutFolder(f).catch(() => {}).then(() => listeners.forEach((l) => l()));
}
