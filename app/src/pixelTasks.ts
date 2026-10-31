// SPDX-License-Identifier: GPL-3.0-or-later
import { mixDetailPixels, mixedPredictionError } from "./cachedDetail";
import { computeHistogram, type Histogram, type ClipShow } from "./histogram";

export type PixelTask = { kind: "histogram" | "clipping" | "mix" | "validation"; pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number; height: number; show?: ClipShow; other?: Uint8ClampedArray<ArrayBuffer>; mix?: number; actual?: Uint8ClampedArray<ArrayBuffer> };
export type PixelResult = Histogram | Uint8ClampedArray<ArrayBuffer> | { mean: number; p95: number };
export function runPixelTask(task: PixelTask): PixelResult {
  if (task.kind === "validation") return mixedPredictionError(task.pixels, task.other!, task.actual!, task.mix!);
  if (task.kind === "mix") return mixDetailPixels(task.pixels, task.other!, task.mix!);
  if (task.kind === "histogram") return computeHistogram(task.pixels, task.width, task.height);
  const out = new Uint8ClampedArray(task.pixels.length), px = task.pixels;
  for (let i = 0; i < px.length; i += 4) {
    if (task.show?.high && (px[i] === 255 || px[i+1] === 255 || px[i+2] === 255)) {
      out[i] = 255; out[i+3] = 255;
    } else if (task.show?.low && (px[i] === 0 || px[i+1] === 0 || px[i+2] === 0)) {
      out[i+1] = 64; out[i+2] = 255; out[i+3] = 255;
    }
  }
  return out;
}
