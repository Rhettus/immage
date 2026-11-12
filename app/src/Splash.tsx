// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the startup splash: a small window of its own, as darktable's, with the
// artwork and Immage's and darktable's versions, shown while the engine
// starts. Immage's version and commit show at once (main.rs, build), to
// tell builds apart before the engine is up. the main window starts hidden
// (tauri.conf.json); `about` answers only once the engine does (main.rs,
// about), so its reply is the sign to show the main window and close this one
import { ready, settings } from "./settings";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/poppins/500.css";
import "./styles.css";
import splashUrl from "./splash.jpg";
import { logCspViolations } from "./cspLog";
import { commands } from "./commands";

logCspViolations();

const MIN_SHOWN_MS = 1200;
// darktable reports nothing from inside dt_init, where the wait is, so the
// bar fills against how long the last start took; the first start after
// installing has no record, and is the slow one (the system scans every
// bundled library, and OpenCL compiles its kernels)
const STARTUP_KEY = "immage.startupMs";
const SPLASH_SIZE_KEY = "immage.splashSize";
const FIRST_START_MS = 20000;
const SLOW_HINT_MS = 8000;

// the last start's duration, 0 for none
function lastMs() {
  try { return Number(settings.get(STARTUP_KEY)) || 0; } catch { return 0; }
}

// eases towards the end without reaching it: about 90% at the expected
// time, so a slower start than last time still moves
function fraction(elapsed: number, expected: number) {
  return 0.97 * (1 - Math.exp(-2.4 * elapsed / expected));
}

// hand over to the main window, whatever happened here
async function finish() {
  try {
    const main = await Window.getByLabel("main");
    await main?.show();
    await main?.setFocus();
  } finally {
    await getCurrentWindow().close();
  }
}

type Build = { app: string; commit: string | null };

function Splash() {
  const [build, setBuild] = useState<Build | null>(null);
  const [about, setAbout] = useState<(Build & { darktable: string }) | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [last] = useState(lastMs);
  const expected = last || FIRST_START_MS;
  // a first start, or one after an update (which the system scans again)
  const slow = elapsed > SLOW_HINT_MS && (!last || elapsed > 1.5 * last);

  // the largest size this window was given, kept for the GUI tests (their
  // session starts after the splash has gone): a tiling window manager that
  // tiles it instead of floating it stretches it over the screen
  useEffect(() => {
    let w = 0, h = 0;
    const note = () => {
      w = Math.max(w, innerWidth); h = Math.max(h, innerHeight);
      try { settings.set(SPLASH_SIZE_KEY, `${w}x${h}`); } catch { /* not kept */ }
    };
    note();
    addEventListener("resize", note);
    return () => removeEventListener("resize", note);
  }, []);

  useEffect(() => { commands.build().then(setBuild).catch(() => {}); }, []);

  useEffect(() => {
    const shown = Date.now();
    const tick = setInterval(() => setElapsed(Date.now() - shown), 100);
    commands.about()
      .then((a) => {
        clearInterval(tick);
        try { settings.set(STARTUP_KEY, String(Date.now() - shown)); } catch { /* not kept */ }
        setAbout(a);
        setTimeout(finish, Math.max(0, MIN_SHOWN_MS - (Date.now() - shown)));
      })
      // the app stays usable without the versions; say why, then get out of the way
      .catch((e) => { clearInterval(tick); setProblem(String(e)); setTimeout(finish, 3000); });
    return () => clearInterval(tick);
  }, []);

  const done = about ? 1 : fraction(elapsed, expected);
  const ours = about ?? build;

  return (
    <div className="splash" data-tauri-drag-region>
      <img src={splashUrl} alt="" draggable={false} data-tauri-drag-region />
      <div className="splash-info" data-tauri-drag-region>
        {ours && (
          <div className="splash-versions" title={about ? `darktable ${about.darktable}` : undefined}>
            <span>Immage {ours.app}{ours.commit && <span className="splash-commit"> ({ours.commit})</span>}</span>
            {about && <>
              <span className="splash-dot">·</span>
              <span>darktable {about.darktable.split("~")[0]}</span>
            </>}
          </div>
        )}
        {!about && (
          <div className="splash-status">
            {problem ? `the engine did not answer: ${problem}`
              : slow ? "starting the engine: the first start after installing or updating takes longer…"
              : "starting the engine…"}
          </div>
        )}
      </div>
      {!problem && (
        <div className="splash-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(done * 100)}>
          <div style={{ transform: `scaleX(${done})` }} />
        </div>
      )}
    </div>
  );
}

await ready;
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Splash />
  </StrictMode>,
);
