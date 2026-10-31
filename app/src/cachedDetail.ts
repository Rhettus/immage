// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

export function isDetailControl(id: string): boolean {
  const global = id.replace(/^l_/, "");
  return ["texture", "clarity", "contrast", "dehaze", "nr_detail"].includes(global)
    || global.startsWith("detail_clarity_") || global.startsWith("detail_texture_")
    || global.startsWith("sharp_");
}

type Pixels = Uint8ClampedArray<ArrayBuffer>;
export type DetailAnchor = { value:number; pixels:Pixels };

// use actual module output, never a generic exposure or tone transform
export function interpolateDetail(a:DetailAnchor, b:DetailAnchor, value:number, range:number): Pixels | null {
  const span = b.value-a.value;
  if (!Number.isFinite(value) || !Number.isFinite(span) || Math.abs(span)<1e-9
      || a.pixels.length!==b.pixels.length || !a.pixels.length || !(range>0)) return null;
  const k = (value-a.value)/span;
  // beyond the recent neighborhood the native render is a better preview
  if (k < -0.5 || k > 1.5 || Math.min(Math.abs(value-a.value),Math.abs(value-b.value)) > range*0.1) return null;
  const pixels = new Uint8ClampedArray(a.pixels.length);
  for (let i=0;i<pixels.length;i+=4) {
    for (let c=0;c<3;c++) pixels[i+c] = a.pixels[i+c]+(b.pixels[i+c]-a.pixels[i+c])*k;
    pixels[i+3] = b.pixels[i+3];
  }
  return pixels;
}
