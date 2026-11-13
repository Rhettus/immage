// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { InstanceMenu, type InstanceChoice } from "./InstanceMenu";
import { PresetMenu } from "./PresetMenu";
import { Chevron, Collapse } from "./Collapse";
import { Choice, Slider, Toggle } from "./Controls";
import type { AdvancedState } from "./session";
import type { DtPreset, Instance, ModuleSchema, SchemaField } from "./commands";
import type { Control } from "./manifest";
import { type LayoutField, type ModuleLayout } from "./advancedLayout";

// the card's fields as the controls the rest of the app draws
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function fieldControl(f: SchemaField, l: LayoutField, value: number): Control {
  const digits = l.digits ?? (f.type === "int" ? 0 : 2);
  const hard: [number, number] = [f.min ?? -Infinity, f.max ?? Infinity];
  const soft = l.soft ?? [Math.max(hard[0], -1e6), Math.min(hard[1], 1e6)];
  // a value past the soft range stays reachable and shown, not clamped
  const min = Math.max(hard[0], Math.min(soft[0], value));
  const max = Math.min(hard[1], Math.max(soft[1], value));
  const unit = l.unit ? (l.unit === "%" ? "%" : ` ${l.unit}`) : "";
  const base = { id: `adv:${f.path}`, label: l.label, min, max, step: 10 ** -digits,
                 format: (v: number) => `${v.toFixed(digits)}${unit}`, note: f.description || undefined };
  if (f.type === "bool") return { ...base, kind: "toggle", min: 0, max: 1, step: 1 };
  if (f.type === "enum") {
    const options = (f.values ?? []).map((e): [string, number] => [sentence(e.description || e.name), e.value]);
    return { ...base, kind: "choice", min: 0, max: Math.max(...options.map(([, v]) => v)), step: 1,
             options, inline: options.length > 3, menu: options.length > 3 };
  }
  return { ...base, kind: "slider" };
}

// `siblings` is how many instances of the module the group shows, `index`
// this one's place among them (pipe order); `fresh`, a card just added
export function ModuleCard({ instance, layout, schema, state, siblings, index, fresh, onField, onEnabled, onReset, onInstance, loadPresets, onPreset }: {
  instance: Instance; layout: ModuleLayout; schema: ModuleSchema; state: AdvancedState;
  siblings: number; index: number; fresh?: boolean;
  onField: (path: string, value: number, coalesce: boolean) => void;
  onEnabled: (on: boolean) => void; onReset: () => void;
  onInstance: (c: InstanceChoice, name?: string) => void;
  loadPresets: () => Promise<DtPreset[]>; onPreset: (name: string) => void;
}) {
  const edited = instance.hand_edited || state.enabled !== instance.default_enabled;
  // folded unless edited or just added; the user's own fold wins after that
  const [fold, setFold] = useState<boolean | null>(fresh ? true : null);
  const [renaming, setRenaming] = useState(false);
  // Enter or Escape ends the rename once; the blur that follows does not
  const ended = useRef(false);
  const open = fold ?? edited;
  const fields = new Map(schema.fields.map((f) => [f.path, f]));
  const name = instance.label ? `${layout.title} ${instance.label}` : layout.title;
  const done = (el: HTMLInputElement, keep: boolean) => {
    if (ended.current) return;
    ended.current = true;
    setRenaming(false);
    const v = el.value.trim();
    if (keep && v !== (instance.hand_edited ? instance.name : "")) onInstance("rename", v);
  };
  return (
    <div className={`module-card${state.enabled ? "" : " off"}`} data-module={`${instance.op}#${instance.priority}`}>
      <div className="module-card-head" onClick={() => setFold(!open)}>
        <input type="checkbox" className="switch" checked={state.enabled} aria-label={`${name} on or off`}
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
          {layout.fields.map((l) => {
            const f = fields.get(l.path);
            if (!f || (l.showIf && !l.showIf(state.params))) return null;
            const value = state.params[l.path] ?? state.defaults[l.path] ?? 0;
            const neutral = state.defaults[l.path] ?? 0;
            const control = fieldControl(f, l, value);
            const props = { control, value, neutral, values: state.params, disabled: false };
            const set = (coalesce: boolean) => (v: number) => onField(l.path, v, coalesce);
            return control.kind === "toggle" ? <Toggle key={l.path} {...props} onChange={set(false)} />
              : control.kind === "choice" ? <Choice key={l.path} {...props} onChange={set(false)} />
              : <Slider key={l.path} {...props} onChange={set(true)} />;
          })}
        </div>
      </Collapse>
    </div>
  );
}
