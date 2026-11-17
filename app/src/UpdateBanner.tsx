// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a newer Immage on GitHub: a small card in the corner, over everything but
// in nobody's way, with the release's notes, until it is installed or put off
import { useState } from "react";
import { t } from "./i18n";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installUpdate, later, relaunch, releaseUrl, skipVersion, useBannerShown, useUpdate } from "./updates";

const IS_LINUX = /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent);

export function UpdateBanner({ prepare }: { prepare: () => Promise<void> }) {
  const state = useUpdate();
  const shown = useBannerShown();
  const [notes, setNotes] = useState(false);
  if (!shown || !("update" in state) || !state.update) return null;
  const { version, body } = state.update;
  const page = () => void openUrl(releaseUrl(version));
  // a dev build runs from the checkout, which the updater would not replace
  const canInstall = !import.meta.env.DEV;

  return (
    <div className="update-banner" role="status">
      <div className="update-head">
        <span>{t("dialogs.update.available", { version })}</span>
        {body && (
          <button className="update-notes-toggle" onClick={() => setNotes(!notes)}>
            {notes ? t("dialogs.update.hideNotes") : t("dialogs.update.releaseNotes")}
          </button>
        )}
      </div>
      {notes && body && <pre className="update-notes">{body}</pre>}
      {state.kind === "downloading" && (
        <>
          <div className="progress"><div className="bar" style={{ width: state.total ? `${(100 * state.got) / state.total}%` : "100%" }} /></div>
          <div className="update-line">
            {t("dialogs.update.downloading", { got: (state.got / 1e6).toFixed(0), total: state.total ? t("dialogs.update.downloadingOf", { total: (state.total / 1e6).toFixed(0) }) : "" })}
          </div>
        </>
      )}
      {state.kind === "installing" && <div className="update-line">{t("dialogs.update.installing")}</div>}
      {state.kind === "failed" && (
        <div className="update-line error">
          {state.engineGone ? t("dialogs.update.failedEngineStopped", { message: state.message }) : t("dialogs.update.failed", { message: state.message })}
          {IS_LINUX && ` ${t("dialogs.update.appImageFallback")}`}
        </div>
      )}
      <div className="update-foot">
        {state.kind === "available" && (
          <>
            <button className="btn" onClick={skipVersion}>{t("dialogs.update.skipVersion")}</button>
            <button className="btn" onClick={later}>{t("dialogs.update.later")}</button>
            {canInstall
              ? <button className="btn primary" onClick={() => void installUpdate(prepare)}>{t("dialogs.update.installRelaunch")}</button>
              : <button className="btn primary" onClick={page}>{t("dialogs.update.releasePage")}</button>}
          </>
        )}
        {state.kind === "failed" && (
          <>
            <button className="btn" onClick={page}>{t("dialogs.update.releasePage")}</button>
            {state.engineGone
              ? <button className="btn primary" onClick={() => void relaunch()}>{t("dialogs.update.relaunch")}</button>
              : <>
                  <button className="btn" onClick={later}>{t("dialogs.update.later")}</button>
                  <button className="btn primary" onClick={() => void installUpdate(prepare)}>{t("dialogs.update.tryAgain")}</button>
                </>}
          </>
        )}
      </div>
    </div>
  );
}
