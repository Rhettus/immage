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
// so a folder on a network share shows at once. the next lists photo candidates,
// so the client can lay out a cell for each. a newer call (another `token`)
// stops this one. returns every image: ratings, labels and EXIF summary.
// `skip` names subfolders taken off the folder tree, which `recursive`
// leaves out with their own subfolders
#[tauri::command]
#[specta::specta]
pub(crate) async fn open_folder(app: AppHandle, state: State<'_, AppState>, path: String, recursive: Option<bool>,
                     skip: Option<Vec<String>>, token: u64) -> Result<FolderReply, String> {
    state.folder_token.store(token, Ordering::SeqCst);
    state.tagged.mark_active();
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
    if let Some(index) = state.search_cache.clone() {
        let observed = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let volume = volumes::volume_online(&observed);
            let _ = index.root_state(&observed, Some(&volume.mount), "online", None);
        }).await.map_err(|e| e.to_string())?;
    }
    let skip: HashSet<PathBuf> = skip.unwrap_or_default().into_iter().map(PathBuf::from).collect();
    let top = dir.clone();
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
    // the folder itself did not list in time: its share has stopped answering
    if listed.stalled.contains(&top) {
        return Err(format!("{path} is not answering: its drive or network share may be disconnected"));
    }
    let listed_cache = std::sync::Arc::new(Mutex::new(listed));
    app.state::<plugins::Plugins>().drain_jobs();
    app.state::<plugins::Plugins>().beside_originals(&mut files);
    let total = files.len();
    let list: Vec<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
    let _ = app.emit("folder-progress", json!({ "token": token, "done": 0, "total": total, "images": [],
                                                "files": list }));
    // stamps the listing could not give (Linux) are read side by side, for
    // a few seconds at most, before the cached rows are checked against
    // them: a file that has not answered by then keeps its cached row
    {
        let (cache_listed, shared) = (listed_cache.clone(), app.state::<Caches>().listed.clone());
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // publish at once: stamps not yet read are Unknown there, which
            // thumb_cached stats itself, so answers stay correct while
            // prestat runs and cached_thumb no longer sees the previous
            // folder's listing for up to STAT_WAIT. no lock is held across it
            let early = cache_listed.lock().unwrap().clone();
            publish_listing(&shared, early, || handle.state::<AppState>().folder_token.load(Ordering::SeqCst) == token);
            cache::prestat(&cache_listed, STAT_WAIT);
            let now = cache_listed.lock().unwrap().clone();
            // prestat can take seconds: a newer folder read may have
            // published its own listing meanwhile
            publish_listing(&shared, now, || handle.state::<AppState>().folder_token.load(Ordering::SeqCst) == token);
        }).await.map_err(|e| e.to_string())?;
    }
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
        let cached_index = state.search_cache.clone();
        let cached_listing = listed_cache.clone();
        let candidates = batch.to_vec();
        let (mut cached, list, batch_len) = tauri::async_runtime::spawn_blocking(move || {
            let mut cached = Vec::new(); let mut missing = Vec::new();
            let mut cached_mode = None;
            let mut count = 0;
            for path in candidates {
                let found = cached_folder_metadata(cached_index.as_deref(), &cached_listing, &path);
                let hit = found.is_some();
                if cached_mode.is_some_and(|mode| mode != hit) { break; }
                cached_mode = Some(hit); count += 1;
                if let Some(mut metadata) = found { cached.append(&mut metadata); }
                else { missing.push(path.to_string_lossy().into_owned()); }
            }
            (cached, missing, count)
        }).await.map_err(|e| e.to_string())?;
        if state.folder_token.load(Ordering::SeqCst) != token { return Err("superseded".into()); }
        for image in &mut cached {
            if let (Some(path), Some(version)) = (image["path"].as_str(), image["version"].as_i64()) {
                image["imgid"] = json!(state.tagged.cached_photo(path, version));
            }
        }
        // Each group is a contiguous hit/miss prefix. The engine's budgeted
        // processed count therefore cannot skip an unprocessed cache miss.
        let cached_files = if list.is_empty() { batch_len } else { 0 };
        let t = state.tagged.clone();
        let tag = t.tag();
        let start = Instant::now();
        let handle = app.clone();
        // `job` stops the batch once another folder's is queued, and
        // `budget` once it has run that long, so a network share's slow
        // files hold neither the next folder nor an open photo for long
        // (main.c, _import_files)
        let budget = (IMPORT_TARGET * 2).as_millis() as u64;
        let requested = list.len();
        let reply = if requested == 0 { json!({"images":[],"done":0}) } else { tauri::async_runtime::spawn_blocking(move || t.request_until(
            tag, json!({ "cmd": "import", "files": list, "job": token, "budget": budget }), Duration::from_secs(30),
            || handle.state::<AppState>().folder_token.load(Ordering::SeqCst) != token))
            .await
            .map_err(|e| e.to_string())?? };
        let took = start.elapsed();
        let mut got = reply["images"].as_array().cloned().unwrap_or_default();
        // The grid gets the batch first; the cache write follows on the
        // blocking pool. It yields to the folder read (no lock is held while
        // the engine works) and is skipped once another folder supersedes this
        // read. Not awaited: a slow cache write never delays folder-progress.
        if let Some(index) = state.search_cache.clone() {
            let listed = listed_cache.clone();
            let metadata = got.clone();
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if handle.state::<AppState>().folder_token.load(Ordering::SeqCst) == token {
                    index_imported_metadata(Some(&index), &listed, &metadata);
                }
            });
        }
        // the files the batch went through; the rest go in the next. none
        // when another read's batch came in first, which the token check
        // above then finds, or which is resent
        let through = cached_files + reply["done"].as_u64().map_or(requested, |n| (n as usize).min(requested));
        got.append(&mut cached);
        // a batch of about IMPORT_TARGET, however long a file takes to read
        if through > 0 && through < batch_len {
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

// the most a folder's opening waits for its files' sizes and times
const STAT_WAIT: Duration = Duration::from_secs(4);
// the most a folder's listing is waited for
const LIST_WAIT: Duration = Duration::from_secs(10);

// Publish a folder's listing unless a newer read has superseded it. The token
// is checked while holding the `Caches.listed` mutex: every publisher bumps
// `folder_token` at the start of open_folder, long before any publish, so a
// stale read either sees the bump or has already written before the newer one
// publishes. Lock order: the mutex, then only an atomic load; nothing else is
// taken inside `current`.
fn publish_listing(shared: &Mutex<cache::Listed>, listing: cache::Listed, current: impl FnOnce() -> bool) -> bool {
    let mut slot = shared.lock().unwrap();
    if !current() { return false; }
    *slot = listing;
    true
}

// A complete, validated group only: one unknown/new/deleted sidecar forces
// ordinary engine import, including all current virtual copies. No engine IDs
// or negative (unsupported-file) results are persisted here.
fn cached_folder_metadata(
    index: Option<&crate::search_cache::SearchCache>, listed: &Mutex<cache::Listed>, path: &Path,
) -> Option<Vec<Value>> {
    let index = index?;
    let versions = listed.lock().ok()?.versions(path)?;
    let rows = index.path_metadata(path.to_str()?).ok()?;
    if rows.len() != versions.len() { return None; }
    let mut result = Vec::new();
    for version in versions {
        let key = if version == 0 { String::new() } else { format!("version:{version}") };
        let (_, original, edited, metadata) = rows.iter().find(|(k,_,_,_)| *k == key)?;
        match cache::listed_metadata_fingerprints(listed, path, version) {
            Some(stamps) if stamps.0 != *original || stamps.1 != *edited => return None,
            Some(_) => {}
            // a stat that did not answer in time: shown as cached, and
            // found changed (if it is) when the folder is next opened
            None if cache::metadata_unreached(listed, path, version) => {}
            None => return None,
        }
        let image: Value = serde_json::from_str(metadata).ok()?;
        // Reject malformed disposable rows rather than breaking folder replies.
        let mut typed = image.clone(); typed["imgid"] = json!(1);
        let parsed: LibraryImage = serde_json::from_value(typed).ok()?;
        if parsed.path != path.to_str()? || i64::from(parsed.version) != version { return None; }
        result.push(image);
    }
    Some(result)
}

// Keep the already-extracted EXIF/library metadata in the disposable local
// index. The engine's imgid is deliberately omitted: it exists only for this
// process and must never become the persistent search identity.
fn index_imported_metadata(
    index: Option<&crate::search_cache::SearchCache>,
    listed: &std::sync::Mutex<cache::Listed>,
    images: &[Value],
) {
    let Some(index) = index else { return };
    // Gather every input first (fingerprints, serialization), then write the
    // whole batch in one transaction so the cache lock and one WAL sync cover
    // the batch, not each photo.
    struct Row { path: String, key: String, original: String, edited: String,
        ns: Option<i64>, raw: Option<String>, offset: Option<i32>, json: Option<String> }
    let mut rows = Vec::new();
    for image in images {
        let Some(path) = image.get("path").and_then(Value::as_str) else { continue };
        let version = image.get("version").and_then(Value::as_i64).unwrap_or(0);
        let Some((original, edited)) =
            cache::listed_metadata_fingerprints(listed, Path::new(path), version)
        else { continue };
        let (ns, raw, offset) = precise_capture(image);
        let key = if version == 0 { String::new() } else { format!("version:{version}") };
        let mut metadata = image.clone();
        if let Some(fields) = metadata.as_object_mut() { fields.remove("imgid"); }
        let json = match serde_json::to_string(&metadata) {
            Ok(json) => Some(json),
            Err(e) => { eprintln!("search metadata serialization: {e}"); None }
        };
        rows.push(Row { path: path.into(), key, original, edited, ns, raw, offset, json });
    }
    let items: Vec<_> = rows.iter().map(|r| crate::search_cache::BatchItem {
        path: &r.path, copy_key: &r.key, original: &r.original, edited: &r.edited,
        capture_time_ns: r.ns, capture_time_raw: r.raw.as_deref(),
        timezone_offset_seconds: r.offset, metadata: r.json.as_deref(),
    }).collect();
    if let Err(e) = index.upsert_metadata_batch(&items) {
        eprintln!("search metadata cache: {e}");
    }
}

fn mutation_metadata_snapshot(
    index: &crate::search_cache::SearchCache,
    path: &str,
    copy_key: &str,
) -> Result<Option<crate::search_cache::PendingAnalysis>, String> {
    let Some(variant) = index.variant(path, copy_key)? else { return Ok(None) };
    let Some(asset) = index.asset(variant.asset_id)? else { return Ok(None) };
    if asset.path != path { return Ok(None) }
    Ok(Some(crate::search_cache::PendingAnalysis {
        variant_id: variant.id,
        asset_id: asset.id,
        path: asset.path,
        copy_key: variant.copy_key,
        original: asset.original_fingerprint,
        edited: variant.edited_fingerprint,
        needs_metadata: true,
        needs_edited: false,
    }))
}

fn metadata_refresh_key(row: &crate::search_cache::PendingAnalysis) -> String {
    // after_success assigns a fresh random edited fingerprint on each
    // invalidation; save/open refreshes for the same photo therefore don't
    // deduplicate one another across invalidation generations.
    format!("search-metadata:{}:{}", row.variant_id, row.edited)
}

struct PreparedMetadata {
    edited: String,
    metadata: String,
    capture: (Option<i64>, Option<String>, Option<i32>),
}

// File stats and serialization can block on a NAS; prepare them before taking
// Job::commit's queue lock. The publication step below is only the CAS query.
fn prepare_mutation_metadata(
    row: &crate::search_cache::PendingAnalysis,
    image: &Value,
) -> Result<Option<PreparedMetadata>, String> {
    let Some(path) = image.get("path").and_then(Value::as_str) else { return Ok(None) };
    let Some(version) = image.get("version").and_then(Value::as_i64) else { return Ok(None) };
    if version < 0 { return Ok(None) }
    let copy_key = if version == 0 { String::new() } else { format!("version:{version}") };
    if path != row.path || copy_key != row.copy_key { return Ok(None) }
    let Some((original, edited)) = cache::listed_metadata_fingerprints(
        &Mutex::new(cache::Listed::default()), Path::new(path), version,
    ) else { return Ok(None) };
    if original != row.original { return Ok(None) }
    let capture = precise_capture(image);
    let mut stored = image.clone();
    if let Some(fields) = stored.as_object_mut() { fields.remove("imgid"); }
    let metadata = serde_json::to_string(&stored).map_err(|e| e.to_string())?;
    Ok(Some(PreparedMetadata { edited, metadata, capture }))
}

fn publish_mutation_metadata(
    index: &crate::search_cache::SearchCache,
    row: &crate::search_cache::PendingAnalysis,
    prepared: PreparedMetadata,
) -> Result<bool, String> {
    index.finish_analysis_metadata(
        row,
        &prepared.edited,
        &prepared.metadata,
        (prepared.capture.0, prepared.capture.1.as_deref(), prepared.capture.2),
    )
}

fn cache_mutation_metadata(
    index: &crate::search_cache::SearchCache,
    row: &crate::search_cache::PendingAnalysis,
    image: &Value,
) -> Result<bool, String> {
    let Some(prepared) = prepare_mutation_metadata(row, image)? else { return Ok(false) };
    publish_mutation_metadata(index, row, prepared)
}

// A successful metadata edit invalidates the cached JSON in the engine link.
// Re-read the engine's authoritative metadata and repopulate the disposable
// search index without making a successful edit depend on cache availability.
async fn refresh_search_metadata(state: &AppState, imgid: i64) {
    let Some(index) = state.search_cache.clone() else { return };
    let Some(photo) = state.tagged.known_photo(imgid) else { return };
    let copy_key = if photo.version == 0 { String::new() } else { format!("version:{}", photo.version) };
    let row = match mutation_metadata_snapshot(&index, &photo.path, &copy_key) {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(error) => {
            eprintln!("search metadata refresh for {imgid}: {error}");
            return;
        }
    };
    let reply = match state.engine("search_metadata_refresh").request(
        json!({ "cmd": "meta", "imgid": imgid }),
    ) {
        Ok(reply) => reply,
        Err(error) => {
            eprintln!("search metadata refresh for {imgid}: {error}");
            return;
        }
    };
    let Some(image) = reply.get("image").cloned() else { return };
    match tauri::async_runtime::spawn_blocking(move || cache_mutation_metadata(&index, &row, &image)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => eprintln!("search metadata refresh for {imgid}: {error}"),
        Err(error) => eprintln!("search metadata refresh for {imgid}: {error}"),
    }
}

// Lifecycle refreshes run on the bounded shared queue so opening the next
// photo never waits on metadata I/O for the one just left.
pub(crate) fn queue_search_metadata_refresh(state: &AppState, photo: crate::library_ids::Photo) {
    let Some(index) = state.search_cache.clone() else { return };
    let copy_key = if photo.version == 0 { String::new() } else { format!("version:{}", photo.version) };
    let row = match mutation_metadata_snapshot(&index, &photo.path, &copy_key) {
        Ok(Some(row)) => row,
        Ok(None) => return,
        Err(error) => {
            eprintln!("search metadata refresh for {}: {error}", photo.path);
            return;
        }
    };
    let key = metadata_refresh_key(&row);
    let tagged = state.tagged.clone();
    let path = photo.path.clone();
    let version = photo.version;
    if !state.analysis_queue.submit(key, move |job| {
        if job.cancelled() { return }
        let handle = tagged.cached_photo(&path, version);
        let reply = match tagged.request(tagged.tag(), json!({ "cmd": "meta", "imgid": handle })) {
            Ok(reply) => reply,
            Err(error) => {
                eprintln!("search metadata refresh for {}: {error}", path);
                return;
            }
        };
        let Some(image) = reply.get("image").cloned() else { return };
        let prepared = match prepare_mutation_metadata(&row, &image) {
            Ok(Some(prepared)) => prepared,
            Ok(None) => return,
            Err(error) => {
                eprintln!("search metadata refresh for {}: {error}", path);
                return;
            }
        };
        if let Some(result) = job.commit(|| publish_mutation_metadata(&index, &row, prepared)) {
            match result {
                Ok(_) => {}
                Err(error) => eprintln!("search metadata refresh for {}: {error}", path),
            }
        }
    }) {
        eprintln!("search metadata refresh for {}: analysis queue is full or stopping", photo.path);
    }
}

// Preserve camera fractional digits and only assign an instant when its UTC
// offset is known. A changed sidecar capture date takes precedence over EXIF.
pub(crate) fn precise_capture(image: &Value) -> (Option<i64>, Option<String>, Option<i32>) {
    let exif = &image["exif"];
    let datetime = exif["datetime"].as_str().unwrap_or("");
    let source = exif["capture_time_raw"].as_str().unwrap_or("");
    let source_matches = datetime.len() >= 19 && source.get(..19) == datetime.get(..19);
    let raw = if source_matches { source } else { datetime };
    if raw.is_empty() { return (None,None,None); }
    let zone = if source_matches { exif["capture_offset"].as_str().unwrap_or("") } else { "" };
    let offset = (|| {
        let b = zone.as_bytes();
        if b.len()!=6 || !matches!(b[0], b'+'|b'-') || b[3]!=b':'
            || ![b[1],b[2],b[4],b[5]].iter().all(u8::is_ascii_digit) { return None; }
        let hours=i32::from(b[1]-b'0')*10+i32::from(b[2]-b'0');
        let minutes=i32::from(b[4]-b'0')*10+i32::from(b[5]-b'0');
        if hours>23 || minutes>59 { return None; }
        Some((hours*3600+minutes*60)*if b[0]==b'-' {-1} else {1})
    })();
    let instant = chrono::NaiveDateTime::parse_from_str(raw,"%Y:%m:%d %H:%M:%S%.f").ok()
        .zip(offset.and_then(chrono::FixedOffset::east_opt))
        .and_then(|(dt,zone)|dt.and_local_timezone(zone).single())
        .and_then(|dt|dt.timestamp_nanos_opt());
    (instant,Some(raw.to_owned()),offset)
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

// Candidate formats from darktable/data/supported_extensions.cmake and the
// optional readers in darktable/src/CMakeLists.txt. Keep the optional formats
// here too: the engine still decides whether this build can decode a photo.
// Checking the name needs no file reads or extra network round trips.
pub(crate) fn photo_candidate(path: &Path) -> bool {
    const EXTENSIONS: &[&str] = &[
        "3fr", "ari", "arw", "bay", "bmq", "cap", "cine", "cr2", "cr3", "crw", "cs1", "dc2",
        "dcr", "dng", "erf", "fff", "gpr", "hdr", "ia", "iiq", "jfif", "jpeg", "jpg", "k25",
        "kc2", "kdc", "mdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "ori", "pbm", "pef",
        "pfm", "pgm", "png", "pnm", "ppm", "pxn", "qoi", "qtk", "raf", "raw", "rdc", "rw2",
        "rwl", "sr2", "srf", "srw", "sti", "tif", "tiff", "x3f", "exr", "jxl", "webp", "avif",
        "heif", "heic", "hif", "hej2", "avci", "j2c", "j2k", "jp2", "jpc", "jpf", "jpx",
        "bmp", "cin", "dcm", "dpx", "fit", "fits", "fts", "gif", "jng", "miff", "mng", "pam",
    ];
    path.extension().and_then(|e| e.to_str())
        .is_some_and(|e| EXTENSIONS.iter().any(|known| e.eq_ignore_ascii_case(known)))
}

// the files of `dir` by name, then with `recursive` each subfolder's in
// turn, as darktable's own folder import orders them. dot files, non-photos
// and packages are left out, and so are the subfolders in `skip`
// each file's stamp, sidecars' too, goes in `listed`, so its thumbnail is
// checked without asking the disk again (cache::listed_thumb_name)
fn folder_files(dir: &Path, recursive: bool, skip: &HashSet<PathBuf>, out: &mut Vec<PathBuf>,
                listed: &mut cache::Listed) {
    let (mut files, mut dirs, mut stamps) = (Vec::new(), Vec::new(), Vec::new());
    let Some(entries) = listing::list_within(dir, LIST_WAIT) else {
        listed.stalled.push(dir.to_path_buf());
        return;
    };
    for e in entries {
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
        if photo_candidate(&p) {
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
pub(crate) fn is_package(path: &Path) -> bool {
    let p = objc2_foundation::NSString::from_str(&path.to_string_lossy());
    objc2_app_kit::NSWorkspace::sharedWorkspace().isFilePackageAtPath(&p)
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn is_package(_path: &Path) -> bool {
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
pub(crate) async fn path_kind(path: String) -> Option<&'static str> {
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::volumes::answering(std::path::Path::new(&path)) {
            return None;
        }
        let p = std::fs::canonicalize(&path).ok()?;
        if p.is_dir() { Some("dir") } else if p.is_file() { Some("file") } else { None }
    }).await.ok().flatten()
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
    if let Some(index)=&state.search_cache {
        for path in &gone { if let Err(e)=index.remove_path(path) { eprintln!("search cache trash: {e}"); } }
    }
    // only once the files are gone: a new file at the same path then
    // imports fresh, not as the deleted one, rejected
    for id in forget {
        state.engine("trash_files").request(json!({ "cmd": "forget", "imgid": id }))?;
    }
    Ok(gone)
}

// files on network shares, which have no Trash, and the rest
fn split_network(items: Vec<PathBuf>, on_network: impl Fn(&Path) -> bool) -> (Vec<PathBuf>, Vec<PathBuf>) {
    items.into_iter().partition(|p| on_network(p))
}

// the files that are still there, each once: an original and its own
// copy in one batch name the copy's sidecar twice. files on a network
// share have no Trash to go to, so they are deleted outright, and only
// once every share involved answers: a stuck share fails the batch
// before anything is removed
async fn trash_existing(mut items: Vec<PathBuf>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        items.sort();
        items.dedup();
        items.retain(|p| p.is_file());
        if items.is_empty() {
            return Ok(());
        }
        let (network, local) = split_network(items, volumes::on_network);
        let mut folders: Vec<&Path> = network.iter().filter_map(|p| p.parent()).collect();
        folders.dedup();
        for folder in folders {
            if !volumes::answering(folder) {
                return Err(format!("{} is on a network drive that is not answering; nothing was deleted", folder.display()));
            }
        }
        let mut failed = Vec::new();
        for file in &network {
            match std::fs::remove_file(file) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => failed.push(format!("{}: {e}", file.display())),
            }
        }
        if !local.is_empty() {
            #[allow(unused_mut)]
            let mut trash = trash::TrashContext::default();
            // the crate's default asks Finder over AppleScript, which needs the
            // Automation permission and fails without it; NSFileManager does not
            #[cfg(target_os = "macos")]
            {
                use trash::macos::{DeleteMethod, TrashContextExtMacos};
                trash.set_delete_method(DeleteMethod::NsFileManager);
            }
            if let Err(e) = trash.delete_all(&local) {
                failed.push(e.to_string());
            }
        }
        if failed.is_empty() { Ok(()) } else { Err(failed.join("; ")) }
    })
    .await
    .map_err(|e| e.to_string())?
}

// whether each path is on a network share, from the mount table alone: the
// share is never asked, so this does not wait on a stuck one
#[tauri::command]
#[specta::specta]
pub(crate) async fn on_network_share(paths: Vec<String>) -> Vec<bool> {
    tauri::async_runtime::spawn_blocking(move || paths.iter().map(|p| volumes::on_network(Path::new(p))).collect())
        .await
        .unwrap_or_default()
}

// a virtual copy of a photo: a new darktable version carrying its edit,
// rating, labels, metadata and keywords, with a sidecar of its own
#[tauri::command]
#[specta::specta]
pub(crate) async fn create_virtual_copy(state: State<'_, AppState>, imgid: i64) -> Result<LibraryImage, String> {
    let reply = state.engine("create_virtual_copy").request(json!({ "cmd": "copy", "imgid": imgid }))?;
    if let Some(image)=reply.get("image") {
        index_imported_metadata(state.search_cache.as_deref(), &Mutex::new(cache::Listed::default()), std::slice::from_ref(image));
    }
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

// the folder tree's New Folder: one folder named `name` inside `parent`,
// never an existing one or one elsewhere, its path returned
#[tauri::command]
#[specta::specta]
pub(crate) async fn create_folder(parent: String, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = name.trim();
        if let Some(why) = folder_name_problem(name) {
            return Err(why);
        }
        let parent = Path::new(&parent);
        if !volumes::answering(parent) {
            return Err(format!("{} is not connected", parent.display()));
        }
        let dir = parent.join(name);
        match std::fs::create_dir(&dir) {
            Ok(()) => Ok(dir.to_string_lossy().into_owned()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(format!("\"{name}\" already exists there")),
            Err(e) => Err(format!("could not create \"{name}\": {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// a name that is one folder: not a path, not hidden from the tree, and
// within what every system takes
fn folder_name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("a folder needs a name".into());
    }
    if name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        return Some(format!("\"{name}\" is not a folder name"));
    }
    if name.starts_with('.') {
        return Some("a name starting with \".\" makes a hidden folder".into());
    }
    if cfg!(windows) && (name.contains(['<', '>', ':', '"', '|', '?', '*']) || name.ends_with(['.', ' '])) {
        return Some(format!("\"{name}\" is not a folder name on Windows"));
    }
    None
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
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn thumb(state: State<'_, AppState>, caches: State<'_, Caches>, imgid: i64, size: u32,
               path: Option<String>, version: Option<i64>, proof: Option<bool>,
               foreground: Option<bool>) -> Result<bindings::Frame, String> {
    // named before the render: a sidecar written during it makes the next
    // look a miss, never a stale hit. a proofed one is not the photo's
    // thumbnail, and is not kept
    let proof = proof.unwrap_or(false);
    // browsing: Smart search leaves network drives until it stops
    state.tagged.mark_active();
    let name = path.filter(|_| !proof).and_then(|p| cache::refresh(&caches.listed, Path::new(&p), version.unwrap_or(0), size).map(|n| (p, n)));
    let thumbs = state.tagged.clone();
    let tag = thumbs.tag();
    // a file of its own, as several are built at once
    let storage = state._frame_output.clone();
    let out = storage.path(&format!("thumb-{tag}.rgba"));
    let (reply, mut pixels) = tauri::async_runtime::spawn_blocking(move || {
        let got = thumbs.request(tag, json!({ "cmd": "thumb", "imgid": imgid, "size": size, "proof": proof, "foreground": foreground.unwrap_or(false), "out": out }))
            .and_then(|reply| Ok((reply, frame_output::FrameOutput::read(&out).map_err(|e| format!("thumb: {e}"))?)));
        storage.remove(&out);
        drop(storage);
        got
    })
    .await
    .map_err(|e| e.to_string())??;
    // Native-resolution previews may come from the independent export pipe.
    // Normalize both sources to the same RGBA frame protocol.
    let reply = if reply.get("encoding").and_then(|v| v.as_str()) == Some("jpeg") {
        let image = image::load_from_memory(&pixels).map_err(|e| format!("preview: {e}"))?.to_rgba8();
        let dimensions = json!({ "width": image.width(), "height": image.height() });
        pixels = image.into_raw();
        dimensions
    } else { reply };
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
                if thumbs.write(&name, &jpeg).is_ok() && size > 0 {
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
pub(crate) async fn thumb_cached(state: State<'_, AppState>, caches: State<'_, Caches>, path: String, version: i64,
                                 size: u32) -> Result<bindings::Frame, String> {
    // browsing: Smart search leaves network drives until it stops
    state.tagged.mark_active();
    let (thumbs, listed) = (caches.thumbs.clone(), caches.listed.clone());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let photo = Path::new(&path);
        let name = cache::listed_thumb_name(&listed, photo, version, size)?;
        let bytes = thumbs.read(&name)?;
        // a cache from before known thumbnails learns them as it is read
        if size > 0 { thumbs.set_known(photo, version, size, &name); }
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
    if let (Some(index), Some(image)) = (state.search_cache.clone(), reply.get("image").cloned()) {
        tauri::async_runtime::spawn_blocking(move || index_imported_metadata(Some(&index), &Mutex::new(cache::Listed::default()), &[image]))
            .await.map_err(|e| e.to_string())?;
    }
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
    refresh_search_metadata(&state, imgid).await;
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
    state.engine("meta_set").request(req)?;
    refresh_search_metadata(&state, imgid).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn capture_times(state: State<'_, AppState>, entries: Vec<CaptureTimeEntry>) -> Result<CaptureTimesReply, String> {
    let reply = state.engine("capture_times").request(json!({ "cmd": "capture_times", "entries": entries }))?;
    let result: CaptureTimesReply = serde_json::from_value(reply).map_err(|e| format!("capture_times: unexpected reply: {e}"))?;
    for update in &result.updates {
        if update.error.is_none() {
            refresh_search_metadata(&state, update.imgid).await;
        }
    }
    Ok(result)
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
    fn create_folder_makes_one_new_folder() {
        let base = std::env::temp_dir().join(format!("immage-newfolder-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let parent = base.to_string_lossy().into_owned();
        let made = tauri::async_runtime::block_on(create_folder(parent.clone(), " Picks ".into())).unwrap();
        assert_eq!(Path::new(&made), base.join("Picks"));
        assert!(base.join("Picks").is_dir());
        // never over an existing folder, and never a path or a hidden folder
        for bad in ["Picks", "", "..", "a/b", ".hidden"] {
            assert!(tauri::async_runtime::block_on(create_folder(parent.clone(), bad.into())).is_err(), "{bad:?}");
        }
        assert!(!base.join("a").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn folder_names_are_one_visible_folder() {
        for bad in ["", ".", "..", "a/b", "a\\b", "a\0b", ".git", ".hidden"] {
            assert!(folder_name_problem(bad).is_some(), "{bad:?}");
        }
        for good in ["Picks", "2026 trip", "Été", "a.b", "-x", "x."] {
            assert_eq!(folder_name_problem(good), None, "{good:?}");
        }
        // only spaces trim to nothing
        let base = std::env::temp_dir().join(format!("immage-newfolder-names-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let parent = base.to_string_lossy().into_owned();
        assert!(tauri::async_runtime::block_on(create_folder(parent.clone(), "   ".into())).is_err());
        // a parent that is not there is an error, not a created tree
        let gone = base.join("not").join("here").to_string_lossy().into_owned();
        assert!(tauri::async_runtime::block_on(create_folder(gone, "x".into())).is_err());
        assert!(!base.join("not").exists());
        // a file in the way reads as already there
        std::fs::write(base.join("file"), b"").unwrap();
        let e = tauri::async_runtime::block_on(create_folder(parent, "file".into())).unwrap_err();
        assert!(e.contains("already exists"), "{e}");
        std::fs::remove_dir_all(&base).unwrap();
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
    fn photo_candidates_include_raw_and_optional_formats() {
        for name in ["photo.ORF", "photo.cr3", "photo.JpEg", "photo.gpr", "photo.HEIC",
                     "photo.avif", "photo.jxl", "photo.exr", "photo.pfm", "photo.jp2"] {
            assert!(photo_candidate(Path::new(name)), "{name}");
        }
        for name in ["photo.ACR", "photo.orf.xmp", "photo.jpg.txt", "notes", "movie.MOV", "data.json"] {
            assert!(!photo_candidate(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn superseded_read_does_not_publish_listing() {
        let shared = Mutex::new(cache::Listed::default());
        let mut stale = cache::Listed::default();
        stale.stalled.push(PathBuf::from("/stale"));
        assert!(!publish_listing(&shared, stale.clone(), || false));
        assert!(shared.lock().unwrap().stalled.is_empty());
        assert!(publish_listing(&shared, stale, || true));
        assert!(shared.lock().unwrap().stalled.contains(&PathBuf::from("/stale")));
    }

    /// Cache lookup/listing costs only; no engine extraction or GUI timing.
    #[test]
    #[ignore = "manual metadata cache benchmark"]
    fn benchmark_warm_folder_metadata() {
        let dir=tempfile::tempdir().unwrap();let photos=dir.path().join("photos");std::fs::create_dir(&photos).unwrap();
        let index=crate::search_cache::SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let fixture:Value=serde_json::from_str(include_str!("../tests/engine-replies/import.json")).unwrap();
        let mut metadata=Vec::new();
        for n in 0..1000 { let path=photos.join(format!("photo-{n:04}.jpg"));std::fs::write(&path,b"synthetic source").unwrap();
            let mut image=fixture[2]["reply"]["images"][0].clone();image["path"]=json!(path);image["filename"]=json!(path.file_name().unwrap().to_str().unwrap());image["version"]=json!(0);image["copy"]=json!(false);metadata.push(image); }
        let listing=|| {let mut listed=cache::Listed::default();let mut paths=Vec::new();folder_files(&photos,false,&HashSet::new(),&mut paths,&mut listed);(paths,Mutex::new(listed))};
        let (paths,listed)=listing();let start=Instant::now();
        assert!(paths.iter().all(|p|cached_folder_metadata(Some(&index),&listed,p).is_none()));
        let misses=start.elapsed().as_secs_f64()*1000.0;
        index_imported_metadata(Some(&index),&listed,&metadata);
        let mut times=Vec::new();
        for _ in 0..6 {let start=Instant::now();let (paths,listed)=listing();assert!(paths.iter().all(|p|cached_folder_metadata(Some(&index),&listed,p).is_some()));times.push(start.elapsed().as_secs_f64()*1000.0);}
        let first=times.remove(0);times.sort_by(f64::total_cmp);
        eprintln!("FOLDER_CACHE_BENCH rows=1000 missing_lookup_ms={misses:.3} first_warm_ms={first:.3} warm_median_ms={:.3} warm_samples_ms={times:?} debug={}",times[2],cfg!(debug_assertions));
    }

    #[test]
    fn precise_capture_retains_fraction_and_known_offset_without_inventing_timezone() {
        let mut image=json!({"exif":{"datetime":"2026:11:15 12:34:56.123","capture_time_raw":"2026:11:15 12:34:56.123456789","capture_offset":"-07:30"}});
        let (ns,raw,offset)=precise_capture(&image);
        assert_eq!(raw.as_deref(),Some("2026:11:15 12:34:56.123456789"));assert_eq!(offset,Some(-27000));
        assert_eq!(ns,chrono::DateTime::parse_from_rfc3339("2026-11-15T12:34:56.123456789-07:30").unwrap().timestamp_nanos_opt());
        image["exif"]["capture_offset"]=json!("");let (ns,raw,offset)=precise_capture(&image);assert!(ns.is_none()&&offset.is_none());assert!(raw.unwrap().ends_with("123456789"));
        image["exif"]["datetime"]=json!("2026:11:16 12:34:56");image["exif"]["capture_offset"]=json!("+01:00");
        let (ns,raw,offset)=precise_capture(&image);assert_eq!(raw.as_deref(),Some("2026:11:16 12:34:56"));assert!(ns.is_none()&&offset.is_none());
        image["exif"]["datetime"]=json!("");assert_eq!(precise_capture(&image),(None,None,None));
    }

    #[test]
    fn warm_metadata_requires_current_source_all_copies_and_raster_masks() {
        let temp = tempfile::tempdir().unwrap();
        let photo = temp.path().join("a.tif");
        std::fs::write(&photo, b"pixels").unwrap();
        std::fs::write(temp.path().join("a.tif.xmp"), b"original edit").unwrap();
        let index = crate::search_cache::SearchCache::open(&temp.path().join("cache.sqlite")).unwrap();
        let fixture: Value = serde_json::from_str(include_str!("../tests/engine-replies/import.json")).unwrap();
        let mut original = fixture[2]["reply"]["images"][0].clone();
        original["path"] = json!(photo); original["filename"] = json!("a.tif");
        let listing = || {
            let mut listed = cache::Listed::default(); let mut files = Vec::new();
            folder_files(temp.path(), false, &HashSet::new(), &mut files, &mut listed);
            Mutex::new(listed)
        };
        let listed = listing();
        assert!(cached_folder_metadata(Some(&index), &listed, &photo).is_none());
        index_imported_metadata(Some(&index), &listed, std::slice::from_ref(&original));
        let warm = cached_folder_metadata(Some(&index), &listed, &photo).unwrap();
        assert_eq!(warm.len(), 1); assert!(warm[0].get("imgid").is_none());
        assert_eq!(warm[0]["exif"], original["exif"]);
        assert!(cached_folder_metadata(None, &listed, &photo).is_none());
        // The listing used by the previous folder remains owned and immutable.
        std::fs::write(temp.path().join("a_02.tif.xmp"), b"copy").unwrap();
        assert!(cached_folder_metadata(Some(&index), &listing(), &photo).is_none());
        let mut copy = original.clone(); copy["version"] = json!(2); copy["copy"] = json!(true);
        index_imported_metadata(Some(&index), &listing(), &[original.clone(), copy.clone()]);
        assert_eq!(cached_folder_metadata(Some(&index), &listing(), &photo).unwrap().len(), 2);
        std::fs::write(temp.path().join("a_02.tif.dtdata"), b"new raster mask").unwrap();
        assert!(cached_folder_metadata(Some(&index), &listing(), &photo).is_none());
        index_imported_metadata(Some(&index), &listing(), &[original.clone(), copy]);
        assert!(cached_folder_metadata(Some(&index), &listing(), &photo).is_some());
        std::fs::remove_file(temp.path().join("a_02.tif.xmp")).unwrap();
        assert!(cached_folder_metadata(Some(&index), &listing(), &photo).is_none());
        std::fs::write(&photo, b"changed source bytes").unwrap();
        assert!(cached_folder_metadata(Some(&index), &listing(), &photo).is_none());
    }

    #[test]
    fn unavailable_search_cache_does_not_block_folder_metadata_or_engine_ids() {
        let metadata = vec![json!({"imgid": 314, "path":"/unavailable/cache/photo.jpg", "version":0,
                                  "exif":{"datetime":"2026:01:02 03:04:05"}})];
        index_imported_metadata(None, &std::sync::Mutex::new(cache::Listed::default()), &metadata);
        assert_eq!(metadata[0]["imgid"], 314);
        assert_eq!(metadata[0]["path"], "/unavailable/cache/photo.jpg");
    }

    #[test]
    fn imported_metadata_is_cached_without_engine_ids_and_tracks_sidecar_stamp() {
        let dir = std::env::temp_dir().join(format!("immage-index-metadata-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("a.jpg");
        std::fs::write(&photo, b"original pixels").unwrap();
        let cache_path = dir.join("search.sqlite");
        let index = crate::search_cache::SearchCache::open(&cache_path).unwrap();
        let mut listed = cache::Listed::default();
        let mut files = Vec::new();
        folder_files(&dir, false, &HashSet::new(), &mut files, &mut listed);
        let listed = std::sync::Mutex::new(listed);
        let image = json!({"imgid":987654,"path":photo,"version":0,"edited":false,
                           "exif":{"datetime":"2025:02:03 04:05:06"},"rating":3});
        index_imported_metadata(Some(&index), &listed, std::slice::from_ref(&image));
        let original = index.variant(photo.to_str().unwrap(), "").unwrap().unwrap();
        let saved: Value = serde_json::from_str(&index.metadata(original.id).unwrap().unwrap()).unwrap();
        assert!(saved.get("imgid").is_none());
        assert_eq!(saved["exif"]["datetime"], "2025:02:03 04:05:06");
        assert_eq!(original.capture_time_raw.as_deref(), Some("2025:02:03 04:05:06"));

        std::fs::write(photo.with_file_name("a.jpg.xmp"), b"edit sidecar").unwrap();
        let mut listed2 = cache::Listed::default();
        let mut files2 = Vec::new();
        folder_files(&dir, false, &HashSet::new(), &mut files2, &mut listed2);
        index_imported_metadata(Some(&index), &std::sync::Mutex::new(listed2), std::slice::from_ref(&image));
        let updated = index.variant(photo.to_str().unwrap(), "").unwrap().unwrap();
        assert_eq!(updated.asset_id, original.asset_id);
        assert_ne!(updated.edited_fingerprint, original.edited_fingerprint);
        drop(index);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn folder_files_order_and_skips() {
        let dir = repo_root().join(format!("build/scratch/folder-files-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in ["b.jpg", "A.CR3", "a.cr3.xmp", "a.ACR", "notes.txt", "movie.mp4", "no-extension",
                  "sub/settings.acr", "sub/readme.pdf", ".hidden/x.jpg", "sub/c.jpg", "Photos Library.photoslibrary/d.jpg"] {
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

    // the split sends only the paths the predicate calls network to direct
    // deletion; nothing here touches the disk or the user's Trash
    #[test]
    fn network_files_are_split_from_trashable_ones() {
        let items = vec![PathBuf::from("/mnt/nas/a.arw"), PathBuf::from("/home/me/b.arw"), PathBuf::from("/mnt/nas/a.arw.xmp")];
        let (network, local) = split_network(items, |p| p.starts_with("/mnt/nas"));
        assert_eq!(network, vec![PathBuf::from("/mnt/nas/a.arw"), PathBuf::from("/mnt/nas/a.arw.xmp")]);
        assert_eq!(local, vec![PathBuf::from("/home/me/b.arw")]);
    }

    #[test]
    fn refreshed_mutation_metadata_is_searchable_without_folder_reimport() {
        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("edited.jpg");
        std::fs::write(&photo, b"disposable photo bytes").unwrap();
        let index = crate::search_cache::SearchCache::open(&dir.path().join("search.sqlite")).unwrap();
        let fixture: Value = serde_json::from_str(include_str!("../tests/engine-replies/import.json")).unwrap();
        let mut image = fixture[2]["reply"]["images"][0].clone();
        image["imgid"] = json!(712);
        image["path"] = json!(photo);
        image["filename"] = json!("edited.jpg");
        image["version"] = json!(0);
        image["copy"] = json!(false);
        image["rating"] = json!(2);
        image["keywords"] = json!(["Places|Old"]);
        index_imported_metadata(Some(&index), &Mutex::new(cache::Listed::default()), std::slice::from_ref(&image));

        let other = dir.path().join("other.jpg");
        std::fs::write(&other, b"another disposable photo").unwrap();
        let mut other_image = image.clone();
        other_image["path"] = json!(other);
        other_image["filename"] = json!("other.jpg");
        other_image["rating"] = json!(1);
        other_image["keywords"] = json!(["Places|Other"]);
        index_imported_metadata(Some(&index), &Mutex::new(cache::Listed::default()), std::slice::from_ref(&other_image));

        let mut args = crate::local_search::LocalSearchArgs::default();
        args.filters.min_rating = 2;
        args.filters.keywords = vec!["Places|Old".into()];
        let root = dir.path().to_path_buf();
        let page = crate::local_search::retrieve(&index, &args, &[root.clone()], &[], None, || false).unwrap();
        assert_eq!(page.items.len(), 1);

        // This mirrors Engine::Link after a successful native sidecar mutation.
        let stale_same_photo = mutation_metadata_snapshot(&index, photo.to_str().unwrap(), "").unwrap().unwrap();
        std::fs::write(dir.path().join("edited.jpg.xmp"), b"updated rating and keywords").unwrap();
        index.invalidate_edited(photo.to_str().unwrap(), "").unwrap();
        assert!(!cache_mutation_metadata(&index, &stale_same_photo, &image).unwrap(),
            "a reply from before the mutation must not publish");
        args.filters.min_rating = 5;
        args.filters.keywords = vec!["Places|Updated".into()];
        assert!(crate::local_search::retrieve(&index, &args, &[root.clone()], &[], None, || false)
            .unwrap().items.is_empty());

        image["rating"] = json!(5);
        image["keywords"] = json!(["Places|Updated"]);
        let current_snapshot = mutation_metadata_snapshot(&index, photo.to_str().unwrap(), "").unwrap().unwrap();
        assert_ne!(metadata_refresh_key(&stale_same_photo), metadata_refresh_key(&current_snapshot),
            "each save/open invalidation generation must get a distinct queue key");
        // A concurrent metadata change in another photo must not drop this
        // photo's independent, fingerprint-guarded refresh.
        index.invalidate_edited(other.to_str().unwrap(), "").unwrap();
        assert!(cache_mutation_metadata(&index, &current_snapshot, &image).unwrap());
        let page = crate::local_search::retrieve(&index, &args, &[root], &[], None, || false).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].image.rating, 5);
        assert_eq!(page.items[0].image.keywords, ["Places|Updated"]);

        let stale_clear = mutation_metadata_snapshot(&index, photo.to_str().unwrap(), "").unwrap().unwrap();
        index.clear().unwrap();
        assert!(!cache_mutation_metadata(&index, &stale_clear, &image).unwrap(),
            "a late response must not recreate a cleared cache row");
        assert_eq!(index.counts().unwrap().variants, 0);
    }
}
