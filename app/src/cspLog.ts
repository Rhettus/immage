// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a blocked resource fails silently, so each content security policy
// violation (tauri.conf.json, csp) goes to webview.log in the runtime folder
// (main.rs, csp_violation). deduped by directive and target, and capped, so
// a loop that keeps hitting the policy cannot flood the log
import { invoke } from "@tauri-apps/api/core";

const MAX_LOGGED = 50;

export function logCspViolations() {
  const seen = new Set<string>();
  document.addEventListener("securitypolicyviolation", (e) => {
    const key = `${e.effectiveDirective}|${e.blockedURI}`;
    if (seen.has(key) || seen.size >= MAX_LOGGED) return;
    seen.add(key);
    invoke("csp_violation", {
      directive: e.effectiveDirective,
      blocked: e.blockedURI,
      source: e.sourceFile,
      line: e.lineNumber,
      sample: e.sample,
    }).catch(() => {});
  });
}
