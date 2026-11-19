// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

import { useEffect, useMemo, useRef, useState } from "react";
import { commands, type RenameItem, type RenameRow } from "./commands";
import { DATE_FORMATS, EMPTY_META, TOKENS, expand, fileTokenNames, type Meta } from "./exportTokens";
import { loadSettings } from "./exportSettings";
import { formatNumber, t } from "./i18n";
import type { ImageEntry } from "./library";
import { baseName } from "./paths";

const extension = (name: string) => name.match(/\.[^.]+$/)?.[0] ?? "";
const filenameToken = new RegExp(`\\{(?:${[...TOKENS, "originalname"].join("|")})(?::[^}]+)?\\}`);
const metadataToken = /\{(?:title|caption|creator|copyright)(?::[^}]+)?\}/;

const renameErrors: Record<string, string> = {
  "Invalid filename": "dialogs.rename.invalidName",
  "Filename is too long": "dialogs.rename.longName",
  "The selected photo has changed": "dialogs.rename.sourceChanged",
  "Two selected files or sidecars use the same path": "dialogs.rename.duplicate",
  "Rename was not performed": "dialogs.rename.skipped",
  "A file is in use by another transfer": "dialogs.rename.inUse",
};

function renameError(error: string): string {
  const labels = [
    ["Already exists: ", "dialogs.rename.conflict"],
    ["A destination sidecar already exists: ", "dialogs.rename.sidecarConflict"],
    ["Folder is unavailable: ", "dialogs.rename.folderUnavailable"],
  ];
  const prefix = labels.find(([prefix]) => error.startsWith(prefix));
  if (prefix) return t(prefix[1], { path: error.slice(prefix[0].length) });
  return Object.hasOwn(renameErrors, error) ? t(renameErrors[error]) : error;
}

export function RenameDialog({ groups, onApply, onClose }: {
  groups: ImageEntry[][];
  onApply: (items: RenameItem[]) => Promise<RenameRow[]>;
  onClose: () => void;
}) {
  const multiple = groups.length > 1;
  const first = groups[0][0].filename;
  const [pattern, setPattern] = useState(() => multiple ? "{originalname}-{seq}" : first.slice(0, first.length - extension(first).length));
  const [edited, setEdited] = useState(multiple);
  const [dateFormat, setDateFormat] = useState(() => loadSettings().dateFormat);
  const [metadata, setMetadata] = useState<Map<number, Meta> | null>(null);
  const [metadataError, setMetadataError] = useState("");
  const [preview, setPreview] = useState<{ items: RenameItem[]; rows: RenameRow[]; error?: string } | null>(null);
  const [outcome, setOutcome] = useState<RenameRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const templated = edited && filenameToken.test(pattern);
  const needsMetadata = templated && metadataToken.test(pattern);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    if (!needsMetadata || metadata) return;
    let cancelled = false;
    setMetadataError("");
    const load = async () => {
      const loaded = new Map<number, Meta>();
      for (const [photo] of groups) {
        if (cancelled) return;
        const reply = await commands.meta(photo.imgid);
        loaded.set(photo.imgid, reply.image.metadata);
      }
      if (!cancelled) setMetadata(loaded);
    };
    void load().catch((e) => { if (!cancelled) setMetadataError(String(e)); });
    return () => { cancelled = true; };
  }, [groups, metadata, needsMetadata]);

  const candidates = useMemo(() => groups.flatMap(([photo, ...companions], n) => {
    const stem = templated
      ? expand(pattern.replace(/\{originalname(?=[:}])/g, "{filename"), photo, metadata?.get(photo.imgid) ?? EMPTY_META, n + 1, groups.length, dateFormat)
      : pattern;
    return [photo, ...companions].map((i) => ({
      item: { imgid: i.imgid, path: i.path, stem },
      oldName: i.filename,
      newName: stem + extension(i.filename),
    }));
  }), [groups, templated, pattern, dateFormat, metadata]);
  const items = useMemo(() => candidates.map((c) => c.item), [candidates]);
  const ready = !!pattern.trim() && (!needsMetadata || !!metadata);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void commands.renamePreview(items).then(
        (reply) => { if (!cancelled) setPreview({ items, rows: reply.rows }); },
        (e) => { if (!cancelled) setPreview({ items, rows: [], error: String(e) }); },
      );
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [items, ready]);

  const checked = ready && preview?.items === items ? preview : null;
  const rows = outcome ?? checked?.rows ?? [];
  const byPath = new Map(rows.map((row) => [row.oldPath, row]));
  const valid = !!checked && !checked.error && rows.length === items.length && rows.every((row) => !row.error)
    && rows.some((row) => row.oldPath !== row.newPath);
  const close = () => { if (!busy) onClose(); };
  const apply = async () => {
    if (!valid || busy || outcome) return;
    setBusy(true);
    setError("");
    try {
      const changed = new Set(rows.filter((row) => row.oldPath !== row.newPath).map((row) => row.oldPath));
      const result = await onApply(items.filter((item) => changed.has(item.path)));
      if (result.some((row) => row.error)) setOutcome(result);
      else onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const tokenNames = fileTokenNames();
  const example = candidates[0];
  const exampleRow = byPath.get(example.item.path);
  const problem = checked?.rows.find((row) => row.error);
  const message = error || (needsMetadata && metadataError) || checked?.error;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.code === "Escape") { e.preventDefault(); close(); }
        if (e.code === "Tab") {
          const focusable = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)") ?? []);
          const first = focusable[0], last = focusable.at(-1);
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}>
      <div ref={box} className="modal rename-photos" role="dialog" aria-modal="true" aria-labelledby="rename-title">
        <div className="modal-head"><h2 id="rename-title">{t("dialogs.rename.title", { n: candidates.length, count: formatNumber(candidates.length) })}</h2></div>
        <div className="modal-body">
          <label className="row">
            {t(multiple ? "dialogs.export.pattern" : "dialogs.rename.name")}
            <input ref={input} className="field" value={pattern} disabled={busy || !!outcome}
              onChange={(e) => { setEdited(true); setPattern(e.target.value); setError(""); }}
              onKeyDown={(e) => { if (e.code === "Enter") { e.preventDefault(); void apply(); } }} />
            {!multiple && extension(first)}
          </label>
          <div className="row">
            <select className="token-menu" aria-label={t("dialogs.export.insertPhotoInfo")} value="" disabled={busy || !!outcome}
              onChange={(e) => {
                const token = e.target.value;
                if (!token) return;
                const start = input.current?.selectionStart ?? pattern.length;
                const end = input.current?.selectionEnd ?? start;
                const insertion = `{${token}}`;
                setEdited(true);
                setPattern(pattern.slice(0, start) + insertion + pattern.slice(end));
                setError("");
                window.requestAnimationFrame(() => {
                  input.current?.focus();
                  input.current?.setSelectionRange(start + insertion.length, start + insertion.length);
                });
              }}>
              <option value="">{t("dialogs.export.insertPhotoInfo")}</option>
              {TOKENS.map((token) => <option key={token} value={token === "filename" ? "originalname" : token}>{tokenNames[token]}</option>)}
            </select>
            <label className="row">
              {t("dialogs.export.dateStyle")}
              <select value={dateFormat} disabled={busy || !!outcome} onChange={(e) => { setDateFormat(e.target.value); setError(""); }}>
                {DATE_FORMATS.map((format) => <option key={format}>{format}</option>)}
              </select>
            </label>
          </div>
          {!outcome && <p className="rename-example"><strong>{t("dialogs.rename.example")}</strong>{" "}
            <bdi>{exampleRow && exampleRow.newPath !== exampleRow.oldPath ? baseName(exampleRow.newPath) : example.newName}</bdi>
          </p>}
          {!outcome && problem?.error && <p role="alert">
            <bdi>{baseName(problem.oldPath)}</bdi>{" — "}{renameError(problem.error)}
          </p>}
          {outcome && <table className="rename-preview">
            <thead><tr>
              <th scope="col">{t("dialogs.rename.current")}</th>
              <th scope="col">{t("dialogs.rename.proposed")}</th>
              <th scope="col">{t("dialogs.rename.result")}</th>
            </tr></thead>
            <tbody>{candidates.map(({ item, oldName, newName }) => {
              const row = byPath.get(item.path);
              return <tr key={item.path}>
                <td title={item.path}>{oldName}</td>
                <td title={row?.newPath}>{row?.newPath && row.newPath !== row.oldPath ? baseName(row.newPath) : newName}
                </td>
                <td>
                  {row?.error ? t("dialogs.rename.failed")
                    : row && row.oldPath !== row.newPath ? t("dialogs.rename.renamed") : t("dialogs.rename.unchanged")}
                  {row?.error && <div className="note-plain">{renameError(row.error)}</div>}
                </td>
              </tr>;
            })}</tbody>
          </table>}
          {!outcome && ready && !checked && <p role="status">{t("dialogs.rename.checking")}</p>}
          {!outcome && needsMetadata && !metadata && !metadataError && <p role="status">{t("dialogs.common.preparing")}</p>}
          {message && <p role="alert">{t("dialogs.rename.error", { error: message })}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" disabled={busy} onClick={close}>{t(outcome ? "dialogs.common.done" : "dialogs.common.cancel")}</button>
          {!outcome && <button className="btn primary" disabled={busy || !valid} onClick={() => void apply()}>
            {t(busy ? "dialogs.rename.renaming" : "dialogs.rename.apply")}
          </button>}
        </div>
      </div>
    </div>
  );
}
