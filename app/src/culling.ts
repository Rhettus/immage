// SPDX-License-Identifier: GPL-3.0-or-later
// Pure targeting and bounded work scheduling shared by grid culling.
export function keywordTargets<T extends { imgid: number; remote?: unknown }>(
  images: T[], selection: Set<number>, hovered?: number,
): T[] {
  const selected = images.filter(i => selection.has(i.imgid) && !i.remote);
  return selected.length ? selected : images.filter(i => i.imgid === hovered && !i.remote);
}

// One active operation, one replaceable foreground request, and a bounded list of neighbors.
// Replacing pending work rejects its promise; active native work finishes safely.
export class PreviewQueue {
  private running = false;
  private pending: { run: () => Promise<void>; cancel: () => void }[] = [];
  replace() {
    for (const job of this.pending.splice(0)) job.cancel();
  }
  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ run: async () => { try { resolve(await run()); } catch (e) { reject(e); } },
        cancel: () => reject(new Error("Preview superseded")) });
      void this.pump();
    });
  }
  private async pump() {
    if (this.running) return;
    this.running = true;
    try { while (this.pending.length) await this.pending.shift()!.run(); }
    finally { this.running = false; }
  }
}

// A stable responsive frame keeps the toolbar and image viewport in place as
// photos, preview resolutions, and zoom modes change.
export function fitLightbox(windowWidth: number, windowHeight: number) {
  return {
    width: Math.max(1, Math.min(windowWidth * .8, windowWidth - 32)),
    height: Math.max(1, Math.min(windowHeight * .8, windowHeight - 32)),
  };
}

// Keep the lightbox's relative zoom multiplier in step with the editor. Null
// means the wheel returned to Fit; 1 is 100% and 4 is the maximum detail.
export function wheelZoom(from: number, deltaY: number, ctrlKey: boolean, fitScale: number): number | null {
  const delta = Math.max(-50, Math.min(50, deltaY));
  let to = Math.min(4, from * Math.exp(-delta * (ctrlKey ? .006 : .0008)));
  // Stop at native resolution so one detent cannot skip across 100%.
  if ((from < 1 && to > 1) || (from > 1 && to < 1)) to = 1;
  return to <= fitScale * 1.001 ? null : to;
}

// Match editor read-ahead: nearest first in the last navigation direction,
// then the same count behind when enabled. The caller supplies visible order.
export function previewNeighbors<T extends { imgid: number; remote?: unknown }>(
  images: T[], current: number, direction: 1 | -1, count: number, both: boolean,
): T[] {
  const at = images.findIndex(i => i.imgid === current);
  if (at < 0) return [];
  const result: T[] = [];
  for (const dir of both ? [direction, -direction] : [direction]) {
    for (let step = 1; step <= count; step++) {
      const image = images[at + dir * step];
      if (image && !image.remote) result.push(image);
    }
  }
  return result;
}

// The photo the lightbox moves to when the current one leaves the list: the
// one now at its old position, else the last, else none (closing it).
export function fallbackPhoto<T extends { imgid: number }>(images: T[], previousIndex: number): number | null {
  return images[Math.min(previousIndex, images.length - 1)]?.imgid ?? null;
}

export type CullingAction =
  | { type: "closeKeywords" | "closeLightbox" | "toggleLightbox" | "keywords" | "toggleZoom" | "holdSpace" | "toggleReject" | "togglePick" | "none" }
  | { type: "step"; by: -1 | 1 }
  | { type: "rate"; value: number }
  | { type: "label"; bit: number };

// What a key does in grid culling and its lightbox: `ignore` leaves the event
// alone, `swallow` stops other handlers without acting (the lightbox owns the
// keyboard), `consume` also prevents the default and runs `action`.
// The photo F, the toolbar button and the menu act on: the one asked for, else
// the hovered one, else the anchor if selected, else the first selected.
export function pickCullingTarget<T extends { imgid: number }>(
  images: T[], asked: number | undefined, hovered: string | null | undefined, anchor: number | null, selection: Set<number>,
): T | undefined {
  const over = hovered === null || hovered === undefined ? NaN : Number(hovered);
  return images.find(i => i.imgid === asked) ?? images.find(i => i.imgid === over)
    ?? images.find(i => i.imgid === anchor && selection.has(i.imgid)) ?? images.find(i => selection.has(i.imgid));
}

export function cullingKey(k: string, s: {
  photo: number | null; keywordsOpen: boolean; writing: boolean; blocked: boolean; modalOpen: boolean;
  hasTarget: boolean; hasCurrent: boolean;
}): { kind: "ignore" | "swallow" | "consume"; action?: CullingAction } {
  const none = { type: "none" } as const;
  if (s.keywordsOpen && k === "escape") {
    return { kind: "consume", action: s.writing ? none : { type: "closeKeywords" } };
  }
  if (s.blocked) return { kind: "ignore" };
  if (s.modalOpen && !s.photo && !s.keywordsOpen) return { kind: "ignore" };
  if (s.photo !== null && !s.keywordsOpen && k === " ") return { kind: "consume", action: { type: "holdSpace" } };
  const handled = /^(f|k|z|escape|arrowleft|arrowright|[0-9]|x|pick)$/.test(k);
  if (s.photo !== null && !handled) return { kind: "swallow" };
  if (!handled) return { kind: "ignore" };
  if (!s.photo && !s.keywordsOpen && k !== "f" && k !== "k") return { kind: "ignore" };
  if (s.keywordsOpen && k !== "escape") return { kind: "ignore" };
  if (!s.photo && !s.hasTarget) return { kind: "ignore" };
  const c = s.hasCurrent;
  let action: CullingAction = none;
  if (k === "escape") action = s.keywordsOpen ? { type: "closeKeywords" } : { type: "closeLightbox" };
  else if (k === "f") action = { type: "toggleLightbox" };
  else if (k === "k") action = { type: "keywords" };
  else if (k === "z") { if (c) action = { type: "toggleZoom" }; }
  else if (k === "arrowleft" || k === "arrowright") { if (c) action = { type: "step", by: k === "arrowleft" ? -1 : 1 }; }
  else if (/^[0-5]$/.test(k)) { if (c) action = { type: "rate", value: Number(k) }; }
  else if (/^[6-9]$/.test(k)) { if (c) action = { type: "label", bit: Number(k) - 6 }; }
  else if (k === "pick") { if (c) action = { type: "togglePick" }; }
  else if (k === "x") { if (c) action = { type: "toggleReject" }; }
  return { kind: "consume", action };
}
