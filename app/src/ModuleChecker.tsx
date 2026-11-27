// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { createContext, useContext, useEffect, useId, useRef, useState, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { commands, type CheckerReply } from "./commands";
import { formatNumber, t } from "./i18n";
import type { AdvancedState } from "./session";

export const CheckerViewer = createContext<{
  host: HTMLDivElement | null;
  active: string | null;
  setActive: Dispatch<SetStateAction<string | null>>;
  photo: { path: string; imgid: number | null } | null;
}>({ host: null, active: null, setActive: () => {}, photo: null });

const coordinates = Array.from({ length: 8 }, (_, index) => `checker_box[${index}]`);
export const checkerBoxPaths = ["checker_box_set", ...coordinates];
const defaultBox = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.1, 0.9];
const charts = [
  "darktable.xrite.colorchecker.24.pre.2014.c193366ab9",
  "darktable.xrite.calibrite.colorchecker.24.post.2014.267d8e87cc",
  "darktable.datacolor.spydercheckr.24.ff9dbf6c56",
  "darktable.datacolor.spydercheckr.48.7ac62cd347",
  "darktable.datacolor.spydercheckr.photo.3451bc07c1",
];
const optimizations = [
  "darktable.none.140bedbf9c",
  "darktable.neutral.colors.bf9d23f093",
  "darktable.saturated.colors.7b93e7e283",
  "darktable.skin.and.soil.colors.c918b491c8",
  "darktable.foliage.colors.0be50684bf",
  "darktable.sky.and.water.colors.0f405f4597",
  "darktable.average.delta.e.22cca2a9bf",
  "darktable.maximum.delta.e.d68cc15d6e",
];

const clamp = (v: number) => Math.min(1, Math.max(0, v));
const display = (value: number) => formatNumber(value, { maximumFractionDigits: 2 });

// Project from the ideal chart rectangle to the four viewer corners.
function patchPolygons(box: number[], layout: CheckerReply | null, scale: number) {
  if (!layout?.centers || !layout.radius || !layout.ratio) return [];
  const [ax, ay, bx, by, cx, cy, dx, dy] = box;
  const ux = bx - cx, uy = by - cy, vx = dx - cx, vy = dy - cy;
  const ex = ax - bx + cx - dx, ey = ay - by + cy - dy;
  const det = ux * vy - uy * vx;
  if (Math.abs(det) < 1e-9) return [];
  const g = (ex * vy - ey * vx) / det, h = (ux * ey - uy * ex) / det;
  const project = (x: number, y: number) => {
    const w = 1 + g * x + h * y;
    return `${(ax + ((1 + g) * bx - ax) * x + ((1 + h) * dx - ax) * y) / w},${(ay + ((1 + g) * by - ay) * x + ((1 + h) * dy - ay) * y) / w}`;
  };
  const rx = layout.radius * scale, ry = rx / layout.ratio;
  const { centers } = layout;
  return Array.from({ length: centers.length / 2 }, (_, i) => {
    const x = centers[i * 2], y = centers[i * 2 + 1];
    return [project(x - rx, y - ry), project(x + rx, y - ry), project(x + rx, y + ry), project(x - rx, y + ry)].join(" ");
  });
}

function CheckerOverlay({ host, box, layout, scale, change }: {
  host: HTMLDivElement; box: number[]; layout: CheckerReply | null; scale: number;
  change: (box: number[]) => void;
}) {
  const move = (index: number, x: number, y: number) => {
    const next = [...box];
    next[index] = clamp(x);
    next[index + 1] = clamp(y);
    change(next);
  };
  const drag = (index: number, event: PointerEvent<HTMLButtonElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const rect = host.getBoundingClientRect();
    if (rect.width && rect.height) move(index, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
  };
  const outline = [0, 2, 4, 6].map(index => `${box[index]},${box[index + 1]}`).join(" ");
  return createPortal(<>
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={outline} />
      {patchPolygons(box, layout, scale).map((points, index) => <polygon key={index} points={points} />)}
    </svg>
    {[0, 2, 4, 6].map(index => (
      <button type="button" key={index} className="checker-corner"
              aria-label={t("fields.checker.corner", { number: formatNumber(index / 2 + 1) })}
              style={{ left: `${box[index] * 100}%`, top: `${box[index + 1] * 100}%` }}
              onPointerDown={e => {
                if (e.button !== 0) return;
                e.stopPropagation();
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={e => drag(index, e)}
              onPointerUp={e => { e.stopPropagation(); drag(index, e); }}
              onKeyDown={e => {
                const vectors: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
                };
                const vector = vectors[e.code];
                if (!vector) return;
                e.preventDefault();
                e.stopPropagation();
                const step = e.shiftKey ? 0.01 : 0.002;
                move(index, box[index] + vector[0] * step, box[index + 1] + vector[1] * step);
              }} />
    ))}
  </>, host);
}

export function ModuleChecker(props: {
  priority: number; state: AdvancedState; settle: () => Promise<void>;
  onFields: (fields: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const viewer = useContext(CheckerViewer);
  return viewer.photo && <CheckerCard key={JSON.stringify(viewer.photo)} {...props} />;
}

function CheckerCard({ priority, state, settle, onFields }: Parameters<typeof ModuleChecker>[0]) {
  const { host, active, setActive, photo } = useContext(CheckerViewer);
  const id = useId();
  const open = active === id;
  const [chart, setChart] = useState(0);
  const [optimization, setOptimization] = useState(0);
  const [scale, setScale] = useState(0.5);
  const [draft, setDraft] = useState<number[] | null>(null);
  const box = draft ?? (state.params.checker_box_set ? coordinates.map(path => state.params[path]) : defaultBox);
  const [layout, setLayout] = useState<{ chart: number; data: CheckerReply } | null>(null);
  const [result, setResult] = useState<{ reply: CheckerReply; signature: string } | null>(null);
  const [profile, setProfile] = useState<{ fields: Record<string, number>; signature: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      setActive(now => now === id ? null : now);
    };
  }, [id, setActive]);
  useEffect(() => {
    if (!open || layout?.chart === chart) return;
    let canceled = false;
    void settle().then(() => commands.checkerAnalyze(chart, priority, 0, 0.5, null, false, null)).then(
      data => { if (!canceled) setLayout({ chart, data }); },
      () => { if (!canceled) setFailed(true); },
    );
    return () => { canceled = true; };
  }, [open, chart, priority, layout]);

  const signature = JSON.stringify([open, !!host, chart, optimization, scale, box,
    Object.entries(state.params).filter(([path]) => !checkerBoxPaths.includes(path)), state.enabled]);
  const current = useRef(signature);
  current.current = signature;
  const reply = result?.signature === signature ? result.reply : null;
  const report = reply?.report;
  const candidate = profile?.signature === signature ? profile.fields : null;
  const savedBox: Record<string, number> = { checker_box_set: 1, ...Object.fromEntries(coordinates.map((path, index) => [path, box[index]])) };
  const ready = !!host && state.enabled && layout?.chart === chart && scale > 0;

  const measure = async (validate: boolean) => {
    setFailed(false);
    setBusy(true);
    setResult(null);
    if (!validate) setProfile(null);
    try {
      await settle();
      if (!live.current || current.current !== signature) return;
      const reply = await commands.checkerAnalyze(chart, priority, optimization, scale, box, validate, photo?.imgid ?? null);
      if (!live.current || current.current !== signature) return;
      setResult({ reply, signature });
      if (reply.fields) setProfile({ fields: reply.fields, signature });
      if (!state.params.checker_box_set || coordinates.some(path => Math.abs(state.params[path] - savedBox[path]) > 1e-6))
        onFields(savedBox, false, "checker-box");
    } catch {
      if (live.current && current.current === signature) setFailed(true);
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const quality = report && (report[0] <= 1.2 ? "darktable.very.good.624d026dc1"
    : report[0] <= 2.3 ? "darktable.good.770e607624"
    : report[0] <= 3.4 ? "darktable.passable.da6773e57b" : "darktable.bad.2f05d4b689");
  return <section className="module-checker">
    <button type="button" className="btn" aria-expanded={open} data-control-id="adv:checker"
            onClick={() => { if (open) setDraft(null); setFailed(false); setActive(open ? null : id); }}>
      {t("darktable.calibrate.with.a.color.checker.cef6b086e1")}
    </button>
    {open && <>
      <label>{t("darktable.chart.cc57fc1903")}
        <select value={chart} disabled={busy} onChange={e => { setFailed(false); setChart(Number(e.target.value)); }}>
          {charts.map((key, index) => <option key={key} value={index}>{t(key)}</option>)}
        </select>
      </label>
      <label>{t("darktable.optimize.for.50b23c809a")}
        <select value={optimization} disabled={busy} onChange={e => setOptimization(Number(e.target.value))}>
          {optimizations.map((key, index) => <option key={key} value={index}>{t(key)}</option>)}
        </select>
      </label>
      <label>{t("darktable.patch.scale.244bde4e29")} <output>{display(scale)}</output>
        <input type="range" min={0} max={1} step={0.001} value={scale} disabled={busy}
               onChange={e => setScale(e.target.valueAsNumber)} />
      </label>
      <div className="checker-actions">
        <button type="button" className="btn" data-control-id="adv:checker-recompute" disabled={!ready || busy}
                onClick={() => void measure(false)}>{t("darktable.recompute.823116272f")}</button>
        <button type="button" className="btn" data-control-id="adv:checker-validate" disabled={!ready || busy}
                onClick={() => void measure(true)}>{t("darktable.validate.133c8eb86c")}</button>
        <button type="button" className="btn" data-control-id="adv:checker-accept" disabled={!ready || busy || !candidate} onClick={() => {
          if (!candidate) return;
          onFields({ ...savedBox, ...candidate }, false, "checker-profile");
          setDraft(null);
          setProfile(null);
          setResult(null);
        }}>{t("darktable.accept.c125d0397b")}</button>
      </div>
      <div className="checker-report" role="status">
        {busy && t("fields.checker.measuring")}
        {failed && t("fields.checker.failed")}
        {report && quality && <>
          <strong>{t("fields.checker.quality", { quality: t(quality) })}</strong>
          <div>{t("fields.checker.output", { average: display(report[0]), maximum: display(report[1]) })}</div>
          {reply?.fields && <>
            <div>{t("fields.checker.input", { average: display(report[2]), maximum: display(report[3]) })}</div>
            <div>{t("fields.checker.wb", { average: display(report[4]), maximum: display(report[5]) })}</div>
            <div>{t("fields.checker.temperature", { temperature: formatNumber(Math.round(report[8])) })}</div>
            <table className="checker-matrix">
              <caption>{t("fields.checker.matrix")}</caption>
              <tbody>{["red", "green", "blue"].map(channel => <tr key={channel}>
                {[0, 1, 2].map(col => <td key={col}>
                  {formatNumber(reply.fields![`${channel}[${col}]`], { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                </td>)}
              </tr>)}</tbody>
            </table>
          </>}
          <div>{t("fields.checker.normalization", { exposure: display(report[6]), black: formatNumber(report[7], { maximumFractionDigits: 4 }) })}</div>
        </>}
      </div>
      {host && state.enabled && <CheckerOverlay host={host} box={box} scale={scale}
        layout={layout?.chart === chart ? layout.data : null}
        change={points => { if (!busy) { setDraft(points); setFailed(false); } }} />}
    </>}
  </section>;
}
