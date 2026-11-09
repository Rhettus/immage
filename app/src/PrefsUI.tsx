// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Preferences' building blocks: a titled card of settings, and a row with
// the setting's name and a short explanation on the left, its control on
// the right
export function PrefCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="pref-card">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

// Portal help stays outside the scrolling pane and cannot be clipped by it.
function PrefHelp({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  function close() { clearTimeout(timer.current); setPosition(null); }
  function show() {
    clearTimeout(timer.current);
    const r = button.current?.getBoundingClientRect();
    if (r) setPosition({ left: Math.max(8, Math.min(r.left, window.innerWidth - 336)), top: r.bottom + 6 });
  }
  function leave() {
    timer.current = setTimeout(() => {
      if (document.activeElement !== button.current) setPosition(null);
    }, 150);
  }
  useEffect(() => {
    if (!position) return;
    const r = tip.current?.getBoundingClientRect();
    if (r && r.bottom > window.innerHeight - 8) {
      const anchor = button.current!.getBoundingClientRect();
      setPosition(p => p && ({ ...p, top: Math.max(8, anchor.top - r.height - 6) }));
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
    }
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    // Scroll changes the anchor position, so dismiss stale help.
    function scroll(e: Event) {
      if (!(e.target instanceof Node) || !tip.current?.contains(e.target)) close();
    }
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [!!position]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <button ref={button} type="button" className="pref-help" aria-label={`Help for ${label || "this setting"}`}
            aria-describedby={position ? id : undefined} onMouseEnter={show} onMouseLeave={leave}
            onFocus={show} onBlur={close} onClick={show}>?</button>
    {position && createPortal(<div ref={tip} id={id} role="tooltip" className="pref-help-tip"
      style={position} onMouseEnter={() => clearTimeout(timer.current)} onMouseLeave={leave}>{children}</div>, document.body)}
  </>;
}

export function PrefRow({ label, hint, summary, title, children }: {
  label: string; hint?: ReactNode; summary?: ReactNode; title?: string; children: ReactNode;
}) {
  const help = summary !== undefined ? hint : title;
  return (
    <div className="pref-row" data-pref-label={label}>
      <div className="pref-label">
        <span className="pref-label-heading">{label}{help && <PrefHelp label={label}>{help}</PrefHelp>}</span>
        {(summary ?? hint) && <span className="pref-hint">{summary ?? hint}</span>}
      </div>
      <div className="pref-control">{children}</div>
    </div>
  );
}

// an on/off setting
export function PrefSwitch({ checked, onChange, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return <input type="checkbox" className="switch" checked={checked} disabled={disabled}
                onChange={(e) => onChange(e.target.checked)} />;
}
