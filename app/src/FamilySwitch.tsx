// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the module switch on an Advanced card whose module shares the card with
// others that do the same job (the tone mappers): drawn like Simple's module
// switch (ModuleSwitch.tsx). Picking another switches this one off and that
// one on; the old one keeps its settings in the history
import { createPortal } from "react-dom";
import { ArrowLeftRight } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";

export type FamilyOption = { op: string; title: string; applicable: boolean };

export function FamilySwitch({ label, current, options, onPick }: {
  label: string; current: string; options: FamilyOption[]; onPick: (op: string) => void;
}) {
  const { at, close, toggle, box, menu } = useCardMenu();
  return (
    <span className="module-switch" ref={box}>
      <button type="button" className={`module-switch-btn${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Switch ${label}`} title={`Switch ${label}`} onClick={(e) => { toggle(e); }}>
        <ArrowLeftRight size={13} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" onKeyDown={menuKeys}
             style={{ position: "fixed", left: at.x, top: at.y }}>
          <div className="menu-label">Module for {label}</div>
          {options.map((o) => (
            <button key={o.op} type="button" role="menuitemradio" aria-checked={o.op === current} data-family-option={o.op}
                    className={o.op === current ? "on" : ""} disabled={!o.applicable}
                    title={o.applicable ? undefined : "darktable cannot apply this module to this photo"}
                    onClick={(e) => { e.stopPropagation(); close(); if (o.op !== current) onPick(o.op); }}>
              <span className="check">{o.op === current ? "✓" : ""}</span><span className="name">{o.title}</span>
            </button>
          ))}
        </div>, document.body)}
    </span>
  );
}
