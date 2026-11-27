// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// whether the local CLIP package is installed, and whether remote CLIP
// providers (morfPhoto / Immich) are actively serving folders. The answer is
// `search_status`, which the backend reads off the event loop; App asks once
// after the first paint, again when Preferences closes, and every few seconds
// while a model download is still running.
import { commands } from "./commands";

// `known` is false when the status could not be read, which says nothing about the model
export type ClipState = {
  known: boolean;
  installed: boolean;
  downloading: boolean;
  remoteClip: boolean;
  allRemote: boolean;
};

export async function loadClipState(): Promise<ClipState> {
  try {
    const status = await commands.searchStatus();
    const providers = status.clip_providers ?? [];
    const allRemote = providers.length > 0 && providers.every((p) => p.provider !== "local");
    return {
      known: true,
      installed: status.model_installed,
      downloading: status.model.downloading,
      remoteClip: !!status.remote_clip,
      allRemote,
    };
  } catch {
    return { known: false, installed: false, downloading: false, remoteClip: false, allRemote: false };
  }
}
