// Replaces the system popup of every <select> with a menu drawn like the
// right-click menu, so dropdowns look the same on macOS, Windows and Linux.
// The <select> stays the source of truth: choosing writes its value and fires
// "change", so handlers, tests and data-* hooks keep working unchanged.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Item = { kind: "group"; label: string } | { kind: "option"; label: string; value: string; disabled: boolean };

// popups that close on any pointerdown outside themselves: the menu must live inside
const HOSTS = ".filter-pop, .icon-picker, .modal, .context-menu";

function itemsOf(sel: HTMLSelectElement): Item[] {
  const out: Item[] = [];
  const add = (o: HTMLOptionElement) => {
    if (!o.hidden) out.push({ kind: "option", label: o.text, value: o.value, disabled: o.disabled });
  };
  for (const c of Array.from(sel.children)) {
    if (c instanceof HTMLOptGroupElement) {
      out.push({ kind: "group", label: c.label });
      for (const o of Array.from(c.children)) if (o instanceof HTMLOptionElement) add(o);
    } else if (c instanceof HTMLOptionElement) add(c);
  }
  return out;
}

const usable = (t: EventTarget | null): HTMLSelectElement | null => {
  const s = (t as Element | null)?.closest?.("select") as HTMLSelectElement | null;
  return s && !s.disabled && !s.multiple && s.size <= 1 ? s : null;
};

export default function SelectMenu() {
  const [sel, setSel] = useState<HTMLSelectElement | null>(null);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const state = useRef({ sel, active });
  state.current = { sel, active };

  const close = () => setSel(null);
  const choose = (s: HTMLSelectElement, value: string) => {
    setSel(null);
    if (s.value !== value) {
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    }
    s.focus();
  };

  useEffect(() => {
    const open = (s: HTMLSelectElement) => {
      const its = itemsOf(s);
      setActive(its.findIndex((i) => i.kind === "option" && i.value === s.value));
      setSel(s);
    };
    const down = (e: MouseEvent) => {
      const s = usable(e.target);
      if (!s || e.button !== 0) return;
      e.preventDefault(); // keeps the system popup from opening
      s.focus();
      if (state.current.sel === s) setSel(null);
      else open(s);
    };
    const away = (e: PointerEvent) => {
      if (state.current.sel && !box.current?.contains(e.target as Node) && !usable(e.target)) setSel(null);
    };
    const key = (e: KeyboardEvent) => {
      const { sel: cur, active: act } = state.current;
      if (!cur) {
        const s = usable(e.target);
        if (s && (e.key === " " || e.key === "Enter" || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) || e.key === "F4")) {
          e.preventDefault();
          open(s);
        }
        return;
      }
      const its = itemsOf(cur);
      const step = (d: number) => {
        let i = act;
        do i += d; while (i >= 0 && i < its.length && (its[i].kind !== "option" || (its[i] as { disabled: boolean }).disabled));
        if (i >= 0 && i < its.length) setActive(i);
      };
      const swallow = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (e.key === "Escape") { swallow(); close(); cur.focus(); }
      else if (e.key === "ArrowDown") { swallow(); step(1); }
      else if (e.key === "ArrowUp") { swallow(); step(-1); }
      else if (e.key === "Home") { swallow(); setActive(its.findIndex((i) => i.kind === "option")); }
      else if (e.key === "End") { swallow(); setActive(its.length - 1 - [...its].reverse().findIndex((i) => i.kind === "option")); }
      else if (e.key === "Enter" || e.key === " ") {
        swallow();
        const it = its[act];
        if (it?.kind === "option" && !it.disabled) choose(cur, it.value);
      } else if (e.key === "Tab") close();
    };
    const wheel = (e: Event) => { if (state.current.sel && !box.current?.contains(e.target as Node)) setSel(null); };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("wheel", wheel, { capture: true, passive: true });
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("wheel", wheel, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  // under the select, or above it when the window has no room below
  useLayoutEffect(() => {
    if (!sel || !box.current) { setPos(null); return; }
    const r = sel.getBoundingClientRect();
    const h = Math.min(box.current.scrollHeight, window.innerHeight - 16);
    const below = window.innerHeight - r.bottom - 8;
    const flip = below < h && r.top > below;
    const maxHeight = Math.max(120, flip ? r.top - 8 : below);
    const top = flip ? Math.max(8, r.top - 4 - Math.min(h, maxHeight)) : r.bottom + 4;
    const width = Math.max(r.width, 140);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top, width, maxHeight });
  }, [sel]);

  useEffect(() => {
    if (pos) box.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [pos, active]);

  if (!sel) return null;
  const items = itemsOf(sel);
  const host = (sel.closest(HOSTS) as HTMLElement | null) ?? document.body;
  return createPortal(
    <div ref={box} className="context-menu select-menu" role="listbox"
         style={pos ? { left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight } : { visibility: "hidden" }}>
      {items.map((it, i) => it.kind === "group"
        ? <div key={i} className="menu-label">{it.label}</div>
        : (
          <button key={i} type="button" role="option" aria-selected={it.value === sel.value}
                  className={`${it.value === sel.value ? "chosen" : ""}${i === active ? " on" : ""}`}
                  disabled={it.disabled}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(sel, it.value)}>
            {it.label || " "}
          </button>
        ))}
    </div>,
    host,
  );
}
