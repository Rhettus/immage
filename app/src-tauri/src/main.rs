// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a windowed program on Windows: without it Windows starts the app with a
// console window of its own. debug builds keep theirs, for the log
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod map_tiles;
mod map_search;
mod engine;
mod immich_search;
mod immich_upload;
mod listing;
mod plugins;
mod perf_trace;
mod frame_output;
mod resources;
mod memory_budget;
mod settings;
#[cfg(target_os = "linux")]
mod scale;
#[cfg(target_os = "linux")]
mod renderer;
mod volumes;
mod scrub;
mod support_bundle;
mod backup;
mod bindings;
mod typed_app;
mod typed_edit;
mod typed_export;
mod typed_library;
mod typed_session;
mod export_cmds;
mod library_cmds;
mod session_cmds;

use cache::Caches;
use engine::{BaseCancel, Engine, Tagged, Timing};
use serde::Deserialize;
use serde_json::{json, Map, Number, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use typed_app::{Album, Level, Licenses, Named, ParityReply, Resolved, SearchPage, Toggle};
use typed_edit::{AccelProvider, AgxPresetsReply, AgxProfile, AiAccelReply, CombineMember, DepthMap, FilmFetch, FilmStocks, FontFamily, FontsReply, LensMenu, LookReply, MapView, MaskInfo, MasksReply, NewSpot, Spot, SpotSource, SpotsReply, UprightReply};
use typed_export::{GeneratedReply, LookInfo, PrintProfile, PrintProfilesReply, PrintReply, PrinterInfoReply, PrintersReply};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use crate::session_cmds::shm_frame;
use crate::library_cmds::launch_path;
use crate::library_cmds::Launch;
use crate::export_cmds::path_inside;
use crate::export_cmds::pick_save;
use crate::export_cmds::pick_files;
use crate::export_cmds::merge;

struct AppState {
    // engine(), not this directly
    engine: perf_trace::TracedMutex<Engine>,
    // reaches the engine while a request holds it
    base_cancel: BaseCancel,
    frame_path: PathBuf,
    // thumbnails, folder imports and background exports, which go to the
    // engine without engine()
    tagged: Tagged,
    // export_images' running jobs, which export_cancel stops
    export_cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    presets_path: PathBuf,
    preview_path: PathBuf,
    range_path: PathBuf,
    denoise_path: PathBuf,
    looks_dir: PathBuf,
    // looks the user imported, beside the shipped ones (look_import)
    user_looks_dir: PathBuf,
    models_dir: PathBuf,
    // the folder being read; an older open_folder stops when it changes
    folder_token: AtomicU64,
    // Preferences' performance overlay: renders collect darktable's per-module
    // timings while it is on, and its reports are written to perf_dir
    perf_on: AtomicBool,
    perf_last: Mutex<Vec<Timing>>,
    perf_by_request: Mutex<HashMap<u64, Vec<Timing>>>,
    perf_modules_dropped: AtomicU64,
    perf_dir: PathBuf,
    runtime: PathBuf,
    // darktable's resource level the engine started with (a respawn reads it again)
    resource_level: Mutex<String>,
    // whether the engine started with its edits on the GPU
    gpu_edits: AtomicBool,
    // the engine's connection, for restart and its state events
    engine_link: Arc<engine::Link>,
    // Drop after Engine so it cannot still be writing into this directory.
    _frame_output: Arc<frame_output::FrameOutput>,
}

impl AppState {
    // the engine for a request its main loop serves, one at a time
    fn engine(&self, operation: &'static str) -> perf_trace::Guard<'_, Engine> {
        let mut guard = self.engine.lock(operation, None);
        guard.set_operation(operation);
        guard
    }
}

// the checkout this app is built from: the dev build runs the engine from
// its build/ tree, and keeps runtime state there too
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

// Linux: the folder holding the web extension for shared-memory frames
// (webext/frames.c), built by build_appimage.sh: in the bundle's
// resources, or in a dev build the checkout's. none, and frames come
// through Tauri's reply
#[cfg(target_os = "linux")]
fn webext_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = if cfg!(debug_assertions) {
        repo_root().join("app/src-tauri/resources/webext")
    } else {
        app.path().resource_dir().ok()?.join("webext")
    };
    dir.join("libimmage-frames.so").is_file().then_some(dir)
}

// replace a mask's shapes (made when missing)
#[tauri::command]
#[specta::specta]
async fn mask_shapes(state: State<'_, AppState>, name: String, shapes: Vec<Value>) -> Result<(), String> {
    state.engine("mask_shapes")
        .request(json!({ "cmd": "mask", "name": name, "shapes": shapes })).map(|_| ())
}

// replace a combined mask's members ([{ mask, opacity 0-1, invert }]) and
// the range components its instances take, which drives masks' shared
// instances (app/src/localMerge.ts)
#[tauri::command]
#[specta::specta]
async fn combine(state: State<'_, AppState>, name: String, members: Vec<CombineMember>, ranges: Option<Vec<Value>>)
    -> Result<(), String> {
    state.engine("combine")
        .request(json!({ "cmd": "combine", "name": name, "members": members, "ranges": ranges })).map(|_| ())
}

// the open image's masks, with these fields ({ op: [field] }) of their
// instances
#[tauri::command]
#[specta::specta]
async fn masks(state: State<'_, AppState>, fields: std::collections::BTreeMap<String, Vec<String>>) -> Result<Vec<MaskInfo>, String> {
    let reply = state.engine("masks").request(json!({ "cmd": "masks", "fields": fields }))?;
    serde_json::from_value::<MasksReply>(reply).map(|r| r.masks).map_err(|e| format!("masks: unexpected reply: {e}"))
}

// the Lensfun lenses Lens Corrections can use for the open photo, and the
// one matched from its EXIF (the engine's _lens_menu)
#[tauri::command]
#[specta::specta]
async fn lenses(state: State<'_, AppState>) -> Result<LensMenu, String> {
    let reply = state.engine("lenses").request(json!({ "cmd": "lenses" }))?;
    serde_json::from_value(reply).map_err(|e| format!("lenses: unexpected reply: {e}"))
}

// Upright's fit of rotate and perspective: { rotation, lensshift_v,
// lensshift_h, fit }. Guided passes its drawn lines (x1, y1, x2, y2 in the
// input image, 0-1)
#[tauri::command]
#[specta::specta]
async fn upright(state: State<'_, AppState>, mode: String, guides: Option<Vec<Number>>, aspect: Number)
    -> Result<UprightReply, String> {
    let mut req = json!({ "cmd": "upright", "mode": mode, "aspect": aspect });
    if let Some(g) = guides {
        req["guides"] = json!(g);
    }
    let reply = state.engine("upright").request(req)?;
    serde_json::from_value(reply).map_err(|e| format!("upright: unexpected reply: {e}"))
}

// how much range components select over a width x height grid of the shown
// image: u32 width and height, then one byte per point
#[tauri::command]
#[specta::specta]
async fn range_map(state: State<'_, AppState>, ranges: Vec<Value>, width: u32, height: u32) -> Result<bindings::Frame, String> {
    let mut engine = state.engine("range_map");
    engine.request(json!({ "cmd": "range_map", "ranges": ranges, "width": width, "height": height,
                           "out": state.range_path }))?;
    // read while the engine is still ours, so no other request overwrites it
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("range map: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// the zone (Zone System, scene-referred) of each point of a width x height
// grid of the shown image, as (z + 1) * 20, and the zones' statistics:
// u32 width, height and JSON length, the JSON, then one byte per point
#[tauri::command]
#[specta::specta]
async fn zones(state: State<'_, AppState>, width: u32, height: u32, transition: Number, stage: String)
    -> Result<bindings::Frame, String> {
    let mut engine = state.engine("zones");
    let reply = engine.request(json!({ "cmd": "zones", "width": width, "height": height, "transition": transition,
                                       "stage": stage, "out": state.range_path }))?;
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("zones: {e}"))?;
    drop(engine);
    let stats = reply.to_string().into_bytes();
    let mut out = Vec::with_capacity(12 + stats.len() + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&(stats.len() as u32).to_le_bytes());
    out.extend_from_slice(&stats);
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// a mask as darktable makes it, refinements and all, over a width x height
// grid of the shown image: laid out as range_map's reply. `op` instead of a
// name maps that module's own mask (a details threshold's). with a view
// ({ x, y, scale }, as a render's), the grid is that window of the image at
// that scale, width x height pixels or what of it lies on the image
#[tauri::command]
#[specta::specta]
async fn mask_map(state: State<'_, AppState>, name: Option<String>, op: Option<String>, width: u32, height: u32,
                  view: Option<MapView>) -> Result<bindings::Frame, String> {
    let mut engine = state.engine("mask_map");
    let mut req = json!({ "cmd": "mask_map", "width": width, "height": height, "out": state.range_path });
    if let Some(n) = name {
        req["name"] = json!(n);
    }
    if let Some(o) = op {
        req["op"] = json!(o);
    }
    if let Some(v) = view {
        req["x"] = json!(v.x);
        req["y"] = json!(v.y);
        req["scale"] = json!(v.scale);
    }
    let reply = engine.request(req)?;
    let width = reply["width"].as_u64().map_or(width, |w| w as u32);
    let height = reply["height"].as_u64().map_or(height, |h| h as u32);
    let map = frame_output::FrameOutput::read(&state.range_path).map_err(|e| format!("mask map: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + map.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&map);
    Ok(bindings::Frame(Response::new(out)))
}

// a request the engine's main loop answers once it has what it needs of
// the open photo, and a thread of the engine's then answers with the tag:
// AI Denoise and the AI selections, whose models take seconds to a
// minute, while the engine is free for editing
async fn on_engine_thread(state: &AppState, mut req: Value) -> Result<Value, String> {
    let tagged = state.tagged.clone();
    let tag = tagged.tag();
    req["tag"] = json!(tag);
    let answer = tagged.expect(tag)?;
    if let Err(e) = state.engine("on_engine_thread").request(req) {
        tagged.forget(tag);
        return Err(e);
    }
    tauri::async_runtime::spawn_blocking(move || answer.wait()).await.map_err(|e| e.to_string())?
}

// select an object with the AI model: clicks [[x, y, include]] and/or a
// box [x0, y0, x1, y1] in shown-image units; replies with its outline.
// `inset` false traces it on its edge, for a selection the mask takes away
// (main.c, _trace_json). with `backdrop`, replies { paths, backdrop }: the
// hue range of a plain background to take out, or null (main.c, _backdrop)
// the reply is free-form because its shape follows `backdrop`
#[tauri::command]
#[specta::specta]
async fn ai_object(state: State<'_, AppState>, points: Vec<Vec<Number>>, r#box: Option<Vec<Number>>, inset: Option<bool>,
                   backdrop: Option<bool>) -> Result<Value, String> {
    let mut req = json!({ "cmd": "ai_object", "points": points });
    if let Some(b) = r#box {
        req["box"] = json!(b);
    }
    if let Some(i) = inset {
        req["inset"] = json!(i);
    }
    ai_outline(&state, req, backdrop).await
}

// an AI selection's reply as its command gives it: the paths, or with
// `backdrop`, the paths and the backdrop (its hue range and edge outline)
async fn ai_outline(state: &AppState, mut req: Value, backdrop: Option<bool>) -> Result<Value, String> {
    let backdrop = backdrop.unwrap_or(false);
    if backdrop {
        req["backdrop"] = json!(true);
    }
    let reply = on_engine_thread(state, req).await?;
    Ok(if backdrop {
        json!({ "paths": reply["paths"], "backdrop": reply["backdrop"] })
    } else {
        reply["paths"].clone()
    })
}

// darktable's AI models come from its model repository, in the release made
// for this darktable version, as darktable's own download does
// (src/common/ai_models.c). they are downloaded here and the engine unpacks
// them with darktable's libarchive, so no curl or unzip of the system's is
// needed: a fresh Linux install can lack either (Arch has no unzip).
// the pinned checksums and the repository are below, at MODEL_RELEASES

fn sha256_file(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

// on Windows a console program gets a console window of its own unless
// told not to (CREATE_NO_WINDOW)
fn no_console(_cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        _cmd.creation_flags(0x0800_0000);
    }
}

// the error, and whether trying again may help: a dropped connection or a
// server's 5xx or 429 may, a 404 will not
fn fetch_once(http: &reqwest::blocking::Client, url: &str, dest: &Path, limit: Option<u64>)
              -> Result<(), (String, bool)> {
    let r = http.get(url).send().map_err(|e| (e.to_string(), true))?;
    let status = r.status();
    if !status.is_success() {
        return Err((status.to_string(), status.is_server_error() || status.as_u16() == 429));
    }
    let larger = || (format!("{url} was larger than expected"), false);
    if let (Some(limit), Some(len)) = (limit, r.content_length()) {
        if len > limit {
            return Err(larger());
        }
    }
    let mut file = std::fs::File::create(dest).map_err(|e| (format!("{}: {e}", dest.display()), false))?;
    // one byte past the limit is enough to know the body is too big
    let mut body = std::io::Read::take(r, limit.map_or(u64::MAX, |l| l.saturating_add(1)));
    let copied = std::io::copy(&mut body, &mut file).map_err(|e| (e.to_string(), true))?;
    if limit.is_some_and(|l| copied > l) {
        return Err(larger());
    }
    Ok(())
}

// tried three times. the timeout bounds each read
// of the body (reqwest's blocking Response::read), not the whole download,
// so only a stalled one gives up. a body past `limit` bytes is cut off
// and not tried again
fn fetch(url: &str, dest: &Path, limit: Option<u64>) -> Result<(), String> {
    let http = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last = String::new();
    for attempt in 0..3u64 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_secs(attempt));
        }
        match fetch_once(&http, url, dest, limit) {
            Ok(()) => return Ok(()),
            Err((e, again)) => {
                last = e;
                if !again {
                    break;
                }
            }
        }
    }
    let _ = std::fs::remove_file(dest);
    Err(format!("could not download {url}: {last}"))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))
}

// the model release for darktable `short` ("5.7.0") in releases-index's
// compatible_releases; for a version that is not one (no release tags in
// the checkout), the newest listed
fn model_release(compatible: &Value, short: &str) -> Result<String, String> {
    let numeric = |v: &str| v.split('.').map(|p| p.parse::<u32>().ok()).collect::<Option<Vec<_>>>();
    if let Some(t) = compatible[short].as_str() {
        return Ok(t.to_string());
    }
    if numeric(short).is_some() {
        return Err(format!("no AI model release for darktable {short}"));
    }
    compatible.as_object().into_iter().flatten()
        .filter_map(|(v, t)| Some((numeric(v)?, t.as_str()?)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, t)| t.to_string())
        .ok_or_else(|| "no AI model release listed".to_string())
}

// the model archives this Immage trusts, per darktable version: the model
// repository's release tag and each archive's sha256 and size, copied from
// that release's versions.json when the darktable pin moved. a pinned
// version reads neither releases-index.json nor versions.json, so an
// archive changed upstream under the same tag is refused rather than
// installed. scripts/pin_models.py writes the block; moving the pin runs
// it (app/docs/dev/darktable-pin.md)
struct ModelPin {
    id: &'static str,
    sha256: &'static str,
    size: u64,
}

struct ModelRelease {
    darktable: &'static str,
    tag: &'static str,
    models: &'static [ModelPin],
}

// BEGIN scripts/pin_models.py
const MODEL_RELEASES: &[ModelRelease] = &[ModelRelease {
    darktable: "5.7.0",
    tag: "nightly-5.7.0",
    models: &[
        ModelPin { id: "denoise-nafnet", sha256: "027961b3e6d1d4d2ba2d7a412688c0542e6a6e2cf7ec2f8e16030cf0a311fb0a", size: 108413592 },
        ModelPin { id: "denoise-nind", sha256: "a516197e62681d80ee886f535fa1a45b0f0ef28c3a578f706b71cfce61cfe56e", size: 55008210 },
        ModelPin { id: "mask-object-sam21-base-plus", sha256: "e953844fd4c0a035422cdb2fe27d7390bce3dbb0c810daefc10170c1a82994e8", size: 308511140 },
        ModelPin { id: "mask-object-sam21-small", sha256: "2c317a5e7f622f12ab916c1bb248b0383675d8ba6e4bccd3d0c9ddb7decc9ab8", size: 169639526 },
        ModelPin { id: "mask-object-sam21-tiny", sha256: "6aa57644bed82fcbdc851e17c23dd71f0880a0c4da689c5e560a11834a32f1bb", size: 143293697 },
        ModelPin { id: "mask-object-segnext-b2hq", sha256: "ab63af19216ad233792dca98087dc9ec7aebe301288f69eed59563d468cfd6f3", size: 422711159 },
        ModelPin { id: "rawdenoise-nind", sha256: "1a0db3dc4a4db13ce5eee7aa2fed097914be28a3f628dc6071dc6aa8d16377bc", size: 57700134 },
        ModelPin { id: "upscale-bsrgan", sha256: "b3a96b407a628c5de1618843e9832b872996f24166aad6a849ae9b8532851f33", size: 124072128 },
        ModelPin { id: "upscale-realplksr", sha256: "b88744faa595bd75f2455bf980d95e8d8f249875c211357c6809bf4e4ecfb1ea", size: 54935127 },
    ],
}];
// END scripts/pin_models.py

// where darktable's models are fetched from, and the pins they are held
// to; tests swap in a local server and their own pins
struct ModelSite<'a> {
    index: &'a str,
    releases: &'a str,
    pins: &'a [ModelRelease],
}

const DARKTABLE_AI: ModelSite<'static> = ModelSite {
    index: "https://raw.githubusercontent.com/darktable-org/darktable-ai/HEAD",
    releases: "https://github.com/darktable-org/darktable-ai/releases/download",
    pins: MODEL_RELEASES,
};

// a model archive to download: its release, sha256 and size, and whether
// they came from the pins or from the release's own versions.json
struct ModelSource {
    tag: String,
    sha256: String,
    size: u64,
    pinned: bool,
}

// None for a darktable version with no pins: a dev build on a checkout
// without release tags, or a pin moved without running pin_models.py
fn pinned_model(pins: &[ModelRelease], short: &str, id: &str) -> Option<Result<ModelSource, String>> {
    let release = pins.iter().find(|r| r.darktable == short)?;
    Some(release.models.iter().find(|m| m.id == id)
        .map(|m| ModelSource { tag: release.tag.into(), sha256: m.sha256.into(), size: m.size, pinned: true })
        .ok_or_else(|| format!("model '{id}' is not in release {}", release.tag)))
}

// the release and checksum as the model repository publishes them now,
// as darktable's own download reads them
fn published_model(site: &ModelSite, dl: &Path, short: &str, id: &str) -> Result<ModelSource, String> {
    let index = dl.join("releases-index.json");
    fetch(&format!("{}/releases-index.json", site.index), &index, Some(1_000_000))?;
    let releases = read_json(&index)?;
    let tag = model_release(&releases["compatible_releases"], short)?;
    let versions = dl.join("versions.json");
    fetch(&format!("{}/{tag}/versions.json", site.releases), &versions, Some(1_000_000))?;
    let entry = read_json(&versions)?["models"][id].clone();
    let sha256 = entry["sha256"].as_str().and_then(|s| s.strip_prefix("sha256:"))
        .ok_or_else(|| format!("model '{id}' is not in release {tag}"))?
        .to_string();
    Ok(ModelSource { tag, sha256, size: entry["size"].as_u64().unwrap_or(0), pinned: false })
}

// `progress` hears each stage ({ id, stage, mb? }); the app passes them on
// to the window as "ai-model" events. `unpack` unpacks an archive into a
// folder: the engine's unpack
type Unpack<'a> = &'a dyn Fn(&Path, &Path) -> Result<(), String>;

fn install_model(progress: &dyn Fn(Value), unpack: Unpack, site: &ModelSite, dir: &Path, id: &str,
                 version: &str) -> Result<(), String> {
    let dl = dir.join("_dl");
    std::fs::create_dir_all(&dl).map_err(|e| e.to_string())?;
    // "5.7.0+1252~g0967d3653e" is release 5.7.0's. a checkout without
    // darktable's release-* tags (a clone of a fork that does not carry
    // them) reports no darktable version, as on the Windows build; then
    // the newest release darktable lists is the one
    let short = version.split(['+', '~', '-']).next().unwrap_or("");
    let source = match pinned_model(site.pins, short, id) {
        Some(pinned) => pinned?,
        None => {
            let s = published_model(site, &dl, short, id)?;
            eprintln!("AI model '{id}': no pinned checksum for darktable '{version}'; \
                       using {}'s published one", s.tag);
            s
        }
    };
    progress(json!({ "id": id, "stage": "downloading", "mb": source.size / 1_000_000 }));
    let archive = dl.join(format!("{id}.dtmodel"));
    let part = dl.join(format!("{id}.dtmodel.part"));
    let limit = if source.size > 0 { Some(source.size) } else { None };
    fetch(&format!("{}/{}/{id}.dtmodel", site.releases, source.tag), &part, limit)?;
    if sha256_file(&part)? != source.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(if source.pinned {
            format!("the AI model '{id}' offered for download is not the one this version of Immage \
                     was made with, so it was not installed: an update of Immage is needed")
        } else {
            format!("the downloaded model '{id}' failed its checksum")
        });
    }
    std::fs::rename(&part, &archive).map_err(|e| e.to_string())?;
    progress(json!({ "id": id, "stage": "installing" }));
    let unpacked = unpack(&archive, dir);
    let _ = std::fs::remove_file(&archive);
    unpacked?;
    if !dir.join(id).join("config.json").exists() {
        return Err(format!("could not unpack the model '{id}'"));
    }
    progress(json!({ "id": id, "stage": "ready" }));
    Ok(())
}

// models that are not darktable's: one ONNX file, pinned by checksum and
// size, fetched from a fixed commit of its repository, and the config.json darktable's model registry reads, written beside it
struct ExtraModel {
    id: &'static str,
    url: &'static str,
    sha256: &'static str,
    size: u64,
    mb: u64,
    config: &'static str,
}

const EXTRA_MODELS: &[ExtraModel] = &[ExtraModel {
    id: "mask-subject-birefnet-lite",
    // BiRefNet lite, MIT (https://github.com/ZhengPeng7/BiRefNet), as
    // exported to ONNX by onnx-community
    url: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model.onnx",
    sha256: "5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
    size: 224005088,
    mb: 224,
    config: r#"{ "id": "mask-subject-birefnet-lite", "name": "mask birefnet lite",
  "description": "BiRefNet lite salient object segmentation, for Select Subject and Background",
  "task": "mask", "arch": "birefnet", "backend": "onnx", "version": "1.0" }"#,
}, ExtraModel {
    id: "mask-scene-segformer-b2",
    // SegFormer B2 trained on ADE20K (NVIDIA's license, non-commercial
    // use), as exported to ONNX for transformers.js by Xenova
    url: "https://huggingface.co/Xenova/segformer-b2-finetuned-ade-512-512/resolve/df795789e70f4089c8658907679c6fd2367c89a5/onnx/model.onnx",
    sha256: "819c15e6af8c4de3359c1de7ab0a17d0dde495df1d16f8908a7163f8038e0fa0",
    size: 110445327,
    mb: 110,
    config: r#"{ "id": "mask-scene-segformer-b2", "name": "mask segformer b2 ade20k",
  "description": "SegFormer B2 scene segmentation (ADE20K, 150 classes), for Select Sky and Landscape",
  "task": "mask", "arch": "segformer", "backend": "onnx", "version": "1.0" }"#,
}, ExtraModel {
    id: "mask-depth-da2-small",
    // Depth Anything V2 Small, Apache 2.0
    // (https://github.com/DepthAnything/Depth-Anything-V2), as exported to
    // ONNX for transformers.js by onnx-community
    url: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model.onnx",
    sha256: "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c",
    size: 99060839,
    mb: 99,
    config: r#"{ "id": "mask-depth-da2-small", "name": "mask depth anything v2 small",
  "description": "Depth Anything V2 Small relative depth, for Depth Range",
  "task": "mask", "arch": "depthanything", "backend": "onnx", "version": "1.0" }"#,
}];

fn install_extra(progress: &dyn Fn(Value), dir: &Path, m: &ExtraModel) -> Result<(), String> {
    let dest = dir.join(m.id);
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    progress(json!({ "id": m.id, "stage": "downloading", "mb": m.mb }));
    let part = dest.join("model.onnx.part");
    fetch(m.url, &part, Some(m.size))?;
    if sha256_file(&part)? != m.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("the downloaded model '{}' failed its checksum", m.id));
    }
    std::fs::rename(&part, dest.join("model.onnx")).map_err(|e| e.to_string())?;
    // written last: the registry finds the model only once it is whole
    std::fs::write(dest.join("config.json"), m.config).map_err(|e| e.to_string())?;
    progress(json!({ "id": m.id, "stage": "ready" }));
    Ok(())
}

// make sure an AI model is installed, downloading it on first use
#[tauri::command]
#[specta::specta]
async fn ai_model_ensure(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.models_dir.clone();
    if dir.join(&id).join("config.json").exists() {
        return Ok(());
    }
    if let Some(m) = EXTRA_MODELS.iter().find(|m| m.id == id) {
        return tauri::async_runtime::spawn_blocking(move || {
            install_extra(&|v| { let _ = app.emit("ai-model", v); }, &dir, m)
        })
            .await
            .map_err(|e| e.to_string())?;
    }
    let reply = state.engine("ai_model_ensure").request(json!({ "cmd": "version" }))?;
    let version = reply["version"].as_str().unwrap_or("").to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let unpack = |archive: &Path, into: &Path| {
            app.state::<AppState>().engine("ai_model_unpack")
                .request(json!({ "cmd": "unpack", "archive": archive, "dir": into }))
                .map(|_| ())
        };
        install_model(&|v| { let _ = app.emit("ai-model", v); }, &unpack, &DARKTABLE_AI, &dir, &id, &version)
    })
        .await
        .map_err(|e| e.to_string())?
}

// an installed model the engine cannot load, deleted and downloaded again:
// an unpack cut short leaves its config.json, which ai_model_ensure takes
// for a whole model, so nothing else ever replaces it
#[tauri::command]
#[specta::specta]
async fn ai_model_reinstall(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("not a model id: {id}"));
    }
    match std::fs::remove_dir_all(state.models_dir.join(&id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
        _ => {}
    }
    ai_model_ensure(app, state, id).await
}

// a one-click AI mask ("subject"): its outline, as ai_object replies, and
// `inset` as there. "depth" takes the band of depth it covers, [near, far]
// in 0-1. `backdrop` as there too, and the reply as free-form
#[tauri::command]
#[specta::specta]
async fn ai_mask(state: State<'_, AppState>, kind: String, range: Option<[Number; 2]>, inset: Option<bool>,
                 backdrop: Option<bool>) -> Result<Value, String> {
    let mut req = json!({ "cmd": "ai_mask", "kind": kind });
    if let Some(r) = range {
        req["range"] = json!(r);
    }
    if let Some(i) = inset {
        req["inset"] = json!(i);
    }
    ai_outline(&state, req, backdrop).await
}

// the depth map, about `size` across: { width, height, data } with data
// 0 (nearest) to 255 by rows
#[tauri::command]
#[specta::specta]
async fn ai_depth(state: State<'_, AppState>, size: u32) -> Result<DepthMap, String> {
    let reply = on_engine_thread(&state, json!({ "cmd": "ai_depth", "size": size })).await?;
    serde_json::from_value(reply).map_err(|e| format!("ai_depth: unexpected reply: {e}"))
}

// AI Denoise of the open raw at `strength` (0-1): a new DNG beside it with
// its edit, which the folder view then shows after it, as an Edit In
// result. replies { path, original, image }; the engine takes the edit,
// then denoises on a thread of its own
#[tauri::command]
#[specta::specta]
async fn ai_denoise(state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>, strength: Number)
    -> Result<GeneratedReply, String> {
    let reply = on_engine_thread(&state, json!({ "cmd": "ai_denoise", "strength": strength })).await?;
    let (Some(original), Some(result)) = (reply["original"].as_str(), reply["path"].as_str()) else {
        return Err("the engine gave no DNG".into());
    };
    plugins.record(plugins::Return {
        original: original.into(), result: result.into(), plugin: "ai-denoise".into(), applied: false,
    })?;
    serde_json::from_value(reply).map_err(|e| format!("ai_denoise: unexpected reply: {e}"))
}

// the spektrafilm data pack and its films and papers (engine main.c,
// _spektra_stocks)
#[tauri::command]
#[specta::specta]
async fn spektra_stocks(state: State<'_, AppState>) -> Result<FilmStocks, String> {
    let reply = state.engine("spektra_stocks").request(json!({ "cmd": "spektra_stocks" }))?;
    serde_json::from_value(reply).map_err(|e| format!("spektra_stocks: unexpected reply: {e}"))
}

// the pack's download: `action` "start", "cancel" or "status"; none waits
// for the network (engine main.c, _spektra_fetch)
#[tauri::command]
#[specta::specta]
async fn spektra_fetch(state: State<'_, AppState>, action: String) -> Result<FilmFetch, String> {
    let reply = state.engine("spektra_fetch").request(json!({ "cmd": "spektra_fetch", "action": action }))?;
    serde_json::from_value(reply).map_err(|e| format!("spektra_fetch: unexpected reply: {e}"))
}

// AI Denoise's preview: a crop about `size` pixels square centered on (u, v)
// of the edited photo. replies a header (width, height as u32; the crop's
// share of the photo across and down as f32), then the crop as float linear
// RGB without and with the denoise, for the dialog to mix at its Amount
#[tauri::command]
#[specta::specta]
async fn ai_denoise_preview(state: State<'_, AppState>, u: Number, v: Number, size: u32) -> Result<bindings::Frame, String> {
    let mut engine = state.engine("ai_denoise_preview");
    let reply = engine.request(json!({
        "cmd": "ai_denoise_preview", "u": u, "v": v, "size": size, "out": state.denoise_path,
    }))?;
    let mut out = Vec::new();
    for k in ["width", "height"] {
        out.extend_from_slice(&(reply[k].as_u64().unwrap_or(0) as u32).to_le_bytes());
    }
    for k in ["rect_w", "rect_h"] {
        out.extend_from_slice(&(reply[k].as_f64().unwrap_or(0.0) as f32).to_le_bytes());
    }
    // read while the engine is still ours, so no other preview overwrites it
    frame_output::FrameOutput::append(&state.denoise_path, &mut out)
        .map_err(|e| format!("denoise preview: {e}"))?;
    drop(engine);
    Ok(bindings::Frame(Response::new(out)))
}

// the image's heal and clone spots: replaced by `spots` when given, and
// replied as the engine keeps them
#[tauri::command]
#[specta::specta]
async fn spots(state: State<'_, AppState>, spots: Option<Vec<Spot>>) -> Result<Vec<Spot>, String> {
    let mut req = json!({ "cmd": "spots" });
    if let Some(s) = spots {
        req["spots"] = json!(s);
    }
    let reply = state.engine("spots").request(req)?;
    serde_json::from_value::<SpotsReply>(reply).map(|r| r.spots).map_err(|e| format!("spots: unexpected reply: {e}"))
}

// the spots off for the Before view, and back on
#[tauri::command]
#[specta::specta]
async fn spots_enable(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.engine("spots_enable").request(json!({ "cmd": "spots_enable", "on": on })).map(|_| ())
}

// where a new spot should copy from: { sx, sy }
#[tauri::command]
#[specta::specta]
async fn spot_source(state: State<'_, AppState>, spot: NewSpot) -> Result<SpotSource, String> {
    let reply = state.engine("spot_source").request(json!({ "cmd": "spot_source", "spot": spot }))?;
    serde_json::from_value(reply).map_err(|e| format!("spot_source: unexpected reply: {e}"))
}

#[tauri::command]
#[specta::specta]
async fn mask_delete(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.engine("mask_delete").request(json!({ "cmd": "mask_delete", "name": name })).map(|_| ())
}

#[tauri::command]
#[specta::specta]
async fn mask_rename(state: State<'_, AppState>, name: String, to: String) -> Result<(), String> {
    state.engine("mask_rename").request(json!({ "cmd": "mask_rename", "name": name, "to": to })).map(|_| ())
}

// the performance overlay: on, renders collect darktable's per-module timings
#[tauri::command]
#[specta::specta]
async fn perf_set(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.perf_on.store(on, Ordering::Relaxed);
    Ok(())
}

// a content security policy violation the page saw (tauri.conf.json, csp),
// one line in webview.log in the runtime folder. the page dedupes and caps
// what it sends; the file is also capped here, so a page cannot fill the disk
#[tauri::command]
#[specta::specta]
fn csp_violation(state: State<'_, AppState>, directive: String, blocked: String, source: String, line: u32, sample: String) {
    use std::io::Write;
    let path = state.runtime.join("webview.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return;
    }
    let clip = |t: &str| t.chars().take(300).map(|c| if c.is_control() { ' ' } else { c }).collect::<String>();
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(log, "[{since}] csp violation: {} blocked={} source={}:{} sample={}", clip(&directive), clip(&blocked), clip(&source), line, clip(&sample));
    }
}

#[tauri::command]
#[specta::specta]
async fn perf_trace_start(state: State<'_, AppState>) -> Result<(), String> {
    state.perf_by_request.lock().unwrap().clear();
    state.perf_modules_dropped.store(0, Ordering::Relaxed);
    state.engine("perf_trace_start").cache_trace(true)?;
    state.engine.start();
    Ok(())
}
#[tauri::command]
#[specta::specta]
async fn perf_trace_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    state.engine("perf_trace_stop").cache_trace(false)?;
    Ok(())
}

// the last render's per-module timings, while the overlay is on
#[tauri::command]
#[specta::specta]
async fn perf_modules(state: State<'_, AppState>, request: Option<u64>) -> Result<Vec<Timing>, String> {
    if let Some(id) = request {
        return state.perf_by_request.lock().unwrap().remove(&id).ok_or_else(|| "module timings for request unavailable".to_string());
    }
    Ok(state.perf_last.lock().unwrap().clone())
}

// the GPU check's comparison of one CPU and one GPU render of the edit
// (main.c, _parity), with each pass's module timings. a case that differs
// writes its amplified difference as <diff>.png in the reports folder
#[tauri::command]
#[specta::specta]
async fn gpu_check_parity(state: State<'_, AppState>, size: Option<u32>, diff: Option<String>,
                          self_check: Option<bool>) -> Result<ParityReply, String> {
    let mut req = json!({ "cmd": "parity", "size": size.unwrap_or(1024), "self": self_check.unwrap_or(false) });
    if let Some(name) = diff {
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err("bad diff name".into());
        }
        std::fs::create_dir_all(&state.perf_dir).map_err(|e| e.to_string())?;
        req["diff"] = json!(state.perf_dir.join(format!("{name}.png")).to_string_lossy());
    }
    let mut engine = state.engine("gpu_check_parity");
    // the marks around it keep earlier requests' timings out of its own
    engine.perf_mark();
    let reply = engine.request(req)?;
    let timings = engine.perf_mark();
    let mut passes: std::collections::BTreeMap<String, Vec<Timing>> = Default::default();
    let mut pass = String::new();
    for t in timings {
        if t.kind == "pass" {
            pass = t.label.clone();
            passes.insert(pass.clone(), Vec::new());
        } else if let Some(list) = passes.get_mut(&pass) {
            // the check pipe is a full pipe; a thumbnail or preview drawn
            // meanwhile on another thread is not part of its pass
            if t.pipe.is_empty() || t.pipe == "full" { list.push(t); }
        }
    }
    let mut parity: ParityReply = serde_json::from_value(reply).map_err(|e| format!("unexpected parity reply: {e}"))?;
    parity.modules = passes;
    Ok(parity)
}

// does nothing: the GUI benchmark times a call's round trip on its own,
// the cost every engine call pays on top of its work
#[tauri::command]
#[specta::specta]
async fn perf_ping() -> Result<(), String> {
    Ok(())
}

// a GUI benchmark's report, as <name>.json in the reports folder; its path back
#[tauri::command]
#[specta::specta]
async fn perf_report_write(state: State<'_, AppState>, name: String, mut report: Value) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("bad report name".into());
    }
    std::fs::create_dir_all(&state.perf_dir).map_err(|e| e.to_string())?;
    let path = state.perf_dir.join(format!("{name}.json"));
    let (spans, dropped, unfinished) = state.engine.snapshot();
    report["build"] = json!({ "commit": BUILD_COMMIT, "dirty": build_dirty() });
    if report["diagnostics"]["enabled"].as_bool() == Some(true) {
        report["diagnostics"]["cache"] = state.engine("perf_cache_report").cache_report();
        report["diagnostics"]["native"] = json!({ "clock": "native monotonic milliseconds; independent of frontend clock",
            "droppedSpans": dropped, "droppedModuleTimings":state.perf_modules_dropped.load(Ordering::Relaxed),
            "unfinished": unfinished.iter().map(|s| json!({ "id":s.id, "requestId":s.request, "operation":s.operation, "waitAt":s.wait, "acquiredAt":s.acquired })).collect::<Vec<_>>(),
            "scope": "AppState engine mutex; tagged/background engine traffic is outside this mutex",
            "releaseMarker": "before guard destruction; excludes instrumentation and unlock overhead",
            "spans": spans.iter().map(|s| json!({ "id": s.id, "requestId": s.request, "operation": s.operation,
                "waitAt": s.wait, "acquiredAt": s.acquired, "releasedAt": s.released, "outputMs": s.output_ms.map(|t| json!({
                    "allocate":t[0], "convert":t[1], "file":t[2], "free":t[3] })) })).collect::<Vec<_>>() });
    }
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// the system's own id for this machine, hashed: reports get passed around
// to compare machines, and the raw hardware UUID need not go with them.
// benchmarking/bench.py (machine_id) hashes it the same way, so engine runs
// and GUI reports from one machine match
fn machine_id() -> Option<String> {
    use sha2::{Digest, Sha256};
    let run = |prog: &str, args: &[&str]| {
        let mut cmd = std::process::Command::new(prog);
        cmd.args(args);
        no_console(&mut cmd);
        cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let raw = if cfg!(target_os = "macos") {
        // "IOPlatformUUID" = "XXXXXXXX-..."
        run("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?.lines()
            .find(|l| l.contains("\"IOPlatformUUID\""))
            .and_then(|l| l.rsplit('"').nth(1).map(str::to_string))
    } else if cfg!(windows) {
        // "    MachineGuid    REG_SZ    xxxxxxxx-..."
        run("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])?.lines()
            .find(|l| l.contains("MachineGuid"))
            .and_then(|l| l.split_whitespace().last().map(str::to_string))
    } else {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"].iter().find_map(|p| std::fs::read_to_string(p).ok())
    }?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let hash = Sha256::digest(format!("immage-bench:{raw}"));
    Some(hash.iter().take(6).map(|b| format!("{b:02x}")).collect())
}

// the id reports carry: the hashed system id, or, where the system gives none,
// a random one made once per install and kept in `dir`. Never the host name.
fn report_machine_id(dir: Option<&Path>) -> Option<String> {
    if let Some(id) = machine_id() {
        return Some(id);
    }
    let file = dir?.join("machine-id");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let t = text.trim();
        if t.len() == 12 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(t.to_string());
        }
    }
    use sha2::{Digest, Sha256};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let local = 0u8;
    let hash = Sha256::digest(format!("immage-install:{now}:{}:{:p}", std::process::id(), &local));
    let id: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir?).ok()?;
    std::fs::write(&file, &id).ok()?;
    Some(id)
}

// the web view's EGL override is kept out of the image engine
#[cfg(target_os = "linux")]
static WEBVIEW_EGL_OVERRIDE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
#[specta::specta]
fn webview_renderer() -> Option<renderer::Status> {
    #[cfg(target_os = "linux")]
    return renderer::status();
    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
#[specta::specta]
fn webview_renderer_set(settings: State<'_, settings::Settings>, mode: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return renderer::set(&settings, &mode);
    #[cfg(not(target_os = "linux"))]
    { let _ = (settings, mode); Err("webview renderer selection is available on Linux".into()) }
}

// what decides how a frame reaches the screen on Linux: the session
// (Wayland or X11) and desktop, and the GDK and WebKit settings, as this
// process has them; an AppImage's start-up hooks can set some itself
fn display_env() -> Value {
    let var = |k: &str| std::env::var(k).ok();
    let mut vars: Map<String, Value> = std::env::vars()
        .filter(|(k, _)| k.starts_with("WEBKIT_") || k.starts_with("__GL_") || k.starts_with("__NV_")
                || k.starts_with("__EGL_"))
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    for k in ["GDK_BACKEND", "LIBGL_ALWAYS_SOFTWARE"] {
        if let Some(v) = var(k) {
            vars.insert(k.to_string(), Value::String(v));
        }
    }
    json!({
        "sessionType": var("XDG_SESSION_TYPE"),
        "desktop": var("XDG_CURRENT_DESKTOP"),
        "wayland": var("WAYLAND_DISPLAY").is_some(),
        "x11": var("DISPLAY").is_some(),
        "vars": vars,
        "renderer": webview_renderer(),
    })
}

// the machine block of a GUI benchmark report and the support bundle
fn machine_block(dir: Option<&Path>, opencl: Option<Value>) -> Value {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing())
                                             .with_memory(MemoryRefreshKind::nothing().with_ram()));
    json!({
        "id": report_machine_id(dir),
        "os": System::long_os_version(),
        "arch": System::cpu_arch(),
        "cpu": sys.cpus().first().map(|c| c.brand().trim().to_string()),
        "cores": sys.cpus().len(),
        "memoryGb": (sys.total_memory() as f64 / (1u64 << 30) as f64).round(),
        "opencl": opencl,
        "display": display_env(),
        // the user agent's version is frozen; this is WebKitGTK's,
        // WebView2's or WKWebView's own
        "webview": tauri::webview_version().ok(),
    })
}

// the machine a GUI benchmark ran on: a stable id to group reports by, and
// what it is
#[tauri::command]
#[specta::specta]
async fn perf_machine(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let opencl = state.engine("perf_machine").request(json!({ "cmd": "opencl" })).ok()
        .map(|mut r| { if let Some(o) = r.as_object_mut() { o.remove("ok"); } r });
    let dir = app.path().app_data_dir().ok();
    tauri::async_runtime::spawn_blocking(move || machine_block(dir.as_deref(), opencl))
    .await
    .map_err(|e| e.to_string())
}

// the screen's real scale where it is less than the whole one GTK draws
// the window at (Wayland at 125%: 1.25 against 2), so the viewer sizes
// frames for the screen; none elsewhere. an error until the window is on a
// screen, as at start: the page asks again. not async: GTK's monitor is
// read on the main thread
#[tauri::command]
#[specta::specta]
fn display_scale(window: tauri::WebviewWindow) -> Result<Option<serde_json::Number>, String> {
    #[cfg(target_os = "linux")]
    {
        let monitor = window.current_monitor().ok().flatten().ok_or("not on a screen yet")?;
        let whole = monitor.scale_factor();
        let p = monitor.position();
        let at = ((p.x as f64 / whole).round() as i32, (p.y as f64 / whole).round() as i32);
        Ok(scale::output_scale(at).filter(|s| *s < whole - 0.01).and_then(serde_json::Number::from_f64))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(None)
    }
}

// Preferences' darktable memory: the level the engine runs at, and the one
// its next start takes
#[tauri::command]
#[specta::specta]
fn darktable_resources(state: State<'_, AppState>) -> Level {
    Level { running: state.resource_level.lock().unwrap().clone(), next: engine::resource_level(&state.runtime) }
}

#[tauri::command]
#[specta::specta]
fn darktable_resources_set(settings: State<'_, settings::Settings>, level: String) -> Result<(), String> {
    engine::set_resource_level(&settings, &level)
}

// Preferences' GPU edits: whether the engine runs with them, and whether
// its next start will
#[tauri::command]
#[specta::specta]
fn gpu_edits(state: State<'_, AppState>) -> Toggle {
    Toggle { running: state.gpu_edits.load(Ordering::Relaxed), next: engine::gpu_edits(&state.runtime) }
}

#[tauri::command]
#[specta::specta]
fn gpu_edits_set(settings: State<'_, settings::Settings>, on: bool) -> Result<(), String> {
    engine::set_gpu_edits(&settings, on)
}

// the GPU execution providers this computer can use for AI, with their
// devices, for Preferences and the Export dialog's AI upscale
#[tauri::command]
#[specta::specta]
async fn ai_accel(state: State<'_, AppState>) -> Result<Vec<AccelProvider>, String> {
    let reply = state.engine("ai_accel").request(json!({ "cmd": "ai_accel" }))?;
    serde_json::from_value::<AiAccelReply>(reply).map(|r| r.providers).map_err(|e| format!("ai_accel: unexpected reply: {e}"))
}

// the Immich side of exporting: run off the async runtime, as the client
// blocks
async fn immich_call<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&immich_upload::Immich) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let conn = tauri_plugin_immporter::immich_connection(app)
        .ok_or("Immich is not set up: add its URL and API key in Preferences")?;
    tauri::async_runtime::spawn_blocking(move || f(&immich_upload::Immich::new(&conn)?))
        .await
        .map_err(|e| e.to_string())?
}

// the albums to export to, by name
#[tauri::command]
#[specta::specta]
async fn immich_albums(app: AppHandle) -> Result<Vec<Album>, String> {
    immich_call(&app, |c| c.albums()).await
}

#[tauri::command]
#[specta::specta]
async fn immich_create_album(app: AppHandle, name: String) -> Result<Album, String> {
    immich_call(&app, move |c| c.create_album(name.trim())).await
}

// the permissions an export needs that the key lacks
#[tauri::command]
#[specta::specta]
async fn immich_export_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.missing_permissions()).await
}

// the Library panel's Immich card (immich_search.rs)
// the permissions its search, thumbnails and downloads need that the key lacks
#[tauri::command]
#[specta::specta]
async fn immich_browse_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.lacks(immich_upload::BROWSE_PERMISSIONS)).await
}

#[tauri::command]
#[specta::specta]
async fn immich_search(app: AppHandle, args: immich_search::SearchArgs, map: Option<immich_search::PathMap>)
    -> Result<SearchPage, String> {
    immich_call(&app, move |c| c.search(&args, &map.unwrap_or_default())).await
}

#[tauri::command]
#[specta::specta]
async fn immich_libraries(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.libraries()).await
}

#[tauri::command]
#[specta::specta]
async fn immich_suggestions(app: AppHandle, kind: String, within: Option<Map<String, Value>>) -> Result<Vec<String>, String> {
    immich_call(&app, move |c| c.suggestions(&kind, &within.unwrap_or_default())).await
}

#[tauri::command]
#[specta::specta]
async fn immich_people(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.people()).await
}

#[tauri::command]
#[specta::specta]
async fn immich_tags(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.tags()).await
}

// Immich's thumbnail as its encoded image (WebP or JPEG); asking again
// does not go to the server while the cache keeps it
#[tauri::command]
#[specta::specta]
async fn immich_thumb(app: AppHandle, caches: State<'_, Caches>, id: String) -> Result<bindings::Frame, String> {
    immich_search::safe_id(&id)?;
    let cache = caches.immich_thumbs.clone();
    let name = id.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || cache.read(&name)).await.map_err(|e| e.to_string())?;
    if let Some(b) = hit {
        return Ok(bindings::Frame(Response::new(b)));
    }
    let cache = caches.immich_thumbs.clone();
    immich_call(&app, move |c| {
        let bytes = c.thumb(&id)?;
        let _ = cache.write(&id, &bytes);
        Ok(bytes)
    }).await.map(|b| bindings::Frame(Response::new(b)))
}

// a file to open for an Immich asset: the external library's own file when
// this computer has it, else the original downloaded into the cache
#[tauri::command]
#[specta::specta]
async fn immich_resolve(app: AppHandle, id: String, name: String, path: String,
                        map: Option<immich_search::PathMap>) -> Result<Resolved, String> {
    if let Some(p) = immich_search::local_path(&path, &map.unwrap_or_default()) {
        return Ok(Resolved { path: p.to_string_lossy().into_owned(), downloaded: false });
    }
    let cache = app.state::<Caches>().immich_originals.clone();
    let p = immich_call(&app, move |c| {
        let (p, fresh) = c.original(&id, &name, cache.dir())?;
        if fresh { cache.added(&id) } else { cache.touch(&id) }
        Ok(p)
    }).await?;
    Ok(Resolved { path: p.to_string_lossy().into_owned(), downloaded: true })
}

// the darktable styles shipped as looks: "<pack> - <group>_<name>.dtstyle",
// then the user's own, by the name the engine shows them under
fn list_looks(state: &AppState) -> Result<Vec<LookInfo>, String> {
    let mut looks = Vec::new();
    let packs = std::fs::read_dir(&state.looks_dir).map_err(|e| format!("looks: {e}"))?;
    for pack in packs.flatten() {
        let Ok(files) = std::fs::read_dir(pack.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("dtstyle") {
                continue;
            }
            let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            let title = stem.split_once(" - ").map_or(stem, |(_, t)| t);
            let (group, name) = title.split_once('_').unwrap_or(("Looks", title));
            looks.push(LookInfo { name: name.into(), group: group.into(), path: path.to_string_lossy().into_owned(), user: None });
        }
    }
    looks.sort_by_key(|l| (l.group.clone(), l.name.clone()));
    let Ok(files) = std::fs::read_dir(&state.user_looks_dir) else { return Ok(looks) };
    for file in files.flatten() {
        let path = file.path();
        if path.extension().and_then(|e| e.to_str()) != Some("dtstyle") {
            continue;
        }
        let Some(name) = std::fs::read_to_string(&path).ok().as_deref().and_then(style_name) else { continue };
        looks.push(LookInfo { name: style_label(&name).into(), group: "My Looks".into(),
                              path: path.to_string_lossy().into_owned(), user: Some(true) });
    }
    Ok(looks)
}

// a .dtstyle's style name as the engine reads it (_style_items() in
// engine/main.c): the first <name>, with &amp; its only entity
fn style_name(text: &str) -> Option<String> {
    let a = text.find("<name>")? + "<name>".len();
    let z = a + text[a..].find("</name>")?;
    Some(text[a..z].replace("&amp;", "&"))
}

// the name's last "|" segment, which is how the engine shows it
fn style_label(name: &str) -> &str {
    name.rsplit_once('|').map_or(name, |(_, l)| l)
}

#[tauri::command]
#[specta::specta]
async fn looks_list(state: State<'_, AppState>) -> Result<Vec<LookInfo>, String> {
    list_looks(&state)
}

// a darktable style file added to the user's looks, renamed "<name> (2)"
// where a look has its name already, as a photo knows its look by name;
// returns the name it took
fn import_look(state: &AppState, path: &Path) -> Result<String, String> {
    let shown = path.display();
    let size = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?.len();
    if size > 4 << 20 {
        return Err("this file is too large to be a look".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{shown}: {e}"))?;
    let name = style_name(&text)
        .filter(|_| text.contains("<darktable_style"))
        .ok_or("this file is not a darktable style")?;
    let taken: std::collections::HashSet<String> = list_looks(state)?
        .iter().map(|l| l.name.clone()).collect();
    let label = style_label(&name).trim();
    let label = if label.is_empty() { "Imported look" } else { label };
    let mut fresh = label.to_string();
    for n in 2.. {
        if !taken.contains(&fresh) { break }
        fresh = format!("{label} ({n})");
    }
    let renamed = match name.rsplit_once('|') {
        Some((group, _)) => format!("{group}|{fresh}"),
        None => fresh.clone(),
    };
    let text = if renamed == name { text } else {
        let a = text.find("<name>").unwrap() + "<name>".len();
        let z = a + text[a..].find("</name>").unwrap();
        format!("{}{}{}", &text[..a], renamed.replace('&', "&amp;"), &text[z..])
    };

    std::fs::create_dir_all(&state.user_looks_dir).map_err(|e| format!("looks: {e}"))?;
    let stem = fresh.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let mut dest = state.user_looks_dir.join(format!("{stem}.dtstyle"));
    for n in 2.. {
        if !dest.exists() { break }
        dest = state.user_looks_dir.join(format!("{stem} ({n}).dtstyle"));
    }
    state.engine("look_import").request(json!({ "cmd": "style_forget", "name": renamed }))?;
    std::fs::write(&dest, text).map_err(|e| format!("looks: {e}"))?;
    Ok(fresh)
}

// a look's style file, copied where the save dialog asks; false when it is
// cancelled. `from` must be one of the looks
#[tauri::command]
#[specta::specta]
async fn look_export(app: AppHandle, state: State<'_, AppState>, from: String, name: String) -> Result<bool, String> {
    let from = path_inside(Path::new(&from), &[&state.looks_dir, &state.user_looks_dir])?;
    let Some(to) = pick_save(&app, "darktable style", &["dtstyle"], &format!("{name}.dtstyle")).await? else {
        return Ok(false);
    };
    std::fs::copy(&from, &to).map_err(|e| format!("{}: {e}", to.display()))?;
    Ok(true)
}

// one of the user's own looks; the shipped ones stay
#[tauri::command]
#[specta::specta]
async fn look_delete(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = path_inside(Path::new(&path), &[&state.user_looks_dir])
        .map_err(|_| "only an imported look can be deleted".to_string())?;
    std::fs::remove_file(&path).map_err(|e| format!("looks: {e}"))
}

// apply a look to the open image, or with no path take it off; returns the
// look in use
#[tauri::command]
#[specta::specta]
async fn look_apply(state: State<'_, AppState>, path: Option<String>) -> Result<Option<String>, String> {
    let path = match path {
        Some(p) => Some(path_inside(Path::new(&p), &[&state.looks_dir, &state.user_looks_dir])?),
        None => None,
    };
    let reply = state.engine("look_apply").request(json!({ "cmd": "look", "path": path }))?;
    serde_json::from_value::<LookReply>(reply).map(|r| r.look).map_err(|e| format!("look: unexpected reply: {e}"))
}

// how strongly the look applies, 0-100
#[tauri::command]
#[specta::specta]
async fn look_amount(state: State<'_, AppState>, amount: Number) -> Result<(), String> {
    state.engine("look_amount").request(json!({ "cmd": "look_amount", "amount": amount })).map(|_| ())
}

// the installed font families and their faces, as the engine draws them
#[tauri::command]
#[specta::specta]
async fn fonts(state: State<'_, AppState>) -> Result<Vec<FontFamily>, String> {
    let reply = state.engine("fonts").request(json!({ "cmd": "fonts" }))?;
    serde_json::from_value::<FontsReply>(reply).map(|r| r.families).map_err(|e| format!("fonts: unexpected reply: {e}"))
}

// the Print panel (engine/print.c): printer profiles, soft proofing,
// printers and the print itself
fn without_ok(mut reply: Value) -> Value {
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
    }
    reply
}

#[tauri::command]
#[specta::specta]
async fn print_profiles(state: State<'_, AppState>) -> Result<Vec<PrintProfile>, String> {
    let reply = state.engine("print_profiles").request(json!({ "cmd": "print_profiles" }))?;
    serde_json::from_value::<PrintProfilesReply>(reply).map(|r| r.profiles)
        .map_err(|e| format!("print_profiles: unexpected reply: {e}"))
}

// a printer profile the user picks in the dialog opened here, copied among
// the engine's own; null when it is cancelled
#[tauri::command]
#[specta::specta]
async fn print_profile_add(app: AppHandle, state: State<'_, AppState>) -> Result<Option<PrintProfile>, String> {
    let picked = pick_files(&app, "ICC profile", &["icc", "icm", "ICC", "ICM"], false).await?;
    let Some(path) = picked.first() else { return Ok(None) };
    let reply = state.engine("print_profile_add").request(json!({ "cmd": "print_profile_add", "path": path }))?;
    serde_json::from_value(reply).map(Some).map_err(|e| format!("print_profile_add: unexpected reply: {e}"))
}

// `mode` "off", "proof" or "gamut"; replies whether the view changed, and
// the front end renders again if so
#[tauri::command]
#[specta::specta]
async fn softproof(state: State<'_, AppState>, mode: String, profile: Option<String>, intent: Option<i64>)
    -> Result<bool, String> {
    let reply = state.engine("softproof").request(json!({
        "cmd": "softproof", "mode": mode, "profile": profile.unwrap_or_default(), "intent": intent.unwrap_or(0),
    }))?;
    Ok(reply["changed"].as_bool().unwrap_or(false))
}

// { available, printers: [{ name, description, default }] }
#[tauri::command]
#[specta::specta]
async fn printers(state: State<'_, AppState>) -> Result<PrintersReply, String> {
    let reply = state.engine("printers").request(json!({ "cmd": "printers" }))?;
    serde_json::from_value(reply).map_err(|e| format!("printers: unexpected reply: {e}"))
}

#[tauri::command]
#[specta::specta]
async fn printer_info(state: State<'_, AppState>, name: String) -> Result<PrinterInfoReply, String> {
    let reply = state.engine("printer_info").request(json!({ "cmd": "printer", "name": name }))?;
    serde_json::from_value(reply).map_err(|e| format!("printer: unexpected reply: {e}"))
}

// `request` without any `pdf` the page sent: the engine writes a PDF to that
// path, so only the one Rust gets from its own save dialog may reach it
fn without_pdf(mut request: Value) -> Value {
    if let Some(o) = request.as_object_mut() {
        o.remove("pdf");
    }
    request
}

// the save dialog for a print's PDF, named `pdf_name` as the page suggests;
// None when there is no PDF to write, Some(None) when the user cancelled
async fn pick_pdf(app: &AppHandle, pdf_name: Option<&str>) -> Result<Option<Option<PathBuf>>, String> {
    match pdf_name {
        Some(name) => Ok(Some(pick_save(app, "PDF", &["pdf"], name).await?)),
        None => Ok(None),
    }
}

// the reply with the path of the PDF written, for the page to show
fn with_pdf(mut reply: Value, pdf: Option<&Path>) -> Value {
    if let (Some(p), Some(o)) = (pdf, reply.as_object_mut()) {
        o.insert("pdf".into(), json!(p.to_string_lossy()));
    }
    reply
}

// the engine's print reply with the PDF's path, as the page gets it
fn print_reply(result: Result<Value, String>, pdf: Option<&Path>) -> Result<Option<PrintReply>, String> {
    let reply = with_pdf(without_ok(result?), pdf);
    serde_json::from_value(reply).map(Some).map_err(|e| format!("print: unexpected reply: {e}"))
}

// renders the photo as its edit is now and prints it, or, given `pdf_name`,
// writes a PDF where the user picks (null when they cancel), on the export
// thread as an export does (export_images), so editing goes on
#[tauri::command]
#[specta::specta]
async fn print_photo(app: AppHandle, state: State<'_, AppState>, imgid: i64, request: Map<String, Value>,
                     pdf_name: Option<String>) -> Result<Option<PrintReply>, String> {
    let mut req = without_pdf(Value::Object(request));
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(None),
        Some(Some(p)) => {
            req["pdf"] = json!(p.to_string_lossy());
            Some(p)
        }
        None => None,
    };
    let tagged = state.tagged.clone();
    let held = tagged.tag();
    state.engine("print_photo").request(json!({ "cmd": "export_hold", "job": held, "imgids": [imgid] }))?;
    req["cmd"] = json!("print");
    req["job"] = json!(held);
    req["imgid"] = json!(imgid);
    let t = tagged.clone();
    let tag = t.tag();
    let result = tauri::async_runtime::spawn_blocking(move || t.request(tag, req))
        .await.map_err(|e| e.to_string()).and_then(|r| r);
    let t = tagged.clone();
    let tag = t.tag();
    let _ = tauri::async_runtime::spawn_blocking(move || t.request(tag, json!({ "cmd": "export_release", "job": held })))
        .await;
    print_reply(result, pdf.as_deref())
}

// a sheet of photos, each as its edit is now (print_photo's way): the Cells
// layout's pages of boxes and labels are in `request`, `imgids` the photos
// they hold, which the engine takes a snapshot of as each page reaches it.
// `pdf_name` is print_photo's: the PDF goes where the user picks, null when
// they cancel
#[tauri::command]
#[specta::specta]
async fn print_sheet(app: AppHandle, state: State<'_, AppState>, job: u64, imgids: Vec<i64>, request: Map<String, Value>,
                     pdf_name: Option<String>) -> Result<Option<PrintReply>, String> {
    let mut req = without_pdf(Value::Object(request));
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(None),
        Some(Some(p)) => {
            req["pdf"] = json!(p.to_string_lossy());
            Some(p)
        }
        None => None,
    };
    let tagged = state.tagged.clone();
    state.engine("print_sheet").request(json!({ "cmd": "export_hold", "job": job, "imgids": imgids }))?;
    req["cmd"] = json!("print");
    let t = tagged.clone();
    // each photo placed reaches the page as a merge's progress, and Stop as a merge's
    let result = tauri::async_runtime::spawn_blocking(move || merge(app, t, job, req))
        .await.map_err(|e| e.to_string()).and_then(|r| r);
    let t = tagged.clone();
    let tag = t.tag();
    let _ = tauri::async_runtime::spawn_blocking(move || t.request(tag, json!({ "cmd": "export_release", "job": job })))
        .await;
    print_reply(result, pdf.as_deref())
}

// the AgX presets in darktable's own `data.db` in the config folder,
// converted by the engine to the current version: { presets: [{ name, params }] }
#[tauri::command]
#[specta::specta]
async fn agx_presets(state: State<'_, AppState>, fields: Vec<String>) -> Result<AgxPresetsReply, String> {
    let reply = state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "fields": fields }))?;
    serde_json::from_value(reply).map_err(|e| format!("agx_presets: unexpected reply: {e}"))
}

// the same from a `.dtpreset` or `.dtstyle` the user picks in the dialog
// opened here; null when it is cancelled
#[tauri::command]
#[specta::specta]
async fn agx_presets_pick(app: AppHandle, state: State<'_, AppState>, fields: Vec<String>)
    -> Result<Option<AgxPresetsReply>, String> {
    let picked = pick_files(&app, "darktable preset or style", &["dtpreset", "dtstyle"], false).await?;
    let Some(file) = picked.first() else { return Ok(None) };
    let reply = state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "file": file, "fields": fields }))?;
    serde_json::from_value(reply).map(Some).map_err(|e| format!("agx_presets: unexpected reply: {e}"))
}

// the AgX presets the user loaded into the Profile menu, a document the
// front end shapes; none yet is an empty list
#[tauri::command]
#[specta::specta]
async fn agx_profiles_load(state: State<'_, AppState>) -> Result<Vec<AgxProfile>, String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("AgX presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("AgX presets: {e}")),
    }
}

#[tauri::command]
#[specta::specta]
async fn agx_profiles_save(state: State<'_, AppState>, profiles: Vec<AgxProfile>) -> Result<(), String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("AgX presets: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("AgX presets: {e}"))
}

// the commit this app was built from and whether the tree had uncommitted
// changes (build.rs); both are absent when it was built outside Git
const BUILD_COMMIT: Option<&str> = option_env!("IMMAGE_BUILD_COMMIT");
fn build_dirty() -> Option<bool> {
    option_env!("IMMAGE_BUILD_DIRTY").map(|s| s == "true")
}

// the commit as shown to people: ten digits, as darktable's version gives
// its own, and "-dirty" for a tree with changes
fn build_label() -> Option<String> {
    BUILD_COMMIT.map(|c| format!("{}{}", &c[..c.len().min(10)], if build_dirty() == Some(true) { "-dirty" } else { "" }))
}

// Immage's version and commit, for the splash: answered at once, without
// waiting for the engine as `about` does
#[tauri::command]
#[specta::specta]
fn build(app: AppHandle) -> bindings::BuildInfo {
    bindings::BuildInfo { app: app.package_info().version.to_string(), commit: build_label() }
}

// Immage's version and commit and the darktable its engine was built
// from, for Preferences and the GPU check's report
#[tauri::command]
#[specta::specta]
async fn about(app: AppHandle, state: State<'_, AppState>) -> Result<bindings::AboutInfo, String> {
    let reply = state.engine("about").request(json!({ "cmd": "version" }))?;
    Ok(bindings::AboutInfo {
        app: app.package_info().version.to_string(),
        commit: build_label(),
        darktable: reply["version"].as_str().unwrap_or_default().to_string(),
    })
}

// the license texts the GPL requires to travel with the app, for
// Preferences' About: the GPL itself, the index of the bundled
// libraries' licenses with the folder holding their texts
// (scripts/bundle_engine.py), and the notices of the crates and packages
// compiled into the app (scripts/notices.mjs). each is null when missing,
// as in a development build that has not bundled the engine
#[tauri::command]
#[specta::specta]
fn licenses(app: AppHandle) -> Result<Licenses, String> {
    let (gpl, libs, notices) = if cfg!(debug_assertions) {
        let res = repo_root().join("app/src-tauri/resources");
        (repo_root().join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    } else {
        let res = app.path().resource_dir().map_err(|e| e.to_string())?;
        (res.join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    };
    let index = libs.join("INDEX.txt");
    Ok(Licenses {
        gpl: std::fs::read_to_string(&gpl).ok(),
        libraries: std::fs::read_to_string(&index).ok(),
        libraries_path: index.exists().then(|| index.to_string_lossy().into_owned()),
        notices: std::fs::read_to_string(&notices).ok(),
    })
}

// before an update is installed: the installer replaces the engine's files,
// which Windows will not do while they are in use
#[tauri::command]
#[specta::specta]
async fn engine_quit(state: State<'_, AppState>) -> Result<(), String> {
    state.engine("engine_quit").quit();
    Ok(())
}

// the user's restart of an engine that is not answering: kills it without
// the engine lock, which its request holds. the request fails with the exit
// error and the supervisor starts another (engine-state down, then ready)
#[tauri::command]
#[specta::specta]
fn engine_restart(state: State<'_, AppState>) {
    state.engine_link.restart();
}

// keeps the engine running: when it exits, tells the page, starts another
// and tells the page again. three restarts within a minute are a crash
// loop, and it gives up (state "failed"); a restart asked for does not count
fn supervise(app: AppHandle) {
    let state = app.state::<AppState>();
    let link = state.engine_link.clone();
    let mut budget = engine::RestartBudget::new(3, Duration::from_secs(60));
    while let Some(epoch) = link.wait_dead() {
        let manual = link.take_manual();
        link.emit(json!({ "state": "down", "epoch": epoch }));
        // exports in flight have lost their engine
        state.export_cancels.lock().unwrap().clear();
        if !manual && !budget.allow(Instant::now()) {
            link.emit(json!({ "state": "failed" }));
            return;
        }
        // the failed request has released the lock by now
        let mut engine = state.engine("engine_respawn");
        if link.quitting() {
            return;
        }
        match engine.respawn() {
            Ok(()) => {
                *state.resource_level.lock().unwrap() = engine::resource_level(&state.runtime);
                state.gpu_edits.store(engine::gpu_edits(&state.runtime), Ordering::Relaxed);
                link.emit(json!({ "state": "ready", "epoch": engine.epoch() }));
            }
            Err(e) => {
                eprintln!("engine respawn failed: {e}");
                link.emit(json!({ "state": "failed" }));
                return;
            }
        }
    }
}

// the menu spec lives in app/src/menu.ts so the drawn Windows/Linux menu and
// this native one list the same items; Windows and Linux draw it in the title
// bar strip, as a native row there would take extra height
#[derive(Deserialize, specta::Type)]
struct NativeMenu {
    label: String,
    items: Vec<NativeItem>,
}

#[derive(Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
enum NativeItem {
    Item { id: String, label: String, #[serde(default)] accel: Option<String> },
    Separator,
    Submenu { label: String, items: Vec<NativeItem> },
    Predefined { role: NativeRole },
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
enum NativeRole {
    About, Services, Hide, HideOthers, ShowAll, Quit, CloseWindow,
    Cut, Copy, Paste, Minimize, Zoom, Fullscreen,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn native_items(app: &AppHandle, items: &[NativeItem]) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::{MenuItemBuilder, PredefinedMenuItem as P, Submenu};
    let mut out: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for it in items {
        out.push(match it {
            NativeItem::Item { id, label, accel } => {
                let mut b = MenuItemBuilder::with_id(id.as_str(), label);
                if let Some(a) = accel { b = b.accelerator(a); }
                Box::new(b.build(app)?)
            }
            NativeItem::Separator => Box::new(P::separator(app)?),
            NativeItem::Submenu { label, items } => {
                let kids = native_items(app, items)?;
                let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = kids.iter().map(|k| k.as_ref()).collect();
                Box::new(Submenu::with_items(app, label, true, &refs)?)
            }
            NativeItem::Predefined { role } => match role {
                NativeRole::About => Box::new(P::about(app, None, None)?),
                NativeRole::Services => Box::new(P::services(app, None)?),
                NativeRole::Hide => Box::new(P::hide(app, None)?),
                NativeRole::HideOthers => Box::new(P::hide_others(app, None)?),
                NativeRole::ShowAll => Box::new(P::show_all(app, None)?),
                NativeRole::Quit => Box::new(P::quit(app, None)?),
                NativeRole::CloseWindow => Box::new(P::close_window(app, None)?),
                NativeRole::Cut => Box::new(P::cut(app, None)?),
                NativeRole::Copy => Box::new(P::copy(app, None)?),
                NativeRole::Paste => Box::new(P::paste(app, None)?),
                NativeRole::Minimize => Box::new(P::minimize(app, None)?),
                NativeRole::Zoom => Box::new(P::maximize(app, None)?),
                NativeRole::Fullscreen => Box::new(P::fullscreen(app, None)?),
            },
        });
    }
    Ok(out)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(app: &AppHandle, menus: &[NativeMenu]) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, Submenu};
    let mut tops = Vec::new();
    for m in menus {
        let kids = native_items(app, &m.items)?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = kids.iter().map(|k| k.as_ref()).collect();
        tops.push(Submenu::with_items(app, &m.label, true, &refs)?);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = tops.iter().map(|t| t as _).collect();
    Menu::with_items(app, &refs)
}

// async so it runs off the main thread: the menu API hops to it and waits
#[tauri::command]
#[specta::specta]
async fn menu_set(app: AppHandle, menus: Vec<NativeMenu>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_menu(&app, &menus).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, menus);
    Ok(())
}

// workers for Tauri's async runtime. most commands are async and wait for
// the engine on the std mutex inside AppState::engine, which parks the
// worker running them: with only one worker per core, as Tauri's default
// runtime has, a slow request (a save, a large open) with a few commands
// queued behind it would park every worker, and commands that never touch
// the engine (folder listings, thumbnails from the cache, Immich) would wait
// too. the margin covers the engine commands the page has in flight at once.
// the runtime lives until the process exits, as Tauri's own default does
// (a static it never drops), so shutdown is unchanged
const ENGINE_WAITERS: usize = 8;

fn async_workers(cores: usize) -> usize {
    cores.max(1) + ENGINE_WAITERS
}

fn main() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    // before GTK and WebKit start, and before any other thread
    #[cfg(target_os = "linux")]
    renderer::init(&context.config().identifier).expect("cannot select the webview renderer");
    // Linux: setup builds the windows, with the web extension that hands
    // frames over (webext_dir); it has to be in place before their web
    // process starts
    #[cfg(target_os = "linux")]
    for w in &mut context.config_mut().app.windows {
        w.create = false;
    }
    // after renderer::init, which needs to run before any other thread
    let runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(async_workers(std::thread::available_parallelism().map_or(4, |n| n.get())))
            .enable_all()
            .build()
            .expect("cannot start the async runtime"),
    ));
    tauri::async_runtime::set(runtime.handle().clone());
    // the first argument naming a file or folder; macOS adds -psn_... to apps it starts
    let arg = std::env::args_os().skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .find_map(|a| launch_path(Path::new(&a)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin({
            let updater = tauri_plugin_updater::Builder::new();
            // NSIS /D must be last and unquoted, including paths with spaces.
            // Pin updates to the running installation when both scopes exist.
            #[cfg(target_os = "windows")]
            let updater = match std::env::current_exe() {
                Ok(exe) => match exe.parent() {
                    Some(dir) => updater.installer_arg(format!("/D={}", dir.display())),
                    None => updater,
                },
                Err(_) => updater,
            };
            updater.build()
        })
        .plugin(tauri_plugin_process::init())
        // the main window opens as it was last closed. not its visibility, which
        // the splash sets (Splash.tsx), nor full screen, which only Full Screen
        // Preview enters
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .with_denylist(&["splash"])
            .build())
        // its own catalog, thumbnails and Immich key, apart from the standalone importer's
        .plugin(tauri_plugin_immporter::init(tauri_plugin_immporter::Config {
            data_subdir: Some("immporter".into()),
            keychain_from: None,
        }))
        .manage(Launch(Mutex::new(arg)))
        // custom items reach the page by id; predefined ones act natively
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref());
        })
        .setup(|app| {
            memory_budget::watch(app.handle().clone());
            #[cfg(target_os = "linux")]
            {
                let dir = webext_dir(app.handle());
                for config in app.config().app.windows.clone() {
                    let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
                    if let Some(dir) = &dir {
                        window = window.extensions_path(dir);
                    }
                    window.build()?;
                }
                shm_frame::sweep();
            }
            // a dev build runs the engine from the checkout's build/ tree; a
            // bundled app carries its own (scripts/bundle_engine.py) and keeps
            // the engine's config and cache in its data folder
            let engine_exe = format!("darktable-engine{}", std::env::consts::EXE_SUFFIX);
            // GUI benchmark reports go with the checkout's benchmarks in a dev build
            let (default_bin, runtime, looks_dir, models_dir, perf_dir) = if cfg!(debug_assertions) {
                let root = repo_root();
                (root.join("build/bin").join(&engine_exe), root.join("build/app-runtime"),
                 root.join("app/looks"), root.join("build/ai-models"), root.join("benchmarking/results/gui"))
            } else {
                let res = app.path().resource_dir()?;
                let data = app.path().app_data_dir()?;
                (res.join("darktable/bin").join(&engine_exe), data.clone(), res.join("looks"), data.join("models"),
                 data.join("benchmarks"))
            };
            let bin = std::env::var_os("DT_ENGINE_BIN").map(PathBuf::from).unwrap_or(default_bin);
            // one-time move of the old loose files; the engine flags below
            // then read settings.json
            let settings = settings::Settings::load(&runtime);
            if let Err(e) = settings.migrate() {
                eprintln!("settings: cannot move the old preference files: {e}");
            }
            app.manage(settings);
            let resource_level = engine::resource_level(&runtime);
            let gpu_edits = engine::gpu_edits(&runtime);
            let engine = Engine::spawn(&bin, &runtime, &models_dir)
                .map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
            let frame_output = Arc::new(frame_output::FrameOutput::new(&runtime));
            let engine_link = engine.link();
            let events = app.handle().clone();
            engine_link.set_events(move |event| { let _ = events.emit("engine-state", event); });
            app.manage(AppState {
                base_cancel: engine.base_cancel(),
                tagged: engine.tagged(),
                export_cancels: Mutex::new(HashMap::new()),
                engine: perf_trace::TracedMutex::new(engine),
                frame_path: frame_output.path("frame.rgba"),
                denoise_path: frame_output.path("denoise-preview.f32"),
                presets_path: runtime.join("presets.json"),
                preview_path: frame_output.path("preview.rgba"),
                range_path: frame_output.path("range.bin"),
                looks_dir,
                user_looks_dir: runtime.join("looks"),
                models_dir,
                folder_token: AtomicU64::new(0),
                perf_on: AtomicBool::new(false),
                perf_last: Mutex::new(Vec::new()),
                perf_by_request: Mutex::new(HashMap::new()),
                perf_modules_dropped: AtomicU64::new(0),
                perf_dir,
                runtime: runtime.clone(),
                resource_level: Mutex::new(resource_level),
                gpu_edits: AtomicBool::new(gpu_edits),
                engine_link,
                _frame_output: frame_output,
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || supervise(handle));
            app.manage(plugins::Plugins::new(runtime.join("plugin-returns.json")));
            // stacks saved in Macro Studio while Immage was closed
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<plugins::Plugins>().drain_jobs());
            app.manage(support_bundle::BundleState::default());
            app.manage(Caches::new(&app.path().app_cache_dir()?));
            Ok(())
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("error while running Immage");
    app.run(|_app, _event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(p) = urls.iter().filter_map(|u| u.to_file_path().ok()).find_map(|p| launch_path(&p)) {
                *_app.state::<Launch>().0.lock().unwrap() = Some(p);
                let _ = _app.emit("launch-file", ());
            }
        }
    });
}

// Full Screen Preview's window: macOS's simple full screen, which stays in
// the window's own Space. tao hands the keyboard to its own view at each
// change of the window's style (util::toggle_style_mask()), and that view
// beeps at every key it then passes on to the page; leaving makes the last
// change asynchronously, on the main queue (util::set_style_mask_async()).
// so the switch is made on the main thread, where it runs at once, and the
// web view takes the keyboard back in a block queued after tao's
#[tauri::command]
#[specta::specta]
fn preview_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(webview) = handle.get_webview_window("main") else { return };
        let _ = webview.set_simple_fullscreen(on);
        let refocus = move || {
            let _ = webview.set_focus();
            let _ = AsRef::<tauri::Webview>::as_ref(&webview).set_focus();
        };
        #[cfg(target_os = "macos")]
        dispatch2::DispatchQueue::main().exec_async(refocus);
        #[cfg(not(target_os = "macos"))]
        refocus();
    }).map_err(|e| e.to_string())
}

// the first-use download, as the installed app does it, into a folder of
// its own: about 500 MB from GitHub and Hugging Face, so only on request
// (cargo test -- --ignored models_download)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn async_workers_leave_room_beside_engine_waiters() {
        assert_eq!(async_workers(0), 1 + ENGINE_WAITERS);
        assert_eq!(async_workers(4), 4 + ENGINE_WAITERS);
    }

    #[test]
    fn native_menu_spec_parses() {
        let spec = json!([{"label": "Immage", "items": [
            {"type": "predefined", "role": "hideOthers"},
            {"type": "separator"},
            {"type": "item", "id": "export", "label": "Export", "accel": "CmdOrCtrl+E"},
            {"type": "item", "id": "undo", "label": "Undo"},
            {"type": "submenu", "label": "More", "items": [{"type": "predefined", "role": "zoom"}]}
        ]}]);
        let m: Vec<NativeMenu> = serde_json::from_value(spec).unwrap();
        assert_eq!(m[0].items.len(), 5);
        assert!(matches!(&m[0].items[2], NativeItem::Item { id, accel: Some(_), .. } if id == "export"));
        assert!(matches!(&m[0].items[3], NativeItem::Item { accel: None, .. }));
        assert!(matches!(&m[0].items[0], NativeItem::Predefined { role: NativeRole::HideOthers }));
    }

    #[test]
    fn machine_id_is_stable() {
        let id = machine_id().expect("no machine id");
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(machine_id().as_deref(), Some(id.as_str()));
        println!("machine id {id}");
    }

    #[test]
    fn report_machine_id_without_a_system_id_is_kept() {
        if machine_id().is_some() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("immage-mid-{}", std::process::id()));
        let first = report_machine_id(Some(&dir)).expect("no id");
        assert_eq!(first.len(), 12);
        assert_eq!(report_machine_id(Some(&dir)), Some(first));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_release_for_a_version() {
        let index = json!({ "5.6.0": "v5.6", "5.7.0": "nightly-5.7.0", "5.10.0": "v5.10" });
        assert_eq!(model_release(&index, "5.7.0").unwrap(), "nightly-5.7.0");
        // no darktable version (a checkout without release tags): the newest,
        // numerically, so 5.10 above 5.7
        assert_eq!(model_release(&index, "immage").unwrap(), "v5.10");
        assert!(model_release(&index, "5.8.0").is_err());
    }

    #[test]
    fn sha256_of_a_file() {
        let path = std::env::temp_dir().join(format!("immage-sha-{}", std::process::id()));
        std::fs::write(&path, "abc").unwrap();
        let got = sha256_file(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(got, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn pinned_model_lookup() {
        let pins = [ModelRelease { darktable: "5.7.0", tag: "t1", models: &[
            ModelPin { id: "m", sha256: "ab", size: 3 }] }];
        let got = pinned_model(&pins, "5.7.0", "m").unwrap().unwrap();
        assert_eq!((got.tag.as_str(), got.sha256.as_str(), got.size, got.pinned), ("t1", "ab", 3, true));
        assert!(pinned_model(&pins, "5.7.0", "other").unwrap().is_err());
        for v in ["5.8.0", "immage", ""] {
            assert!(pinned_model(&pins, v, "m").is_none(), "{v:?}");
        }
    }

    #[test]
    fn model_releases_hold_the_apps_models() {
        for id in ["mask-object-sam21-small", "rawdenoise-nind", "upscale-realplksr"] {
            for r in MODEL_RELEASES {
                assert!(r.models.iter().any(|m| m.id == id), "{id} missing from {}", r.tag);
            }
        }
        for r in MODEL_RELEASES {
            for m in r.models {
                assert!(m.sha256.len() == 64 && m.sha256.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')),
                        "{}: bad sha256", m.id);
            }
        }
    }

    fn model_site<'a>(url: &'a str, pins: &'a [ModelRelease]) -> ModelSite<'a> {
        ModelSite { index: url, releases: url, pins }
    }

    fn sha_of(bytes: &[u8], dir: &Path) -> String {
        let p = dir.join("x.bin");
        std::fs::write(&p, bytes).unwrap();
        sha256_file(&p).unwrap()
    }

    #[test]
    fn pinned_model_refuses_changed_archive() {
        let dir = scratch("pin-changed");
        let sha = sha_of(b"xxx", &dir);
        // the pins hold 'static data, so the test's are leaked
        let models: &'static [ModelPin] = Box::leak(Box::new([
            ModelPin { id: "m", sha256: Box::leak(sha.into_boxed_str()), size: 3 }]));
        let pins = [ModelRelease { darktable: "5.7.0", tag: "t1", models }];
        let mut server = mockito::Server::new();
        let _archive = server.mock("GET", "/t1/m.dtmodel").with_body("yyy").create();
        let index = server.mock("GET", "/releases-index.json").expect(0).create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { panic!("unpacked a refused archive") };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        let left = dir.join("_dl/m.dtmodel").exists() || dir.join("_dl/m.dtmodel.part").exists();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("'m'") && err.contains("update of Immage"), "{err}");
        assert!(!left);
        index.assert();
    }

    #[test]
    fn fetch_stops_past_the_limit() {
        let dir = scratch("fetch-limit");
        let mut server = mockito::Server::new();
        let big = server.mock("GET", "/big").with_body("0123456789").expect(1).create();
        let dest = dir.join("big.bin");
        let err = fetch(&format!("{}/big", server.url()), &dest, Some(3)).unwrap_err();
        let left = dest.exists();
        let _small = server.mock("GET", "/small").with_body("abc").create();
        let ok = dir.join("small.bin");
        let got = fetch(&format!("{}/small", server.url()), &ok, Some(3));
        let kept = std::fs::read(&ok).ok();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("/big") && err.contains("larger than expected"), "{err}");
        assert!(!left);
        big.assert();
        got.unwrap();
        assert_eq!(kept.as_deref(), Some(&b"abc"[..]));
    }

    #[test]
    fn extra_models_are_pinned_to_a_commit() {
        for m in EXTRA_MODELS {
            let rest = m.url.split("/resolve/").nth(1).unwrap_or_else(|| panic!("{}: no /resolve/", m.id));
            let commit = rest.split('/').next().unwrap();
            assert!(commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit()), "{}: {}", m.id, m.url);
            assert!(m.size > 0, "{}", m.id);
        }
    }

    #[test]
    fn unpinned_model_uses_published_checksum() {
        let dir = scratch("pin-published");
        let sha = sha_of(b"xxx", &dir);
        let pins = [ModelRelease { darktable: "5.7.0", tag: "t1", models: &[] }];
        let mut server = mockito::Server::new();
        let _index = server.mock("GET", "/releases-index.json")
            .with_body(r#"{"compatible_releases":{"5.8.0":"t2"}}"#).create();
        let _versions = server.mock("GET", "/t2/versions.json")
            .with_body(format!(r#"{{"models":{{"m":{{"sha256":"sha256:{sha}","size":3}}}}}}"#)).create();
        let _archive = server.mock("GET", "/t2/m.dtmodel").with_body("xxx").create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let calls = std::cell::Cell::new(0);
        let unpack = |_: &Path, into: &Path| -> Result<(), String> {
            calls.set(calls.get() + 1);
            std::fs::create_dir_all(into.join("m")).map_err(|e| e.to_string())?;
            std::fs::write(into.join("m/config.json"), "{}").map_err(|e| e.to_string())
        };
        let got = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.8.0+1");
        let _ = std::fs::remove_dir_all(&dir);
        got.unwrap();
        assert_eq!(calls.get(), 1);
    }

    #[test]
    #[ignore]
    fn models_download() {
        let dir = std::env::temp_dir().join(format!("immage-models-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = |v: Value| eprintln!("{v}");
        // the dev build's engine unpacks, as the app's does
        let runtime = std::env::temp_dir().join(format!("immage-models-engine-{}", std::process::id()));
        std::fs::create_dir_all(&runtime).unwrap();
        let engine = std::sync::Mutex::new(Engine::spawn(
            &repo_root().join("build/bin/darktable-engine"), &runtime, &dir).expect("the dev build's engine"));
        let unpack = |archive: &Path, into: &Path| {
            engine.lock().unwrap().request(json!({ "cmd": "unpack", "archive": archive, "dir": into })).map(|_| ())
        };
        install_model(&log, &unpack, &DARKTABLE_AI, &dir, "mask-object-sam21-small", "5.7.0+1~gtest").expect("darktable's model");
        install_model(&log, &unpack, &DARKTABLE_AI, &dir, "rawdenoise-nind", "5.7.0+1~gtest").expect("darktable's raw denoise model");
        for m in EXTRA_MODELS {
            install_extra(&log, &dir, m).expect(m.id);
        }
        for id in ["mask-object-sam21-small", "rawdenoise-nind", "mask-subject-birefnet-lite",
                   "mask-scene-segformer-b2", "mask-depth-da2-small"] {
            assert!(dir.join(id).join("config.json").exists(), "{id} has no config.json");
        }
        // a 404 is not tried again, and leaves no file
        let missing = dir.join("missing");
        let start = Instant::now();
        assert!(fetch(&format!("{}/none/none.dtmodel", DARKTABLE_AI.releases), &missing, None).is_err());
        assert!(start.elapsed() < Duration::from_secs(10) && !missing.exists());
        drop(engine);
        let _ = std::fs::remove_dir_all(&runtime);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("immage-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_print_request_loses_the_pages_pdf_path() {
        let req = without_pdf(json!({ "pdf": "/home/u/.bashrc", "dpi": 300 }));
        assert_eq!(req, json!({ "dpi": 300 }));
        let reply = with_pdf(json!({}), Some(Path::new("/tmp/a.pdf")));
        assert_eq!(reply["pdf"], "/tmp/a.pdf");
        assert_eq!(with_pdf(json!({}), None), json!({}));
    }
}
