// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The photo of the Composite card (overlay.c's drop area). darktable shows the
// chosen photo's thumbnail there and takes a thumbnail dragged from the
// lighttable. Immage has no lighttable beside the editor, so the card shows
// the same thumbnail with a Choose photo button, which lists the photos of the
// folder being browsed, and a Clear button (the card's reset clears it as
// gui_reset does). The choice is a write of the module's `imgid`: the engine
// refuses a photo that composites this one, directly or through others, as
// darktable's drop does (engine/files.c), and the card then reads its state
// back from the engine
import { useEffect, useRef, useState } from "react";
import { commands } from "./commands";
import { fetchThumb, type ImageEntry } from "./library";

function Thumb({ imgid, entry, width, height }: { imgid: number; entry?: ImageEntry; width: number; height: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchThumb(imgid, 2 * Math.max(width, height), entry).then((bmp) => {
      const c = canvas.current;
      if (!live || !c) return;
      const k = Math.min(c.width / bmp.width, c.height / bmp.height);
      const w = bmp.width * k, h = bmp.height * k;
      const g = c.getContext("2d");
      g?.clearRect(0, 0, c.width, c.height);
      g?.drawImage(bmp, (c.width - w) / 2, (c.height - h) / 2, w, h);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [imgid, entry?.path, width, height]);
  return failed ? <div className="photo-thumb missing" style={{ width, height }}>missing</div>
    : <canvas ref={canvas} className="photo-thumb" width={2 * width} height={2 * height} style={{ width, height }} />;
}

export function ModulePhoto({ label, value, disabled, photos, onChange }: {
  label: string; value: number; disabled: boolean;
  // the photos of the folder being browsed, from which one is chosen
  photos: ImageEntry[];
  onChange: (imgid: number) => void;
}) {
  const [picking, setPicking] = useState(false);
  const chosen = value > 0;
  const entry = photos.find((p) => p.imgid === value);
  // the photo's name, from the folder when it is there, otherwise the library's
  const [name, setName] = useState("");
  useEffect(() => {
    if (!chosen) { setName(""); return; }
    if (entry) { setName(entry.filename); return; }
    let live = true;
    commands.meta(value).then((r) => { if (live) setName(r.image.filename); }).catch(() => { if (live) setName(""); });
    return () => { live = false; };
  }, [value, chosen, entry?.filename]);
  return (
    <div className="module-photo" data-control-id="adv:imgid">
      <div className="choice-row"><span>{label}</span></div>
      <div className="photo-row">
        {chosen ? <Thumb imgid={value} entry={entry} width={96} height={72} />
          : <div className="photo-thumb empty" style={{ width: 96, height: 72 }} title="no photo chosen">no photo</div>}
        <div className="photo-side">
          <div className="photo-name" title={name || undefined}>{chosen ? name || `Photo ${value}` : "No photo chosen"}</div>
          <div className="photo-buttons">
            <button type="button" className="btn small" disabled={disabled} onClick={() => setPicking(true)}
                    title="choose the photo to put over this one">Choose photo</button>
            <button type="button" className="btn small" disabled={disabled || !chosen} onClick={() => onChange(0)}
                    title="take the photo off the composite">Clear</button>
          </div>
        </div>
      </div>
      {picking && (
        <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) setPicking(false); }}>
          <div className="modal photo-picker" role="dialog" aria-label="Choose photo">
            <div className="modal-head"><h2>Choose photo</h2></div>
            <div className="modal-body">
              {photos.length === 0 ? <p className="note-plain">The folder has no photos to choose from. Open a folder first.</p> : (
                <div className="photo-picker-grid">
                  {photos.map((p) => (
                    <button key={p.imgid} type="button" className={`photo-pick${p.imgid === value ? " active" : ""}`} title={p.filename}
                            onClick={() => { setPicking(false); if (p.imgid !== value) onChange(p.imgid); }}>
                      <Thumb imgid={p.imgid} entry={p} width={96} height={72} />
                      <span>{p.filename}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-foot"><button className="btn" onClick={() => setPicking(false)}>Cancel</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
