// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the levels widget of an Advanced card for rgblevels (the layout's
// `levels`), after rgblevels.c: black, gray and white handles over a grid,
// R, G and B tabs only for independent channels. it draws no histogram, as
// the point curve editors of the cards do not
import { useEffect, useRef, useState } from "react";
import { grayShare, moveHandle, nearestHandle, wheelPosition, type Levels } from "./levels";
import type { AdvancedState } from "./session";

const W = 260, H = 70, TRI = 9;
const CHANNELS = ["R", "G", "B"];
const path = (c: number, k: number) => `levels[${c}][${k}]`;
const HANDLE_FILL = ["#000", "#808080", "#fff"];

export function ModuleLevels({ op, state, disabled, onFields }: {
  op: string; state: AdvancedState; disabled: boolean;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const p = state.params, d = state.defaults;
  // independent channels have R, G and B tabs; linked ones use the first
  const independent = p.autoscale === 1;
  const [tab, setTab] = useState(0);
  useEffect(() => { setTab(0); }, [independent]);   // gui_changed: back to R on a mode change
  const ch = independent ? tab : 0;
  const levels: Levels = [0, 1, 2].map((k) => p[path(ch, k)] ?? d[path(ch, k)] ?? [0, 0.5, 1][k]) as Levels;

  const svg = useRef<SVGSVGElement>(null);
  // what a drag works on: the levels as last sent (the card's state follows
  // a moment later), the handle grabbed and gray's share when it began
  const live = useRef(levels);
  const grab = useRef<{ handle: number; share: number } | null>(null);
  const [hover, setHover] = useState(0);
  const share = useRef(grayShare(levels));
  if (!grab.current) live.current = levels;
  const id = `${op}-levels-${ch}`;

  const send = (l: Levels, coalesce: boolean) => {
    live.current = l;
    onFields(Object.fromEntries(l.map((v, k) => [path(ch, k), v])), coalesce, id);
  };
  const x = (e: { clientX: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  // the wheel needs preventDefault, which React's passive listener cannot do
  const wheel = useRef<(e: WheelEvent) => void>(() => {});
  wheel.current = (e) => {
    if (disabled || grab.current) return;
    e.preventDefault();
    const dy = e.deltaMode === 0 ? e.deltaY / 100 : e.deltaY;
    const speed = e.shiftKey ? 10 : e.ctrlKey ? 0.1 : 1;
    send(moveHandle(live.current, hover, wheelPosition(live.current[hover], dy, speed), share.current), true);
  };
  useEffect(() => {
    const el = svg.current;
    const f = (e: WheelEvent) => wheel.current(e);
    el?.addEventListener("wheel", f, { passive: false });
    return () => el?.removeEventListener("wheel", f);
  }, []);

  return (
    <div className="module-card-curve module-card-levels" data-levels={op}>
      {independent && (
        <div className="segmented small module-card-tabs" role="tablist">
          {CHANNELS.map((label, i) => (
            <button key={label} role="tab" aria-selected={i === ch} className={i === ch ? "active" : ""}
                    data-levels-channel={label} onClick={() => setTab(i)}>{label}</button>
          ))}
        </div>
      )}
      <svg ref={svg} className={`curve levels-area${disabled ? " disabled" : ""}`} viewBox={`0 0 ${W} ${H + TRI}`}
           preserveAspectRatio="none" aria-label={`${op} ${CHANNELS[ch]} levels`}
           onPointerMove={(e) => {
             if (disabled) return;
             if (grab.current) {
               send(moveHandle(live.current, grab.current.handle, x(e), grab.current.share), true);
               return;
             }
             // hovering only: the handle a press would take, and gray's share
             setHover(nearestHandle(levels, x(e)));
             share.current = grayShare(levels);
           }}
           onPointerDown={(e) => {
             if (disabled || e.button !== 0) return;
             const handle = nearestHandle(levels, x(e));
             setHover(handle);
             grab.current = { handle, share: grayShare(levels) };
             live.current = levels;
             svg.current!.setPointerCapture(e.pointerId);
           }}
           onPointerUp={() => {
             if (!grab.current) return;
             grab.current = null;
             send(live.current, false);   // the release ends the undo step
           }}
           onDoubleClick={() => {
             if (disabled) return;
             // double-click puts the channel's black, gray and white back to
             // the module's defaults, and gray's share to the middle
             grab.current = null;
             share.current = 0.5;
             send([0, 1, 2].map((k) => d[path(ch, k)] ?? [0, 0.5, 1][k]) as Levels, false);
           }}>
        <rect x={0} y={0} width={W} height={H} className="levels-bg" />
        {[0.25, 0.5, 0.75].map((g) => <line key={g} x1={g * W} y1={0} x2={g * W} y2={H} className="grid" />)}
        {levels.map((v, k) => (
          <g key={k} className={k === hover ? "levels-on" : undefined}>
            <line x1={v * W} y1={0} x2={v * W} y2={H} className="levels-line" />
            <path d={`M${v * W},${H + 1} l${-TRI / 2},0 l${TRI / 2},${-TRI + 1} l${TRI / 2},${TRI - 1} z`}
                  fill={k === hover ? HANDLE_FILL[k] : "none"} className="levels-handle" />
          </g>
        ))}
      </svg>
    </div>
  );
}
