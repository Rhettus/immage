// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a thumbnail dragged onto a folder of the Folders panel, to move the photos
// there (⌥/Alt held at the drop copies them). drawn with pointer events, not
// HTML drag and drop: the window's own file drop (App.tsx, onDragDropEvent)
// takes HTML drags on WebKitGTK and Windows. a folder row takes a drop by
// its data-folder-path; one marked data-folder-refuse does not
import { useEffect, useState } from "react";

export type PhotoDrag = {
  count: number;
  over: string | null;      // the folder under the pointer, when it takes the drop
  copy: boolean;
  from: string[];           // the dragged photos' folders
};

let drag: PhotoDrag | null = null;
const listeners = new Set<() => void>();
const set = (d: PhotoDrag | null) => {
  drag = d;
  listeners.forEach((l) => l());
};

export function usePhotoDrag(): PhotoDrag | null {
  const [shown, setShown] = useState(drag);
  useEffect(() => {
    const l = () => setShown(drag);
    listeners.add(l);
    l();
    return () => { listeners.delete(l); };
  }, []);
  return shown;
}

// how far the pointer goes before a press is a drag, CSS pixels
const SLOP = 6;

export type DragStart = {
  count: () => number;          // asked when the drag begins: the photos it takes
  from: () => string[];
  drop: (folder: string, copy: boolean) => void;
};

// from a cell's pointer down: becomes a drag once the pointer has moved, and
// swallows the click that would otherwise follow its release
export function pressPhoto(e: React.PointerEvent<HTMLElement>, start: DragStart) {
  if (e.button !== 0 || e.pointerType === "touch") return;
  const cell = e.currentTarget;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLDivElement | null = null;
  let copy = e.altKey;
  const target = (x: number, y: number) => {
    const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-folder-path]");
    return row && !row.dataset.folderRefuse ? row.dataset.folderPath! : null;
  };
  const begin = () => {
    const count = start.count();
    if (!count) return false;
    ghost = document.createElement("div");
    ghost.className = "photo-drag";
    const src = cell.querySelector("canvas");
    if (src && src.width && src.height) {
      const k = Math.min(1, 96 / Math.max(src.width, src.height));
      const c = document.createElement("canvas");
      c.width = Math.round(src.width * k);
      c.height = Math.round(src.height * k);
      c.getContext("2d")?.drawImage(src, 0, 0, c.width, c.height);
      ghost.appendChild(c);
    }
    const badge = document.createElement("span");
    badge.className = "count";
    badge.textContent = String(count);
    ghost.appendChild(badge);
    document.body.appendChild(ghost);
    document.body.classList.add("dragging-photos");
    set({ count, over: null, copy, from: start.from() });
    return true;
  };
  const place = (ev: PointerEvent) => {
    copy = ev.altKey;
    ghost!.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
    ghost!.classList.toggle("copy", copy);
    const over = target(ev.clientX, ev.clientY);
    if (drag && (drag.over !== over || drag.copy !== copy)) set({ ...drag, over, copy });
  };
  const end = () => {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
    ghost?.remove();
    document.body.classList.remove("dragging-photos");
    if (ghost) {
      // the release's click lands on whatever is under it: not a pick
      const swallow = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
      window.addEventListener("click", swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    }
    set(null);
  };
  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < SLOP) return;
      if (!begin()) { end(); return; }
    }
    place(ev);
  };
  const up = (ev: PointerEvent) => {
    const over = ghost ? target(ev.clientX, ev.clientY) : null;
    const alt = ev.altKey;
    end();
    if (over) start.drop(over, alt);
  };
  const cancel = () => end();
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && ghost) { ev.stopPropagation(); ev.preventDefault(); end(); }
    else if (ev.key === "Alt" && ghost && drag) set({ ...drag, copy: true });
  };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
}
