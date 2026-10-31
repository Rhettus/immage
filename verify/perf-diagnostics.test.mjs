// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import { PerfDiagnostics } from '../app/src/perfDiagnostics.ts';

test('bounded diagnostics report losses, preserve identities across resets and snapshot events', () => {
  const trace = new PerfDiagnostics(2);
  const id = trace.next();
  trace.record({ at: 1, label: 'drag', name: 'render.start', id });
  trace.record({ at: 2, label: 'release', name: 'render.end', id });
  trace.record({ at: 3, label: 'release', name: 'frame.raf', id });
  const report = trace.report();
  assert.equal(report.events.length, 2);
  assert.equal(report.droppedEvents, 1);
  assert.equal(report.events[0].id, report.events[1].id);
  trace.reset();
  assert.equal(trace.report().events.length, 0);
  assert.equal(trace.report().droppedEvents, 0);
  assert.equal(report.events.length, 2);
  assert.ok(trace.next() > id);
});

test('overlapping spans retain dispatch phase, finish independently and ignore stale completions', () => {
  const trace = new PerfDiagnostics();
  const base = trace.begin(1, 'idle', 'render', { kind:'base' });
  const edit = trace.begin(3, 'drag', 'render', { kind:'edit' });
  assert.deepEqual(trace.activeIds(), [base, edit]);
  trace.finish(4, base, 'cancelled');
  assert.deepEqual(trace.activeIds(), [edit]);
  trace.finish(6, edit);
  const events = trace.report().events;
  assert.equal(events[2].label, 'idle');
  assert.equal(events[2].name, 'render.cancelled');
  assert.equal(events[3].label, 'drag');
  assert.deepEqual(trace.report().unfinished, []);
  trace.reset();
  trace.finish(8, edit);
  assert.deepEqual(trace.report().events, []);
});


test('unfinished operation storage is bounded as well as event storage', () => {
  const trace = new PerfDiagnostics(1);
  const first = trace.begin(1, 'drag', 'render');
  trace.begin(2, 'drag', 'command');
  assert.equal(trace.report().unfinished.length,1);
  assert.equal(trace.report().droppedEvents,1);
  trace.finish(3,first);
  assert.equal(trace.report().unfinished.length,0);
  assert.equal(trace.report().droppedEvents,2);
});
