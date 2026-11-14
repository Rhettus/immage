// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the library panel's folders as a tree, as Lightroom's: each folder added
// opens into its subfolders, read from disk when first opened and again
// whenever it is reopened, so folders made since (by an import) show.
// with folders on more than one drive, each drive is a heading over its
// folders, so a 2026 on the Mac and a 2026 on a NAS are told apart
import { useCallback, useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { commands, type SubFolder, type Volume } from "./commands";
import { FILE_MANAGER } from "./ExportDialog";
import { useMenuClose } from "./FileMenu";
import { NameEdit } from "./MasksPanel";
import { baseName } from "./paths";
import { usePhotoDrag } from "./photoDrag";

// the drive a folder is on (folder_volumes, volumes.rs)
export type { Volume };

// points right, and turns down when what it opens opens
const chevron = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
       strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7" /></svg>
);

export function FolderTree({ roots, volumes, hostNames, folded, current, photo, expanded, hidden, refresh, icon, driveIcon, networkIcon,
                             onToggle, onFold, onOpen, onRemove, onRenameHost, onError }: {
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
  onError: (message: string) => void;
}) {
  const [editingHost, setEditingHost] = useState<string | null>(null);
  const [children, setChildren] = useState<Map<string, SubFolder[]>>(new Map());
  // a folder's right-click menu, and the folder a new subfolder is being
  // named in (its row, first among the subfolders, until Enter or Esc)
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; offline: boolean } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [creating, setCreating] = useState<string | null>(null);
  const creatingRef = useRef<string | null>(null);
  const [made, setMade] = useState(0);   // bumped to read the open folders again after one is made
  const newFolder = (parent: string) => {
    if (!expanded.has(parent)) onToggle(parent);
    creatingRef.current = parent;
    setCreating(parent);
  };
  // Enter and the blur that follows it both end the edit: the first one counts
  const named = (name: string | null) => {
    const parent = creatingRef.current;
    creatingRef.current = null;
    setCreating(null);
    if (!parent || !name) return;
    commands.createFolder(parent, name).then(() => setMade((n) => n + 1), (e) => onError(`New Folder: ${e}`));
  };
  // a photo dragged over a folder (photoDrag.ts): the folder takes the drop,
  // and one that is shut opens after a moment's rest on it, so its
  // subfolders can take it instead. the photos' own folder opens too: it
  // refuses the drop, but its subfolders take it
  const drag = usePhotoDrag();
  const opens = useRef(new Map<string, boolean>());
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  const rest = drag?.rest ?? null;
  useEffect(() => {
    if (!rest || expanded.has(rest) || !opens.current.get(rest)) return;
    const t = window.setTimeout(() => toggle.current(rest), 500);
    return () => window.clearTimeout(t);
  }, [rest, expanded]);
  // the open folders' subfolders, read when a folder opens or on refresh
  useEffect(() => {
    let stale = false;
    // Publish each folder as it arrives: a slow or unavailable drive must
    // not hold back the children of another folder the user just expanded.
    for (const p of expanded) {
      void commands.listSubfolders(p).then((list) => {
        if (stale) return;
        setChildren((old) => {
          const next = new Map(old);
          next.set(p, list);
          return next;
        });
      }).catch(() => { /* keep prior children; reopening or refresh retries */ });
    }
    return () => { stale = true; };
  }, [expanded, refresh, made]);

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
    opens.current.set(path, hasChildren && !offline);
    // the photos' own folder, or a drive not answering, takes no drop
    const refuse = offline || (drag !== null && drag.from.length === 1 && drag.from[0] === path);
    const target = drag !== null && drag.over === path;
    return (
      <li key={path}>
        <div className={`folder-row${path === current ? " active" : ""}${holdsPhoto ? " has-photo" : ""}${offline ? " offline" : ""}`
                        + `${target ? ` drop-into${drag.copy ? " copy" : ""}` : ""}`}
             data-folder-path={path} data-folder-refuse={refuse ? "1" : undefined}
             title={offline ? `${path}\nnot connected` : path}
             ref={path === photo ? reveal : undefined}
             style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(path)}
             onContextMenu={(e) => {
               e.preventDefault();
               e.stopPropagation();
               setMenu({ x: e.clientX, y: e.clientY, path, offline });
             }}>
          <button className={`twisty${open ? " open" : ""}${hasChildren ? "" : " none"}`} tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(path); }}>
            {chevron}
          </button>
          {icon}<span className="name">{name}</span>
          {holdsPhoto && <span className="photo-dot" title="the open photo is in this folder" />}
          <button className="remove" title="remove from the list"
                  onClick={(e) => { e.stopPropagation(); onRemove(path); }}>×</button>
        </div>
        {(creating === path || (kids && kids.length > 0)) && (
          <ul>
            {creating === path && (
              <li>
                <div className="folder-row" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
                  <span className="twisty none">{chevron}</span>
                  {icon}<NameEdit shown="New Folder" onDone={named} />
                </div>
              </li>
            )}
            {kids?.map((k) => row(k.path, k.name, depth + 1, k.has_children))}
          </ul>
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
  const folderMenu = menu && (
    <FolderMenu {...menu} onClose={closeMenu}
                onNew={() => newFolder(menu.path)} onRemove={() => onRemove(menu.path)} />
  );
  if (drives.size < 2) return <>
    <ul className="folders">{roots.map((r) => rootRow(r, 0))}</ul>
    {folderMenu}
  </>;
  return (<>
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
    {folderMenu}
  </>);
}

// a folder's right-click menu: a new subfolder in it, the folder in the
// file manager, and taking it off the list, as its × does
function FolderMenu({ x, y, path, offline, onNew, onRemove, onClose }: {
  x: number; y: number; path: string; offline: boolean;
  onNew: () => void; onRemove: () => void; onClose: () => void;
}) {
  const ref = useMenuClose(onClose);
  const left = Math.min(x, window.innerWidth - 230), top = Math.min(y, window.innerHeight - 130);
  const why = offline ? "not connected" : undefined;
  return (
    <div ref={ref} className="context-menu" style={{ left, top }}>
      <button disabled={offline} title={why} onClick={() => { onClose(); onNew(); }}>New Folder…</button>
      <div className="menu-sep" />
      <button disabled={offline} title={why}
              onClick={() => { onClose(); void revealItemInDir(path).catch(() => {}); }}>Show in {FILE_MANAGER}</button>
      <div className="menu-sep" />
      <button onClick={() => { onClose(); onRemove(); }}>Remove from List</button>
    </div>
  );
}
