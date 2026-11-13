// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the cluster previews and acquire buttons of the Color mapping card, after
// colormapping.c gui_init: "source clusters:" and its preview, "target
// clusters:" and its preview, then "acquire as source" and "acquire as
// target". A press analyzes the photo as it stands at the module's input and
// stores the clusters in the module (darktable does this on the preview pipe
// in its GUI; engine/cmapping.c does it for the engine) as one edit: the
// engine's field cm_source or cm_target takes the number the acquire replied
import { useState } from "react";
import { commands } from "./commands";
import type { AdvancedState } from "./session";
import { clusterSwatches, MAXN, PREVIEW_H, PREVIEW_W, type Side } from "./colormapping";

const LABEL: Record<Side, string> = { source: "source clusters:", target: "target clusters:" };
const TIP: Record<Side, string> = { source: "analyze this image as a source image", target: "analyze this image as a target image" };

export function ModuleClusters({ state, disabled, settle, onFields }: {
  state: AdvancedState; disabled: boolean;
  // waits for the card's edits to reach the engine (the cluster count)
  settle: () => Promise<void>;
  onFields: (edit: Record<string, number>, coalesce: boolean, id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const P = (path: string) => state.params[path] ?? state.defaults[path] ?? 0;
  const n = Math.min(MAXN, Math.max(0, Math.round(P("n"))));

  const acquire = async (side: Side) => {
    setBusy(true);
    setProblem("");
    try {
      await settle();
      const r = await commands.colormappingAcquire(side, n);
      onFields({ [side === "source" ? "cm_source" : "cm_target"]: r.hash }, false, `cm-${side}`);
    } catch (e) {
      setProblem(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="module-card-clusters" data-clusters="colormapping">
      {(["source", "target"] as const).map((side) => (
        <div key={side}>
          <div className="module-card-section">{LABEL[side]}</div>
          <svg className="clusters-area" viewBox={`0 0 ${PREVIEW_W} ${PREVIEW_H}`} data-side={side} aria-label={LABEL[side].replace(":", "")}
               style={{ aspectRatio: `${PREVIEW_W} / ${PREVIEW_H}` }} shapeRendering="crispEdges">
            <rect x={0} y={0} width={PREVIEW_W} height={PREVIEW_H} fill="rgb(51,51,51)" />
            {clusterSwatches(P, side, n).map((s, k) => <rect key={k} x={s.x} y={s.y} width={s.w} height={s.h} fill={s.color} />)}
          </svg>
        </div>
      ))}
      <div className="clusters-buttons">
        {(["source", "target"] as const).map((side) => (
          <button key={side} type="button" className="btn" data-control-id={`adv:acquire-${side}`} title={TIP[side]}
                  disabled={disabled || busy} onClick={() => void acquire(side)}>{`acquire as ${side}`}</button>
        ))}
      </div>
      {problem && <div className="note module-file-note">{problem}</div>}
    </div>
  );
}
