// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the confirmation of photos dropped on a folder (photoDrag.ts): what moves
// or copies where, from move_plan (move_cmds.rs), and what to do with each
// photo whose name the folder already has with other content
import { useEffect, useRef, useState } from "react";
import { type MovePlan } from "./commands";
import { bytesText } from "./background";
import { baseName } from "./paths";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function MoveDialog({ plan, error, copy: copyAsked, onConfirm, onClose }: {
  plan: MovePlan | null;           // null while it is worked out
  error: string | null;
  copy: boolean;                   // ⌥/Alt held at the drop
  onConfirm: (copy: boolean, keepBoth: string[]) => void;
  onClose: () => void;
}) {
  const [copy, setCopy] = useState(copyAsked);
  // the clashing photos to keep beside the other file, by unit key
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button.primary")?.focus(); }, [plan]);
  const units = plan?.units ?? [];
  const here = units.filter((u) => u.clash === "here");
  const same = units.filter((u) => u.clash === "same");
  const clashes = units.filter((u) => u.clash === "different");
  const fresh = units.filter((u) => u.clash === "none");
  const movable = units.some((u) => !u.keepSource && u.clash !== "here");
  const moving = movable && !copy;
  const downloads = units.filter((u) => u.download).length;
  const immichFiles = units.filter((u) => u.keepSource && !u.download).length;
  const versions = units.filter((u) => u.versions > 1 && u.clash !== "here");
  const count = fresh.length + keep.size + (moving ? same.length : 0);
  const verb = moving ? "Move" : "Copy";
  const low = plan?.free != null && plan.free < plan.bytes;
  const where = plan ? plan.dest : "";
  const confirm = () => { if (plan && count && !low) onConfirm(!moving, [...keep]); };
  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "SELECT") { e.preventDefault(); confirm(); }
    }}>
    <div ref={box} className="modal move-photos" role="dialog" aria-modal="true" aria-labelledby="move-title">
      <div className="modal-head"><h2 id="move-title">{verb} Photos</h2></div>
      <div className="modal-body">
        {error ? <p role="alert">{error}</p> : !plan ? <p>Checking the folder…</p> : <>
          <p>
            {verb} <strong>{plural(count, "photo")}</strong>
            {plan.bytes > 0 && <> ({bytesText(plan.bytes)})</>} to <strong title={where}>{baseName(where) || where}</strong>
            <span className="move-dest">{where}</span>
          </p>
          <p className="note-plain">
            {moving && plan.sameDrive
              ? "On the same drive, the files are renamed: nothing is copied."
              : `Each photo and its XMP sidecars are copied, read back and checked against the original's checksum${
                  moving ? ". The original is removed only once every copy matches" : ""}.`}
          </p>
          {versions.length > 0 && <p className="note-plain">
            {versions.length === 1 ? `${versions[0].name} has ${versions[0].versions} versions` : `${plural(versions.length, "photo")} have virtual copies`}:
            {" "}every version {moving ? "moves" : "is copied"} with {versions.length === 1 ? "it" : "them"}.
          </p>}
          {downloads > 0 && <p className="note-plain">
            {plural(downloads, "photo")} from Immich {downloads === 1 ? "is" : "are"} downloaded and checked; Immich keeps {downloads === 1 ? "it" : "them"}.
          </p>}
          {immichFiles > 0 && <p className="note-plain">
            {plural(immichFiles, "Immich photo")} {immichFiles === 1 ? "is" : "are"} copied from this computer; Immich keeps the original{immichFiles === 1 ? "" : "s"}.
          </p>}
          {same.length > 0 && <p className="note-plain">
            {plural(same.length, "photo")} {same.length === 1 ? "is" : "are"} already there, identical
            {moving ? `: only ${same.length === 1 ? "its original is" : "the originals are"} removed.` : ", and skipped."}
          </p>}
          {here.length > 0 && <p className="note-plain">{plural(here.length, "photo")} already in this folder {here.length === 1 ? "is" : "are"} skipped.</p>}
          {clashes.length > 0 && <>
            <h3>Already there, with other content</h3>
            <div className="row move-all">
              <button className="btn small" onClick={() => setKeep(new Set())}>Skip all</button>
              <button className="btn small" onClick={() => setKeep(new Set(clashes.map((u) => u.key)))}>Keep both for all</button>
            </div>
            <ul className="move-clashes">
              {clashes.map((u) => (
                <li key={u.key} className="row">
                  <span className="name" title={u.key}>{u.name}</span>
                  <select value={keep.has(u.key) ? "keep" : "skip"} onChange={(e) => {
                    const next = new Set(keep);
                    if (e.target.value === "keep") next.add(u.key); else next.delete(u.key);
                    setKeep(next);
                  }}>
                    <option value="skip">Skip</option>
                    <option value="keep">Keep both (numbered)</option>
                  </select>
                </li>
              ))}
            </ul>
          </>}
          {low && <p role="alert">Not enough space: {bytesText(plan.free!)} free, {bytesText(plan.bytes)} needed.</p>}
          {movable && <label className="row check">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            Keep the originals (copy instead of move)
          </label>}
        </>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        {plan && !error && <button className="btn primary" disabled={!count || low} onClick={confirm}>
          {verb} {plural(count, "photo")}
        </button>}
      </div>
    </div>
  </div>;
}
