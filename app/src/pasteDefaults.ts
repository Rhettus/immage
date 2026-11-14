// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { commands } from "./commands";
import type { Session } from "./session";
import { agxRuns, controlById, profileSelection, type Values } from "./manifest";
import { AUTO_TONE_IDS, autoExposure, autoTone } from "./autoTone";
import { DEFAULT_TRANSITION, parseZones } from "./zones";

export type PasteDefaults = {
  profile: number; compensation: number; auto: boolean;
  preset: { values: Values; rawOnly?: boolean; nonRaw?: boolean } | null;
};
// the new-photos preset is a raw's starting point. a JPEG, TIFF or other
// rendered file gets it only when Preferences' Also apply to JPEGs is on,
// and then without what needs a raw (the controls marked rawOnly) or what
// the camera did already (Lens Corrections). null: nothing to apply
const LENS_IDS = new Set(["lens_profile", "lens_ca", "lens_pick"]);
export function newPhotoPresetValues(values: Values, raw: boolean, nonRaw: boolean): Values | null {
  if (raw) return values;
  if (!nonRaw) return null;
  return Object.fromEntries(Object.entries(values)
    .filter(([id]) => !LENS_IDS.has(id) && !controlById.get(id)?.rawOnly));
}

// Establish the same new-photo baseline as opening it in the viewer, before
// taking a batch's undo snapshot. Never change an existing saved edit.
export async function preparePastePhoto(s: Session, defaults: PasteDefaults) {
  if (s.wasEdited) return;
  const values: Values = { tm_mode: 1 };
  if (s.raw) {
    if (defaults.profile) Object.assign(values, profileSelection(defaults.profile));
    if (defaults.compensation) values.exp_comp = defaults.compensation;
    values.capture = 1;
  }
  const preset = defaults.preset && (s.raw || !defaults.preset.rawOnly)
    ? newPhotoPresetValues(defaults.preset.values, s.raw, !!defaults.preset.nonRaw) : null;
  if (preset) Object.assign(values, preset);
  s.setMany(Object.entries(values));
  await s.settled();
  if (s.raw && defaults.auto) {
    s.setMany(AUTO_TONE_IDS.map(id => [id, 0]));
    await s.settled();
    const zones = parseZones(await commands.zones(320, 320, DEFAULT_TRANSITION, "after"));
    const { exposure, ...key } = autoExposure(s.values.exposure, zones);
    s.setMany([["exposure", exposure]]);
    await s.settled();
    if (agxRuns(s.values)) {
      const range = await commands.agxAuto();
      s.setMany([["agx_black", range.black_ev], ["agx_white", range.white_ev]]);
      await s.settled();
    }
    const frame = await s.preview(320, {});
    const tone = autoTone(frame.pixels, frame.width, frame.height, key);
    if (tone) s.setMany(Object.entries(tone));
  }
  // Keep baseline=true until close writes the defaults as the unedited state.
  await s.close();
}
