// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { StrictMode, Profiler } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { perf } from "./perf";
import "@fontsource/poppins/400.css";
import "@fontsource/poppins/500.css";
import "@fontsource/poppins/600.css";
import "@fontsource/poppins/700.css";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Profiler id="app" onRender={perf.reactCommit}><App /></Profiler>
  </StrictMode>,
);
