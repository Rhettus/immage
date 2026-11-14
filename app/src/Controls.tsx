// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { AGX_USER_FIRST, type Control, type CurveChannel, DELETE_PRESET, LOAD_PRESET, type ModuleChoice, mapOf, moduleName, parametricOf, pointsOf, preferredChoice, profileLabel } from "./manifest";
import { type CurveMark, CurveMarkView } from "./PointCurve";
import { DELETE_AGX_PRESET_EVENT, LOAD_AGX_PRESET_EVENT, useAgxProfiles, userProfiles } from "./agxProfiles";
import { type Histogram, histogramPath } from "./histogram";
import { ModuleSwitch } from "./ModuleSwitch";
import { type Preset } from "./Presets";
import { type Probe, invert, lightness, polyline } from "./probe";
import { channelCurve, curve, monotone, curve as paramCurve } from "./tonecurve";
import { end, track } from "./activity";
import { keys } from "./keys";
import { loadSliderScroll, loadSliderScrollStep } from "./Preferences";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { perf } from "./perf";

// what ⌥-dragging a slider shows over the photo
export type OptionPreview = { kind: "mask"; op: string } | { kind: "gray" };

export type ControlProps = {
  control: Control; value: number; neutral: number; disabled: boolean; onChange: (v: number) => void;
  values: Record<string, number>;
  rawOnly?: boolean;   // disabled for needing a raw
  onOption?: (on: boolean) => void;   // ⌥ held while dragging, or let go
  glow?: number;   // how much the photo under the pointer belongs to this control's color band, 0-1
  // the module choice this row carries the switch for (ModuleSwitch), its module and the pick
  moduleChoice?: ModuleChoice; moduleValue?: number; onModule?: (value: number) => void;
  moduleAdjusted?: number[];   // the tool's modules that hold edits
  moduleScope?: "global" | "masks";
};

// about one mouse notch of a wheel event's deltaY on macOS
export const WHEEL_NOTCH = 40;

export function Slider({ values, onChange, onOption, onModule, ...props }: ControlProps) {
  const callbacks = useRef({ onChange, onOption, onModule });
  useLayoutEffect(() => { callbacks.current = { onChange, onOption, onModule }; });
  const module = useCallback((value: number) => callbacks.current.onModule?.(value), []);
  const change = useCallback((value: number) => callbacks.current.onChange(value), []);
  const option = useCallback((on: boolean) => callbacks.current.onOption?.(on), []);
  const track = typeof props.control.track === "function" ? props.control.track(values) : props.control.track;
  return <SliderWidget {...props} track={track} onChange={change} onOption={onOption ? option : undefined}
                       onModule={onModule ? module : undefined} />;
}

export const SliderWidget = memo(function SliderWidget({ control: c, value, neutral, disabled, onChange, track, glow = 0, rawOnly, onOption, moduleChoice, moduleValue, moduleAdjusted, moduleScope = "global", onModule }:
  Omit<ControlProps, "values"> & { track?: string }) {
  perf.count("react.sliderRenderAttempts");
  const s = c.slider;
  const reset = () => !disabled && send(neutral);
  const m = mapOf.get(c.id);
  const [editing, setEditing] = useState(false);
  const cancel = useRef(false);
  // the wheel over a slider moves it, a notch by Preferences' scroll amount
  // of its range; trackpads send small steps, which add up first. a notch
  // is about 40 on macOS but 100 on Windows, so one event is capped at a
  // notch. React's own wheel handler is passive and could not keep the
  // panel from scrolling
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ value, onChange, disabled });
  live.current = { value, onChange, disabled };
  // React publication can wait until the next display frame. Relative input
  // (wheel steps and Shift anchors) must still see every preceding input.
  const send = (next: number) => { live.current.value = next; onChange(next); };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let acc = 0;
    const onWheel = (e: WheelEvent) => {
      const { value: v, onChange: change, disabled: off } = live.current;
      // left to scroll the panel unless Preferences lets the wheel move sliders
      if (off || !loadSliderScroll()) return;
      e.preventDefault();
      acc += Math.max(-WHEEL_NOTCH, Math.min(WHEEL_NOTCH, e.deltaY));
      const notches = Math.trunc(acc / WHEEL_NOTCH);
      if (!notches) return;
      acc -= notches * WHEEL_NOTCH;
      const lo = s ? s.min : c.min, hi = s ? s.max : c.max, step = s ? s.step : c.step;
      const by = Math.max(step, (hi - lo) * loadSliderScrollStep());
      const pos = Math.min(hi, Math.max(lo, (s ? s.toPos(v) : v) - notches * by));
      const snapped = Math.round(pos / step) * step;
      const next = s ? s.fromPos(snapped) : snapped;
      live.current.value = next;
      change(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [c, s]);
  // ⌥ (Alt) held during a drag shows what the slider affects, as in
  // Lightroom; pressing or letting go of it mid-drag counts too
  const optionRef = useRef(onOption);
  optionRef.current = onOption;
  // ⇧ held during a drag moves the slider a tenth as far, from where it
  // was when ⇧ went down; a click on the track with it does not jump.
  // once ⇧ has been used the rest of the drag stays relative, at full
  // speed after it is let go, so the slider does not leap to the pointer.
  // `at` is the track position of the first move after each change
  const fine = useRef<{ from: number; at: number | null; scale: number } | null>(null);
  const startFine = (e: React.PointerEvent) => {
    const anchor = (shift: boolean) => {
      const v = live.current.value;
      fine.current = { from: s ? s.toPos(v) : v, at: null, scale: shift ? 0.1 : 1 };
    };
    fine.current = null;
    if (e.shiftKey) anchor(true);
    const onKey = (k: KeyboardEvent) => {
      if (k.key === "Shift" && !k.repeat) anchor(k.type === "keydown");
    };
    const end = () => {
      fine.current = null;
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };
  const startDrag = (e: React.PointerEvent) => {
    startFine(e);
    if (!optionRef.current) return;
    let shown = false;
    const show = (on: boolean) => {
      if (on !== shown) { shown = on; optionRef.current?.(on); }
    };
    const onKey = (k: KeyboardEvent) => { if (k.key === "Alt") show(k.type === "keydown"); };
    const end = () => {
      show(false);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    show(e.altKey);
  };
  // a plain track shares its label's row; a colored one keeps the full
  // width under it, as does a label too long for the row or a wide one
  const compact = !track && !c.wide && c.label.length <= 11;
  return (
    <div ref={box} data-control-id={c.id} className={`slider${compact ? " compact" : ""}${disabled ? " disabled" : ""}`
                              + `${glow > 0.1 ? " probed" : ""}${value === neutral ? " at-neutral" : ""}`}
         style={glow > 0.1 ? { ["--glow" as string]: glow } : undefined}
         title={rawOnly ? "needs a raw photo: darktable makes the detail mask from the raw"
                : c.note ? keys(c.note) : m ? `darktable: ${moduleName(m.op)}` : ""}>
      {/* double-click resets, as in Lightroom */}
      {moduleChoice && onModule ? (
        <span className="label-line">
          <label onDoubleClick={reset}>{c.label}</label>
          <ModuleSwitch choice={moduleChoice} value={moduleValue ?? preferredChoice(moduleChoice)} scope={moduleScope} adjusted={moduleAdjusted}
                        disabled={disabled} onPick={onModule} />
        </span>
      ) : <label onDoubleClick={reset}>{c.label}</label>}
      {editing ? (
        <input className="value-edit" autoFocus defaultValue={String(+value.toFixed(4))}
               onFocus={(e) => e.target.select()}
               onKeyDown={(e) => {
                 e.stopPropagation();
                 if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                 if (e.key === "Escape") { cancel.current = true; (e.target as HTMLInputElement).blur(); }
               }}
               onBlur={(e) => {
                 const typed = parseFloat(e.target.value.replace(/[^0-9.+-]/g, ""));
                 if (!cancel.current && Number.isFinite(typed)) {
                   const v = Math.min(c.max, Math.max(c.min, Math.round(typed / c.step) * c.step));
                   send(v);
                 }
                 cancel.current = false;
                 setEditing(false);
               }} />
      ) : (
        // double-click the number to type one
        <span className="value" title="double-click to type a value"
              onDoubleClick={() => { if (!disabled) setEditing(true); }}>{c.format(value)}</span>
      )}
      <input type="range" disabled={disabled} onDoubleClick={reset} onPointerDown={startDrag}
             style={track ? { ["--track" as string]: track } : undefined}
             className={track ? "custom-track" : ""}
             min={s ? s.min : c.min} max={s ? s.max : c.max} step={s ? s.step : c.step}
             // a mapped track's position on its own step: WebKit's range ignores
             // End from a position just off one (Temp's 0.99999...)
             value={s ? Math.round(s.toPos(value) / s.step) * s.step : value}
             onChange={(e) => {
               let n = Number(e.target.value);
               const f = fine.current;
               if (f) {
                 if (f.at === null) f.at = n;
                 const lo = s ? s.min : c.min, hi = s ? s.max : c.max, step = s ? s.step : c.step;
                 n = Math.min(hi, Math.max(lo, Math.round((f.from + (n - f.at) * f.scale) / step) * step));
               }
               send(s ? s.fromPos(n) : n);
             }} />
    </div>
  );
});

// a few named values as a segmented control (Color | Black & White)
export function Choice({ control: c, value, disabled, onChange }: ControlProps) {
  useAgxProfiles();
  if (c.menu) return (
    <div className="choice-row" data-control-id={c.id}>
      <span title={c.note}>{c.label}</span>
      <select title={c.note} className="field" value={value} disabled={disabled} onChange={(e) => {
        const v = Number(e.target.value);
        if (c.loadPreset && (v === LOAD_PRESET || v === DELETE_PRESET)) {
          e.target.value = String(value);
          window.dispatchEvent(new Event(v === DELETE_PRESET ? DELETE_AGX_PRESET_EVENT : LOAD_AGX_PRESET_EVENT));
        } else onChange(v);
      }}>
        {c.optionGroups
          ? c.optionGroups.map(([group, opts]) => (
            <optgroup key={group} label={group}>
              {opts.map(([label, v]) => <option key={v} value={v}>{label}</option>)}
            </optgroup>))
          : (c.options ?? []).map(([label, v]) => <option key={v} value={v}>{label}</option>)}
        {c.loadPreset && <>
          {!c.options?.some(([, v]) => v === value) && value >= AGX_USER_FIRST
            && <option hidden value={value}>{profileLabel(value)}</option>}
          <optgroup label="">
            <option value={LOAD_PRESET}>Load AgX Preset</option>
            <option value={DELETE_PRESET} disabled={!userProfiles().length}>Delete AgX Preset</option>
          </optgroup>
        </>}
      </select>
    </div>
  );
  const options = (
    <div data-control-id={c.id} className={`${c.inline ? "pills" : "segmented"} choice${disabled ? " disabled" : ""}`}>
      {(c.options ?? []).map(([label, v]) => {
        const Icon = c.optionIcons?.[v];
        return (
          <button key={label} className={value === v ? "active" : ""} disabled={disabled}
                  title={c.optionLabels?.[v] ? label : undefined} onClick={() => onChange(v)}>
            {Icon && <Icon size={15} strokeWidth={1.8} />}{c.optionLabels?.[v] ?? label}
          </button>
        );
      })}
    </div>
  );
  return c.inline ? <div className="choice-row"><span>{c.label}</span>{options}</div> : options;
}

export function Toggle({ control: c, value, disabled, onChange }: ControlProps) {
  const m = mapOf.get(c.id);
  return (
    <label data-control-id={c.id} className={`toggle${disabled ? " disabled" : ""}`}
           title={c.note ?? (m ? `darktable: ${moduleName(m.op)}` : "")}>
      <span>{c.label}</span>
      <input type="checkbox" className="switch" checked={value === 1} disabled={disabled}
             onChange={(e) => onChange(e.target.checked ? 1 : 0)} />
    </label>
  );
}

// the parametric curve as it will be written, over the region bands
export function CurveGraph({ values: v, histogram, mark }: {
  values: Record<string, number>; histogram: Histogram | null; mark: CurveMark | null;
}) {
  const W = 260, H = 260;
  const hist = histogramPath(histogram, W, H);
  const pts = curve(parametricOf(v));
  const d = pts.map(([x, y], k) => `${k ? "L" : "M"}${(x * W).toFixed(1)},${((1 - y) * H).toFixed(1)}`).join(" ");
  const splits = [v.tc_split1 ?? 25, v.tc_split2 ?? 50, v.tc_split3 ?? 75];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {hist && <path d={hist} className="hist" />}
      {[0.25, 0.5, 0.75].map((g) => (
        <g key={g}>
          <line x1={g * W} y1={0} x2={g * W} y2={H} className="grid" />
          <line x1={0} y1={g * H} x2={W} y2={g * H} className="grid" />
        </g>
      ))}
      {splits.map((s, i) => <line key={i} x1={(s / 100) * W} y1={0} x2={(s / 100) * W} y2={H} className="split" />)}
      <line x1={0} y1={H} x2={W} y2={0} className="identity" />
      <path d={d} className="line" />
      {mark && <CurveMarkView mark={mark} W={W} H={H} />}
    </svg>
  );
}

// the photo under the pointer on the curve: the input that, through the
// curve shown, gives the tone on screen. the display pixel is after the
// curve, so the curve is run backwards; modules after it (vignette, grain)
// shift the answer a little
export function markOnCurve(probe: Probe, v: Record<string, number>, pointMode: boolean, channel: CurveChannel): CurveMark {
  const ch = pointMode && channel !== "rgb" ? ({ r: 0, g: 1, b: 2 } as const)[channel] : null;
  const f = !pointMode ? polyline(paramCurve(parametricOf(v)))
    : ch === null ? monotone(pointsOf(v)) : channelCurve(pointsOf(v, channel));
  const x = invert(f, ch === null ? lightness(probe.rgb) : probe.rgb[ch] / 255);
  return { x, y: Math.min(1, Math.max(0, f(x))) };
}
