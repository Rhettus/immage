// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the library panel's folders as a tree, as Lightroom's: each folder added
// opens into its subfolders, read from disk when first opened and again
// whenever it is reopened, so folders made since (by an import) show.
// with folders on more than one drive, each drive is a heading over its
// folders, so a 2026 on the Mac and a 2026 on a NAS are told apart
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NameEdit } from "./MasksPanel";
import { baseName } from "./paths";

type SubFolder = { name: string; path: string; has_children: boolean };
// the drive a folder is on (folder_volumes, volumes.rs)
export type Volume = { path: string; mount: string; name: string; host: string | null; network: boolean; online: boolean };

// points right, and turns down when what it opens opens
const chevron = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
       strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7" /></svg>
);

export function FolderTree({ roots, volumes, hostNames, folded, current, photo, expanded, hidden, refresh, icon, driveIcon, networkIcon,
                             onToggle, onFold, onOpen, onRemove, onRenameHost }: {
  roots: string[];
  volumes: Map<string, Volume>;        // by root
  hostNames: Record<string, string>;   // the user's names for servers, by host
  folded: Set<string>;                 // drive headings closed, by mount
  current: string | null;
  photo: string | null;                // the open photo's folder: scrolled to, and marked when not `current`
  expanded: Set<string>;
  hidden: Set<string>;                 // subfolders taken off the tree
  refresh: number;                     // bumped to read every open folder again
  icon: React.ReactNode;
  driveIcon: React.ReactNode;
  networkIcon: React.ReactNode;
  onToggle: (path: string) => void;
  onFold: (mount: string) => void;
  onOpen: (path: string) => void;
  onRemove: (path: string) => void;
  onRenameHost: (host: string, name: string) => void;  // "" goes back to the host
}) {
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [children, setChildren] = useState<Map<string, SubFolder[]>>(new Map());
  // the open folders' subfolders, read when a folder opens or on refresh
  useEffect(() => {
    let stale = false;
    const open = [...expanded];
    void Promise.all(open.map(async (p) => [p, await invoke<SubFolder[]>("list_subfolders", { path: p })] as const))
      .then((lists) => {
        if (stale) return;
        setChildren((old) => {
          const next = new Map(old);
          for (const [p, list] of lists) next.set(p, list);
          return next;
        });
      });
    return () => { stale = true; };
  }, [expanded, refresh]);

  // the photo's folder is scrolled to once per photo folder, when its row
  // first shows: its parents' subfolders are read after it opens
  const revealed = useRef<string | null>(null);
  const reveal = (el: HTMLDivElement | null) => {
    if (!el || revealed.current === photo) return;
    revealed.current = photo;
    el.scrollIntoView({ block: "nearest" });
  };

  const row = (path: string, name: string, depth: number, hasChildren: boolean, offline = false): React.ReactNode => {
    const open = expanded.has(path);
    const kids = open ? children.get(path)?.filter((k) => !hidden.has(k.path)) : undefined;
    const holdsPhoto = path === photo && path !== current;
    return (
      <li key={path}>
        <div className={`folder-row${path === current ? " active" : ""}${holdsPhoto ? " has-photo" : ""}${offline ? " offline" : ""}`}
             title={offline ? `${path}\nnot connected` : path}
             ref={path === photo ? reveal : undefined}
             style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(path)}>
          <button className={`twisty${open ? " open" : ""}${hasChildren ? "" : " none"}`} tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(path); }}>
            {chevron}
          </button>
          {icon}<span className="name">{name}</span>
          {holdsPhoto && <span className="photo-dot" title="the open photo is in this folder" />}
          <button className="remove" title="remove from the list"
                  onClick={(e) => { e.stopPropagation(); onRemove(path); }}>×</button>
        </div>
        {kids && kids.length > 0 && (
          <ul>{kids.map((k) => row(k.path, k.name, depth + 1, k.has_children))}</ul>
        )}
      </li>
    );
  };

  // a root's twisty shows until it is known to have no subfolders
  const rootRow = (r: string, depth: number) =>
    row(r, baseName(r), depth, children.get(r)?.length !== 0, volumes.get(r)?.online === false);

  // drives in the order their first folder was added
  const drives = new Map<string, string[]>();
  for (const r of roots) {
    const mount = volumes.get(r)?.mount ?? "";
    drives.set(mount, [...(drives.get(mount) ?? []), r]);
  }
  if (drives.size < 2) return <ul className="folders">{roots.map((r) => rootRow(r, 0))}</ul>;
  return (
    <ul className="folders">
      {[...drives].map(([mount, list]) => {
        const v = volumes.get(list[0]);
        const open = !folded.has(mount);
        // a share mounted by its address shows it, unless the user named it
        const host = v?.host ? hostNames[v.host] || v.host : null;
        return (
          <li key={`drive:${mount}`}>
            <div className="folder-volume" title={v?.host ? `${mount}\non ${host}${host !== v.host ? ` (${v.host})` : ""}` : mount}
                 onClick={() => onFold(mount)}>
              <span className={`twisty${open ? " open" : ""}`}>{chevron}</span>
              {v?.network ? networkIcon : driveIcon}
              <span className="name">{v?.name || mount}</span>
              {v?.host && (editingHost === mount
                ? <NameEdit shown={host!} onDone={(to) => {
                    setEditingHost(null);
                    if (to !== null && to !== host) onRenameHost(v.host!, to === v.host ? "" : to);
                  }} />
                : <span className="host" title="double-click to rename"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => { e.stopPropagation(); setEditingHost(mount); }}>{host}</span>)}
              <span className={`drive-dot${v?.online === false ? " off" : ""}`}
                    title={v?.online === false ? "not answering" : "connected"} />
            </div>
            {open && <ul>{list.map((r) => rootRow(r, 1))}</ul>}
          </li>
        );
      })}
    </ul>
  );
}
