// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's hidden modules (Preferences > Modules > Advanced modules): a
// module the user hides leaves Add module, the module search and the tone
// mapper switch. A photo that uses it still shows its card, so no edit is
// unreachable. Keys are `${group}:${op}`, one per row of the Preferences card,
// so a module in two groups (color balance rgb in Basic and Color Grading) hides
// in each on its own. Kept as a settings list, read live by its consumers
import { settings } from "./settings";
import type { ModuleLayout } from "./advancedLayout";

const KEY = "immage.hiddenModules";

export const hiddenKey = (group: string, op: string) => `${group}:${op}`;

let cache: { raw: string | undefined; set: ReadonlySet<string> } = { raw: undefined, set: new Set() };

// the hidden keys; the parse is kept until the stored text changes, as the
// panels read it on every render
export function loadHiddenModules(): ReadonlySet<string> {
  let raw: string | undefined;
  try { raw = settings.get(KEY) ?? undefined; } catch { raw = undefined; }
  if (raw === cache.raw) return cache.set;
  let set = new Set<string>();
  try {
    const v = JSON.parse(raw ?? "[]");
    if (Array.isArray(v)) set = new Set(v.filter((k): k is string => typeof k === "string" && !!k));
  } catch { /* none hidden */ }
  cache = { raw, set };
  return set;
}

export function storeHiddenModules(keys: Iterable<string>) {
  try { settings.set(KEY, JSON.stringify([...new Set(keys)].sort())); } catch { /* not kept */ }
}

export const isHidden = (hidden: ReadonlySet<string>, group: string, op: string) => hidden.has(hiddenKey(group, op));

// the layouts a search or Add module may offer
export const visibleLayouts = (layouts: ModuleLayout[], hidden: ReadonlySet<string>) =>
  layouts.filter((l) => !isHidden(hidden, l.group, l.op));

// Essentials only keeps these darktable modules (in every group that holds
// them) and hides the rest: each with a Simple equivalent. Crop is Simple's
// own tool and has no Advanced card. Edit this list to change the set
export const ESSENTIAL_OPS: readonly string[] = [
  "temperature", "channelmixerrgb", "exposure", "highlights",
  "agx", "sigmoid", "filmicrgb", "basecurve",
  "contrastntexture", "bilat", "hazeremoval", "diffuse",
  "colorbalancergb", "toneequal", "rgbcurve", "colorequal",
  "denoiseprofile", "lens", "ashift", "vignette", "grain",
  "colorin", "colorout",
];

// the keys Essentials only hides: every layout but the essential ones, and
// any with a Simple instance of its own
export const essentialsHidden = (layouts: ModuleLayout[]): string[] =>
  layouts.filter((l) => !l.instance && !ESSENTIAL_OPS.includes(l.op)).map((l) => hiddenKey(l.group, l.op));
