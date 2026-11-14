// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { AdvancedGroup, type AdvancedEdit, type AdvancedPick } from "./AdvancedPanel";
import type { EditMode } from "./Preferences";
import { AdvancedToggle, advancedEdited, useAdvanced } from "./advanced";
import { BANDS, type Control, type ControlPreset, type CurveChannel, MODULE_CHOICES, type ModuleChoice, NEG_GREYED, type Panel, SF_GREYED, type Section, type Turn, type Values, choiceCovers, choiceOn, choiceShows, controlById, isModuleSetting, mapOf, mapsWith, parametricOf, pointValues, pointsOf, preferredChoice } from "./manifest";
import { Chevron, Collapse } from "./Collapse";
import { Choice, CurveGraph, OptionPreview, Slider, Toggle, markOnCurve } from "./Controls";
import { CircleOff, Eye, EyeOff, Grid2x2, MoveHorizontal, MoveVertical, PenLine, Sparkles, WandSparkles } from "lucide-react";
import { ContrastEqualizer } from "./ContrastEqualizer";
import { type Frame, Session } from "./session";
import { GradingWheels, type WheelMode } from "./ColorWheel";
import { type Histogram } from "./histogram";
import { LensPicker } from "./LensPicker";
import { ModuleSwitch } from "./ModuleSwitch";
import { PipetteIcon } from "./icons";
import { PointCurve } from "./PointCurve";
import { type Preset } from "./Presets";
import { SaturationCurve } from "./SaturationCurve";
import { Snapshot } from "./uiUpdates";
import { type WB, WB_PRESETS } from "./wb";
import { bandWeights, useProbe } from "./probe";
import { channelCurve, curve, isIdentity, curve as paramCurve } from "./tonecurve";
import { detailRows, isAdvancedControl } from "./DetailControls";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { panelValues, peekIds } from "./panelValues";
import { settings } from "./settings";
import type { ImageEntry } from "./library";

// a preset's values but the photo's modules: the tone mapper, which presets
// made when it was a slider may hold
export const presetValues = (p: Preset): Values =>
  Object.fromEntries(Object.entries(p.values).filter(([id]) => !isModuleSetting(id)));

// the White Balance picker and Lightroom's presets
export function WBTools({ values, asShot, picking, disabled, onPick, onAuto, onPreset }: {
  values: Record<string, number>; asShot: WB | null; picking: boolean; disabled: boolean;
  onPick: () => void; onAuto: () => void; onPreset: (wb: WB) => void;
}) {
  const near = (wb: WB) => Math.abs(wb.temp - values.temp) < 1 && Math.abs(wb.tint - values.tint) < 1;
  const current = asShot && near(asShot) ? "As Shot"
    : WB_PRESETS.find(([, wb]) => near(wb))?.[0] ?? "Custom";
  return (
    <div className="wb-tools">
      <button className={`tool${picking ? " on" : ""}`} disabled={disabled} onClick={onPick}
              title="pick a neutral spot in the image (W)"><PipetteIcon /></button>
      <span className="wb-label">WB</span>
      <select value={current} disabled={disabled}
              onChange={(e) => {
                const name = e.target.value;
                if (name === "Auto") onAuto();
                else if (name === "As Shot") { if (asShot) onPreset(asShot); }
                else { const p = WB_PRESETS.find(([n]) => n === name); if (p) onPreset(p[1]); }
              }}>
        <option>As Shot</option>
        <option>Auto</option>
        {WB_PRESETS.map(([n]) => <option key={n}>{n}</option>)}
        {current === "Custom" && <option>Custom</option>}
      </select>
    </div>
  );
}

// a picked spot's display color: a small square around it, averaged
export function sampleSpot(px: Uint8ClampedArray, width: number, height: number,
                    ix: number, iy: number): [number, number, number] | null {
  const r = Math.max(2, Math.round(width * 0.004));
  const cx = Math.round(ix * (width - 1)), cy = Math.round(iy * (height - 1));
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(height - 1, cy + r); y++)
    for (let x = Math.max(0, cx - r); x <= Math.min(width - 1, cx + r); x++) {
      const i = 4 * (y * width + x);
      // a clipped channel no longer says what color the spot is
      if (px[i] >= 250 || px[i + 1] >= 250 || px[i + 2] >= 250) continue;
      sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2];
      n++;
    }
  return n ? [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255] : null;
}

// what each Upright button does, as its tooltip
export const UPRIGHT_TITLES = [
  "no Upright correction: the Manual sliders alone",
  "a balanced correction: level, plumb, and the horizontal lines when the photo has enough of them",
  "draw two to four guides along lines that should be plumb or level",
  "level the photo: rotation only",
  "level the photo and make its vertical lines plumb",
  "level, plumb and square: the vertical and horizontal lines both",
];

// Upright's buttons as icons, in UPRIGHT_MODES' order: Level and Vertical
// by the axis they straighten, Full by both
export const UPRIGHT_ICONS = [CircleOff, WandSparkles, PenLine, MoveHorizontal, MoveVertical, Grid2x2];

export const noHistogramSubscription = () => () => {};
export const noHistogram = () => null;

export type PanelProps = {
  editMode?: EditMode;   // Advanced shows darktable modules in place of the sliders
  sessionRevision: number;
  // the module search's pick for this group, and its acknowledgement
  pick?: AdvancedPick | null; onPicked?: (nonce: number) => void;
  // the photos of the folder being browsed, for Composite's photo (Advanced mode)
  photos?: ImageEntry[];
  panel: Panel; open: boolean; onToggle: (solo: boolean) => void; values: Record<string, number>;
  session: Session | null; disabled: boolean; onChange: (c: Control, v: number) => void;
  onChangeMany: (entries: [string, number][], label?: string) => void; histograms: Snapshot<Histogram | null>;
  onAuto?: () => void;
  detailLoupe?: React.ReactNode;
  presenceLoupe?: React.ReactNode;
  wbTools?: React.ReactNode;   // the picker and presets, above Temp
  toneTools?: React.ReactNode;   // Auto, above Exposure
  denoiseTools?: React.ReactNode;   // AI Denoise's button, its section's only content
  straightenTools?: React.ReactNode;  // the Straighten tool, its section's only content
  transformTools?: React.ReactNode;   // Upright's buttons, its section's only content
  onPreview: (values: Values | null) => void;   // a swatch under the pointer
  onOptionPreview?: (preview: OptionPreview | null) => void;   // a slider ⌥-dragged
  onAdvancedEdit?: AdvancedEdit;   // records an Advanced card edit for undo
  // Simple: how many Advanced edits in this group no slider shows, and the
  // badge's link to the Editing mode preference
  advancedEdits?: number; onAdvancedEdits?: () => void;
  onTurn?: (how: Turn) => void;   // the toolbar's rotate and flip, for Advanced's orientation card
  onPeek?: (ids: string[] | null) => void;   // the eye held: these controls shown at their defaults
};

// the panel's eye: held, the photo shows the panel's controls at their
// defaults, the sliders staying where they are; let go, the edit is back
function PeekButton({ ids, disabled, onPeek }: { ids: string[]; disabled: boolean; onPeek: (ids: string[] | null) => void }) {
  const [held, setHeld] = useState(false);
  const heldRef = useRef(false);
  const set = (on: boolean) => {
    if (heldRef.current === on) return;
    heldRef.current = on;
    setHeld(on);
    onPeek(on ? ids : null);
  };
  const live = useLiveEvent(set);
  useEffect(() => () => live(false), [live]);
  useEffect(() => { if (disabled) live(false); }, [disabled, live]);
  return (
    <button type="button" className={`advanced-toggle panel-peek${held ? " on" : ""}`} data-panel-peek aria-pressed={held}
            disabled={disabled} title="hold to see the photo without this panel's adjustments"
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              e.currentTarget.setPointerCapture(e.pointerId);
              set(true);
            }}
            onPointerUp={() => set(false)} onPointerCancel={() => set(false)} onLostPointerCapture={() => set(false)}
            onKeyDown={(e) => {
              if (e.key !== " " && e.key !== "Enter") return;
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat) set(true);
            }}
            onKeyUp={(e) => {
              if (e.key !== " " && e.key !== "Enter") return;
              e.preventDefault();
              e.stopPropagation();
              set(false);
            }}
            onBlur={() => set(false)}>
      {held ? <EyeOff size={14} strokeWidth={2} /> : <Eye size={14} strokeWidth={2} />}
    </button>
  );
}

// Event bridges retain the latest committed handlers without making every panel
// and slider render just because the App created another closure.
export function useLiveEvent<A extends unknown[], R>(callback: (...args: A) => R) {
  const latest = useRef(callback);
  useLayoutEffect(() => { latest.current = callback; });
  return useCallback((...args: A) => latest.current(...args), []);
}

export function PanelView(props: PanelProps) {
  const advancedMode = props.editMode === "advanced";
  const selected = useRef<Values | undefined>(undefined);
  const values = panelValues(props.panel, props.values, selected.current);
  useLayoutEffect(() => { selected.current = values; });
  const onToggle = useLiveEvent(props.onToggle);
  const onChange = useLiveEvent(props.onChange);
  const onChangeMany = useLiveEvent(props.onChangeMany);
  const onPreview = useLiveEvent(props.onPreview);
  const auto = useLiveEvent(() => props.onAuto?.());
  const option = useLiveEvent((preview: OptionPreview | null) => props.onOptionPreview?.(preview));
  const onTurn = useLiveEvent((how: Turn) => props.onTurn?.(how));
  const onPeek = useLiveEvent((ids: string[] | null) => props.onPeek?.(ids));
  if (advancedMode) return <AdvancedGroup id={props.panel.id} title={props.panel.advancedTitle ?? props.panel.title} open={props.open} onToggle={onToggle}
                                       session={props.session} revision={props.sessionRevision} record={props.onAdvancedEdit}
                                       onSimple={onChangeMany} onTurn={onTurn} pick={props.pick} onPicked={props.onPicked} photos={props.photos} />;
  return <PanelWidget {...props} values={values} onToggle={onToggle} onChange={onChange}
    onChangeMany={onChangeMany} onPreview={onPreview} onAuto={props.onAuto ? auto : undefined}
    onOptionPreview={props.onOptionPreview ? option : undefined} onPeek={props.onPeek ? onPeek : undefined} />;
}

export const PanelWidget = memo(function PanelWidget({ panel: p, open, onToggle, values, session, disabled, onChange, onChangeMany, histograms,
                     onAuto, wbTools, toneTools, denoiseTools, straightenTools, transformTools, detailLoupe, presenceLoupe, onPreview, onOptionPreview,
                     advancedEdits = 0, onAdvancedEdits, onPeek }: PanelProps) {
  const histogram = useSyncExternalStore(p.graph === "tonecurve" ? histograms.subscribe : noHistogramSubscription, p.graph === "tonecurve" ? histograms.get : noHistogram);
  const pointMode = p.graph === "tonecurve" && values.tc_mode === 1;
  // which curve the point editor shows: the master, or one channel
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("rgb");
  const probe = useProbe(open && (p.id === "tonecurve" || p.id === "hsl" || p.id === "bw"));
  const curveMark = p.graph === "tonecurve" && probe ? markOnCurve(probe, values, pointMode, curveChannel) : null;
  // the color bands the photo under the pointer falls in; in black and
  // white, by the color it had before the treatment
  const bandSrc = probe && (p.id === "bw" ? probe.orig : p.id === "hsl" ? probe.rgb : null);
  const weights = bandSrc ? bandWeights(bandSrc) : null;
  const glowOf = (id: string) => {
    const m = weights && /^(?:bw|hsl_(?:hue|sat|lum))_(.+)$/.exec(id);
    const k = m ? BANDS.findIndex(([b]) => b === m[1]) : -1;
    return k < 0 ? 0 : weights![k];
  };
  // to points: the parametric curve sampled where Lightroom puts its own
  const toPoints = () => {
    // points made before stay; only an empty point curve starts from the
    // parametric curve's shape
    if (!isIdentity(pointsOf(values))) { onChange(controlById.get("tc_mode")!, 1); return; }
    const pc = paramCurve(parametricOf(values));
    const flat = pc.every(([x, y]) => Math.abs(x - y) < 1e-4);
    const pts: [number, number][] = flat ? [[0, 0], [1, 1]]
      : [0, 4, 8, 12, 16].map((k) => pc[k]);
    onChangeMany([["tc_mode", 1], ...Object.entries(pointValues(pts))]);
  };
  const [closed, setClosed] = useState(loadClosedSections);
  const toggleSection = (title: string) => setClosed(toggleClosedSection(`${p.id}/${title}`));
  const [advanced, toggleAdvanced] = useAdvanced(p.id);
  // Whites: Advanced is AgX's
  const shown = (c: Control) => choiceShows(c.id, values) && (c.id !== "whites_brilliance" || values.tm_mode === 1);
  const advancedIds = p.sections.flatMap((sec) => sec.controls).filter((c) => isAdvancedControl(c.id) && shown(c)).map((c) => c.id);
  const [tab, setTab] = useState(0);
  const [wheels, setWheels] = useState<WheelMode>("3way");
  const sections = p.tabs ? [p.sections[tab]] : p.sections;
  const showWheels = p.graph === "colorwheels" && wheels !== "sliders";
  // a converted negative has these modules off (NEG_OFF), a film
  // simulation its tone mappers (SF_OFF)
  const negative = (c: Control) => (values.neg_on === 1 && NEG_GREYED.has(c.id))
    || (values.sf_on === 1 && SF_GREYED.has(c.id));
  // each tool with several modules carries its switch on the first of its
  // controls shown (the equalizer and the curve stand in for theirs)
  const switchHosts = new Map<string, ModuleChoice>();
  for (const ch of MODULE_CHOICES) {
    if (ch.options.length < 2) continue;
    const covers = new Set(choiceCovers(ch));
    // Clarity and Texture keep only Medium and Fine above their Advanced fold: the switch goes on those
    const hosts = p.sections.flatMap((sec) => sec.controls).filter((c) => covers.has(c.id) && choiceShows(c.id, values));
    const first = hosts.find((c) => /_gain_(medium|fine)$/.test(c.id)) ?? hosts[0];
    if (first) switchHosts.set(/^ce_/.test(first.id) ? "ce_0_0" : /^s[cb]_/.test(first.id) ? "sc_pn" : first.id, ch);
  }
  const switchFor = (id: string) => {
    const ch = switchHosts.get(id);
    return ch && {
      choice: ch, value: values[ch.control] ?? preferredChoice(ch), disabled,
      adjusted: session?.adjustedModules(ch.control),
      onPick: (v: number) => onChange(controlById.get(ch.control)!, v),
    };
  };
  const switchProps = (id: string) => {
    const sw = switchFor(id);
    return sw ? { moduleChoice: sw.choice, moduleValue: sw.value, moduleAdjusted: sw.adjusted, onModule: sw.onPick } : {};
  };
  const withOptions = (c: Control) => c.optionsFor && session
    ? { ...c, options: c.optionsFor(session.context, values[c.id] ?? session.neutral[c.id] ?? 0) } : c;
  const controlProps = (c: Control) => ({
    control: negative(c) ? { ...c, note: values.neg_on === 1
      ? "set in Negative: a converted negative turns this module off"
      : "set in Film Simulation: a film simulation turns the tone mapper off" } : withOptions(c),
    value: values[c.id] ?? c.neutral ?? 0,
    neutral: session?.neutral[c.id] ?? c.neutral ?? 0,
    disabled: disabled || negative(c) || !mapOf.has(c.id) || (!!c.rawOnly && !session?.raw), onChange: (v: number) => onChange(c, v),
    values, glow: glowOf(c.id),
    rawOnly: !!c.rawOnly && !!session && !session.raw,
    ...switchProps(c.id),
    onOption: c.optionPreview && onOptionPreview
      ? (on: boolean) => onOptionPreview(!on ? null : c.optionPreview === "gray" ? { kind: "gray" }
                                         : { kind: "mask", op: (mapsWith(c.id).find((m) => choiceOn(m, values)) ?? mapOf.get(c.id)!).op })
      : undefined,
  });
  const foreign = p.graph === "tonecurve" && [...(session?.foreign ?? [])].some((m) => m.op === "tonecurve");
  return (
    <div className="panel adjust" data-panel-id={p.id}>
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>{p.title}</span>
        {curveMark && (
          <span className="probe-chip" title="the photo under the pointer: its color, and where it sits on the curve (0-255)">
            {`R ${Math.round(probe!.rgb[0])} G ${Math.round(probe!.rgb[1])} B ${Math.round(probe!.rgb[2])}`}
            <b>{`${Math.round(curveMark.x * 255)} → ${Math.round(curveMark.y * 255)}`}</b>
          </span>
        )}
        {probe && (p.id === "hsl" || p.id === "bw") && (
          <span className="probe-chip" title={p.id === "bw" ? "the color under the pointer before black and white, and its band"
                                                             : "the color under the pointer, and its band"}>
            {bandSrc && <i style={{ background: `rgb(${bandSrc.map(Math.round).join(",")})` }} />}
            {!bandSrc ? "…" : weights ? BANDS[weights.indexOf(Math.max(...weights))][1] : "neutral"}
          </span>
        )}
        {onPeek && (
          <PeekButton ids={peekIds(p)} onPeek={onPeek}
                      disabled={disabled || !advancedEdited(peekIds(p), values, session?.neutral ?? {})} />
        )}
        {advancedIds.length > 0 && (
          <AdvancedToggle on={advanced} onToggle={toggleAdvanced}
                          edited={advancedEdited(advancedIds, values, session?.neutral ?? {})} />
        )}
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="panel-body">
          {detailLoupe}
          {p.graph === "tonecurve" && (
            <div className="segmented tabs">
              <button className={pointMode ? "active" : ""} onClick={() => !pointMode && toPoints()}>Point</button>
              <button className={!pointMode ? "active" : ""} onClick={() => pointMode && onChange(controlById.get("tc_mode")!, 0)}>
                Parametric
              </button>
            </div>
          )}
          {p.graph === "tonecurve" && !pointMode && <CurveGraph values={values} histogram={histogram} mark={curveMark} />}
          {pointMode && (
            <div className="segmented small channels">
              {(["rgb", "r", "g", "b"] as const).map((c) => (
                <button key={c} className={`${c === curveChannel ? "active" : ""} ch-${c}`}
                        onClick={() => setCurveChannel(c)}>{c.toUpperCase()}</button>
              ))}
            </div>
          )}
          {pointMode && (
            <PointCurve key={curveChannel} points={pointsOf(values, curveChannel)} disabled={disabled}
                        histogram={histogram} mark={curveMark}
                        channel={curveChannel === "rgb" ? null : ({ r: 0, g: 1, b: 2 } as const)[curveChannel]}
                        draw={curveChannel === "rgb" ? undefined : channelCurve}
                        onChange={(pts) => onChangeMany(Object.entries(pointValues(pts, curveChannel)))} />
          )}
          {foreign && <div className="note">custom curve from darktable; moving a slider replaces it</div>}
          {p.graph === "colorwheels" && (
            <GradingWheels prefix="cg" mode={wheels} onMode={setWheels} values={values} disabled={disabled}
                           onChange={(es) => es.forEach(([id, v]) => onChange(controlById.get(id)!, v))}
                           lum={(id) => <Slider {...controlProps(controlById.get(id)!)} />} />
          )}
          {p.tabs && (
            <div className="segmented tabs">
              {p.sections.map((s, i) => (
                <button key={s.title} className={i === tab ? "active" : ""} onClick={() => setTab(i)}>
                  {s.title}
                </button>
              ))}
            </div>
          )}
          {p.presets && (
            <PresetRow presets={p.presets} disabled={disabled} onApply={onChangeMany} onPreview={onPreview}
                       before={onAuto && <button className="btn small" disabled={disabled} onClick={onAuto}>Auto</button>} />
          )}
          {!showWheels && !pointMode && sectionRuns(sections).map((run) => {
            const content = (s: Section) => (
              <>
                {s.presets && <PresetRow presets={s.presets} disabled={disabled} onApply={onChangeMany}
                                           onPreview={onPreview} />}
                {s.title === "White Balance" && wbTools}
                {s.title === "White Balance" && session?.wbInModule && (
                  <div className="note">white balance comes from the white balance module, with color calibration off; Temp and Tint turn color calibration on, which adapts it again</div>
                )}
                {s.title === "Tone" && toneTools}
                {s.title === "AI Denoise" && denoiseTools}
                {s.title === "Straighten" && straightenTools}
                {s.title === "Upright" && transformTools}
                {detailRows(s.controls.filter(shown), (c) => {
                  if (c.id.startsWith("ce_")) return c.id === "ce_0_0"
                    ? <ContrastEqualizer key="contrast-equalizer" values={values} disabled={disabled} onChange={onChangeMany}
                       module={switchFor("ce_0_0") && <ModuleSwitch {...switchFor("ce_0_0")!} scope="global" />} />
                    : null;
                  if (c.id.startsWith("sc_") || c.id.startsWith("sb_")) return c.id === "sc_pn"
                    ? <SaturationCurve key="saturation-curve" values={values} disabled={disabled} onChange={onChangeMany}
                       module={switchFor("sc_pn") && <ModuleSwitch {...switchFor("sc_pn")!} scope="global" />} />
                    : null;
                  if (c.id === "lens_pick") return <LensPicker key={c.id} value={values.lens_pick ?? 0} photo={session}
                    disabled={disabled || values.lens_profile !== 1} onChange={(v) => onChange(c, v)} />;
                  const props = controlProps(c);
                  return c.kind === "toggle" ? <Toggle key={c.id} {...props} />
                    : c.kind === "choice" ? <Choice key={c.id} {...props} />
                    : <Slider key={c.id} {...props} />;
                }, advanced)}
              </>
            );
            const s = run[0];
            // a tab is its own heading, and a control beside its label
            // (Treatment) needs none
            if (p.tabs || (s.controls.length && s.controls.every((c) => c.inline))) return <section key={s.title}>{content(s)}</section>;
            // sections sharing a group: one heading, a box for each
            const title = s.group ?? s.title;
            const body = s.group
              ? run.map((g) => (
                  <div className="subcard" key={g.title}>
                    <div className="subcard-head">
                      {g.subtitle ?? g.title}
                      {g.tag && <span className="tag"><Sparkles size={11} strokeWidth={2} />{g.tag}</span>}
                    </div>
                    {content(g)}
                  </div>
                ))
              : content(s);
            const shut = closed.has(`${p.id}/${title}`);
            return (
              <section key={title} data-section-id={title}>
                <h3 className="fold" onClick={() => toggleSection(title)}>
                  {title}
                  {!s.group && s.tag && <span className="tag"><Sparkles size={11} strokeWidth={2} />{s.tag}</span>}
                  <Chevron open={!shut} />
                </h3>
                <Collapse open={!shut}><div className="section-body">{s.title === "Presence" && presenceLoupe}{body}</div></Collapse>
              </section>
            );
          })}
          {advancedEdits > 0 && (
            <button type="button" className="advanced-edits" data-advanced-edits={advancedEdits} onClick={onAdvancedEdits}
                    title="Edits made in Advanced mode that these sliders cannot show">
              <span className="advanced-dot" /><span><b>{advancedEdits} advanced edit{advancedEdits === 1 ? "" : "s"}</b> here keep rendering. Editing mode…</span>
            </button>
          )}
        </div>
      </Collapse>
    </div>
  );
});

// buttons that set several controls at once; one with a swatch shows as a
// colored circle, its label as a tooltip
// a preset under the pointer is previewed over the image; a click applies it
export function PresetRow({ presets, disabled, onApply, onPreview, before }: {
  presets: ControlPreset[];
  disabled: boolean;
  onApply: (entries: [string, number][]) => void;
  onPreview: (values: Values | null) => void;
  before?: React.ReactNode;
}) {
  return (
    <div className="presets" onPointerLeave={() => onPreview(null)}>
      {before}
      {presets.map((pr) => {
        const props = {
          disabled,
          onPointerEnter: () => !disabled && onPreview(pr.values),
          onClick: () => { onPreview(null); onApply(Object.entries(pr.values)); },
        };
        return pr.swatch
          ? <button key={pr.label} className="swatch" title={pr.label} aria-label={pr.label}
                    style={{ background: pr.swatch }} {...props} />
          : <button key={pr.label} className="btn small" {...props}>{pr.label}</button>;
      })}
    </div>
  );
}

// consecutive sections of one group, together; any other section alone
export function sectionRuns(sections: Section[]): Section[][] {
  const runs: Section[][] = [];
  for (const s of sections) {
    const last = runs[runs.length - 1];
    if (s.group && last?.[0].group === s.group) last.push(s);
    else runs.push([s]);
  }
  return runs;
}

// the sections folded shut, "<panel id>/<section title>", kept between sessions
export const CLOSED_SECTIONS_KEY = "immage.sections.closed";
export function loadClosedSections(): Set<string> {
  try { return new Set(JSON.parse(settings.get(CLOSED_SECTIONS_KEY) ?? "[]")); } catch { return new Set(); }
}
// read again before writing: every card keeps its own copy
export function toggleClosedSection(key: string): Set<string> {
  const closed = loadClosedSections();
  if (!closed.delete(key)) closed.add(key);
  try { settings.set(CLOSED_SECTIONS_KEY, JSON.stringify([...closed])); } catch { /* not kept */ }
  return closed;
}

// a frame with no color in it: a black and white look's tile. a toned
// look (sepia, say) has some, and counts as color
export function isMono(f: Frame): boolean {
  const px = f.pixels;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4)
    sum += Math.max(Math.abs(px[i] - px[i + 1]), Math.abs(px[i + 1] - px[i + 2]), Math.abs(px[i] - px[i + 2]));
  return sum / (px.length / 4) < 2;
}
