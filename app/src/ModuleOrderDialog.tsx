// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Advanced mode's Module order: the open photo's darktable pipe order, first
// module at the top. Only enabled modules are listed; a drag moves a module
// among them and the full list (disabled modules stay where they are) is what
// the engine is sent. The engine's lo..hi says where a module may go, and the
// engine judges the whole order again on Apply.
import { useEffect, useMemo, useRef, useState } from "react";
import type { OrderModule } from "./commands";
import type { Session } from "./session";
import { LAYOUTS } from "./advancedLayout";
import { fieldText } from "./fieldText";
import { GripIcon, LockIcon } from "./icons";
import { t, formatNumber } from "./i18n";

const keyOf = (m: { op: string; priority: number }) => `${m.op}#${m.priority}`;
const layoutTitle = new Map(LAYOUTS.map((l) => [l.op, l.title]));
const nameOf = (m: OrderModule) => { const title = layoutTitle.get(m.op); return title ? fieldText(title) : m.name; };

// the full list with `m` moved to sit in visible slot `slot` (before the
// slot-th other visible module), after its visible predecessor
function place(full: OrderModule[], m: OrderModule, slot: number): { list: OrderModule[]; index: number } {
  const rest = full.filter((x) => x !== m);
  const vis = rest.filter((x) => x.enabled);
  let index: number;
  if (slot <= 0) index = vis.length ? rest.indexOf(vis[0]) : rest.length;
  else index = rest.indexOf(vis[Math.min(slot, vis.length) - 1]) + 1;
  return { list: [...rest.slice(0, index), m, ...rest.slice(index)], index };
}

export function ModuleOrderDialog({ session, onBeforeApply, onClose }: {
  session: Session;
  onBeforeApply: () => void;      // records the undo step
  onClose: () => void;
}) {
  const [loaded, setLoaded] = useState<OrderModule[] | null>(null);   // the engine's list, with ranges
  const [order, setOrder] = useState<OrderModule[]>([]);               // the working full order
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<{ key: string; y: number; slot: number | null } | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const grabbed = useRef(0);   // pointer offset inside the lifted row

  const load = () => {
    let live = true;
    session.moduleOrder().then((m) => { if (live) { setLoaded(m); setOrder(m); } })
      .catch(() => { if (live) setError(t("dialogs.moduleOrder.loadFailed")); });
    return () => { live = false; };
  };
  useEffect(() => { box.current?.focus(); return load(); }, []);
  useEffect(() => {
    if (!focusKey) return;
    list.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
    setFocusKey(null);
  }, [focusKey, order]);

  const visible = useMemo(() => order.filter((m) => m.enabled), [order]);
  const changed = !!loaded && order.some((m, i) => keyOf(m) !== keyOf(loaded[i]));
  const range = (m: OrderModule) => loaded?.find((x) => keyOf(x) === keyOf(m)) ?? m;
  // the visible slots module m may be dropped in, from the engine's range
  const allowed = (m: OrderModule): number[] => {
    const { lo, hi } = range(m);
    const out: number[] = [];
    const others = visible.filter((x) => x !== m).length;
    for (let s = 0; s <= others; s++) {
      const at = place(order, m, s).index;
      if (at >= lo && at <= hi) out.push(s);
    }
    return out;
  };
  const slotOf = (m: OrderModule) => visible.filter((x) => x !== m && order.indexOf(x) < order.indexOf(m)).length;
  const dragged = drag ? visible.find((m) => keyOf(m) === drag.key) ?? null : null;
  const dragAllowed = useMemo(() => (dragged ? allowed(dragged) : []), [dragged, order, loaded]);

  const line = (s: number) => drag && dragged && drag.slot === s ? <div className="order-drop" aria-hidden="true" /> : null;
  const moveTo = (m: OrderModule, slot: number) => setOrder(place(order, m, slot).list);

  const lockTip = (m: OrderModule) => m.locked === "owner"
    ? t(m.owner === "mask" ? "dialogs.moduleOrder.lockedMask" : m.owner === "look" ? "dialogs.moduleOrder.lockedLook" : "dialogs.moduleOrder.lockedApp")
    : t("dialogs.moduleOrder.lockedPipe");

  const slotAt = (clientY: number, m: OrderModule) => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(".order-row:not(.lifted)") ?? [])]
      .filter((r) => r.dataset.key !== keyOf(m));
    let slot = 0;
    for (const r of rows) { const b = r.getBoundingClientRect(); if (clientY > b.top + b.height / 2) slot++; }
    if (!dragAllowed.length) return null;
    // the nearest slot it may take
    return dragAllowed.reduce((best, s) => Math.abs(s - slot) < Math.abs(best - slot) ? s : best, dragAllowed[0]);
  };

  const apply = async () => {
    if (!changed || busy) return;
    setBusy(true); setError(null);
    onBeforeApply();
    const err = await session.setModuleOrder(order.map((m) => ({ op: m.op, priority: m.priority })));
    if (err === null) { onClose(); return; }
    setError(t("dialogs.moduleOrder.failed"));
    setBusy(false);
    load();
  };
  const reset = async () => {
    setConfirm(false); setBusy(true); setError(null);
    onBeforeApply();
    const err = await session.setModuleOrder("reset");
    if (err === null) { onClose(); return; }
    setError(t("dialogs.moduleOrder.failed"));
    setBusy(false);
    load();
  };

  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.code === "Escape") { e.preventDefault(); if (drag) setDrag(null); else if (confirm) setConfirm(false); else if (!busy) onClose(); }
    }}>
    <div ref={box} tabIndex={-1} className="modal module-order" role="dialog" aria-modal="true" aria-labelledby="module-order-title">
      <div className="modal-head"><h2 id="module-order-title">{t("dialogs.moduleOrder.title")}</h2></div>
      {confirm && <div className="order-confirm" role="alertdialog" aria-label={t("dialogs.moduleOrder.resetAsk")}>
        <p>{t("dialogs.moduleOrder.resetAsk")}</p>
        <button className="btn small" onClick={() => void reset()}>{t("app.action.reset")}</button>
        <button className="btn small" autoFocus onClick={() => setConfirm(false)}>{t("dialogs.moduleOrder.keep")}</button>
      </div>}
      <div className="modal-body">
        <p className="hint">{t("dialogs.moduleOrder.hint")}</p>
        {!loaded
          ? <p className="hint" role={error ? "alert" : "status"}>{error ?? t("dialogs.moduleOrder.loading")}</p>
          : <>
            <div className={`order-list${drag ? " dragging" : ""}`} ref={list} role="list">
              {visible.map((m, i) => {
                const k = keyOf(m), locked = m.locked !== null, isDrag = drag?.key === k;
                const others = visible.filter((x) => x !== dragged);
                const at = dragged && !isDrag ? others.indexOf(m) : -1;   // slot before this row
                const dim = !!dragged && !isDrag && !dragAllowed.includes(at) && !dragAllowed.includes(at + 1);
                return <div key={k} style={{ display: "contents" }}>
                  {at >= 0 && line(at)}
                  <div className={`order-row${locked ? " locked" : ""}${dim ? " dim" : ""}${isDrag ? " ghost" : ""}`} role="listitem" data-key={k}
                       tabIndex={locked ? undefined : 0} title={locked ? lockTip(m) : undefined}
                       aria-label={`${formatNumber(i + 1)}. ${nameOf(m)}${m.label ? ` ${m.label}` : ""}`}
                       onKeyDown={(e) => {
                         if (locked || !e.altKey || (e.code !== "ArrowUp" && e.code !== "ArrowDown")) return;
                         e.preventDefault();
                         const cur = slotOf(m), ok = allowed(m);
                         const next = e.code === "ArrowUp" ? [...ok].reverse().find((s) => s < cur) : ok.find((s) => s > cur);
                         if (next !== undefined) { moveTo(m, next); setFocusKey(k); }
                       }}>
                    <span className="order-num">{formatNumber(i + 1)}</span>
                    <span className="order-grip" aria-hidden="true"
                          onPointerDown={(e) => {
                            if (locked || busy || e.button !== 0) return;
                            e.preventDefault();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            const row = e.currentTarget.parentElement!.getBoundingClientRect();
                            grabbed.current = e.clientY - row.top;
                            setDrag({ key: k, y: e.clientY, slot: slotOf(m) });
                          }}
                          onPointerMove={(e) => {
                            if (!isDrag) return;
                            setDrag({ key: k, y: e.clientY, slot: slotAt(e.clientY, m) });
                          }}
                          onPointerUp={() => { if (isDrag && drag.slot !== null) moveTo(m, drag.slot); setDrag(null); }}
                          onPointerCancel={() => setDrag(null)}>
                      {locked ? <LockIcon /> : <GripIcon />}
                    </span>
                    <span className="order-name">{nameOf(m)}{m.label && <span className="order-inst"> · {m.label}</span>}</span>
                  </div>
                </div>;
              })}
              {line(visible.filter((x) => x !== dragged).length)}
              {dragged && drag && list.current && (() => {
                const box = list.current.getBoundingClientRect();
                const top = drag.y - box.top + list.current.scrollTop - grabbed.current;
                return <div className="order-row lifted order-float" style={{ insetBlockStart: top }} aria-hidden="true">
                  <span className="order-num">{formatNumber(visible.indexOf(dragged) + 1)}</span>
                  <span className="order-grip"><GripIcon /></span>
                  <span className="order-name">{nameOf(dragged)}{dragged.label && <span className="order-inst"> · {dragged.label}</span>}</span>
                </div>;
              })()}
            </div>
            <div className="order-ends"><span>{t("dialogs.moduleOrder.runsLast")}</span></div>
          </>}
        {error && loaded && <p className="order-error" role="alert">{error}</p>}
      </div>
      <div className="modal-foot order-foot">
        <button className="btn" disabled={busy || !loaded} onClick={() => setConfirm(true)}>{t("dialogs.moduleOrder.reset")}</button>
        <span className="order-spacer" />
        <button className="btn" onClick={onClose} disabled={busy}>{t("app.action.cancel")}</button>
        <button className="btn primary" disabled={!changed || busy} onClick={() => void apply()}>{t("dialogs.moduleOrder.apply")}</button>
      </div>
    </div>
  </div>;
}
