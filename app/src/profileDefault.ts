// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { AGX_PROFILE_DEFAULT, PROFILE_OPTIONS } from "./manifest";

const PROFILE_KEY = "immage.newPhotosProfile";
export function loadNewPhotosProfile(): number {
  try {
    const v = Number(localStorage.getItem(PROFILE_KEY) ?? AGX_PROFILE_DEFAULT);
    return PROFILE_OPTIONS.some(([, x]) => x === v) ? v : AGX_PROFILE_DEFAULT;
  } catch { return AGX_PROFILE_DEFAULT; }
}
export function storeNewPhotosProfile(value: number): void {
  if (!PROFILE_OPTIONS.some(([, x]) => x === value)) throw new Error("Choose an available profile for new raw photos");
  localStorage.setItem(PROFILE_KEY, String(value));
}
