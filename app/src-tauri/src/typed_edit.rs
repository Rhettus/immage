// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// request and reply types of the editing commands beside the sliders: masks,
// spots, Upright, AI selections, film simulation data, lenses, fonts and AgX
// presets, typed in bindings.rs. a reply type here is what the engine's JSON
// is read into; tests/engine-replies holds real replies that bindings.rs's
// tests read into them
use crate::typed_session::Refine;
use serde::{Deserialize, Serialize};
use serde_json::{Number, Value};
use specta::Type;
use std::collections::BTreeMap;

// a mask as the engine keeps it. its shapes are the page's own tagged
// union (ellipse, gradient, brush, object, ranges: masks.ts, Shape), grown
// by the page and read by the engine, so each stays a free-form object
#[derive(Serialize, Deserialize, Type)]
pub struct MaskInfo {
    pub name: String,
    pub shapes: Vec<Value>,
    pub invert: bool,
    // 0-100
    pub opacity: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refine: Option<Refine>,
    // the module instances this mask drives, by op (or op#tag), with the
    // fields the page asked for
    pub instances: BTreeMap<String, MaskInstance>,
    // the combined masks this one is a member of
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merged_in: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct MaskInstance {
    pub enabled: bool,
    pub params: BTreeMap<String, Number>,
}

// `masks`' reply
#[derive(Deserialize)]
pub struct MasksReply {
    pub masks: Vec<MaskInfo>,
}

// a member of a combined mask: a mask at an opacity 0-1, inverted or not
#[derive(Serialize, Deserialize, Type)]
pub struct CombineMember {
    pub mask: String,
    pub opacity: Number,
    pub invert: bool,
}

// the window of the image a mask map covers, as a render's x, y and scale
#[derive(Serialize, Deserialize, Type)]
pub struct MapView {
    pub x: Number,
    pub y: Number,
    pub scale: Number,
}

#[derive(Serialize, Deserialize, Type, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SpotMode {
    Heal,
    Clone,
}

// a heal or clone spot, in shown-image units: 0-1 across the width and
// height, sizes as fractions of the width. (sx, sy) is where the center, or
// a stroke's first point, copies from
#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Spot {
    Circle {
        x: Number,
        y: Number,
        r: Number,
        mode: SpotMode,
        sx: Number,
        sy: Number,
        feather: Number,
        opacity: Number,
    },
    Brush {
        points: Vec<(Number, Number)>,
        size: Number,
        mode: SpotMode,
        sx: Number,
        sy: Number,
        feather: Number,
        opacity: Number,
    },
}

// a spot before its source is found
#[derive(Serialize, Deserialize, Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum NewSpot {
    Circle {
        x: Number,
        y: Number,
        r: Number,
        mode: SpotMode,
        feather: Number,
        opacity: Number,
    },
    Brush {
        points: Vec<(Number, Number)>,
        size: Number,
        mode: SpotMode,
        feather: Number,
        opacity: Number,
    },
}

#[derive(Deserialize)]
pub struct SpotsReply {
    pub spots: Vec<Spot>,
}

// where a new spot copies from
#[derive(Serialize, Deserialize, Type)]
pub struct SpotSource {
    pub sx: Number,
    pub sy: Number,
}

// Upright's fit of rotate and perspective
#[derive(Serialize, Deserialize, Type)]
pub struct UprightReply {
    pub rotation: Number,
    pub lensshift_v: Number,
    pub lensshift_h: Number,
    // the mode the fit settled on, in the engine's words
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fit: Option<String>,
}

// `depth`'s map: `data` 0 (nearest) to 255 by rows
#[derive(Serialize, Deserialize, Type)]
pub struct DepthMap {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u16>,
}

// a GPU execution provider AI can use, with its devices
#[derive(Serialize, Deserialize, Type)]
pub struct AccelProvider {
    pub id: String,
    pub name: String,
    pub devices: Vec<AccelDevice>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct AccelDevice {
    pub id: i64,
    pub name: String,
}

#[derive(Deserialize)]
pub struct AiAccelReply {
    pub providers: Vec<AccelProvider>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct FontFace {
    pub name: String,
    pub weight: u32,
    pub italic: bool,
}

#[derive(Serialize, Deserialize, Type)]
pub struct FontFamily {
    pub name: String,
    pub faces: Vec<FontFace>,
}

#[derive(Deserialize)]
pub struct FontsReply {
    pub families: Vec<FontFamily>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Lens {
    pub name: String,
    pub maker: String,
    pub hash: i64,
}

// the lenses Lens Corrections can use, the one matched from EXIF (`auto`,
// empty for none) and the index picked
#[derive(Serialize, Deserialize, Type)]
pub struct LensMenu {
    pub auto: String,
    pub pick: i64,
    pub lenses: Vec<Lens>,
}

// `look`'s reply: the look in use, by name
#[derive(Deserialize)]
pub struct LookReply {
    pub look: Option<String>,
}

// an AgX preset found in darktable's data.db or a file, its parameters by
// field name
#[derive(Serialize, Deserialize, Type)]
pub struct FoundPreset {
    pub name: String,
    pub params: BTreeMap<String, Number>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct AgxPresetsReply {
    pub presets: Vec<FoundPreset>,
}

// an AgX preset the user loaded into the Profile menu (agx-profiles.json)
#[derive(Serialize, Deserialize, Type)]
pub struct AgxProfile {
    pub value: i64,
    pub label: String,
    pub params: BTreeMap<String, Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<bool>,
}

// a film or paper of the spektrafilm data pack
#[derive(Serialize, Deserialize, Type)]
pub struct FilmStock {
    pub hash: i64,
    pub stock: String,
    pub name: String,
    pub printing: bool,
    pub positive: bool,
    pub bw: bool,
    pub target_print: String,
    pub dev_times: Vec<Number>,
}

// the pack in use. the engine names its LUT only when it found the pack in
// its own list of them
#[derive(Serialize, Deserialize, Type)]
pub struct FilmPack {
    pub dir: String,
    #[serde(default)]
    pub lut_id: String,
    #[serde(default)]
    pub lut_hash: i64,
    #[serde(default)]
    pub hand_installed: bool,
}

#[derive(Serialize, Deserialize, Type)]
pub struct FilmStocks {
    pub pack: Option<FilmPack>,
    pub stocks: Vec<FilmStock>,
}

#[derive(Serialize, Deserialize, Type, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum FetchState {
    Idle,
    Running,
    Done,
    Failed,
}

// the pack's download: idle, running, done or failed; `progress` 0-1, or -1
// when unknown; `started` answers a start
#[derive(Serialize, Deserialize, Type)]
pub struct FilmFetch {
    pub state: FetchState,
    pub message: String,
    pub progress: Number,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started: Option<bool>,
}

// `module_schema`'s reply: what darktable's introspection says of a module
// (see session_module_schema in engine/session.c)
#[derive(Serialize, Deserialize, Type)]
pub struct ModuleSchema {
    pub op: String,
    pub name: String,
    pub version: i64,
    pub params_size: i64,
    pub groups: Vec<String>,
    pub flags: SchemaFlags,
    pub fields: Vec<SchemaField>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct SchemaFlags {
    pub one_instance: bool,
    pub deprecated: bool,
    pub hidden: bool,
    pub supports_blending: bool,
    pub no_masks: bool,
    pub no_history: bool,
    pub no_switch: bool,
}

// a leaf of a module's params, by the path `set` and `get` take. a scalar has
// `min`, `max` (none: unbounded) and `default`, an enum its `values`; an
// array (`type` "array", or "string" for characters) gives its `dims` and
// `element` type, and for structs the `members` of one element by relative path
#[derive(Serialize, Deserialize, Type)]
pub struct SchemaField {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub min: Option<Number>,
    #[serde(default)]
    pub max: Option<Number>,
    #[serde(default)]
    pub default: Option<Number>,
    #[serde(default)]
    pub enum_type: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<SchemaEnumValue>>,
    #[serde(default)]
    pub dims: Option<Vec<i64>>,
    #[serde(default)]
    pub element: Option<String>,
    #[serde(default)]
    pub defaults: Option<Vec<Option<Number>>>,
    // arrays of up to 64 structs: one object per element, row-major, of the
    // number members' defaults keyed by their relative paths
    #[serde(default)]
    pub member_defaults: Option<Vec<std::collections::BTreeMap<String, Option<Number>>>>,
    #[serde(default)]
    pub members: Option<Vec<SchemaField>>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct SchemaEnumValue {
    pub name: String,
    pub value: i64,
    #[serde(default)]
    pub description: Option<String>,
}

// `instances`' reply, which the page gets as the list
#[derive(Deserialize)]
pub struct InstancesReply {
    pub instances: Vec<Instance>,
}

// one instance of a module in the open photo's pipe, in pipe order.
// `priority` addresses it in `set_params` and `get_params` ("op@N"); `owner`
// is the Immage tool that manages it ("mask", "shared" or "look"), none for
// the user's own
#[derive(Serialize, Deserialize, Type)]
pub struct Instance {
    pub op: String,
    pub priority: i64,
    pub name: String,
    pub hand_edited: bool,
    pub enabled: bool,
    pub default_enabled: bool,
    pub iop_order: i64,
    pub owner: Option<String>,
}
