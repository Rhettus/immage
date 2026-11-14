// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The file choosers of two Advanced cards: LUT 3D's file (lut3d.c: a button
// that opens a file dialog in the 3D LUT folder, and a menu of the files next
// to the chosen one) and Watermark's marker (watermark.c: a menu of the
// markers in darktable's watermarks folders, and a button that lists them
// again). The module keeps the file's name; the engine's fields `lut_file`
// and `wm_marker` carry it as a hash (engine/files.c), and a choice is that
// hash from the engine's list
import { FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { commands, type ChosenFile, type LutFiles } from "./commands";
import { onLutFolder } from "./lutFolder";

export function ModuleFile({ kind, label, priority, value, disabled, photo, onChange }: {
  kind: "lut" | "marker"; label: string; priority: number; value: number; disabled: boolean;
  // the open photo, whose module this is
  photo: object | null; onChange: (hash: number) => void;
}) {
  const [lut, setLut] = useState<LutFiles | null>(null);
  const [markers, setMarkers] = useState<{ list: ChosenFile[]; dirs: string[] } | null>(null);
  const [problem, setProblem] = useState("");
  // a new LUT folder in Preferences lists another set of files
  const [folder, setFolder] = useState(0);
  useEffect(() => onLutFolder(() => setFolder((n) => n + 1)), []);
  // read again when the choice changes: a new file shows its own folder
  useEffect(() => {
    let live = true;
    if (kind === "lut") commands.lutFiles(priority, false).then((r) => { if (live) setLut(r); }).catch(() => { if (live) setLut(null); });
    else commands.watermarks().then((r) => { if (live) setMarkers({ list: r.markers, dirs: r.dirs }); }).catch(() => { if (live) setMarkers(null); });
    return () => { live = false; };
  }, [kind, priority, photo, value, folder]);

  const fail = (e: unknown) => setProblem(String(e).replace(/^Error: /, ""));
  const browse = () => {
    setProblem("");
    commands.lutFiles(priority, true).then((r) => { if (r?.current_hash) onChange(r.current_hash); }).catch(fail);
  };
  const refresh = () => {
    setProblem("");
    commands.watermarks().then((r) => setMarkers({ list: r.markers, dirs: r.dirs })).catch(fail);
  };

  if (kind === "lut") {
    const files = lut?.files ?? [];
    const chosen = !!lut?.current;
    // lut3d.c _update_filepath_combobox: a file that is gone is listed as invalid
    const gone = chosen && !files.some((f) => f.hash === lut.current_hash);
    return (
      <div className="choice-row module-file" data-control-id="adv:lut_file">
        <span>{label}</span>
        <button type="button" className="tool" disabled={disabled || !lut} aria-label="Select LUT file"
                title={`select a png (haldclut), a cube or a 3dl file in the 3D LUT folder${lut ? ` (${lut.folder})` : ""}; the folder is set in Preferences > Modules`}
                onClick={browse}><FolderOpen size={16} strokeWidth={1.8} /></button>
        <select className="field" disabled={disabled || !chosen} value={chosen ? value : 0} aria-label={label}
                title="the file path (relative to the LUT folder) is saved with the photo, not the LUT data themselves"
                onChange={(e) => onChange(Number(e.target.value))}>
          {!chosen && <option value={0} />}
          {files.map((f) => <option key={f.hash ?? f.path} value={f.hash ?? 0}>{f.path}</option>)}
          {gone && <option value={lut?.current_hash ?? 0}>{`INVALID >> ${lut?.current}`}</option>}
        </select>
        {problem && <div className="note module-file-note">{problem}</div>}
      </div>
    );
  }
  const list = markers?.list ?? [];
  const known = list.some((m) => (m.hash ?? 0) === value);
  return (
    <div className="choice-row module-file" data-control-id="adv:wm_marker">
      <span>{label}</span>
      <select className="field" disabled={disabled} value={value} aria-label={label}
              title={markers ? `SVG watermarks in ${markers.dirs[1]} or ${markers.dirs[0]}` : undefined}
              onChange={(e) => onChange(Number(e.target.value))}>
        {!known && <option value={value} />}
        {list.map((m, k) => <option key={`${m.hash}-${k}`} value={m.hash ?? 0}>{m.label ?? m.path}</option>)}
      </select>
      <button type="button" className="tool" disabled={disabled} aria-label="Refresh the marker list" title="refresh the marker list"
              onClick={refresh}><RefreshCw size={16} strokeWidth={1.8} /></button>
      {problem && <div className="note module-file-note">{problem}</div>}
    </div>
  );
}
