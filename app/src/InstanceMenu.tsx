// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an Advanced card's instance menu: darktable's multi-instance actions
// (new, duplicate, rename, move in the pipe, delete), drawn like the module
// switch's menu (ModuleSwitch.tsx)
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";

export type InstanceChoice = "new" | "duplicate" | "rename" | "up" | "down" | "delete";

export function InstanceMenu({ name, oneInstance, first, canUp, canDown, onPick }: {
  name: string; oneInstance: boolean; first: boolean; canUp: boolean; canDown: boolean;
  onPick: (c: InstanceChoice) => void;
}) {
  const { at, close, toggle, box, menu } = useCardMenu();
  const one = oneInstance ? "darktable allows one instance of this module" : undefined;
  const item = (c: InstanceChoice, label: string, why?: string) => (
    <button type="button" role="menuitem" data-instance-action={c} disabled={!!why} title={why}
            onClick={(e) => { e.stopPropagation(); close(); onPick(c); }}>
      <span className="check" /><span className="name">{label}</span>
    </button>
  );
  return (
    <span className="instance-menu" ref={box}>
      <button type="button" className={`module-card-menu${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Instances of ${name}`} title="Instances"
              onClick={(e) => { toggle(e); }}>
        <MoreHorizontal size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" style={{ position: "fixed", left: at.x, top: at.y }}
             onKeyDown={menuKeys}>
          <div className="menu-label">{name}</div>
          {item("new", "New instance", one)}
          {item("duplicate", "Duplicate", one)}
          {item("rename", "Rename…", one)}
          <div className="menu-sep" />
          {item("up", "Move up in the pipe", canUp ? undefined : "already the first of this module's instances")}
          {item("down", "Move down in the pipe", canDown ? undefined : "already the last of this module's instances")}
          <div className="menu-sep" />
          {item("delete", "Delete", first ? "the first instance, which Simple's sliders show, can be switched off but not deleted" : undefined)}
        </div>, document.body)}
    </span>
  );
}
