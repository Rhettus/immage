// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { bytesText } from "./background";
import type { FolderConflict, FolderMovePlan } from "./commands";
import { formatNumber, t } from "./i18n";

export function FolderMoveDialog({ plan, error, copy: copyAsked, onClose, onConfirm }: {
  plan: FolderMovePlan | null;
  error: string | null;
  copy: boolean;
  onClose: () => void;
  onConfirm: (copy: boolean, overwrite: FolderConflict[]) => void;
}) {
  const [copy, setCopy] = useState(copyAsked);
  const [overwrite, setOverwrite] = useState(new Set<string>());
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  const selected = plan?.conflicts.filter((f) => overwrite.has(f.path)) ?? [];
  const bytes = plan ? plan.bytes + selected.reduce((total, f) => total + f.bytes, 0) : 0;
  const instant = plan?.instant && !copy;
  const low = !instant && plan?.free != null && plan.free < bytes;
  const count = (key: string, n: number) => t(key, { n, number: formatNumber(n) });

  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }}>
    <div className="modal move-photos" role="dialog" aria-modal="true" aria-labelledby="folder-move-title">
      <div className="modal-head">
        <h2 id="folder-move-title">{t(copy ? "dialogs.folderMove.copyTitle" : "dialogs.folderMove.moveTitle")}</h2>
      </div>
      <div className="modal-body">
        {error ? <p role="alert">{error}</p> : !plan ? <p>{t("dialogs.move.checking")}</p> : <>
          <p className="move-dest">{plan.target}</p>
          <p>{[
            count("dialogs.folderMove.photos", plan.photos),
            count("dialogs.folderMove.files", plan.files - plan.photos),
            count("dialogs.folderMove.subfolders", plan.subfolders),
          ].join(" · ")}</p>
          <p className="note-plain">{t(instant ? "dialogs.move.sameDrive" : copy
            ? "dialogs.folderMove.checkedCopy" : "dialogs.folderMove.checkedMove")}</p>
          {!instant && <p>{t("dialogs.folderMove.bytes", { size: bytesText(bytes) })}</p>}
          {plan.network && <p className="note-plain">{t("dialogs.folderMove.network")}</p>}
          {plan.merge && <p>{t("dialogs.folderMove.merge")}</p>}
          {plan.identical > 0 && <p>{count("dialogs.folderMove.identical", plan.identical)}</p>}
          {plan.links > 0 && <p>{count("dialogs.folderMove.links", plan.links)}</p>}
          {plan.conflicts.length > 0 && <>
            <h3>{t("dialogs.move.conflictsHeading")}</h3>
            <ul className="move-clashes">
              {plan.conflicts.map((f) => <li key={f.path} className="row">
                <span className="name" title={f.path}>{f.path}</span>
                <select aria-label={t("dialogs.folderMove.conflictAction", { path: f.path })}
                  value={overwrite.has(f.path) ? "overwrite" : "skip"}
                  onChange={(e) => {
                    const next = new Set(overwrite);
                    if (e.target.value === "overwrite") next.add(f.path);
                    else next.delete(f.path);
                    setOverwrite(next);
                  }}>
                  <option value="skip">{t("dialogs.move.skip")}</option>
                  <option value="overwrite">{t("dialogs.folderMove.overwrite")}</option>
                </select>
              </li>)}
            </ul>
          </>}
          {low && <p role="alert">{t("dialogs.move.lowSpace", { free: bytesText(plan.free!), needed: bytesText(bytes) })}</p>}
          <label className="row check">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            {t("dialogs.move.keepOriginals")}
          </label>
        </>}
      </div>
      <div className="modal-foot">
        <button ref={cancel} className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
        <button className="btn primary" disabled={!plan || low}
          onClick={() => onConfirm(copy, selected)}>{t(copy ? "dialogs.move.copy" : "dialogs.move.move")}</button>
      </div>
    </div>
  </div>;
}
