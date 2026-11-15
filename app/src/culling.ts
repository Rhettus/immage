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
