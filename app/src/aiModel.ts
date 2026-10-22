// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// an AI command run with its model installed, downloaded on first use. a
// model whose unpack was cut short keeps its config.json, so it passes
// ai_model_ensure and never loads; the engine's "cannot load the '<id>'
// model" then downloads it again, once, and the command runs again
import { invoke } from "@tauri-apps/api/core";

export async function withModel<T>(id: string, run: () => Promise<T>): Promise<T> {
  await invoke("ai_model_ensure", { id });
  try {
    return await run();
  } catch (e) {
    if (!String(e).includes(`cannot load the '${id}' model`)) throw e;
    await invoke("ai_model_reinstall", { id });
    return run();
  }
}
