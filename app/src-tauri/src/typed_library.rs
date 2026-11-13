// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// request and reply types of the library commands (folders, import,
// thumbnails, keywords, capture times, copies, geocoding), typed in
// bindings.rs. a reply type here is what the engine's JSON is read into;
// tests/engine-replies holds real replies that bindings.rs's tests read into
// them
use crate::bindings::{Location, MetaExif};
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use specta::Type;

// an image as the engine's library lists it (`import`, `copy`): `meta`'s
// image without the text fields, which a listing leaves out
#[derive(Serialize, Deserialize, Type)]
pub struct LibraryImage {
    pub imgid: i64,
    pub path: String,
    pub filename: String,
    // 0-5; 0 when rejected
    pub rating: u8,
    pub rejected: bool,
    // bits: red 1, yellow 2, green 4, blue 8, purple 16
    pub labels: u32,
    pub edited: bool,
    pub width: u32,
    pub height: u32,
    pub location: Option<Location>,
    pub exif: MetaExif,
    // darktable's tags, "|" between levels
    pub keywords: Vec<String>,
    // the file's version: every one but the lowest is a virtual copy
    pub version: u32,
    pub copy: bool,
}

// what `open_folder` returns, and what each engine `import` batch carries:
// every image, and the files the share did not answer for
#[derive(Serialize, Deserialize, Type)]
pub struct FolderReply {
    pub images: Vec<LibraryImage>,
    // paths; a batch's reply from an older engine has none
    #[serde(default)]
    pub unanswered: Vec<Value>,
}

// `copy`'s reply: the new version
#[derive(Deserialize)]
pub struct CopyReply {
    pub image: LibraryImage,
}

// the files `sidecars` and `remove_copy` name
#[derive(Deserialize)]
pub struct FilesReply {
    pub files: Vec<String>,
}

// `keywords` and `keywords_set`: every keyword used, or the image's own
#[derive(Deserialize)]
pub struct KeywordsReply {
    pub keywords: Vec<String>,
}

// `thumb`'s reply: the size of the pixels it wrote
#[derive(Deserialize)]
pub struct ThumbReply {
    pub width: u32,
    pub height: u32,
}

// a subfolder for the library panel's tree: name, path and whether it has
// subfolders of its own (for the twisty)
#[derive(Serialize, Type)]
pub struct SubFolder {
    pub name: String,
    pub path: String,
    pub has_children: bool,
}

// one photo's capture time, as the dialog read it and wants it
#[derive(Serialize, Deserialize, Type)]
pub struct CaptureTimeEntry {
    pub imgid: i64,
    pub before: String,
    pub after: String,
}

// what the engine did with an entry; `error` when the sidecar could not be
// written and the time was left as it was
#[derive(Serialize, Deserialize, Type)]
pub struct CaptureTimeUpdate {
    pub imgid: i64,
    pub before: String,
    pub after: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct CaptureTimesReply {
    pub updates: Vec<CaptureTimeUpdate>,
}

// a geocoding result: south, west, north, east for `bounds`
#[derive(Serialize, Type)]
pub struct Place {
    pub label: String,
    pub latitude: Number,
    pub longitude: Number,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<(Number, Number, Number, Number)>,
}
