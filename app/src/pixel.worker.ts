// SPDX-License-Identifier: GPL-3.0-or-later
import { runPixelTask, type PixelTask } from "./pixelTasks";
const worker = self as unknown as { onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (value: unknown, transfer: Transferable[]) => void };
const anchors = new Map<number, Uint8ClampedArray<ArrayBuffer>>();
worker.onmessage = ({ data }: MessageEvent<{ id: number; task: PixelTask; validationIds?: number[] }>) => {
  const start = performance.now();
  const task = data.task;
  if (data.validationIds?.length) {
    const keys = ["pixels", "other", "actual"] as const;
    data.validationIds.forEach((id, i) => {
      const key = keys[i];
      const pixels = task[key]!;
      if (!anchors.has(id)) anchors.set(id, pixels);
      task[key] = anchors.get(id)!;
    });
    for (const id of anchors.keys()) if (!data.validationIds.includes(id)) anchors.delete(id);
  }
  const result = runPixelTask(task);
  const transfer = result instanceof Uint8ClampedArray ? [result.buffer]
    : "bins" in result ? [...result.bins.map(b => b.buffer), result.small.px.buffer] : [];
  worker.postMessage({ id: data.id, result, workMs: performance.now() - start }, transfer);
};
