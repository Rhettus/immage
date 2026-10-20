// the open image's metadata as Lightroom's Metadata panel lays it out: its
// text fields, rating and labels editable, its EXIF shown
import { useEffect, useState } from "react";
import { baseName } from "./paths";
import { LABEL_COLORS, type Exif, type ImageEntry } from "./library";


export type TextFields = { title: string; description: string; rights: string; creator: string };

// Lightroom's names for darktable's fields
const EDITABLE: [keyof TextFields, string][] = [
  ["title", "Title"], ["description", "Caption"], ["rights", "Copyright"], ["creator", "Creator"],
];

type FullExif = Exif & {
  crop_factor: number; white_balance: string; flash: string; exposure_program: string;
  metering_mode: string; file_width: number; file_height: number;
};

// darktable's "not recorded" for floats is -FLT_MAX or 0
export const known = (v: number | undefined) => v !== undefined && Number.isFinite(v) && Math.abs(v) < 1e30;

// the shot's ISO, focal length, aperture and shutter speed, as Lightroom
// lists them under its histogram; a value the camera did not record is left out
export function exposureLine(e: Exif): string[] {
  return [
    known(e.iso) && e.iso > 0 ? `ISO ${Math.round(e.iso)}` : "",
    known(e.focal_length) && e.focal_length > 0 ? `${+e.focal_length.toFixed(1)} mm` : "",
    known(e.aperture) && e.aperture > 0 ? `ƒ / ${+e.aperture.toFixed(1)}` : "",
    shutter(e.exposure),
  ].filter(Boolean);
}

export function shutter(t: number): string {
  if (!known(t) || t <= 0) return "";
  if (t >= 1) return `${+t.toFixed(1)} sec`;
  return `1/${Math.round(1 / t)} sec`;
}

export function captureDate(exif: string): string {
  // "YYYY:MM:DD HH:MM:SS.mmm"
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(exif);
  if (!m) return exif;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function MetadataPanel({ image, text, onText, onMeta, open, onToggle }: {
  image: ImageEntry | null;
  text: TextFields | null;
  onText: (field: keyof TextFields, value: string) => void;
  onMeta: (fields: Partial<ImageEntry>) => void;
  open: boolean;
  onToggle: (alt: boolean) => void;
}) {
  if (!image) return null;
  const e = image.exif as FullExif;
  const folder = image.path.slice(0, image.path.length - image.filename.length - 1);
  const mp = e.file_width * e.file_height / 1e6;
  const rows: [string, string][] = [
    ["Capture Date", e.datetime ? captureDate(e.datetime) : ""],
    ["File Dimensions", e.file_width ? `${e.file_width} × ${e.file_height}` : ""],
    ["Megapixels", mp ? `${mp.toFixed(1)} MP` : ""],
    ["Subject Distance", known(e.focus_distance) && e.focus_distance > 0 ? `${+e.focus_distance.toFixed(2)} m` : ""],
    ["Focal Length", known(e.focal_length) && e.focal_length > 0 ? `${+e.focal_length.toFixed(1)} mm` : ""],
    ["Focal Length 35mm", known(e.crop_factor) && e.crop_factor > 0 && e.focal_length > 0
      ? `${Math.round(e.focal_length * e.crop_factor)} mm` : ""],
    ["F-Stop", known(e.aperture) && e.aperture > 0 ? `ƒ / ${+e.aperture.toFixed(1)}` : ""],
    ["Shutter Speed", shutter(e.exposure)],
    ["ISO Speed Rating", known(e.iso) && e.iso > 0 ? `ISO ${Math.round(e.iso)}` : ""],
    ["Exposure Bias", known(e.exposure_bias) && e.exposure_bias !== 0
      ? `${e.exposure_bias > 0 ? "+" : ""}${+e.exposure_bias.toFixed(2)} EV` : ""],
    ["Flash", e.flash],
    ["Exposure Program", e.exposure_program],
    ["Metering Mode", e.metering_mode],
    ["White Balance", e.white_balance],
    ["Lens", e.lens === "n/a" ? "" : e.lens],
    ["Model", e.model],
    ["Make", e.maker],
  ];
  return (
    <div className="panel metadata">
      <div className={`panel-title${open ? " open" : ""}`} onClick={(e) => onToggle(e.altKey)}>
        <span>Metadata</span>
        <svg className={`chevron${open ? " open" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
      </div>
      {open && (
        <div className="meta-grid">
          <span className="k">File Name</span><span className="v" title={image.filename}>{image.filename}</span>
          <span className="k">Folder</span><span className="v" title={folder}>{baseName(folder)}</span>
          {EDITABLE.map(([field, label]) => (
            <TextRow key={`${image.imgid}-${field}`} label={label} value={text?.[field] ?? ""}
                     disabled={!text} onCommit={(v) => onText(field, v)} />
          ))}
          <span className="k">Rating</span>
          <span className="v stars-edit">
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={!image.rejected && image.rating >= n ? "on" : ""}
                      title={`${n} star${n > 1 ? "s" : ""}`}
                      onClick={() => onMeta({ rating: image.rating === n ? 0 : n, rejected: false })}>★</button>
            ))}
          </span>
          <span className="k">Label</span>
          <span className="v labels-edit">
            {LABEL_COLORS.map((c, k) => (
              <button key={c} className={`swatch${image.labels & (1 << k) ? " on" : ""}`} style={{ background: c }}
                      onClick={() => onMeta({ labels: image.labels ^ (1 << k) })} />
            ))}
          </span>
          <span className="gap" />
          {rows.filter(([, v]) => v).map(([k, v]) => (
            <Row key={k} k={k} v={v} />
          ))}
        </div>
      )}
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: string }) => (
  <><span className="k">{k}</span><span className="v" title={v}>{v}</span></>
);

// committed on Enter or when focus leaves, as Lightroom does; Escape
// restores the stored value
function TextRow({ label, value, disabled, onCommit }: {
  label: string; value: string; disabled: boolean; onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <>
      <span className="k">{label}</span>
      <input className="v field" value={draft} disabled={disabled}
             onChange={(e) => setDraft(e.target.value)} onBlur={commit}
             onKeyDown={(e) => {
               if (e.key === "Enter") (e.target as HTMLInputElement).blur();
               if (e.key === "Escape") { setDraft(value); (e.target as HTMLInputElement).blur(); }
             }} />
    </>
  );
}
