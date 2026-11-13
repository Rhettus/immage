// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an Advanced card's presets menu: darktable's own presets for the module, in
// darktable's order (shipped ones, then the user's), loaded when it opens and
// drawn like the instance menu (InstanceMenu.tsx)
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlignLeft } from "lucide-react";
import { useDismiss } from "./MasksPanel";
import type { DtPreset } from "./commands";
import { presetLabel } from "./presetName";

export function PresetMenu({ name, load, onPick }: {
  name: string; load: () => Promise<DtPreset[]>; onPick: (rawName: string) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number; above: number } | null>(null);
  const [list, setList] = useState<DtPreset[] | null>(null);
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
  }, [at, list]);
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setAt(null); };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [at]);
  const close = () => setAt(null);
  const open = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (at) { close(); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setList(null);
    setAt({ x: r.right, y: r.bottom + 4, above: r.top });
    // read each time: a preset saved or applied elsewhere shows as it is now
    load().then(setList, () => setList([]));
  };
  const item = (p: DtPreset) => (
    <button key={p.name} type="button" role="menuitemradio" aria-checked={p.active} data-preset={p.name}
            disabled={!p.applicable} title={p.applicable ? p.description || undefined : "this preset does not apply to this photo"}
            onClick={(e) => { e.stopPropagation(); close(); onPick(p.name); }}>
      <span className="check">{p.active ? "✓" : ""}</span><span className="name">{presetLabel(p.name)}</span>
    </button>
  );
  const builtin = list?.filter((p) => p.builtin) ?? [];
  const own = list?.filter((p) => !p.builtin) ?? [];
  return (
    <span className="preset-menu" ref={box}>
      <button type="button" className={`module-card-menu${at ? " on" : ""}`} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Presets for ${name}`} title="darktable presets" onClick={open}>
        <AlignLeft size={14} strokeWidth={1.8} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu"
             style={{ position: "fixed", left: at.x, top: at.y, maxHeight: "60vh", overflowY: "auto" }}
             onKeyDown={(e) => {
               if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
               e.preventDefault();
               const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
               const i = items.indexOf(document.activeElement as HTMLButtonElement);
               items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
             }}>
          <div className="menu-label">darktable presets</div>
          {list && list.length === 0 && <button type="button" role="menuitem" disabled><span className="check" /><span className="name">No presets</span></button>}
          {builtin.map(item)}
          {builtin.length > 0 && own.length > 0 && <div className="menu-sep" />}
          {own.map(item)}
        </div>, document.body)}
    </span>
  );
}
