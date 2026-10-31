// SPDX-License-Identifier: GPL-3.0-or-later
import { runPixelTask, type PixelTask, type PixelResult } from "./pixelTasks";
import { perf } from "./perf";

type Job = { id: number; key: string; task: PixelTask; done: (result: PixelResult) => void;
  label: string; queuedAt: number; startedAt?: number };
// One running task and one latest pending task per surface. Original frame
// buffers stay owned by the renderer; only a dispatched copy is transferred.
export class PixelWorker {
  private worker: Worker | null = null;
  private failed = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private serial = 0;
  private active: Job | null = null;
  private pending = new Map<string, Job>();
  private latest = new Map<string, number>();
  constructor(private factory = () => new Worker(new URL("./pixel.worker.ts", import.meta.url), { type: "module" })) {}

  get threaded() { return !!this.worker && !this.failed; }

  submit(key: string, task: PixelTask, done: Job["done"]) {
    const id = ++this.serial;
    this.latest.set(key, id);
    if (this.pending.has(key)) perf.count("workerCoalesced");
    this.pending.set(key, { id, key, task, done, label: perf.label, queuedAt: performance.now() });
    this.pump();
  }
  cancel(key: string) { this.latest.delete(key); this.pending.delete(key); }
  dispose() {
    if (this.watchdog !== null) clearTimeout(this.watchdog); this.watchdog = null;
    this.worker?.terminate(); this.worker = null; this.active = null;
    this.pending.clear(); this.latest.clear();
  }
  private finish(result: PixelResult, workMs: number) {
    const job = this.active;
    if (!job) return;
    if (this.watchdog !== null) clearTimeout(this.watchdog); this.watchdog = null;
    this.active = null;
    perf.work(`${this.failed ? "main" : "worker"}.${job.task.kind}.compute`, workMs, job.label);
    perf.work(`worker.${job.task.kind}.roundTrip`, performance.now() - job.startedAt!, job.label);
    if (this.latest.get(job.key) === job.id) {
      this.latest.delete(job.key);
      job.done(result);
    } else perf.count("workerDiscarded");
    this.pump();
  }
  private fallback() {
    if (this.watchdog !== null) clearTimeout(this.watchdog); this.watchdog = null;
    this.failed = true; this.worker?.terminate(); this.worker = null;
    const job = this.active;
    if (job) {
      // Keep the newest queued task, rather than recomputing an obsolete one.
      this.active = null;
      if (this.latest.get(job.key) === job.id) this.pending.set(job.key, job);
    }
    perf.count("workerFallback");
    this.pump();
  }
  private pump() {
    if (this.active || !this.pending.size) return;
    const job = this.pending.values().next().value!;
    this.pending.delete(job.key); this.active = job;
    job.startedAt = performance.now();
    perf.work(`worker.${job.task.kind}.queue`, job.startedAt - job.queuedAt, job.label);
    if (!this.worker && !this.failed) {
      try {
        this.worker = this.factory();
        this.worker.onmessage = ({ data }) => {
          if (data.id === this.active?.id) this.finish(data.result, data.workMs);
        };
        this.worker.onerror = event => { event.preventDefault(); this.fallback(); };
        this.worker.onmessageerror = () => this.fallback();
      } catch { this.fallback(); return; }
    }
    if (this.failed) {
      const start = performance.now();
      const result = runPixelTask(job.task);
      this.finish(result, performance.now() - start);
      return;
    }
    try {
      const actual = job.task.actual ? perf.time("pixels.copy", () => job.task.actual!.slice()) : undefined;
      const other = job.task.other ? perf.time("pixels.copy", () => job.task.other!.slice()) : undefined;
      const pixels = perf.time("pixels.copy", () => job.task.pixels.slice());
      perf.count("pixelBytesCopied", pixels.byteLength + (other?.byteLength ?? 0) + (actual?.byteLength ?? 0));
      perf.time("worker.postMessage", () => this.worker!.postMessage({ id: job.id, task: { ...job.task, pixels, other, actual } }, [pixels.buffer, ...(other ? [other.buffer] : []), ...(actual ? [actual.buffer] : [])]));
      this.watchdog = setTimeout(() => this.fallback(), 10000);
    } catch { this.fallback(); }
  }
}
