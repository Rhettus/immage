// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the File/Edit/Photo/View/Help menu bar drawn in the title strip on Windows
// and Linux; macOS uses the system menu
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { keys } from "./keys";
import type { ActionId, Menu, MenuItem } from "./menu";

// path[d] is the highlighted index at depth d (-1: none); an entry with a
// submenu is open when a deeper entry follows it
type Path = number[];

const usable = (it: MenuItem) => it.kind === "item" || it.kind === "submenu";
const shown = (items: MenuItem[]) => items.filter((i) => i.kind !== "role");

function itemsAt(root: MenuItem[], path: Path): MenuItem[] {
  let items = root;
  for (const i of path) {
    const it = items[i];
    if (it?.kind !== "submenu") return [];
    items = shown(it.items);
  }
  return items;
}

function Dropdown({ items, path, depth, setPath, run }: {
  items: MenuItem[]; path: Path; depth: number; setPath: (p: Path) => void; run: (id: ActionId) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);
  // a submenu that would leave the window opens to the left instead
  useLayoutEffect(() => {
    if (depth === 0) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setFlip(r.right > window.innerWidth && r.width < r.left);
  }, [depth]);
  return (
    <div ref={ref} className={`menubar-menu${depth ? " sub" : ""}${flip ? " flip" : ""}`} role="menu">
      {items.map((it, i) => {
        if (it.kind === "separator") return <div key={i} className="menubar-sep" role="separator" />;
        if (it.kind === "role") return null;
        const on = path[depth] === i;
        const here = path.slice(0, depth);
        if (it.kind === "submenu") {
          const open = on && path.length > depth + 1;
          return (
            <div key={i} className="menubar-has-sub">
              <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open}
                className={on ? "on" : ""} data-menu-sub={it.label}
                onPointerEnter={() => setPath(open ? path.slice(0, depth + 2) : [...here, i, -1])}
                onClick={() => setPath([...here, i, -1])}>
                <span>{it.label}</span><span className="menubar-arrow" aria-hidden="true">▸</span>
              </button>
              {open && <Dropdown items={shown(it.items)} path={path} depth={depth + 1} setPath={setPath} run={run} />}
            </div>
          );
        }
        return (
          <button key={i} type="button" role="menuitem" className={on ? "on" : ""} data-menu-item={it.id}
            onPointerEnter={() => setPath([...here, i])} onClick={() => run(it.id)}>
            <span>{it.label}</span>
            {it.shortcut && <span className="menubar-keys">{keys(it.shortcut)}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function MenuBar({ menus, onAction }: { menus: Menu[]; onAction: (id: ActionId) => void }) {
  const [top, setTop] = useState<number | null>(null);
  const [path, setPath] = useState<Path>([]);
  const nav = useRef<HTMLElement>(null);
  const st = useRef({ top, path, menus });
  st.current = { top, path, menus };

  const close = () => { setTop(null); setPath([]); };
  const run = (id: ActionId) => {
    close();
    setTimeout(() => onAction(id), 0); // after closing, so focus is back on the page
  };
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (top === null) return;
    const down = (e: PointerEvent) => {
      if (!nav.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      const { top: t, path: p, menus: ms } = st.current;
      if (t === null) return;
      const root = shown(ms[t].items);
      const level = Math.max(p.length - 1, 0);
      const items = itemsAt(root, p.slice(0, level));
      const cur = p.length ? p[level] : -1;
      const step = (dir: 1 | -1) => {
        const n = items.length;
        for (let k = 1; k <= n; k++) {
          const j = cur < 0 ? (dir > 0 ? k - 1 : n - k) : (cur + dir * k + n * k) % n;
          if (usable(items[j])) return j;
        }
        return -1;
      };
      const at = (j: number) => setPath([...p.slice(0, level), j]);
      const move = (to: number) => { setTop(to); setPath([]); };
      let handled = true;
      switch (e.key) {
        case "ArrowDown": at(step(1)); break;
        case "ArrowUp": at(step(-1)); break;
        case "ArrowRight": {
          const it = items[cur];
          if (it?.kind === "submenu") {
            const sub = shown(it.items);
            setPath([...p.slice(0, level), cur, Math.max(sub.findIndex(usable), 0)]);
          } else move((t + 1) % ms.length);
          break;
        }
        case "ArrowLeft":
          if (p.length > 1) setPath(p.slice(0, -1));
          else move((t - 1 + ms.length) % ms.length);
          break;
        case "Escape":
          if (p.length > 1) setPath(p.slice(0, -1)); else close();
          break;
        case "Enter":
        case " ": {
          const it = items[cur];
          if (it?.kind === "item") runRef.current(it.id);
          else if (it?.kind === "submenu") {
            const sub = shown(it.items);
            setPath([...p.slice(0, level), cur, Math.max(sub.findIndex(usable), 0)]);
          }
          break;
        }
        default: handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
    };
  }, [top !== null]);

  return (
    // a click leaves the focus where it was, so Edit's Undo, Cut, Copy, Paste
    // and Select All still reach the text field being typed in
    <nav className="menubar" role="menubar" ref={nav} onMouseDown={(e) => e.preventDefault()}>
      {menus.map((m, i) => (
        <div key={m.label} className="menubar-slot">
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={top === i}
            className={`menubar-title${top === i ? " open" : ""}`} data-menu={m.label}
            onClick={() => { if (top === i) close(); else { setTop(i); setPath([]); } }}
            onPointerEnter={() => { if (top !== null && top !== i) { setTop(i); setPath([]); } }}>
            {m.label}
          </button>
          {top === i && <Dropdown items={shown(m.items)} path={path} depth={0} setPath={setPath} run={run} />}
        </div>
      ))}
    </nav>
  );
}
