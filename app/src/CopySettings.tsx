// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Copy Settings: which parts of an edit to copy, by panel and
// section, kept between uses; Paste and Previous apply the same parts
import { useEffect, useState } from "react";
import { panels, type Values } from "./manifest";
import type { Mask } from "./masks";

export type CopyGroup = { id: string; label: string; ids: string[] };

// the Basic, Detail and Effects panels copy by section, as Lightroom's do;
// the point curve goes with the tone curve
const BY_SECTION = new Set(["basic", "detail", "effects"]);
const controlsOf = (id: string) =>
  panels.find((p) => p.id === id)?.sections.flatMap((s) => s.controls.map((c) => c.id)) ?? [];
export const COPY_GROUPS: CopyGroup[] = [
  ...panels.filter((p) => !p.hidden).flatMap((p) => BY_SECTION.has(p.id)
    ? p.sections.filter((s) => s.controls.length)
        .map((s) => ({ id: `${p.id}:${s.title}`, label: s.title, ids: s.controls.map((c) => c.id) }))
    : [{ id: p.id, label: p.title,
         ids: [...controlsOf(p.id), ...(p.id === "tonecurve" ? controlsOf("tonecurve-points") : [])] }]),
  { id: "crop", label: "Crop", ids: controlsOf("crop") },
  { id: "look", label: "Look", ids: [] },
  { id: "masks", label: "Masks", ids: [] },
];
// left out unless asked for, as in Lightroom: they belong to one framing
const OFF_BY_DEFAULT = ["crop", "masks"];

export type Clip = {
  values: Values;
  look?: { name: string | null; path: string | null; amount: number };
  masks?: Mask[];
};

const KEY = "immage.copy.groups";
export const loadCopyGroups = (): Set<string> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(v)) return new Set(v);
  } catch { /* the defaults */ }
  return new Set(COPY_GROUPS.map((g) => g.id).filter((id) => !OFF_BY_DEFAULT.includes(id)));
};
const saveCopyGroups = (on: Set<string>) => {
  try { localStorage.setItem(KEY, JSON.stringify([...on])); } catch { /* not remembered */ }
};

// the chosen parts of an edit
export const makeClip = (on: Set<string>, values: Values, look: Clip["look"], masks: Mask[]): Clip => {
  const clip: Clip = { values: {} };
  for (const g of COPY_GROUPS)
    if (on.has(g.id)) for (const id of g.ids) if (id in values) clip.values[id] = values[id];
  if (on.has("look")) clip.look = look;
  if (on.has("masks")) clip.masks = structuredClone(masks);
  return clip;
};

export function CopyDialog({ onCopy, onClose }: { onCopy: (on: Set<string>) => void; onClose: () => void }) {
  const [on, setOn] = useState(loadCopyGroups);
  const toggle = (id: string) => setOn((old) => {
    const next = new Set(old);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const copy = () => { saveCopyGroups(on); onCopy(on); onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") copy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal copy-settings">
        <div className="modal-head">
          <h2>Copy Settings</h2>
          <div className="segmented small">
            <button onClick={() => setOn(new Set(COPY_GROUPS.map((g) => g.id)))}>Check All</button>
            <button onClick={() => setOn(new Set())}>Check None</button>
          </div>
        </div>
        <div className="modal-body copy-groups">
          {COPY_GROUPS.map((g) => (
            <label key={g.id} className="row check">
              <input type="checkbox" checked={on.has(g.id)} onChange={() => toggle(g.id)} />
              {g.label}
            </label>
          ))}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!on.size} onClick={copy}>Copy</button>
        </div>
      </div>
    </div>
  );
}
