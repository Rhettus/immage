// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the typed command protocol: the commands listed in `commands()` have their
// signatures and reply types exported to app/src/bindings.ts, which the page
// calls through app/src/commands.ts. every other command still goes through
// tauri::generate_handler! in main.rs (`handler` routes between the two), and
// moves in here as it gets typed
//
// regenerate the file after changing a typed command or reply type:
//   IMMAGE_WRITE_BINDINGS=1 cargo test --locked bindings
// plain `cargo test` fails when the committed file is out of date
use serde::{Deserialize, Serialize};
use serde_json::Number;
use specta::Type;
use std::collections::HashSet;
use tauri::ipc::{Invoke, InvokeResponseBody, IpcResponse};
use tauri_specta::{collect_commands, Commands};

pub fn commands() -> Commands<tauri::Wry> {
    collect_commands![
        crate::settings::settings_all,
        crate::settings::settings_set,
        crate::meta,
        crate::meta_set,
        crate::points,
        crate::path_kind,
        crate::build,
        crate::about,
        crate::map_tiles::map_tile,
        // the open-photo path
        crate::open_image,
        crate::history,
        crate::module_state,
        crate::get_params,
        crate::set_params,
        crate::sample,
        crate::tone_key,
        crate::color_profiles,
        crate::agx_auto,
        crate::render,
        crate::cancel_base,
        crate::save,
        crate::baseline_end,
        crate::before_view,
        crate::preview,
        crate::paste_batch,
    ]
}

// only the bindings export needs the builder: the app routes through `handler`
#[cfg(test)]
pub fn builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(commands())
        // ids and sizes are serde_json numbers on the wire, never past 2^53
        .dangerously_cast_bigints_to_number()
        // one type per reply, not a Serialize and a Deserialize variant
        .disable_serde_phases()
}

// one invoke handler for the typed commands and the rest: tauri allows a
// single handler, and an Invoke can be given to only one of them
pub fn handler(
    rest: impl Fn(Invoke<tauri::Wry>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let commands = commands();
    let typed: HashSet<String> = (commands.1)(&mut specta::Types::default())
        .functions
        .iter()
        .map(|f| f.name().to_string())
        .collect();
    let typed_handler = commands.0.clone();
    move |invoke| {
        if typed.contains(invoke.message.command()) {
            typed_handler(invoke)
        } else {
            rest(invoke)
        }
    }
}

// a binary reply (a frame, a map tile): tauri sends the bytes raw and the
// page receives an ArrayBuffer. specta has no type for tauri's Response
pub struct Frame(pub tauri::ipc::Response);

impl IpcResponse for Frame {
    fn body(self) -> tauri::Result<InvokeResponseBody> {
        self.0.body()
    }
}

impl Type for Frame {
    fn definition(_types: &mut specta::Types) -> specta::datatype::DataType {
        specta::datatype::DataType::Reference(specta_typescript::define("ArrayBuffer"))
    }
}

// the engine's `meta` reply. the engine's own JSON is read into these, so a
// field the engine adds does not break the page and one it drops shows up here
#[derive(Serialize, Deserialize, Type)]
pub struct MetaReply {
    pub image: MetaImage,
}

#[derive(Serialize, Deserialize, Type)]
pub struct MetaImage {
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
    // the text fields, which `meta` (unlike a folder listing) always sends
    pub metadata: MetaText,
}

#[derive(Serialize, Deserialize, Type)]
pub struct Location {
    pub latitude: Number,
    pub longitude: Number,
}

// serde_json's Number is always finite, which specta exports as a plain
// `number` (an f64 would be `number | null`)
fn zero() -> Number {
    Number::from(0)
}

#[derive(Serialize, Deserialize, Type)]
pub struct MetaExif {
    pub maker: String,
    pub model: String,
    pub lens: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub body_serial: String,
    pub exposure: Number,
    pub aperture: Number,
    pub iso: Number,
    pub focal_length: Number,
    pub exposure_bias: Number,
    pub focus_distance: Number,
    // 0 when the camera did not record it
    #[serde(default = "zero")]
    pub crop_factor: Number,
    #[serde(default)]
    pub white_balance: String,
    #[serde(default)]
    pub flash: String,
    #[serde(default)]
    pub exposure_program: String,
    #[serde(default)]
    pub metering_mode: String,
    // the file's own pixel size, before any crop
    #[serde(default)]
    pub file_width: u32,
    #[serde(default)]
    pub file_height: u32,
    #[serde(default)]
    pub sensor_width: u32,
    #[serde(default)]
    pub sensor_height: u32,
    pub datetime: String,
    // the file's modified time, sent only when there is no capture time
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_datetime: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct MetaText {
    pub title: String,
    pub description: String,
    pub creator: String,
    pub publisher: String,
    pub rights: String,
    pub notes: String,
}

#[derive(Serialize, Deserialize, Type)]
pub struct BuildInfo {
    pub app: String,
    // none when built outside Git
    pub commit: Option<String>,
}

#[derive(Serialize, Deserialize, Type)]
pub struct AboutInfo {
    pub app: String,
    pub commit: Option<String>,
    pub darktable: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMITTED: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../src/bindings.ts");

    fn generate() -> String {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = std::env::temp_dir().join(format!("immage-bindings-{}-{n}.ts", std::process::id()));
        builder().export(specta_typescript::Typescript::default(), &tmp).expect("cannot export the bindings");
        let text = std::fs::read_to_string(&tmp).expect("cannot read the exported bindings");
        let _ = std::fs::remove_file(&tmp);
        text
    }

    // regenerate with: IMMAGE_WRITE_BINDINGS=1 cargo test --locked bindings
    #[test]
    fn bindings_are_current() {
        let fresh = generate();
        if std::env::var_os("IMMAGE_WRITE_BINDINGS").is_some() {
            std::fs::write(COMMITTED, &fresh).expect("cannot write app/src/bindings.ts");
            return;
        }
        let committed = std::fs::read_to_string(COMMITTED).unwrap_or_default();
        assert!(
            committed == fresh,
            "app/src/bindings.ts is out of date with the Rust commands. regenerate it with:\n  \
             cd app/src-tauri && IMMAGE_WRITE_BINDINGS=1 cargo test --locked bindings"
        );
    }

    #[test]
    fn bindings_are_deterministic() {
        assert_eq!(generate(), generate());
    }

    use crate::typed_session::*;
    use serde::de::DeserializeOwned;

    type ReplyCheck = fn(serde_json::Value) -> Result<(), serde_json::Error>;

    fn reads<T: DeserializeOwned>(reply: serde_json::Value) -> Result<(), serde_json::Error> {
        serde_json::from_value::<T>(reply).map(|_| ())
    }

    // every engine command whose reply the Rust layer reads into a typed
    // struct, with that struct: the commands that pass an engine reply
    // through. each needs a file of real replies in tests/engine-replies,
    // which verify/engine-protocol.py --fixtures writes from the built
    // engine. a new entry without a file fails below, and an engine reply
    // that no longer fits its type fails here rather than in the app
    const ENGINE_REPLIES: &[(&str, ReplyCheck)] = &[
        ("meta", reads::<MetaReply>),
        ("open", reads::<OpenReply>),
        ("history", reads::<HistoryReply>),
        ("module_state", reads::<ModuleStateReply>),
        ("get", reads::<GetReply>),
        ("sample", reads::<SampleReply>),
        ("tone_key", reads::<ToneKeyReply>),
        ("color_profiles", reads::<ColorProfiles>),
        ("agx_auto", reads::<AgxAutoReply>),
        ("save", reads::<SaveReply>),
        ("paste_batch", reads::<PasteBatchReply>),
        ("render", reads::<RenderReply>),
        ("preview", reads::<PreviewReply>),
    ];

    #[test]
    fn typed_engine_replies_read_the_engines_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/engine-replies");
        for (command, check) in ENGINE_REPLIES {
            let file = dir.join(format!("{command}.json"));
            let text = std::fs::read_to_string(&file).unwrap_or_else(|_| {
                panic!(
                    "no fixture for the engine's {command} reply ({}). write them with:\n  \
                     python3 -I verify/engine-protocol.py --fixtures app/src-tauri/tests/engine-replies",
                    file.display()
                )
            });
            let fixtures: Vec<serde_json::Value> = serde_json::from_str(&text).expect("a fixture file is a JSON list");
            assert!(!fixtures.is_empty(), "{command}: no replies in its fixture file");
            for fixture in fixtures {
                let label = fixture["label"].clone();
                if let Err(e) = check(fixture["reply"].clone()) {
                    panic!("the engine's {command} reply ({label}) no longer fits its type: {e}");
                }
            }
        }
    }

    // the same typed replies, for a field the fixtures do not carry
    #[test]
    fn meta_reply_ignores_fields_it_does_not_know() {
        let reply: MetaReply = serde_json::from_value(serde_json::json!({
            "image": { "imgid": 3, "path": "/a.nef", "filename": "a.nef", "rating": 2, "rejected": false,
                "width": 10, "height": 8, "location": null,
                "exif": { "maker": "", "model": "", "lens": "", "exposure": 0.1, "aperture": 2.8, "iso": 100.0,
                    "focal_length": 50.0, "exposure_bias": 0.0, "focus_distance": 0.0, "datetime": "",
                    "something_new": 1 },
                "labels": 0, "edited": false, "version": 0, "copy": false, "keywords": ["a|b"],
                "metadata": { "title": "", "description": "", "creator": "", "publisher": "", "rights": "", "notes": "" } },
            "extra": true
        }))
        .unwrap();
        assert_eq!(reply.image.imgid, 3);
        assert_eq!(reply.image.metadata.title, "");
    }
}
