// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { RotateCcw } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { InstanceMenu, type InstanceChoice } from "./InstanceMenu";
import { PresetMenu } from "./PresetMenu";
import { FamilySwitch, type FamilyOption } from "./FamilySwitch";
import { Chevron, Collapse } from "./Collapse";
import { Choice, Slider, Toggle } from "./Controls";
import type { AdvancedState } from "./session";
import type { DtPreset, Instance, ModuleSchema, SchemaField } from "./commands";
import type { Control, Turn } from "./manifest";
import { FlipIcon, RotateIcon } from "./icons";
import { fieldPath, type LayoutField, type ModuleLayout } from "./advancedLayout";

// the card's fields as the controls the rest of the app draws
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// the schema entry of a layout path: an array element ("red[2]") takes its
// array's type, range and that element's default
export function schemaField(fields: Map<string, SchemaField>, path: string): SchemaField | undefined {
  const direct = fields.get(path);
  if (direct) return direct;
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
// this one's place among them (pipe order); `fresh`, a card just added
export function ModuleCard({ instance, layout, schema, state, siblings, index, fresh, family, onField, onEnabled, onReset, onInstance, loadPresets, onPreset, onTurn }: {
  instance: Instance; layout: ModuleLayout; schema: ModuleSchema; state: AdvancedState;
  siblings: number; index: number; fresh?: boolean;
  // the modules this card can switch to, when it is a shared card
  family?: { label: string; options: FamilyOption[]; onPick: (op: string) => void };
  onField: (path: string, value: number, coalesce: boolean) => void;
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
  // darktable's notebook pages, in its order; the first is shown at first
  const tabs = [...new Set(layout.fields.flatMap((l) => l.tab ? [l.tab] : []))];
  const [tab, setTab] = useState(tabs[0]);
  // a module darktable will not let you switch: off, it cannot apply here
  const fixed = instance.switchable === false;
  // a card just added is brought into view and flashes once
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => { if (fresh) card.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [fresh]);
  const name = instance.label ? `${layout.title} ${instance.label}` : layout.title;
  const done = (el: HTMLInputElement, keep: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setRenaming(false);
    const v = el.value.trim();
    if (keep && v !== (instance.hand_edited ? instance.name : "")) onInstance("rename", v);
  };
  return (
    <div ref={card} className={`module-card${state.enabled ? "" : " off"}${fresh ? " fresh" : ""}`} data-module={`${instance.op}#${instance.priority}`}>
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
          {(() => {
            // a section heading shows once, above the first of its fields shown
            let heading: string | undefined;
            return layout.fields.map((l) => {
              const f = schemaField(fields, l.path);
              if (!f || (l.tab && l.tab !== tab) || (l.showIf && !l.showIf(state.params))) return null;
              const value = state.params[l.path] ?? state.defaults[l.path] ?? 0;
              const neutral = state.defaults[l.path] ?? 0;
              const control = fieldControl(f, l, value);
              const props = { control, value, neutral, values: state.params, disabled: fixed && !state.enabled };
              const set = (coalesce: boolean) => (v: number) => onField(l.path, v, coalesce);
              const title = l.section && l.section !== heading ? l.section : undefined;
              heading = l.section;
              return (
                <Fragment key={l.path}>
                  {title && <div className="module-card-section">{title}</div>}
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
