// SPDX-License-Identifier: GPL-3.0-or-later
// One frontend clock; events describe overlap, not additive stage durations.
export type DiagnosticEvent = { at: number; label: string; name: string; id?: number; data?: Record<string, unknown> };
export class PerfDiagnostics {
  private serial = 0;
  private events: DiagnosticEvent[] = [];
  private dropped = 0;
  private active = new Map<number, DiagnosticEvent>();
  private limit: number;
  constructor(limit = 30000) { this.limit = limit; }
  reset() { this.events = []; this.dropped = 0; this.active.clear(); }
  next() { return ++this.serial; }
  record(event: DiagnosticEvent) {
    if (this.events.length < this.limit) this.events.push(event);
    else this.dropped++;
  }
  begin(at: number, label: string, name: string, data?: Record<string, unknown>) {
    const id = this.next();
    if (this.active.size >= this.limit) { this.dropped++; return id; }
    const event = { at, label, name: `${name}.start`, id, data };
    this.active.set(id, event); this.record(event);
    return id;
  }
  finish(at: number, id: number | undefined, outcome = "end", data?: Record<string, unknown>) {
    if (id === undefined) return;
    const start = this.active.get(id);
    if (!start) return;
    this.active.delete(id);
    this.record({ at, label: start.label, name: `${start.name.slice(0, -6)}.${outcome}`, id, data });
  }
  activeIds() { return [...this.active.keys()]; }
  activeEvents() { return [...this.active.values()]; }
  report() {
    return { clock: 'frontend performance.now()', presentation: 'next animation callback, not compositor presentation',
      capabilities: ['input-attribution', 'frame-outcomes', 'frontend-operation-spans', 'scheduling-events', 'preview-decisions', 'native-engine-lock-spans'],
      droppedEvents: this.dropped, unfinished: [...this.active.values()], events: this.events.slice() };
  }
}
