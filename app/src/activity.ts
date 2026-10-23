// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// work the screen is waiting on (a render, an AI mask, opening a photo),
// for the viewer's busy indicator. a job counts as waiting from when it
// began or last showed something; the indicator comes up only once one has
// waited a moment, so quick renders and the steady frames of a slider drag
// never flash it
import { useEffect, useState } from "react";

type Job = { since: number; shown: boolean };
const jobs = new Set<Job>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function begin(): Job {
  const j = { since: performance.now(), shown: false };
  jobs.add(j);
  emit();
  return j;
}

// the job put something on screen: its wait starts again
export function progress(j: Job) {
  j.since = performance.now();
  j.shown = true;
  emit();
}

export function end(j: Job) {
  if (jobs.delete(j)) emit();
}

export async function track<T>(p: Promise<T>): Promise<T> {
  const j = begin();
  try {
    return await p;
  } finally {
    end(j);
  }
}

// ms until the indicator is due, <= 0 once it is: a job waits `delay` for
// its first frame and `steady` for each after it. a drag's frames on Linux
// at 2x took about 465 ms, so the spinner came up between them, and there
// its animation redraws the whole window every display frame
export function dueIn(waiting: Iterable<Job>, now: number, delay: number, steady: number): number {
  let due = Infinity;
  for (const j of waiting) due = Math.min(due, j.since + (j.shown ? steady : delay) - now);
  return due;
}

// on while any job has waited its time (dueIn); once on, it stays a little
// after, so frames that each take a while do not make it blink
export function useWorking(delay = 250, linger = 300, steady = 1000): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let timer = 0, shown = false, offAt = 0;
    const check = () => {
      window.clearTimeout(timer);
      const now = performance.now();
      const due = dueIn(jobs, now, delay, steady);
      if (due <= 0) {
        shown = true;
        offAt = now + linger;
        setOn(true);
        return;
      }
      if (shown && now < offAt) { timer = window.setTimeout(check, Math.min(due, offAt - now)); return; }
      shown = false;
      setOn(false);
      if (Number.isFinite(due)) timer = window.setTimeout(check, due);
    };
    listeners.add(check);
    check();
    return () => { listeners.delete(check); window.clearTimeout(timer); };
  }, [delay, linger, steady]);
  return on;
}
