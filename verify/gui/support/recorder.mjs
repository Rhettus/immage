// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//
// Records a demo clip of the dedicated test app: webview screenshots only,
// taken through the run's WebDriver session, plus a log of where the scripted
// pointer went. WebDriver shows no native cursor, so the assembler
// (verify/gui/demo-assemble.mjs) draws one afterwards from that log; nothing
// is injected into the page.
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const MOVE_MS = 120, STEP_MS = 80;

export class Recorder {
  constructor(driver, dir) {
    this.driver = driver; this.dir = dir; this.frames = []; this.cursor = []; this.captions = [];
    this.running = false; this.paused = false; this.t0 = 0; this.pos = null; this.scale = 1;
  }
  now() { return performance.now() - this.t0; }
  point(x, y, ms) { this.cursor.push({ t: this.now(), x, y, ms }); this.pos = { x, y }; }
  click() { this.cursor.push({ t: this.now(), x: this.pos.x, y: this.pos.y, click: true }); }
  // Wrap the driver's pointer actions so the log follows every move. Calls
  // are unchanged; only their coordinates and timing are noted.
  wrap() {
    const d = this.driver, rec = this;
    const original = { point: d.point, move: d.move, drag: d.drag, wheel: d.wheel };
    d.point = async function (x, y, clicks = 1) {
      rec.point(x, y, MOVE_MS);
      const done = original.point.call(this, x, y, clicks);
      await done;
      for (let i = 0; i < clicks; i++) rec.click();
    };
    d.move = async function (x, y) { rec.point(x, y, MOVE_MS); return original.move.call(this, x, y); };
    d.drag = async function (from, to) {
      rec.point(from.x, from.y, MOVE_MS);
      const started = rec.now() + MOVE_MS;
      for (let i = 1; i <= 8; i++)
        rec.cursor.push({ t: started + i * STEP_MS, x: from.x + (to.x - from.x) * i / 8, y: from.y + (to.y - from.y) * i / 8, ms: STEP_MS, down: true });
      return original.drag.call(this, from, to);
    };
    d.wheel = async function (x, y, ...rest) { rec.point(x, y, MOVE_MS); return original.wheel.call(this, x, y, ...rest); };
    this.unwrap = () => Object.assign(d, original);
  }
  async start() {
    await mkdir(join(this.dir, 'frames'), { recursive: true });
    this.scale = await this.driver.observe(() => devicePixelRatio);
    const view = await this.driver.observe(() => ({ width: innerWidth, height: innerHeight }));
    this.view = view;
    this.pos = { x: view.width / 2, y: view.height / 2 };
    this.t0 = performance.now(); this.running = true;
    this.cursor.push({ t: 0, x: this.pos.x, y: this.pos.y, ms: 0 });
    this.wrap();
    this.loop = this.capture();
  }
  async capture() {
    while (this.running) {
      if (this.paused) { await new Promise(r => setTimeout(r, 50)); continue; }
      const before = this.now();
      const name = `f${String(this.frames.length).padStart(5, '0')}.png`;
      try { await this.driver.screenshot(join(this.dir, 'frames', name)); }
      catch (error) { if (this.running) throw error; return; }
      this.frames.push({ file: `frames/${name}`, t: (before + this.now()) / 2 });
    }
  }
  caption(text) { this.captions.push({ t: this.now(), text }); }
  // A paused stretch is cut from the clip: its time is subtracted afterwards.
  pause() { this.paused = true; this.cutFrom = this.now(); }
  resume() { this.cuts = [...(this.cuts ?? []), [this.cutFrom, this.now()]]; this.paused = false; }
  async stop() {
    this.running = false; await this.loop; this.unwrap?.();
    const cuts = this.cuts ?? [];
    // time on the clip: real time minus the paused stretches before it
    const clip = t => t - cuts.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(t, b) - a), 0);
    const timeline = { scale: this.scale, view: this.view,
      frames: this.frames.map(f => ({ file: f.file, t: clip(f.t) })),
      cursor: this.cursor.map(c => ({ ...c, t: clip(c.t) })),
      captions: this.captions.map(c => ({ ...c, t: clip(c.t) })) };
    await writeFile(join(this.dir, 'timeline.json'), JSON.stringify(timeline));
    return timeline;
  }
}
