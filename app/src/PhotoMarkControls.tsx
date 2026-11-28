// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { Flag, Palette, Tags } from "lucide-react";
import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { menuKeys, useCardMenu } from "./cardMenu";
import { BanIcon, StarIcon } from "./icons";
import { t } from "./i18n";
import { LABEL_COLORS } from "./library";
import { MARK_STARS, type MarkState, type MarkSummary, type PhotoMark } from "./photoMarks";

const labelNames = ["red", "yellow", "green", "blue", "purple"] as const;
const markClass = (state: MarkState) => state === "mixed" ? " mixed" : state ? " on" : "";

function keepButtonFocus(e: MouseEvent) {
  if (e.button === 0 && (e.target as Element).closest("button")) e.preventDefault();
}

function keepButtonSpace(e: KeyboardEvent) {
  if (e.code === "Space") e.stopPropagation();
}

type ControlsProps = { summary: MarkSummary; onMark: (mark: PhotoMark) => void };

function StarButtons({ summary, onMark }: ControlsProps) {
  return MARK_STARS.map((n, k) => {
    const { exact, fill } = summary.stars[k];
    const label = t("library.filmstrip.stars", { count: n });
    return <button key={n} type="button" className={`tool mark-star${markClass(fill)}${exact === "mixed" && fill !== "mixed" ? " mixed" : ""}`}
                   title={label} aria-label={label} aria-pressed={exact} disabled={summary.disabled}
                   onClick={() => onMark({ type: "rating", value: n })}><StarIcon filled={fill === true} /></button>;
  });
}

function LabelButtons({ summary, onMark }: ControlsProps) {
  return LABEL_COLORS.map((color, k) => {
    const label = t(`library.menu.label-${labelNames[k]}`);
    return <button key={color} type="button" className={`swatch${markClass(summary.labels[k])}`} style={{ background: color }}
                   title={label} aria-label={label} aria-pressed={summary.labels[k]} disabled={summary.disabled}
                   onClick={() => onMark({ type: "label", value: 1 << k })} />;
  });
}

function FlagButtons({ summary, onMark }: ControlsProps) {
  const pick = t("library.menu.pick");
  const reject = t("library.filmstrip.reject");
  return <>
    <button type="button" className={`tool mark-pick${markClass(summary.picked)}`} title={pick} aria-label={pick}
            aria-pressed={summary.picked} disabled={summary.disabled} onClick={() => onMark({ type: "pick" })}>
      <Flag fill={summary.picked === true ? "currentColor" : "none"} />
    </button>
    <button type="button" className={`tool thumb-reject reject${markClass(summary.rejected)}`} title={reject} aria-label={reject}
            aria-pressed={summary.rejected} disabled={summary.disabled} onClick={() => onMark({ type: "reject" })}><BanIcon /></button>
  </>;
}

export function MarkSelection(props: ControlsProps) {
  return <div className="tool-group mark-selection" role="group" aria-label={t("library.marks.selection")} data-mark-controls
              onMouseDown={keepButtonFocus} onKeyDown={keepButtonSpace}>
    <span className="mark-selection-label">{t("library.marks.action")}</span>
    <StarButtons {...props} />
    <span className="sep" />
    <LabelButtons {...props} />
    <span className="sep" />
    <FlagButtons {...props} />
  </div>;
}

function MarkMenu({ summary, onMark, compact }: ControlsProps & { compact: boolean }) {
  const { at, close, toggle, box, menu } = useCardMenu(undefined, false);
  const trigger = useRef<HTMLButtonElement>(null);
  const label = t(compact ? "library.marks.photo" : "library.marks.colors");
  const dismiss = () => { close(); trigger.current?.focus({ preventScroll: true }); };
  const apply = (mark: PhotoMark) => { dismiss(); onMark(mark); };
  useLayoutEffect(() => {
    if (at) menu.current?.querySelector("button")?.focus({ preventScroll: true });
  }, [at, menu]);
  const colored = summary.labels.some(Boolean);
  return <span className="thumb-mark-menu" ref={box}>
    <button ref={trigger} type="button" className={`tool mark-menu-trigger${colored ? " on" : ""}`}
            aria-label={label} title={label} aria-haspopup="dialog" aria-expanded={!!at}
            onClick={(e) => toggle(e, true)}>{compact ? <Tags /> : <Palette />}</button>
    {at && createPortal(
      <div ref={menu} className="context-menu photo-mark-menu" role="dialog" aria-label={label} data-mark-controls
           style={{ position: "fixed", left: at.x, top: at.y }}
           onBlur={(e) => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) close(); }}
           onKeyDown={(e) => {
             if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); dismiss(); }
             else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
               e.preventDefault();
               e.stopPropagation();
               const buttons = [...e.currentTarget.querySelectorAll("button")];
               const step = (e.key === "ArrowRight") === (getComputedStyle(e.currentTarget).direction === "ltr") ? 1 : -1;
               const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
               buttons[(index + step + buttons.length) % buttons.length]?.focus();
             } else menuKeys(e);
           }}>
        {compact && <div className="tool-group"><StarButtons summary={summary} onMark={apply} /><FlagButtons summary={summary} onMark={apply} /></div>}
        <div className="tool-group"><LabelButtons summary={summary} onMark={apply} /></div>
      </div>, document.body)}
  </span>;
}

export function ThumbnailMarks({ compact, ...props }: ControlsProps & { compact: boolean }) {
  const { summary } = props;
  return <div className={`thumb-marks${compact ? " compact" : ""}`} data-mark-controls
              onMouseDown={keepButtonFocus} onKeyDown={keepButtonSpace}>
    {compact ? <span className="thumb-mark-status">
      {summary.stars.some(({ fill }) => fill) && <span className="thumb-mark-rating">
        {summary.stars.map(({ fill }, k) => fill && <span key={k} className={markClass(fill).trim()}>★</span>)}
      </span>}
      {summary.picked && <span className={`mark-pick${markClass(summary.picked)}`} title={t("library.menu.pick")}><Flag /></span>}
      {summary.rejected && <span className={`thumb-reject${markClass(summary.rejected)}`} title={t("library.filmstrip.reject")}><BanIcon /></span>}
    </span> : <>
      <span className="thumb-stars"><StarButtons {...props} /></span>
      <FlagButtons {...props} />
    </>}
    <span className="labels">
      {LABEL_COLORS.map((color, k) => summary.labels[k] && <span key={color} className={`dot${markClass(summary.labels[k])}`}
        title={t(`library.menu.label-${labelNames[k]}`)} style={{ background: color }} />)}
    </span>
    <MarkMenu {...props} compact={compact} />
  </div>;
}
