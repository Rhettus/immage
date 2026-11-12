// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Preferences' GPU check: the edit, then each module with an OpenCL path
// changed by darktable updates, rendered on the CPU and on the GPU and
// compared (engine main.c, _parity). darktable's integration tests accept
// dE < 2 between the two

import type { ParityReply } from "./commands";

// `to` sets a value; `by` moves a slider by that share of its range
export type CaseStep = { id: string; to?: number; by?: number };
export type GpuCase = { id: string; label: string; op: string; steps: CaseStep[] };

export const GPU_CASES: GpuCase[] = [
  { id: "edit", label: "the edit as it is", op: "", steps: [] },
  { id: "exposure", label: "Exposure", op: "exposure", steps: [{ id: "exposure", by: 0.1 }] },
  { id: "toneequal", label: "Shadows and Highlights (tone equalizer)", op: "toneequal",
    steps: [{ id: "mod_tone", to: 0 }, { id: "shadows", by: 0.25 }, { id: "highlights", by: -0.25 }] },
  { id: "shadhi", label: "Shadows and Highlights (shadows and highlights)", op: "shadhi",
    steps: [{ id: "mod_tone", to: 1 }, { id: "shadows", by: 0.25 }, { id: "highlights", by: -0.25 }] },
  { id: "diffuse", label: "Texture (diffuse or sharpen)", op: "diffuse",
    steps: [{ id: "mod_texture", to: 0 }, { id: "texture", by: 0.2 }] },
  { id: "contrastntexture-texture", label: "Texture (contrast & texture)", op: "contrastntexture",
    steps: [{ id: "mod_texture", to: 1 }, { id: "detail_texture_gain_fine", by: 0.2 }] },
  { id: "bilat", label: "Clarity (local contrast)", op: "bilat",
    steps: [{ id: "mod_clarity", to: 0 }, { id: "clarity", by: 0.2 }] },
  { id: "contrastntexture-clarity", label: "Clarity (contrast & texture)", op: "contrastntexture",
    steps: [{ id: "mod_clarity", to: 1 }, { id: "detail_clarity_gain_medium", by: 0.2 }] },
  { id: "hazeremoval", label: "Dehaze", op: "hazeremoval", steps: [{ id: "dehaze", by: 0.15 }] },
  { id: "denoiseprofile", label: "Luminance noise reduction", op: "denoiseprofile",
    steps: [{ id: "nr_luminance", by: 0.4 }] },
  { id: "lens", label: "Lens profile", op: "lens", steps: [{ id: "lens_profile", to: 1 }] },
  { id: "sharpen", label: "Sharpening", op: "sharpen", steps: [{ id: "mod_sharpening", to: 0 }, { id: "usm_amount", by: 0.3 }] },
  { id: "vignette", label: "Vignette", op: "vignette", steps: [{ id: "vig_amount", by: -0.15 }] },
  { id: "grain", label: "Grain", op: "grain", steps: [{ id: "grain_amount", by: 0.3 }] },
  { id: "colorbalancergb", label: "Vibrance", op: "colorbalancergb", steps: [{ id: "vibrance", by: 0.15 }] },
  { id: "temperature", label: "White balance", op: "temperature", steps: [{ id: "temp", by: 0.05 }] },
];

export type Range = { min: number; max: number };
export type Resolved = { entries: [string, number][] } | { skipped: string };

// a case's edits from the photo's values: a choice first, then the sliders
// it shows. a slider the photo cannot show (another module chosen, a raw-only
// control on a JPEG) skips the case rather than testing something else
export function resolveCase(c: GpuCase, values: Record<string, number>, range: (id: string) => Range | undefined,
                            shows: (id: string, v: Record<string, number>) => boolean): Resolved {
  const v = { ...values };
  const entries: [string, number][] = [];
  for (const step of c.steps) {
    if (step.to !== undefined) {
      v[step.id] = step.to;
      entries.push([step.id, step.to]);
      continue;
    }
    const r = range(step.id);
    if (!r) return { skipped: `no control ${step.id}` };
    if (!shows(step.id, v)) return { skipped: `${step.id} not shown for this photo` };
    const from = v[step.id] ?? 0;
    let to = from + (step.by ?? 0) * (r.max - r.min);
    // a slider already near its end moves the other way
    if (to > r.max || to < r.min) to = from - (step.by ?? 0) * (r.max - r.min);
    to = Math.min(r.max, Math.max(r.min, to));
    v[step.id] = to;
    entries.push([step.id, to]);
  }
  return { entries };
}

export type Parity = ParityReply;

// the modules darktable ran on the CPU in the GPU pass: no OpenCL code, a
// kernel that did not build, or a device out of memory
export const cpuInGpuPass = (p: Parity) =>
  [...new Set((p.modules?.gpu ?? []).filter((m) => m.kind === "module" && !m.gpu).map((m) => m.label))];
export const tiledInGpuPass = (p: Parity) =>
  [...new Set((p.modules?.gpu ?? []).filter((m) => m.kind === "module" && m.tiled).map((m) => m.label))];

// a module's second instance is timed as `contrastntexture.1`
export const opOf = (label: string) => label.replace(/\.\d+$/, "");

export type Verdict = { pass: boolean; reasons: string[]; notes: string[] };

// a case passes when the GPU pass ran on a device, without falling back to
// the CPU, and its frame is within dE 2 of the CPU's for 99% of pixels. a
// module darktable keeps on the CPU (contrast & texture had no OpenCL code
// before darktable 7d7dac363d) is noted, not failed
export function verdict(p: Parity, op: string): Verdict {
  const reasons: string[] = [];
  if (p.gpu.devid < 0) reasons.push("no device for the GPU pass");
  if (p.gpu.cl_errors > 0) reasons.push(`OpenCL failed and the pipe reran on the CPU (${p.gpu.cl_errors})`);
  if (p.de.p99 >= 2) reasons.push(`dE p99 ${p.de.p99.toFixed(2)}`);
  const notes: string[] = [];
  if (op && cpuInGpuPass(p).some((l) => opOf(l) === op)) notes.push(`${op} ran on the CPU`);
  if (op && tiledInGpuPass(p).some((l) => opOf(l) === op)) notes.push(`${op} was tiled`);
  return { pass: reasons.length === 0, reasons, notes };
}
