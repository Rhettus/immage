// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { type Job, dismissJob, stopJob } from "./background";
import { t } from "./i18n";

// how long a message stays up with no action, then how long it takes to fade
const NOTICE_MS = 15000;
const FADE_MS = 400;

// a finished message in a corner of the viewer: it fades away and is removed
// (`onDone`) NOTICE_MS after `stamp` last changed, unless the pointer is over
// it; leaving restarts the wait. A click on its body, not a button, removes it
// at once. `stamp` is anything that changes when the message is shown again,
// even with the same words. Inactive, it is a plain box.
export function Notice({ stamp, onDone, active = true, className, children, ...rest }: {
  stamp: unknown; onDone: () => void; active?: boolean; className: string; children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const [fading, setFading] = useState(false);
  const over = useRef(false);
  const timer = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  const arm = () => {
    window.clearTimeout(timer.current);
    setFading(false);
    if (!active) return;
    timer.current = window.setTimeout(() => {
      setFading(true);
      timer.current = window.setTimeout(() => done.current(), FADE_MS);
    }, NOTICE_MS);
  };
  const armRef = useRef(arm);
  armRef.current = arm;
  useEffect(() => {
    if (!over.current) armRef.current();
    else { window.clearTimeout(timer.current); setFading(false); }
    return () => window.clearTimeout(timer.current);
  }, [stamp, active]);
  return (
    <div {...rest} className={`${className} notice${fading ? " fading" : ""}`} {...keepPointer}
         onPointerEnter={() => { over.current = true; window.clearTimeout(timer.current); setFading(false); }}
         onPointerLeave={() => { over.current = false; arm(); }}
         onClick={(e) => { if (active && !(e.target as Element).closest("button")) done.current(); }}>
      {children}
    </div>
  );
}

// the viewer's own pointer handling (zoom on click) stays off a box over it
export const keepPointer = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
};

// the activity line's progress bar
export function ActivityBar({ what, done, total }: { what: string; done: number; total: number }) {
  return (
    <div className="activity" {...keepPointer}>
      <span>{total ? t("library.activity.progress", { what, done: done.toLocaleString(), total: total.toLocaleString() }) : t("library.activity.reading")}</span>
      <div className="bar"><div style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
    </div>
  );
}

// a background export or merge (background.ts): its progress and Stop, then
// what it did
export function JobActivity({ job }: { job: Job }) {
  const action = job.action;
  if (job.summary !== null) {
    return (
      <Notice className="activity waiting" stamp={job.summary} onDone={() => dismissJob(job.id)}>
        <span className={job.failed ? "failed" : ""}>{job.summary}</span>
        {action && <button onClick={() => { dismissJob(job.id); action.run(); }}>{action.label}</button>}
        <button onClick={() => dismissJob(job.id)}>{t("library.activity.ok")}</button>
      </Notice>
    );
  }
  return (
    <div className="activity waiting" {...keepPointer}>
        {job.stage ? (
          // a merge's own stage, with a bar when it has steps to count
          job.total > 1 ? (
            <div className="progress">
              <span>{job.what}: {job.stage}</span>
              <div className="bar"><div style={{ width: `${(100 * job.done) / job.total}%` }} /></div>
            </div>
          ) : <span>{job.what}: {job.stage}…</span>
        ) : job.total ? (
          <div className="progress">
            <span>{t("library.activity.jobProgress", { what: job.what, done: job.done.toLocaleString(), total: job.total.toLocaleString() })}</span>
            <div className="bar"><div style={{ width: `${(100 * job.done) / job.total}%` }} /></div>
          </div>
        ) : <span>{job.what}…</span>}
        {job.cancel && (
          <button disabled={job.stopping} onClick={() => stopJob(job)}>{job.stopping ? t("library.activity.stopping") : t("library.activity.stop")}</button>
        )}
    </div>
  );
}
