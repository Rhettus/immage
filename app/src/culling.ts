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

// Fit the actual preview, keeping its aspect ratio and never enlarging it.
// The toolbar and padding belong outside the image rectangle.
export function fitLightbox(width: number, height: number, windowWidth: number, windowHeight: number, toolbar: number) {
  width = Math.max(1, width); height = Math.max(1, height);
  const scale = Math.min(1, Math.max(1, windowWidth * .86 - 24) / width,
    Math.max(1, windowHeight * .86 - toolbar - 24) / height);
  return { width: Math.ceil(width * scale + 24), height: Math.ceil(height * scale + toolbar + 24) };
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
