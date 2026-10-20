// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a newer Immage on GitHub: a small card in the corner, over everything but
// in nobody's way, with the release's notes, until it is installed or put off
import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { installUpdate, later, relaunch, releaseUrl, skipVersion, useBannerShown, useUpdate } from "./updates";

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
        <span>Immage {version} is available</span>
        {body && (
          <button className="update-notes-toggle" onClick={() => setNotes(!notes)}>
            {notes ? "Hide Notes" : "Release Notes"}
          </button>
        )}
      </div>
      {notes && body && <pre className="update-notes">{body}</pre>}
      {state.kind === "downloading" && (
        <>
          <div className="progress"><div className="bar" style={{ width: state.total ? `${(100 * state.got) / state.total}%` : "100%" }} /></div>
          <div className="update-line">
            downloading {(state.got / 1e6).toFixed(0)}{state.total ? ` of ${(state.total / 1e6).toFixed(0)}` : ""} MB
          </div>
        </>
      )}
      {state.kind === "installing" && <div className="update-line">saving the edit and installing…</div>}
      {state.kind === "failed" && (
        <div className="update-line error">
          {state.engineGone ? "the update did not install, and the engine has stopped; relaunch to go on: " : "the update did not install: "}
          {state.message}
        </div>
      )}
      <div className="update-foot">
        {state.kind === "available" && (
          <>
            <button className="btn" onClick={skipVersion}>Skip This Version</button>
            <button className="btn" onClick={later}>Later</button>
            {canInstall
              ? <button className="btn primary" onClick={() => void installUpdate(prepare)}>Install and Relaunch</button>
              : <button className="btn primary" onClick={page}>Release Page</button>}
          </>
        )}
        {state.kind === "failed" && (
          <>
            <button className="btn" onClick={page}>Release Page</button>
            {state.engineGone
              ? <button className="btn primary" onClick={() => void relaunch()}>Relaunch</button>
              : <>
                  <button className="btn" onClick={later}>Later</button>
                  <button className="btn primary" onClick={() => void installUpdate(prepare)}>Try Again</button>
                </>}
          </>
        )}
      </div>
    </div>
  );
}
