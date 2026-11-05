// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a panel's fold: its chevron, and its body easing open and shut
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export const Chevron = ({ open }: { open: boolean }) => (
  <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
);

// a body that eases open and shut. it stays mounted only while open or
// closing, so a shut panel's widgets cost nothing
export function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      // one frame shut first, so the opening has a start to ease from
      let r = requestAnimationFrame(() => { r = requestAnimationFrame(() => setExpanded(true)); });
      return () => cancelAnimationFrame(r);
    }
    setExpanded(false);
    const t = window.setTimeout(() => setMounted(false), 240);
    return () => window.clearTimeout(t);
  }, [open]);
  // WebKitGTK leaves a scrolled list past its end when a fold shrinks it:
  // the top of a panel then sits out of reach with blank space below, and
  // the wheel cannot bring it back. put the list's offset back in range
  const box = useRef<HTMLDivElement>(null);
  const clamp = () => {
    for (let p = box.current?.parentElement; p; p = p.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(p).overflowY)) continue;
      const max = Math.max(0, p.scrollHeight - p.clientHeight);
      if (p.scrollTop > max) p.scrollTop = max;
      return;
    }
  };
  useLayoutEffect(clamp, [mounted]);
  return (
    <div ref={box} className={`collapse${expanded ? " open" : ""}`}
         onTransitionEnd={(e) => { if (e.target === e.currentTarget) clamp(); }}>
      <div>{mounted && children}</div>
    </div>
  );
}
