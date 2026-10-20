// the quick start guide: a spotlight that moves from one part of the window
// to the next with a short note on each, shown on start until its checkbox
// says not to, and on request from the title bar. its targets carry
// data-tour attributes. a hand-drawn arrow runs from the note to what it
// describes; a step with callouts lights a group (the rail's edit tools)
// and points an arrow at each member from its own note
import { useEffect, useLayoutEffect, useState } from "react";
import { keys } from "./keys";

type Callout = { target: string; title: string; body: string };
type Step = { target?: string; title: string; body: string; callouts?: Callout[] };

const STEPS: Step[] = [
  { title: "Welcome to Immage",
    body: "A quick look at the whole workflow: bringing photos in, editing them and sending them out. It takes about a minute; Esc skips it." },
  { target: "import", title: "Import",
    body: keys("Copy photos off a card or a folder. Ones already in the destination, or in Immich, are marked, and the new ones open here when it is done. ⇧⌘I.") },
  { target: "folders", title: "Your folders",
    body: "Folders you add, or import into, stay listed; open one to see its subfolders. Edits are saved next to each photo as an XMP sidecar." },
  { target: "immich", title: "Immich",
    body: "Search your Immich library by words, people, places or albums, and edit what it finds as if it were local. It shows once your server is set up in Preferences." },
  { target: "filmstrip", title: "Pick a photo",
    body: "The filmstrip shows the folder. Click a photo, or use the arrow keys; 1 to 5 rate it and X rejects it." },
  { target: "viewer", title: "Look closely",
    body: "Click to zoom to 100% at that point and click again to fit. Scroll to zoom, drag to pan; press \\ for before, and Y steps through the before and after views." },
  { target: "edit", title: "Edit",
    body: keys("The editing tools sit together on the right; each opens its own panel. ⌘Z undoes any of them."),
    callouts: [
      { target: "adjust", title: "Adjustments",
        body: "The familiar develop panels. Drag a slider or scroll over it; double-click resets it." },
      { target: "crop", title: "Crop",
        body: "Aspect ratios, straighten and rotate. R opens it, Enter applies." },
      { target: "masks", title: "Masks",
        body: "Brush, gradients, ranges and AI selections: adjust just one part." },
      { target: "zones", title: "Zone System",
        body: "Black and white tones as zones 0–X: see where each falls, then place or adjust it." },
      { target: "heal", title: "Heal",
        body: "Click a spot or paint over a line to remove it. Q opens it." },
      { target: "presets", title: "Presets",
        body: "Live previews of presets and film looks; save your own." },
    ] },
  { target: "history", title: "History",
    body: keys("Every edit as a step, newest at the top. Click one to go back to it; ⌘Z and ⇧⌘Z step through them.") },
  { target: "export", title: "Export",
    body: keys("Export the photo, or every photo shown, to a folder or straight into an Immich album, with borders and file names of your choosing. ⇧⌘E.") },
  { target: "prefs", title: "Preferences",
    body: keys("What new photos start with (profile and a preset), and your Immich server. ⌘, opens them.") },
];

const PAD = 8; // around the spotlight, in pixels

export function Tour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [hide, setHide] = useState(tourSeen);
  const close = () => { setTourSeen(hide); onClose(); };
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [callRects, setCallRects] = useState<(DOMRect | null)[]>([]);
  const s = STEPS[step];

  // where the spotlight goes: its target as it is now on screen; a step
  // whose target is hidden (a closed panel) shows its note in the middle
  useLayoutEffect(() => {
    const el = s.target ? document.querySelector(`[data-tour="${s.target}"]`) : null;
    // a target scrolled out of its panel (a long folder list) comes into
    // view, and only its visible part is lit
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    const measure = () => {
      setCallRects((s.callouts ?? []).map((c) => {
        const r = document.querySelector(`[data-tour="${c.target}"]`)?.getBoundingClientRect();
        return r && r.width > 4 ? r : null;
      }));
      const r = el?.getBoundingClientRect();
      if (!r || r.width <= 4 || r.height <= 4) { setRect(null); return; }
      const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, window.innerHeight - 8);
      setRect(bottom - top > 4 ? new DOMRect(r.left, top, r.width, bottom - top) : null);
    };
    // the panels may still be sliding open when a step starts
    measure();
    const t = window.setTimeout(measure, 320);
    window.addEventListener("resize", measure);
    return () => { window.clearTimeout(t); window.removeEventListener("resize", measure); };
  }, [step]);

  const go = (k: number) => {
    if (k < 0) return;
    if (k >= STEPS.length) close();
    else setStep(k);
  };

  // its own keys, ahead of the app's (arrows would change the photo)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") go(step + 1);
      else if (e.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, hide]);

  const vw = window.innerWidth, vh = window.innerHeight;
  const spot = rect
    ? { left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD }
    : { left: vw / 2, top: vh / 2, width: 0, height: 0 };

  // the note sits beside the spotlight on the roomier side, kept on screen
  const CARD_W = 320, CARD_H = 216;
  let card: { left: number; top: number };
  const notes = rect && s.callouts ? layoutCallouts(s.callouts, callRects, rect, vh) : null;
  if (!rect) card = { left: (vw - CARD_W) / 2, top: (vh - CARD_H) / 2 };
  else if (notes) {
    // left of the callouts, out of the arrows' way
    card = { left: Math.max(12, notes.left - CARD_W - 48), top: Math.min(vh - CARD_H - 12, Math.max(12, rect.top + rect.height / 2 - CARD_H / 2)) };
  } else {
    const right = vw - (spot.left + spot.width), left = spot.left;
    const below = vh - (spot.top + spot.height);
    // far enough off for the arrow between them
    const GAP = 72;
    if (Math.max(right, left) >= CARD_W + GAP + 12)
      card = { left: right >= left ? spot.left + spot.width + GAP : spot.left - CARD_W - GAP,
               top: spot.top + spot.height / 2 - CARD_H / 2 };
    else card = { left: spot.left + spot.width / 2 - CARD_W / 2,
                  top: below >= CARD_H + GAP + 12 ? spot.top + spot.height + GAP : spot.top - CARD_H - GAP };
    card.left = Math.min(vw - CARD_W - 12, Math.max(12, card.left));
    card.top = Math.min(vh - CARD_H - 12, Math.max(12, card.top));
  }

  return (
    <div className="tour" onPointerDown={(e) => e.stopPropagation()}>
      <div className={`tour-spot${rect ? " ring" : ""}`} style={spot} />
      {rect && !notes && (
        <svg key={`arrow-${step}`} className="tour-arrows" width={vw} height={vh}>
          <SketchArrow {...cardArrow(card, CARD_W, CARD_H, spot)} seed={step} />
        </svg>
      )}
      {notes && (
        <>
          <svg key={`arrows-${step}`} className="tour-arrows" width={vw} height={vh}>
            {notes.items.map((n, k) => <SketchArrow key={k} from={n.from} to={n.to} seed={k} />)}
          </svg>
          {notes.items.map((n, k) => (
            <div key={`${step}-${k}`} className="tour-callout"
                 style={{ left: notes.left, top: n.top, width: CALLOUT_W, animationDelay: `${120 + k * 90}ms` }}>
              <h4>{n.title}</h4>
              <p>{n.body}</p>
            </div>
          ))}
        </>
      )}
      <div className="tour-card" style={{ left: card.left, top: card.top, width: CARD_W }}>
        <div key={step} className="tour-text">
          <div className="tour-count">{step + 1} of {STEPS.length}</div>
          <h3>{s.title}</h3>
          <p>{s.body}</p>
        </div>
        <label className="tour-hide">
          <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
          Don't show on startup
        </label>
        <div className="tour-foot">
          <div className="tour-dots">
            {STEPS.map((_, k) => <span key={k} className={k === step ? "on" : ""} onClick={() => setStep(k)} />)}
          </div>
          <button className="btn small" onClick={close}>Skip</button>
          {step > 0 && <button className="btn small" onClick={() => go(step - 1)}>Back</button>}
          <button className="btn small primary" onClick={() => go(step + 1)}>
            {step === STEPS.length - 1 ? "Done" : "Next"}</button>
        </div>
      </div>
    </div>
  );
}

// callout notes: a column left of the lit group, evenly stacked around its
// middle, each with an arrow from its title to its icon
const CALLOUT_W = 236;
function layoutCallouts(callouts: Callout[], rects: (DOMRect | null)[], group: DOMRect, vh: number) {
  // a note's height, from its text: a title line and wrapped body lines
  const height = (c: Callout) => 30 + Math.ceil(c.body.length / 34) * 17;
  const GAP = 14;
  const right = group.left - PAD - 84;
  const total = callouts.reduce((h, c) => h + height(c) + GAP, -GAP);
  let top = Math.min(vh - 12 - total, Math.max(12, group.top + group.height / 2 - total / 2));
  const items = callouts.map((c, k) => {
    const r = rects[k];
    const h = height(c);
    const item = {
      ...c, top,
      from: { x: right + 6, y: top + 13 },
      to: r ? { x: r.left - 6, y: r.top + r.height / 2 } : { x: group.left - 6, y: top + 13 },
    };
    top += h + GAP;
    return item;
  });
  return { left: right - CALLOUT_W, items };
}

// the arrow from a step's card to its spotlight: from the card's side that
// faces it to the spotlight's nearest edge, or its middle when they overlap
type Box = { left: number; top: number; width: number; height: number };
function cardArrow(card: { left: number; top: number }, w: number, h: number, spot: Box) {
  const cx = card.left + w / 2, cy = card.top + h / 2;
  const sx = spot.left + spot.width / 2, sy = spot.top + spot.height / 2;
  const clampY = (y: number) => Math.min(spot.top + spot.height - 12, Math.max(spot.top + 12, y));
  const clampX = (x: number) => Math.min(spot.left + spot.width - 12, Math.max(spot.left + 12, x));
  if (card.left >= spot.left + spot.width)
    return { from: { x: card.left - 6, y: cy - 30 }, to: { x: spot.left + spot.width + 4, y: clampY(cy - 30) } };
  if (card.left + w <= spot.left)
    return { from: { x: card.left + w + 6, y: cy - 30 }, to: { x: spot.left - 4, y: clampY(cy - 30) } };
  if (card.top >= spot.top + spot.height)
    return { from: { x: cx, y: card.top - 6 }, to: { x: clampX(cx), y: spot.top + spot.height + 4 } };
  if (card.top + h <= spot.top)
    return { from: { x: cx, y: card.top + h + 6 }, to: { x: clampX(cx), y: spot.top - 4 } };
  return { from: { x: cx, y: card.top - 6 }, to: { x: sx, y: sy } };
}

// a hand-drawn arrow: a bowed stroke with a little wobble, drawn twice a
// hair apart as a pen would, and an open head; `seed` varies each one
function SketchArrow({ from, to, seed }: { from: { x: number; y: number }; to: { x: number; y: number }; seed: number }) {
  const j = (k: number) => Math.sin(seed * 12.9898 + k * 78.233) * 0.5;  // steady, made-up randomness
  const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
  // bowed to one side of the straight line, by a share of its length
  const b = (dy > 0 ? -1 : 1) * Math.min(28, 0.18 * len) * (1 + 0.4 * j(1));
  const nx = -dy / len * b, ny = dx / len * b;
  const c1 = { x: from.x + dx * 0.33 + nx, y: from.y + dy * 0.33 + ny };
  const c2 = { x: from.x + dx * 0.72 + nx * 0.5, y: from.y + dy * 0.72 + ny * 0.5 };
  const d = (o: number) => `M${from.x + o},${from.y - o} C${c1.x + 2 * j(2)},${c1.y + o} ${c2.x},${c2.y - o} ${to.x},${to.y}`;
  const a = Math.atan2(to.y - c2.y, to.x - c2.x), L = 11;
  const head = [a + 2.65 + 0.1 * j(3), a - 2.65 + 0.1 * j(4)]
    .map((t) => `M${to.x},${to.y} L${to.x + L * Math.cos(t)},${to.y + L * Math.sin(t)}`).join(" ");
  // drawn in turn, each head once its line is down
  const delay = 120 + seed * 90;
  return (
    <g className="sketch">
      <path d={d(0)} pathLength={1} style={{ animationDelay: `${delay}ms` }} />
      <path d={d(0.9)} pathLength={1} className="faint" style={{ animationDelay: `${delay + 60}ms` }} />
      <path d={head} className="head" style={{ animationDelay: `${delay + 520}ms` }} />
    </g>
  );
}

const TOUR_KEY = "immage.tour.done";
export const tourSeen = () => { try { return localStorage.getItem(TOUR_KEY) === "1"; } catch { return false; } };
export const setTourSeen = (seen: boolean) => {
  try { if (seen) localStorage.setItem(TOUR_KEY, "1"); else localStorage.removeItem(TOUR_KEY); } catch { /* as it was */ }
};
