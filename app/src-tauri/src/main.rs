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

use cache::Caches;
use engine::{BaseCancel, Engine, Tagged, Timing};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

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

// commands are async so a render runs off the main thread

#[tauri::command]
async fn open_image(state: State<'_, AppState>, path: String, imgid: Option<i64>) -> Result<Value, String> {
    state.engine("open_image").request(json!({ "cmd": "open", "path": path, "imgid": imgid.unwrap_or(-1) }))
}

// the open image's darktable history, oldest first; `saved`, as the last
// save stored it, compressed
#[tauri::command]
async fn history(state: State<'_, AppState>, saved: Option<bool>) -> Result<Value, String> {
    let reply = state.engine("history").request(json!({ "cmd": "history", "saved": saved.unwrap_or(false) }))?;
    Ok(reply["items"].clone())
}

// the History panel's switch and delete for one instance in the history:
// `enabled` switches it, `reset` puts it back to darktable's defaults,
// `restore` to a state an earlier reply gave. replies the state before and
// after, `was` and `now`
#[tauri::command]
async fn module_state(
    state: State<'_, AppState>,
    op: String,
    priority: i64,
    enabled: Option<bool>,
    reset: Option<bool>,
    restore: Option<Value>,
) -> Result<Value, String> {
    let mut req = json!({ "cmd": "module_state", "op": op, "priority": priority, "reset": reset.unwrap_or(false) });
    if let Some(e) = enabled {
        req["enabled"] = json!(e);
    }
    if let Some(r) = restore {
        req["restore"] = r;
    }
    state.engine("module_state").request(req)
}

#[tauri::command]
async fn get_params(state: State<'_, AppState>, modules: Value) -> Result<Value, String> {
    state.engine("get_params").request(json!({ "cmd": "get", "modules": modules }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn set_params(
    state: State<'_, AppState>,
    op: String,
    params: Map<String, Value>,
    enabled: bool,
    after: Option<String>,
    before: Option<String>,
    instance: Option<String>,
    mask: Option<String>,
    invert: Option<bool>,
    opacity: Option<f64>,
    refine: Option<Value>,
) -> Result<(), String> {
    let mut req = json!({ "cmd": "set", "op": op, "params": params, "enabled": enabled });
    if let Some(a) = after {
        req["after"] = json!(a);
    }
    if let Some(b) = before {
        req["before"] = json!(b);
    }
    // a mask's adjustments go to its own instance of the module
    if let Some(i) = instance {
        req["instance"] = json!(i);
    }
    if let Some(m) = mask {
        req["mask"] = json!(m);
        req["invert"] = json!(invert.unwrap_or(false));
        if let Some(o) = opacity {
            req["opacity"] = json!(o);
        }
        if let Some(r) = refine {
            req["refine"] = r;
        }
    }
    state.engine("set_params").request(req).map(|_| ())
}

// replace a mask's shapes (made when missing)
#[tauri::command]
async fn mask_shapes(state: State<'_, AppState>, name: String, shapes: Value) -> Result<(), String> {
    state.engine("mask_shapes")
        .request(json!({ "cmd": "mask", "name": name, "shapes": shapes })).map(|_| ())
}

// replace a combined mask's members ([{ mask, opacity 0-1, invert }]) and
// the range components its instances take, which drives masks' shared
// instances (app/src/localMerge.ts)
#[tauri::command]
async fn combine(state: State<'_, AppState>, name: String, members: Value, ranges: Option<Value>) -> Result<(), String> {
    state.engine("combine")
        .request(json!({ "cmd": "combine", "name": name, "members": members, "ranges": ranges })).map(|_| ())
}

// the open image's masks, with these fields ({ op: [field] }) of their
// instances
#[tauri::command]
async fn masks(state: State<'_, AppState>, fields: Value) -> Result<Value, String> {
    let reply = state.engine("masks").request(json!({ "cmd": "masks", "fields": fields }))?;
    Ok(reply["masks"].clone())
}

// the working-space values at a point of the shown image, or over a box of
// it [x0, y0, x1, y1], for range masks; with `stage` "negadoctor", at
// negadoctor's input, for the Negative panel's pickers
#[tauri::command]
async fn sample(state: State<'_, AppState>, x: f64, y: f64, area: Option<Vec<f64>>, stage: Option<String>) -> Result<Value, String> {
    state.engine("sample").request(json!({ "cmd": "sample", "x": x, "y": y, "box": area, "stage": stage }))
}

// the mean log2 luminance the tone mapper gets, for Auto's exposure
#[tauri::command]
async fn tone_key(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("tone_key").request(json!({ "cmd": "tone_key" }))
}

// the Lensfun lenses Lens Corrections can use for the open photo, and the
// one matched from its EXIF (the engine's _lens_menu)
#[tauri::command]
async fn lenses(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("lenses").request(json!({ "cmd": "lenses" }))
}

// Input and working profiles supported by the pinned darktable engine.
#[tauri::command]
async fn color_profiles(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("color_profiles").request(json!({ "cmd": "color_profiles" }))
}

// black and white relative exposure for AgX, as darktable's "auto tune
// levels" picker finds them over the photo
#[tauri::command]
async fn agx_auto(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("agx_auto").request(json!({ "cmd": "agx_auto" }))
}

// Upright's fit of rotate and perspective: { rotation, lensshift_v,
// lensshift_h, fit }. Guided passes its drawn lines (x1, y1, x2, y2 in the
// input image, 0-1)
#[tauri::command]
async fn upright(state: State<'_, AppState>, mode: String, guides: Option<Value>, aspect: f64) -> Result<Value, String> {
    let mut req = json!({ "cmd": "upright", "mode": mode, "aspect": aspect });
    if let Some(g) = guides {
        req["guides"] = g;
    }
    state.engine("upright").request(req)
}

// points (x, y pairs, 0-1) between the shown image and the input image
// before any distortion; `to` is "shown" or "input"
#[tauri::command]
#[specta::specta]
async fn points(state: State<'_, AppState>, points: Value, to: String) -> Result<Value, String> {
    let reply = state.engine("points").request(json!({ "cmd": "points", "points": points, "to": to }))?;
    Ok(reply["points"].clone())
}

// how much range components select over a width x height grid of the shown
// image: u32 width and height, then one byte per point
#[tauri::command]
async fn range_map(state: State<'_, AppState>, ranges: Value, width: u32, height: u32) -> Result<Response, String> {
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
    Ok(Response::new(out))
}

// the zone (Zone System, scene-referred) of each point of a width x height
// grid of the shown image, as (z + 1) * 20, and the zones' statistics:
// u32 width, height and JSON length, the JSON, then one byte per point
#[tauri::command]
async fn zones(state: State<'_, AppState>, width: u32, height: u32, transition: f64, stage: String) -> Result<Response, String> {
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
    Ok(Response::new(out))
}

// a mask as darktable makes it, refinements and all, over a width x height
// grid of the shown image: laid out as range_map's reply. `op` instead of a
// name maps that module's own mask (a details threshold's). with a view
// ({ x, y, scale }, as a render's), the grid is that window of the image at
// that scale, width x height pixels or what of it lies on the image
#[tauri::command]
async fn mask_map(state: State<'_, AppState>, name: Option<String>, op: Option<String>, width: u32, height: u32,
                  view: Option<Value>) -> Result<Response, String> {
    let mut engine = state.engine("mask_map");
    let mut req = json!({ "cmd": "mask_map", "width": width, "height": height, "out": state.range_path });
    if let Some(n) = name {
        req["name"] = json!(n);
    }
    if let Some(o) = op {
        req["op"] = json!(o);
    }
    if let Some(v) = view {
        for k in ["x", "y", "scale"] {
            req[k] = v[k].clone();
        }
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
    Ok(Response::new(out))
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
#[tauri::command]
async fn ai_object(state: State<'_, AppState>, points: Value, r#box: Option<Value>, inset: Option<bool>,
                   backdrop: Option<bool>) -> Result<Value, String> {
    let mut req = json!({ "cmd": "ai_object", "points": points });
    if let Some(b) = r#box {
        req["box"] = b;
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
// in 0-1. `backdrop` as there too
#[tauri::command]
async fn ai_mask(state: State<'_, AppState>, kind: String, range: Option<[f64; 2]>, inset: Option<bool>,
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
async fn ai_depth(state: State<'_, AppState>, size: u32) -> Result<Value, String> {
    let mut reply = on_engine_thread(&state, json!({ "cmd": "ai_depth", "size": size })).await?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
        o.remove("tag");
    }
    Ok(reply)
}

// AI Denoise of the open raw at `strength` (0-1): a new DNG beside it with
// its edit, which the folder view then shows after it, as an Edit In
// result. replies { path, original, image }; the engine takes the edit,
// then denoises on a thread of its own
#[tauri::command]
async fn ai_denoise(state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>, strength: f64) -> Result<Value, String> {
    let mut reply = on_engine_thread(&state, json!({ "cmd": "ai_denoise", "strength": strength })).await?;
    let (Some(original), Some(result)) = (reply["original"].as_str(), reply["path"].as_str()) else {
        return Err("the engine gave no DNG".into());
    };
    plugins.record(plugins::Return {
        original: original.into(), result: result.into(), plugin: "ai-denoise".into(), applied: false,
    })?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
    }
    Ok(reply)
}

// Bake a converted negative (`kind` "negative") or a film simulation
// ("film") into a new positive beside its source, <name>-positive or
// <name>-film. Reserve the name before exporting so repeated requests never
// overwrite.
#[tauri::command]
async fn positive_export(state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>,
                         imgid: i64, original: String, format: String, kind: String) -> Result<Value, String> {
    if format != "dng" && format != "tiff" {
        return Err("choose DNG or TIFF for generated positives".into());
    }
    let (name, plugin) = match kind.as_str() {
        "negative" => ("positive", "negative-positive"),
        "film" => ("film", "film-positive"),
        _ => return Err(format!("no positive kind '{kind}'")),
    };
    let source = Path::new(&original);
    let dir = source.parent().ok_or("the source has no folder")?;
    let stem = source.file_stem().ok_or("the source has no filename")?.to_string_lossy();
    let ext = extension(&format);
    let mut n = 0;
    let target = loop {
        let suffix = if n == 0 { String::new() } else { format!("_{n:02}") };
        let path = dir.join(format!("{stem}-{name}{suffix}.{ext}"));
        // An orphaned sidecar must not supply an old edit to a new export.
        if path.with_file_name(format!("{}.xmp", path.file_name().unwrap().to_string_lossy())).exists() {
            n += 1;
            continue;
        }
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => break path,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => n += 1,
            Err(e) => return Err(format!("cannot create the positive: {e}")),
        }
    };
    let t = state.tagged.clone();
    let held = t.tag();
    if let Err(e) = state.engine("positive_export").request(json!({
        "cmd": "export_hold", "job": held, "imgids": [imgid],
    })) {
        let _ = std::fs::remove_file(&target);
        return Err(e);
    }
    let out = target.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let tag = t.tag();
        let result = t.request(tag, json!({
            "cmd": "export", "job": held, "imgid": imgid, "out": out,
            "format": format, "bpp": 32, "positive_copy": true, "history": false,
        }));
        let tag = t.tag();
        let _ = t.request(tag, json!({ "cmd": "export_release", "job": held }));
        result
    }).await.map_err(|e| e.to_string()).and_then(|r| r);
    // Keep a completed file on an import/sidecar failure for recovery.
    let mut reply = match result {
        Ok(reply) => reply,
        Err(e) => {
            if std::fs::metadata(&target).map(|m| m.len() == 0).unwrap_or(false) {
                let _ = std::fs::remove_file(&target);
            }
            return Err(e);
        }
    };
    let path = target.to_string_lossy().into_owned();
    plugins.record(plugins::Return {
        original: original.clone(), result: path, plugin: plugin.into(), applied: true,
    })?;
    reply["original"] = json!(original);
    Ok(reply)
}

// the spektrafilm data pack and its films and papers (engine main.c,
// _spektra_stocks)
#[tauri::command]
async fn spektra_stocks(state: State<'_, AppState>) -> Result<Value, String> {
    let mut reply = state.engine("spektra_stocks").request(json!({ "cmd": "spektra_stocks" }))?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
    }
    Ok(reply)
}

// the pack's download: `action` "start", "cancel" or "status"; none waits
// for the network (engine main.c, _spektra_fetch)
#[tauri::command]
async fn spektra_fetch(state: State<'_, AppState>, action: String) -> Result<Value, String> {
    let mut reply = state.engine("spektra_fetch").request(json!({ "cmd": "spektra_fetch", "action": action }))?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
    }
    Ok(reply)
}

// AI Denoise's preview: a crop about `size` pixels square centered on (u, v)
// of the edited photo. replies a header (width, height as u32; the crop's
// share of the photo across and down as f32), then the crop as float linear
// RGB without and with the denoise, for the dialog to mix at its Amount
#[tauri::command]
async fn ai_denoise_preview(state: State<'_, AppState>, u: f64, v: f64, size: u32) -> Result<Response, String> {
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
    Ok(Response::new(out))
}

// the image's heal and clone spots: replaced by `spots` when given, and
// replied as the engine keeps them
#[tauri::command]
async fn spots(state: State<'_, AppState>, spots: Option<Value>) -> Result<Value, String> {
    let mut req = json!({ "cmd": "spots" });
    if let Some(s) = spots {
        req["spots"] = s;
    }
    let reply = state.engine("spots").request(req)?;
    Ok(reply["spots"].clone())
}

// the spots off for the Before view, and back on
#[tauri::command]
async fn spots_enable(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.engine("spots_enable").request(json!({ "cmd": "spots_enable", "on": on })).map(|_| ())
}

// where a new spot should copy from: { sx, sy }
#[tauri::command]
async fn spot_source(state: State<'_, AppState>, spot: Value) -> Result<Value, String> {
    let reply = state.engine("spot_source").request(json!({ "cmd": "spot_source", "spot": spot }))?;
    Ok(json!({ "sx": reply["sx"], "sy": reply["sy"] }))
}

#[tauri::command]
async fn mask_delete(state: State<'_, AppState>, name: String) -> Result<(), String> {
    state.engine("mask_delete").request(json!({ "cmd": "mask_delete", "name": name })).map(|_| ())
}

#[tauri::command]
async fn mask_rename(state: State<'_, AppState>, name: String, to: String) -> Result<(), String> {
    state.engine("mask_rename").request(json!({ "cmd": "mask_rename", "name": name, "to": to })).map(|_| ())
}

const FRAME_HEAD: usize = 64;

// without a scale the whole image is fitted into width x height; with one
// (1.0 is 100%) the width x height window at (x, y) of the scaled image is
// rendered. the frame goes back as raw bytes: six little-endian u32 (frame
// width, height, image width and height at 100%, window x, y), six
// little-endian f32 timings in ms (waiting for the engine, the engine's
// request, its pixelpipe, its frame write, the frame read here, collecting
// the per-module timings), darktable's u64 hash of the frame, one more f32
// timing (the edits sent ahead of the render) and four bytes of padding
// (FRAME_HEAD bytes in all), then RGBA. ops in skip are left out of this frame. a
// frame of no size, with no RGBA, is the one in `have` of that hash
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn render(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    width: u32,
    height: u32,
    scale: Option<f64>,
    x: Option<i64>,
    y: Option<i64>,
    skip: Option<Vec<String>>,
    draft: Option<bool>,
    base: Option<bool>,
    shared: Option<u32>,
    token: Option<String>,
    have: Option<Vec<String>>,
    edits: Option<Vec<Value>>,
    diagnostic_request: Option<u64>,
) -> Result<Response, String> {
    let mut req = json!({ "cmd": "render", "width": width, "height": height, "rgba": state.frame_path });
    if let Some(id) = diagnostic_request { req["diagnostic_request"] = json!(id); }
    if let Some(skip) = skip {
        req["skip"] = json!(skip);
    }
    // the hashes of frames the page holds: when the view's frame is one of
    // them, the engine names it rather than rendering it
    if let Some(have) = have {
        req["have"] = json!(have);
    }
    // a drag's frame, on the engine's drag pipe
    if draft == Some(true) {
        req["draft"] = json!(true);
    }
    // the idle whole-image base, on the engine's base pipe and the GPU;
    // numbered before it waits for the engine, so cancel_base reaches it
    // even then
    if base == Some(true) {
        req["base"] = json!(true);
        req["id"] = json!(state.base_cancel.next_id());
    }
    if let Some(s) = scale {
        req["scale"] = json!(s);
        req["x"] = json!(x.unwrap_or(0));
        req["y"] = json!(y.unwrap_or(0));
    }
    let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
    let t0 = Instant::now();
    let operation = if base == Some(true) { "base" } else { "render" };
    let mut engine = state.engine.lock(operation, diagnostic_request);
    engine.set_operation(operation);
    let lock_ms = ms(t0);
    // a move's module edits (Session.moduleEdit), sent as set_params would,
    // under the same lock: one call from the page rather than one each,
    // which cost 20 ms or more a call on Linux while the page draws
    let ts = Instant::now();
    for e in edits.unwrap_or_default() {
        let mut set = json!({ "cmd": "set" });
        for k in ["op", "params", "enabled", "after", "before", "instance"] {
            if !e[k].is_null() {
                set[k] = e[k].clone();
            }
        }
        engine.request(set)?;
    }
    let set_ms = ms(ts);
    let t1 = Instant::now();
    let reply = engine.request(req)?;
    if let Some(output) = reply["output_ms"].as_object() {
        engine.set_output_ms(["allocate_ms", "convert_ms", "file_ms", "free_ms"]
            .map(|key| output.get(key).and_then(Value::as_f64).unwrap_or(0.0)));
    }
    let request_ms = ms(t1);
    let field = |k: &str| reply[k].as_u64().unwrap_or(0) as u32;
    // the header, then the frame read straight in behind it: one copy of a
    // frame that can be 17 MB, read while the engine is still ours so no
    // other render overwrites it
    let size = 4 * field("width") as usize * field("height") as usize;
    let mut out = Vec::with_capacity(FRAME_HEAD + size);
    for k in ["width", "height", "full_width", "full_height", "x", "y"] {
        out.extend_from_slice(&field(k).to_le_bytes());
    }
    let timings = 24;
    out.resize(48, 0);
    let hash = reply["hash"].as_str().and_then(|h| u64::from_str_radix(h, 16).ok()).unwrap_or(0);
    out.extend_from_slice(&hash.to_le_bytes());
    out.extend_from_slice(&(set_ms as f32).to_le_bytes());
    out.resize(FRAME_HEAD, 0);
    let kept = reply["kept"].as_bool() == Some(true);
    let t2 = Instant::now();
    if !kept {
        frame_output::FrameOutput::append(&state.frame_path, &mut out)
            .map_err(|e| format!("frame: {e}"))?;
    }
    let read_ms = ms(t2);
    let t3 = Instant::now();
    if state.perf_on.load(Ordering::Relaxed) {
        let modules = engine.perf_mark();
        *state.perf_last.lock().unwrap() = modules.clone();
        if let Some(id) = diagnostic_request {
            let mut requests = state.perf_by_request.lock().unwrap();
            if requests.len() >= 512 {
                if let Some(oldest) = requests.keys().copied().min() { requests.remove(&oldest); }
                state.perf_modules_dropped.fetch_add(1, Ordering::Relaxed);
            }
            requests.insert(id, modules);
        }
    }
    let mark_ms = ms(t3);
    drop(engine);
    let f = |k: &str| reply[k].as_f64().unwrap_or(0.0);
    for (i, v) in [lock_ms, request_ms, f("process_ms"), f("write_ms"), read_ms, mark_ms].into_iter().enumerate() {
        out[timings + 4 * i..timings + 4 * i + 4].copy_from_slice(&(v as f32).to_le_bytes());
    }
    // the header alone, of no size: the page's own frame of that hash
    if kept {
        return Ok(Response::new(out));
    }
    // the header alone says the frame went by shared memory, tagged `shared`;
    // where that can't be done, it comes back whole as before
    #[cfg(windows)]
    if let Some(id) = shared {
        let out = std::sync::Arc::new(out);
        match shared_frame::post(&webview, out.clone(), id) {
            Ok(()) => return Ok(Response::new(out[..FRAME_HEAD].to_vec())),
            Err(e) => {
                eprintln!("shared frame: {e}");
                return Ok(Response::new(std::sync::Arc::try_unwrap(out).unwrap_or_else(|a| (*a).clone())));
            }
        }
    }
    #[cfg(target_os = "linux")]
    if let (Some(id), Some(token)) = (shared, token) {
        let shared_start = Instant::now();
        match shm_frame::write(&out, &token, id) {
            Ok(()) => {
                // Reserved header word: duration of the shared-file write. The
                // file already contains the earlier header; the reply owns this
                // timing and the frontend records it before reading that file.
                out[60..64].copy_from_slice(&(ms(shared_start) as f32).to_le_bytes());
                return Ok(Response::new(out[..FRAME_HEAD].to_vec()));
            },
            Err(e) => eprintln!("shared frame: {e}"),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (shared, token);
    #[cfg(not(windows))]
    let _ = webview;
    Ok(Response::new(out))
}

// Linux: a frame handed to the page through /dev/shm, which the window's
// web extension (webext/frames.c) reads and deletes. returned through
// Tauri, WebKitGTK copies it across processes at about 25 ms a megapixel,
// more while a 2x page draws
#[cfg(target_os = "linux")]
mod shm_frame {
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

    const DIR: &str = "/dev/shm";
    const PREFIX: &str = "immage-frame-";

    // the page's token is 16 hex digits (sharedFrames.ts), and the
    // extension reads no other name
    pub fn path(token: &str, id: u32) -> Option<PathBuf> {
        (token.len() == 16 && token.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| Path::new(DIR).join(format!("{PREFIX}{token}-{id}")))
    }

    pub fn write(frame: &[u8], token: &str, id: u32) -> Result<(), String> {
        let path = path(token, id).ok_or("bad token")?;
        write_file(&path, frame).map_err(|e| format!("{}: {e}", path.display()))
    }

    // a new file only, owner-readable (the web extension runs as the same
    // user), and never through a symlink planted at the name in the shared
    // directory: an existing entry is removed (remove_file does not follow
    // a link) and the create retried once
    fn write_file(path: &Path, frame: &[u8]) -> std::io::Result<()> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let open = || {
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(path)
        };
        let mut file = match open() {
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                std::fs::remove_file(path)?;
                open()?
            }
            other => other?,
        };
        file.write_all(frame)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::{symlink, PermissionsExt};

        #[test]
        fn shm_write_is_private_and_ignores_symlinks() {
            let dir = std::env::temp_dir().join(format!("immage-shm-test-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let victim = dir.join("victim");
            std::fs::write(&victim, b"keep").unwrap();
            let target = dir.join("frame");
            symlink(&victim, &target).unwrap();
            write_file(&target, b"frame").unwrap();
            assert_eq!(std::fs::read(&victim).unwrap(), b"keep");
            assert_eq!(std::fs::read(&target).unwrap(), b"frame");
            assert!(!std::fs::symlink_metadata(&target).unwrap().file_type().is_symlink());
            assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o600);
            // an existing regular file is replaced too
            write_file(&target, b"next").unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), b"next");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    // frames a page never read (it closed, or the app was killed) stay in
    // memory until deleted: those over a minute old, at startup. another
    // running copy's are newer
    pub fn sweep() {
        let Ok(dir) = std::fs::read_dir(DIR) else { return };
        let old = SystemTime::now() - Duration::from_secs(60);
        for e in dir.flatten() {
            if e.file_name().to_string_lossy().starts_with(PREFIX)
                && e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < old)
            {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

// a frame handed to the page through a WebView2 shared buffer. returned
// through Tauri, it would be copied into a COM stream on the UI thread and
// read across two process boundaries (wry, webview2/mod.rs,
// prepare_web_request_response): 125-240 MB/s, against the Mac's 3-4 GB/s
#[cfg(windows)]
mod shared_frame {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment12, ICoreWebView2_17, ICoreWebView2_2, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
    };
    use windows::core::{Interface, HSTRING};

    // WebView2 is called on the UI thread only; the page copies the frame out
    // and releases the buffer (session.ts, sharedFrame)
    pub fn post(webview: &tauri::Webview, frame: Arc<Vec<u8>>, id: u32) -> Result<(), String> {
        let (tx, rx) = mpsc::channel();
        webview
            .with_webview(move |pw| {
                let posted = unsafe {
                    (|| -> windows::core::Result<()> {
                        let core = pw.controller().CoreWebView2()?;
                        let env: ICoreWebView2Environment12 = core.cast::<ICoreWebView2_2>()?.Environment()?.cast()?;
                        let buffer = env.CreateSharedBuffer(frame.len() as u64)?;
                        let mut p = std::ptr::null_mut();
                        buffer.Buffer(&mut p)?;
                        std::ptr::copy_nonoverlapping(frame.as_ptr(), p, frame.len());
                        let tag = HSTRING::from(format!("{{\"frame\":{id}}}"));
                        core.cast::<ICoreWebView2_17>()?
                            .PostSharedBufferToScript(&buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, &tag)
                    })()
                };
                let _ = tx.send(posted.map_err(|e| e.to_string()));
            })
            .map_err(|e| e.to_string())?;
        rx.recv_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?
    }
}

// stop the base render under way, or about to be: its render then fails
// with "canceled". no engine lock, as that render holds it
#[tauri::command]
async fn cancel_base(state: State<'_, AppState>) -> Result<(), String> {
    state.base_cancel.cancel()
}

// the performance overlay: on, renders collect darktable's per-module timings
#[tauri::command]
async fn perf_set(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.perf_on.store(on, Ordering::Relaxed);
    Ok(())
}

// a content security policy violation the page saw (tauri.conf.json, csp),
// one line in webview.log in the runtime folder. the page dedupes and caps
// what it sends; the file is also capped here, so a page cannot fill the disk
#[tauri::command]
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
async fn perf_trace_start(state: State<'_, AppState>) -> Result<(), String> {
    state.perf_by_request.lock().unwrap().clear();
    state.perf_modules_dropped.store(0, Ordering::Relaxed);
    state.engine("perf_trace_start").cache_trace(true)?;
    state.engine.start();
    Ok(())
}
#[tauri::command]
async fn perf_trace_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    state.engine("perf_trace_stop").cache_trace(false)?;
    Ok(())
}

// the last render's per-module timings, while the overlay is on
#[tauri::command]
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
async fn gpu_check_parity(state: State<'_, AppState>, size: Option<u32>, diff: Option<String>,
                          self_check: Option<bool>) -> Result<Value, String> {
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
    let mut reply = engine.request(req)?;
    let timings = engine.perf_mark();
    let mut passes = serde_json::Map::new();
    let mut pass = String::new();
    for t in timings {
        if t.kind == "pass" {
            pass = t.label.clone();
            passes.insert(pass.clone(), json!([]));
        } else if let Some(Value::Array(list)) = passes.get_mut(&pass) {
            // the check pipe is a full pipe; a thumbnail or preview drawn
            // meanwhile on another thread is not part of its pass
            if t.pipe.is_empty() || t.pipe == "full" { list.push(json!(t)); }
        }
    }
    reply["modules"] = Value::Object(passes);
    if let Some(o) = reply.as_object_mut() { o.remove("ok"); }
    Ok(reply)
}

// does nothing: the GUI benchmark times a call's round trip on its own,
// the cost every engine call pays on top of its work
#[tauri::command]
async fn perf_ping() -> Result<(), String> {
    Ok(())
}

// a GUI benchmark's report, as <name>.json in the reports folder; its path back
#[tauri::command]
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
fn webview_renderer() -> Value {
    #[cfg(target_os = "linux")]
    return renderer::status();
    #[cfg(not(target_os = "linux"))]
    json!(null)
}

#[tauri::command]
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
async fn perf_machine(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let opencl = state.engine("perf_machine").request(json!({ "cmd": "opencl" })).ok()
        .map(|mut r| { if let Some(o) = r.as_object_mut() { o.remove("ok"); } r });
    let dir = app.path().app_data_dir().ok();
    tauri::async_runtime::spawn_blocking(move || machine_block(dir.as_deref(), opencl))
    .await
    .map_err(|e| e.to_string())
}

// import a folder's images into the engine's in-memory library, and with
// `recursive` its subfolders' too; darktable decides what is an image. the
// files go in batches, each reported as a "folder-progress" event with its
// images, so a big folder shows its progress and its first photos early.
// the batches go to the engine's import thread (main.c, _import_run), so
// the photo is edited and rendered while they are read.
// a first event, before the folder is even listed, has its images as the
// last read found them (`known`, without imgids): from the app's own disk,
// so a folder on a network share shows at once. the next lists every file,
// so the client can lay out a cell for each. a newer call (another `token`)
// stops this one. returns every image: ratings, labels and EXIF summary.
// `skip` names subfolders taken off the folder tree, which `recursive`
// leaves out with their own subfolders
#[tauri::command]
async fn open_folder(app: AppHandle, state: State<'_, AppState>, path: String, recursive: Option<bool>,
                     skip: Option<Vec<String>>, token: u64) -> Result<Value, String> {
    state.folder_token.store(token, Ordering::SeqCst);
    let recursive = recursive.unwrap_or(false);
    let snapshot = snapshot_path(&state.runtime, &path, recursive, skip.as_deref().unwrap_or_default());
    let known = {
        let snapshot = snapshot.clone();
        tauri::async_runtime::spawn_blocking(move || read_snapshot(&snapshot)).await.map_err(|e| e.to_string())?
    };
    if let Some(known) = known {
        let _ = app.emit("folder-progress", json!({ "token": token, "done": 0, "total": 0, "images": [],
                                                    "known": known }));
    }
    let dir = PathBuf::from(&path);
    let there = {
        let dir = dir.clone();
        tauri::async_runtime::spawn_blocking(move || volumes::answering(&dir).then(|| dir.is_dir()))
            .await
            .map_err(|e| e.to_string())?
    };
    match there {
        None => return Err(format!("{path} is not answering: its drive or network share may be disconnected")),
        Some(false) => return Err(format!("folder not found: {path}")),
        Some(true) => {}
    }
    let skip: HashSet<PathBuf> = skip.unwrap_or_default().into_iter().map(PathBuf::from).collect();
    let (mut files, listed) = tauri::async_runtime::spawn_blocking(move || {
        let (mut out, mut listed) = (Vec::new(), cache::Listed::default());
        folder_files(&dir, recursive, &skip, &mut out, &mut listed);
        (out, listed)
    })
    .await
    .map_err(|e| e.to_string())?;
    if state.folder_token.load(Ordering::SeqCst) != token {
        return Err("superseded".into());
    }
    *app.state::<Caches>().listed.lock().unwrap() = listed;
    app.state::<plugins::Plugins>().drain_jobs();
    app.state::<plugins::Plugins>().beside_originals(&mut files);
    let total = files.len();
    let list: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let _ = app.emit("folder-progress", json!({ "token": token, "done": 0, "total": total, "images": [],
                                                "files": list }));
    let mut images = Vec::new();
    let mut unanswered: Vec<Value> = Vec::new();
    let mut done = 0;
    let mut size = IMPORT_BATCH.0;
    let mut progress = Progress::default();
    while done < total {
        if state.folder_token.load(Ordering::SeqCst) != token {
            return Err("superseded".into());
        }
        let batch = &files[done..total.min(done + size)];
        let list: Vec<String> = batch.iter().map(|p| p.to_string_lossy().into_owned()).collect();
        let t = state.tagged.clone();
        let tag = t.tag();
        let start = Instant::now();
        let handle = app.clone();
        // `job` stops the batch once another folder's is queued, and
        // `budget` once it has run that long, so a network share's slow
        // files hold neither the next folder nor an open photo for long
        // (main.c, _import_files)
        let budget = (IMPORT_TARGET * 2).as_millis() as u64;
        let reply = tauri::async_runtime::spawn_blocking(move || t.request_until(
            tag, json!({ "cmd": "import", "files": list, "job": token, "budget": budget }), Duration::from_secs(30),
            || handle.state::<AppState>().folder_token.load(Ordering::SeqCst) != token))
            .await
            .map_err(|e| e.to_string())??;
        let took = start.elapsed();
        let got = reply["images"].as_array().cloned().unwrap_or_default();
        // the files the batch went through; the rest go in the next. none
        // when another read's batch came in first, which the token check
        // above then finds, or which is resent
        let through = reply["done"].as_u64().map_or(batch.len(), |n| (n as usize).min(batch.len()));
        // a batch of about IMPORT_TARGET, however long a file takes to read
        if through > 0 && through < batch.len() {
            size = through.max(IMPORT_BATCH.1);
        } else if took < IMPORT_TARGET / 2 {
            size = (size * 2).min(IMPORT_BATCH.2);
        } else if took > IMPORT_TARGET * 2 {
            size = (size / 2).max(IMPORT_BATCH.1);
        }
        done += through;
        // files the share did not answer for are skipped, not retried, so one
        // stalled read cannot hold the folder; a batch of one from then on
        // shows each further stall by itself
        if let Some(silent) = reply["unanswered"].as_array().filter(|a| !a.is_empty()) {
            unanswered.extend(silent.iter().cloned());
            size = IMPORT_BATCH.1;
        }
        images.extend(got.iter().cloned());
        if let Some(got) = progress.add(got, Instant::now(), done == total) {
            let _ = app.emit("folder-progress", json!({ "token": token, "done": done, "total": total, "images": got }));
        }
    }
    let kept = images.clone();
    tauri::async_runtime::spawn_blocking(move || write_snapshot(&snapshot, &kept));
    Ok(json!({ "images": images, "unanswered": unanswered }))
}

// the folder's images as its last whole read found them, for open_folder()
// to show before it reads again: one file per folder (and recursive and
// skip, which change what it holds) in the runtime folder
fn snapshot_path(runtime: &Path, dir: &str, recursive: bool, skip: &[String]) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut skip = skip.to_vec();
    skip.sort();
    let mut h = Sha256::new();
    h.update(format!("{dir}\0{recursive}\0{}", skip.join("\0")));
    let name: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();
    runtime.join("folders").join(format!("{name}.json"))
}

fn read_snapshot(path: &Path) -> Option<Value> {
    let list: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    list.is_array().then_some(list)
}

// without imgids, which are the engine's for this session only. written
// beside and renamed, so a read never finds half a file
fn write_snapshot(path: &Path, images: &[Value]) {
    let list: Vec<Value> = images.iter().map(|i| {
        let mut i = i.clone();
        if let Some(o) = i.as_object_mut() {
            o.remove("imgid");
        }
        i
    }).collect();
    let Ok(bytes) = serde_json::to_vec(&list) else { return };
    let Some(dir) = path.parent() else { return };
    let part = path.with_extension("part");
    if std::fs::create_dir_all(dir).is_ok() && std::fs::write(&part, bytes).is_ok()
        && std::fs::rename(&part, path).is_err() {
        let _ = std::fs::remove_file(&part);
    }
}

// a batch's files to begin with, and the fewest and most: sized to take
// about IMPORT_TARGET, so the folder fills in steady steps
const IMPORT_BATCH: (usize, usize, usize) = (8, 1, 64);
const IMPORT_TARGET: Duration = Duration::from_millis(150);

// a folder's batches, reported as a folder-progress event at most every
// PROGRESS_EVERY: each event redraws the filmstrip, a cell for every file
// in the folder, and a network share's batch is a file or two, so an
// event per batch kept the window too busy to edit in. the first batch
// goes at once, for the folder's first photos, and the last for the rest
const PROGRESS_EVERY: Duration = Duration::from_secs(1);

#[derive(Default)]
struct Progress {
    sent: Option<Instant>,
    held: Vec<Value>,
}

impl Progress {
    // a batch's images; those held since the last event, with these, when
    // it is time for the next
    fn add(&mut self, got: Vec<Value>, now: Instant, last: bool) -> Option<Vec<Value>> {
        self.held.extend(got);
        if !last && self.sent.is_some_and(|t| now.duration_since(t) < PROGRESS_EVERY) {
            return None;
        }
        self.sent = Some(now);
        Some(std::mem::take(&mut self.held))
    }
}

// the files of `dir` by name, then with `recursive` each subfolder's in
// turn, as darktable's own folder import orders them. dot files, sidecars
// and packages are left out, and so are the subfolders in `skip`
// each file's stamp, sidecars' too, goes in `listed`, so its thumbnail is
// checked without asking the disk again (cache::listed_thumb_name)
fn folder_files(dir: &Path, recursive: bool, skip: &HashSet<PathBuf>, out: &mut Vec<PathBuf>,
                listed: &mut cache::Listed) {
    let (mut files, mut dirs, mut stamps) = (Vec::new(), Vec::new(), Vec::new());
    for e in listing::list(dir) {
        let name = e.name.to_string_lossy().to_lowercase();
        if name.starts_with('.') {
            continue;
        }
        let p = dir.join(&e.name);
        // from the listing itself, where p.is_dir() would ask the disk of
        // every file, a round trip each on a network share; a link is
        // followed, as is_dir() did
        let is_dir = match e.kind {
            listing::Kind::Dir => true,
            listing::Kind::File => false,
            listing::Kind::Other => p.is_dir(),
        };
        if is_dir {
            if recursive && !skip.contains(&p) && !is_package(&p) {
                dirs.push((name, p));
            }
            continue;
        }
        stamps.push((p.clone(), e.stamp));
        if !name.ends_with(".xmp") {
            files.push((name, p));
        }
    }
    listed.add(dir, stamps);
    files.sort();
    dirs.sort();
    out.extend(files.into_iter().map(|(_, p)| p));
    for (_, d) in dirs {
        folder_files(&d, true, skip, out, listed);
    }
}

// a folder macOS shows as a file (Photos Library, a Lightroom catalog's
// .lrlibrary, an app): not one to browse or import from
#[cfg(target_os = "macos")]
fn is_package(path: &Path) -> bool {
    let p = objc2_foundation::NSString::from_str(&path.to_string_lossy());
    objc2_app_kit::NSWorkspace::sharedWorkspace().isFilePackageAtPath(&p)
}

#[cfg(not(target_os = "macos"))]
fn is_package(_path: &Path) -> bool {
    false
}

// whether a file or folder is still there, as one moved or deleted outside
// the app is not
// a folder on a drive that is not answering counts as there, so it is not
// taken for one moved or deleted
#[tauri::command]
async fn path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || !volumes::answering(Path::new(&path)) || Path::new(&path).exists())
        .await
        .unwrap_or(true)
}

// a path dropped on the window: "dir", "file", or none when it is gone
#[tauri::command]
#[specta::specta]
fn path_kind(path: String) -> Option<&'static str> {
    let p = std::fs::canonicalize(&path).ok()?;
    if p.is_dir() { Some("dir") } else if p.is_file() { Some("file") } else { None }
}

// the screen's real scale where it is less than the whole one GTK draws
// the window at (Wayland at 125%: 1.25 against 2), so the viewer sizes
// frames for the screen; none elsewhere. an error until the window is on a
// screen, as at start: the page asks again. not async: GTK's monitor is
// read on the main thread
#[tauri::command]
fn display_scale(window: tauri::WebviewWindow) -> Result<Option<f64>, String> {
    #[cfg(target_os = "linux")]
    {
        let monitor = window.current_monitor().ok().flatten().ok_or("not on a screen yet")?;
        let whole = monitor.scale_factor();
        let p = monitor.position();
        let at = ((p.x as f64 / whole).round() as i32, (p.y as f64 / whole).round() as i32);
        Ok(scale::output_scale(at).filter(|s| *s < whole - 0.01))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(None)
    }
}

// rejected photos to the system's Trash. the engine, not the client, says
// whether each is rejected and where it is: if any is not rejected, nothing
// moves. a virtual copy takes only its own sidecars, leaving the file to
// the other versions; an original takes the file and every version's
// sidecars, as darktable deletes them. returns the trashed files' paths
#[tauri::command]
async fn trash_files(state: State<'_, AppState>, imgids: Vec<i64>) -> Result<Vec<String>, String> {
    let mut checked = Vec::new();
    for id in imgids {
        let reply = state.engine("trash_files").request(json!({ "cmd": "meta", "imgid": id }))?;
        let image = &reply["image"];
        let path = image["path"].as_str().unwrap_or_default().to_string();
        if image["rejected"].as_bool() != Some(true) || path.is_empty() {
            let name = image["filename"].as_str().unwrap_or("a photo");
            return Err(format!("{name} is not rejected; nothing was deleted"));
        }
        checked.push((id, path, image["copy"].as_bool() == Some(true)));
    }
    let mut items: Vec<PathBuf> = Vec::new();
    let mut gone = Vec::new();
    let mut forget = Vec::new();
    for (id, path, copy) in checked {
        let cmd = if copy { "remove_copy" } else { "sidecars" };
        let reply = state.engine("trash_files").request(json!({ "cmd": cmd, "imgid": id }))?;
        if !copy {
            items.push(PathBuf::from(&path));
            gone.push(path);
            forget.push(id);
        }
        items.extend(reply["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(PathBuf::from));
    }
    trash_existing(items).await?;
    // only once the files are gone: a new file at the same path then
    // imports fresh, not as the deleted one, rejected
    for id in forget {
        state.engine("trash_files").request(json!({ "cmd": "forget", "imgid": id }))?;
    }
    Ok(gone)
}

// the files that are still there, each once: an original and its own
// copy in one batch name the copy's sidecar twice
async fn trash_existing(mut items: Vec<PathBuf>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        items.sort();
        items.dedup();
        items.retain(|p| p.is_file());
        if items.is_empty() {
            return Ok(());
        }
        #[allow(unused_mut)]
        let mut trash = trash::TrashContext::default();
        // the crate's default asks Finder over AppleScript, which needs the
        // Automation permission and fails without it; NSFileManager does not
        #[cfg(target_os = "macos")]
        {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            trash.set_delete_method(DeleteMethod::NsFileManager);
        }
        trash.delete_all(&items).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// a virtual copy of a photo: a new darktable version carrying its edit,
// rating, labels, metadata and keywords, with a sidecar of its own
#[tauri::command]
async fn create_virtual_copy(state: State<'_, AppState>, imgid: i64) -> Result<Value, String> {
    let reply = state.engine("create_virtual_copy").request(json!({ "cmd": "copy", "imgid": imgid }))?;
    Ok(reply["image"].clone())
}

// a merge on the engine's export thread as the page's job `job`, its
// progress emitted as "merge-progress" { job, done, total, stage, last }:
// the photos read, then the merge's own stages, `last` the one past
// stopping (main.c, _merge_report); merge_cancel stops it at its next step
fn merge(app: AppHandle, t: engine::Tagged, job: u64, mut req: Value) -> Result<Value, String> {
    let tag = t.tag();
    req["job"] = json!(job);
    t.request_with_progress(tag, req, move |p| {
        let _ = app.emit("merge-progress", json!({
            "job": job, "done": p["done"], "total": p["total"], "stage": p["stage"], "last": p["last"],
        }));
    })
}

// stops the page's merge `job` at its next step. the line gets no reply;
// the merge answers "stopped"
#[tauri::command]
fn merge_cancel(state: State<'_, AppState>, job: u64) -> Result<(), String> {
    state.tagged.send(json!({ "cmd": "merge_cancel", "job": job }))
}

// Merge to HDR: the raw brackets `imgids` into a float DNG beside the
// first (<name>-hdr.dng), registered onto each other first when `align`.
// replies { path, image }. the engine merges on its export thread, so the
// photo is edited meanwhile
#[tauri::command]
async fn hdr_merge(app: AppHandle, state: State<'_, AppState>, job: u64, imgids: Vec<i64>, align: bool)
                   -> Result<Value, String> {
    let t = state.tagged.clone();
    let mut reply = tauri::async_runtime::spawn_blocking(move || {
        merge(app, t, job, json!({ "cmd": "hdr_merge", "imgids": imgids, "align": align }))
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
        o.remove("tag");
    }
    Ok(reply)
}

// whether Merge to HDR can align brackets: the engine built with OpenCV
#[tauri::command]
async fn hdr_can_align(state: State<'_, AppState>) -> Result<bool, String> {
    let reply = state.engine("hdr_can_align").request(json!({ "cmd": "version" }))?;
    Ok(reply["hdr_align"].as_bool().unwrap_or(false))
}

// Panorama Merge: the photos `imgids` stitched into a DNG beside the first
// (<name>-pano.dng), which the folder view then shows after it, as an
// Edit In result. `projection` is "auto", "spherical", "cylindrical" or
// "perspective"; `crop` cuts the empty edges. replies { path, original,
// image, used, frames }, `used` being how many frames overlapped the rest.
// the engine stitches on its export thread, so the photo is edited
// meanwhile
#[tauri::command]
async fn pano_merge(app: AppHandle, state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>, job: u64,
                    imgids: Vec<i64>, projection: String, crop: bool) -> Result<Value, String> {
    let t = state.tagged.clone();
    let mut reply = tauri::async_runtime::spawn_blocking(move || {
        merge(app, t, job, json!({ "cmd": "pano_merge", "imgids": imgids, "projection": projection, "crop": crop }))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (Some(original), Some(result)) = (reply["original"].as_str(), reply["path"].as_str()) else {
        return Err("the engine gave no DNG".into());
    };
    plugins.record(plugins::Return {
        original: original.into(), result: result.into(), plugin: "panorama".into(), applied: false,
    })?;
    if let Some(o) = reply.as_object_mut() {
        o.remove("ok");
        o.remove("tag");
    }
    Ok(reply)
}

// Reduced-size panorama on the export thread. No file is written or imported;
// the page crops the returned RGBA coverage locally, and merge_cancel stops it.
#[tauri::command]
async fn pano_preview(app: AppHandle, state: State<'_, AppState>, job: u64,
                      imgids: Vec<i64>, projection: String) -> Result<Value, String> {
    let t = state.tagged.clone();
    tauri::async_runtime::spawn_blocking(move || {
        merge(app, t, job, json!({ "cmd": "pano_preview", "imgids": imgids, "projection": projection }))
    })
    .await
    .map_err(|e| e.to_string())?
}

// whether Panorama Merge can stitch: the engine built with OpenCV's
// stitching module
#[tauri::command]
async fn pano_can_merge(state: State<'_, AppState>) -> Result<bool, String> {
    let reply = state.engine("pano_can_merge").request(json!({ "cmd": "version" }))?;
    Ok(reply["pano"].as_bool().unwrap_or(false))
}

// out of the library, its sidecars to the Trash. the photo's file stays.
// once the engine has removed it, it is gone from the library whatever the
// Trash says, so that comes back as a warning rather than an error
#[tauri::command]
async fn remove_virtual_copy(state: State<'_, AppState>, imgid: i64) -> Result<Option<String>, String> {
    let reply = state.engine("remove_virtual_copy").request(json!({ "cmd": "remove_copy", "imgid": imgid }))?;
    let files = reply["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(PathBuf::from).collect();
    Ok(trash_existing(files).await.err())
}

// a folder's subfolders for the library panel's tree: name, path and
// whether it has subfolders of its own (for the twisty). dot folders and
// packages are left out; a folder that cannot be read has none
#[derive(serde::Serialize)]
struct SubFolder {
    name: String,
    path: String,
    has_children: bool,
}

fn subdirs(path: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(path) else { return Vec::new() };
    rd.flatten()
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| !is_package(p))
        .collect()
}

#[tauri::command]
async fn list_subfolders(path: String) -> Vec<SubFolder> {
    tauri::async_runtime::spawn_blocking(move || {
        if !volumes::answering(Path::new(&path)) {
            return Vec::new();
        }
        let mut list: Vec<SubFolder> = subdirs(Path::new(&path))
            .into_iter()
            .map(|p| SubFolder {
                name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                has_children: !subdirs(&p).is_empty(),
                path: p.to_string_lossy().into_owned(),
            })
            .collect();
        list.sort_by_key(|f| f.name.to_lowercase());
        list
    })
    .await
    .unwrap_or_default()
}

// the drive each library folder is on, for the folder tree's headings. off
// the main thread: a share whose server is gone can hold statfs a while
#[tauri::command]
async fn folder_volumes(paths: Vec<String>) -> Vec<volumes::Volume> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| volumes::volume(p)).collect())
        .await
        .unwrap_or_default()
}

// the lighttable thumbnail of an image: little-endian u32 width and height,
// then RGBA. given the photo's file, it is also kept in the thumbnail cache.
// the engine builds it on a thread of its own, beside any edit or render,
// so it does not take engine()
#[tauri::command]
async fn thumb(state: State<'_, AppState>, caches: State<'_, Caches>, imgid: i64, size: u32,
               path: Option<String>, version: Option<i64>, proof: Option<bool>) -> Result<Response, String> {
    // named before the render: a sidecar written during it makes the next
    // look a miss, never a stale hit. a proofed one is not the photo's
    // thumbnail, and is not kept
    let proof = proof.unwrap_or(false);
    let name = path.filter(|_| !proof).and_then(|p| cache::refresh(&caches.listed, Path::new(&p), version.unwrap_or(0), size).map(|n| (p, n)));
    let thumbs = state.tagged.clone();
    let tag = thumbs.tag();
    // a file of its own, as several are built at once
    let storage = state._frame_output.clone();
    let out = storage.path(&format!("thumb-{tag}.rgba"));
    let (reply, mut pixels) = tauri::async_runtime::spawn_blocking(move || {
        let got = thumbs.request(tag, json!({ "cmd": "thumb", "imgid": imgid, "size": size, "proof": proof, "out": out }))
            .and_then(|reply| Ok((reply, frame_output::FrameOutput::read(&out).map_err(|e| format!("thumb: {e}"))?)));
        storage.remove(&out);
        drop(storage);
        got
    })
    .await
    .map_err(|e| e.to_string())??;
    // the thumbnail cache leaves the fourth byte at 0, which a canvas takes
    // for fully transparent
    for a in pixels.iter_mut().skip(3).step_by(4) {
        *a = 255;
    }
    let (width, height) = (reply["width"].as_u64().unwrap_or(0) as u32, reply["height"].as_u64().unwrap_or(0) as u32);
    let mut out = Vec::with_capacity(8 + pixels.len());
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(&pixels);
    // encoded and written after the reply, which need not wait for it
    if let Some((photo, name)) = name {
        let thumbs = caches.thumbs.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Ok(jpeg) = cache::encode_jpeg(&pixels, width, height) {
                if thumbs.write(&name, &jpeg).is_ok() {
                    thumbs.set_known(Path::new(&photo), version.unwrap_or(0), size, &name);
                }
            }
        });
    }
    Ok(Response::new(out))
}

// a library thumbnail from the cache, as JPEG, or nothing when it has none
// for the photo as it is now: as the open folder's listing found it, else
// as a stat finds it. the engine is not asked
#[tauri::command]
async fn thumb_cached(caches: State<'_, Caches>, path: String, version: i64, size: u32) -> Result<Response, String> {
    let (thumbs, listed) = (caches.thumbs.clone(), caches.listed.clone());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let photo = Path::new(&path);
        let name = cache::listed_thumb_name(&listed, photo, version, size)?;
        let bytes = thumbs.read(&name)?;
        // a cache from before known thumbnails learns them as it is read
        thumbs.set_known(photo, version, size, &name);
        Some(bytes)
    }).await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes.unwrap_or_default()))
}

// the photo's last thumbnail as JPEG, or nothing, found by its path alone:
// the photo is not looked at, so this is quick on a network share, but it
// may be of the photo as it was. thumb_cached() is the one to trust
#[tauri::command]
async fn thumb_known(caches: State<'_, Caches>, path: String, version: i64, size: u32) -> Result<Response, String> {
    let thumbs = caches.thumbs.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || thumbs.read_known(Path::new(&path), version, size))
        .await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes.unwrap_or_default()))
}

// Preferences' size limits for the caches, in bytes; lowering one evicts at once
#[tauri::command]
async fn cache_limits(caches: State<'_, Caches>, limits: cache::Limits) -> Result<(), String> {
    let list = [(caches.thumbs.clone(), limits.thumbs), (caches.immich_thumbs.clone(), limits.immich_thumbs),
                (caches.immich_originals.clone(), limits.immich_originals)];
    tauri::async_runtime::spawn_blocking(move || {
        for (c, l) in list {
            c.set_limit(l);
        }
    }).await.map_err(|e| e.to_string())
}

// how much each cache holds, in bytes
#[tauri::command]
async fn cache_usage(caches: State<'_, Caches>) -> Result<cache::Limits, String> {
    let (a, b, c) = (caches.thumbs.clone(), caches.immich_thumbs.clone(), caches.immich_originals.clone());
    tauri::async_runtime::spawn_blocking(move || cache::Limits {
        thumbs: a.usage(), immich_thumbs: b.usage(), immich_originals: c.usage(),
    }).await.map_err(|e| e.to_string())
}

// empties one cache ("thumbs", "immichThumbs" or "immichOriginals"); an
// edited original stays
#[tauri::command]
async fn cache_clear(caches: State<'_, Caches>, which: String) -> Result<(), String> {
    let c = caches.by_name(&which).ok_or_else(|| format!("no cache {which}"))?.clone();
    tauri::async_runtime::spawn_blocking(move || c.clear()).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn meta(state: State<'_, AppState>, imgid: i64) -> Result<bindings::MetaReply, String> {
    let reply = state.engine("meta").request(json!({ "cmd": "meta", "imgid": imgid }))?;
    serde_json::from_value(reply).map_err(|e| format!("meta: unexpected reply: {e}"))
}

// the photos likely opened next, their raws decoded ahead in this order on
// the engine's own thread; the reply does not wait for them
#[tauri::command]
async fn prefetch(state: State<'_, AppState>, imgids: Vec<i64>) -> Result<Value, String> {
    state.engine("prefetch").request(json!({ "cmd": "prefetch", "imgids": imgids }))
}

// Preferences' darktable memory: the level the engine runs at, and the one
// its next start takes
#[tauri::command]
fn darktable_resources(state: State<'_, AppState>) -> Value {
    json!({ "running": *state.resource_level.lock().unwrap(), "next": engine::resource_level(&state.runtime) })
}

#[tauri::command]
fn darktable_resources_set(settings: State<'_, settings::Settings>, level: String) -> Result<(), String> {
    engine::set_resource_level(&settings, &level)
}

// Preferences' GPU edits: whether the engine runs with them, and whether
// its next start will
#[tauri::command]
fn gpu_edits(state: State<'_, AppState>) -> Value {
    json!({ "running": state.gpu_edits.load(Ordering::Relaxed), "next": engine::gpu_edits(&state.runtime) })
}

#[tauri::command]
fn gpu_edits_set(settings: State<'_, settings::Settings>, on: bool) -> Result<(), String> {
    engine::set_gpu_edits(&settings, on)
}

// the GPU execution providers this computer can use for AI, with their
// devices, for Preferences and the Export dialog's AI upscale
#[tauri::command]
async fn ai_accel(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.engine("ai_accel").request(json!({ "cmd": "ai_accel" }))?["providers"].clone())
}

// every keyword ever used, for the Keywording panel's suggestions
#[tauri::command]
async fn keywords(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.engine("keywords").request(json!({ "cmd": "keywords" }))?["keywords"].clone())
}

// keywords added to and removed from an image; its keywords afterwards
#[tauri::command]
async fn keywords_set(state: State<'_, AppState>, imgid: i64, add: Vec<String>, remove: Vec<String>)
    -> Result<Value, String> {
    let req = json!({ "cmd": "keywords_set", "imgid": imgid, "add": add, "remove": remove });
    Ok(state.engine("keywords_set").request(req)?["keywords"].clone())
}

// rating, rejected, labels and text fields; only the ones given are set
#[tauri::command]
#[specta::specta]
async fn meta_set(state: State<'_, AppState>, imgid: i64, fields: Map<String, Value>) -> Result<(), String> {
    let mut req = json!({ "cmd": "meta_set", "imgid": imgid });
    for (k, v) in fields {
        req[k] = v;
    }
    state.engine("meta_set").request(req).map(|_| ())
}

#[derive(Deserialize, serde::Serialize)]
struct CaptureTimeEntry {
    imgid: i64,
    before: String,
    after: String,
}

#[tauri::command]
async fn capture_times(state: State<'_, AppState>, entries: Vec<CaptureTimeEntry>) -> Result<Value, String> {
    state.engine("capture_times").request(json!({ "cmd": "capture_times", "entries": entries }))
}

#[derive(Deserialize)]
struct ExportItem {
    imgid: i64,
    // the file name without extension, already expanded from any template
    stem: String,
    // when it was taken (EXIF, "2026:10:08 14:03:22"), for Immich
    #[serde(default)]
    created: Option<String>,
    // what to do when the file is already there, when it was asked for
    // this image; otherwise the options' conflict
    #[serde(default)]
    conflict: Option<String>,
    // borders and text drawn around and over this image, its text already
    // expanded from its metadata: { borders: [...], texts: [...] } (engine)
    #[serde(default)]
    frame: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportOptions {
    dir: String,
    subfolder: Option<String>,
    format: String,
    quality: Option<i64>,
    bpp: Option<i64>,
    color_space: String,
    long_edge: Option<i64>,
    // "unique" adds -1, -2...; "overwrite"; "skip"
    conflict: String,
    // instead of the folder: uploaded to this Immich album
    #[serde(default)]
    immich_album: Option<String>,
    // AI upscaling, 2 or 4 times the width and height, on this GPU
    // provider and device (Preferences)
    #[serde(default)]
    upscale: Option<i64>,
    #[serde(default)]
    ai_provider: Option<String>,
    #[serde(default)]
    ai_device: Option<i64>,
    // false leaves GPS out of the file, as Lightroom's Remove Location Info
    #[serde(default)]
    location: Option<bool>,
    // the rest of the dialog's Metadata section: false leaves each out of
    // the file (the engine's export)
    #[serde(default)]
    camera: Option<bool>,
    #[serde(default)]
    serials: Option<bool>,
    #[serde(default)]
    description: Option<bool>,
    #[serde(default)]
    tags: Option<bool>,
    #[serde(default)]
    history: Option<bool>,
    // added to each exported file's keywords, and with keywords_on_original
    // to the original photo's as well
    #[serde(default)]
    keywords: Option<Vec<String>>,
    #[serde(default)]
    keywords_on_original: Option<bool>,
}

fn extension(format: &str) -> &str {
    match format {
        "jpeg" => "jpg",
        "tiff" => "tif",
        other => other,
    }
}

// where a folder export writes, and each image's file name
fn export_dir(dir: &str, subfolder: Option<&str>) -> PathBuf {
    let mut d = PathBuf::from(dir);
    if let Some(sub) = subfolder.filter(|s| !s.trim().is_empty()) {
        d.push(sub.trim());
    }
    d
}

fn export_stem(item: &ExportItem) -> String {
    match item.stem.trim() {
        "" => format!("image-{}", item.imgid),
        s => s.to_string(),
    }
}

// each image's file in a folder export, and whether it is already there,
// so that the dialog can ask what to do before exporting
#[tauri::command]
fn export_existing(items: Vec<ExportItem>, dir: String, subfolder: Option<String>, format: String) -> Vec<Value> {
    let dir = export_dir(&dir, subfolder.as_deref());
    let ext = extension(&format);
    items.iter().map(|item| {
        let path = dir.join(format!("{}.{ext}", export_stem(item)));
        json!({ "path": path, "exists": path.exists() })
    }).collect()
}

// the target for one image, or None when an existing file is to be left alone
fn export_target(dir: &Path, stem: &str, ext: &str, conflict: &str) -> Option<PathBuf> {
    let first = dir.join(format!("{stem}.{ext}"));
    if !first.exists() || conflict == "overwrite" {
        return Some(first);
    }
    if conflict == "skip" {
        return None;
    }
    (1..).map(|n| dir.join(format!("{stem}-{n}.{ext}"))).find(|p| !p.exists())
}

// export images one at a time on the engine's export thread (main.c,
// _export_run), without engine(), so the photo is edited meanwhile. each
// renders its edit as it was when the export was asked for, which the
// engine holds for `job` (export_hold). progress goes to the window as
// "export-progress"; export_cancel stops before the next image
#[tauri::command]
async fn export_images(
    app: AppHandle,
    state: State<'_, AppState>,
    job: u64,
    items: Vec<ExportItem>,
    options: ExportOptions,
) -> Result<Value, String> {
    // to Immich: rendered into a folder of the cache, each file uploaded and
    // deleted, then the lot added to the album
    let immich = match &options.immich_album {
        Some(_) => {
            let conn = tauri_plugin_immporter::immich_connection(&app)
                .ok_or("Immich is not set up: add its URL and API key in Preferences")?;
            let c = tauri::async_runtime::spawn_blocking(move || immich_upload::Immich::new(&conn))
                .await.map_err(|e| e.to_string())??;
            Some(std::sync::Arc::new(c))
        }
        None => None,
    };
    let dir = match &immich {
        Some(_) => app.path().app_cache_dir().map_err(|e| e.to_string())?.join("immich-export"),
        None => export_dir(&options.dir, options.subfolder.as_deref()),
    };
    if immich.is_some() {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let conflict = if immich.is_some() { "unique" } else { options.conflict.as_str() };
    let ext = extension(&options.format);
    let (mut written, mut skipped, mut failed) = (vec![], vec![], vec![]);
    let (mut uploaded, mut duplicates, mut ids) = (0, 0, Vec::<String>::new());
    let total = items.len();
    let keywords = options.keywords.clone().unwrap_or_default();
    let tag_original = options.keywords_on_original.unwrap_or(false) && !keywords.is_empty();
    let tagged = state.tagged.clone();
    let held = tagged.tag();
    let imgids: Vec<i64> = items.iter().map(|i| i.imgid).collect();
    state.engine("export_images").request(json!({ "cmd": "export_hold", "job": held, "imgids": imgids }))?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.export_cancels.lock().unwrap().insert(job, cancel.clone());
    // removed on every exit, including an early return, a panic or a dropped future
    let _registered = CancelEntry { map: &state.export_cancels, job };
    let mut cancelled = false;
    for (n, item) in items.iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let stem = export_stem(item);
        let conflict = match (&immich, item.conflict.as_deref()) {
            (None, Some(c)) => c,
            _ => conflict,
        };
        match export_target(&dir, &stem, ext, conflict) {
            None => skipped.push(json!(dir.join(format!("{stem}.{ext}")))),
            Some(target) => {
                let mut req = json!({
                    "cmd": "export", "job": held, "imgid": item.imgid, "out": target, "format": options.format,
                    "color_space": options.color_space,
                });
                if let Some(q) = options.quality { req["quality"] = json!(q); }
                if let Some(b) = options.bpp { req["bpp"] = json!(b); }
                if let Some(l) = options.long_edge { req["long_edge"] = json!(l); }
                if let Some(f) = &item.frame { req["frame"] = f.clone(); }
                for (key, v) in [("location", options.location), ("camera", options.camera), ("serials", options.serials),
                                 ("description", options.description), ("tags", options.tags),
                                 ("history", options.history)] {
                    if let Some(v) = v { req[key] = json!(v); }
                }
                if let Some(u) = options.upscale { req["upscale"] = json!(u); }
                if let Some(p) = &options.ai_provider { req["ai_provider"] = json!(p); }
                if let Some(d) = options.ai_device { req["ai_device"] = json!(d); }
                if !keywords.is_empty() { req["keywords"] = json!(keywords); }
                let t = tagged.clone();
                let tag = t.tag();
                let result = tauri::async_runtime::spawn_blocking(move || t.request(tag, req))
                    .await.map_err(|e| e.to_string()).and_then(|r| r);
                if result.is_ok() && tag_original {
                    let req = json!({ "cmd": "keywords_set", "imgid": item.imgid, "add": keywords, "remove": [] });
                    if let Err(e) = state.engine("export_images").request(req) {
                        failed.push(json!({ "file": target,
                                            "error": format!("exported, but the keywords were not added to the original: {e}") }));
                    }
                }
                match (result, &immich) {
                    (Ok(_), None) => written.push(json!(target)),
                    (Ok(_), Some(c)) => {
                        let (c, file) = (c.clone(), target.clone());
                        let created = immich_upload::iso_time(item.created.as_deref());
                        let up = tauri::async_runtime::spawn_blocking(move || c.upload(&file, &created))
                            .await.map_err(|e| e.to_string()).and_then(|r| r);
                        let _ = std::fs::remove_file(&target);
                        match up {
                            Ok((id, dup)) => {
                                if dup { duplicates += 1 } else { uploaded += 1 }
                                ids.push(id);
                            }
                            Err(e) => failed.push(json!({ "file": target, "error": e })),
                        }
                    }
                    (Err(e), _) => failed.push(json!({ "file": target, "error": e })),
                }
            }
        }
        let _ = app.emit("export-progress", json!({ "job": job, "done": n + 1, "total": total }));
    }
    // the photos not reached, and their snapshots; after the last export,
    // on the same thread
    drop(_registered);
    let t = tagged.clone();
    let tag = t.tag();
    let _ = tauri::async_runtime::spawn_blocking(move || t.request(tag, json!({ "cmd": "export_release", "job": held })))
        .await;
    if let (Some(c), Some(album)) = (immich, options.immich_album.clone()) {
        let _ = std::fs::remove_dir(&dir);
        let added = tauri::async_runtime::spawn_blocking(move || c.add_to_album(&album, &ids))
            .await.map_err(|e| e.to_string()).and_then(|r| r);
        if let Err(e) = added {
            failed.push(json!({ "file": "", "error": e }));
        }
        return Ok(json!({ "written": [], "skipped": skipped, "failed": failed, "uploaded": uploaded,
                          "duplicates": duplicates, "album": options.immich_album, "cancelled": cancelled }));
    }
    Ok(json!({ "written": written, "skipped": skipped, "failed": failed, "dir": dir, "cancelled": cancelled }))
}

// removes an export job's cancel flag when it goes out of scope
struct CancelEntry<'a> {
    map: &'a Mutex<HashMap<u64, Arc<AtomicBool>>>,
    job: u64,
}

impl Drop for CancelEntry<'_> {
    fn drop(&mut self) {
        // a poisoned lock still holds a usable map
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.job);
    }
}

// stops export_images' `job` before its next image
#[tauri::command]
fn export_cancel(state: State<'_, AppState>, job: u64) {
    if let Some(c) = state.export_cancels.lock().unwrap().get(&job) {
        c.store(true, Ordering::SeqCst);
    }
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
async fn immich_albums(app: AppHandle) -> Result<Value, String> {
    immich_call(&app, |c| c.albums()).await
}

#[tauri::command]
async fn immich_create_album(app: AppHandle, name: String) -> Result<Value, String> {
    immich_call(&app, move |c| c.create_album(name.trim())).await
}

// the permissions an export needs that the key lacks
#[tauri::command]
async fn immich_export_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.missing_permissions()).await
}

// the Library panel's Immich card (immich_search.rs)
// the permissions its search, thumbnails and downloads need that the key lacks
#[tauri::command]
async fn immich_browse_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.lacks(immich_upload::BROWSE_PERMISSIONS)).await
}

#[tauri::command]
async fn immich_search(app: AppHandle, args: immich_search::SearchArgs, map: Option<immich_search::PathMap>)
    -> Result<Value, String> {
    immich_call(&app, move |c| c.search(&args, &map.unwrap_or_default())).await
}

#[tauri::command]
async fn immich_libraries(app: AppHandle) -> Result<Value, String> {
    immich_call(&app, |c| c.libraries()).await
}

#[tauri::command]
async fn immich_suggestions(app: AppHandle, kind: String, within: Option<Map<String, Value>>) -> Result<Value, String> {
    immich_call(&app, move |c| c.suggestions(&kind, &within.unwrap_or_default())).await
}

#[tauri::command]
async fn immich_people(app: AppHandle) -> Result<Value, String> {
    immich_call(&app, |c| c.people()).await
}

#[tauri::command]
async fn immich_tags(app: AppHandle) -> Result<Value, String> {
    immich_call(&app, |c| c.tags()).await
}

// Immich's thumbnail as its encoded image (WebP or JPEG); asking again
// does not go to the server while the cache keeps it
#[tauri::command]
async fn immich_thumb(app: AppHandle, caches: State<'_, Caches>, id: String) -> Result<Response, String> {
    immich_search::safe_id(&id)?;
    let cache = caches.immich_thumbs.clone();
    let name = id.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || cache.read(&name)).await.map_err(|e| e.to_string())?;
    if let Some(b) = hit {
        return Ok(Response::new(b));
    }
    let cache = caches.immich_thumbs.clone();
    immich_call(&app, move |c| {
        let bytes = c.thumb(&id)?;
        let _ = cache.write(&id, &bytes);
        Ok(bytes)
    }).await.map(Response::new)
}

// a file to open for an Immich asset: the external library's own file when
// this computer has it, else the original downloaded into the cache
#[tauri::command]
async fn immich_resolve(app: AppHandle, id: String, name: String, path: String,
                        map: Option<immich_search::PathMap>) -> Result<Value, String> {
    if let Some(p) = immich_search::local_path(&path, &map.unwrap_or_default()) {
        return Ok(json!({ "path": p, "downloaded": false }));
    }
    let cache = app.state::<Caches>().immich_originals.clone();
    let p = immich_call(&app, move |c| {
        let (p, fresh) = c.original(&id, &name, cache.dir())?;
        if fresh { cache.added(&id) } else { cache.touch(&id) }
        Ok(p)
    }).await?;
    Ok(json!({ "path": p, "downloaded": true }))
}

// the reply says whether the photo now reads as edited (darktable's history hash)
#[tauri::command]
async fn save(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("save").request(json!({ "cmd": "save" }))
}

// Native history snapshots owned by the frontend's batch undo entries.
#[tauri::command]
async fn paste_batch(state: State<'_, AppState>, action: String, token: Option<u64>, imgids: Option<Vec<i64>>) -> Result<Value, String> {
    state.engine("paste_batch").request(json!({ "cmd": "paste_batch", "action": action,
        "token": token.unwrap_or(0), "imgids": imgids.unwrap_or_default() }))
}

// the user's first change to a new photo: the defaults applied so far become
// its unedited baseline
#[tauri::command]
async fn baseline_end(state: State<'_, AppState>) -> Result<(), String> {
    state.engine("baseline_end").request(json!({ "cmd": "baseline_end" })).map(|_| ())
}

// whether the engine holds the Before view's settings, which it must not
// save on quitting
#[tauri::command]
async fn before_view(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.engine("before_view").request(json!({ "cmd": "before", "on": on })).map(|_| ())
}

// the darktable styles shipped as looks: "<pack> - <group>_<name>.dtstyle",
// then the user's own, by the name the engine shows them under
fn list_looks(state: &AppState) -> Result<Vec<Value>, String> {
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
            looks.push(json!({ "name": name, "group": group, "path": path }));
        }
    }
    looks.sort_by_key(|l| (l["group"].to_string(), l["name"].to_string()));
    let Ok(files) = std::fs::read_dir(&state.user_looks_dir) else { return Ok(looks) };
    for file in files.flatten() {
        let path = file.path();
        if path.extension().and_then(|e| e.to_str()) != Some("dtstyle") {
            continue;
        }
        let Some(name) = std::fs::read_to_string(&path).ok().as_deref().and_then(style_name) else { continue };
        looks.push(json!({ "name": style_label(&name), "group": "My Looks", "path": path, "user": true }));
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
async fn looks_list(state: State<'_, AppState>) -> Result<Value, String> {
    list_looks(&state).map(Value::from)
}

// the file dialogs of the commands below are opened here, so a path the
// page names is never read or written; none when the dialog is cancelled
async fn pick_files(app: &AppHandle, title: &str, exts: &[&str], multiple: bool) -> Result<Vec<PathBuf>, String> {
    let handle = app.clone();
    let (title, exts) = (title.to_string(), exts.iter().map(|e| e.to_string()).collect::<Vec<_>>());
    tauri::async_runtime::spawn_blocking(move || {
        let exts: Vec<&str> = exts.iter().map(String::as_str).collect();
        let dialog = handle.dialog().file().add_filter(title, &exts);
        let picked = if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        picked.into_iter().filter_map(|f| f.into_path().ok()).collect()
    })
    .await
    .map_err(|e| e.to_string())
}

async fn pick_save(app: &AppHandle, title: &str, exts: &[&str], name: &str) -> Result<Option<PathBuf>, String> {
    let handle = app.clone();
    let (title, name) = (title.to_string(), safe_file_name(name));
    let exts = exts.iter().map(|e| e.to_string()).collect::<Vec<_>>();
    tauri::async_runtime::spawn_blocking(move || {
        let exts: Vec<&str> = exts.iter().map(String::as_str).collect();
        handle.dialog().file().add_filter(title, &exts).set_file_name(name)
            .blocking_save_file().and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())
}

// a name the page suggests for a save dialog, with path separators and the
// characters Windows refuses taken out
fn safe_file_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
    cleaned.trim_matches(['.', ' ']).to_string()
}

// the canonical form of `path` when it lies inside one of `dirs`, which are
// compared canonical too, component by component, so a sibling sharing a
// prefix, `..` and a link out of the folder do not pass
fn path_inside(path: &Path, dirs: &[&Path]) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let inside = dirs.iter().filter_map(|d| std::fs::canonicalize(d).ok()).any(|d| real.starts_with(d));
    if inside { Ok(real) } else { Err("this is not one of the looks".into()) }
}

// look files the user picked, each added to the user's looks, and presets
// files they picked beside them; the page gets the presets' documents (it
// stores them), the number of looks added and what failed
#[tauri::command]
async fn shared_import(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let picked = pick_files(&app, "Presets and looks", &["json", "dtstyle"], true).await?;
    let (mut presets, mut looks, mut failed) = (Vec::new(), 0, Vec::new());
    for path in picked {
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_look = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dtstyle"));
        let done = if is_look {
            import_look(&state, &path).map(|_| looks += 1)
        } else {
            read_preset_file(&path).map(|v| presets.push(v))
        };
        if let Err(e) = done { failed.push(format!("{name}: {e}")) }
    }
    Ok(json!({ "presets": presets, "looks": looks, "failed": failed }))
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
        .iter().filter_map(|l| l["name"].as_str().map(str::to_owned)).collect();
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
async fn look_delete(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let path = path_inside(Path::new(&path), &[&state.user_looks_dir])
        .map_err(|_| "only an imported look can be deleted".to_string())?;
    std::fs::remove_file(&path).map_err(|e| format!("looks: {e}"))
}

// apply a look to the open image, or with no path take it off; returns the
// look in use
#[tauri::command]
async fn look_apply(state: State<'_, AppState>, path: Option<String>) -> Result<Value, String> {
    let path = match path {
        Some(p) => Some(path_inside(Path::new(&p), &[&state.looks_dir, &state.user_looks_dir])?),
        None => None,
    };
    let reply = state.engine("look_apply").request(json!({ "cmd": "look", "path": path }))?;
    Ok(reply["look"].clone())
}

// how strongly the look applies, 0-100
#[tauri::command]
async fn look_amount(state: State<'_, AppState>, amount: f64) -> Result<(), String> {
    state.engine("look_amount").request(json!({ "cmd": "look_amount", "amount": amount })).map(|_| ())
}

// a small render of the open image with edits and, if `with_look`, `look`
// (a path, or none) on top, leaving the edit as it is: u32 width and
// height, then RGBA
#[tauri::command]
async fn preview(
    state: State<'_, AppState>,
    size: u32,
    edits: Value,
    with_look: bool,
    look: Option<String>,
) -> Result<Response, String> {
    let mut req = json!({ "cmd": "preview", "size": size, "edits": edits, "rgba": state.preview_path });
    if with_look {
        req["look"] = json!(look);
    }
    let mut engine = state.engine("preview");
    let reply = engine.request(req)?;
    let pixels = frame_output::FrameOutput::read(&state.preview_path).map_err(|e| format!("preview: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + pixels.len());
    for k in ["width", "height"] {
        out.extend_from_slice(&(reply[k].as_u64().unwrap_or(0) as u32).to_le_bytes());
    }
    out.extend_from_slice(&pixels);
    Ok(Response::new(out))
}

// the Export dialog's preview: one image exported as the dialog would, as
// a small JPEG into the runtime folder, its bytes handed back. `long_edge`
// is the export's own, capped so the preview stays quick; the frame's pixel
// sizes follow it, so the preview is a scaled copy of the export
#[tauri::command]
async fn export_preview(
    state: State<'_, AppState>,
    item: ExportItem,
    options: ExportOptions,
    cap: i64,
) -> Result<Response, String> {
    let out = state._frame_output.path("export-preview.jpg");
    let mut req = json!({
        "cmd": "export", "imgid": item.imgid, "out": out, "format": "jpeg", "quality": 85,
        "color_space": "srgb", "long_edge": options.long_edge.map_or(cap, |l| l.min(cap)),
        "px_long_edge": options.long_edge.unwrap_or(0), "draft": true, "transient": true,
    });
    if let Some(f) = &item.frame { req["frame"] = f.clone(); }
    let mut engine = state.engine("export_preview");
    let result = engine.request(req).and_then(|_| {
        frame_output::FrameOutput::read(&out).map(Response::new).map_err(|e| format!("preview: {e}"))
    });
    state._frame_output.remove(&out);
    result
}

// the installed font families and their faces, as the engine draws them
#[tauri::command]
async fn fonts(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("fonts").request(json!({ "cmd": "fonts" })).map(|r| r["families"].clone())
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
async fn print_profiles(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("print_profiles").request(json!({ "cmd": "print_profiles" })).map(|r| r["profiles"].clone())
}

// a printer profile the user picks in the dialog opened here, copied among
// the engine's own; null when it is cancelled
#[tauri::command]
async fn print_profile_add(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let picked = pick_files(&app, "ICC profile", &["icc", "icm", "ICC", "ICM"], false).await?;
    let Some(path) = picked.first() else { return Ok(Value::Null) };
    state.engine("print_profile_add").request(json!({ "cmd": "print_profile_add", "path": path })).map(without_ok)
}

// `mode` "off", "proof" or "gamut"; replies whether the view changed, and
// the front end renders again if so
#[tauri::command]
async fn softproof(state: State<'_, AppState>, mode: String, profile: Option<String>, intent: Option<i64>)
    -> Result<bool, String> {
    let reply = state.engine("softproof").request(json!({
        "cmd": "softproof", "mode": mode, "profile": profile.unwrap_or_default(), "intent": intent.unwrap_or(0),
    }))?;
    Ok(reply["changed"].as_bool().unwrap_or(false))
}

// { available, printers: [{ name, description, default }] }
#[tauri::command]
async fn printers(state: State<'_, AppState>) -> Result<Value, String> {
    state.engine("printers").request(json!({ "cmd": "printers" })).map(without_ok)
}

#[tauri::command]
async fn printer_info(state: State<'_, AppState>, name: String) -> Result<Value, String> {
    state.engine("printer_info").request(json!({ "cmd": "printer", "name": name })).map(without_ok)
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

// renders the photo as its edit is now and prints it, or, given `pdf_name`,
// writes a PDF where the user picks (null when they cancel), on the export
// thread as an export does (export_images), so editing goes on
#[tauri::command]
async fn print_photo(app: AppHandle, state: State<'_, AppState>, imgid: i64, request: Value,
                     pdf_name: Option<String>) -> Result<Value, String> {
    let mut req = without_pdf(request);
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(Value::Null),
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
    result.map(without_ok).map(|r| with_pdf(r, pdf.as_deref()))
}

// a sheet of photos, each as its edit is now (print_photo's way): the Cells
// layout's pages of boxes and labels are in `request`, `imgids` the photos
// they hold, which the engine takes a snapshot of as each page reaches it.
// `pdf_name` is print_photo's: the PDF goes where the user picks, null when
// they cancel
#[tauri::command]
async fn print_sheet(app: AppHandle, state: State<'_, AppState>, job: u64, imgids: Vec<i64>, request: Value,
                     pdf_name: Option<String>) -> Result<Value, String> {
    let mut req = without_pdf(request);
    let pdf = match pick_pdf(&app, pdf_name.as_deref()).await? {
        Some(None) => return Ok(Value::Null),
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
    result.map(without_ok).map(|r| with_pdf(r, pdf.as_deref()))
}

// the Export dialog's presets, a document the front end shapes; none yet is
// null
#[tauri::command]
async fn export_presets_load(state: State<'_, AppState>) -> Result<Value, String> {
    let path = state.presets_path.with_file_name("export-presets.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("export presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("export presets: {e}")),
    }
}

#[tauri::command]
async fn export_presets_save(state: State<'_, AppState>, presets: Value) -> Result<(), String> {
    let path = state.presets_path.with_file_name("export-presets.json");
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("export presets: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("export presets: {e}"))
}

// the AgX presets in darktable's own `data.db` in the config folder,
// converted by the engine to the current version: { presets: [{ name, params }] }
#[tauri::command]
async fn agx_presets(state: State<'_, AppState>, fields: Vec<String>) -> Result<Value, String> {
    state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "fields": fields }))
}

// the same from a `.dtpreset` or `.dtstyle` the user picks in the dialog
// opened here; null when it is cancelled
#[tauri::command]
async fn agx_presets_pick(app: AppHandle, state: State<'_, AppState>, fields: Vec<String>) -> Result<Value, String> {
    let picked = pick_files(&app, "darktable preset or style", &["dtpreset", "dtstyle"], false).await?;
    let Some(file) = picked.first() else { return Ok(Value::Null) };
    state.engine("agx_presets").request(json!({ "cmd": "agx_presets", "file": file, "fields": fields }))
}

// the AgX presets the user loaded into the Profile menu, a document the
// front end shapes; none yet is an empty list
#[tauri::command]
async fn agx_profiles_load(state: State<'_, AppState>) -> Result<Value, String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("AgX presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!([])),
        Err(e) => Err(format!("AgX presets: {e}")),
    }
}

#[tauri::command]
async fn agx_profiles_save(state: State<'_, AppState>, profiles: Value) -> Result<(), String> {
    let path = state.presets_path.with_file_name("agx-profiles.json");
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&profiles).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("AgX presets: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("AgX presets: {e}"))
}

// presets shared as a file: written where the save dialog opened here
// asks (false when it is cancelled), and read back from a file its open
// dialog picks (null when it is cancelled). a preset file is small, so
// anything larger is not one
#[tauri::command]
async fn export_presets_export(app: AppHandle, contents: Value, name: String, label: String) -> Result<bool, String> {
    let Some(path) = pick_save(&app, &label, &["json"], &format!("{name}.json")).await? else { return Ok(false) };
    write_preset_file(&path, &contents).map(|_| true)
}

#[tauri::command]
async fn export_presets_import(app: AppHandle, label: String) -> Result<Option<Value>, String> {
    let picked = pick_files(&app, &label, &["json"], false).await?;
    picked.first().map(|p| read_preset_file(p)).transpose()
}

fn write_preset_file(path: &Path, contents: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(contents).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("{}: {e}", path.display()))
}

fn read_preset_file(path: &Path) -> Result<Value, String> {
    let shown = path.display();
    let size = std::fs::metadata(path).map_err(|e| format!("{shown}: {e}"))?.len();
    if size > 1 << 20 {
        return Err("this file is too large to be a preset".into());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{shown}: {e}"))?;
    serde_json::from_str(&text).map_err(|_| "this file is not a preset".into())
}

// the user's presets, as the front end shapes them; none yet is an empty list
#[tauri::command]
async fn presets_load(state: State<'_, AppState>) -> Result<Value, String> {
    match std::fs::read_to_string(&state.presets_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!([])),
        Err(e) => Err(format!("presets: {e}")),
    }
}

// written beside and renamed over, so a crash never leaves half a file
#[tauri::command]
async fn presets_save(state: State<'_, AppState>, presets: Value) -> Result<(), String> {
    let tmp = state.presets_path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("presets: {e}"))?;
    std::fs::rename(&tmp, &state.presets_path).map_err(|e| format!("presets: {e}"))
}

// a photo or folder handed to the app from outside, waiting for the window
// to take it: a path on the command line (`Immage /path/photo.arw`,
// `Immage /path/folder`), or on macOS one sent by `open -a Immage ...` or
// Finder, which also reaches an app that is already running
#[derive(Default)]
struct Launch(Mutex<Option<String>>);

fn launch_path(arg: &Path) -> Option<String> {
    let p = std::fs::canonicalize(arg).ok()?;
    (p.is_file() || p.is_dir()).then(|| p.to_string_lossy().into_owned())
}

// the sample photo (app/sample, CC0) copied into a "Sample Photos" folder in
// the app's data, where edits can be saved beside it; made once, then left
// as the user has it. its path
#[tauri::command]
fn sample_folder(app: AppHandle) -> Result<String, String> {
    let src = if cfg!(debug_assertions) {
        repo_root().join("app/sample")
    } else {
        app.path().resource_dir().map_err(|e| e.to_string())?.join("sample")
    };
    let dest = app.path().app_data_dir().map_err(|e| e.to_string())?.join("Sample Photos");
    if !dest.exists() {
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(&src).map_err(|e| format!("{}: {e}", src.display()))?.flatten() {
            if entry.path().is_file() {
                std::fs::copy(entry.path(), dest.join(entry.file_name())).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(dest.to_string_lossy().into_owned())
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
fn licenses(app: AppHandle) -> Result<Value, String> {
    let (gpl, libs, notices) = if cfg!(debug_assertions) {
        let res = repo_root().join("app/src-tauri/resources");
        (repo_root().join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    } else {
        let res = app.path().resource_dir().map_err(|e| e.to_string())?;
        (res.join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    };
    let index = libs.join("INDEX.txt");
    Ok(json!({
        "gpl": std::fs::read_to_string(&gpl).ok(),
        "libraries": std::fs::read_to_string(&index).ok(),
        "librariesPath": index.exists().then(|| index.to_string_lossy().into_owned()),
        "notices": std::fs::read_to_string(&notices).ok(),
    }))
}

// before an update is installed: the installer replaces the engine's files,
// which Windows will not do while they are in use
#[tauri::command]
async fn engine_quit(state: State<'_, AppState>) -> Result<(), String> {
    state.engine("engine_quit").quit();
    Ok(())
}

// the user's restart of an engine that is not answering: kills it without
// the engine lock, which its request holds. the request fails with the exit
// error and the supervisor starts another (engine-state down, then ready)
#[tauri::command]
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

#[tauri::command]
fn launch_file(launch: State<'_, Launch>) -> Option<String> {
    launch.0.lock().unwrap().take()
}

// the menu spec lives in app/src/menu.ts so the drawn Windows/Linux menu and
// this native one list the same items; Windows and Linux draw it in the title
// bar strip, as a native row there would take extra height
#[derive(Deserialize)]
struct NativeMenu {
    label: String,
    items: Vec<NativeItem>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum NativeItem {
    Item { id: String, label: String, accel: Option<String> },
    Separator,
    Submenu { label: String, items: Vec<NativeItem> },
    Predefined { role: NativeRole },
}

#[derive(Deserialize)]
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
        .invoke_handler(bindings::handler(tauri::generate_handler![
            map_search::map_search, map_search::map_search_key_status, map_search::map_search_key_save, map_search::map_search_key_remove, open_folder, open_image, get_params, set_params, render, cancel_base, save, baseline_end, before_view, thumb, thumb_cached, thumb_known, cache_limits, cache_usage, cache_clear, capture_times, prefetch, darktable_resources, darktable_resources_set, memory_budget::memory_budget, gpu_edits, gpu_edits_set, webview_renderer, webview_renderer_set,
            export_images, export_cancel, export_existing, export_preview, fonts, print_profiles, print_profile_add, softproof, printers, printer_info, print_photo, print_sheet, export_presets_load, export_presets_save, export_presets_export, export_presets_import, presets_load, presets_save, agx_presets, agx_presets_pick, agx_profiles_load, agx_profiles_save, looks_list, shared_import, look_export, look_delete, look_apply, look_amount, preview, paste_batch,
            mask_shapes, combine, masks, mask_delete, mask_rename, history, module_state, sample, tone_key, lenses, color_profiles, agx_auto, upright, range_map, zones, mask_map, ai_object,
            ai_model_ensure, ai_model_reinstall, ai_mask, ai_depth, ai_denoise, ai_denoise_preview, positive_export, spektra_stocks, spektra_fetch, list_subfolders, folder_volumes, spots, spots_enable, spot_source, sample_folder, immich_albums, immich_create_album,
            immich_export_check, immich_search, immich_browse_check, immich_libraries, immich_suggestions, immich_people, immich_tags,
            immich_thumb, immich_resolve, launch_file, path_exists, display_scale, trash_files, create_virtual_copy, remove_virtual_copy, hdr_merge, hdr_can_align, pano_merge, pano_preview, pano_can_merge, merge_cancel, preview_fullscreen, licenses, engine_quit, engine_restart, keywords, keywords_set, ai_accel,
            menu_set, csp_violation, perf_set, perf_trace_start, perf_trace_stop, perf_modules, perf_report_write, perf_machine, perf_ping, support_bundle::support_bundle_preview, support_bundle::support_bundle_add_benchmark, support_bundle::support_bundle_save, support_bundle::support_bundle_discard, backup::backup_components, backup::backup_pick_save, backup::backup_pick_open, backup::backup_create, backup::backup_inspect, backup::backup_restore, gpu_check_parity, resources::perf_resources_start, resources::perf_resources_stop,
            plugins::plugin_find_apps, plugins::plugin_config, plugins::plugin_config_save, plugins::plugin_set_app, plugins::plugin_choose_app, plugins::plugin_launch, plugins::plugin_watch, plugins::plugin_cancel, plugins::plugin_job,
            plugins::plugin_returns, plugins::plugin_return_applied
        ]))
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
    fn export_extensions_follow_the_format() {
        assert_eq!(extension("jxl"), "jxl");
        assert_eq!(extension("jpeg"), "jpg");
        assert_eq!(extension("tiff"), "tif");
    }

    #[test]
    fn cancel_entry_removes_on_drop_and_unwind() {
        let map = Mutex::new(HashMap::new());
        map.lock().unwrap().insert(7, Arc::new(AtomicBool::new(false)));
        drop(CancelEntry { map: &map, job: 7 });
        assert!(map.lock().unwrap().is_empty());
        map.lock().unwrap().insert(8, Arc::new(AtomicBool::new(false)));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = CancelEntry { map: &map, job: 8 };
            panic!("boom");
        }));
        assert!(r.is_err() && map.lock().unwrap().is_empty());
    }

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
    fn folder_progress_once_a_second() {
        let mut p = Progress::default();
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        // the first batch at once, then batches held until a second has gone
        assert_eq!(p.add(vec![json!(1)], t, false), Some(vec![json!(1)]));
        assert_eq!(p.add(vec![json!(2)], ms(150), false), None);
        assert_eq!(p.add(vec![json!(3)], ms(300), false), None);
        assert_eq!(p.add(vec![json!(4)], ms(1000), false), Some(vec![json!(2), json!(3), json!(4)]));
        // the last batch whenever it comes, with those held
        assert_eq!(p.add(vec![json!(5)], ms(1100), false), None);
        assert_eq!(p.add(vec![json!(6)], ms(1200), true), Some(vec![json!(5), json!(6)]));
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
    fn folder_files_order_and_skips() {
        let dir = repo_root().join(format!("build/scratch/folder-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in ["b.jpg", "A.CR3", "a.cr3.xmp", ".hidden/x.jpg", "sub/c.jpg", "Photos Library.photoslibrary/d.jpg"] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "").unwrap();
        }
        // a link to a folder is listed as one, though the listing calls it a link
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("sub"), dir.join("link")).unwrap();
        let mut got = Vec::new();
        folder_files(&dir, true, &HashSet::new(), &mut got, &mut cache::Listed::default());
        let names: Vec<String> = got.iter().map(|p| p.strip_prefix(&dir).unwrap().to_string_lossy().into_owned()).collect();
        let _ = std::fs::remove_dir_all(&dir);
        // Files in the current folder come first. Then folders are traversed
        // in case-insensitive name order (link, Photos Library, sub).
        let mut want = vec!["A.CR3", "b.jpg"];
        if cfg!(unix) {
            want.push("link/c.jpg");
        }
        if !cfg!(target_os = "macos") {
            want.push("Photos Library.photoslibrary/d.jpg");
        }
        want.push("sub/c.jpg");
        assert_eq!(names, want);
    }

    #[test]
    fn snapshot_without_imgids() {
        let runtime = repo_root().join(format!("build/scratch/snapshot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&runtime);
        let path = snapshot_path(&runtime, "/photos", false, &["/photos/b".into(), "/photos/a".into()]);
        // what changes the folder's photos names another snapshot; skip's order does not
        assert_eq!(path, snapshot_path(&runtime, "/photos", false, &["/photos/a".into(), "/photos/b".into()]));
        assert_ne!(path, snapshot_path(&runtime, "/photos", true, &["/photos/a".into(), "/photos/b".into()]));
        assert_eq!(read_snapshot(&path), None);
        write_snapshot(&path, &[json!({ "imgid": 7, "path": "/photos/x.jpg", "rating": 3 })]);
        let got = read_snapshot(&path);
        let _ = std::fs::remove_dir_all(&runtime);
        assert_eq!(got, Some(json!([{ "path": "/photos/x.jpg", "rating": 3 }])));
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
    fn path_inside_accepts_only_the_folder() {
        let root = scratch("inside");
        let looks = root.join("looks");
        std::fs::create_dir_all(looks.join("pack")).unwrap();
        std::fs::create_dir_all(root.join("looksX")).unwrap();
        std::fs::write(looks.join("pack/a.dtstyle"), "x").unwrap();
        std::fs::write(root.join("looksX/b.dtstyle"), "x").unwrap();
        std::fs::write(root.join("c.dtstyle"), "x").unwrap();
        let dirs = [looks.as_path()];
        assert!(path_inside(&looks.join("pack/a.dtstyle"), &dirs).is_ok());
        // a sibling that shares the folder name as a prefix
        assert!(path_inside(&root.join("looksX/b.dtstyle"), &dirs).is_err());
        assert!(path_inside(&root.join("c.dtstyle"), &dirs).is_err());
        // `..` out of the folder
        assert!(path_inside(&looks.join("../c.dtstyle"), &dirs).is_err());
        // nothing there
        assert!(path_inside(&looks.join("missing.dtstyle"), &dirs).is_err());
        // a folder that is missing allows nothing
        assert!(path_inside(&root.join("c.dtstyle"), &[root.join("nope").as_path()]).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn path_inside_refuses_a_link_out() {
        let root = scratch("link");
        let looks = root.join("looks");
        std::fs::create_dir_all(&looks).unwrap();
        std::fs::write(root.join("secret"), "x").unwrap();
        std::os::unix::fs::symlink(root.join("secret"), looks.join("l.dtstyle")).unwrap();
        std::os::unix::fs::symlink(&root, looks.join("up")).unwrap();
        assert!(path_inside(&looks.join("l.dtstyle"), &[looks.as_path()]).is_err());
        assert!(path_inside(&looks.join("up/secret"), &[looks.as_path()]).is_err());
        // the folder itself may be reached through a link
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&looks, &alias).unwrap();
        std::fs::write(looks.join("ok.dtstyle"), "x").unwrap();
        assert!(path_inside(&alias.join("ok.dtstyle"), &[looks.as_path()]).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn preset_files_round_trip_and_refuse_bad_input() {
        let dir = scratch("preset");
        let file = dir.join("p.json");
        write_preset_file(&file, &json!({ "presets": [1, 2] })).unwrap();
        assert_eq!(read_preset_file(&file).unwrap(), json!({ "presets": [1, 2] }));
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(read_preset_file(&file).unwrap_err(), "this file is not a preset");
        std::fs::write(&file, vec![b' '; (1 << 20) + 1]).unwrap();
        assert!(read_preset_file(&file).unwrap_err().contains("too large"));
        assert!(read_preset_file(&dir.join("missing.json")).is_err());
        assert!(write_preset_file(&dir.join("no/such/dir.json"), &json!({})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn suggested_save_names_lose_separators() {
        assert_eq!(safe_file_name("a/b\\c:d"), "a_b_c_d");
        assert_eq!(safe_file_name(" ..x.json"), "x.json");
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
