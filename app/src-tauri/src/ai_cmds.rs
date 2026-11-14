// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Number, Value};
use std::path::Path;
use std::time::Duration;
use crate::typed_edit::{AccelProvider, AiAccelReply, DepthMap};
use crate::typed_export::GeneratedReply;
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use crate::AppState;
use crate::plugins;
use crate::bindings;
use crate::frame_output;

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
pub(crate) async fn ai_object(state: State<'_, AppState>, points: Vec<Vec<Number>>, r#box: Option<Vec<Number>>, inset: Option<bool>,
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
pub(crate) fn no_console(_cmd: &mut std::process::Command) {
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
    std::fs::create_dir_all(&dl).map_err(|e| format!("{}: {e}", dl.display()))?;
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
    std::fs::rename(&part, &archive).map_err(|e| format!("{}: {e}", part.display()))?;
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
    std::fs::create_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    progress(json!({ "id": m.id, "stage": "downloading", "mb": m.mb }));
    let part = dest.join("model.onnx.part");
    fetch(m.url, &part, Some(m.size))?;
    if sha256_file(&part)? != m.sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("the downloaded model '{}' failed its checksum", m.id));
    }
    std::fs::rename(&part, dest.join("model.onnx")).map_err(|e| format!("{}: {e}", part.display()))?;
    // written last: the registry finds the model only once it is whole
    std::fs::write(dest.join("config.json"), m.config).map_err(|e| format!("{}: {e}", dest.display()))?;
    progress(json!({ "id": m.id, "stage": "ready" }));
    Ok(())
}

// one install at a time: AI Denoise's dialog fetches its model for the
// preview while Run asks for it again, and two installs of one model share
// its .part file, so the second found it renamed away ("No such file or
// directory"). the one waiting finds the model installed by the first
static INSTALLING: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn installed(dir: &Path, id: &str) -> bool {
    dir.join(id).join("config.json").exists()
}

// make sure an AI model is installed, downloading it on first use
#[tauri::command]
#[specta::specta]
pub(crate) async fn ai_model_ensure(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.models_dir.clone();
    if installed(&dir, &id) {
        return Ok(());
    }
    if let Some(m) = EXTRA_MODELS.iter().find(|m| m.id == id) {
        return tauri::async_runtime::spawn_blocking(move || {
            let _one = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
            if installed(&dir, m.id) {
                return Ok(());
            }
            install_extra(&|v| { let _ = app.emit("ai-model", v); }, &dir, m)
        })
            .await
            .map_err(|e| e.to_string())?;
    }
    let reply = state.engine("ai_model_ensure").request(json!({ "cmd": "version" }))?;
    let version = reply["version"].as_str().unwrap_or("").to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let _one = INSTALLING.lock().unwrap_or_else(|e| e.into_inner());
        if installed(&dir, &id) {
            return Ok(());
        }
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
pub(crate) async fn ai_model_reinstall(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
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
pub(crate) async fn ai_mask(state: State<'_, AppState>, kind: String, range: Option<[Number; 2]>, inset: Option<bool>,
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
pub(crate) async fn ai_depth(state: State<'_, AppState>, size: u32) -> Result<DepthMap, String> {
    let reply = on_engine_thread(&state, json!({ "cmd": "ai_depth", "size": size })).await?;
    serde_json::from_value(reply).map_err(|e| format!("ai_depth: unexpected reply: {e}"))
}

// AI Denoise of the open raw at `strength` (0-1): a new DNG beside it with
// its edit, which the folder view then shows after it, as an Edit In
// result. replies { path, original, image }; the engine takes the edit,
// then denoises on a thread of its own
#[tauri::command]
#[specta::specta]
pub(crate) async fn ai_denoise(state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>, strength: Number)
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

// AI Denoise's preview: a crop about `size` pixels square centered on (u, v)
// of the edited photo. replies a header (width, height as u32; the crop's
// share of the photo across and down as f32), then the crop as float linear
// RGB without and with the denoise, for the dialog to mix at its Amount
#[tauri::command]
#[specta::specta]
pub(crate) async fn ai_denoise_preview(state: State<'_, AppState>, u: Number, v: Number, size: u32) -> Result<bindings::Frame, String> {
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

// the GPU execution providers this computer can use for AI, with their
// devices, for Preferences and the Export dialog's AI upscale
#[tauri::command]
#[specta::specta]
pub(crate) async fn ai_accel(state: State<'_, AppState>) -> Result<Vec<AccelProvider>, String> {
    let reply = state.engine("ai_accel").request(json!({ "cmd": "ai_accel" }))?;
    serde_json::from_value::<AiAccelReply>(reply).map(|r| r.providers).map_err(|e| format!("ai_accel: unexpected reply: {e}"))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::repo_root;
    use std::path::PathBuf;
    use std::time::Instant;

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

    // a pinned release of one model "m" whose archive is `body`, with `size` as pinned
    fn pinned_for(body: &[u8], size: u64, dir: &Path) -> [ModelRelease; 1] {
        let sha = sha_of(body, dir);
        let models: &'static [ModelPin] = Box::leak(Box::new([
            ModelPin { id: "m", sha256: Box::leak(sha.into_boxed_str()), size }]));
        [ModelRelease { darktable: "5.7.0", tag: "t1", models }]
    }

    fn left_over(dir: &Path) -> bool {
        dir.join("_dl/m.dtmodel").exists() || dir.join("_dl/m.dtmodel.part").exists() || dir.join("m").exists()
    }

    #[test]
    fn interrupted_download_installs_nothing() {
        let dir = scratch("dl-interrupted");
        let pins = pinned_for(b"xxxx", 4, &dir);
        let mut server = mockito::Server::new();
        // the connection drops mid-body, on every try
        let archive = server.mock("GET", "/t1/m.dtmodel").with_chunked_body(|w| {
            w.write_all(b"xx")?;
            w.flush()?;
            Err(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "dropped"))
        }).expect(3).create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { panic!("unpacked a partial archive") };
        let done = std::cell::Cell::new(false);
        let progress = |v: Value| if v["stage"] == "ready" { done.set(true) };
        let err = install_model(&progress, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        let left = left_over(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("could not download"), "{err}");
        assert!(!left && !done.get());
        archive.assert();
    }

    #[test]
    fn short_but_cleanly_ended_body_fails_the_checksum() {
        // a server that stops early but ends cleanly: only the checksum can tell
        let dir = scratch("dl-short");
        let pins = pinned_for(b"xxxx", 4, &dir);
        let mut server = mockito::Server::new();
        let _archive = server.mock("GET", "/t1/m.dtmodel").with_body("xx").create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { panic!("unpacked a partial archive") };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        let left = left_over(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("update of Immage"), "{err}");
        assert!(!left);
    }

    #[test]
    fn oversized_pinned_download_is_refused() {
        let dir = scratch("dl-big");
        let pins = pinned_for(b"xxxx", 4, &dir);
        let mut server = mockito::Server::new();
        let archive = server.mock("GET", "/t1/m.dtmodel").with_body("xxxxxxxx").expect(1).create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { panic!("unpacked an oversized archive") };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        let left = left_over(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(err.contains("larger than expected"), "{err}");
        assert!(!left);
        archive.assert();
    }

    #[test]
    fn published_checksum_mismatch_installs_nothing() {
        let dir = scratch("pub-mismatch");
        let sha = sha_of(b"xxx", &dir);
        let pins = [ModelRelease { darktable: "5.7.0", tag: "t1", models: &[] }];
        let mut server = mockito::Server::new();
        let _index = server.mock("GET", "/releases-index.json")
            .with_body(r#"{"compatible_releases":{"5.8.0":"t2"}}"#).create();
        let _versions = server.mock("GET", "/t2/versions.json")
            .with_body(format!(r#"{{"models":{{"m":{{"sha256":"sha256:{sha}","size":3}}}}}}"#)).create();
        let _archive = server.mock("GET", "/t2/m.dtmodel").with_body("yyy").create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { panic!("unpacked a corrupt archive") };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.8.0+1").unwrap_err();
        let left = left_over(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(err, "the downloaded model 'm' failed its checksum");
        assert!(!left);
    }

    #[test]
    fn failed_unpack_leaves_no_archive_or_model() {
        let dir = scratch("unpack-fails");
        let pins = pinned_for(b"xxx", 3, &dir);
        let mut server = mockito::Server::new();
        let _archive = server.mock("GET", "/t1/m.dtmodel").with_body("xxx").create();
        let url = server.url();
        let site = model_site(&url, &pins);
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { Err("bad archive".into()) };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        assert_eq!(err, "bad archive");
        assert!(!left_over(&dir));
        // an unpack that reports success but leaves no config.json is not an install
        let unpack = |_: &Path, _: &Path| -> Result<(), String> { Ok(()) };
        let err = install_model(&|_| {}, &unpack, &site, &dir, "m", "5.7.0+1~gtest").unwrap_err();
        let left = left_over(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(err, "could not unpack the model 'm'");
        assert!(!left);
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

    // the first-use download, as the installed app does it, into a folder of
    // its own: about 500 MB from GitHub and Hugging Face, so only on request
    // (cargo test -- --ignored models_download)
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
}
