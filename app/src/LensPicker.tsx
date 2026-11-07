// Lens Corrections' lens: Auto, the lens darktable matched from the file,
// or one of Lensfun's lenses. The list comes from the engine (`lenses`);
// the choice is the control `lens_pick`, 0 for Auto and else the lens's hash.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";

type Lens = { name: string; maker: string; hash: number };
type Menu = { auto: string; pick: number; lenses: Lens[] };

// every word of the query, in any order, in the lens's maker and model:
// "12-32" finds the Panasonic 12-32mm, "pana 12-32" narrows it to Panasonic
export function matchLenses(lenses: Lens[], query: string): Lens[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return lenses;
  return lenses.filter((l) => {
    const hay = `${l.maker} ${l.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export function LensPicker({ value, disabled, photo, onChange }: {
  value: number; disabled: boolean; photo: object | null; onChange: (hash: number) => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  // the list belongs to the open photo (its camera), and a pick elsewhere
  // (undo, a pasted edit) can name a lens it does not hold
  useEffect(() => {
    let live = true;
    invoke<Menu>("lenses").then((m) => { if (live) setMenu(m); }).catch(() => { if (live) setMenu(null); });
    return () => { live = false; };
  }, [photo, value]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { const n = e.target as Node; if (!box.current?.contains(n) && !pop.current?.contains(n)) setOpen(false); };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("pointerdown", away, true); window.removeEventListener("resize", close); };
  }, [open]);

  // drawn on the page, not in the panel, whose scrolling area would clip it:
  // under the button, or above it when the window has no room below
  useLayoutEffect(() => {
    const b = box.current?.querySelector("button");
    if (!open || !b) { setPos(null); return; }
    const r = b.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const flip = below < 240 && above > below;
    const maxHeight = Math.max(160, Math.min(flip ? above : below, 340));
    const width = Math.max(r.width, 260);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width, maxHeight,
             top: flip ? Math.max(8, r.top - 4 - maxHeight) : r.bottom + 4 });
  }, [open]);

  // typing starts at once, once the menu is placed (a hidden input cannot take focus)
  useEffect(() => { if (pos) field.current?.focus(); }, [pos]);

  // Auto leads the list, so the matches are indexed from 1
  const matches = useMemo(() => (menu ? matchLenses(menu.lenses, query) : []), [menu, query]);
  const showAuto = !query.trim();
  const rows: (Lens | null)[] = showAuto ? [null, ...matches] : matches;
  useEffect(() => setActive(0), [query, open]);
  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const chosen = value ? menu?.lenses.find((l) => l.hash === value) : null;
  const label = value ? (chosen?.name ?? "Chosen lens") : menu?.auto ? `Auto: ${menu.auto}` : "Auto";
  const choose = (l: Lens | null) => { setOpen(false); setQuery(""); if ((l?.hash ?? 0) !== value) onChange(l?.hash ?? 0); };

  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); setOpen(false); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter" && rows.length) { e.preventDefault(); choose(rows[active] ?? null); }
  };

  return (
    <div className="choice-row lens-pick" data-control-id="lens_pick" ref={box}>
      <span>Lens</span>
      <div className="lens-field">
        <button type="button" className="field lens-button" disabled={disabled} title={label} aria-haspopup="listbox"
                aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</button>
      </div>
        {open && createPortal(
          <div ref={pop} className="context-menu lens-menu" data-lens-menu
               style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { visibility: "hidden" }}>
            <input ref={field} className="field" placeholder="Search lenses" aria-label="Search lenses" value={query}
                   onChange={(e) => setQuery(e.target.value)} onKeyDown={key} />
            <div className="lens-list" ref={list} role="listbox" style={pos ? { maxHeight: pos.maxHeight - 52 } : undefined}>
              {rows.map((l, i) => (
                <button key={l ? l.hash : "auto"} type="button" role="option" aria-selected={(l?.hash ?? 0) === value}
                        className={`${(l?.hash ?? 0) === value ? "chosen" : ""}${i === active ? " on" : ""}`}
                        onMouseEnter={() => setActive(i)} onClick={() => choose(l)}>
                  {l ? l.name : menu?.auto ? `Auto: ${menu.auto}` : "Auto"}
                </button>
              ))}
              {!rows.length && <div className="menu-label">{menu ? "No lens matches" : "Loading lenses…"}</div>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
