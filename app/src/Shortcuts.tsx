// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's Keyboard Shortcuts sheet (⌘/): every key the app answers,
// by where it works. the handlers live in App.tsx; keep this list with them
import { useEffect } from "react";
import { cmd, keys } from "./keys";

type Group = { title: string; keys: [string, string][] };

const GROUPS: Group[] = [
  {
    title: "General",
    keys: [
      ["⇧⌘I", "Import photos"],
      ["⇧⌘E", "Export"],
      ["⌘,", "Preferences"],
      ["⌘/", "Keyboard shortcuts"],
      ["⇧⌘P", "Performance overlay"],
      ["⌘Z", "Undo"],
      ["⇧⌘Z", "Redo"],
      ["⇧⌘C", "Copy settings"],
      ["⇧⌘V", "Paste settings"],
      ["⌥⌘V", "Paste the previous photo's settings"],
      ["⌘'", "Create virtual copy, of every selected photo"],
    ],
  },
  {
    title: "View",
    keys: [
      ["F", "Full screen preview (F or Esc leaves)"],
      ["L", "Next canvas: dark, neutral gray, white"],
      ["Tab", "Hide or show the side panels"],
      ["⇧Tab", "Hide or show the side panels and filmstrip"],
      ["Z", "Fit or the navigator's zoom (100% until another is picked)"],
      ["⌘= ⌘-", "Zoom in or out: fit, fill, 1:1, 2:1, 3:1, 4:1"],
      ["Click", "Zoom to 100% there, or back to fit"],
      ["Scroll", "Zoom around the pointer (a brush in hand: its size)"],
      ["\\", "Before"],
      ["Y", "Next before / after view: side by side, split left / right, split top / bottom, hold for before"],
      ["C", "Compare with another photo (← → step it, Esc leaves)"],
      ["J", "Show or hide shadow and highlight clipping"],
      ["I", "Cycle the info over the photo: file and capture, exposure and lens, none"],
    ],
  },
  {
    title: "Photos",
    keys: [
      ["← →", "Previous or next photo"],
      ["0 – 5", "Rating, for every selected photo"],
      ["6 – 9", "Red, yellow, green or blue label, for every selected photo"],
      ["X", "Reject"],
      ["⌘-click", "In the filmstrip: add a photo to the selection, or take it out"],
      ["⇧-click", "In the filmstrip: select the run from the open photo"],
      ["G", "Grid view of the folder (G or Esc goes back)"],
    ],
  },
  {
    title: "Adjustments",
    keys: [
      ["W", "White balance picker (Esc cancels)"],
      ["Double-click", "A slider or its name: reset it"],
      ["Double-click", "A slider's value: type one"],
      ["⇧-drag", "A slider: a tenth of the movement, for fine changes"],
      ["Scroll", "Over a slider: nudge it, when Preferences allows"],
      ["⌥-click", "A panel's title: open it alone (in focus mode, alongside the others)"],
    ],
  },
  {
    title: "Crop",
    keys: [
      ["R", "Crop tool; R or Enter applies"],
      ["Esc", "Leave the crop tool without applying"],
      ["X", "Swap the aspect between landscape and portrait"],
      ["⇧-drag", "Straighten: along what should be level or upright"],
      ["⌘[", "Rotate left"],
      ["⌘]", "Rotate right"],
    ],
  },
  {
    title: "Masks",
    keys: [
      ["K", "Brush"],
      ["M", "Linear gradient"],
      ["⇧M", "Radial gradient"],
      ["⇧J", "Color range"],
      ["⇧Q", "Luminance range"],
      ["[ ]", "Brush size"],
      ["Scroll", "With the brush: its size; ⇧ its feather"],
      ["⌥-drag", "Brush away"],
      ["O", "Show or hide the overlay"],
      ["Esc", "Put the tool down"],
    ],
  },
  {
    title: "Zone System",
    keys: [
      ["O", "Show or hide the pinned zones' overlay"],
      ["← →", "Move the pinned zones (with the zones focused)"],
      ["⇧← ⇧→", "Grow or shrink the run of zones"],
      ["Esc", "Unpin"],
    ],
  },
  {
    title: "Heal and Clone",
    keys: [
      ["Q", "Heal and clone"],
      ["[ ]", "Brush size"],
      ["Scroll", "Brush size; ⇧ its feather"],
      ["A", "Visualize spots"],
      ["Delete", "Remove the selected spot"],
      ["Esc", "Deselect the spot"],
    ],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (cmd(e) && e.code === "Slash")) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal shortcuts">
        <div className="modal-head"><h2>Keyboard Shortcuts</h2></div>
        <div className="modal-body shortcut-groups">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <dl>
                {g.keys.map(([k, what], i) => (
                  <div key={i}><dt><kbd>{keys(k)}</kbd></dt><dd>{keys(what)}</dd></div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}
