// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { PROFILE_GROUPS } from "./manifest";
import { loadNewPhotosProfile } from "./profileDefault";
import { addAgxProfiles, deleteAgxProfiles, findAgxPresets, DELETE_AGX_PRESET_EVENT, LOAD_AGX_PRESET_EVENT, useAgxProfiles, userProfiles,
         type FoundPreset } from "./agxProfiles";

// Profile > Load AgX Preset: pick AgX presets from darktable's own presets or from
// a preset (.dtpreset) or style (.dtstyle) file, to keep in the Profile menu
export function AgxPresetLoader({ ready, onPick }: { ready: boolean; onPick: (value: number) => void }) {
  const [mode, setMode] = useState<"load" | "delete" | null>(null);
  useEffect(() => {
    const load = () => setMode("load"), remove = () => setMode("delete");
    window.addEventListener(LOAD_AGX_PRESET_EVENT, load);
    window.addEventListener(DELETE_AGX_PRESET_EVENT, remove);
    return () => {
      window.removeEventListener(LOAD_AGX_PRESET_EVENT, load);
      window.removeEventListener(DELETE_AGX_PRESET_EVENT, remove);
    };
  }, []);
  return mode ? <AgxPresetDialog key={mode} mode={mode} ready={ready} onPick={onPick} onClose={() => setMode(null)} /> : null;
}

function AgxPresetDialog({ mode, ready, onPick, onClose }: { mode: "load" | "delete"; ready: boolean; onPick: (value: number) => void; onClose: () => void }) {
  useAgxProfiles();
  const removing = mode === "delete";
  const [found, setFound] = useState<FoundPreset[] | null>(null);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [replacement, setReplacement] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const listed = removing ? userProfiles().map((p) => ({ name: p.label, params: p.params })) : found ?? [];

  const deleting = userProfiles().filter((_, i) => chosen.has(i)).map((p) => p.value);
  const needsReplacement = removing && deleting.includes(loadNewPhotosProfile());
  const replacements = PROFILE_GROUPS.map(([name, options]) =>
    [name, options.filter(([, value]) => !deleting.includes(value))] as [string, [string, number][]]);
  const replacementValid = replacement !== null && replacements.some(([, opts]) => opts.some(([, v]) => v === replacement));

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
  const apply = async () => {
    if (!chosen.size) return;
    setBusy(true);
    try {
      if (removing) await deleteAgxProfiles(deleting, replacement ?? undefined);
      else {
        const values = await addAgxProfiles(listed.filter((_, i) => chosen.has(i)));
        if (values.length) onPick(values[0]);
      }
      onClose();
    } catch (e) { setError(String(e)); setBusy(false); }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => { if (ready && !removing) void search(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="modal-backdrop" onPointerDown={(e) => { if (!busy && e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); if (!busy) onClose(); }
      if (e.key === "Tab") {
        const items = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? []);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    <div ref={box} className="modal" data-dialog={removing ? "agx-presets-delete" : "agx-presets"} role="dialog" aria-modal="true" aria-labelledby="agx-preset-title">
      <div className="modal-head"><h2 id="agx-preset-title">{removing ? "Delete AgX Preset" : "Load AgX Preset"}</h2></div>
      <div className="modal-body">
        {!ready && !removing && <p className="note-plain">Open a photo to load presets.</p>}
        {removing && <p>Delete presets from My Presets. Photos already using them keep their adjustments.</p>}
        {removing && !listed.length && <p>No user-loaded AgX presets.</p>}
        {listed.length > 0 && <>
          <p>{removing ? "Your presets:" : "Presets found:"}</p>
          {listed.map((p, i) => <label key={i} className="row">
            <input type="checkbox" disabled={busy} checked={chosen.has(i)}
                   onChange={(e) => setChosen((c) => { const n = new Set(c); if (e.target.checked) n.add(i); else n.delete(i); return n; })} />
            {" "}{p.name.replace(/^_builtin_/, "")}
          </label>)}
        </>}
        {needsReplacement && <label className="row">
          This preset is the default for new raw photos. Choose another default before deleting it.
          <select className="field" data-action="agx-replacement-default" disabled={busy}
            value={replacementValid ? replacement! : ""} onChange={(e) => setReplacement(Number(e.target.value))}>
            <option value="" disabled>Choose a default profile…</option>
            {replacements.filter(([, options]) => options.length).map(([name, options]) => <optgroup key={name} label={name}>
              {options.map(([name, value]) => <option key={value} value={value}>{name}</option>)}
            </optgroup>)}
          </select>
        </label>}
        {error && <p role="alert">{error}</p>}

      </div>
      <div className="modal-foot">
        {!removing && <>
          <button className="btn" disabled={busy || !ready} onClick={() => void search()}>From darktable</button>
          <button className="btn" disabled={busy || !ready} onClick={() => void choose()}>From file…</button>
        </>}
        <button className="btn" disabled={busy} onClick={onClose}>Close</button>
        <button className="btn primary" disabled={busy || chosen.size === 0 || (needsReplacement && !replacementValid)} onClick={() => void apply()}>{removing ? "Delete" : "Add"}</button>
      </div>
    </div>
  </div>;
}
