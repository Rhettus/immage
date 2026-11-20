// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { commands } from "./bindings";
import { formatNumber, t } from "./i18n";
import { PrefCard, PrefRow } from "./PrefsUI";

type State = "idle" | "indexing" | "warming" | "paused" | "disabled" | "starting" | "retrying" | "error";
type Metrics = {
  state?: State;
  progress?: { files_seen?: number; files_total?: number };
  last_run?: { files_seen?: number; errors_count?: number };
  thumbnails?: { state?: State; workers?: number; checked?: number; generated?: number };
  clip?: { state?: State; eligible?: number; indexed?: number; failed?: number };
};

const states = {
  idle: "morfphoto.metrics.idle",
  indexing: "morfphoto.metrics.indexing",
  warming: "morfphoto.metrics.warming",
  paused: "morfphoto.metrics.paused",
  disabled: "morfphoto.metrics.disabled",
  starting: "morfphoto.metrics.starting",
  retrying: "morfphoto.metrics.retrying",
  error: "morfphoto.metrics.error",
} as const;

const number = (value?: number) => typeof value === "number" ? formatNumber(value) : "—";
const state = (value?: State) => value && Object.hasOwn(states, value)
  ? t(states[value]) : t("morfphoto.metrics.unavailable");

export function MorfPhotoMetrics() {
  const [metrics, setMetrics] = useState<Metrics | null>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await commands.morfPhotoMetrics();
        if (!disposed) {
          setMetrics(result as Metrics | null);
          setUnavailable(false);
        }
      } catch {
        if (!disposed) setUnavailable(true);
      } finally {
        if (!disposed) timer = setTimeout(refresh, 10_000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);

  if (!metrics && !unavailable) return null;
  const { progress, last_run: lastRun, thumbnails, clip } = metrics ?? {};
  return <PrefCard title={t("morfphoto.metrics.title")}>
    {unavailable
      ? <PrefRow label={t("morfphoto.metrics.unavailable")} children={null} />
      : <>
        <PrefRow label={t("morfphoto.metrics.scan")} summary={t("morfphoto.metrics.scanCounts", {
          state: state(metrics?.state), seen: number(progress?.files_seen ?? lastRun?.files_seen),
          total: number(progress?.files_total ?? lastRun?.files_seen), errors: number(lastRun?.errors_count),
        })} children={null} />
        <PrefRow label={t("morfphoto.metrics.thumbnails")} summary={t("morfphoto.metrics.thumbnailCounts", {
          state: state(thumbnails?.state), generated: number(thumbnails?.generated),
          checked: number(thumbnails?.checked), workers: number(thumbnails?.workers),
        })} children={null} />
        <PrefRow label={t("morfphoto.metrics.clip")} summary={t("morfphoto.metrics.clipCounts", {
          state: state(clip?.state), indexed: number(clip?.indexed),
          eligible: number(clip?.eligible), failed: number(clip?.failed),
        })} children={null} />
      </>}
  </PrefCard>;
}
