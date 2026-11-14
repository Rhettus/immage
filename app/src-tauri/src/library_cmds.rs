// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::cache::Caches;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use crate::typed_library::{CaptureTimeEntry, CaptureTimesReply, CopyReply, FilesReply, FolderReply, KeywordsReply, LibraryImage, SubFolder, ThumbReply};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};
use crate::AppState;
use crate::volumes;
use crate::cache;
use crate::plugins;
use crate::listing;
use crate::bindings;
use crate::frame_output;
use crate::repo_root;

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
#[specta::specta]
pub(crate) async fn open_folder(app: AppHandle, state: State<'_, AppState>, path: String, recursive: Option<bool>,
                     skip: Option<Vec<String>>, token: u64) -> Result<FolderReply, String> {
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
    serde_json::from_value(json!({ "images": images, "unanswered": unanswered }))
        .map_err(|e| format!("open_folder: unexpected reply: {e}"))
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
#[specta::specta]
pub(crate) async fn path_exists(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || !volumes::answering(Path::new(&path)) || Path::new(&path).exists())
        .await
        .unwrap_or(true)
}

// a path dropped on the window: "dir", "file", or none when it is gone
#[tauri::command]
#[specta::specta]
pub(crate) fn path_kind(path: String) -> Option<&'static str> {
    let p = std::fs::canonicalize(&path).ok()?;
    if p.is_dir() { Some("dir") } else if p.is_file() { Some("file") } else { None }
}

// rejected photos to the system's Trash. the engine, not the client, says
// whether each is rejected and where it is: if any is not rejected, nothing
// moves. a virtual copy takes only its own sidecars, leaving the file to
// the other versions; an original takes the file and every version's
// sidecars, as darktable deletes them. returns the trashed files' paths
#[tauri::command]
#[specta::specta]
pub(crate) async fn trash_files(state: State<'_, AppState>, imgids: Vec<i64>) -> Result<Vec<String>, String> {
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
#[specta::specta]
pub(crate) async fn create_virtual_copy(state: State<'_, AppState>, imgid: i64) -> Result<LibraryImage, String> {
    let reply = state.engine("create_virtual_copy").request(json!({ "cmd": "copy", "imgid": imgid }))?;
    serde_json::from_value::<CopyReply>(reply).map(|r| r.image).map_err(|e| format!("copy: unexpected reply: {e}"))
}

// out of the library, its sidecars to the Trash. the photo's file stays.
// once the engine has removed it, it is gone from the library whatever the
// Trash says, so that comes back as a warning rather than an error
#[tauri::command]
#[specta::specta]
pub(crate) async fn remove_virtual_copy(state: State<'_, AppState>, imgid: i64) -> Result<Option<String>, String> {
    let reply = state.engine("remove_virtual_copy").request(json!({ "cmd": "remove_copy", "imgid": imgid }))?;
    let reply: FilesReply = serde_json::from_value(reply).map_err(|e| format!("remove_copy: unexpected reply: {e}"))?;
    Ok(trash_existing(reply.files.into_iter().map(PathBuf::from).collect()).await.err())
}

// dot folders and packages are left out of the library panel's tree
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
#[specta::specta]
pub(crate) async fn list_subfolders(path: String) -> Vec<SubFolder> {
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
#[specta::specta]
pub(crate) async fn folder_volumes(paths: Vec<String>) -> Vec<volumes::Volume> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| volumes::volume(p)).collect())
        .await
        .unwrap_or_default()
}

// Preferences' thumbnail threads: kept for the engine's next start and
// handed to the running engine at once
#[tauri::command]
#[specta::specta]
pub(crate) async fn thumb_threads(state: State<'_, AppState>, settings: State<'_, crate::settings::Settings>,
                                  threads: u32) -> Result<(), String> {
    if !(1..=crate::engine::THUMB_THREADS_MAX).contains(&threads) {
        return Err(format!("thumbnail threads must be 1 to {}", crate::engine::THUMB_THREADS_MAX));
    }
    settings.set(crate::settings::THUMB_THREADS, &threads.to_string())?;
    state.engine("thumb_threads").request(json!({ "cmd": "thumb_threads", "threads": threads })).map(|_| ())
}

// the lighttable thumbnail of an image: little-endian u32 width and height,
// then RGBA. given the photo's file, it is also kept in the thumbnail cache.
// the engine builds it on a thread of its own, beside any edit or render,
// so it does not take engine()
#[tauri::command]
#[specta::specta]
pub(crate) async fn thumb(state: State<'_, AppState>, caches: State<'_, Caches>, imgid: i64, size: u32,
               path: Option<String>, version: Option<i64>, proof: Option<bool>) -> Result<bindings::Frame, String> {
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
    let ThumbReply { width, height } = serde_json::from_value(reply).map_err(|e| format!("thumb: unexpected reply: {e}"))?;
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
    Ok(bindings::Frame(Response::new(out)))
}

// a library thumbnail from the cache, as JPEG, or nothing when it has none
// for the photo as it is now: as the open folder's listing found it, else
// as a stat finds it. the engine is not asked
#[tauri::command]
#[specta::specta]
pub(crate) async fn thumb_cached(caches: State<'_, Caches>, path: String, version: i64, size: u32) -> Result<bindings::Frame, String> {
    let (thumbs, listed) = (caches.thumbs.clone(), caches.listed.clone());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let photo = Path::new(&path);
        let name = cache::listed_thumb_name(&listed, photo, version, size)?;
        let bytes = thumbs.read(&name)?;
        // a cache from before known thumbnails learns them as it is read
        thumbs.set_known(photo, version, size, &name);
        Some(bytes)
    }).await.map_err(|e| e.to_string())?;
    Ok(bindings::Frame(Response::new(bytes.unwrap_or_default())))
}

// the photo's last thumbnail as JPEG, or nothing, found by its path alone:
// the photo is not looked at, so this is quick on a network share, but it
// may be of the photo as it was. thumb_cached() is the one to trust
#[tauri::command]
#[specta::specta]
pub(crate) async fn thumb_known(caches: State<'_, Caches>, path: String, version: i64, size: u32) -> Result<bindings::Frame, String> {
    let thumbs = caches.thumbs.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || thumbs.read_known(Path::new(&path), version, size))
        .await.map_err(|e| e.to_string())?;
    Ok(bindings::Frame(Response::new(bytes.unwrap_or_default())))
}

// Preferences' size limits for the caches, in bytes; lowering one evicts at once
#[tauri::command]
#[specta::specta]
pub(crate) async fn cache_limits(caches: State<'_, Caches>, limits: cache::Limits) -> Result<(), String> {
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
#[specta::specta]
pub(crate) async fn cache_usage(caches: State<'_, Caches>) -> Result<cache::Limits, String> {
    let (a, b, c) = (caches.thumbs.clone(), caches.immich_thumbs.clone(), caches.immich_originals.clone());
    tauri::async_runtime::spawn_blocking(move || cache::Limits {
        thumbs: a.usage(), immich_thumbs: b.usage(), immich_originals: c.usage(),
    }).await.map_err(|e| e.to_string())
}

// empties one cache ("thumbs", "immichThumbs" or "immichOriginals"); an
// edited original stays
#[tauri::command]
#[specta::specta]
pub(crate) async fn cache_clear(caches: State<'_, Caches>, which: String) -> Result<(), String> {
    let c = caches.by_name(&which).ok_or_else(|| format!("no cache {which}"))?.clone();
    tauri::async_runtime::spawn_blocking(move || c.clear()).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn meta(state: State<'_, AppState>, imgid: i64) -> Result<bindings::MetaReply, String> {
    let reply = state.engine("meta").request(json!({ "cmd": "meta", "imgid": imgid }))?;
    serde_json::from_value(reply).map_err(|e| format!("meta: unexpected reply: {e}"))
}

// the photos likely opened next, their raws decoded ahead in this order on
// the engine's own thread; the reply does not wait for them
#[tauri::command]
#[specta::specta]
pub(crate) async fn prefetch(state: State<'_, AppState>, imgids: Vec<i64>) -> Result<(), String> {
    state.engine("prefetch").request(json!({ "cmd": "prefetch", "imgids": imgids })).map(|_| ())
}

// every keyword ever used, for the Keywording panel's suggestions
#[tauri::command]
#[specta::specta]
pub(crate) async fn keywords(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let reply = state.engine("keywords").request(json!({ "cmd": "keywords" }))?;
    serde_json::from_value::<KeywordsReply>(reply).map(|r| r.keywords).map_err(|e| format!("keywords: unexpected reply: {e}"))
}

// keywords added to and removed from an image; its keywords afterwards
#[tauri::command]
#[specta::specta]
pub(crate) async fn keywords_set(state: State<'_, AppState>, imgid: i64, add: Vec<String>, remove: Vec<String>)
    -> Result<Vec<String>, String> {
    let req = json!({ "cmd": "keywords_set", "imgid": imgid, "add": add, "remove": remove });
    let reply = state.engine("keywords_set").request(req)?;
    serde_json::from_value::<KeywordsReply>(reply).map(|r| r.keywords).map_err(|e| format!("keywords_set: unexpected reply: {e}"))
}

// rating, rejected, labels and text fields; only the ones given are set
#[tauri::command]
#[specta::specta]
pub(crate) async fn meta_set(state: State<'_, AppState>, imgid: i64, fields: Map<String, Value>) -> Result<(), String> {
    let mut req = json!({ "cmd": "meta_set", "imgid": imgid });
    for (k, v) in fields {
        req[k] = v;
    }
    state.engine("meta_set").request(req).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn capture_times(state: State<'_, AppState>, entries: Vec<CaptureTimeEntry>) -> Result<CaptureTimesReply, String> {
    let reply = state.engine("capture_times").request(json!({ "cmd": "capture_times", "entries": entries }))?;
    serde_json::from_value(reply).map_err(|e| format!("capture_times: unexpected reply: {e}"))
}

// a photo or folder handed to the app from outside, waiting for the window
// to take it: a path on the command line (`Immage /path/photo.arw`,
// `Immage /path/folder`), or on macOS one sent by `open -a Immage ...` or
// Finder, which also reaches an app that is already running
#[derive(Default)]
pub(crate) struct Launch(pub(crate) Mutex<Option<String>>);

pub(crate) fn launch_path(arg: &Path) -> Option<String> {
    let p = std::fs::canonicalize(arg).ok()?;
    (p.is_file() || p.is_dir()).then(|| p.to_string_lossy().into_owned())
}

// the sample photo (app/sample, CC0) copied into a "Sample Photos" folder in
// the app's data, where edits can be saved beside it; made once, then left
// as the user has it. its path
#[tauri::command]
#[specta::specta]
pub(crate) fn sample_folder(app: AppHandle) -> Result<String, String> {
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

#[tauri::command]
#[specta::specta]
pub(crate) fn launch_file(launch: State<'_, Launch>) -> Option<String> {
    launch.0.lock().unwrap().take()
}


#[cfg(test)]
mod tests {
    use super::*;

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

    // the files a deletion names can already be gone, or be named twice (an
    // original and its copy share a sidecar); neither is an error, and
    // nothing is left to send to the Trash. only missing paths and folders
    // are used here, so no test moves a real file to the user's Trash
    #[test]
    fn trashing_missing_files_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("immage-trash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let gone = dir.join("a.jpg.xmp");
        let items = vec![gone.clone(), gone, dir.join("b.arw"), dir.clone()];
        let result = tauri::async_runtime::block_on(trash_existing(items));
        // a folder is never trashed by this path
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(result, Ok(()));
        assert_eq!(tauri::async_runtime::block_on(trash_existing(vec![])), Ok(()));
    }
}
