// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the foot of the Negative and Film Simulation panels, below the sections
// that scroll: the format Export to Library writes (the Generated positive
// format preference), the export itself, and turning the conversion off
import type { NegativeExportFormat } from "./Preferences";
import { t } from "./i18n";

export function PositiveFooter({ format, onFormat, onExport, exporting, onTurnOff, turnOffLabel, turnOffTitle,
                                 disabled }: {
  format: NegativeExportFormat; onFormat: (f: NegativeExportFormat) => void;
  onExport: () => void; exporting: boolean;
  onTurnOff: () => void; turnOffLabel: string; turnOffTitle: string;
  disabled: boolean;
}) {
  return (
    <div className="positive-foot">
      <div className="positive-row">
        <div className="segmented small" role="group" aria-label={t("fields.positive.format")}>
          {(["dng", "tiff"] as const).map((f) => (
            <button key={f} className={format === f ? "active" : ""} disabled={disabled || exporting}
                    title={t(f === "dng" ? "fields.positive.dngHint" : "fields.positive.tiffHint")}
                    onClick={() => onFormat(f)}>{f.toUpperCase()}</button>
          ))}
        </div>
        <button className="btn small" disabled={disabled || exporting} onClick={onExport}
                title={t("fields.positive.exportHint", { format: format === "dng" ? "DNG" : "TIFF" })}>
          {exporting ? t("fields.positive.exporting") : t("fields.positive.export")}
        </button>
      </div>
      <button className="btn small" disabled={disabled} onClick={onTurnOff} title={turnOffTitle}>{turnOffLabel}</button>
    </div>
  );
}
