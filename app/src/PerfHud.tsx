// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the performance overlay over the photo (Preferences > General >
// Performance, or ⇧⌘P): Now has the display's frame rate, edit-to-pixels
// latency, where the last frame's time went and every module in it; Session
// keeps the slowest response of each kind and every module instance's times
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { perf, percentiles, STAGES, type Sample, type Stage, type Timing } from "./perf";

// by kind of work, as the benchmark dashboard shows them: waiting, set_params,
// darktable's pipeline, moving the frame, the page's own work, the histogram
const WAIT = "#8a8a8a", SET = "#9586f0", PIPE = "#5c97f5", MOVE = "#4fbccd", PAGE = "#d77abb", HIST = "#eb9a4d";
export const STAGE_COLORS: Record<Stage, string> = {
  queue: WAIT, set: SET, lock: WAIT, pipeline: PIPE, write: MOVE, read: MOVE, probe: WAIT, ipc: MOVE,
  handoff: PAGE, draw: PAGE, histogram: HIST, paint: PAGE,
};

const ms = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
// a session's cumulative time, which outgrows milliseconds
const long = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : ms(v));

const TAB_KEY = "immage.perfHudTab";
type Tab = "now" | "session";
function loadTab(): Tab {
  try { return localStorage.getItem(TAB_KEY) === "session" ? "session" : "now"; } catch { return "now"; }
}

// from how long ago, in ms
function ago(elapsed: number) {
  const s = Math.round(elapsed / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function Stages({ s }: { s: Sample }) {
  return (
    <>
      <div className="perf-bar">
        {STAGES.map((k) => s.stages[k] > 0.05 && (
          <i key={k} style={{ flexGrow: s.stages[k], background: STAGE_COLORS[k] }}
             title={`${k} ${ms(s.stages[k])} ms`} />
        ))}
      </div>
      <div className="perf-legend">
        {STAGES.filter((k) => s.stages[k] >= 1).map((k) => (
          <span key={k}><i style={{ background: STAGE_COLORS[k] }} />{k} {ms(s.stages[k])}</span>
        ))}
      </div>
    </>
  );
}

const Pipe = ({ pipe }: { pipe: string }) => (pipe && pipe !== "full" ? <em className="perf-pipe">{pipe}</em> : null);
const flags = (m: { gpu: boolean; tiled: boolean }) => `${m.gpu ? " (GPU)" : ""}${m.tiled ? " tiled" : ""}`;

function Modules({ list }: { list: Timing[] }) {
  return (
    <>
      {list.map((m, i) => (
        <div key={i} className="perf-row">
          <span>{m.label}<Pipe pipe={m.pipe} />{flags(m)}</span><b>{ms(m.ms)} ms</b>
        </div>
      ))}
    </>
  );
}

function Now() {
  const now = performance.now();
  const edits = perf.samples.filter((s) => s.kind === "edit").slice(-60);
  const { p50, p95 } = percentiles(edits.map((s) => s.total));
  const lastSecond = perf.samples.filter((s) => now - s.at < 1000).length;
  const last: Sample | undefined = perf.samples[perf.samples.length - 1];
  const modules = last ? last.modules.filter((m) => m.kind !== "other").sort((a, b) => b.ms - a.ms) : [];
  const recomputed = last?.modules.filter((m) => m.kind === "module").length ?? 0;
  return (
    <>
      <div className="perf-row"><span>display</span><b>{perf.fps.toFixed(0)} fps</b><span>{perf.longFrames} long</span></div>
      <div className="perf-row"><span>renders</span><b>{lastSecond}/s</b></div>
      <div className="perf-row"><span>edit → pixels</span><b>{ms(p50)} ms</b><span>p95 {ms(p95)}</span></div>
      {last && (
        <>
          <div className="perf-row">
            <span>last {last.kind}{last.draft ? " (draft)" : ""}</span><b>{ms(last.total)} ms</b>
            <span>{last.width}×{last.height}{last.edits > 1 ? `, ${last.edits} moves` : ""}</span>
          </div>
          <Stages s={last} />
          {modules.length > 0 && (
            <div className="perf-modules">
              <span className="perf-sub">{recomputed} modules recomputed</span>
              <div className="perf-scroll"><Modules list={modules} /></div>
              <div className="perf-row perf-total">
                <span>total</span><b>{ms(modules.reduce((t, m) => t + m.ms, 0))} ms</b>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

function SessionTab() {
  const [, redraw] = useState(0);
  const { since, worst, modules } = perf.session;
  const kinds = (["edit", "view", "base"] as const).filter((k) => worst[k]);
  const stats = [...modules.values()].sort((a, b) => b.max - a.max);
  const runs = stats.reduce((t, m) => t + m.runs, 0);
  const total = stats.reduce((t, m) => t + m.total, 0);
  return (
    <>
      <div className="perf-row">
        <span className="perf-sub">since {new Date(since).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <button className="perf-reset" onClick={() => { perf.resetSession(); redraw((n) => n + 1); }}>Reset</button>
      </div>
      {kinds.length === 0 && <div className="perf-sub">no renders yet</div>}
      {kinds.map((k) => {
        const s = worst[k]!;
        const top = s.modules.filter((m) => m.kind !== "other").sort((a, b) => b.ms - a.ms).slice(0, 3);
        return (
          <div key={k} className="perf-worst">
            <div className="perf-row">
              <span>slowest {k}{s.draft ? " (draft)" : ""}</span><b>{ms(s.total)} ms</b>
              <span>{s.width}×{s.height}{s.edits > 1 ? `, ${s.edits} moves` : ""}, {ago(performance.now() - s.at)}</span>
            </div>
            <Stages s={s} />
            <Modules list={top} />
          </div>
        );
      })}
      {stats.length > 0 && (
        <div className="perf-modules">
          <div className="perf-row perf-thead"><span>module</span><i>runs</i><i>last</i><i>avg</i><i>max</i><b>total</b></div>
          <div className="perf-scroll">
            {stats.map((m) => (
              <div key={`${m.label} ${m.pipe}`} className="perf-row" title={`max ${ago(Date.now() - m.maxAt)}`}>
                <span>{m.label}<Pipe pipe={m.pipe} />{flags(m)}</span>
                <i>{m.runs}</i><i>{ms(m.last)}</i><i>{ms(m.total / m.runs)}</i><i className="perf-max">{ms(m.max)}</i><b>{long(m.total)}</b>
              </div>
            ))}
          </div>
          <div className="perf-row perf-total">
            <span>total</span><i>{runs}</i><i /><i /><i /><b>{long(total)}</b>
          </div>
        </div>
      )}
    </>
  );
}

export function PerfHud({ onClose }: { onClose: () => void }) {
  const [, tick] = useState(0);
  const [tab, setTab] = useState<Tab>(loadTab);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, []);
  const pick = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem(TAB_KEY, t); } catch { /* not kept */ }
  };
  return (
    // the viewer's pointerdown zooms; the tabs, close and lists are not the photo
    <div className="perf-hud" onPointerDown={(e) => e.stopPropagation()}>
      <div className="perf-head">
        <nav className="perf-tabs">
          <button className={tab === "now" ? "on" : ""} onClick={() => pick("now")}>Now</button>
          <button className={tab === "session" ? "on" : ""} onClick={() => pick("session")}>Session</button>
        </nav>
        <button className="perf-close" title="close (⇧⌘P)" aria-label="close" onClick={onClose}><X size={13} /></button>
      </div>
      {tab === "now" ? <Now /> : <SessionTab />}
    </div>
  );
}
