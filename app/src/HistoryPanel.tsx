// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// darktable's history stack: at the bottom the image's darktable history as
// opened (the modules darktable starts every photo with, and edits kept from
// before), above it this session's undo steps, newest at the top. a click
// goes to any step; those above the current one are what Redo brings back.
// compressing folds the steps into the opened stack, as darktable's
// "compress history stack". a row of the opened stack can be switched off
// or deleted, or reset if Immage has sliders for its module (actionOf)
import { useState } from "react";
import { controlById, panels } from "./manifest";
import type { HistoryItem } from "./session";

const HIDE_OFF_KEY = "immage.history.hideOff";

// where each control sits, for naming a step by what it changed
const placeOf = new Map(panels.flatMap((p) => p.sections.flatMap((s) =>
  s.controls.map((c) => [c.id, { panel: p, section: s }] as const))));
// labels used in more than one place (HSL's Red, Color Grading's Hue) are
// named with their section
const labelCount = new Map<string, number>();
for (const c of controlById.values()) labelCount.set(c.label, (labelCount.get(c.label) ?? 0) + 1);

const controlName = (id: string): string => {
  const c = controlById.get(id), at = placeOf.get(id);
  if (!c || !at) return id;
  // the crop's edges, the point curve's points: the tool, not the field
  if (at.panel.hidden) return at.panel.title;
  return (labelCount.get(c.label) ?? 0) > 1 ? `${at.section.title}: ${c.label}` : c.label;
};

const MASK_STEPS: Record<string, string> = {
  create: "New mask", range: "Mask range", delete: "Delete mask", invert: "Invert mask", rename: "Rename mask",
  shapes: "Mask shape", drag: "Mask shape", depth: "Depth range", parametric: "Parametric",
};
const SPOT_STEPS: Record<string, string> = {
  create: "New spot", delete: "Delete spot", drag: "Move spot", edit: "Spot", clear: "Clear spots",
};
const STEPS: Record<string, string> = {
  reset: "Reset all", look: "Look", "look:amount": "Look amount",
  "settings pasted": "Paste settings", "previous settings": "Previous settings",
};

// a step's name from the keys undo records it under: control ids, or
// "mask:…" and "spot:…" for the tools
export function stepName(keys: string[]): string {
  if (keys.length === 1) {
    const k = keys[0];
    if (STEPS[k]) return STEPS[k];
    if (k.startsWith("spot:")) return SPOT_STEPS[k.split(":")[1]] ?? "Spot";
    if (k.startsWith("mask:")) {
      const rest = k.slice(5), kind = rest.split(":")[0];
      if (MASK_STEPS[kind]) return MASK_STEPS[kind];
      // a mask's own setting, "mask:<name>:<id>"; the name may hold a colon
      const cut = rest.lastIndexOf(":");
      const id = rest.slice(cut + 1);
      return `${rest.slice(0, cut)}: ${id === "opacity" ? "Opacity" : controlName(id)}`;
    }
    return controlName(k);
  }
  // several at once (Auto, the white balance picker): what they share
  const at = keys.map((id) => placeOf.get(id));
  if (at.every((a) => a && a.section === at[0]!.section)) return at[0]!.panel.hidden ? at[0]!.panel.title : at[0]!.section.title;
  if (at.every((a) => a && a.panel === at[0]!.panel)) return at[0]!.panel.title;
  return "Settings";
}

export function HistoryPanel({ base, steps, at, onGo, onCompress, disabled, open, onToggle, actionOf, onChange }: {
  base: HistoryItem[];      // the stack the photo opened with, oldest first
  actionOf: (h: HistoryItem) => "toggle" | "reset" | null;
  onChange: (h: HistoryItem, how: "toggle" | "delete" | "reset") => void;
  steps: string[];          // each change since, oldest first
  at: number;               // how many of them are applied
  onGo: (n: number) => void;
  onCompress: () => void;
  disabled: boolean;
  open: boolean;
  onToggle: (alt: boolean) => void;
}) {
  // switched-off modules out of the list; they keep their numbers, so the
  // gaps show where they were
  const [hideOff, setHideOff] = useState(() => {
    try { return localStorage.getItem(HIDE_OFF_KEY) === "1"; } catch { return false; }
  });
  const toggleHideOff = () => setHideOff((h) => {
    try { localStorage.setItem(HIDE_OFF_KEY, h ? "0" : "1"); } catch { /* not kept */ }
    return !h;
  });
  const anyOff = base.some((h) => !h.enabled);
  // the opened stack is one state, the undo stack's first: only its top
  // row goes there
  const rows = [
    { name: "original", note: null, off: false, n: base.length ? null : 0, item: null },
    ...base.map((h, k) => ({ name: h.name, note: h.label, off: !h.enabled, n: k === base.length - 1 ? 0 : null,
                             item: h })),
    ...steps.map((name, k) => ({ name, note: null, off: false, n: k + 1, item: null })),
  ].map((r, num) => ({ ...r, num })).filter((r) => !(hideOff && r.off)).reverse();
  return (
    <div className="panel history" data-tour="history">
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>History</span>
        <button className="compress" disabled={disabled || !steps.length}
                onClick={(e) => { e.stopPropagation(); onCompress(); }}
                title="compress history: one step per module, as darktable keeps it. the steps since the photo opened can no longer be undone">
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22v-6M12 8V2M4 12H2M10 12H8M16 12h-2M22 12h-2M15 19l-3-3-3 3M15 5l-3 3-3-3" />
          </svg>
        </button>
        {anyOff && (
          <button className="eye" onClick={(e) => { e.stopPropagation(); toggleHideOff(); }}
                  title={hideOff ? "show the switched-off modules: they are in the history, but do nothing to the photo"
                    : "hide the switched-off modules: they are in the history, but do nothing to the photo"}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
              {hideOff && <path d="m3 3 18 18" />}
            </svg>
          </button>
        )}
        <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
      </div>
      {open && (
        <ol className="history-list">
          {rows.map(({ name, note, off, n, num, item }) => {
            const action = item && !disabled ? actionOf(item) : null;
            return (
            <li key={num}>
              <button className={`${n === at ? "current" : ""}${n !== null && n > at ? " undone" : ""}`
                                 + `${n === null ? " fixed" : ""}`}
                      disabled={disabled || n === null} onClick={() => n !== null && onGo(n)}
                      title={off ? "switched off" : undefined}>
                <span className="num">{num}</span>
                <span className="name">{name}{note && <span className="note"> • {note}</span>}</span>
                {off && <span className="off">off</span>}
              </button>
              {action && (
                <span className="row-actions">
                  {action === "toggle" ? (
                    <>
                      <button onClick={() => onChange(item!, "toggle")}
                              title={off ? "switch on" : "switch off: it stays in the history, but does nothing to the photo"}>
                        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                             strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />
                        </svg>
                      </button>
                      <button onClick={() => onChange(item!, "delete")}
                              title={item!.default_enabled
                                ? "delete: darktable starts every photo with it, so it goes back to darktable's defaults"
                                : "delete: switched off, and gone from the history once saved"}>
                        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                             strokeLinecap="round" strokeLinejoin="round">
                          <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <button onClick={() => onChange(item!, "reset")}
                            title="reset: its sliders back to where a new photo starts">
                      <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                           strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5" />
                      </svg>
                    </button>
                  )}
                </span>
              )}
            </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
