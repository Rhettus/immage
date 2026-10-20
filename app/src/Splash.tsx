// the startup splash: a small window of its own, as darktable's, with the
// artwork and Immage's and darktable's versions, shown while the engine
// starts. the main window starts hidden (tauri.conf.json); `about` answers
// only once the engine does (main.rs, about), so its reply is the sign to
// show the main window and close this one
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import "@fontsource/poppins/500.css";
import "./styles.css";
import splashUrl from "./splash.jpg";

const MIN_SHOWN_MS = 1200;

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

function Splash() {
  const [about, setAbout] = useState<{ app: string; darktable: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const shown = Date.now();
    invoke<{ app: string; darktable: string }>("about")
      .then((a) => { setAbout(a); setTimeout(finish, Math.max(0, MIN_SHOWN_MS - (Date.now() - shown))); })
      // the app stays usable without the versions; say why, then get out of the way
      .catch((e) => { setProblem(String(e)); setTimeout(finish, 3000); });
  }, []);

  return (
    <div className="splash" data-tauri-drag-region>
      <img src={splashUrl} alt="" draggable={false} data-tauri-drag-region />
      <div className="splash-info" data-tauri-drag-region>
        {about ? (
          <div className="splash-versions" title={`darktable ${about.darktable}`}>
            <span>Immage {about.app}</span>
            <span className="splash-dot">·</span>
            <span>darktable {about.darktable.split("~")[0]}</span>
          </div>
        ) : (
          <div className="splash-status">{problem ? `the engine did not answer: ${problem}` : "starting the engine…"}</div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Splash />
  </StrictMode>,
);
