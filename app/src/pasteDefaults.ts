// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { commands } from "./commands";
import type { Session } from "./session";
import { agxRuns, controlById, isColorBalanceProfile, profileSelection, TM_AGX, type Values } from "./manifest";
import { AUTO_TONE_IDS, autoExposure, autoTone } from "./autoTone";
import { DEFAULT_TRANSITION, parseZones } from "./zones";

export type PasteDefaults = {
  profile: number; compensation: number; auto: boolean; lensMethod?: number;
  preset: { values: Values; rawOnly?: boolean; nonRaw?: boolean } | null;
};
// Controls that only apply to a scene-referred tone mapper (AgX/Sigmoid)
const TM_ONLY_IDS = new Set(["tm_mode", "agx_black", "agx_white", "whites_brilliance"]);

// Strip tone-mapper-only controls and AgX profiles when targeting a display-referred
// (already tone-mapped) photo so presets and paste never enable a tone mapper on LDR files.
export function filterValuesForPhoto(values: Values, toneMappable: boolean): Values {
  if (toneMappable) return values;
  return Object.fromEntries(Object.entries(values).filter(([id, v]) =>
    !TM_ONLY_IDS.has(id) && (id !== "profile" || v === 0 || isColorBalanceProfile(v))));
}

// the new-photos preset is a raw's starting point. a JPEG, TIFF or other
// rendered file gets it only when Preferences' Also apply to JPEGs is on,
// and then without what needs a raw (the controls marked rawOnly), what
// the camera did already (Lens Corrections), or AgX-only controls/profiles.
// null: nothing to apply
const LENS_IDS = new Set(["lens_profile", "lens_ca", "lens_pick", "lens_method"]);
export function newPhotoPresetValues(values: Values, raw: boolean, nonRaw: boolean,
                                     toneMappable = raw): Values | null {
  if (raw) return values;
  if (!nonRaw) return null;
  const base = filterValuesForPhoto(values, toneMappable);
  return Object.fromEntries(Object.entries(base)
    .filter(([id]) => !LENS_IDS.has(id) && !controlById.get(id)?.rawOnly));
}

// Preferences' lens correction method for a new raw whose lens corrections
// are on, written so the engine renders it. Lensfun is left to darktable's
// default when the database has no lens for the photo. null: nothing to set
export function newPhotoLensMethod(s: Session, method: number | undefined): number | null {
  if (method === undefined) return null;
  if (!s.raw || s.values.lens_profile !== 1) return null;
  if (method === 1 && !s.lensfunKnown) return null;
  // a raw without embedded data already renders Lensfun: no step to add
  if (method === 1 && !s.lensEmbedded) return null;
  return method;
}

// Establish the same new-photo baseline as opening it in the viewer, before
// taking a batch's undo snapshot. Never change an existing saved edit.
export async function preparePastePhoto(s: Session, defaults: PasteDefaults) {
  if (s.wasEdited) return;
  const values: Values = s.toneMappable ? { tm_mode: TM_AGX } : {};
  if (s.raw) {
    if (defaults.compensation) values.exp_comp = defaults.compensation;
    values.capture = 1;
  }
  const preset = defaults.preset && (s.raw || !defaults.preset.rawOnly)
    ? newPhotoPresetValues(defaults.preset.values, s.raw, !!defaults.preset.nonRaw, s.toneMappable) : null;
  if (preset) Object.assign(values, preset);
  // Preferences' profile wins over a preset's, AgX Default (0) included
  if (s.toneMappable && (defaults.profile || values.profile !== undefined))
    Object.assign(values, profileSelection(defaults.profile, s.toneMappable));
  if (Object.keys(values).length) {
    s.setMany(Object.entries(values));
    await s.settled();
  }
  const lens = newPhotoLensMethod(s, defaults.lensMethod);
  if (lens !== null) { s.setMany([["lens_method", lens]]); await s.settled(); }
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
