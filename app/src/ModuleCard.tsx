// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { RotateCcw } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { InstanceMenu, type InstanceChoice } from "./InstanceMenu";
import { PresetMenu } from "./PresetMenu";
import { FamilySwitch, type FamilyOption } from "./FamilySwitch";
import { Chevron, Collapse } from "./Collapse";
import { Choice, Slider, Toggle } from "./Controls";
import { colorProfiles, wbPresets, type AdvancedState, type ColorProfiles } from "./session";
import type { DtPreset, Instance, ModuleSchema, SchemaField, WbPreset } from "./commands";
import type { Control, Turn } from "./manifest";
import { FlipIcon, RotateIcon } from "./icons";
import { fieldPath, type LayoutField, type ModuleLayout } from "./advancedLayout";
import { ColorWheel } from "./ColorWheel";
import { ModuleCurves } from "./ModuleCurves";
import { ModuleGraph } from "./ModuleGraph";
import { graphFields } from "./graphMaps";
import { LensPicker } from "./LensPicker";

// the card's fields as the controls the rest of the app draws
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// the engine's own fields, which no introspection schema lists: white
// balance's temperature and tint, in temperature.c's limits (wb.c)
const ENGINE_FIELDS: Record<string, SchemaField> = {
  temp_k: { path: "temp_k", type: "float", min: 1901, max: 25000 },
  tint: { path: "tint", type: "float", min: 0.135, max: 2.326 },
  wb_setting: { path: "wb_setting", type: "int", min: 0, max: 255 },
  wb_tune: { path: "wb_tune", type: "int", min: -100, max: 100 },
};

// the schema entry of a layout path: an array element ("red[2]") takes its
// array's type, range and that element's default
export function schemaField(fields: Map<string, SchemaField>, path: string): SchemaField | undefined {
  const direct = fields.get(path);
  if (direct) return direct;
  if (path in ENGINE_FIELDS) return ENGINE_FIELDS[path];
  const a = fields.get(fieldPath(path)), k = Number(/\[(\d+)\]$/.exec(path)?.[1]);
  if (!a || a.type !== "array" || !a.element || Number.isNaN(k)) return undefined;
  return { ...a, path, type: a.element, default: a.defaults?.[k] ?? null, dims: null, defaults: null };
}

export function fieldControl(f: SchemaField, l: LayoutField, value: number): Control {
  // as dt_bauhaus_slider_set_format: a "%" slider over a small range shows
  // the value times 100, two digits fewer. `digits` is the shown precision
  const percent = l.unit === "%" && Math.abs(f.max ?? Infinity) <= 10;
  const factor = l.factor ?? (percent ? 100 : 1), offset = l.offset ?? 0;
  const digits = l.digits ?? (f.type === "int" || percent ? 0 : 2);
  const hard: [number, number] = [f.min ?? -Infinity, f.max ?? Infinity];
  const soft = l.soft ?? [Math.max(hard[0], -1e6), Math.min(hard[1], 1e6)];
  // a value past the soft range stays reachable and shown, not clamped
  const min = Math.max(hard[0], Math.min(soft[0], value));
  const max = Math.min(hard[1], Math.max(soft[1], value));
  // darktable's formats put "%" and "°" right after the number
  const unit = l.unit ? (l.unit === "%" || l.unit === "°" ? l.unit : ` ${l.unit}`) : "";
  // digits count on the shown value, so the step is in shown units too
  const base = { id: `adv:${l.path}`, label: l.label, min, max, step: 10 ** -digits / Math.abs(factor),
                 format: (v: number) => `${(v * factor + offset).toFixed(digits)}${unit}`, note: f.description || undefined };
  if (f.type === "bool") return { ...base, kind: "toggle", min: 0, max: 1, step: 1 };
  if (l.choices) return { ...base, kind: "choice", min: 0, max: Math.max(...l.choices.map(([, v]) => v)), step: 1,
                          options: l.choices, inline: l.choices.length > 3, menu: l.choices.length > 3 };
  if (f.type === "enum") {
    const options = (f.values ?? []).filter((e) => !l.options || l.options.includes(e.value))
      .map((e): [string, number] => [sentence(e.description || e.name), e.value]);
    return { ...base, kind: "choice", min: 0, max: Math.max(...options.map(([, v]) => v)), step: 1,
             options, inline: options.length > 3, menu: options.length > 3 };
  }
  return { ...base, kind: "slider" };
}

// `siblings` is how many instances of the module the group shows, `index`
// this one's place among them (pipe order); `fresh`, a card just added;
// `focus`, a number that changes each time the module search picks the card
export function ModuleCard({ hidden, instance, layout, schema, state, siblings, index, fresh, focus, family, photo, wbInModule, onField, onFields, onEnabled, onReset, onInstance, loadPresets, onPreset, onTurn }: {
  instance: Instance; layout: ModuleLayout; schema: ModuleSchema; state: AdvancedState;
  // hidden in Preferences > Modules, yet shown as the photo uses it
  hidden?: boolean;
  siblings: number; index: number; fresh?: boolean; focus?: number;
  // the open photo, which the lens picker lists lenses for
  photo?: object | null;
  // the white balance note: the photo's white balance is set by this module
  // with color calibration off (Session.wbInModule)
  wbInModule?: boolean;
  // the modules this card can switch to, when it is a shared card
  family?: { label: string; options: FamilyOption[]; onPick: (op: string) => void };
  onField: (path: string, value: number, coalesce: boolean) => void;
  // several fields as one edit (a wheel's hue and chroma)
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
  onEnabled: (on: boolean) => void; onReset: () => void;
  onInstance: (c: InstanceChoice, name?: string) => void;
  loadPresets: () => Promise<DtPreset[]>; onPreset: (name: string) => void;
  onTurn?: (how: Turn) => void;
}) {
  const edited = instance.hand_edited || state.enabled !== instance.default_enabled;
  // folded unless edited or just added; the user's own fold wins after that
  const [fold, setFold] = useState<boolean | null>(fresh ? true : null);
  const [renaming, setRenaming] = useState(false);
  // Enter or Escape ends the rename once; the blur that follows does not
  const ended = useRef(false);
  const open = fold ?? edited;
  const fields = new Map(schema.fields.map((f) => [f.path, f]));
  // the profile menus' choices, read again when a profile changes (an added
  // file shows up); the current one stays listed when it is not among them
  const roles = layout.fields.flatMap((l) => l.profiles ? [l.profiles] : []);
  const [profiles, setProfiles] = useState<ColorProfiles | null>(null);
  const shown = roles.map((r) => state.params[`${r}_profile`]).join();
  useEffect(() => {
    if (!roles.length) return;
    let live = true;
    colorProfiles().then((p) => { if (live) setProfiles(p); }).catch(() => {});
    return () => { live = false; };
  }, [shown]);   // eslint-disable-line react-hooks/exhaustive-deps
  const profileField = (l: LayoutField, value: number): [SchemaField, LayoutField] => {
    const list = profiles?.[l.profiles!] ?? [];
    const choices = list.some(([, v]) => v === value) ? list : [...list, ["Current profile", value] as [string, number]];
    return [{ path: l.path, type: "int" }, { ...l, choices }];
  };
  // white balance's camera presets, once per photo (wb_presets: empty for a
  // photo without any); the card reads the setting and finetune from them
  const hasWb = layout.fields.some((l) => l.wb);
  const [wbList, setWbList] = useState<WbPreset[]>([]);
  useEffect(() => {
    if (!hasWb) return;
    let live = true;
    setWbList([]);
    wbPresets().then((r) => { if (live) setWbList(r.presets); }).catch(() => {});
    return () => { live = false; };
  }, [photo]);   // eslint-disable-line react-hooks/exhaustive-deps
  const wbCurrent = wbList.find((p) => p.value === state.params.wb_setting);
  const wbField = (l: LayoutField, value: number): [SchemaField, LayoutField] | null => {
    if (l.wb === "tune") {
      if (!wbCurrent || wbCurrent.tune_min >= wbCurrent.tune_max) return null;
      return [{ path: l.path, type: "int", min: wbCurrent.tune_min, max: wbCurrent.tune_max }, { ...l, soft: [wbCurrent.tune_min, wbCurrent.tune_max] }];
    }
    // temperature.c's own order; from image area (index 1) is not offered
    const std: [string, number][] = [["As shot", 0], ["User modified", 2], ["Camera reference", 3], ["As shot to reference", 4]];
    const list = [...std, ...wbList.map((p): [string, number] => [p.name, p.value])];
    const choices = list.some(([, v]) => v === value) ? list : [...list, ["Current setting", value] as [string, number]];
    return [{ path: l.path, type: "int" }, { ...l, choices }];
  };
  // darktable's notebook pages, in its order; the first is shown at first
  const tabs = [...new Set(layout.fields.flatMap((l) => l.tab ? [l.tab] : []))];
  const [tab, setTab] = useState(tabs[0]);
  // a module darktable will not let you switch: off, it cannot apply here
  const fixed = instance.switchable === false;
  // a card just added is brought into view and flashes once
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { if (fresh) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [fresh]);
  // the module search's pick: open, flash and bring into view. the group may
  // still be easing open, so the scroll waits for it
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (focus === undefined) return;
    setFold(true);
    setFlash(true);
    const scroll = window.setTimeout(() => card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 260);
    const off = window.setTimeout(() => setFlash(false), 1300);
    return () => { window.clearTimeout(scroll); window.clearTimeout(off); };
  }, [focus]);
  const name = instance.label ? `${layout.title} ${instance.label}` : layout.title;
  const done = (el: HTMLInputElement, keep: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setRenaming(false);
    const v = el.value.trim();
    if (keep && v !== (instance.hand_edited ? instance.name : "")) onInstance("rename", v);
  };
  return (
    <div ref={card} className={`module-card${state.enabled ? "" : " off"}${fresh || flash ? " fresh" : ""}`} data-module={`${instance.op}#${instance.priority}`}>
      <div className="module-card-head" onClick={() => setFold(!open)}>
        <input type="checkbox" className="switch" checked={state.enabled} aria-label={`${name} on or off`} disabled={fixed}
               onClick={(e) => e.stopPropagation()} onChange={(e) => onEnabled(e.target.checked)} />
        {renaming
          ? <input className="field module-card-rename" autoFocus defaultValue={instance.hand_edited ? instance.name : ""}
                   placeholder={instance.label || layout.title} aria-label={`Name for ${name}`} maxLength={127}
                   spellCheck={false} onClick={(e) => e.stopPropagation()}
                   onFocus={(e) => e.currentTarget.select()}
                   onKeyDown={(e) => {
                     e.stopPropagation();
                     if (e.key === "Enter") done(e.currentTarget, true);
                     if (e.key === "Escape") done(e.currentTarget, false);
                   }}
                   onBlur={(e) => done(e.currentTarget, true)} />
          : <span className="module-card-title">{name}</span>}
        {family && <span onClick={(e) => e.stopPropagation()}>
          <FamilySwitch label={family.label} current={instance.op} options={family.options} onPick={family.onPick} />
        </span>}
        {hidden && <span className="module-card-tag" title="Hidden in Preferences > Modules; this photo uses it, so its card stays">hidden</span>}
        {siblings > 1 && instance.priority === 0 && <span className="module-card-tag" title="Simple's sliders show this instance">Simple</span>}
        <PresetMenu name={name} load={loadPresets} onPick={(n) => { setFold(true); onPreset(n); }} />
        <button className="module-card-reset" title="Reset to darktable's defaults" aria-label={`Reset ${name}`}
                onClick={(e) => { e.stopPropagation(); onReset(); }}>
          <RotateCcw size={14} strokeWidth={1.8} />
        </button>
        <InstanceMenu name={name} oneInstance={!!schema.flags.one_instance} first={instance.priority === 0}
                      canUp={index > 0} canDown={index < siblings - 1}
                      onPick={(c) => { if (c === "rename") { ended.current = false; setRenaming(true); } else onInstance(c); }} />
        <Chevron open={open} />
      </div>
      <Collapse open={open}>
        <div className="module-card-body">
          {layout.op === "temperature" && wbInModule && (
            <div className="note" style={{ marginLeft: 0, marginRight: 0 }}>color calibration is off, so this module sets the white balance</div>
          )}
          {layout.turns && onTurn && (
            <div className="crop-turn module-card-turns">
              {layout.turns.map(({ label, how }) => (
                <button key={how} className="tool" title={label} aria-label={label} onClick={() => onTurn(how)}>
                  {how === "h" || how === "v" ? <FlipIcon vertical={how === "v"} /> : <RotateIcon right={how === "cw"} />}
                </button>
              ))}
            </div>
          )}
          {tabs.length > 1 && (
            <div className="segmented small module-card-tabs" role="tablist">
              {tabs.map((t) => <button key={t} role="tab" aria-selected={t === tab} className={t === tab ? "active" : ""}
                                       onClick={() => setTab(t)}>{t}</button>)}
            </div>
          )}
          {layout.curves && [layout.curves.count(0), layout.curves.node(0, 0, "x")].every((p) => fields.has(p.replace(/\[.*$/, ""))) && (
            <ModuleCurves op={layout.op} curves={layout.curves} state={state} disabled={fixed && !state.enabled} onFields={onFields} />
          )}
          {layout.graph && graphFields(layout.graph).every((f) => fields.has(f)) && (
            <ModuleGraph kind={layout.graph} state={state} disabled={fixed && !state.enabled} onFields={onFields} />
          )}
          {layout.lensPick && state.params.method === 1 && (
            <div data-control-id="adv:lens_pick">
              <LensPicker value={state.params.lens_pick ?? 0} photo={photo ?? null} disabled={fixed && !state.enabled}
                          onChange={(hash) => onFields({ lens_pick: hash, has_been_set: 1 }, false, "lens-pick")} />
            </div>
          )}
          {(() => {
            // a section heading shows once, above the first of its fields shown
            let heading: string | undefined;
            return layout.fields.map((l) => {
              const value = state.params[l.path] ?? state.defaults[l.path] ?? 0;
              const [f, shownAs] = (l.profiles ? profileField(l, value) : l.wb ? wbField(l, value) : null) ?? [l.wb ? undefined : schemaField(fields, l.path), l];
              if (!f || (l.tab && l.tab !== tab) || (l.showIf && !l.showIf(state.params))) return null;
              const neutral = state.defaults[l.path] ?? 0;
              const control = fieldControl(f, shownAs, value);
              const props = { control, value, neutral, values: state.params, disabled: fixed && !state.enabled };
              const set = (coalesce: boolean) => (v: number) => onField(l.path, v, coalesce);
              const title = l.section && l.section !== heading ? l.section : undefined;
              heading = l.section;
              const wheel = title ? layout.wheels?.find((w) => w.section === title) : undefined;
              return (
                <Fragment key={l.path}>
                  {title && <div className="module-card-section">{title}</div>}
                  {wheel && fields.has(wheel.hue) && fields.has(wheel.chroma) && (() => {
                    const top = layout.fields.find((x) => x.path === wheel.chroma)?.soft?.[1] ?? fields.get(wheel.chroma)!.max ?? 1;
                    const hue = state.params[wheel.hue] ?? 0, chroma = state.params[wheel.chroma] ?? 0;
                    return (
                      <div className="module-card-wheel" data-wheel={wheel.hue}>
                        <ColorWheel hue={hue} sat={Math.min(100, Math.max(0, chroma / top * 100))} size="140px" disabled={fixed && !state.enabled}
                                    onChange={(h, sat) => onFields({ [wheel.hue]: h, [wheel.chroma]: sat / 100 * top }, true, wheel.hue)} />
                      </div>
                    );
                  })()}
                  {control.kind === "toggle" ? <Toggle {...props} onChange={set(false)} />
                    : control.kind === "choice" ? <Choice {...props} onChange={set(false)} />
                    : <Slider {...props} onChange={set(true)} />}
                </Fragment>
              );
            });
          })()}
        </div>
      </Collapse>
    </div>
  );
}
