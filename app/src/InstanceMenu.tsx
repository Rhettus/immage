// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an Advanced card's instance menu: darktable's multi-instance actions
// (new, duplicate, rename, move in the pipe, delete), drawn like the module
// switch's menu (ModuleSwitch.tsx)
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { menuKeys, useCardMenu } from "./cardMenu";
import { t } from "./i18n";

export type InstanceChoice = "new" | "duplicate" | "rename" | "up" | "down" | "delete" | "remove" | "reset";

export function InstanceMenu({ name, oneInstance, first, canUp, canDown, maskOwned = false, onPick }: {
  name: string; oneInstance: boolean; first: boolean; canUp: boolean; canDown: boolean;
  maskOwned?: boolean;
  onPick: (c: InstanceChoice) => void;
}) {
  const { at, close, toggle, box, menu } = useCardMenu();
  const one = oneInstance ? t("fields.instance.oneOnly") : undefined;
  const item = (c: InstanceChoice, label: string, why?: string) => (
    <button type="button" role="menuitem" data-instance-action={c} disabled={!!why} title={why}
            onClick={(e) => { e.stopPropagation(); close(); onPick(c); }}>
      <span className="check" /><span className="name">{label}</span>
    </button>
  );
  return (
    <span className="instance-menu" ref={box}>
      <button type="button" className={`module-card-menu${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={t("fields.instance.instancesOf", { name })} title={t("fields.instance.instances")}
              onClick={(e) => { toggle(e); }}>
        <MoreHorizontal size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" style={{ position: "fixed", left: at.x, top: at.y }}
             onKeyDown={menuKeys}>
          <div className="menu-label">{name}</div>
          {maskOwned ? <>
            {item("reset", t("fields.instance.reset"))}
            {item("remove", t("fields.instance.removeMask"))}
          </> : <>
            {item("new", t("fields.instance.new"), one)}
            {item("duplicate", t("fields.instance.duplicate"), one)}
            {item("rename", t("fields.instance.rename"), one)}
            <div className="menu-sep" />
            {item("up", t("fields.instance.moveUp"), canUp ? undefined : t("fields.instance.first"))}
            {item("down", t("fields.instance.moveDown"), canDown ? undefined : t("fields.instance.last"))}
            <div className="menu-sep" />
            {item("delete", t("fields.instance.delete"), first ? t("fields.instance.cannotDeleteFirst") : undefined)}
          </>}
        </div>, document.body)}
    </span>
  );
}
