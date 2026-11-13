// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a panel as an accordion of steps, for the Film Simulation and Negative
// panels: every step is listed, one is open, the rest fold to a line with
// their number, title and a summary of their values. Back and Next walk the
// steps that can be opened; the open step is remembered per panel
import { useState } from "react";
import { Check, Lock } from "lucide-react";
import { Chevron, Collapse } from "./Collapse";
import { settings } from "./settings";

export type Step = {
  id: string; title: string; summary: string;
  locked?: boolean; lockNote?: string;
  // not a step to open or walk to, though listed (the summary says why)
  skipped?: boolean;
  hidden?: boolean;
  content: React.ReactNode;
};

const KEY = "immage.steps.open";
function load(): Record<string, string> {
  try { return JSON.parse(settings.get(KEY) ?? "{}") ?? {}; } catch { return {}; }
}

// the open step of a panel, "" for all folded; read again before writing,
// as every panel keeps its own copy
export function useStepOpen(panel: string): [string | null, (id: string) => void] {
  const [open, setOpen] = useState<string | null>(() => load()[panel] ?? null);
  const set = (id: string) => {
    const all = load();
    all[panel] = id;
    try { settings.set(KEY, JSON.stringify(all)); } catch { /* not kept */ }
    setOpen(id);
  };
  return [open, set];
}

const usable = (s: Pick<Step, "hidden" | "locked" | "skipped">) => !s.hidden && !s.locked && !s.skipped;

// the step that is open: the one remembered if it can be, "" when all are
// folded, else the first that can be opened
export function openStep(steps: Pick<Step, "id" | "hidden" | "locked" | "skipped">[], open: string | null): string {
  if (open === "") return "";
  const s = steps.find((x) => x.id === open);
  return s && usable(s) ? s.id : steps.find(usable)?.id ?? "";
}

export function GuidedSteps({ steps, open, onOpen }: {
  steps: Step[]; open: string | null; onOpen: (id: string) => void;
}) {
  const [visited, setVisited] = useState<Set<string>>(new Set());
  const shown = steps.filter((s) => !s.hidden);
  const current = openStep(steps, open);
  const walk = shown.filter(usable);
  const go = (id: string) => {
    if (current) setVisited((v) => new Set(v).add(current));
    onOpen(id);
  };
  const at = walk.findIndex((s) => s.id === current);
  return (
    <div className="steps">
      {shown.map((s, i) => {
        const on = s.id === current;
        const done = visited.has(s.id) && usable(s) && !on;
        const dead = !!s.locked || !!s.skipped;
        return (
          <div key={s.id} data-step={s.id}
               className={`step${on ? " open" : ""}${s.locked ? " locked" : ""}${s.skipped ? " skipped" : ""}${done ? " done" : ""}`}>
            <button type="button" className="step-head" aria-expanded={on} aria-disabled={dead || undefined}
                    onClick={() => { if (!dead) go(on ? "" : s.id); }}>
              <span className="num">{done ? <Check size={11} strokeWidth={3} /> : i + 1}</span>
              <span className="step-main">
                <span className="step-title">{s.title}</span>
                <span className="step-sum">
                  {s.locked && <Lock size={11} strokeWidth={2.2} />}{s.locked ? s.lockNote ?? s.summary : s.summary}
                </span>
              </span>
              <span className="step-chev"><Chevron open={on} /></span>
            </button>
            <Collapse open={on}>
              <div className="step-body">
                {s.content}
                <div className="step-nav">
                  <button type="button" className="btn small" disabled={at <= 0}
                          onClick={() => go(walk[at - 1].id)}>Back</button>
                  <button type="button" className="btn small primary"
                          onClick={() => go(at >= walk.length - 1 ? "" : walk[at + 1].id)}>
                    {at >= walk.length - 1 ? "Done" : "Next"}</button>
                </div>
              </div>
            </Collapse>
          </div>
        );
      })}
    </div>
  );
}
