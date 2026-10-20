// Lightroom's Remove panel, Heal and Clone: the brush for new spots, the
// selected spot's own settings, and Visualize Spots
import type { Control } from "./manifest";
import type { SpotTool } from "./SpotOverlay";
import type { Spot } from "./spots";

export function HealPanel({ tool, spots, selected, visualize, disabled, renderSlider,
                            onTool, onSpot, onDelete, onClear, onVisualize }: {
  tool: SpotTool; spots: Spot[]; selected: number | null; visualize: number | null; disabled: boolean;
  renderSlider: (c: Control, value: number, onChange: (v: number) => void) => React.ReactNode;
  onTool: (t: SpotTool) => void;
  onSpot: (patch: Partial<Spot>) => void;  // the selected spot changed
  onDelete: () => void;
  onClear: () => void;
  onVisualize: (v: number | null) => void;
}) {
  const sel = selected !== null ? spots[selected] : undefined;
  // with a spot selected, the controls are its own, as in Lightroom; a
  // change is also kept for the next spot
  const mode = sel?.mode ?? tool.mode;
  const size = sel ? (sel.type === "circle" ? sel.r * 2 : sel.size) : tool.size;
  const feather = sel?.feather ?? tool.feather;
  const opacity = sel?.opacity ?? tool.opacity;
  const set = (patch: Partial<SpotTool>) => {
    onTool({ ...tool, ...patch });
    if (!sel) return;
    if (patch.size !== undefined)
      onSpot(sel.type === "circle" ? { r: patch.size / 2 } : { size: patch.size });
    else onSpot(patch as Partial<Spot>);
  };
  const pct = (v: number) => `${Math.round(v)}`;
  return (
    <div className="panel">
      <div className="panel-title"><span>Heal</span></div>
      <section>
        <div className="seg heal-mode">
          {(["heal", "clone"] as const).map((m) => (
            <button key={m} className={`btn small${mode === m ? " on" : ""}`} disabled={disabled}
                    title={m === "heal" ? "copy texture from the source, matched to the spot's color and light"
                                        : "copy the source as it is"}
                    onClick={() => set({ mode: m })}>{m === "heal" ? "Heal" : "Clone"}</button>
          ))}
        </div>
        {renderSlider({ id: "spot_size", label: "Size", min: 0.2, max: 20, step: 0.1, neutral: 3,
                        format: (v) => `${v.toFixed(1)}%` }, size * 100, (v) => set({ size: v / 100 }))}
        {renderSlider({ id: "spot_feather", label: "Feather", min: 0, max: 100, step: 1, neutral: 50, format: pct },
                      feather * 100, (v) => set({ feather: v / 100 }))}
        {renderSlider({ id: "spot_opacity", label: "Opacity", min: 0, max: 100, step: 1, neutral: 100, format: pct },
                      opacity * 100, (v) => set({ opacity: v / 100 }))}
        <div className="note-plain">
          {sel ? "drag the spot or its source to move them; Delete removes it"
               : "click a spot to heal it, or paint over a line"}
        </div>
        <div className="heal-actions">
          <button className="btn small" disabled={disabled || !sel} onClick={onDelete}>Delete spot</button>
          <button className="btn small" disabled={disabled || !spots.length} onClick={onClear}>
            Clear all{spots.length ? ` (${spots.length})` : ""}</button>
        </div>
      </section>
      <section>
        <label className="toggle">
          <span>Visualize spots (A)</span>
          <input type="checkbox" className="switch" checked={visualize !== null} disabled={disabled}
                 onChange={(e) => onVisualize(e.target.checked ? 50 : null)} />
        </label>
        {visualize !== null && renderSlider({ id: "spot_vis", label: "Threshold", min: 0, max: 100, step: 1,
                                              neutral: 50, format: pct }, visualize, (v) => onVisualize(v))}
      </section>
    </div>
  );
}
