// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { AGX_PROFILE_DEFAULT, PROFILE_OPTIONS } from "./manifest";
import { settings } from "./settings";

const PROFILE_KEY = "immage.newPhotosProfile";
export function loadNewPhotosProfile(): number {
  try {
    const v = Number(settings.get(PROFILE_KEY) ?? AGX_PROFILE_DEFAULT);
    return PROFILE_OPTIONS.some(([, x]) => x === v) ? v : AGX_PROFILE_DEFAULT;
  } catch { return AGX_PROFILE_DEFAULT; }
}
export function storeNewPhotosProfile(value: number): void {
  if (!PROFILE_OPTIONS.some(([, x]) => x === value)) throw new Error("Choose an available profile for new raw photos");
  settings.set(PROFILE_KEY, String(value));
}

// how a new raw's lens corrections find their data: 1 Lensfun's database
// (when it has the lens), 0 the metadata embedded in the raw
const LENS_METHOD_KEY = "immage.newPhotosLensMethod";
export const LENS_METHOD_LENSFUN = 1, LENS_METHOD_EMBEDDED = 0;
export function loadNewPhotosLensMethod(): number {
  try {
    // unset reads as Lensfun: Number(null) is 0, Embedded's value
    const v = settings.get(LENS_METHOD_KEY);
    return v !== null && Number(v) === LENS_METHOD_EMBEDDED ? LENS_METHOD_EMBEDDED : LENS_METHOD_LENSFUN;
  } catch { return LENS_METHOD_LENSFUN; }
}
export function storeNewPhotosLensMethod(value: number): void {
  settings.set(LENS_METHOD_KEY, String(value === LENS_METHOD_EMBEDDED ? LENS_METHOD_EMBEDDED : LENS_METHOD_LENSFUN));
}
