// the Transform panel's view of the photo: Lightroom's grid while a
// Transform slider moves or Guided is on, and Guided Upright's guides. with
// Guided on, a drag on the photo draws a guide along what should be plumb
// or level, a drag on a guide's end moves that end, and Delete removes the
// selected guide; each one ends in a new fit. guides come and go in the
// shown frame, 0-1 across its width and height
import { useEffect, useRef, useState } from "react";

type Guide = [number, number, number, number];
// a guide shorter than this, in CSS pixels, was a click
const MIN_DRAG = 8;
const GRID = 8;

export function GuideOverlay({ image, guides, guided, grid, onCommit, onDelete }: {
  image: { w: number; h: number };   // the shown frame at 100%
  guides: Guide[];
  guided: boolean;                   // the Guided tool is on: guides show and draw
  grid: boolean;
  onCommit: (index: number | null, guide: Guide) => void;   // null: a new guide
  onDelete: (index: number) => void;
}) {
  const W = image.w, H = image.h;
  const svg = useRef<SVGSVGElement>(null);
  // a guide being drawn or an end being moved, until release
  const drag = useRef<{ index: number | null; end: 0 | 1; guide: Guide; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ index: number | null; guide: Guide } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [cssWidth, setCssWidth] = useState(1);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCssWidth(el.clientWidth || 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const unit = W / cssWidth;   // image pixels per CSS pixel
  useEffect(() => { if (selected !== null && selected >= guides.length) setSelected(null); }, [guides.length, selected]);
  useEffect(() => {
    if (!guided || selected === null) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      e.preventDefault();
      onDelete(selected);
      setSelected(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [guided, selected, onDelete]);

  const pointer = (e: React.PointerEvent): [number, number] => {
    const b = svg.current!.getBoundingClientRect();
    return [(e.clientX - b.left) / b.width, (e.clientY - b.top) / b.height];
  };
  const start = (index: number | null, end: 0 | 1) => (e: React.PointerEvent) => {
    if (!guided || e.button !== 0) return;
    // the viewer's pan and the Straighten line stay out of it
    e.stopPropagation();
    e.preventDefault();
    svg.current!.setPointerCapture(e.pointerId);
    const [u, v] = pointer(e);
    const guide: Guide = index === null ? [u, v, u, v] : [...guides[index]] as Guide;
    drag.current = { index, end, guide, x: e.clientX, y: e.clientY };
    setSelected(index);
    setDraft({ index, guide });
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [u, v] = pointer(e);
    d.guide = d.end === 0 ? [u, v, d.guide[2], d.guide[3]] : [d.guide[0], d.guide[1], u, v];
    setDraft({ index: d.index, guide: d.guide });
  };
  const finish = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    drag.current = null;
    setDraft(null);
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y) >= MIN_DRAG;
    const g = d.guide;
    const long = Math.hypot((g[2] - g[0]) * cssWidth, ((g[3] - g[1]) * cssWidth * H) / W) >= MIN_DRAG;
    if (moved && long) onCommit(d.index, g);
  };

  const shown = guides.map((g, i) => (draft && draft.index === i ? draft.guide : g));
  if (draft && draft.index === null) shown.push(draft.guide);
  const line = (g: Guide, i: number) => {
    const [x1, y1, x2, y2] = [g[0] * W, g[1] * H, g[2] * W, g[3] * H];
    const editable = i < guides.length;
    return (
      <g key={i} className={`tf-guide${selected === i ? " selected" : ""}`}>
        <line className="under" x1={x1} y1={y1} x2={x2} y2={y2} />
        <line x1={x1} y1={y1} x2={x2} y2={y2} />
        {editable && <line className="hit" x1={x1} y1={y1} x2={x2} y2={y2}
                           onPointerDown={(e) => { if (!guided) return; e.stopPropagation(); setSelected(i); }} />}
        {editable && ([[x1, y1], [x2, y2]] as const).map(([x, y], end) => (
          <circle key={end} className="end" cx={x} cy={y} r={5 * unit} onPointerDown={start(i, end as 0 | 1)} />
        ))}
      </g>
    );
  };

  return (
    <>
      {grid && <div className="tf-grid" style={{ ["--cells" as string]: GRID }} />}
      <svg ref={svg} className={`mask-svg tf-guides${guided ? " drawing" : ""}`} viewBox={`0 0 ${W} ${H}`}
           preserveAspectRatio="none"
           onPointerDown={start(null, 1)} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish}>
        {guided && shown.map(line)}
      </svg>
    </>
  );
}
