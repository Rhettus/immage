// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// which darktable module a tool runs on for photos that have not used it
// yet (manifest.ts, MODULE_CHOICES): Default, the one darktable's AgX
// workflow uses for each, or Custom, each tool's as Preferences' Modules
// tab sets it
import { MODULE_CHOICES, MASK_MODULE_CHOICES, preferredChoice } from "./manifest";

export type ModuleMode = "default" | "custom";
const MODE_KEY = "immage.modules.mode";
const CHOICES_KEY = "immage.modules.choices";

export function loadModuleMode(): ModuleMode {
  try { return localStorage.getItem(MODE_KEY) === "custom" ? "custom" : "default"; } catch { return "default"; }
}
export function storeModuleMode(v: ModuleMode) {
  try { localStorage.setItem(MODE_KEY, v); } catch { /* not kept */ }
}

// Custom's picks, by choice id
function loadCustom(scope: "global" | "masks" = "global"): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(scope === "masks" ? CHOICES_KEY + ".masks" : CHOICES_KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

// the module value a tool gets: Custom's pick, if it is still one of the
// tool's options, else the AgX workflow's
export function loadModuleChoice(id: string, scope: "global" | "masks" = "global"): number {
  const c = (scope === "masks" ? MASK_MODULE_CHOICES : MODULE_CHOICES).find((x) => x.id === id);
  if (!c) return 0;
  if (loadModuleMode() === "custom") {
    const v = loadCustom(scope)[id];
    if (c.options.some((o) => o.value === v)) return v;
  }
  return preferredChoice(c);
}
export function storeModuleChoice(id: string, v: number, scope: "global" | "masks" = "global") {
  try { localStorage.setItem(scope === "masks" ? CHOICES_KEY + ".masks" : CHOICES_KEY, JSON.stringify({ ...loadCustom(scope), [id]: v })); } catch { /* not kept */ }
}
