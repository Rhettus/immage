// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

export function isDetailControl(id: string): boolean {
  const global = id.replace(/^l_/, "");
  return ["texture", "clarity", "dehaze", "nr_luminance", "nr_color", "nr_detail", "grain_amount", "grain_size"].includes(global)
    || global.startsWith("detail_clarity_") || global.startsWith("detail_texture_")
    || global.startsWith("sharp_");
}
