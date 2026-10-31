// SPDX-License-Identifier: GPL-3.0-or-later
// Keep high-rate input publication separate from immediate engine edits.
export class FrameUpdates<T> {
  private pending: ((value: T) => T)[] = [];
  private frame: number | null = null;
  constructor(private publish: (update: (value: T) => T) => void,
    private request = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
    private cancel = (id: number) => cancelAnimationFrame(id)) {}
  enqueue(update: (value: T) => T) {
    this.pending.push(update);
    this.frame ??= this.request(() => this.flush());
  }
  flush() {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null;
    if (!this.pending.length) return;
    const pending = this.pending; this.pending = [];
    this.publish(value => pending.reduce((next, update) => update(next), value));
  }
  // Discrete changes (undo, preset, photo switch) follow queued input in order.
  immediate(update: (value: T) => T) { this.flush(); this.publish(update); }
  dispose() {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null; this.pending = [];
  }
}

// Subscribers redraw scopes/curves without rendering the editor around them.
export class Snapshot<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}
  get = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  set(value: T) {
    if (Object.is(this.value, value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}
