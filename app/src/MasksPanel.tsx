// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Masks panel: a menu to create a mask, the image's masks with
// the selected one opened to its shapes, and that mask's settings and own
// adjustment sliders
import { BANDS, choiceShows, HSL_TABS, localControlById, RANGES, type Control, type Values } from "./manifest";
import { GradingWheels, type WheelMode } from "./ColorWheel";
import { isRange, maskThumb, NO_REFINE, shapeLabel, type BlendifChannel, type Mask, type ParametricRange,
         type Range, type RangeMap, type Refine, type Shape } from "./masks";
import { DROPPER, ParametricEditor, type Picked } from "./ParametricEditor";
import { useEffect, useRef, useState } from "react";
import { keys } from "./keys";
import { Chevron, Collapse } from "./Collapse";
import { bandWeights, useProbe } from "./probe";
import type { BrushSettings, MaskTool } from "./MaskOverlay";

export type ToolTarget = "new" | "add" | "subtract";
export type LandscapeKind = "sky" | "water" | "vegetation" | "mountains" | "ground" | "architecture" | "artificial_ground";
export type AiKind = "subject" | "background" | "people" | LandscapeKind;

// Lightroom's Landscape choices, all from the one scene model
const LANDSCAPE: [LandscapeKind, string][] = [
  ["sky", "Sky"], ["water", "Water"], ["vegetation", "Vegetation"], ["mountains", "Mountains"],
  ["ground", "Natural Ground"], ["architecture", "Architecture"], ["artificial_ground", "Artificial Ground"],
];

const TOOLS: [MaskTool, string, string][] = [
  ["brush", "Brush", "K"], ["gradient", "Linear Gradient", "M"], ["ellipse", "Radial Gradient", "⇧M"],
];
const AI_TOOLS: [MaskTool, string, string][] = [["object", "Select Object", "click it, or drag a box around it"]];
// a range by what it picks, but a shape to darktable: it adds and
// subtracts, and does not intersect
const DEPTH_TOOLS: [MaskTool, string, string][] = [["depth", "Depth Range", "click the image at the depth to select"]];
// Parametric is darktable's parametric mask, made at once rather than
// picked; on a mask with shapes it makes darktable's drawn & parametric
const RANGE_TOOLS: [MaskTool, string, string][] = [
  ["color", "Color Range", "⇧J"], ["luminance", "Luminance Range", "⇧Q"], ["parametric", "Parametric", ""],
];

// the adjustments in the main panel's groups and order: Basic's, then Detail
const LOCAL_GROUPS: [string, string[]][] = [
  ["White Balance", ["l_temp", "l_tint"]],
  ["Tone", ["l_exposure", "l_contrast", "l_highlights", "l_shadows", "l_whites", "l_blacks"]],
  ["Presence", ["l_texture", "l_clarity", "l_dehaze", "l_hue", "l_saturation"]],
  ["HSL", BANDS.flatMap(([b]) => [`l_hsl_hue_${b}`, `l_hsl_sat_${b}`, `l_hsl_lum_${b}`])],
  ["Color Grading", RANGES.flatMap(([r]) => [`l_cg_${r}_hue`, `l_cg_${r}_sat`, `l_cg_${r}_lum`])],
  // Sharpening as the photo's module has it (MODULE_CHOICES)
  ["Detail", ["l_sharpness", "l_usm", "l_noise", "l_defringe"]],
];
// in black and white a mask's modules run after the conversion (the
// engine's _named_instance() puts them after the mask anchor), so these
// find only gray: hue, saturation and HSL do nothing, and white balance
// only tints, which the mask's Color Grading does better
const MONO_HIDDEN = new Set(["l_temp", "l_tint", "l_hue", "l_saturation",
                             ...BANDS.flatMap(([b]) => [`l_hsl_hue_${b}`, `l_hsl_sat_${b}`, `l_hsl_lum_${b}`])]);
const MONO_GROUPS = LOCAL_GROUPS.map(([t, ids]) => [t, ids.filter((id) => !MONO_HIDDEN.has(id))] as [string, string[]])
  .filter(([, ids]) => ids.length > 0);
const OPACITY: Control = { id: "m_opacity", label: "Opacity", min: 0, max: 100, step: 1, neutral: 100,
                           format: (v) => `${Math.round(v)}%` };
// darktable's mask refinements, as sliders: [refine field, control, to the
// field's units]. its feather follows the photo's edges rather than
// softening the mask's, so it goes by Edge Aware here; the selected
// component's own Feather softens. detail needs the raw's detail mask, so
// only raws have it
const pct = (v: number) => `${Math.round(v)}`;
const REFINES: [keyof Refine, Control, number][] = [
  ["feather", { id: "m_feather", label: "Edge Aware", min: 0, max: 100, step: 1, neutral: 0, format: pct }, 2.5],
  ["blur", { id: "m_blur", label: "Blur", min: 0, max: 100, step: 1, neutral: 0, format: pct }, 1],
  ["detail", { id: "m_detail", label: "Detail", min: -100, max: 100, step: 1, neutral: 0, format: pct }, 0.01],
  ["contrast", { id: "m_contrast", label: "Contrast", min: -100, max: 100, step: 1, neutral: 0, format: pct }, 0.01],
];

const svg = (body: React.ReactNode) => (
  <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{body}</svg>
);
const AI_ICONS = {
  subject: svg(<><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
                 <circle cx="12" cy="9.5" r="2.3" fill="currentColor" /><path d="M7.8 17c.6-2.3 2.2-3.5 4.2-3.5s3.6 1.2 4.2 3.5" fill="currentColor" /></>),
  sky: svg(<><path d="M3.5 17.5h17" /><path d="M6 20.5h12" />
             <path d="M7.5 13.5a3.2 3.2 0 0 1 .7-6.3 4.4 4.4 0 0 1 8.4 1.2 2.6 2.6 0 0 1-.1 5.1z" /></>),
  people: svg(<><circle cx="9" cy="8" r="2.6" /><path d="M3.8 19c.5-3.2 2.5-5 5.2-5s4.7 1.8 5.2 5" />
                <circle cx="16.5" cy="8.8" r="2.1" /><path d="M15.6 13.2c.3 0 .6-.1.9-.1 2.2 0 3.9 1.5 4.3 4.4" /></>),
  landscape: svg(<><path d="M2.5 19.5l6-9 4 6 2.5-3.5 6.5 6.5z" /><circle cx="17" cy="6.5" r="2" /></>),
  background: svg(<><rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" fillOpacity="0.45" />
                    <circle cx="12" cy="10" r="2.6" fill="#181818" stroke="none" />
                    <path d="M7.5 18.5c.6-2.6 2.3-4 4.5-4s3.9 1.4 4.5 4z" fill="#181818" stroke="none" /></>),
};
export const TOOL_ICONS: Record<MaskTool, React.ReactNode> = {
  brush: svg(<><path d="M18.4 3.6a2 2 0 0 1 2.8 2.8L12 15.6 8.4 12z" />
               <path d="M8.4 12c-2.3 0-3.9 1.6-3.9 3.9 0 1.6-.7 2.7-2 3.6 4.4.6 8.2-.4 9.5-3.9z" /></>),
  gradient: svg(<><defs><linearGradient id="mt-lg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor="currentColor" stopOpacity="0.9" />
                  <stop offset="1" stopColor="currentColor" stopOpacity="0" /></linearGradient></defs>
                  <rect x="4" y="4" width="16" height="16" rx="2.5" fill="url(#mt-lg)" /></>),
  ellipse: svg(<><defs><radialGradient id="mt-rg">
                 <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
                 <stop offset="1" stopColor="currentColor" stopOpacity="0" /></radialGradient></defs>
                 <circle cx="12" cy="12" r="8.5" fill="url(#mt-rg)" /><circle cx="12" cy="12" r="8.5" /></>),
  color: svg(<><path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.4-2l-.4-1a1.7 1.7 0 0 1 1.6-2.3H17a4 4 0 0 0 4-4c0-4.9-4-8.7-9-8.7z" />
               <circle cx="7.5" cy="11" r="1.2" fill="currentColor" /><circle cx="10.5" cy="7" r="1.2" fill="currentColor" />
               <circle cx="15.5" cy="7.5" r="1.2" fill="currentColor" /></>),
  object: svg(<><path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
                <path d="M10 9.5l6.5 2.6-2.8 1.1-1.1 2.8z" fill="currentColor" /></>),
  depth: svg(<><path d="M3 17.5l5-3h13l-5 3z" /><path d="M5 12.5l4-2.4h10.5l-4 2.4z" opacity="0.75" />
               <path d="M7 7.6l3-1.8h8l-3 1.8z" opacity="0.5" /></>),
  parametric: svg(<><path d="M3 8h18M3 16h18" /><path d="M7 5l2 3H5zM15 5l2 3h-4z" fill="currentColor" />
                    <path d="M5 19l2-3 2 3zM17 19l2-3 2 3z" /></>),
  picker: DROPPER,
  luminance: svg(<><circle cx="12" cy="12" r="4" />
                   <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" /></>),
};

export function MasksPanel({ masks, selected, shape, tool, target, brush, overlay, disabled, raw, image, thumbMaps,
                             renderSlider, onTool, onSelect, onShape, onShapeMode, onShapeDelete,
                             onInvert, onOpacity, onRefine, onHidden, onDuplicate, onDelete, onRename, onPeek,
                             onBrush, onOverlay, onLocal, onRange, onDepth, onFeather, onAi, aiBusy, focusMode,
                             picked, pickShow, pickSet, onParametric, onPickShow, onPickSet, onPickTab, fresh, mono, photo,
                             onHslShown }: {
  masks: Mask[]; selected: string | null; shape: number;
  tool: MaskTool | null; target: ToolTarget; brush: BrushSettings; overlay: boolean; disabled: boolean;
  raw: boolean;                              // detail refinement needs a raw
  mono: boolean;                             // the photo is black and white
  photo: Values;                             // its own values, for which modules it runs on
  image: { w: number; h: number } | null;    // the shown image at 100%, for the thumbnails' aspect
  thumbMaps: Record<string, RangeMap>;       // range masks' maps, by mask
  renderSlider: (c: Control, value: number, onChange: (v: number) => void, glow?: number) => React.ReactNode;
  onTool: (tool: MaskTool | null, target: ToolTarget) => void;
  onSelect: (name: string) => void;
  onShape: (k: number) => void;
  onShapeMode: (k: number) => void;
  onShapeDelete: (k: number) => void;
  onInvert: (invert: boolean) => void;
  onOpacity: (opacity: number) => void;
  onRefine: (patch: Partial<Refine>) => void;
  onHidden: (name: string, hidden: boolean) => void;
  onDuplicate: (name: string, invert: boolean) => void;
  onDelete: (name: string) => void;
  onRename: (name: string, to: string) => void;
  onPeek: (name: string | null) => void;   // the pointer resting on a mask's name, or gone
  onBrush: (b: BrushSettings) => void;
  onOverlay: (on: boolean) => void;
  onLocal: (id: string, v: number) => void;
  onRange: (k: number, patch: Partial<Range>) => void;
  onDepth: (k: number, depth: [number, number], feather: number) => void;
  onFeather: (k: number, patch: Partial<Shape>) => void;   // the selected component's soft edge
  onAi: (kind: AiKind, target: ToolTarget) => void;  // one click, no tool
  aiBusy: boolean;
  focusMode: boolean;
  picked: Picked | null;                     // the parametric show picker's reading
  pickShow: boolean;
  pickSet: BlendifChannel | null;            // the parametric set range picker, for this channel
  onParametric: (k: number, channels: ParametricRange["channels"]) => void;
  onPickShow: (on: boolean) => void;
  onPickSet: (channel: BlendifChannel | null) => void;
  onPickTab: (channel: BlendifChannel | null) => void;
  fresh: { name: string; n: number } | null;   // the mask just created: its Tone opens
  onHslShown: (shown: boolean) => void;      // the HSL group is open, so the photo under the pointer is wanted
}) {
  // a mask's overlay shows once the pointer has rested on its name a
  // moment, so sweeping across the list does not flash each one; leaving
  // hides it at once
  const peekTimer = useRef(0);
  const peekSoon = (name: string | null) => {
    window.clearTimeout(peekTimer.current);
    if (name === null) { onPeek(null); return; }
    peekTimer.current = window.setTimeout(() => onPeek(name), 250);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  const m = masks.find((x) => x.name === selected) ?? null;
  // the selected mask's card and its adjustment groups fold as the edit
  // panels do: in focus mode opening one shuts the others, ⌥ keeps them
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(focusMode ? ["mask", "brush"] : ["mask", "brush", ...LOCAL_GROUPS.map(([t]) => t)]));
  const toggle = (id: string, alt: boolean) =>
    setOpen((old) => {
      const solo = focusMode ? !alt && !old.has(id) : alt;
      if (solo) return new Set(old.has(id) && old.size === 1 ? [] : [id]);
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // a new mask opens on Tone, the first thing it is made for. its settings
  // are still the defaults, so they fold out of the way, and in focus mode
  // so do the other adjustment groups
  useEffect(() => {
    if (!fresh) return;
    setOpen((old) => new Set([...[...old].filter((id) => id !== "mask"
      && (!focusMode || !LOCAL_GROUPS.some(([t]) => t === id))), "Tone"]));
  }, [fresh?.n]);
  // in focus mode, moving one of the mask's adjustments folds its settings
  // and the brush's, as opening a group does. on the release, so the slider being dragged
  // does not jump up the panel under the pointer
  const foldSettings = useRef(false);
  const local = (id: string, v: number) => {
    onLocal(id, v);
    if (focusMode) foldSettings.current = true;
  };
  useEffect(() => {
    const up = () => {
      if (!foldSettings.current) return;
      foldSettings.current = false;
      setOpen((old) => {
        if (!old.has("mask") && !old.has("brush")) return old;
        const next = new Set(old);
        next.delete("mask");
        next.delete("brush");
        return next;
      });
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  // picking the brush again brings its settings back
  useEffect(() => {
    if (tool === "brush") setOpen((old) => (old.has("brush") ? old : new Set([...old, "brush"])));
  }, [tool]);
  const [hslTab, setHslTab] = useState(0);
  const [wheels, setWheels] = useState<WheelMode>("3way");
  // the color bands the photo under the pointer falls in light their
  // sliders, as in the main HSL card
  const hslShown = !!m && !mono && open.has("HSL");
  useEffect(() => { onHslShown(hslShown); }, [hslShown]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onHslShown(false), []);             // eslint-disable-line react-hooks/exhaustive-deps
  const probe = useProbe(hslShown);
  const weights = probe ? bandWeights(probe.rgb) : null;
  const glowOf = (id: string) => {
    const b = weights && /^l_hsl_(?:hue|sat|lum)_(.+)$/.exec(id);
    const k = b ? BANDS.findIndex(([x]) => x === b[1]) : -1;
    return k < 0 ? 0 : weights![k];
  };
  const slider = (id: string) => {
    const c = localControlById.get(id)!;
    return renderSlider(c, m!.values[c.id] ?? 0, (v) => local(c.id, v), glowOf(c.id));
  };
  const groupBody = (title: string, ids: string[]) => {
    if (title === "HSL") {
      const key = (["hue", "sat", "lum"] as const)[hslTab];
      return <>
        <div className="segmented tabs">
          {HSL_TABS.map((label, i) => (
            <button key={label} className={i === hslTab ? "active" : ""} onClick={() => setHslTab(i)}>{label}</button>
          ))}
        </div>
        {ids.filter((id) => id.startsWith(`l_hsl_${key}_`)).map(slider)}
      </>;
    }
    if (title === "Color Grading")
      return <>
        <GradingWheels prefix="l_cg" mode={wheels} onMode={setWheels} values={m!.values} disabled={disabled}
                       onChange={(es) => es.forEach(([id, v]) => local(id, v))} lum={slider} />
        {wheels === "sliders" && RANGES.map(([r, label]) => (
          <div className="subcard" key={r}>
            <div className="subcard-head">{label}</div>
            {ids.filter((id) => id.startsWith(`l_cg_${r}_`)).map(slider)}
          </div>
        ))}
      </>;
    return ids.map(slider);
  };
  const menu = (t: ToolTarget) => (
    <ShapeMenu target={t} tool={target === t ? tool : null} disabled={disabled} aiBusy={aiBusy}
               onTool={(id) => onTool(id, t)} onAi={(k) => onAi(k, t)} />
  );
  const thumb = (x: Mask) => (image
    ? <img className="mask-thumb" alt="" src={maskThumb(x, 48, image.w, image.h, thumbMaps[x.name] ?? null)} />
    : <span className="mask-thumb" />);

  return (
    <div className="masks-panel">
      <div className="panel adjust">
        <div className="panel-title">
          <span>Masks</span>
          <button className={`eye${overlay ? " on" : ""}`} title={`show overlay (O)`}
                  onClick={(e) => { e.stopPropagation(); onOverlay(!overlay); }}>{eyeIcon(overlay)}</button>
        </div>
        <section>
          {menu("new")}
          {masks.length > 0 && (
            <ul className="mask-list">
              {masks.map((x) => (
                <li key={x.name} className={`${x.name === selected ? "on" : ""}${x.hidden ? " off" : ""}`}>
                  <div className="mask-row" onClick={() => onSelect(x.name)}
                       onMouseEnter={() => peekSoon(x.name)} onMouseLeave={() => peekSoon(null)}>
                    {/* the eye compares with and without the mask, so the overlay keeps out of the way */}
                    <button className="eye" title={x.hidden ? "show this mask's adjustments" : "hide this mask's adjustments"}
                            onMouseEnter={() => peekSoon(null)} onMouseLeave={() => peekSoon(x.name)}
                            onClick={(e) => { e.stopPropagation(); onHidden(x.name, !x.hidden); }}>
                      {eyeIcon(!x.hidden)}</button>
                    {thumb(x)}
                    <MaskName name={x.name} editing={renaming === x.name}
                              onEditing={(on) => setRenaming(on ? x.name : null)}
                              onRename={(to) => onRename(x.name, to)} />
                    <MaskMenu onDuplicate={(inv) => onDuplicate(x.name, inv)} onRename={() => setRenaming(x.name)}
                              onDelete={() => onDelete(x.name)} />
                    <button className="mask-del" title="delete this mask"
                            onClick={(e) => { e.stopPropagation(); onDelete(x.name); }}>×</button>
                  </div>
                  {x.name === selected && (
                    <div className="mask-parts">
                      {/* one part is the mask itself, named on its row */}
                      {x.shapes.length > 1 && <ul className="shape-list">
                        {x.shapes.map((s, k) => (
                          <li key={k} className={k === shape ? "on" : ""} onClick={() => onShape(k)}>
                            <span className="name">{shapeLabel(s)}</span>
                            {k > 0 && !isRange(s) && (
                              // as it reads on what shows, which an inverted mask turns round
                              <button className={`mode${(s.mode === "subtract") !== x.invert ? " sub" : ""}`}
                                      title="add to the mask or take away from it"
                                      onClick={(e) => { e.stopPropagation(); onShapeMode(k); }}>
                                {(s.mode === "subtract") !== x.invert ? "−" : "+"}</button>
                            )}
                            <button className="del" title="delete this shape"
                                    onClick={(e) => { e.stopPropagation(); onShapeDelete(k); }}>×</button>
                          </li>
                        ))}
                      </ul>}
                      <div className="mask-ops">{menu("add")}{menu("subtract")}</div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {!masks.length && <div className="note-plain">pick a kind of mask to start one</div>}
        </section>
        {m && (
          // what the mask is: the selected one's own settings
          <section>
            <h3 className="fold" onClick={(e) => toggle("mask", e.altKey)}>Mask settings<Chevron open={open.has("mask")} /></h3>
            <Collapse open={open.has("mask")}>
              <label className="toggle">
                <span>Invert</span>
                <input type="checkbox" className="switch" checked={m.invert} disabled={disabled}
                       onChange={(e) => onInvert(e.target.checked)} />
              </label>
              {renderSlider(OPACITY, m.opacity ?? 100, onOpacity)}
              {REFINES.filter(([f]) => raw || f !== "detail").map(([f, c, k]) =>
                renderSlider(c, Math.round(((m.refine ?? NO_REFINE)[f] / k) * 10) / 10,
                             (v) => onRefine({ [f]: v * k })))}
              {(() => {
                // the selected component's own soft edge, as Lightroom's
                // Feather: a radial's inward fade, a stroke's softness, an
                // outline's border. a linear gradient's fade is its handles,
                // and a range's is Smoothness
                const r = m.shapes[shape];
                const feather = (value: number, neutral: number, set: (v: number) => void) =>
                  renderSlider({ id: "s_feather", label: "Feather", min: 0, max: 100, step: 1, neutral, format: pct },
                               Math.round(value), set);
                if (r?.type === "ellipse")
                  return feather(r.feather * 100, 50, (v) => onFeather(shape, { feather: Math.min(0.95, v / 100) }));
                if (r?.type === "brush")
                  return feather((1 - r.hardness) * 100, 50, (v) => onFeather(shape, { hardness: 1 - v / 100 }));
                if (r?.type === "object" && !r.depth)
                  return feather((r.feather ?? 0.003) * 2000, 6, (v) => onFeather(shape, { feather: v / 2000 }));
                if (r?.type === "object" && r.depth) {
                  const [near, far] = r.depth, f = r.feather ?? 0.01;
                  return (
                    <>
                      {renderSlider({ id: "d_near", label: "Near", min: 0, max: 100, step: 1, neutral: near * 100, format: pct },
                                    near * 100, (v) => onDepth(shape, [Math.min(v / 100, far), far], f))}
                      {renderSlider({ id: "d_far", label: "Far", min: 0, max: 100, step: 1, neutral: far * 100, format: pct },
                                    far * 100, (v) => onDepth(shape, [near, Math.max(v / 100, near)], f))}
                      {feather(f * 2000, 20, (v) => onFeather(shape, { feather: v / 2000 }))}
                    </>
                  );
                }
                if (!r || !isRange(r)) return null;
                if (r.type === "parametric")
                  return <ParametricEditor key={`${m.name}:${shape}`} range={r} picked={picked} showing={pickShow}
                                           setting={pickSet} disabled={disabled} renderSlider={renderSlider}
                                           onChange={(ch) => onParametric(shape, ch)} onShow={onPickShow}
                                           onSet={onPickSet} onTab={onPickTab} />;
                if (r.type === "luminance") {
                  // a Zone System range for zone 0 or X has an open end
                  const lo = r.lo ?? -14, hi = r.hi ?? 6;
                  return (
                  <>
                    {renderSlider({ id: "r_lo", label: "Low (EV)", min: -14, max: 6, step: 0.1, neutral: lo,
                                    format: (v) => (r.lo === null && v === lo ? "open" : v.toFixed(1)) },
                                  lo, (v) => onRange(shape, { lo: Math.min(v, hi) }))}
                    {renderSlider({ id: "r_hi", label: "High (EV)", min: -14, max: 6, step: 0.1, neutral: hi,
                                    format: (v) => (r.hi === null && v === hi ? "open" : v.toFixed(1)) },
                                  hi, (v) => onRange(shape, { hi: Math.max(v, lo) }))}
                    {renderSlider({ id: "r_lf", label: "Smoothness", min: 0.1, max: 4, step: 0.1, neutral: 1,
                                    format: (v) => v.toFixed(1) }, r.feather, (v) => onRange(shape, { feather: v }))}
                  </>
                  );
                }
                return (
                  <>
                    {renderSlider({ id: "r_cw", label: "Refine", min: 0, max: 100, step: 1, neutral: 27,
                                    format: (v) => `${Math.round(v)}` },
                                  (r.width - 0.005) / 0.0013, (v) => onRange(shape, { width: 0.005 + v * 0.0013 }))}
                    {renderSlider({ id: "r_cf", label: "Smoothness", min: 0, max: 100, step: 1, neutral: 19,
                                    format: (v) => `${Math.round(v)}` },
                                  (r.feather - 0.002) / 0.002, (v) => onRange(shape, { feather: 0.002 + v * 0.002 }))}
                  </>
                );
              })()}
            </Collapse>
          </section>
        )}
      </div>

      {tool === "brush" && (
        <div className="panel adjust">
          <div className={`panel-title${open.has("brush") ? " open" : ""}`}
               onClick={() => setOpen((old) => {
                 const next = new Set(old);
                 if (next.has("brush")) next.delete("brush"); else next.add("brush");
                 return next;
               })}>
            <span>Brush</span><Chevron open={open.has("brush")} />
          </div>
          <Collapse open={open.has("brush")}>
            <section>
              {renderSlider({ id: "b_size", label: "Size", min: 0.5, max: 40, step: 0.5, neutral: 5,
                              format: (v) => `${v.toFixed(1)}%` },
                            brush.size * 100, (v) => onBrush({ ...brush, size: v / 100 }))}
              {renderSlider({ id: "b_feather", label: "Feather", min: 0, max: 100, step: 1, neutral: 50,
                              format: (v) => `${Math.round(v)}` },
                            (1 - brush.hardness) * 100, (v) => onBrush({ ...brush, hardness: 1 - v / 100 }))}
              {renderSlider({ id: "b_flow", label: "Density", min: 1, max: 100, step: 1, neutral: 100,
                              format: (v) => `${Math.round(v)}` },
                            brush.density * 100, (v) => onBrush({ ...brush, density: v / 100 }))}
              <label className="toggle">
                <span>{keys("Erase (hold ⌥)")}</span>
                <input type="checkbox" className="switch" checked={brush.erase}
                       onChange={(e) => onBrush({ ...brush, erase: e.target.checked })} />
              </label>
            </section>
          </Collapse>
        </div>
      )}

      {m && (
        // what the mask does: its adjustments, in one card apart from the masks
        <div className="panel adjust">
          <div className="panel-title adj-title">
            <span>Adjustments <span className="of">· {m.name.replace(/^mask/, "Mask")}</span></span>
          </div>
          {(mono ? MONO_GROUPS : LOCAL_GROUPS).map(([title, ids]) => (
            <section key={title}>
              <h3 className="fold" onClick={(e) => toggle(title, e.altKey)}>
                {title}
                {title === "HSL" && probe && (
                  <span className="probe-chip" title="the color under the pointer, and its band">
                    <i style={{ background: `rgb(${probe.rgb.map(Math.round).join(",")})` }} />
                    {weights ? BANDS[weights.indexOf(Math.max(...weights))][1] : "neutral"}
                  </span>
                )}
                <Chevron open={open.has(title)} />
              </h3>
              <Collapse open={open.has(title)}>
                {groupBody(title, ids.filter((id) => choiceShows(id, photo)))}
              </Collapse>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

const eyeIcon = (open: boolean) => svg(<>
  <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
  {!open && <path d="m3 3 18 18" />}</>);

// a mask row's "…": what else can be done with it
function MaskMenu({ onDuplicate, onRename, onDelete }: {
  onDuplicate: (invert: boolean) => void; onRename: () => void; onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useDismiss(open, () => setOpen(false), box);
  const item = (label: string, act: () => void, cls = "") => (
    <button className={cls} onClick={(e) => { e.stopPropagation(); setOpen(false); act(); }}>{label}</button>
  );
  return (
    <span className="mask-more" ref={box} onClick={(e) => e.stopPropagation()}>
      <button className={`more-btn${open ? " on" : ""}`} title="more" onClick={() => setOpen(!open)}>…</button>
      {open && (
        <div className="tile-menu mask-more-list">
          {item("Duplicate Mask", () => onDuplicate(false))}
          {item("Duplicate and Invert Mask", () => onDuplicate(true))}
          {item("Rename Mask", onRename)}
          {item("Delete Mask", onDelete, "danger")}
        </div>
      )}
    </span>
  );
}

// a menu closes on a click outside it, or Escape
export function useDismiss(open: boolean, close: () => void, box: React.RefObject<HTMLElement | null>) {
  const closer = useRef(close);
  closer.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) closer.current(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") closer.current(); };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc, true);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("keydown", esc, true); };
  }, [open, box]);
}

const ADD_ICON = svg(<><circle cx="12" cy="12" r="9" /><path d="M12 8v8M8 12h8" /></>);
const SUBTRACT_ICON = svg(<><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>);

// Create New Mask, or Add or Subtract on the selected mask: a button opening
// the list of what can be made, added or taken away. ranges only narrow a
// mask, so on one they sit under Add as Intersect
function ShapeMenu({ target, tool, disabled, aiBusy, onTool, onAi }: {
  target: ToolTarget; tool: MaskTool | null; disabled: boolean; aiBusy: boolean;
  onTool: (tool: MaskTool | null) => void; onAi: (kind: AiKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [landscape, setLandscape] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const close = () => { setOpen(false); setLandscape(false); };
  useDismiss(open, close, box);
  const ai = (k: AiKind, label: React.ReactNode, icon: React.ReactNode) => (
    <button key={k} className="ai" disabled={aiBusy} onClick={() => { close(); onAi(k); }}>
      {icon}<span>{label}</span></button>
  );
  const tools = (list: [MaskTool, string, string][]) => list.map(([id, label, key]) => (
    <button key={id} className={`${list === AI_TOOLS || list === DEPTH_TOOLS ? "ai" : ""}${tool === id ? " on" : ""}`}
            disabled={list === DEPTH_TOOLS && aiBusy}
            onClick={() => { close(); onTool(tool === id ? null : id); }}>
      {TOOL_ICONS[id]}<span>{label}</span>
      {(list === TOOLS || list === RANGE_TOOLS) && <span className="key">{keys(key)}</span>}</button>
  ));
  const button = target === "new"
    ? <button className={`create-mask${open || tool ? " on" : ""}`} disabled={disabled}
              onClick={() => (open ? close() : setOpen(true))}>
        <span className="plus">{svg(<path d="M12 6v12M6 12h12" />)}</span>Create New Mask</button>
    : <button className={`mask-op${open || tool ? " on" : ""}${target === "subtract" ? " sub" : ""}`}
              disabled={disabled} title={`${target === "add" ? "add to" : "subtract from"} this mask`}
              onClick={() => (open ? close() : setOpen(true))}>
        {target === "add" ? ADD_ICON : SUBTRACT_ICON}<span>{target === "add" ? "Add" : "Subtract"}</span></button>;
  return (
    <span className={`shape-menu ${target}`} ref={box}>
      {button}
      {open && (
        <div className="tile-menu shape-menu-list">
          <span className="tool-kind">AI</span>
          {ai("subject", "Subject", AI_ICONS.subject)}
          {ai("sky", "Sky", AI_ICONS.sky)}
          {target === "new" && ai("background", "Background", AI_ICONS.background)}
          {ai("people", "People", AI_ICONS.people)}
          <button className={`ai${landscape ? " on" : ""}`} disabled={aiBusy} onClick={() => setLandscape(!landscape)}>
            {AI_ICONS.landscape}<span>Landscape</span><span className="more">{landscape ? "▾" : "▸"}</span></button>
          {landscape && LANDSCAPE.map(([k, label]) => (
            <button key={k} className="ai sub-item" disabled={aiBusy} onClick={() => { close(); onAi(k); }}>{label}</button>
          ))}
          {tools(AI_TOOLS)}
          <span className="tool-kind">Shapes</span>
          {tools(TOOLS)}
          <span className="tool-kind">Ranges</span>
          {target === "new" && tools(RANGE_TOOLS)}
          {tools(DEPTH_TOOLS)}
          {target === "add" && <><span className="tool-kind">Intersect</span>{tools(RANGE_TOOLS)}</>}
        </div>
      )}
    </span>
  );
}

// a mask's name; a double-click, or Rename in its menu, edits it in place,
// Enter keeps the new name and Escape the old one
function MaskName({ name, editing, onEditing, onRename }: {
  name: string; editing: boolean; onEditing: (on: boolean) => void; onRename: (to: string) => void;
}) {
  const shown = name.replace(/^mask/, "Mask");
  if (!editing) {
    return <span className="name" title="double-click to rename"
                 onDoubleClick={(e) => { e.stopPropagation(); onEditing(true); }}>{shown}</span>;
  }
  return <NameEdit shown={shown} onDone={(to) => { onEditing(false); if (to && to !== shown) onRename(to); }} />;
}

function NameEdit({ shown, onDone }: { shown: string; onDone: (to: string | null) => void }) {
  const [draft, setDraft] = useState(shown);
  return (
    <input className="name-edit" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
           onClick={(e) => e.stopPropagation()} onFocus={(e) => e.target.select()}
           onBlur={() => onDone(draft.trim())}
           onKeyDown={(e) => {
             if (e.key === "Enter") onDone(draft.trim());
             else if (e.key === "Escape") onDone(null);
           }} />
  );
}
