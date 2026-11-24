// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the confirmation of photos dropped on a folder (photoDrag.ts): what moves
// or copies where, from move_plan (move_cmds.rs), and what to do with each
// photo whose name the folder already has with other content
import { useEffect, useRef, useState } from "react";
import { type MovePlan } from "./commands";
import { bytesText } from "./background";
import { baseName } from "./paths";
import { t, formatNumber } from "./i18n";

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

export function MoveDialog({ plan, error, copy: copyAsked, companions, withCompanions, onCompanions, onConfirm, onClose }: {
  plan: MovePlan | null;           // null while it is worked out
  error: string | null;
  copy: boolean;                   // ⌥/Alt held at the drop
  companions: number;              // stacked JPEG, HEIF or ORI files among the photos
  withCompanions: boolean;         // whether they go too
  onCompanions: (on: boolean) => void;
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
  // a new plan can drop a clash that was chosen: only the current ones count
  const kept = clashes.filter((u) => keep.has(u.key)).map((u) => u.key);
  const fresh = units.filter((u) => u.clash === "none");
  const movable = units.some((u) => !u.keepSource && u.clash !== "here");
  const moving = movable && !copy;
  const downloads = units.filter((u) => u.download).length;
  const immichFiles = units.filter((u) => u.keepSource && !u.download).length;
  const versions = units.filter((u) => u.versions > 1 && u.clash !== "here");
  const count = fresh.length + kept.length + (moving ? same.length : 0);
  const verb = moving ? t("dialogs.move.move") : t("dialogs.move.copy");
  const low = plan?.free != null && plan.free < plan.bytes;
  const where = plan ? plan.dest : "";
  const confirm = () => { if (plan && count && !low) onConfirm(!moving, kept); };
  return <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "SELECT") { e.preventDefault(); confirm(); }
    }}>
    <div ref={box} className="modal move-photos" role="dialog" aria-modal="true" aria-labelledby="move-title">
      <div className="modal-head"><h2 id="move-title">{moving ? t("dialogs.move.moveTitle") : t("dialogs.move.copyTitle")}</h2></div>
      <div className="modal-body">
        {error ? <p role="alert">{error}</p> : !plan ? <p>{t("dialogs.move.checking")}</p> : <>
          <p>
            {t("dialogs.move.destinationSummary", { action: verb, count: plural(count, t("dialogs.move.photo")), size: plan.bytes > 0 ? ` (${bytesText(plan.bytes)})` : ""})}
            <strong title={where}>{baseName(where) || where}</strong>
            <span className="move-dest">{where}</span>
          </p>
          <p className="note-plain">
            {moving && plan.sameDrive
              ? t("dialogs.move.sameDrive")
              : t(moving ? "dialogs.move.checkedMove" : "dialogs.move.checkedCopy")}
          </p>
          {versions.length > 0 && <p className="note-plain">
            {versions.length === 1 ? t("dialogs.move.oneVersion", { name: versions[0].name, count: versions[0].versions }) : t("dialogs.move.virtualCopies", { count: plural(versions.length, t("dialogs.move.photo")) })}:
            {" "}{t(moving ? "dialogs.move.versionsMove" : "dialogs.move.versionsCopy", { pronoun: versions.length === 1 ? t("dialogs.move.it") : t("dialogs.move.them") })}.
          </p>}
          {downloads > 0 && <p className="note-plain">
            {t("dialogs.move.immichDownloads", { count: plural(downloads, t("dialogs.move.photo")), verb: downloads === 1 ? t("dialogs.move.is") : t("dialogs.move.are"), pronoun: downloads === 1 ? t("dialogs.move.it") : t("dialogs.move.them") })}
          </p>}
          {immichFiles > 0 && <p className="note-plain">
            {t("dialogs.move.immichCopies", { count: plural(immichFiles, t("dialogs.move.immichPhoto")), verb: immichFiles === 1 ? t("dialogs.move.is") : t("dialogs.move.are"), suffix: immichFiles === 1 ? "" : "s" })}
          </p>}
          {same.length > 0 && <p className="note-plain">
            {t(moving ? "dialogs.move.identicalMoved" : "dialogs.move.identicalSkipped", { count: plural(same.length, t("dialogs.move.photo")), verb: same.length === 1 ? t("dialogs.move.is") : t("dialogs.move.are"), original: same.length === 1 ? t("dialogs.move.itsOriginal") : t("dialogs.move.theOriginals") })}
          </p>}
          {here.length > 0 && <p className="note-plain">{t("dialogs.move.alreadyHere", { count: plural(here.length, t("dialogs.move.photo")), verb: here.length === 1 ? t("dialogs.move.is") : t("dialogs.move.are") })}</p>}
          {clashes.length > 0 && <>
            <h3>{t("dialogs.move.conflictsHeading")}</h3>
            <div className="row move-all">
              <button className="btn small" onClick={() => setKeep(new Set())}>{t("dialogs.move.skipAll")}</button>
              <button className="btn small" onClick={() => setKeep(new Set(clashes.map((u) => u.key)))}>{t("dialogs.move.keepAll")}</button>
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
                    <option value="skip">{t("dialogs.move.skip")}</option>
                    <option value="keep">{t("dialogs.move.keepBothNumbered")}</option>
                  </select>
                </li>
              ))}
            </ul>
          </>}
          {low && <p role="alert">{t("dialogs.move.lowSpace", { free: bytesText(plan.free!), needed: bytesText(plan.bytes) })}</p>}
          {movable && <label className="row check">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} />
            {t("dialogs.move.keepOriginals")}
          </label>}
        </>}
        {/* outside the plan, so they stay put while it is worked out again */}
        {companions > 0 && <label className="row check">
          <input type="checkbox" checked={withCompanions} onChange={(e) => onCompanions(e.target.checked)} />
          {t("dialogs.move.includeCompanions", { n: companions, number: formatNumber(companions) })}
        </label>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>{t("dialogs.common.cancel")}</button>
        {plan && !error && <button className="btn primary" disabled={!count || low} onClick={confirm}>
          {verb} {plural(count, t("dialogs.move.photo"))}
        </button>}
      </div>
    </div>
  </div>;
}
