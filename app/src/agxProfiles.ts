// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { commands, type FoundPreset } from "./commands";
import { useSyncExternalStore } from "react";
import { loadNewPhotosProfile, storeNewPhotosProfile } from "./profileDefault";
import { AGX_FIELDS, AGX_USER_FIRST, PROFILE_OPTIONS, setUserProfiles, type UserProfile } from "./manifest";

// the AgX presets loaded from darktable, kept in agx-profiles.json and shown
// in the Profile menu's My Presets group (manifest.ts, setUserProfiles)

export const LOAD_AGX_PRESET_EVENT = "immage:load-agx-preset";
export const DELETE_AGX_PRESET_EVENT = "immage:delete-agx-preset";

let profiles: UserProfile[] = [];
let revision = 0;
let loadError: unknown;
const listeners = new Set<() => void>();

const publish = () => {
  setUserProfiles(profiles);
  revision++;
  listeners.forEach((l) => l());
};

// re-renders a component when the list changes
export const useAgxProfiles = () =>
  useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => revision);

export const userProfiles = () => profiles.filter((p) => !p.deleted);

// a document is only used if every field is a number
const complete = (p: unknown): p is UserProfile => {
  const q = p as UserProfile;
  return !!q && Number.isInteger(q.value) && q.value >= AGX_USER_FIRST && q.value <= 99999 && typeof q.label === "string" && !!q.params
    && (q.deleted === undefined || typeof q.deleted === "boolean")
    && AGX_FIELDS.every((f) => Number.isFinite(q.params[f]));
};

export async function loadAgxProfiles(): Promise<void> {
  try {
    const saved: unknown[] = await commands.agxProfilesLoad();
    if (!Array.isArray(saved) || !saved.every(complete) || new Set(saved.map((p) => p.value)).size !== saved.length)
      throw new Error("Invalid saved AgX presets");
    profiles = saved;
    loadError = undefined;
  } catch (e) { loadError = e; console.error("AgX presets:", e); profiles = []; }
  publish();
}

const store = (next: UserProfile[]) => {
  if (loadError) throw new Error(`Cannot save AgX presets: ${loadError}`);
  return commands.agxProfilesSave(next);
};

export type { FoundPreset } from "./commands";

// the AgX presets in a darktable preset or style file the user picks (the
// dialog opens in Rust), or with `pick` false in the user's darktable
// data.db; the engine converts them to this version and needs a photo open.
// null when the dialog is cancelled
export async function findAgxPresets(pick = false): Promise<FoundPreset[] | null> {
  const r = await (pick ? commands.agxPresetsPick(AGX_FIELDS) : commands.agxPresets(AGX_FIELDS));
  if (!r) return null;
  return r.presets.filter((p) => AGX_FIELDS.every((f) => Number.isFinite(p.params?.[f])));
}

// a preset's name as darktable shows it: the last segment of "group|name"
const shown = (name: string) => name.replace(/^_builtin_/, "").split("|").pop()!.trim() || name;

export async function addAgxProfiles(found: FoundPreset[]): Promise<number[]> {
  const added: UserProfile[] = [];
  let next = Math.max(AGX_USER_FIRST - 1, ...profiles.map((p) => p.value)) + 1;
  for (const f of found) {
    const taken = new Set([...userProfiles(), ...added].map((p) => p.label));
    let label = shown(f.name), n = 2;
    while (taken.has(label)) label = `${shown(f.name)} (${n++})`;
    if (next > 99999 || !AGX_FIELDS.every((field) => Number.isFinite(f.params[field])))
      throw new Error("Cannot add this AgX preset");
    added.push({ value: next++, label, params: f.params });
  }
  const nextProfiles = [...profiles, ...added];
  await store(nextProfiles);
  profiles = nextProfiles;
  publish();
  return added.map((p) => p.value);
}


// Keep the parameter bases for photos already using a removed profile, and never
// reuse its ID. Only active imported entries may be deleted, never built-ins.
export async function deleteAgxProfiles(values: number[], replacement?: number): Promise<void> {
  const selected = new Set(values);
  if ([...selected].some((value) => !userProfiles().some((p) => p.value === value)))
    throw new Error("Only user-loaded AgX presets can be deleted");
  if (!selected.size) return;
  const next = profiles.map((p) => selected.has(p.value) ? { ...p, deleted: true } : p);
  const previousDefault = loadNewPhotosProfile();
  const replacingDefault = selected.has(previousDefault);
  if (replacingDefault) {
    if (replacement === undefined || selected.has(replacement) || !PROFILE_OPTIONS.some(([, v]) => v === replacement))
      throw new Error("Choose another default profile before deleting this preset");
    // Store the explicit replacement first. Restore it if saving deletion fails.
    storeNewPhotosProfile(replacement);
  }
  try { await store(next); }
  catch (error) {
    if (replacingDefault) storeNewPhotosProfile(previousDefault);
    throw error;
  }
  profiles = next;
  publish();
}
