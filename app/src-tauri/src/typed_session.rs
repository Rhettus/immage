// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// request and reply types of the open-photo commands (open, edits, history,
// render, preview, sampling), typed in bindings.rs. a reply type here is what
// the engine's JSON is read into; tests/engine-replies holds real replies
// that bindings.rs's tests read into them
use serde::{Deserialize, Serialize};
use serde_json::{json, Number, Value};
use specta::Type;
use std::collections::BTreeMap;

// `open`'s reply
#[derive(Serialize, Deserialize, Type)]
pub struct OpenReply {
    pub imgid: i64,
    pub sensor_width: u32,
    pub sensor_height: u32,
    pub orientation: i64,
    // the look applied on opening, as a path
    pub look: Option<String>,
    pub look_amount: Number,
    pub edited: bool,
    pub raw: bool,
    // a photo with no history yet, whose defaults are its baseline
    pub fresh: bool,
}

// an item of the image's darktable history, as darktable's history module
// names it. `priority` picks the instance; `fixed` ones have no switch in
// darktable, and `masked` ones are the Masks panel's. the new-photo rows
// the page adds have none of these
#[derive(Serialize, Deserialize, Type, Clone)]
pub struct HistoryItem {
    pub op: String,
    pub name: String,
    pub label: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fixed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub masked: Option<bool>,
}

// `history`'s reply: the page gets the items
#[derive(Deserialize)]
pub struct HistoryReply {
    pub items: Vec<HistoryItem>,
}

// an instance's whole state as the engine's `module_state` gives it, for
// undoing the History panel's switches
#[derive(Serialize, Deserialize, Type)]
pub struct ModuleState {
    pub enabled: bool,
    // darktable's parameter blobs, base64
    pub params: String,
    pub blend: Option<String>,
}

// a state to put an instance back to: one an earlier reply gave, or the
// string "opened" for the state it had when the photo opened
#[derive(Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum Restore {
    Named(String),
    State(ModuleState),
}

// the state before and after
#[derive(Serialize, Deserialize, Type)]
pub struct ModuleStateReply {
    pub was: ModuleState,
    pub now: ModuleState,
}

// `get`'s reply: the fields asked of each module. the page asks by field
// name, and darktable's parameters are numbers
#[derive(Serialize, Deserialize, Type)]
pub struct GetReply {
    pub modules: BTreeMap<String, ModuleInfo>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ModuleInfo {
    pub enabled: bool,
    pub default_enabled: bool,
    pub params: BTreeMap<String, Number>,
    pub defaults: BTreeMap<String, Number>,
}

// a mask's refinement, as darktable's blend parameters hold it: feather and
// blur radii in pixels, detail and contrast -1 to 1
#[derive(Serialize, Deserialize, Type)]
pub struct Refine {
    pub feather: Number,
    pub blur: Number,
    pub detail: Number,
    pub contrast: Number,
}

// a module's edit: its parameters by field name, sent to `set`. `instance`
// names a mask's own instance of the module, and `mask` gives it that mask
// (with `invert`, `opacity` 0-100 and `refine`); `after` and `before` place a
// new instance
#[derive(Serialize, Deserialize, Type)]
pub struct ModuleEdit {
    pub op: String,
    pub params: BTreeMap<String, Number>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mask: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invert: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opacity: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refine: Option<Refine>,
}

impl ModuleEdit {
    // the engine's `set` request. a mask's adjustments (`invert`, `opacity`,
    // `refine`) go only with a mask; `module_only` leaves them out, as a
    // render's or preview's edits do
    pub fn request(&self, module_only: bool) -> Value {
        let mut req = json!({ "cmd": "set", "op": self.op, "params": self.params, "enabled": self.enabled });
        for (key, value) in [("after", &self.after), ("before", &self.before), ("instance", &self.instance)] {
            if let Some(v) = value {
                req[key] = json!(v);
            }
        }
        if let (false, Some(mask)) = (module_only, &self.mask) {
            req["mask"] = json!(mask);
            req["invert"] = json!(self.invert.unwrap_or(false));
            if let Some(o) = &self.opacity {
                req["opacity"] = json!(o);
            }
            if let Some(r) = &self.refine {
                req["refine"] = json!(r);
            }
        }
        req
    }
}

// the profiles darktable offers, as [name, id]
#[derive(Serialize, Deserialize, Type)]
pub struct ColorProfiles {
    pub input: Vec<(String, i64)>,
    pub working: Vec<(String, i64)>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ChannelStats {
    pub min: Number,
    pub mean: Number,
    pub max: Number,
}

// negadoctor's picker over the box, as red, green and blue
#[derive(Serialize, Deserialize, Type)]
pub struct PickerStats {
    pub min: [Number; 3],
    pub mean: [Number; 3],
    pub max: [Number; 3],
}

// `sample`'s reply: the working-space values at a point or over a box, by
// channel name (the range masks' channels)
#[derive(Serialize, Deserialize, Type)]
pub struct SampleReply {
    pub luminance: Number,
    pub ev: Number,
    pub jz: Number,
    pub chroma: Number,
    pub hue: Number,
    pub channels: BTreeMap<String, ChannelStats>,
    // only at negadoctor's input
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub picker: Option<PickerStats>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct ToneKeyReply {
    pub ev: Number,
}

#[derive(Serialize, Deserialize, Type)]
pub struct AgxAutoReply {
    pub black_ev: Number,
    pub white_ev: Number,
}

// `save`'s reply: whether the photo now reads as edited (darktable's history
// hash)
#[derive(Serialize, Deserialize, Type)]
pub struct SaveReply {
    pub edited: bool,
}

// one photo's result of a paste batch's undo or redo
#[derive(Serialize, Deserialize, Type)]
pub struct PasteUpdate {
    pub imgid: i64,
    pub edited: bool,
    pub error: Option<String>,
}

// `paste_batch`'s reply: a token after `begin`, the photos changed after
// `undo` and `redo`, nothing after the rest
#[derive(Serialize, Deserialize, Type)]
pub struct PasteBatchReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updates: Option<Vec<PasteUpdate>>,
}

// the engine's reply to `render`, which goes into the frame's header. every
// field has a default: a missing one has always read as zero there
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RenderReply {
    pub width: u64,
    pub height: u64,
    pub full_width: u64,
    pub full_height: u64,
    pub x: i64,
    pub y: i64,
    pub hash: String,
    pub kept: bool,
    pub process_ms: f64,
    pub write_ms: f64,
    pub output_ms: Option<OutputMs>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct OutputMs {
    pub allocate_ms: f64,
    pub convert_ms: f64,
    pub file_ms: f64,
    pub free_ms: f64,
}

// `preview`'s reply
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct PreviewReply {
    pub width: u64,
    pub height: u64,
}

// the frame the page asks `render` for: the whole image fitted into
// width x height, or, with a scale (1.0 is 100%), the width x height window at
// (x, y) of the scaled image
#[derive(Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RenderRequest {
    pub width: u32,
    pub height: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<Number>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<i64>,
    // ops left out of this frame
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip: Option<Vec<String>>,
    // a drag's frame, on the engine's drag pipe
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub draft: Option<bool>,
    // the idle whole-image base, on the engine's base pipe and the GPU
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<bool>,
    // the frame goes by shared memory under this id, with `token` naming the
    // file on Linux (sharedFrames.ts)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    // the hashes of frames the page holds: one that is the view's comes back
    // as a header alone
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub have: Option<Vec<String>>,
    // a move's module edits, sent ahead of the render under the same lock
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edits: Option<Vec<ModuleEdit>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnostic_request: Option<u64>,
}
