// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Instant;
use crate::typed_session::{AgxAutoReply, ColorProfiles, GetReply, PasteBatchReply, PreviewReply, RenderReply, RenderRequest, SampleReply, SaveReply, ToneKeyReply, HistoryItem, HistoryReply, ModuleEdit, ModuleStateReply, OpenReply, Restore};
use tauri::{ipc::Response, State};
use crate::AppState;
use crate::bindings;
use crate::frame_output;

// commands are async so a render runs off the main thread

#[tauri::command]
#[specta::specta]
pub(crate) async fn open_image(state: State<'_, AppState>, path: String, imgid: Option<i64>) -> Result<OpenReply, String> {
    let reply = state.engine("open_image").request(json!({ "cmd": "open", "path": path, "imgid": imgid.unwrap_or(-1) }))?;
    serde_json::from_value(reply).map_err(|e| format!("open: unexpected reply: {e}"))
}

// the open image's darktable history, oldest first; `saved`, as the last
// save stored it, compressed
#[tauri::command]
#[specta::specta]
pub(crate) async fn history(state: State<'_, AppState>, saved: Option<bool>) -> Result<Vec<HistoryItem>, String> {
    let reply = state.engine("history").request(json!({ "cmd": "history", "saved": saved.unwrap_or(false) }))?;
    let reply: HistoryReply = serde_json::from_value(reply).map_err(|e| format!("history: unexpected reply: {e}"))?;
    Ok(reply.items)
}

// the History panel's switch and delete for one instance in the history:
// `enabled` switches it, `reset` puts it back to darktable's defaults,
// `restore` to a state an earlier reply gave. replies the state before and
// after, `was` and `now`
#[tauri::command]
#[specta::specta]
pub(crate) async fn module_state(
    state: State<'_, AppState>,
    op: String,
    priority: i64,
    enabled: Option<bool>,
    reset: Option<bool>,
    restore: Option<Restore>,
    preset: Option<String>,
) -> Result<ModuleStateReply, String> {
    let mut req = json!({ "cmd": "module_state", "op": op, "priority": priority, "reset": reset.unwrap_or(false) });
    if let Some(e) = enabled {
        req["enabled"] = json!(e);
    }
    if let Some(r) = restore {
        req["restore"] = json!(r);
    }
    if let Some(p) = preset {
        req["preset"] = json!(p);
    }
    let reply = state.engine("module_state").request(req)?;
    serde_json::from_value(reply).map_err(|e| format!("module_state: unexpected reply: {e}"))
}

// the fields ({ op: [field] }) of these modules' instances
#[tauri::command]
#[specta::specta]
pub(crate) async fn get_params(state: State<'_, AppState>, modules: std::collections::BTreeMap<String, Vec<String>>) -> Result<GetReply, String> {
    let reply = state.engine("get_params").request(json!({ "cmd": "get", "modules": modules }))?;
    serde_json::from_value(reply).map_err(|e| format!("get: unexpected reply: {e}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn set_params(state: State<'_, AppState>, edit: ModuleEdit) -> Result<(), String> {
    state.engine("set_params").request(edit.request(false)).map(|_| ())
}

// the working-space values at a point of the shown image, or over a box of
// it [x0, y0, x1, y1], for range masks; with `stage` "negadoctor", at
// negadoctor's input, for the Negative panel's pickers
#[tauri::command]
#[specta::specta]
pub(crate) async fn sample(state: State<'_, AppState>, x: serde_json::Number, y: serde_json::Number, area: Option<Vec<serde_json::Number>>, stage: Option<String>) -> Result<SampleReply, String> {
    let reply = state.engine("sample").request(json!({ "cmd": "sample", "x": x, "y": y, "box": area, "stage": stage }))?;
    serde_json::from_value(reply).map_err(|e| format!("sample: unexpected reply: {e}"))
}

// the mean log2 luminance the tone mapper gets, for Auto's exposure
#[tauri::command]
#[specta::specta]
pub(crate) async fn tone_key(state: State<'_, AppState>) -> Result<ToneKeyReply, String> {
    let reply = state.engine("tone_key").request(json!({ "cmd": "tone_key" }))?;
    serde_json::from_value(reply).map_err(|e| format!("tone_key: unexpected reply: {e}"))
}

// Input and working profiles supported by the pinned darktable engine.
#[tauri::command]
#[specta::specta]
pub(crate) async fn color_profiles(state: State<'_, AppState>) -> Result<ColorProfiles, String> {
    let reply = state.engine("color_profiles").request(json!({ "cmd": "color_profiles" }))?;
    serde_json::from_value(reply).map_err(|e| format!("color_profiles: unexpected reply: {e}"))
}

// black and white relative exposure for AgX, as darktable's "auto tune
// levels" picker finds them over the photo
#[tauri::command]
#[specta::specta]
pub(crate) async fn agx_auto(state: State<'_, AppState>) -> Result<AgxAutoReply, String> {
    let reply = state.engine("agx_auto").request(json!({ "cmd": "agx_auto" }))?;
    serde_json::from_value(reply).map_err(|e| format!("agx_auto: unexpected reply: {e}"))
}

// points (x, y pairs, 0-1) between the shown image and the input image
// before any distortion; `to` is "shown" or "input"
#[tauri::command]
#[specta::specta]
pub(crate) async fn points(state: State<'_, AppState>, points: Value, to: String) -> Result<Value, String> {
    let reply = state.engine("points").request(json!({ "cmd": "points", "points": points, "to": to }))?;
    Ok(reply["points"].clone())
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
#[specta::specta]
pub(crate) async fn render(
    state: State<'_, AppState>,
    webview: tauri::Webview,
    request: RenderRequest,
) -> Result<bindings::Frame, String> {
    let RenderRequest { width, height, scale, x, y, skip, draft, base, shared, token, have, edits, diagnostic_request } = request;
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
        engine.request(e.request(true))?;
    }
    let set_ms = ms(ts);
    let t1 = Instant::now();
    let reply = engine.request(req)?;
    let reply: RenderReply = serde_json::from_value(reply).map_err(|e| format!("render: unexpected reply: {e}"))?;
    if let Some(output) = &reply.output_ms {
        engine.set_output_ms([output.allocate_ms, output.convert_ms, output.file_ms, output.free_ms]);
    }
    let request_ms = ms(t1);
    let field = |k: &str| match k {
        "width" => reply.width,
        "height" => reply.height,
        "full_width" => reply.full_width,
        "full_height" => reply.full_height,
        "x" => reply.x.max(0) as u64,
        _ => reply.y.max(0) as u64,
    } as u32;
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
    let hash = u64::from_str_radix(&reply.hash, 16).unwrap_or(0);
    out.extend_from_slice(&hash.to_le_bytes());
    out.extend_from_slice(&(set_ms as f32).to_le_bytes());
    out.resize(FRAME_HEAD, 0);
    let kept = reply.kept;
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
    for (i, v) in [lock_ms, request_ms, reply.process_ms, reply.write_ms, read_ms, mark_ms].into_iter().enumerate() {
        out[timings + 4 * i..timings + 4 * i + 4].copy_from_slice(&(v as f32).to_le_bytes());
    }
    // the header alone, of no size: the page's own frame of that hash
    if kept {
        return Ok(bindings::Frame(Response::new(out)));
    }
    // the header alone says the frame went by shared memory, tagged `shared`;
    // where that can't be done, it comes back whole as before
    #[cfg(windows)]
    if let Some(id) = shared {
        let out = std::sync::Arc::new(out);
        match shared_frame::post(&webview, out.clone(), id) {
            Ok(()) => return Ok(bindings::Frame(Response::new(out[..FRAME_HEAD].to_vec()))),
            Err(e) => {
                eprintln!("shared frame: {e}");
                return Ok(bindings::Frame(Response::new(std::sync::Arc::try_unwrap(out).unwrap_or_else(|a| (*a).clone()))));
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
                return Ok(bindings::Frame(Response::new(out[..FRAME_HEAD].to_vec())));
            },
            Err(e) => eprintln!("shared frame: {e}"),
        }
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (shared, token);
    #[cfg(windows)]
    let _ = token;
    #[cfg(not(windows))]
    let _ = webview;
    Ok(bindings::Frame(Response::new(out)))
}

// Linux: a frame handed to the page through /dev/shm, which the window's
// web extension (webext/frames.c) reads and deletes. returned through
// Tauri, WebKitGTK copies it across processes at about 25 ms a megapixel,
// more while a 2x page draws
#[cfg(target_os = "linux")]
pub(crate) mod shm_frame {
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
#[specta::specta]
pub(crate) async fn cancel_base(state: State<'_, AppState>) -> Result<(), String> {
    state.base_cancel.cancel()
}

// the reply says whether the photo now reads as edited (darktable's history hash)
#[tauri::command]
#[specta::specta]
pub(crate) async fn save(state: State<'_, AppState>) -> Result<SaveReply, String> {
    let reply = state.engine("save").request(json!({ "cmd": "save" }))?;
    serde_json::from_value(reply).map_err(|e| format!("save: unexpected reply: {e}"))
}

// Native history snapshots owned by the frontend's batch undo entries.
#[tauri::command]
#[specta::specta]
pub(crate) async fn paste_batch(state: State<'_, AppState>, action: String, token: Option<u64>, imgids: Option<Vec<i64>>) -> Result<PasteBatchReply, String> {
    let reply = state.engine("paste_batch").request(json!({ "cmd": "paste_batch", "action": action,
        "token": token.unwrap_or(0), "imgids": imgids.unwrap_or_default() }))?;
    serde_json::from_value(reply).map_err(|e| format!("paste_batch: unexpected reply: {e}"))
}

// the user's first change to a new photo: the defaults applied so far become
// its unedited baseline
#[tauri::command]
#[specta::specta]
pub(crate) async fn baseline_end(state: State<'_, AppState>) -> Result<(), String> {
    state.engine("baseline_end").request(json!({ "cmd": "baseline_end" })).map(|_| ())
}

// whether the engine holds the Before view's settings, which it must not
// save on quitting
#[tauri::command]
#[specta::specta]
pub(crate) async fn before_view(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.engine("before_view").request(json!({ "cmd": "before", "on": on })).map(|_| ())
}

// a small render of the open image with edits and, if `with_look`, `look`
// (a path, or none) on top, leaving the edit as it is: u32 width and
// height, then RGBA
#[tauri::command]
#[specta::specta]
pub(crate) async fn preview(
    state: State<'_, AppState>,
    size: u32,
    edits: Vec<ModuleEdit>,
    with_look: bool,
    look: Option<String>,
) -> Result<bindings::Frame, String> {
    let edits: Vec<Value> = edits.iter().filter_map(|e| serde_json::to_value(e).ok()).collect();
    let mut req = json!({ "cmd": "preview", "size": size, "edits": edits, "rgba": state.preview_path });
    if with_look {
        req["look"] = json!(look);
    }
    let mut engine = state.engine("preview");
    let reply = engine.request(req)?;
    let reply: PreviewReply = serde_json::from_value(reply).map_err(|e| format!("preview: unexpected reply: {e}"))?;
    let pixels = frame_output::FrameOutput::read(&state.preview_path).map_err(|e| format!("preview: {e}"))?;
    drop(engine);
    let mut out = Vec::with_capacity(8 + pixels.len());
    for v in [reply.width, reply.height] {
        out.extend_from_slice(&(v as u32).to_le_bytes());
    }
    out.extend_from_slice(&pixels);
    Ok(bindings::Frame(Response::new(out)))
}

