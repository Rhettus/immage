// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useState } from "react";
import { commands } from "./commands";
import { formatNumber, t } from "./i18n";
import { PrefRow } from "./PrefsUI";
import "./morfPhotoMetrics.css";

type State = "idle" | "indexing" | "warming" | "paused" | "disabled" | "starting" | "retrying" | "error";
type Metrics = {
  state?: State;
  progress?: { files_seen?: number; files_total?: number };
  last_run?: { files_seen?: number; errors_count?: number };
  thumbnails?: { state?: State; workers?: number; checked?: number; generated?: number; cached?: number };
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
  const [expanded, setExpanded] = useState(false);
  return <details className="pref-card nas-metrics" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t("morfphoto.metrics.title")}</summary>
    {expanded && <MetricsRows />}
  </details>;
}

function MetricsRows() {
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

  if (metrics === undefined && !unavailable) {
    return <PrefRow label={t("morfphoto.metrics.loading")} children={null} />;
  }
  const { progress, last_run: lastRun, thumbnails, clip } = metrics ?? {};
  return <>
    {unavailable || !metrics
      ? <PrefRow label={t("morfphoto.metrics.unavailable")} children={null} />
      : <>
        <MetricGroup title={t("morfphoto.metrics.scan")} rows={[
          [t("morfphoto.metrics.status"), state(metrics?.state)],
          [t("morfphoto.metrics.scanned"), number(progress?.files_seen ?? lastRun?.files_seen)],
          [t("morfphoto.metrics.total"), number(progress?.files_total ?? lastRun?.files_seen)],
          [t("morfphoto.metrics.errors"), number(lastRun?.errors_count)],
        ]} />
        <MetricGroup title={t("morfphoto.metrics.thumbnails")} rows={[
          [t("morfphoto.metrics.status"), state(thumbnails?.state)],
          [t("morfphoto.metrics.cached"), number(thumbnails?.cached)],
          [t("morfphoto.metrics.generated"), number(thumbnails?.generated)],
          [t("morfphoto.metrics.checked"), number(thumbnails?.checked)],
          [t("morfphoto.metrics.workers"), number(thumbnails?.workers)],
        ]} />
        <MetricGroup title={t("morfphoto.metrics.clip")} rows={[
          [t("morfphoto.metrics.status"), state(clip?.state)],
          [t("morfphoto.metrics.analysed"), number(clip?.indexed)],
          [t("morfphoto.metrics.eligible"), number(clip?.eligible)],
          [t("morfphoto.metrics.failed"), number(clip?.failed)],
        ]} />
      </>}
  </>;
}

function MetricGroup({ title, rows }: { title: string; rows: [string, string][] }) {
  return <div className="nas-metric-group"><PrefRow label={title} summary={
    <span className="nas-metric-list">
      {rows.map(([label, value]) => <span className="nas-metric" key={label}>
        <span>{label}</span><strong>{value}</strong>
      </span>)}
    </span>
  } children={null} /></div>;
}
