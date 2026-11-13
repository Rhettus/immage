// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the drop-down menus of Advanced mode (instances, darktable presets, Add
// module): opened under their button, kept on screen, flipped above it when
// there is no room below, and closed by a click elsewhere, a scroll or a resize
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useDismiss } from "./MasksPanel";

export type MenuAt = { x: number; y: number; above: number; left?: boolean };

// `relayout` changes when the menu's content does (a list that loads late)
export function useCardMenu(relayout?: unknown) {
  const [at, setAt] = useState<MenuAt | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const within = useRef({ contains: (n: Node) => !!(box.current?.contains(n) || menu.current?.contains(n)) } as unknown as HTMLElement);
  useDismiss(!!at, () => setAt(null), within);
  useLayoutEffect(() => {
    if (!at || !menu.current) return;
    const { width, height } = menu.current.getBoundingClientRect();
    const gap = 8;
    const top = at.y + height <= window.innerHeight - gap ? at.y : at.above - height - 4;
    // right-aligned to the button, or left-aligned for a wide button
    const x = at.left ? at.x : at.x - width;
    menu.current.style.left = `${Math.max(gap, Math.min(x, window.innerWidth - width - gap))}px`;
    menu.current.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - height - gap))}px`;
  }, [at, relayout]);
  useEffect(() => {
    if (!at) return;
    const away = (e: Event) => { if (!menu.current?.contains(e.target as Node)) setAt(null); };
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", away);
    return () => { window.removeEventListener("scroll", away, true); window.removeEventListener("resize", away); };
  }, [at]);
  // toggles the menu under the button clicked; true when it opened
  const toggle = (e: React.MouseEvent<HTMLElement>, left = false) => {
    e.stopPropagation();
    if (at) { setAt(null); return false; }
    const r = e.currentTarget.getBoundingClientRect();
    setAt({ x: left ? r.left : r.right, y: r.bottom + 4, above: r.top, left });
    return true;
  };
  return { at, close: () => setAt(null), toggle, box, menu };
}

// arrow keys move between a menu's enabled items
export function menuKeys(e: React.KeyboardEvent<HTMLDivElement>) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  const items = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
}
