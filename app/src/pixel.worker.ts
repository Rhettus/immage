// SPDX-License-Identifier: GPL-3.0-or-later
import { runPixelTask, type PixelTask } from "./pixelTasks";
const worker = self as unknown as { onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (value: unknown, transfer: Transferable[]) => void };
worker.onmessage = ({ data }: MessageEvent<{ id: number; task: PixelTask }>) => {
  const start = performance.now();
  const result = runPixelTask(data.task);
  const transfer = result instanceof Uint8ClampedArray ? [result.buffer]
    : "bins" in result ? [...result.bins.map(b => b.buffer), result.small.px.buffer] : [];
  worker.postMessage({ id: data.id, result, workMs: performance.now() - start }, transfer);
};
