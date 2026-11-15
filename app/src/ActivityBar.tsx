// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { type Job, dismissJob, stopJob } from "./background";
import { t } from "./i18n";

// the activity line's progress bar
export function ActivityBar({ what, done, total }: { what: string; done: number; total: number }) {
  return (
    <div className="activity">
      <span>{total ? t("library.activity.progress", { what, done: done.toLocaleString(), total: total.toLocaleString() }) : t("library.activity.reading")}</span>
      <div className="bar"><div style={{ width: `${total ? (100 * done) / total : 0}%` }} /></div>
    </div>
  );
}

// a background export or merge (background.ts): its progress and Stop, then
// what it did
export function JobActivity({ job }: { job: Job }) {
  // the viewer's own pointer handling (zoom on click) stays off it
  const keep = (e: React.PointerEvent) => e.stopPropagation();
  const action = job.action;
  return (
    <div className="activity waiting" onPointerDown={keep} onPointerUp={keep}>
      {job.summary === null ? <>
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
      </> : <>
        <span className={job.failed ? "failed" : ""}>{job.summary}</span>
        {action && <button onClick={() => { dismissJob(job.id); action.run(); }}>{action.label}</button>}
        <button onClick={() => dismissJob(job.id)}>{t("library.activity.ok")}</button>
      </>}
    </div>
  );
}
