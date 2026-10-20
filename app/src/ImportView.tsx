// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Lightroom's import screen: the SD card importer (immporter/) over the whole
// window, below the title strip. the editor stays mounted underneath, so
// closing returns to it as it was. loaded on first use
import { lazy, Suspense } from "react";
import type { ImportResult } from "@immporter/embed";

const Importer = lazy(async () => {
  const m = await import("@immporter/embed");
  return { default: m.ImmporterView };
});

// whether an import is running: Close waits for it, as the copy would go on
// without anything showing it
const CloseButton = lazy(async () => {
  const m = await import("@immporter/embed");
  return {
    default: ({ onClose }: { onClose: () => void }) => {
      const importing = m.useImporting();
      return (
        <button className="btn small" disabled={importing} onClick={onClose}
                title={importing ? "an import is running" : "back to editing"}>Close</button>
      );
    },
  };
});

export function ImportView({ onClose, onImportDone, onShowImported, onOpenSettings }: {
  onClose: () => void;
  onImportDone: (r: ImportResult) => void;
  onShowImported: (r: ImportResult) => void;
  onOpenSettings?: () => void;
}) {
  return (
    <div className="import-view">
      <div className="import-head">
        <h1>Import</h1>
        <Suspense fallback={null}><CloseButton onClose={onClose} /></Suspense>
      </div>
      <div className="import-body">
        <Suspense fallback={<div className="note-plain">loading the importer…</div>}>
          <Importer onImportDone={onImportDone} onShowImported={onShowImported} onOpenSettings={onOpenSettings} />
        </Suspense>
      </div>
    </div>
  );
}
