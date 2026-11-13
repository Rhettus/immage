// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the typed command protocol: every command the page calls is listed in
// `commands()`, and its signature and reply type are exported to
// app/src/bindings.ts, which the page calls through app/src/commands.ts. a new
// command takes #[specta::specta] after #[tauri::command] and a line here;
// the tests below fail when one is missing
//
// regenerate the file after changing a typed command or reply type:
//   IMMAGE_WRITE_BINDINGS=1 cargo test --locked bindings
// plain `cargo test` fails when the committed file is out of date
use serde::{Deserialize, Serialize};
use serde_json::Number;
use specta::Type;
use tauri::ipc::{Invoke, InvokeResponseBody, IpcResponse};
use tauri_specta::{collect_commands, Commands};

pub fn commands() -> Commands<tauri::Wry> {
    collect_commands![
        crate::settings::settings_all,
        crate::settings::settings_set,
        crate::library_cmds::meta,
        crate::library_cmds::meta_set,
        crate::session_cmds::points,
        crate::library_cmds::path_kind,
        crate::app_cmds::build,
        crate::app_cmds::about,
        crate::map_tiles::map_tile,
        // the open-photo path
        crate::session_cmds::open_image,
        crate::session_cmds::history,
        crate::session_cmds::module_state,
        crate::session_cmds::get_params,
        crate::session_cmds::set_params,
        crate::session_cmds::sample,
        crate::session_cmds::tone_key,
        crate::session_cmds::color_profiles,
        crate::session_cmds::agx_auto,
        crate::session_cmds::render,
        crate::session_cmds::cancel_base,
        crate::session_cmds::save,
        crate::session_cmds::baseline_end,
        crate::session_cmds::before_view,
        crate::session_cmds::preview,
        crate::session_cmds::paste_batch,
        // the library
        crate::library_cmds::open_folder,
        crate::library_cmds::list_subfolders,
        crate::library_cmds::folder_volumes,
        crate::library_cmds::thumb,
        crate::library_cmds::thumb_cached,
        crate::library_cmds::thumb_known,
        crate::library_cmds::prefetch,
        crate::library_cmds::keywords,
        crate::library_cmds::keywords_set,
        crate::library_cmds::capture_times,
        crate::library_cmds::sample_folder,
        crate::library_cmds::trash_files,
        crate::library_cmds::create_virtual_copy,
        crate::library_cmds::remove_virtual_copy,
        crate::library_cmds::path_exists,
        crate::library_cmds::cache_limits,
        crate::library_cmds::cache_usage,
        crate::library_cmds::cache_clear,
        crate::library_cmds::launch_file,
        crate::app_cmds::display_scale,
        crate::map_search::map_search,
        crate::map_search::map_search_key_status,
        crate::map_search::map_search_key_save,
        crate::map_search::map_search_key_remove,
        // the editing, export and print commands
        crate::export_cmds::export_images,
        crate::export_cmds::export_cancel,
        crate::export_cmds::export_existing,
        crate::export_cmds::export_preview,
        crate::export_cmds::export_presets_load,
        crate::export_cmds::export_presets_save,
        crate::export_cmds::export_presets_export,
        crate::export_cmds::export_presets_import,
        crate::export_cmds::presets_load,
        crate::export_cmds::presets_save,
        crate::print_cmds::print_profiles,
        crate::print_cmds::print_profile_add,
        crate::print_cmds::softproof,
        crate::print_cmds::printers,
        crate::print_cmds::printer_info,
        crate::print_cmds::print_photo,
        crate::print_cmds::print_sheet,
        crate::print_cmds::fonts,
        crate::export_cmds::hdr_merge,
        crate::export_cmds::hdr_can_align,
        crate::export_cmds::pano_merge,
        crate::export_cmds::pano_preview,
        crate::export_cmds::pano_can_merge,
        crate::export_cmds::merge_cancel,
        crate::ai_cmds::ai_object,
        crate::ai_cmds::ai_model_ensure,
        crate::ai_cmds::ai_model_reinstall,
        crate::ai_cmds::ai_mask,
        crate::ai_cmds::ai_depth,
        crate::ai_cmds::ai_denoise,
        crate::ai_cmds::ai_denoise_preview,
        crate::ai_cmds::ai_accel,
        crate::edit_cmds::mask_shapes,
        crate::edit_cmds::combine,
        crate::edit_cmds::masks,
        crate::edit_cmds::mask_delete,
        crate::edit_cmds::mask_rename,
        crate::edit_cmds::mask_map,
        crate::edit_cmds::range_map,
        crate::edit_cmds::zones,
        crate::edit_cmds::spots,
        crate::edit_cmds::spots_enable,
        crate::edit_cmds::spot_source,
        crate::edit_cmds::upright,
        crate::edit_cmds::looks_list,
        crate::export_cmds::shared_import,
        crate::edit_cmds::look_export,
        crate::edit_cmds::look_delete,
        crate::edit_cmds::look_apply,
        crate::edit_cmds::look_amount,
        crate::edit_cmds::agx_presets,
        crate::edit_cmds::agx_presets_pick,
        crate::edit_cmds::agx_profiles_load,
        crate::edit_cmds::agx_profiles_save,
        crate::export_cmds::positive_export,
        crate::edit_cmds::spektra_stocks,
        crate::edit_cmds::spektra_fetch,
        crate::edit_cmds::lenses,
        crate::edit_cmds::module_schema,
        crate::edit_cmds::instances,
        crate::edit_cmds::instance,
        // Preferences, performance reports and the app itself
        crate::app_cmds::darktable_resources,
        crate::app_cmds::darktable_resources_set,
        crate::memory_budget::memory_budget,
        crate::app_cmds::gpu_edits,
        crate::app_cmds::gpu_edits_set,
        crate::app_cmds::webview_renderer,
        crate::app_cmds::webview_renderer_set,
        crate::app_cmds::licenses,
        crate::app_cmds::engine_quit,
        crate::app_cmds::engine_restart,
        crate::app_cmds::menu_set,
        crate::app_cmds::csp_violation,
        crate::app_cmds::preview_fullscreen,
        crate::app_cmds::perf_set,
        crate::app_cmds::perf_trace_start,
        crate::app_cmds::perf_trace_stop,
        crate::app_cmds::perf_modules,
        crate::app_cmds::perf_report_write,
        crate::app_cmds::perf_machine,
        crate::app_cmds::perf_ping,
        crate::app_cmds::gpu_check_parity,
        crate::resources::perf_resources_start,
        crate::resources::perf_resources_stop,
        // Immich
        crate::immich_cmds::immich_albums,
        crate::immich_cmds::immich_create_album,
        crate::immich_cmds::immich_export_check,
        crate::immich_cmds::immich_browse_check,
        crate::immich_cmds::immich_search,
        crate::immich_cmds::immich_libraries,
        crate::immich_cmds::immich_suggestions,
        crate::immich_cmds::immich_people,
        crate::immich_cmds::immich_tags,
        crate::immich_cmds::immich_thumb,
        crate::immich_cmds::immich_resolve,
        // Edit In plugins, backups and the support bundle
        crate::plugins::plugin_find_apps,
        crate::plugins::plugin_config,
        crate::plugins::plugin_config_save,
        crate::plugins::plugin_set_app,
        crate::plugins::plugin_choose_app,
        crate::plugins::plugin_launch,
        crate::plugins::plugin_watch,
        crate::plugins::plugin_cancel,
        crate::plugins::plugin_job,
        crate::plugins::plugin_returns,
        crate::plugins::plugin_return_applied,
        crate::backup::backup_components,
        crate::backup::backup_pick_save,
        crate::backup::backup_pick_open,
        crate::backup::backup_create,
        crate::backup::backup_inspect,
        crate::backup::backup_restore,
        crate::support_bundle::support_bundle_preview,
        crate::support_bundle::support_bundle_add_benchmark,
        crate::support_bundle::support_bundle_save,
        crate::support_bundle::support_bundle_discard,
    ]
}

// the app's invoke handler, which serves the commands above
pub fn handler() -> impl Fn(Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    let commands = commands().0;
    move |invoke| commands(invoke)
}

#[cfg(test)]
pub fn builder() -> tauri_specta::Builder<tauri::Wry> {
    tauri_specta::Builder::<tauri::Wry>::new()
        .commands(commands())
        // ids and sizes are serde_json numbers on the wire, never past 2^53
        .dangerously_cast_bigints_to_number()
        // one type per reply, not a Serialize and a Deserialize variant
        .disable_serde_phases()
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

    use crate::typed_edit::*;
    use crate::typed_export::*;
    use crate::typed_library::*;
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
        ("import", reads::<FolderReply>),
        ("copy", reads::<CopyReply>),
        ("sidecars", reads::<FilesReply>),
        ("remove_copy", reads::<FilesReply>),
        ("keywords", reads::<KeywordsReply>),
        ("keywords_set", reads::<KeywordsReply>),
        ("thumb", reads::<ThumbReply>),
        ("capture_times", reads::<CaptureTimesReply>),
        ("masks", reads::<MasksReply>),
        ("spots", reads::<SpotsReply>),
        ("spot_source", reads::<SpotSource>),
        ("upright", reads::<UprightReply>),
        ("fonts", reads::<FontsReply>),
        ("lenses", reads::<LensMenu>),
        ("module_schema", reads::<ModuleSchema>),
        ("instances", reads::<InstancesReply>),
        ("instance", reads::<InstanceReply>),
        ("ai_accel", reads::<AiAccelReply>),
        ("look", reads::<LookReply>),
        ("agx_presets", reads::<AgxPresetsReply>),
        ("spektra_stocks", reads::<FilmStocks>),
        ("spektra_fetch", reads::<FilmFetch>),
        ("print_profiles", reads::<PrintProfilesReply>),
        ("printers", reads::<PrintersReply>),
        ("print", reads::<PrintReply>),
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
