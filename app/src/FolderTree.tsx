// the library panel's folders as a tree, as Lightroom's: each folder added
// opens into its subfolders, read from disk when first opened and again
// whenever it is reopened, so folders made since (by an import) show
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { baseName } from "./paths";

type SubFolder = { name: string; path: string; has_children: boolean };

export function FolderTree({ roots, current, photo, expanded, refresh, icon, onToggle, onOpen, onRemove }: {
  roots: string[];
  current: string | null;
  photo: string | null;                // the open photo's folder: scrolled to, and marked when not `current`
  expanded: Set<string>;
  refresh: number;                     // bumped to read every open folder again
  icon: React.ReactNode;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onRemove: (root: string) => void;
}) {
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

  const row = (path: string, name: string, depth: number, hasChildren: boolean, root: boolean): React.ReactNode => {
    const open = expanded.has(path);
    const kids = open ? children.get(path) : undefined;
    const holdsPhoto = path === photo && path !== current;
    return (
      <li key={path}>
        <div className={`folder-row${path === current ? " active" : ""}${holdsPhoto ? " has-photo" : ""}`} title={path}
             ref={path === photo ? reveal : undefined}
             style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onOpen(path)}>
          <button className={`twisty${open ? " open" : ""}${hasChildren ? "" : " none"}`} tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); if (hasChildren) onToggle(path); }}>
            {/* points right, and turns down when the folder opens */}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
                 strokeLinecap="round" strokeLinejoin="round"><path d="m9 5 7 7-7 7" /></svg>
          </button>
          {icon}<span className="name">{name}</span>
          {holdsPhoto && <span className="photo-dot" title="the open photo is in this folder" />}
          {root && (
            <button className="remove" title="remove from the list"
                    onClick={(e) => { e.stopPropagation(); onRemove(path); }}>×</button>
          )}
        </div>
        {kids && kids.length > 0 && (
          <ul>{kids.map((k) => row(k.path, k.name, depth + 1, k.has_children, false))}</ul>
        )}
      </li>
    );
  };

  // a root's twisty shows until it is known to have no subfolders
  return (
    <ul className="folders">
      {roots.map((r) => row(r, baseName(r), 0, children.get(r)?.length !== 0, true))}
    </ul>
  );
}
