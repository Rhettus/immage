// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Merge to HDR's dialog, as Lightroom's HDR Merge asks: whether to align
// the brackets, before darktable's HDR merge writes the DNG (App.tsx,
// runHdrMerge). alignment needs an engine built with OpenCV (hdr_can_align)
import { useEffect, useState } from "react";
import { commands } from "./commands";
import { settings } from "./settings";
import { t } from "./i18n";

const ALIGN_KEY = "immage.hdrAlign";
function loadAlign(): boolean {
  try { return settings.get(ALIGN_KEY) !== "false"; } catch { return true; }
}

export function HdrDialog({ count, onRun, onClose }: {
  count: number;
  onRun: (align: boolean) => void;
  onClose: () => void;
}) {
  const [align, setAlign] = useState(loadAlign);
  // null until the engine answers
  const [canAlign, setCanAlign] = useState<boolean | null>(null);
  useEffect(() => { commands.hdrCanAlign().then(setCanAlign).catch(() => setCanAlign(false)); }, []);
  const run = () => {
    try { settings.set(ALIGN_KEY, String(align)); } catch { /* not kept */ }
    onClose();
    onRun(align && !!canAlign);
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal hdr-merge">
        <div className="modal-head"><h2>{t("dialogs.hdr.title")}</h2></div>
        <div className="modal-body">
          <label className="row check" title={canAlign === false ? t("dialogs.hdr.cannotAlign") : undefined}>
            <input type="checkbox" checked={align && canAlign !== false} disabled={!canAlign}
                   onChange={(e) => setAlign(e.target.checked)} />
            {t("dialogs.hdr.autoAlign")}
          </label>
          <p className="note-plain">
            {t("dialogs.hdr.description", { count })}
          </p>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
          <button className="btn primary" autoFocus onClick={run}>{t("dialogs.common.merge")}</button>
        </div>
      </div>
    </div>
  );
}
