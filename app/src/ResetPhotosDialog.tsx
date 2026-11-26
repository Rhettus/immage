// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { formatNumber, t } from "./i18n";

export function ResetPhotosDialog({ count, onClose, onConfirm }: {
  count?: number;
  onClose: () => void;
  onConfirm: (skipConfirmation: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [skipConfirmation, setSkipConfirmation] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    cancel.current?.focus();
    return () => element.close();
  }, []);

  return <dialog ref={dialog} className="modal reset-photos-dialog"
    aria-labelledby="reset-photos-title" aria-describedby="reset-photos-message"
    onKeyDown={(e) => e.stopPropagation()}
    onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <div className="modal-head">
      <h2 id="reset-photos-title">{count === undefined
        ? t("fields.history.resetAll") : t("app.resetPhotos.title", { n: count })}</h2>
    </div>
    <div className="modal-body">
      <p id="reset-photos-message">{count === undefined
        ? t("app.resetPhotos.confirmAdjustments")
        : t("app.resetPhotos.confirm", { n: count, count: formatNumber(count) })}</p>
      <label className="row check">
        <input type="checkbox" checked={skipConfirmation} onChange={(e) => setSkipConfirmation(e.target.checked)} />
        {t("app.resetPhotos.skipConfirmation")}
      </label>
    </div>
    <div className="modal-foot">
      <button ref={cancel} className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
      <button className="btn danger" onClick={() => onConfirm(skipConfirmation)}>{t("app.resetPhotos.okLabel")}</button>
    </div>
  </dialog>;
}
