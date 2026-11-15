// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The 3x3 alignment grid of the Composite and Watermark cards (the layout's
// `align`): nine toggle buttons over the int `alignment`, as overlay.c and
// watermark.c's gui_init lay them out under an "alignment" label. A click
// always selects its button (_alignment_callback leaves one on); the mapping
// is in alignment.ts
import { ALIGNMENTS, alignmentCell } from "./alignment";
import { t } from "./i18n";
import { fieldText } from "./fieldText";

export function ModuleAlign({ label, value, disabled, onChange }: {
  label: string; value: number; disabled: boolean; onChange: (index: number) => void;
}) {
  const on = alignmentCell(value);
  const localized = (i: number) => {
    const cell = alignmentCell(i);
    if (!cell) return t("fields.align.none");
    if (cell.row === 1 && cell.col === 1) return t("fields.align.center");
    const row = (["top", "middle", "bottom"] as const)[cell.row];
    const col = (["left", "center", "right"] as const)[cell.col];
    return t(`fields.align.${row}.${col}`);
  };
  return (
    <div className="choice-row module-align" data-control-id="adv:alignment">
      <span>{fieldText(label)}</span>
      <div className="align-grid" role="radiogroup" aria-label={label}>
        {Array.from({ length: ALIGNMENTS }, (_, i) => {
          const cell = alignmentCell(i)!;
          const active = !!on && on.row === cell.row && on.col === cell.col;
          return (
            <button key={i} type="button" role="radio" aria-checked={active} aria-label={localized(i)} title={localized(i)}
                    className={`align-cell${active ? " active" : ""}`} disabled={disabled} onClick={() => onChange(i)}>
              <svg viewBox="0 0 12 12" width="14" height="14" aria-hidden="true">
                <rect x="0.5" y="0.5" width="11" height="11" rx="1" className="align-frame" />
                <rect x={0.5 + cell.col * 4} y={0.5 + cell.row * 4} width="3" height="3" className="align-dot" />
              </svg>
            </button>
          );
        })}
      </div>
    </div>
  );
}
