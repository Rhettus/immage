// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an Advanced card's instance menu: darktable's multi-instance actions
// (new, duplicate, rename, move in the pipe, delete), drawn like the module
// switch's menu (ModuleSwitch.tsx)
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useDismiss } from "./MasksPanel";

export type InstanceChoice = "new" | "duplicate" | "rename" | "up" | "down" | "delete";

export function InstanceMenu({ name, oneInstance, first, canUp, canDown, onPick }: {
  name: string; oneInstance: boolean; first: boolean; canUp: boolean; canDown: boolean;
  onPick: (c: InstanceChoice) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number; above: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const within = useRef({ contains: (n: Node) => !!(box.current?.contains(n) || menu.current?.contains(n)) } as unknown as HTMLElement);
  useDismiss(!!at, () => setAt(null), within);
  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    const gap = 8;
    const top = at.y + height <= window.innerHeight - gap ? at.y : at.above - height - 4;
    menu.current.style.left = `${Math.max(gap, Math.min(at.x - width, window.innerWidth - width - gap))}px`;
    menu.current.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - height - gap))}px`;
  }, [at]);
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setAt(null); };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [at]);
  const close = () => setAt(null);
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
              onClick={(e) => {
                e.stopPropagation();
                if (at) { close(); return; }
                const r = e.currentTarget.getBoundingClientRect();
                setAt({ x: r.right, y: r.bottom + 4, above: r.top });
              }}>
        <MoreHorizontal size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" style={{ position: "fixed", left: at.x, top: at.y }}
             onKeyDown={(e) => {
               if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
               e.preventDefault();
               const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
               const i = items.indexOf(document.activeElement as HTMLButtonElement);
               items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
             }}>
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
