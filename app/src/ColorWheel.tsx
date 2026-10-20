// a color grading wheel: the angle is color balance rgb's hue (0 at three
// o'clock, counter-clockwise, as Lightroom and RapidRAW draw it), the
// distance from the center its saturation. the disc is painted with the
// display hue each angle really produces (colorgrading.ts)
import { useEffect, useRef } from "react";
import { displayHue } from "./colorgrading";

const RES = 256; // pixels the disc is painted at; CSS scales it

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return [f(5), f(3), f(1)];
}

let painted: ImageData | null = null;
function disc(): ImageData {
  if (painted) return painted;
  const img = new ImageData(RES, RES);
  const c = RES / 2;
  for (let y = 0; y < RES; y++)
    for (let x = 0; x < RES; x++) {
      const dx = x + 0.5 - c, dy = c - (y + 0.5);
      const r = Math.hypot(dx, dy) / c;
      const i = 4 * (y * RES + x);
      if (r > 1) { img.data[i + 3] = 0; continue; }
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const [R, G, B] = hsvToRgb(displayHue(angle), r * 0.85, 0.95);
      img.data[i] = R * 255; img.data[i + 1] = G * 255; img.data[i + 2] = B * 255;
      // a soft edge instead of a jagged one
      img.data[i + 3] = 255 * Math.min(1, (1 - r) * c);
    }
  painted = img;
  return img;
}

export function ColorWheel({ hue, sat, size, disabled, onChange }: {
  hue: number;   // 0-359, color balance rgb's angle
  sat: number;   // 0-100
  size: string;  // CSS width; the wheel keeps itself square
  disabled: boolean;
  onChange: (hue: number, sat: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    const c = canvas.current!;
    c.width = RES; c.height = RES;
    c.getContext("2d")!.putImageData(disc(), 0, 0);
  }, []);

  const pick = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = r.top + r.height / 2 - e.clientY;
    const radius = Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    onChange(Math.round(angle) % 360, Math.round(radius * 100));
  };

  const a = (hue * Math.PI) / 180, k = sat / 100;
  return (
    <div className={`wheel${disabled ? " disabled" : ""}`} style={{ width: size }}
         onPointerDown={(e) => {
           if (disabled) return;
           (e.target as HTMLElement).setPointerCapture(e.pointerId);
           dragging.current = true;
           pick(e);
         }}
         onPointerMove={(e) => { if (dragging.current) pick(e); }}
         onPointerUp={() => { dragging.current = false; }}
         // double-click resets, as everywhere else
         onDoubleClick={() => !disabled && onChange(hue, 0)}>
      <canvas ref={canvas} />
      <span className="wheel-handle" style={{
        left: `${50 + 50 * k * Math.cos(a)}%`,
        top: `${50 - 50 * k * Math.sin(a)}%`,
      }} />
    </div>
  );
}

export type WheelMode = "3way" | "global" | "sliders";

// Color Grading's 3-Way / Global / Sliders switch and its wheels, for the
// main panel ("cg") and a mask's ("l_cg"). in Sliders the caller draws the
// sliders itself
export function GradingWheels({ prefix, mode, onMode, values, disabled, onChange, lum }: {
  prefix: string;
  mode: WheelMode;
  onMode: (mode: WheelMode) => void;
  values: Record<string, number>;
  disabled: boolean;
  onChange: (entries: [string, number][]) => void;
  lum: (id: string) => React.ReactNode;   // a range's luminance slider, under its wheel
}) {
  // one range's wheel and the luminance slider under it
  const wheel = (r: string, title: string) => {
    const hue = `${prefix}_${r}_hue`, sat = `${prefix}_${r}_sat`;
    return (
      <div className="wheel-cell" key={r}>
        <div className="wheel-title">{title}</div>
        <ColorWheel hue={values[hue] ?? 0} sat={values[sat] ?? 0} size="100%" disabled={disabled}
                    onChange={(h, s) => onChange([[hue, h], [sat, s]])} />
        <div className="wheel-readout">{`H ${Math.round(values[hue] ?? 0)}° · S ${Math.round(values[sat] ?? 0)}`}</div>
        <div className="wheel-lum">{lum(`${prefix}_${r}_lum`)}</div>
      </div>
    );
  };
  return (
    <>
      <div className="segmented tabs">
        {([["3way", "3-Way"], ["global", "Global"], ["sliders", "Sliders"]] as const).map(([m, label]) => (
          <button key={m} className={m === mode ? "active" : ""} onClick={() => onMode(m)}>{label}</button>
        ))}
      </div>
      {mode === "3way" && (
        <div className="wheels">
          {/* all three the same size; Midtones takes the top row alone */}
          <div className="wheel-row single">{wheel("midtones", "Midtones")}</div>
          <div className="wheel-row">
            {wheel("shadows", "Shadows")}
            {wheel("highlights", "Highlights")}
          </div>
        </div>
      )}
      {mode === "global" && <div className="wheels"><div className="wheel-row single wide">{wheel("global", "Global")}</div></div>}
    </>
  );
}
