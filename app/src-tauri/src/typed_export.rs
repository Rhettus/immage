// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// request and reply types of the commands that make files: export, print,
// the merges, AI Denoise and the generated positives, and the presets
// documents, typed in bindings.rs. a reply type here is what the engine's
// JSON is read into, or what the Rust layer builds; tests/engine-replies holds
// real engine replies that bindings.rs's tests read into them
use crate::typed_library::LibraryImage;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use specta::Type;

// one image of an export: its file name without extension, already expanded
// from any template
#[derive(Serialize, Deserialize, Type)]
pub struct ExportItem {
    pub imgid: i64,
    pub stem: String,
    // when it was taken (EXIF, "2026:10:08 14:03:22"), for Immich
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    // what to do when the file is already there, when it was asked for
    // this image; otherwise the options' conflict
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<String>,
    // borders and text drawn around and over this image, its text already
    // expanded from its metadata: { borders: [...], texts: [...] }. the
    // engine reads it, and the page's frame editor shapes it
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<Value>,
}

#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subfolder: Option<String>,
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quality: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bpp: Option<i64>,
    pub color_space: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_edge: Option<i64>,
    // "unique" adds -1, -2...; "overwrite"; "skip"
    pub conflict: String,
    // instead of the folder: uploaded to this Immich album
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub immich_album: Option<String>,
    // AI upscaling, 2 or 4 times the width and height, on this GPU
    // provider and device (Preferences)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upscale: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_device: Option<i64>,
    // false leaves GPS out of the file, as Lightroom's Remove Location Info
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<bool>,
    // the rest of the dialog's Metadata section: false leaves each out of
    // the file (the engine's export)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camera: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub serials: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history: Option<bool>,
    // added to each exported file's keywords, and with keywords_on_original
    // to the original photo's as well
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords_on_original: Option<bool>,
}

// a file `export_existing` found, or would write
#[derive(Serialize, Type)]
pub struct ExistingFile {
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize, Type)]
pub struct ExportFailure {
    // empty for the album step of an Immich export
    pub file: String,
    pub error: String,
}

// `export_images`' reply. a folder export has `dir` and a list of files
// written; an Immich export has none and says what it uploaded
#[derive(Serialize, Type)]
pub struct ExportReply {
    pub written: Vec<String>,
    pub skipped: Vec<String>,
    pub failed: Vec<ExportFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    pub cancelled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploaded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicates: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub album: Option<String>,
}

// a photo the engine wrote beside an original and put in the library: AI
// Denoise's DNG, a converted negative or a film simulation. `image` is the
// listing's, as the engine's `import` gives it
#[derive(Serialize, Deserialize, Type)]
pub struct GeneratedReply {
    pub path: String,
    pub original: String,
    pub image: LibraryImage,
}

#[derive(Serialize, Deserialize, Type)]
pub struct HdrReply {
    pub path: String,
    pub image: LibraryImage,
}

// `used` is how many frames overlapped the rest
#[derive(Serialize, Deserialize, Type)]
pub struct PanoReply {
    pub path: String,
    pub original: String,
    pub image: LibraryImage,
    pub used: u32,
    pub frames: u32,
}

// a reduced panorama: base64 RGBA, its size, the crop (x0, y0, x1, y1) and
// the projection the engine settled on
#[derive(Serialize, Deserialize, Type)]
pub struct PanoPreview {
    pub rgba: String,
    pub width: u32,
    pub height: u32,
    pub crop: (i64, i64, i64, i64),
    pub projection: PanoProjection,
    pub used: u32,
}

// the projection a panorama was stitched in; "auto" resolves to one of these
#[derive(Serialize, Deserialize, Type, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum PanoProjection {
    Spherical,
    Cylindrical,
    Perspective,
}

// what a print wrote: the engine's size and resolution (a sheet's pages and
// photos), and the PDF's path when it went to one
#[derive(Serialize, Deserialize, Type)]
pub struct PrintReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dpi: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub photos: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pdf: Option<String>,
}

// an ICC profile the engine can print with
#[derive(Serialize, Deserialize, Type)]
pub struct PrintProfile {
    pub name: String,
    pub file: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PrintProfilesReply {
    pub profiles: Vec<PrintProfile>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Printer {
    pub name: String,
    pub description: String,
    pub default: bool,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PrintersReply {
    pub available: bool,
    pub printers: Vec<Printer>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PrinterMargins {
    pub top: Number,
    pub bottom: Number,
    pub left: Number,
    pub right: Number,
}

// a paper, portrait, in millimeters; `name` is what the printer calls it
#[derive(Serialize, Deserialize, Type)]
pub struct PrinterPaper {
    pub name: String,
    pub common_name: String,
    pub width: Number,
    pub height: Number,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PrinterMedium {
    pub name: String,
    pub common_name: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct PrinterInfoReply {
    pub resolution: Number,
    pub margins: PrinterMargins,
    // as CUPS names it; empty when the printer has no default
    pub default_paper: String,
    pub papers: Vec<PrinterPaper>,
    pub media: Vec<PrinterMedium>,
}

// a presets document as the page writes it: a version, which says what scale
// the values are on, and the presets. the page owns and migrates the
// presets' shape, so each stays a free-form object here
#[derive(Serialize, Deserialize, Type)]
pub struct PresetsFile {
    pub version: Number,
    pub presets: Vec<Value>,
}

// presets.json as it is on disk: version 1 was the bare list
#[derive(Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum PresetsDoc {
    File(PresetsFile),
    List(Vec<Value>),
}

// a look file the page lists: shipped ones by group, the user's own under
// "My Looks" (with `user`)
#[derive(Serialize, Deserialize, Type)]
pub struct LookInfo {
    pub name: String,
    pub group: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<bool>,
}

// what importing shared files did: the presets' documents (the page stores
// them), the number of looks added and what failed
#[derive(Serialize, Type)]
pub struct SharedImport {
    pub presets: Vec<Value>,
    pub looks: u32,
    pub failed: Vec<String>,
}
