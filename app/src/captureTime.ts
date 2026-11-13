// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

export type { CaptureTimeEntry, CaptureTimeUpdate } from "./commands";

// camera clocks are wall times; UTC arithmetic avoids the computer's DST rules
export function captureMillis(value: string): number {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!m || +m[1] < 1) return NaN;
  const d = new Date(0);
  d.setUTCFullYear(+m[1], +m[2] - 1, +m[3]);
  d.setUTCHours(+m[4], +m[5], +m[6], +(m[7] ?? "").padEnd(3, "0"));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]
      || d.getUTCHours() !== +m[4] || d.getUTCMinutes() !== +m[5] || d.getUTCSeconds() !== +m[6]) return NaN;
  return d.getTime();
}

export function captureStamp(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(ms) || d.getUTCFullYear() < 1 || d.getUTCFullYear() > 9999) throw new Error("Capture time must be between years 0001 and 9999.");
  return d.toISOString().replace(/^(\d{4})-(\d{2})-(\d{2})T/, "$1:$2:$3 ").replace(/Z$/, "");
}

export function captureShift(ms: number): string {
  let n = Math.abs(ms);
  const parts: string[] = [];
  for (const [unit, size] of [["day", 86400000], ["hour", 3600000], ["minute", 60000]] as const) {
    const count = Math.floor(n / size);
    if (count) parts.push(`${count} ${unit}${count === 1 ? "" : "s"}`);
    n %= size;
  }
  if (n || !parts.length) parts.push(`${n / 1000} second${n === 1000 ? "" : "s"}`);
  return `${ms < 0 ? "backward" : "forward"} by ${parts.join(", ")}`;
}
