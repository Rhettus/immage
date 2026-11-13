// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// "+ Add module" under an Advanced group's cards: the group's modules in its
// card order. One the photo already shows is checked; one darktable cannot
// apply to this photo (a raw-only module on a JPEG) is greyed out
import { createPortal } from "react-dom";
import { Plus } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";

export type AddChoice = { op: string; title: string; shown: boolean; applicable: boolean };

export function AddModuleMenu({ group, choices, onAdd }: {
  group: string; choices: AddChoice[]; onAdd: (op: string) => void;
}) {
  const { at, close, toggle, box, menu } = useCardMenu();
  return (
    <span className="add-module" ref={box}>
      <button type="button" className={`add-module-button${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Add a module to ${group}`} onClick={(e) => toggle(e, true)}>
        <Plus size={14} strokeWidth={1.8} /> Add module
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" onKeyDown={menuKeys}
             style={{ position: "fixed", left: at.x, top: at.y, maxHeight: "60vh", overflowY: "auto" }}>
          <div className="menu-label">darktable modules</div>
          {choices.map((c) => (
            <button key={c.op} type="button" role="menuitemcheckbox" aria-checked={c.shown} data-add-module={c.op}
                    disabled={c.shown || !c.applicable}
                    title={c.shown ? "already on this photo; the card's ... menu adds another instance"
                      : c.applicable ? undefined : "darktable cannot apply this module to this photo"}
                    onClick={(e) => { e.stopPropagation(); close(); onAdd(c.op); }}>
              <span className="check">{c.shown ? "✓" : ""}</span><span className="name">{c.title}</span>
            </button>
          ))}
        </div>, document.body)}
    </span>
  );
}
