// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";

// the panels showing their advanced controls, kept between sessions
const KEY = "immage.advanced.on";
function load(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]")); } catch { return new Set(); }
}

// read again before writing: every panel keeps its own copy
export function useAdvanced(key: string): [boolean, () => void] {
  const [on, setOn] = useState(() => load().has(key));
  const toggle = () => {
    const set = load();
    const next = !set.delete(key);
    if (next) set.add(key);
    try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* not kept */ }
    setOn(next);
  };
  return [on, toggle];
}

// a dot while the hidden advanced settings are off neutral
export function AdvancedToggle({ on, edited, onToggle, disabled }: { on: boolean; edited?: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button type="button" className={`advanced-toggle${on ? " on" : ""}`} data-advanced-toggle aria-pressed={on}
            disabled={disabled} title={on ? "hide advanced settings" : "show advanced settings"}
            onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <SlidersHorizontal size={14} strokeWidth={2} />
      {edited && !on && <i className="advanced-dot" />}
    </button>
  );
}

export function advancedEdited(ids: string[], values: Record<string, number>, neutral: Record<string, number>): boolean {
  return ids.some((id) => {
    const v = values[id], n = neutral[id];
    return v !== undefined && n !== undefined && Math.abs(v - n) > 1e-6;
  });
}
