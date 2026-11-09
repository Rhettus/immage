// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the small icon beside a tool's name that opens a menu of the darktable
// modules it can run on (manifest.ts, MODULE_CHOICES), as Preferences'
// Modules tab lists them. Picking one changes the module for this photo (or
// mask); "Set as default" also stores it as the Preferences choice
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeftRight } from "lucide-react";
import { useDismiss } from "./MasksPanel";
import { loadModuleChoice, storeModuleChoice, storeModuleMode } from "./moduleChoice";
import type { ModuleChoice } from "./manifest";

export type ModuleScope = "global" | "masks";

export function ModuleSwitch({ choice, value, scope, disabled, adjusted = [], onPick }: {
  choice: ModuleChoice; value: number; scope: ModuleScope; disabled?: boolean; adjusted?: number[]; onPick: (value: number) => void;
}) {
  const [at, setAt] = useState<{ x: number; y: number; above: number } | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // the menu is drawn on the page, outside the scrolling panel, so a press in it is not "away"
  const within = useRef({ contains: (n: Node) => !!(box.current?.contains(n) || menu.current?.contains(n)) } as unknown as HTMLElement);
  useDismiss(!!at, () => setAt(null), within);
  // Measure the actual menu, including scaled fonts, before its first paint.
  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    const gap = 8;
    const top = at.y + height <= window.innerHeight - gap ? at.y : at.above - height - 4;
    menu.current.style.left = `${Math.max(gap, Math.min(at.x, window.innerWidth - width - gap))}px`;
    menu.current.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - height - gap))}px`;
  }, [at]);
  // the menu stays where it opened: scrolling the panel under it closes it
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setAt(null); };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [at]);
  const current = choice.options.find((o) => o.value === value) ?? choice.options[0];
  // what Preferences holds for this tool now; Set as default is moot once it is the pick
  const isDefault = loadModuleChoice(choice.id, scope) === current.value;
  // the dot on the icon: some module other than the shown one holds adjustments
  const otherNames = choice.options.filter((o) => adjusted.includes(o.value) && o.value !== value).map((o) => o.name);
  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setAt({ x: r.left, y: r.bottom + 4, above: r.top });
  };
  const close = () => setAt(null);
  return (
    <span className="module-switch" ref={box}>
      <button type="button" className={`module-switch-btn${at ? " on" : ""}${otherNames.length ? " others" : ""}`} disabled={disabled}
              data-module-switch={choice.id} aria-haspopup="menu" aria-expanded={!!at}
              aria-label={`Module for ${choice.label}`} title={`Module: ${current.name}${otherNames.length ? `. Also adjusted in: ${otherNames.join(", ")}` : ""}`}
              onClick={(e) => { e.stopPropagation(); if (at) close(); else open(e.currentTarget); }}
              onDoubleClick={(e) => e.stopPropagation()}>
        <ArrowLeftRight size={11} strokeWidth={2} />
      </button>
      {at && createPortal(
        <div ref={menu} className="context-menu module-menu" role="menu" style={{ position: "fixed", left: at.x, top: at.y }}
             onKeyDown={(e) => {
               if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
               e.preventDefault();
               const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
               const i = items.indexOf(document.activeElement as HTMLButtonElement);
               items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
             }}>
          <div className="menu-label">Module for {choice.label}</div>
          {choice.options.map((o) => (
            <button key={o.value} type="button" role="menuitemradio" aria-checked={o.value === current.value}
                    className={o.value === current.value ? "on" : ""} data-module-option={o.value}
                    autoFocus={o.value === current.value}
                    onClick={(e) => { e.stopPropagation(); close(); if (o.value !== current.value) onPick(o.value); }}>
              <span className="check">{o.value === current.value ? "✓" : ""}</span>
              <span className="name">{o.name}</span>
              {o.preferred && <span className="tag">preferred</span>}
              {adjusted.includes(o.value) && <span className="adjusted-dot" title="has adjustments" />}
            </button>
          ))}
          <div className="menu-sep" />
          <button type="button" role="menuitem" data-module-default disabled={isDefault}
                  title={isDefault ? "already the default" : `use ${current.name} for ${choice.label} on photos that have not used it yet`}
                  onClick={(e) => {
                    e.stopPropagation(); close();
                    storeModuleMode("custom");
                    storeModuleChoice(choice.id, current.value, scope);
                  }}>
            <span className="check" /><span className="name">Set as default</span>
          </button>
        </div>, document.body)}
    </span>
  );
}
