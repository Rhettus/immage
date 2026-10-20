// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { defineConfig, searchForWorkspaceRoot } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

// the SD card importer's UI, cloned into the repo's immporter/
const immporter = fileURLToPath(new URL("../immporter/src", import.meta.url));

// tauri expects a fixed port and must not have vite clear its terminal output
export default defineConfig({
  // tailwind only styles the importer: its CSS (embed.css) scans its own sources
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // the startup splash is a window of its own, with its own page
  build: { rolldownOptions: { input: { main: "index.html", splash: "splash.html" } } },
  resolve: {
    alias: { "@immporter": immporter },
    // one copy of each, from app/node_modules, even if immporter/ has its own
    dedupe: ["react", "react-dom", "@tauri-apps/api", "@tauri-apps/plugin-dialog", "@tauri-apps/plugin-opener",
             "zustand", "lucide-react", "@tanstack/react-virtual"],
  },
  // 1430, not tauri's usual 1420, so it can run beside other tauri projects
  server: {
    port: 1430,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), immporter] },
  },
});
