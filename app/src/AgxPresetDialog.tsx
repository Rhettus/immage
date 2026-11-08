// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { addAgxProfiles, findAgxPresets, LOAD_AGX_PRESET_EVENT, useAgxProfiles,
         type FoundPreset } from "./agxProfiles";

// Profile > Load preset: pick AgX presets from darktable's own presets or from
// a preset (.dtpreset) or style (.dtstyle) file, to keep in the Profile menu
export function AgxPresetLoader({ ready, onPick }: { ready: boolean; onPick: (value: number) => void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const show = () => setShown(true);
    window.addEventListener(LOAD_AGX_PRESET_EVENT, show);
    return () => window.removeEventListener(LOAD_AGX_PRESET_EVENT, show);
  }, []);
  return shown ? <AgxPresetDialog ready={ready} onPick={onPick} onClose={() => setShown(false)} /> : null;
}

function AgxPresetDialog({ ready, onPick, onClose }: { ready: boolean; onPick: (value: number) => void; onClose: () => void }) {
  useAgxProfiles();
  const [found, setFound] = useState<FoundPreset[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const search = async (file?: string) => {
    setBusy(true); setError("");
    try {
      const list = await findAgxPresets(file);
      setFound(list);
      setChosen(new Set(list.map((_, i) => i)));
      if (!list.length) setError(file ? "No AgX preset in this file." : "No AgX presets of your own in darktable's presets.");
    } catch (e) { setError(String(e)); setFound(null); }
    finally { setBusy(false); }
  };
  const choose = async () => {
    try {
      const file = await open({ multiple: false, filters: [{ name: "darktable preset or style", extensions: ["dtpreset", "dtstyle"] }] });
      if (typeof file === "string") await search(file);
    } catch (e) { setError(String(e)); }
  };
  const add = async () => {
    if (!found) return;
    setBusy(true);
    try {
      const values = await addAgxProfiles(found.filter((_, i) => chosen.has(i)));
      if (values.length) onPick(values[0]);
      onClose();
    } catch (e) { setError(String(e)); setBusy(false); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => { if (ready) void search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="modal-backdrop" onPointerDown={(e) => { if (!busy && e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); if (!busy) onClose(); }
      if (e.key === "Tab") {
        const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <div ref={box} className="modal" data-dialog="agx-presets" role="dialog" aria-modal="true" aria-labelledby="agx-preset-title">
      <div className="modal-head"><h2 id="agx-preset-title">Load AgX Preset</h2></div>
      <div className="modal-body">
        {!ready && <p className="note-plain">Open a photo to load presets.</p>}
        {found && found.length > 0 && <>
          <p>Presets found:</p>
          {found.map((p, i) => <label key={i} className="row">
            <input type="checkbox" disabled={busy} checked={chosen.has(i)}
                   onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
            {" "}{p.name.replace(/^_builtin_/, "")}
          </label>)}
        </>}
        {error && <p role="alert">{error}</p>}

      </div>
      <div className="modal-foot">
        <button className="btn" disabled={busy || !ready} onClick={() => void search()}>From darktable</button>
        <button className="btn" disabled={busy || !ready} onClick={() => void choose()}>From file…</button>
        <button className="btn" disabled={busy} onClick={onClose}>Close</button>
        <button className="btn primary" disabled={busy || !found || chosen.size === 0} onClick={() => void add()}>Add</button>
      </div>
    </div>
  </div>;
}
