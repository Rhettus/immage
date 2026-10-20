// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// tokens filled in from a photo's metadata: export file names, and the
// text an export draws on its frame (LRMogrify's token names)
import type { ImageEntry } from "./library";

export type Meta = { title: string; description: string; creator: string; rights: string };

export const EMPTY_META: Meta = { title: "", description: "", creator: "", rights: "" };

// a file name's tokens
export const TOKENS = ["filename", "title", "caption", "creator", "copyright", "datecaptured", "timecaptured",
                       "year", "month", "day", "camera", "lens", "iso", "rating", "seq"];

// the photo info a caption can show, in groups, each with its name in the
// menu (LRMogrify's token names, so its templates carry over)
export const TEXT_TOKENS: [string, [string, string][]][] = [
  ["Photo", [["title", "Title"], ["caption", "Caption"], ["creator", "Creator"], ["copyright", "Copyright"],
             ["filename", "File name"], ["rating", "Rating"]]],
  ["Date", [["dateCaptured", "Date taken"], ["timeCaptured", "Time taken"]]],
  ["Camera", [["shootingInfo", "Shooting info (mm · f · s · ISO)"], ["cameraModel", "Camera"],
              ["cameraMake", "Camera make"], ["lens", "Lens"], ["focalLength", "Focal length"],
              ["aperture", "Aperture"], ["shutterSpeed", "Shutter speed"], ["isoSpeedRating", "ISO"],
              ["exposureBias", "Exposure compensation"], ["subjectDistance", "Subject distance"]]],
];

// a capture time written with YYYY, YY, MM, DD, HH, mm and ss
function formatTime(d: RegExpExecArray | null, pattern: string): string {
  if (!d) return "";
  const parts: Record<string, string> = {
    YYYY: d[1], YY: d[1].slice(2), MM: d[2], DD: d[3], HH: d[4], mm: d[5], ss: d[6],
  };
  return pattern.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (k) => parts[k]);
}

const captured = (i: ImageEntry) => /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(i.exif.datetime ?? "");

// {datecaptured} follows the chosen date format; {datecaptured:YYYY.MM}
// or {timecaptured:HH-mm} give a token its own. tokens a file name cannot
// carry are replaced, and an empty result falls back to the original name
export function expand(template: string, i: ImageEntry, meta: Meta, seq: number, total: number,
                       dateFormat: string): string {
  const d = captured(i);
  const vals: Record<string, string> = {
    filename: i.filename.replace(/\.[^.]+$/, ""),
    title: meta.title, caption: meta.description, creator: meta.creator, copyright: meta.rights,
    datecaptured: formatTime(d, dateFormat), timecaptured: formatTime(d, "HHmmss"),
    year: d?.[1] ?? "", month: d?.[2] ?? "", day: d?.[3] ?? "",
    camera: i.exif.model, lens: i.exif.lens === "n/a" ? "" : i.exif.lens,
    iso: i.exif.iso > 0 ? String(Math.round(i.exif.iso)) : "",
    rating: String(i.rating),
    seq: String(seq).padStart(Math.max(3, String(total).length), "0"),
  };
  const name = template
    .replace(/\{(\w+)(?::([^}]+))?\}/g, (m, k: string, fmt?: string) =>
      fmt && (k === "datecaptured" || k === "timecaptured") ? formatTime(d, fmt)
        : k in vals ? vals[k] : m)
    .replace(/[/\\:*?"<>|\n\r\t]+/g, "_")
    // an empty token leaves its separator behind: trim those at the ends
    .replace(/^[\s._-]+|[\s._-]+$/g, "")
    .replace(/[-_ ]{2,}/g, (m) => m[0]);
  return name || vals.filename;
}

const round = (v: number, digits: number) => String(Number(v.toFixed(digits)));

function shutter(s: number): string {
  if (!(s > 0)) return "";
  if (s >= 0.3) return `${round(s, 1)}s`;
  return `1/${Math.round(1 / s)}`;
}

// a frame text: {token}, {token, fallback} when the photo lacks it, and
// {dateCaptured:YYYY.MM.DD} for a date written another way. unknown tokens
// stay as typed, so a mistake shows in the preview
export function expandText(text: string, i: ImageEntry, meta: Meta): string {
  const d = captured(i), e = i.exif;
  const vals: Record<string, string> = {
    title: meta.title, caption: meta.description, creator: meta.creator, copyright: meta.rights,
    filename: i.filename.replace(/\.[^.]+$/, ""),
    dateCaptured: formatTime(d, "YYYY/MM/DD"), timeCaptured: formatTime(d, "HH:mm"),
    cameraMake: e.maker ?? "", cameraModel: e.model ?? "", lens: e.lens === "n/a" ? "" : e.lens ?? "",
    focalLength: e.focal_length > 0 ? `${round(e.focal_length, 1)} mm` : "",
    aperture: e.aperture > 0 ? `f/${round(e.aperture, 1)}` : "",
    shutterSpeed: shutter(e.exposure),
    isoSpeedRating: e.iso > 0 ? `ISO ${Math.round(e.iso)}` : "",
    exposureBias: e.exposure_bias ? `${e.exposure_bias > 0 ? "+" : ""}${round(e.exposure_bias, 1)} EV` : "",
    subjectDistance: e.focus_distance > 0 ? `${e.focus_distance.toFixed(2)} m` : "",
    rating: i.rating > 0 ? "★".repeat(i.rating) : "",
  };
  vals.shootingInfo = [vals.focalLength, vals.aperture, vals.shutterSpeed, vals.isoSpeedRating]
    .filter(Boolean).join(" · ");
  return text.replace(/\{(\w+)(?::([^},]+))?(?:\s*,\s*([^}]*))?\}/g, (m, k: string, fmt?: string, fallback?: string) => {
    if (!(k in vals)) return m;
    const v = fmt && (k === "dateCaptured" || k === "timeCaptured") ? formatTime(d, fmt) : vals[k];
    return v || (fallback ?? "");
  });
}
