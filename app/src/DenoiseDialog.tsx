// AI Denoise's dialog, as Lightroom's Denoise asks: how much, before
// darktable's raw denoise writes the new DNG (App.tsx, runDenoise). a piece
// of the photo at 1:1 shows the result, as darktable's neural restore
// previews it: the engine renders the piece without and with the denoise
// once (ai_denoise_preview), and Amount mixes the two here, at once. the
// small photo beside it moves the piece, as the Navigator moves the view
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const AMOUNT_KEY = "immage.denoiseAmount";
function loadAmount(): number {
  try {
    const v = Number(localStorage.getItem(AMOUNT_KEY));
    return Number.isFinite(v) && v > 0 && v <= 100 ? v : 100;
  } catch { return 100; }
}

// the preview box, in CSS pixels; the piece fills it at 1:1 device pixels,
// up to what the model takes in one tile
const BOX = 480;

type Piece = { width: number; height: number; rectW: number; rectH: number; before: Float32Array; after: Float32Array };

// linear to sRGB 8-bit, for the mix: the engine's pixels are linear Rec.709
const LUT_SIZE = 4096;
const TO_SRGB = (() => {
  const t = new Uint8ClampedArray(LUT_SIZE + 1);
  for (let i = 0; i <= LUT_SIZE; i++) {
    const x = i / LUT_SIZE;
    t[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }
  return t;
})();

export function DenoiseDialog({ thumb, center, prepare, onRun, onClose }: {
  thumb: React.RefObject<HTMLCanvasElement | null>;
  center: { u: number; v: number };          // where the piece starts: the view's center
  prepare: () => Promise<void>;              // the model, downloaded on first use
  onRun: (amount: number) => void;
  onClose: () => void;
}) {
  const [amount, setAmount] = useState(loadAmount);
  const [piece, setPiece] = useState<Piece | null>(null);
  const [at, setAt] = useState(center);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const view = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const ready = useRef<Promise<void> | null>(null);
  const seq = useRef(0);

  // the piece at (u, v); a newer request overtakes an older one's reply
  const fetchPiece = async (u: number, v: number) => {
    const n = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      ready.current ??= prepare();
      await ready.current;
      const size = Math.round(BOX * (window.devicePixelRatio || 1));
      const buf = await invoke<ArrayBuffer>("ai_denoise_preview", { u, v, size });
      if (n !== seq.current) return;
      const head = new DataView(buf, 0, 16);
      const width = head.getUint32(0, true), height = head.getUint32(4, true);
      const count = width * height * 3;
      setPiece({
        width, height, rectW: head.getFloat32(8, true), rectH: head.getFloat32(12, true),
        before: new Float32Array(buf, 16, count), after: new Float32Array(buf, 16 + 4 * count, count),
      });
    } catch (e) {
      ready.current = null;
      if (n === seq.current) setError(String(e));
    } finally {
      if (n === seq.current) setBusy(false);
    }
  };
  useEffect(() => { void fetchPiece(center.u, center.v); }, []);

  // the small photo: the Navigator's
  useEffect(() => {
    const src = thumb.current, dst = overview.current;
    if (!src || !dst || !src.width) return;
    dst.width = src.width;
    dst.height = src.height;
    dst.getContext("2d")?.drawImage(src, 0, 0);
  }, [thumb]);

  // the mix, redrawn as Amount moves; held, the piece without the denoise
  useEffect(() => {
    const c = view.current;
    if (!c || !piece) return;
    const raf = requestAnimationFrame(() => {
      const { width, height, before, after } = piece;
      c.width = width;
      c.height = height;
      const dpr = window.devicePixelRatio || 1;
      c.style.width = `${width / dpr}px`;
      c.style.height = `${height / dpr}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const img = ctx.createImageData(width, height);
      const a = holding ? 0 : amount / 100, b = 1 - a;
      const px = img.data;
      for (let i = 0, o = 0; i < before.length; i += 3, o += 4) {
        for (let k = 0; k < 3; k++) {
          const x = b * before[i + k] + a * after[i + k];
          px[o + k] = TO_SRGB[x <= 0 ? 0 : x >= 1 ? LUT_SIZE : (x * LUT_SIZE) | 0];
        }
        px[o + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [piece, amount, holding]);

  const run = () => {
    try { localStorage.setItem(AMOUNT_KEY, String(amount)); } catch { /* not kept */ }
    onRun(amount);
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // a point on the small photo, kept so the piece stays inside it
  const rw = piece?.rectW ?? 0, rh = piece?.rectH ?? 0;
  const pointAt = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const keep = (x: number, half: number) => Math.min(1 - half, Math.max(half, x));
    return { u: keep((e.clientX - r.left) / r.width, rw / 2), v: keep((e.clientY - r.top) / r.height, rh / 2) };
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal denoise">
        <div className="modal-head"><h2>AI Denoise</h2></div>
        <div className="modal-body denoise-body">
          <div className="denoise-view" title="hold to see it without AI Denoise"
               onPointerDown={() => setHolding(true)} onPointerUp={() => setHolding(false)}
               onPointerLeave={() => setHolding(false)}>
            <canvas ref={view} />
            {(busy || error) && (
              <div className={`denoise-state${error ? " error" : ""}`}>{error ?? "previewing…"}</div>
            )}
            {holding && piece && <div className="denoise-tag">Before</div>}
          </div>
          <div className="denoise-side">
            <div className="nav-image denoise-overview"
                 onPointerDown={(e) => {
                   (e.target as HTMLElement).setPointerCapture(e.pointerId);
                   setDragging(true);
                   setAt(pointAt(e));
                 }}
                 onPointerMove={(e) => { if (dragging) setAt(pointAt(e)); }}
                 onPointerUp={(e) => {
                   if (!dragging) return;
                   setDragging(false);
                   const p = pointAt(e);
                   setAt(p);
                   void fetchPiece(p.u, p.v);
                 }}>
              <canvas ref={overview} />
              {piece && (
                <div className="nav-rect" style={{
                  left: `${(at.u - rw / 2) * 100}%`, top: `${(at.v - rh / 2) * 100}%`,
                  width: `${rw * 100}%`, height: `${rh * 100}%`,
                }} />
              )}
            </div>
            <p className="note-plain">drag on the photo to preview another part</p>
            <div className="row">
              <span className="k">Amount</span>
              <input type="range" min={1} max={100} step={1} value={amount}
                     onChange={(e) => setAmount(Number(e.target.value))} />
              <span className="num">{amount}</span>
            </div>
            <p className="note-plain">
              darktable's raw denoise writes a new DNG beside the raw, with this photo's edit and noise
              reduction off, and opens it. it takes up to a minute
            </p>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={run}>Denoise</button>
        </div>
      </div>
    </div>
  );
}
