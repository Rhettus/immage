// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { StrictMode, Profiler } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import SelectMenu from "./SelectMenu";
import { perf } from "./perf";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./styles.css";

// Native Windows hand cursors can show icon strokes through their outline.
// Use the standard desktop-button arrow for icon tools on Windows.
document.documentElement.classList.toggle("windows", navigator.userAgent.includes("Windows"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Profiler id="app" onRender={perf.reactCommit}><App /></Profiler>
    <SelectMenu />
  </StrictMode>,
);
