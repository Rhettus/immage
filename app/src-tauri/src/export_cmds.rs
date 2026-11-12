// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use crate::typed_export::{ExportFailure, ExportItem, ExportOptions, ExportReply, ExistingFile, GeneratedReply, HdrReply, PanoPreview, PanoReply, PresetsDoc, PresetsFile, SharedImport};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use crate::AppState;
use crate::plugins;
use crate::engine;
use crate::immich_upload;
use crate::import_look;
use crate::bindings;
use crate::frame_output;

// Bake a converted negative (`kind` "negative") or a film simulation
// ("film") into a new positive beside its source, <name>-positive or
// <name>-film. Reserve the name before exporting so repeated requests never
// overwrite.
#[tauri::command]
#[specta::specta]
pub(crate) async fn positive_export(state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>,
                         imgid: i64, original: String, format: String, kind: String) -> Result<GeneratedReply, String> {
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
    serde_json::from_value(reply).map_err(|e| format!("positive_export: unexpected reply: {e}"))
}

// a merge on the engine's export thread as the page's job `job`, its
// progress emitted as "merge-progress" { job, done, total, stage, last }:
// the photos read, then the merge's own stages, `last` the one past
// stopping (main.c, _merge_report); merge_cancel stops it at its next step
pub(crate) fn merge(app: AppHandle, t: engine::Tagged, job: u64, mut req: Value) -> Result<Value, String> {
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
#[specta::specta]
pub(crate) fn merge_cancel(state: State<'_, AppState>, job: u64) -> Result<(), String> {
    state.tagged.send(json!({ "cmd": "merge_cancel", "job": job }))
}

// Merge to HDR: the raw brackets `imgids` into a float DNG beside the
// first (<name>-hdr.dng), registered onto each other first when `align`.
// replies { path, image }. the engine merges on its export thread, so the
// photo is edited meanwhile
#[tauri::command]
#[specta::specta]
pub(crate) async fn hdr_merge(app: AppHandle, state: State<'_, AppState>, job: u64, imgids: Vec<i64>, align: bool)
                   -> Result<HdrReply, String> {
    let t = state.tagged.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        merge(app, t, job, json!({ "cmd": "hdr_merge", "imgids": imgids, "align": align }))
    })
    .await
    .map_err(|e| e.to_string())??;
    serde_json::from_value(reply).map_err(|e| format!("hdr_merge: unexpected reply: {e}"))
}

// whether Merge to HDR can align brackets: the engine built with OpenCV
#[tauri::command]
#[specta::specta]
pub(crate) async fn hdr_can_align(state: State<'_, AppState>) -> Result<bool, String> {
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
#[specta::specta]
pub(crate) async fn pano_merge(app: AppHandle, state: State<'_, AppState>, plugins: State<'_, plugins::Plugins>, job: u64,
                    imgids: Vec<i64>, projection: String, crop: bool) -> Result<PanoReply, String> {
    let t = state.tagged.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
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
    serde_json::from_value(reply).map_err(|e| format!("pano_merge: unexpected reply: {e}"))
}

// Reduced-size panorama on the export thread. No file is written or imported;
// the page crops the returned RGBA coverage locally, and merge_cancel stops it.
#[tauri::command]
#[specta::specta]
pub(crate) async fn pano_preview(app: AppHandle, state: State<'_, AppState>, job: u64,
                      imgids: Vec<i64>, projection: String) -> Result<PanoPreview, String> {
    let t = state.tagged.clone();
    let reply = tauri::async_runtime::spawn_blocking(move || {
        merge(app, t, job, json!({ "cmd": "pano_preview", "imgids": imgids, "projection": projection }))
    })
    .await
    .map_err(|e| e.to_string())??;
    serde_json::from_value(reply).map_err(|e| format!("pano_preview: unexpected reply: {e}"))
}

// whether Panorama Merge can stitch: the engine built with OpenCV's
// stitching module
#[tauri::command]
#[specta::specta]
pub(crate) async fn pano_can_merge(state: State<'_, AppState>) -> Result<bool, String> {
    let reply = state.engine("pano_can_merge").request(json!({ "cmd": "version" }))?;
    Ok(reply["pano"].as_bool().unwrap_or(false))
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
#[specta::specta]
pub(crate) fn export_existing(items: Vec<ExportItem>, dir: String, subfolder: Option<String>, format: String) -> Vec<ExistingFile> {
    let dir = export_dir(&dir, subfolder.as_deref());
    let ext = extension(&format);
    items.iter().map(|item| {
        let path = dir.join(format!("{}.{ext}", export_stem(item)));
        ExistingFile { exists: path.exists(), path: path.to_string_lossy().into_owned() }
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
#[specta::specta]
pub(crate) async fn export_images(
    app: AppHandle,
    state: State<'_, AppState>,
    job: u64,
    items: Vec<ExportItem>,
    options: ExportOptions,
) -> Result<ExportReply, String> {
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
    let path_text = |p: &Path| p.to_string_lossy().into_owned();
    let (mut written, mut skipped, mut failed) = (Vec::<String>::new(), Vec::<String>::new(), Vec::<ExportFailure>::new());
    let (mut uploaded, mut duplicates, mut ids) = (0u64, 0u64, Vec::<String>::new());
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
            None => skipped.push(path_text(&dir.join(format!("{stem}.{ext}")))),
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
                        failed.push(ExportFailure { file: path_text(&target),
                            error: format!("exported, but the keywords were not added to the original: {e}") });
                    }
                }
                match (result, &immich) {
                    (Ok(_), None) => written.push(path_text(&target)),
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
                            Err(e) => failed.push(ExportFailure { file: path_text(&target), error: e }),
                        }
                    }
                    (Err(e), _) => failed.push(ExportFailure { file: path_text(&target), error: e }),
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
            failed.push(ExportFailure { file: String::new(), error: e });
        }
        return Ok(ExportReply { written: vec![], skipped, failed, dir: None, cancelled, uploaded: Some(uploaded),
                                duplicates: Some(duplicates), album: options.immich_album, });
    }
    Ok(ExportReply { written, skipped, failed, dir: Some(path_text(&dir)), cancelled, uploaded: None, duplicates: None,
                     album: None })
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
#[specta::specta]
pub(crate) fn export_cancel(state: State<'_, AppState>, job: u64) {
    if let Some(c) = state.export_cancels.lock().unwrap().get(&job) {
        c.store(true, Ordering::SeqCst);
    }
}

// the file dialogs of the commands below are opened here, so a path the
// page names is never read or written; none when the dialog is cancelled
pub(crate) async fn pick_files(app: &AppHandle, title: &str, exts: &[&str], multiple: bool) -> Result<Vec<PathBuf>, String> {
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

pub(crate) async fn pick_save(app: &AppHandle, title: &str, exts: &[&str], name: &str) -> Result<Option<PathBuf>, String> {
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
pub(crate) fn path_inside(path: &Path, dirs: &[&Path]) -> Result<PathBuf, String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let inside = dirs.iter().filter_map(|d| std::fs::canonicalize(d).ok()).any(|d| real.starts_with(d));
    if inside { Ok(real) } else { Err("this is not one of the looks".into()) }
}

// look files the user picked, each added to the user's looks, and presets
// files they picked beside them; the page gets the presets' documents (it
// stores them), the number of looks added and what failed
#[tauri::command]
#[specta::specta]
pub(crate) async fn shared_import(app: AppHandle, state: State<'_, AppState>) -> Result<SharedImport, String> {
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
    Ok(SharedImport { presets, looks, failed })
}

// the Export dialog's preview: one image exported as the dialog would, as
// a small JPEG into the runtime folder, its bytes handed back. `long_edge`
// is the export's own, capped so the preview stays quick; the frame's pixel
// sizes follow it, so the preview is a scaled copy of the export
#[tauri::command]
#[specta::specta]
pub(crate) async fn export_preview(
    state: State<'_, AppState>,
    item: ExportItem,
    options: ExportOptions,
    cap: i64,
) -> Result<bindings::Frame, String> {
    let out = state._frame_output.path("export-preview.jpg");
    let mut req = json!({
        "cmd": "export", "imgid": item.imgid, "out": out, "format": "jpeg", "quality": 85,
        "color_space": "srgb", "long_edge": options.long_edge.map_or(cap, |l| l.min(cap)),
        "px_long_edge": options.long_edge.unwrap_or(0), "draft": true, "transient": true,
    });
    if let Some(f) = &item.frame { req["frame"] = f.clone(); }
    let mut engine = state.engine("export_preview");
    let result = engine.request(req).and_then(|_| {
        frame_output::FrameOutput::read(&out).map(|b| bindings::Frame(Response::new(b))).map_err(|e| format!("preview: {e}"))
    });
    state._frame_output.remove(&out);
    result
}

// the Export dialog's presets, a document the front end shapes; none yet is
// null
#[tauri::command]
#[specta::specta]
pub(crate) async fn export_presets_load(state: State<'_, AppState>) -> Result<Option<PresetsFile>, String> {
    let path = state.presets_path.with_file_name("export-presets.json");
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| format!("export presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("export presets: {e}")),
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn export_presets_save(state: State<'_, AppState>, presets: PresetsFile) -> Result<(), String> {
    let path = state.presets_path.with_file_name("export-presets.json");
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("export presets: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("export presets: {e}"))
}

// presets shared as a file: written where the save dialog opened here
// asks (false when it is cancelled), and read back from a file its open
// dialog picks (null when it is cancelled). a preset file is small, so
// anything larger is not one
#[tauri::command]
#[specta::specta]
pub(crate) async fn export_presets_export(app: AppHandle, contents: Value, name: String, label: String) -> Result<bool, String> {
    let Some(path) = pick_save(&app, &label, &["json"], &format!("{name}.json")).await? else { return Ok(false) };
    write_preset_file(&path, &contents).map(|_| true)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn export_presets_import(app: AppHandle, label: String) -> Result<Option<Value>, String> {
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
#[specta::specta]
pub(crate) async fn presets_load(state: State<'_, AppState>) -> Result<PresetsDoc, String> {
    match std::fs::read_to_string(&state.presets_path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("presets: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PresetsDoc::List(Vec::new())),
        Err(e) => Err(format!("presets: {e}")),
    }
}

// written beside and renamed over, so a crash never leaves half a file
#[tauri::command]
#[specta::specta]
pub(crate) async fn presets_save(state: State<'_, AppState>, presets: PresetsFile) -> Result<(), String> {
    let tmp = state.presets_path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&presets).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("presets: {e}"))?;
    std::fs::rename(&tmp, &state.presets_path).map_err(|e| format!("presets: {e}"))
}


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
}
