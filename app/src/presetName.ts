// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a darktable preset's name as the menu shows it: darktable keeps the
// untranslated "_builtin_" prefix on shipped presets, and "|" in a name makes
// a submenu, shown here as "a › b". the raw name is what the engine applies
export function presetLabel(raw: string): string {
  return raw.replace(/^_builtin_/, "").split("|").map((s) => s.trim()).join(" › ");
}
