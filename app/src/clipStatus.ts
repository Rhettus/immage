// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// whether the local CLIP package is installed, which decides if photo-content
// (Smart) search and similar photos can run on this computer. The answer is
// `search_status`'s `model_installed`, which the backend reads off the event
// loop; App asks once after the first paint, again when Preferences closes, and
// every few seconds while a model download is still running
import { commands } from "./commands";

// `known` is false when the status could not be read, which says nothing about the model
export type ClipState = { known: boolean; installed: boolean; downloading: boolean };

export async function loadClipState(): Promise<ClipState> {
  try {
    const status = await commands.searchStatus();
    return { known: true, installed: status.model_installed, downloading: status.model.downloading };
  } catch {
    return { known: false, installed: false, downloading: false };
  }
}
