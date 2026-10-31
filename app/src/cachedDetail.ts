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
export function detailMix(a:DetailAnchor, b:DetailAnchor, value:number, range:number, validation=false): number | null {
  const span = b.value-a.value;
  if (!Number.isFinite(value) || !Number.isFinite(span) || Math.abs(span)<1e-9
      || a.pixels.length!==b.pixels.length || !a.pixels.length || !(range>0)) return null;
  // private recovery validation allows one full native step; displayed bounds stay tighter
  const k = (value-a.value)/span;
  if (k < (validation ? -1 : -0.5) || k > (validation ? 2 : 1.5) || Math.min(Math.abs(value-a.value),Math.abs(value-b.value)) > range*0.1) return null;
  return k;
}

export function interpolateDetail(a:DetailAnchor, b:DetailAnchor, value:number, range:number, validation=false): Pixels | null {
  const k = detailMix(a,b,value,range,validation);
  return k === null ? null : mixDetailPixels(a.pixels,b.pixels,k);
}

export function mixDetailPixels(a:Pixels, b:Pixels, k:number): Pixels {
  const pixels = new Uint8ClampedArray(a.length);
  for (let i=0;i<pixels.length;i+=4) {
    for (let c=0;c<3;c++) pixels[i+c] = a[i+c]+(b[i+c]-a[i+c])*k;
    pixels[i+3] = b[i+3];
  }
  return pixels;
}

// Basic tone and color sliders use anchors without activating the detail loupe.
export function isCachedControl(id: string): boolean {
  return isDetailControl(id) || ["temp", "tint", "exposure", "highlights", "shadows", "whites", "blacks", "vibrance", "saturation"].includes(id);
}

export function predictionError(predicted: Pixels, actual: Pixels): { mean:number; p95:number } {
  if (!actual.length || actual.length !== predicted.length) return {mean:Infinity,p95:Infinity};
  const bins = new Uint32Array(256);
  let sum = 0, count = 0;
  for (let i=0;i<actual.length;i+=4) {
    let worst = 0;
    for (let c=0;c<3;c++) {
      const error = Math.abs(predicted[i+c]-actual[i+c]);
      sum += error; worst = Math.max(worst,error);
    }
    bins[worst]++; count++;
  }
  let cumulative = 0, p95 = 255;
  for (let i=0;i<bins.length;i++) {
    cumulative += bins[i];
    if (cumulative >= count*0.95) { p95=i; break; }
  }
  return {mean:sum/(count*3*255),p95:p95/255};
}

const PROFILE = "immage.cachedPreviewTiming";
export function previewTiming(): { native:number; target:number } {
  try {
    const p = JSON.parse(localStorage.getItem(PROFILE) ?? "null");
    if (p && Number.isFinite(p.native) && p.native>0 && Number.isFinite(p.target) && p.target>0) return p;
  } catch { /* use initial budget */ }
  return {native:80,target:80};
}
export function storePreviewTiming(native:number, target:number) {
  if (!(native>0) || !Number.isFinite(native) || !(target>0) || !Number.isFinite(target)) return;
  try { localStorage.setItem(PROFILE,JSON.stringify({native,target})); } catch { /* session only */ }
}
export type PredictionAccuracy = { factor:number; recovering:boolean; good:number; failures:number };
export function predictionAccuracy(): PredictionAccuracy {
  return {factor:1,recovering:false,good:0,failures:0};
}

// recovery checks are private predictions: never display them until validated
export function validatePrediction(state:PredictionAccuracy, error:{mean:number;p95:number}): boolean {
  const risk = Math.max(error.mean/0.02,error.p95/0.06);
  if (!Number.isFinite(risk) || risk>1) {
    state.factor = 0.5;
    state.recovering = true;
    state.good = 0;
    state.failures++;
    return false;
  }
  if (risk>0.5) {
    state.factor = Math.max(0.5,state.factor*0.5);
    state.good = 0;
  } else {
    state.factor = Math.min(2,state.factor+0.25);
    state.good++;
    if (state.good>=2) state.recovering = false;
  }
  return true;
}

export function anchorInterval(native:number, target:number, factor=1): number {
  return Math.min(320,Math.max(40,Math.max(target,native*1.25)*factor));
}
