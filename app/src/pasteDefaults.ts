// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { invoke } from "@tauri-apps/api/core";
import type { Session } from "./session";
import type { Values } from "./manifest";
import { AUTO_TONE_IDS, autoExposure, autoTone } from "./autoTone";
import { DEFAULT_TRANSITION, parseZones } from "./zones";

export type PasteDefaults = {
  profile: number; compensation: number; auto: boolean;
  preset: { values: Values; rawOnly?: boolean } | null;
};
// Establish the same new-photo baseline as opening it in the viewer, before
// taking a batch's undo snapshot. Never change an existing saved edit.
export async function preparePastePhoto(s: Session, defaults: PasteDefaults) {
  if (s.wasEdited) return;
  const values: Values = { tm_mode: 1 };
  if (s.raw) {
    if (defaults.profile) values.profile = defaults.profile;
    if (defaults.compensation) values.exp_comp = defaults.compensation;
    values.capture = 1;
  }
  if (defaults.preset && (s.raw || !defaults.preset.rawOnly)) Object.assign(values, defaults.preset.values);
  s.setMany(Object.entries(values));
  await s.settled();
  if (s.raw && defaults.auto) {
    s.setMany(AUTO_TONE_IDS.map(id => [id, 0]));
    await s.settled();
    const zones = parseZones(await invoke<ArrayBuffer>("zones", { width: 320, height: 320,
      transition: DEFAULT_TRANSITION, stage: "after" }));
    const { exposure, ...key } = autoExposure(s.values.exposure, zones);
    s.setMany([["exposure", exposure]]);
    await s.settled();
    if (s.values.tm_mode === 1) {
      const range = await invoke<{ black_ev: number; white_ev: number }>("agx_auto");
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
