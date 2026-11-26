// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Keyboard Shortcuts sheet (⌘/): every key the app answers,
// by where it works. the handlers live in App.tsx; keep this list with them
// (the menus in menu.ts list these shortcuts too)
import { useEffect, useMemo, useRef, useState } from "react";
import { cmd, keys } from "./keys";
import { t } from "./i18n";
import { filterShortcutGroups, type ShortcutGroup } from "./shortcutsSearch";

const GROUPS: ShortcutGroup[] = [
  {
    title: t("dialogs.shortcuts.group.general"),
    keys: [
["⇧⌘I", t("dialogs.shortcuts.general.entry1")],
["⇧⌘E", t("dialogs.shortcuts.general.entry2")],
["⌘P", t("dialogs.shortcuts.general.entry3")],
["S", t("dialogs.shortcuts.general.entry4")],
["⌘,", t("dialogs.shortcuts.general.entry5")],
["⌘/", t("dialogs.shortcuts.general.entry6")],
["⇧⌘P", t("dialogs.shortcuts.general.entry7")],
["⌘Z", t("dialogs.shortcuts.general.entry8")],
["⇧⌘Z", t("dialogs.shortcuts.general.entry9")],
["⇧⌘C", t("dialogs.shortcuts.general.entry10")],
["⇧⌘V", t("dialogs.shortcuts.general.entry11")],
["⌥⌘V", t("dialogs.shortcuts.general.entry12")],
["⌘'", t("dialogs.shortcuts.general.entry13")],
["⌃H", t("dialogs.shortcuts.general.entry14")],
["⌃M", t("dialogs.shortcuts.general.entry15")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.view"),
    keys: [
["F", t("dialogs.shortcuts.view.entry1")],
["K", t("dialogs.shortcuts.view.entry2")],
["L", t("dialogs.shortcuts.view.entry3")],
["Tab", t("dialogs.shortcuts.view.entry4")],
["⇧Tab", t("dialogs.shortcuts.view.entry5")],
["Z", t("dialogs.shortcuts.view.entry6")],
["⌘= ⌘-", t("dialogs.shortcuts.view.entry7")],
["Click", t("dialogs.shortcuts.view.entry8")],
["Scroll", t("dialogs.shortcuts.view.entry9")],
["\\\\", t("dialogs.shortcuts.view.entry10")],
["Y", t("dialogs.shortcuts.view.entry11")],
["C", t("dialogs.shortcuts.view.entry12")],
["J", t("dialogs.shortcuts.view.entry13")],
["H", t("dialogs.shortcuts.view.entry14")],
["I", t("dialogs.shortcuts.view.entry15")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.photos"),
    keys: [
["← →", t("dialogs.shortcuts.photos.entry1")],
["0 – 5", t("dialogs.shortcuts.photos.entry2")],
["6 – 9", t("dialogs.shortcuts.photos.entry3")],
["X", t("dialogs.shortcuts.photos.entry4")],
["⌘-click", t("dialogs.shortcuts.photos.entry5")],
["⇧-click", t("dialogs.shortcuts.photos.entry6")],
["G", t("dialogs.shortcuts.photos.entry7")],
["⌘= ⌘-", t("dialogs.shortcuts.photos.entry8")],
["Pinch, ⌘-scroll", t("dialogs.shortcuts.photos.entry9")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.adjustments"),
    keys: [
["W", t("dialogs.shortcuts.adjustments.entry1")],
["Double-click", t("dialogs.shortcuts.adjustments.entry2")],
["Double-click", t("dialogs.shortcuts.adjustments.entry3")],
["⇧-drag", t("dialogs.shortcuts.adjustments.entry4")],
["Scroll", t("dialogs.shortcuts.adjustments.entry5")],
["⌥-click", t("dialogs.shortcuts.adjustments.entry6")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.crop"),
    keys: [
["R", t("dialogs.shortcuts.crop.entry1")],
["Esc", t("dialogs.shortcuts.crop.entry2")],
["X", t("dialogs.shortcuts.crop.entry3")],
["⇧-drag", t("dialogs.shortcuts.crop.entry4")],
["⌘[", t("dialogs.shortcuts.crop.entry5")],
["⌘]", t("dialogs.shortcuts.crop.entry6")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.masks"),
    keys: [
["K", t("dialogs.shortcuts.masks.entry1")],
["M", t("dialogs.shortcuts.masks.entry2")],
["⇧M", t("dialogs.shortcuts.masks.entry3")],
["⇧J", t("dialogs.shortcuts.masks.entry4")],
["⇧Q", t("dialogs.shortcuts.masks.entry5")],
["[ ]", t("dialogs.shortcuts.masks.entry6")],
["Scroll", t("dialogs.shortcuts.masks.entry7")],
["⌥-drag", t("dialogs.shortcuts.masks.entry8")],
["O", t("dialogs.shortcuts.masks.entry9")],
["Esc", t("dialogs.shortcuts.masks.entry10")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.zonesystem"),
    keys: [
["O", t("dialogs.shortcuts.zonesystem.entry1")],
["← →", t("dialogs.shortcuts.zonesystem.entry2")],
["⇧← ⇧→", t("dialogs.shortcuts.zonesystem.entry3")],
["Esc", t("dialogs.shortcuts.zonesystem.entry4")],
    ],
  },
  {
    title: t("dialogs.shortcuts.group.healandclone"),
    keys: [
["Q", t("dialogs.shortcuts.healandclone.entry1")],
["[ ]", t("dialogs.shortcuts.healandclone.entry2")],
["Scroll", t("dialogs.shortcuts.healandclone.entry3")],
["A", t("dialogs.shortcuts.healandclone.entry4")],
["O", t("dialogs.shortcuts.healandclone.overlay")],
["Delete", t("dialogs.shortcuts.healandclone.entry5")],
["Esc", t("dialogs.shortcuts.healandclone.entry6")],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (cmd(e) && e.code === "Slash") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (queryRef.current) {
          setQuery("");
          inputRef.current?.focus();
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const filtered = useMemo(() => filterShortcutGroups(GROUPS, query), [query]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shortcuts" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <div className="modal-head"><h2 id="shortcuts-title">{t("dialogs.shortcuts.title")}</h2></div>
        <div className="shortcuts-search">
          <input
            ref={inputRef}
            type="search"
            className="field"
            spellCheck={false}
            value={query}
            placeholder={t("dialogs.shortcuts.searchPlaceholder")}
            aria-label={t("dialogs.shortcuts.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
        <div className="modal-body shortcut-groups">
          {filtered.length > 0 ? (
            filtered.map((g) => (
              <section key={g.title}>
                <h3>{g.title}</h3>
                <dl>
                  {g.keys.map(([k, what], i) => (
                    <div key={i}><dt><kbd>{keys(k)}</kbd></dt><dd>{keys(what)}</dd></div>
                  ))}
                </dl>
              </section>
            ))
          ) : (
            <p className="shortcuts-empty" role="status">{t("dialogs.shortcuts.noMatches")}</p>
          )}
        </div>
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("dialogs.common.done")}</button></div>
      </div>
    </div>
  );
}
