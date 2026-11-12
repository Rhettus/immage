// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// reply types of the app-level commands (Immich, Preferences, performance
// reports, the menu bar, the support bundle), typed in bindings.rs. the Rust
// layer builds these itself, so there is no engine reply to check them against
use crate::engine::Timing;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use specta::Type;
use std::collections::BTreeMap;

// Preferences' darktable memory: the level the engine runs at, and the one
// its next start takes
#[derive(Serialize, Type)]
#[serde(rename = "ResourceLevels")]
pub struct Level {
    pub running: String,
    pub next: String,
}

// Preferences' GPU edits: whether the engine runs with them, and whether its
// next start will
#[derive(Serialize, Type)]
#[serde(rename = "GpuEditState")]
pub struct Toggle {
    pub running: bool,
    pub next: bool,
}

// each is null when missing, as in a development build that has not bundled
// the engine
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Licenses {
    pub gpl: Option<String>,
    pub libraries: Option<String>,
    pub libraries_path: Option<String>,
    pub notices: Option<String>,
}

// an Immich person, tag or library
#[derive(Serialize, Type)]
pub struct Named {
    pub id: String,
    pub name: String,
}

#[derive(Serialize, Type)]
pub struct Album {
    pub id: String,
    pub name: String,
    pub count: u64,
}

// what a filmstrip cell and the metadata panel need of an Immich asset
#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub path: String,
    pub local_path: Option<String>,
    pub date: Option<String>,
    pub rating: i64,
    pub favorite: bool,
    pub width: i64,
    pub height: i64,
    pub exif: AssetExif,
}

#[derive(Serialize, Type)]
pub struct AssetExif {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<Number>,
    pub aperture: Option<Number>,
    // "1/250" or "0.5", as Immich has it
    pub exposure: Option<String>,
    pub focal: Option<Number>,
    pub datetime: Option<String>,
}

// one page of a search; `next` goes back for the page after, null at the end
#[derive(Serialize, Type)]
pub struct SearchPage {
    pub items: Vec<Asset>,
    pub next: Option<String>,
}

#[derive(Serialize, Type)]
pub struct Resolved {
    pub path: String,
    pub downloaded: bool,
}

// the comparison of one CPU and one GPU render (the engine's parity reply),
// with each pass's module timings added by the Rust layer
#[derive(Serialize, Deserialize, Type)]
pub struct ParityReply {
    pub width: u32,
    pub height: u32,
    pub de: ParityDe,
    pub rgb: BTreeMap<String, ParityRgb>,
    pub cpu: ParityPass,
    pub gpu: ParityPass,
    // the amplified difference's file, written when a case differs
    pub diff: Option<String>,
    // by pass, "cpu" and "gpu"
    #[serde(default)]
    pub modules: BTreeMap<String, Vec<Timing>>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ParityDe {
    pub mean: Number,
    pub p99: Number,
    pub max: Number,
    pub over2: Number,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ParityRgb {
    pub mean: Number,
    pub max: Number,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ParityPass {
    pub ms: Number,
    // below zero when no device ran the pass
    pub devid: i64,
    pub device: Option<String>,
    pub cl_errors: i64,
}

// the support bundle as the dialog shows it: each file's scrubbed lines, and
// how many of each kind of text the scrubber replaced
#[derive(Serialize, Type)]
pub struct BundleView {
    pub files: Vec<BundleFile>,
    pub counts: BTreeMap<String, u64>,
}

#[derive(Serialize, Type)]
pub struct BundleFile {
    pub name: String,
    pub lines: Vec<String>,
}

// what only the page knows and the scrubber must find in the text; `prefs`
// is the user's own preferences, whatever they hold
#[derive(Deserialize, Default, Type)]
#[serde(default)]
pub struct PageValues {
    pub folders: Vec<String>,
    pub photos: Vec<String>,
    pub extra: Vec<String>,
    pub prefs: Value,
}

// what Preferences shows of the web view's renderer: the mode running and
// the one the next start takes, the vendor in use and which others exist.
// defined here, not in the Linux-only renderer.rs, because the command's
// signature needs it on every platform (it answers null elsewhere)
#[derive(Serialize, Type)]
pub struct WebviewRenderer {
    pub running: String,
    pub next: String,
    pub active: String,
    pub external: bool,
    pub mesa: bool,
    pub nvidia: bool,
}
