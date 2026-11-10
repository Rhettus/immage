// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Edit In: a photo handed to another application (DxO PureRAW, and later
// panorama, HDR and stacking tools) and the file it writes taken back, as
// Lightroom's plug-ins do. the application is started with the files, and
// the folders it writes to are watched by polling until each photo has its
// result. a result is remembered with its original, so the filmstrip shows
// it beside that photo wherever the application put it
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct Plugins {
    returns_path: PathBuf,
    // the plugins the user set up (plugins.json). only Rust writes it, and
    // the program path in it is set by nothing the page can fake: see
    // set_app, store_app and the migration in config
    config_path: PathBuf,
    // the applications plugin_find_apps returned this run, the only paths
    // plugin_set_app takes
    offered: Mutex<HashSet<String>>,
    // one reader or writer of the configuration at a time
    config_io: Mutex<()>,
    // Macro Studio's jobs, each in a folder of its own, and the ledger of
    // those whose results may still come (pending.json)
    jobs_dir: PathBuf,
    // the hand-offs still waiting, by token; a cancelled one leaves
    live: Mutex<HashSet<u64>>,
    // one reader or writer of the returns file at a time
    io: Mutex<()>,
    // and of the ledger
    jobs_io: Mutex<()>,
}

impl Plugins {
    pub fn new(returns_path: PathBuf) -> Self {
        let jobs_dir = returns_path.with_file_name("plugin-jobs");
        let config_path = returns_path.with_file_name("plugins.json");
        Plugins { returns_path, config_path, offered: Mutex::new(HashSet::new()), config_io: Mutex::new(()),
                  jobs_dir, live: Mutex::new(HashSet::new()), io: Mutex::new(()), jobs_io: Mutex::new(()) }
    }

    // None when there is no file yet; a file that does not parse is as good
    // as an empty one, but still there, so nothing is migrated over it
    fn config_read(&self) -> Option<Vec<PluginConfig>> {
        let text = std::fs::read_to_string(&self.config_path).ok()?;
        Some(serde_json::from_str(&text).unwrap_or_default())
    }

    fn config_write(&self, list: &[PluginConfig]) -> Result<(), String> {
        let tmp = self.config_path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("plugin settings: {e}"))?;
        std::fs::rename(&tmp, &self.config_path).map_err(|e| format!("plugin settings: {e}"))
    }

    // the plugins. the page's old localStorage list (`legacy`) is taken once,
    // when there is no plugins.json yet, and the file is made even when the
    // page has none, so the program paths in a later call are never believed.
    // a file there already is never overwritten
    pub fn config(&self, legacy: Option<Vec<PluginConfig>>) -> Result<Vec<PluginConfig>, String> {
        let _io = self.config_io.lock().unwrap();
        if let Some(list) = self.config_read() {
            return Ok(list);
        }
        let mut list: Vec<PluginConfig> = Vec::new();
        for p in legacy.unwrap_or_default() {
            if !p.id.is_empty() && !list.iter().any(|o| o.id == p.id) {
                list.push(p);
            }
        }
        self.config_write(&list)?;
        Ok(list)
    }

    // the page's edits to the list (names, choices, additions, removals). a
    // program path is kept from what is stored, by id, and is empty for a
    // new plugin: the page cannot set one here
    pub fn config_save(&self, list: Vec<PluginConfig>) -> Result<Vec<PluginConfig>, String> {
        let _io = self.config_io.lock().unwrap();
        let stored = self.config_read().unwrap_or_default();
        let mut out: Vec<PluginConfig> = Vec::new();
        for mut p in list {
            if p.id.is_empty() || out.iter().any(|o| o.id == p.id) {
                continue;
            }
            p.app = stored.iter().find(|o| o.id == p.id).map(|o| o.app.clone()).unwrap_or_default();
            out.push(p);
        }
        self.config_write(&out)?;
        Ok(out)
    }

    fn put_app(&self, id: &str, path: &str) -> Result<Vec<PluginConfig>, String> {
        let _io = self.config_io.lock().unwrap();
        let mut list = self.config_read().unwrap_or_default();
        list.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("unknown plugin {id}"))?.app = path.into();
        self.config_write(&list)?;
        Ok(list)
    }

    // an application plugin_find_apps returned this run
    pub fn set_app(&self, id: &str, path: &str) -> Result<Vec<PluginConfig>, String> {
        if !self.offered.lock().unwrap().contains(path) {
            return Err(format!("{path} was not found as an application"));
        }
        self.put_app(id, path)
    }

    fn ready_id(&self, id: &str) -> Result<(), String> {
        let _io = self.config_io.lock().unwrap();
        self.config_read().unwrap_or_default().iter().any(|p| p.id == id).then_some(())
            .ok_or_else(|| format!("unknown plugin {id}"))
    }

    // the plugin an id names, with its application chosen
    fn ready(&self, id: &str) -> Result<PluginConfig, String> {
        let _io = self.config_io.lock().unwrap();
        let p = self.config_read().unwrap_or_default().into_iter().find(|p| p.id == id)
            .ok_or_else(|| format!("unknown plugin {id}"))?;
        if p.app.is_empty() {
            return Err("choose its application in Preferences".into());
        }
        Ok(p)
    }

    fn load(&self) -> Vec<Return> {
        std::fs::read_to_string(&self.returns_path).ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    // written beside and renamed over, so a crash never leaves half a file
    fn store(&self, returns: &[Return]) -> Result<(), String> {
        let tmp = self.returns_path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(returns).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("plugin returns: {e}"))?;
        std::fs::rename(&tmp, &self.returns_path).map_err(|e| format!("plugin returns: {e}"))
    }

    // a result remembered with its original, in place of an earlier record
    // of the same file
    pub fn record(&self, r: Return) -> Result<(), String> {
        let _io = self.io.lock().unwrap();
        let mut returns = self.load();
        returns.retain(|o| o.result != r.result);
        returns.push(r);
        self.store(&returns)
    }

    // a result remembered unless it is already, so a stack saved again to
    // the same file keeps what its first open did
    fn record_new(&self, r: Return) -> Result<(), String> {
        let _io = self.io.lock().unwrap();
        let mut returns = self.load();
        if returns.iter().any(|o| o.result == r.result) {
            return Ok(());
        }
        returns.push(r);
        self.store(&returns)
    }

    // each result whose original is among a folder's files moves to just
    // after it, or joins it there when it lives in a folder not being read
    // (PureRAW's DxO subfolder). results deleted since are forgotten, of
    // this folder's originals only: a result on a share that has gone away
    // blocks its stat in the kernel for good, and every folder after it
    pub fn beside_originals(&self, files: &mut Vec<PathBuf>) {
        let _io = self.io.lock().unwrap();
        let mut returns = self.load();
        let before = returns.len();
        returns.retain(|r| !files.iter().any(|f| f == Path::new(&r.original)) || Path::new(&r.result).is_file());
        if returns.len() != before {
            let _ = self.store(&returns);
        }
        for r in &returns {
            let (original, result) = (Path::new(&r.original), Path::new(&r.result));
            if !files.iter().any(|f| f == original) {
                continue;
            }
            files.retain(|f| f != result);
            let at = files.iter().position(|f| f == original).unwrap();
            // after the original and any result already put there
            let mut at = at + 1;
            while at < files.len() && returns.iter().any(|o| o.original == r.original && Path::new(&o.result) == files[at]) {
                at += 1;
            }
            files.insert(at, result.to_path_buf());
        }
    }
}

// a plugin as Preferences shows it (plugins.ts, PluginConfig)
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginConfig {
    pub id: String,
    pub kind: String,
    pub name: String,
    // the application's path; "" until chosen
    pub app: String,
    pub send: String,
    pub output_dir: String,
    pub on_return: HashMap<String, bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub look: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Return {
    pub original: String,
    pub result: String,
    pub plugin: String,
    // whether its first open has had the plugin's settings (Lens off...)
    #[serde(default)]
    pub applied: bool,
}

// a file or folder name against a pattern whose * stands for anything,
// ignoring case
fn glob(pattern: &str, name: &str) -> bool {
    let (p, n) = (pattern.to_lowercase(), name.to_lowercase());
    let parts: Vec<&str> = p.split('*').collect();
    if parts.len() == 1 {
        return p == n;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !n.starts_with(first) || n.len() < first.len() + last.len() || !n.ends_with(last) {
        return false;
    }
    let mut rest = &n[first.len()..n.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(i) => rest = &rest[i + part.len()..],
            None => return false,
        }
    }
    true
}

// every path under `base` matching a pattern of /- or \-separated parts
fn find(base: &Path, parts: &[&str], out: &mut Vec<PathBuf>) {
    let Some((part, rest)) = parts.split_first() else { return };
    let Ok(rd) = std::fs::read_dir(base) else { return };
    for e in rd.flatten() {
        if !glob(part, &e.file_name().to_string_lossy()) {
            continue;
        }
        if rest.is_empty() {
            out.push(e.path());
        } else {
            find(&e.path(), rest, out);
        }
    }
}

fn app_folders() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(target_os = "macos") {
        v.push(PathBuf::from("/Applications"));
        if let Some(home) = std::env::var_os("HOME") {
            v.push(PathBuf::from(home).join("Applications"));
        }
    } else if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(var) {
                v.push(PathBuf::from(p));
            }
        }
        // where a per-user installer puts it (Macro Studio's)
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            v.push(PathBuf::from(p).join("Programs"));
        }
    }
    v
}

// the installed applications a plugin kind can use, newest version first
// (the highest name: "DxO PureRAW 5" before "DxO PureRAW 4")
#[tauri::command]
pub fn plugin_find_apps(state: State<'_, Plugins>, patterns: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for base in app_folders() {
        for p in &patterns {
            let parts: Vec<&str> = p.split(['/', '\\']).filter(|s| !s.is_empty()).collect();
            find(&base, &parts, &mut out);
        }
    }
    let mut out: Vec<String> = out.into_iter().map(|p| p.to_string_lossy().into_owned()).collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.to_lowercase()));
    out.dedup();
    state.offered.lock().unwrap().extend(out.iter().cloned());
    out
}

// the page's plugins, from plugins.json. `legacy` is what it kept in
// localStorage before Rust owned them: used only for the first run
#[tauri::command]
pub fn plugin_config(state: State<'_, Plugins>, legacy: Option<Vec<PluginConfig>>) -> Result<Vec<PluginConfig>, String> {
    state.config(legacy)
}

#[tauri::command]
pub fn plugin_config_save(state: State<'_, Plugins>, list: Vec<PluginConfig>) -> Result<Vec<PluginConfig>, String> {
    state.config_save(list)
}

#[tauri::command]
pub fn plugin_set_app(state: State<'_, Plugins>, id: String, path: String) -> Result<Vec<PluginConfig>, String> {
    state.set_app(&id, &path)
}

// the file dialog is opened here, so what is stored is what the user picked
// and not a path the page names. none when it is cancelled
#[tauri::command]
pub async fn plugin_choose_app(app: AppHandle, state: State<'_, Plugins>, id: String)
    -> Result<Option<Vec<PluginConfig>>, String> {
    state.ready_id(&id)?;
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = handle.dialog().file();
        dialog = if cfg!(windows) {
            dialog.add_filter("Applications", &["exe"])
        } else {
            dialog.set_directory("/Applications").add_filter("Applications", &["app"])
        };
        dialog.blocking_pick_file().and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        Some(path) => app.state::<Plugins>().put_app(&id, &path.to_string_lossy()).map(Some),
        None => Ok(None),
    }
}

const PHOTO_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jpe", "tif", "tiff", "heic", "heif", "hif", "png", "avif", "webp", "jxl", "exr", "pfm",
    "ppm", "pgm", "pnm", "gif", "j2k", "jp2", "qoi", "bmp",
];

// a file a plugin may be given: an existing regular file with a photo
// extension. symlinks are resolved first, so a link named like a photo
// that points at a folder or another kind of file is refused
fn photo_file(path: &str) -> Result<(), String> {
    let real = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    if !real.is_file() {
        return Err(format!("{path} is not a file"));
    }
    let ext = real.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !PHOTO_EXTENSIONS.contains(&ext.as_str()) && !crate::immich_search::RAW_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("{path} is not a photo"));
    }
    Ok(())
}

// the application started with the files, or given them when it runs
// already: on macOS through `open -a`, as a drop on its Dock icon is
#[tauri::command]
pub async fn plugin_launch(state: State<'_, Plugins>, id: String, files: Vec<String>) -> Result<(), String> {
    let app_path = state.ready(&id)?.app;
    for f in &files {
        photo_file(f)?;
    }
    let name = app_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if cfg!(target_os = "macos") {
            let out = std::process::Command::new("open").arg("-a").arg(&app_path).args(&files)
                .output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
        } else {
            std::process::Command::new(&app_path).args(&files).spawn().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("could not start {name}: {e}"))
}

#[derive(Deserialize)]
pub struct Watch {
    token: u64,
    plugin: String,
    sources: Vec<String>,
    // the result's extensions, without the dot
    exts: Vec<String>,
    // "prefix": one result per source, named from it; "any": one result for
    // the lot (a panorama of several photos), given to the first
    #[serde(rename = "match")]
    match_: String,
    // looked in beside each source ("" is the source's own folder)
    subfolders: Vec<String>,
    // Preferences' Results folder, as editIn names it
    #[serde(rename = "outputDir")]
    output_dir: Option<String>,
    // files the hand-off wrote itself (TIFFs sent), never a result
    #[serde(default)]
    ignore: Vec<String>,
}

const POLL: Duration = Duration::from_secs(2);
const GIVE_UP: Duration = Duration::from_secs(3 * 3600);

fn stem(p: &Path) -> String {
    p.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}

// the source a result is named from: the longest stem it starts with, where
// the stem ends at a break in the name, so IMG_10's result is not IMG_1's
fn named_from<'a>(result: &Path, sources: &'a [PathBuf]) -> Option<&'a PathBuf> {
    let name = stem(result);
    sources.iter()
        .filter(|s| {
            let st = stem(s);
            name.starts_with(&st) && name[st.len()..].chars().next().is_none_or(|c| !c.is_alphanumeric())
        })
        .max_by_key(|s| stem(s).len())
}

// the folders' files with a result's extension, with their times and sizes
fn scan(dirs: &[PathBuf], exts: &[String], ignore: &HashSet<PathBuf>) -> HashMap<PathBuf, (SystemTime, u64)> {
    let mut out = HashMap::new();
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_lowercase();
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if name.starts_with('.') || !exts.iter().any(|x| x.eq_ignore_ascii_case(&ext)) || ignore.contains(&p) {
                continue;
            }
            if let Ok(m) = e.metadata() {
                if m.is_file() {
                    out.insert(p, (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()));
                }
            }
        }
    }
    out
}

// waits in the background for the application's results: each is
// remembered and announced as "plugin-returned" once its size has held
// still for a poll, and "plugin-watch-end" says why the wait ended
// (done, cancelled or timeout)
#[tauri::command]
pub fn plugin_watch(app: AppHandle, state: State<'_, Plugins>, watch: Watch) -> Result<(), String> {
    state.ready(&watch.plugin)?;
    state.live.lock().unwrap().insert(watch.token);
    std::thread::spawn(move || {
        let plugins = app.state::<Plugins>();
        let sources: Vec<PathBuf> = watch.sources.iter().map(PathBuf::from).collect();
        let mut dirs: Vec<PathBuf> = Vec::new();
        for s in &sources {
            let parent = s.parent().map(Path::to_path_buf).unwrap_or_default();
            for sub in &watch.subfolders {
                let d = if sub.is_empty() { parent.clone() } else { parent.join(sub) };
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
            }
        }
        if let Some(d) = watch.output_dir.as_ref().filter(|d| !d.is_empty()).map(PathBuf::from) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
        let mut ignore: HashSet<PathBuf> = watch.ignore.iter().map(PathBuf::from).collect();
        ignore.extend(sources.iter().cloned());
        // what was there before: only a new file, or one written again, counts
        let seen = scan(&dirs, &watch.exts, &ignore);
        let mut last_size: HashMap<PathBuf, u64> = HashMap::new();
        let mut done: HashSet<PathBuf> = HashSet::new();
        let any = watch.match_ == "any";
        let started = Instant::now();
        let reason = loop {
            std::thread::sleep(POLL);
            if !plugins.live.lock().unwrap().contains(&watch.token) {
                break "cancelled";
            }
            if started.elapsed() > GIVE_UP {
                break "timeout";
            }
            let now = scan(&dirs, &watch.exts, &ignore);
            let mut fresh: Vec<(PathBuf, u64)> = now.into_iter()
                .filter(|(p, (t, _))| seen.get(p).is_none_or(|(t0, _)| t > t0))
                .map(|(p, (_, size))| (p, size))
                .collect();
            fresh.sort();
            for (path, size) in fresh {
                // still being written while it grows
                let steady = size > 0 && last_size.get(&path) == Some(&size);
                last_size.insert(path.clone(), size);
                if !steady {
                    continue;
                }
                let original = if any {
                    sources.first()
                } else {
                    named_from(&path, &sources).filter(|s| !done.contains(*s))
                };
                let Some(original) = original.cloned() else { continue };
                ignore.insert(path.clone());
                done.insert(original.clone());
                let r = Return {
                    original: original.to_string_lossy().into_owned(),
                    result: path.to_string_lossy().into_owned(),
                    plugin: watch.plugin.clone(),
                    applied: false,
                };
                if let Err(e) = plugins.record(r.clone()) {
                    eprintln!("{e}");
                }
                let _ = app.emit("plugin-returned", json!({
                    "token": watch.token, "plugin": r.plugin, "original": r.original, "result": r.result,
                }));
            }
            if (any && !done.is_empty()) || done.len() == sources.len() {
                break "done";
            }
        };
        plugins.live.lock().unwrap().remove(&watch.token);
        let _ = app.emit("plugin-watch-end", json!({ "token": watch.token, "reason": reason }));
    });
    Ok(())
}

#[tauri::command]
pub fn plugin_cancel(state: State<'_, Plugins>, token: u64) {
    state.live.lock().unwrap().remove(&token);
}

// every result taken back, with its original and plugin
#[tauri::command]
pub fn plugin_returns(state: State<'_, Plugins>) -> Vec<Return> {
    let _io = state.io.lock().unwrap();
    state.load()
}

// a result's first open has had its plugin's settings
#[tauri::command]
pub fn plugin_return_applied(state: State<'_, Plugins>, result: String) -> Result<(), String> {
    let _io = state.io.lock().unwrap();
    let mut returns = state.load();
    for r in returns.iter_mut().filter(|r| r.result == result) {
        r.applied = true;
    }
    state.store(&returns)
}

// Macro Studio, for focus stacking, speaks a protocol of its own, the one
// its Lightroom, Bridge and Capture One plugins use: a job manifest handed
// to the app, and a receipt it appends a line to as each stack is made and
// saved. both are defined in its bundle, macrostack/host_bridge/manifest.py
// (v1) and receipt.py (v1). Immage asks for review mode: each stack opens in
// Macro Studio's editor, and is reported only when the user saves it there,
// which can be long after the job itself is complete. so a job is kept in a
// ledger until every stack is saved or closed, and drained when a folder is
// read, for the saves that come after the watch has ended

const MS_RECEIPT_VERSION: u64 = 1;
const MS_POLL: Duration = Duration::from_secs(1);
// no record at all: the app never started, or never took the job
const MS_STARTUP: Duration = Duration::from_secs(90);
// it appends a heartbeat every 30 s while it stacks, so this much silence
// before the job is complete means it is gone
const MS_STALL: Duration = Duration::from_secs(300);
// a job left in the ledger this long is given up
const MS_KEEP_SECS: u64 = 30 * 86400;

#[derive(Deserialize, Serialize)]
pub struct StackFile {
    path: String,
    // the photo a TIFF sent was written from, which names and places the result
    #[serde(default, skip_serializing_if = "Option::is_none")]
    origin_path: Option<String>,
}

#[derive(Deserialize)]
pub struct Job {
    token: u64,
    plugin: String,
    // "original-raw" or "rendered" (TIFFs)
    mode: String,
    files: Vec<StackFile>,
    // "natural" or "enhanced"; none for the app's own default
    look: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct Pending {
    job_id: String,
    token: u64,
    plugin: String,
    receipt: String,
    dir: String,
    started: u64,
}

fn manifest_json(job: &Job, job_id: &str, receipt: &Path, host_version: &str) -> serde_json::Value {
    let mut m = json!({
        "version": 1,
        "job_id": job_id,
        "host": "immage",
        "host_version": host_version,
        "mode": job.mode,
        "files": job.files,
        "return_mode": "review",
        "receipt_path": receipt.to_string_lossy(),
    });
    if let Some(look) = job.look.as_deref().filter(|l| *l == "natural" || *l == "enhanced") {
        m["look"] = json!(look);
    }
    m
}

// the receipt's records; a line that does not parse is the one being
// written, and is read again next time
fn receipt_records(path: &Path) -> Vec<serde_json::Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|r| r.is_object())
        .collect()
}

fn kind_of(r: &serde_json::Value) -> &str {
    r["type"].as_str().unwrap_or("")
}

// the stacks open in Macro Studio and neither saved nor closed, by index:
// a stack saved twice is still one stack
fn outstanding(records: &[serde_json::Value]) -> usize {
    let (mut ready, mut settled) = (HashSet::new(), HashSet::new());
    for r in records {
        let i = r["stack_index"].as_i64().unwrap_or(0);
        match kind_of(r) {
            "stack_ready" => { ready.insert(i); }
            "stack_done" | "stack_error" => { settled.insert(i); }
            _ => {}
        }
    }
    ready.difference(&settled).count()
}

// job_complete or job_error, once the app is done with the job's stacking
fn terminal(records: &[serde_json::Value]) -> Option<&serde_json::Value> {
    records.iter().find(|r| matches!(kind_of(r), "job_complete" | "job_error"))
}

// a saved stack's file, with the first photo it was made from
fn saved(r: &serde_json::Value, plugin: &str) -> Option<Return> {
    if kind_of(r) != "stack_done" {
        return None;
    }
    let result = r["output_path"].as_str()?;
    let original = r["origin_paths"].get(0).or_else(|| r["source_paths"].get(0))?.as_str()?;
    Some(Return { original: original.into(), result: result.into(), plugin: plugin.into(), applied: false })
}

// the app the job goes to: the one chosen in Preferences, else where Macro
// Studio says it lives (it writes host-integration.json on every launch)
fn ms_executable(chosen: &str) -> Option<PathBuf> {
    let p = PathBuf::from(chosen);
    let p = if p.extension().is_some_and(|x| x == "app") { p.join("Contents/MacOS/MacroStudio") } else { p };
    if p.is_file() {
        return Some(p);
    }
    let integration = if cfg!(windows) {
        PathBuf::from(std::env::var_os("APPDATA")?).join("MacroStudio")
    } else {
        PathBuf::from(std::env::var_os("HOME")?).join("Library/Application Support/MacroStudio")
    }
    .join("host-integration.json");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(integration).ok()?).ok()?;
    Some(PathBuf::from(v["app_path"].as_str()?)).filter(|p| p.is_file())
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Plugins {
    fn ledger_path(&self) -> PathBuf {
        self.jobs_dir.join("pending.json")
    }

    fn ledger(&self) -> Vec<Pending> {
        std::fs::read_to_string(self.ledger_path()).ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    fn store_ledger(&self, list: &[Pending]) -> Result<(), String> {
        let path = self.ledger_path();
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, text).map_err(|e| format!("plugin jobs: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("plugin jobs: {e}"))
    }

    fn remember_job(&self, p: Pending) -> Result<(), String> {
        let _io = self.jobs_io.lock().unwrap();
        let mut list = self.ledger();
        list.push(p);
        self.store_ledger(&list)
    }

    // every stack saved since, taken back; a job whose stacks are all saved
    // or closed, or that never started, is retired with its folder. a job
    // still being watched is left to its watcher
    pub fn drain_jobs(&self) {
        let _io = self.jobs_io.lock().unwrap();
        let list = self.ledger();
        if list.is_empty() {
            return;
        }
        let live = self.live.lock().unwrap().clone();
        let now = now_secs();
        let mut keep = Vec::new();
        for p in list {
            if live.contains(&p.token) {
                keep.push(p);
                continue;
            }
            let records = receipt_records(Path::new(&p.receipt));
            for r in records.iter().filter_map(|r| saved(r, &p.plugin)) {
                if let Err(e) = self.record_new(r) {
                    eprintln!("{e}");
                }
            }
            let settled = terminal(&records).is_some() && outstanding(&records) == 0;
            let lost = records.is_empty() && now.saturating_sub(p.started) > 86400;
            if settled || lost || now.saturating_sub(p.started) > MS_KEEP_SECS {
                let _ = std::fs::remove_dir_all(&p.dir);
            } else {
                keep.push(p);
            }
        }
        if let Err(e) = self.store_ledger(&keep) {
            eprintln!("{e}");
        }
    }
}

// a job handed to Macro Studio, then its receipt watched in the background:
// each saved stack is remembered and announced as "plugin-returned", and
// "plugin-watch-end" says why the wait ended (done, cancelled, timeout,
// startup, stalled, protocol, stopped or error, the last two with the app's
// message)
#[tauri::command]
pub fn plugin_job(app: AppHandle, state: State<'_, Plugins>, job: Job) -> Result<(), String> {
    if job.mode != "original-raw" && job.mode != "rendered" {
        return Err(format!("unknown mode {}", job.mode));
    }
    let cfg = state.ready(&job.plugin)?;
    if cfg.kind != "macro-studio" {
        return Err(format!("{} does not take jobs", cfg.name));
    }
    for f in &job.files {
        photo_file(&f.path)?;
    }
    let exe = ms_executable(&cfg.app).ok_or("Macro Studio was not found; choose it in Preferences")?;
    let job_id = format!("immage-{}", job.token);
    let dir = state.jobs_dir.join(&job_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("plugin job: {e}"))?;
    let receipt = dir.join("job.receipt.jsonl");
    let manifest = dir.join("job.msjob");
    let text = manifest_json(&job, &job_id, &receipt, &app.package_info().version.to_string()).to_string();
    std::fs::write(&manifest, text).map_err(|e| format!("plugin job: {e}"))?;
    // in the ledger before the app starts, so a stack saved while Immage is
    // closed is still taken back
    state.remember_job(Pending {
        job_id, token: job.token, plugin: job.plugin.clone(), receipt: receipt.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(), started: now_secs(),
    })?;
    // the executable itself, as Macro Studio's Lightroom plugin starts it: a
    // second instance hands the job to one running already, and exits
    let mut cmd = std::process::Command::new(&exe);
    if !cfg!(windows) {
        cmd.arg("--job");
    }
    let mut child = cmd.arg(&manifest)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|e| format!("could not start Macro Studio: {e}"))?;
    std::thread::spawn(move || { let _ = child.wait(); });

    state.live.lock().unwrap().insert(job.token);
    let (token, plugin) = (job.token, job.plugin);
    std::thread::spawn(move || {
        let plugins = app.state::<Plugins>();
        let started = Instant::now();
        let mut last = Instant::now();
        let mut consumed = 0;
        let mut message = String::new();
        let reason = 'watch: loop {
            std::thread::sleep(MS_POLL);
            if !plugins.live.lock().unwrap().contains(&token) {
                break "cancelled";
            }
            let records = receipt_records(&receipt);
            if records.len() > consumed {
                last = Instant::now();
            }
            for r in records.iter().skip(consumed) {
                if kind_of(r) == "job_started" && r["v"].as_u64() != Some(MS_RECEIPT_VERSION) {
                    message = format!("Macro Studio speaks receipt version {}, Immage version {MS_RECEIPT_VERSION}",
                                      r["v"]);
                    break 'watch "protocol";
                }
                let Some(ret) = saved(r, &plugin) else { continue };
                if let Err(e) = plugins.record_new(ret.clone()) {
                    eprintln!("{e}");
                }
                let _ = app.emit("plugin-returned", json!({
                    "token": token, "plugin": ret.plugin, "original": ret.original, "result": ret.result,
                }));
            }
            consumed = consumed.max(records.len());
            match terminal(&records) {
                Some(t) if kind_of(t) == "job_error" => {
                    message = t["message"].as_str().unwrap_or("").to_string();
                    break if t["reason"].is_string() { "stopped" } else { "error" };
                }
                Some(_) if outstanding(&records) == 0 => break "done",
                Some(_) => {}
                None if records.is_empty() && started.elapsed() > MS_STARTUP => break "startup",
                None if !records.is_empty() && last.elapsed() > MS_STALL => break "stalled",
                None => {}
            }
            if last.elapsed() > GIVE_UP {
                break "timeout";
            }
        };
        plugins.live.lock().unwrap().remove(&token);
        // what the watch leaves, the ledger takes back later; a job that is
        // finished with, or never started, is retired now
        plugins.drain_jobs();
        let _ = app.emit("plugin-watch-end", json!({ "token": token, "reason": reason, "message": message }));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn cfg(id: &str, app: &str) -> PluginConfig {
        PluginConfig { id: id.into(), kind: "dxo-pureraw".into(), name: "DxO PureRAW".into(), app: app.into(),
                       send: "original".into(), ..Default::default() }
    }

    #[test]
    fn unknown_ids() {
        let dir = scratch("test-plugin-ids");
        let p = Plugins::new(dir.join("returns.json"));
        p.config(Some(vec![cfg("a", "/Applications/A.app"), cfg("b", "")])).unwrap();
        assert_eq!(p.ready("a").unwrap().app, "/Applications/A.app");
        assert!(p.ready("nope").unwrap_err().contains("unknown plugin"));
        assert!(p.ready("b").unwrap_err().contains("choose its application"));
        assert!(p.ready_id("nope").is_err() && p.ready_id("b").is_ok());
        assert!(p.set_app("nope", "/x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_allow_list() {
        let dir = scratch("test-plugin-apps");
        let p = Plugins::new(dir.join("returns.json"));
        p.config(Some(vec![cfg("a", "")])).unwrap();
        // a path find_apps never returned is refused, and nothing is stored
        assert!(p.set_app("a", "/bin/sh").is_err());
        assert_eq!(p.ready("a").unwrap_err(), "choose its application in Preferences");
        p.offered.lock().unwrap().insert("/Applications/A.app".into());
        assert_eq!(p.set_app("a", "/Applications/A.app").unwrap()[0].app, "/Applications/A.app");
        assert_eq!(p.ready("a").unwrap().app, "/Applications/A.app");
        // and a path offered is still refused for an id that does not exist
        assert!(p.set_app("zz", "/Applications/A.app").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn page_cannot_set_the_program() {
        let dir = scratch("test-plugin-save");
        let p = Plugins::new(dir.join("returns.json"));
        p.config(Some(vec![cfg("a", "/Applications/A.app")])).unwrap();
        // an edit keeps the stored program; a new plugin or a changed path gets none
        let mut edited = cfg("a", "/bin/sh");
        edited.name = "Mine".into();
        let saved = p.config_save(vec![edited, cfg("b", "/bin/sh"), cfg("b", "x"), cfg("", "y")]).unwrap();
        assert_eq!(saved.len(), 2);
        assert_eq!((saved[0].name.as_str(), saved[0].app.as_str()), ("Mine", "/Applications/A.app"));
        assert_eq!(saved[1].app, "");
        // removed from the page's list, removed
        assert_eq!(p.config_save(vec![]).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_once() {
        let dir = scratch("test-plugin-migrate");
        let p = Plugins::new(dir.join("returns.json"));
        let old = vec![cfg("a", "/Applications/A.app"), cfg("a", "dup"), cfg("b", "")];
        let list = p.config(Some(old)).unwrap();
        assert_eq!(list.len(), 2);
        // existing plugins keep working: the program, and a later start reads the file
        assert_eq!(Plugins::new(dir.join("returns.json")).ready("a").unwrap().app, "/Applications/A.app");
        // a second offer is ignored, even from a page that has lost its own copy
        let again = p.config(Some(vec![cfg("evil", "/bin/sh")])).unwrap();
        assert_eq!(again, list);
        assert!(p.ready("evil").is_err());
        // the file is made with no legacy list too, so a later offer is refused
        let dir2 = scratch("test-plugin-migrate-none");
        let q = Plugins::new(dir2.join("returns.json"));
        assert!(q.config(None).unwrap().is_empty());
        assert!(q.config(Some(vec![cfg("evil", "/bin/sh")])).unwrap().is_empty());
        // a file that does not parse is kept, not migrated over
        std::fs::write(dir2.join("plugins.json"), "{").unwrap();
        assert!(q.config(Some(vec![cfg("evil", "/bin/sh")])).unwrap().is_empty());
        assert_eq!(std::fs::read_to_string(dir2.join("plugins.json")).unwrap(), "{");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    #[test]
    fn legacy_shape() {
        // localStorage's entries, which may lack the newer fields
        let l: Vec<PluginConfig> = serde_json::from_str(r#"[{"id":"x:1","kind":"dxo-pureraw","name":"N","app":"/A.app",
            "send":"original","outputDir":"/o","onReturn":{"lens":true}}]"#).unwrap();
        assert_eq!(l[0].output_dir, "/o");
        assert_eq!(l[0].on_return["lens"], true);
        assert!(l[0].look.is_none());
        assert!(serde_json::to_value(&l[0]).unwrap().get("look").is_none());
    }

    #[test]
    fn photo_files() {
        let dir = scratch("test-plugin-files");
        let f = |n: &str| dir.join(n).to_string_lossy().into_owned();
        std::fs::write(dir.join("a.ARW"), b"x").unwrap();
        std::fs::write(dir.join("b.tif"), b"x").unwrap();
        std::fs::write(dir.join("c.txt"), b"x").unwrap();
        std::fs::write(dir.join("noext"), b"x").unwrap();
        std::fs::create_dir(dir.join("d.jpg")).unwrap();
        assert!(photo_file(&f("a.ARW")).is_ok());
        assert!(photo_file(&f("b.tif")).is_ok());
        assert!(photo_file(&f("c.txt")).is_err());
        assert!(photo_file(&f("noext")).is_err());
        // a folder named like a photo, and a file that is not there
        assert!(photo_file(&f("d.jpg")).is_err());
        assert!(photo_file(&f("missing.jpg")).is_err());
        assert!(photo_file(&dir.to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            symlink(dir.join("a.ARW"), dir.join("link.jpg")).unwrap();
            // named like a photo but a folder, or a file of another kind
            symlink(dir.join("d.jpg"), dir.join("dirlink.png")).unwrap();
            symlink(dir.join("c.txt"), dir.join("textlink.jpg")).unwrap();
            symlink(dir.join("gone"), dir.join("dangling.jpg")).unwrap();
            assert!(photo_file(&f("link.jpg")).is_ok());
            assert!(photo_file(&f("dirlink.png")).is_err());
            assert!(photo_file(&f("textlink.jpg")).is_err());
            assert!(photo_file(&f("dangling.jpg")).is_err());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn globs() {
        assert!(glob("DxO PureRAW*.app", "DxO PureRAW 4.app"));
        assert!(glob("*PureRaw*.exe", "PureRawv4.exe"));
        assert!(!glob("DxO PureRAW*.app", "DxO PhotoLab 7.app"));
        assert!(glob("a*b*c", "aXbYc"));
        assert!(!glob("ab*ba", "aba"));
    }

    #[test]
    fn names() {
        let sources = vec![PathBuf::from("/p/IMG_1.ARW"), PathBuf::from("/p/IMG_10.ARW")];
        assert_eq!(named_from(Path::new("/p/DxO/IMG_10-DxO_DeepPRIME XD2s.dng"), &sources), Some(&sources[1]));
        assert_eq!(named_from(Path::new("/p/DxO/IMG_1_DxO.dng"), &sources), Some(&sources[0]));
        assert_eq!(named_from(Path::new("/p/DxO/IMG_12.dng"), &sources), None);
    }

    #[test]
    fn beside() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-plugins");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("DxO")).unwrap();
        let (a, b, ra) = (dir.join("a.orf"), dir.join("b.orf"), dir.join("DxO/a-DxO.dng"));
        std::fs::write(&ra, b"x").unwrap();
        let p = Plugins::new(dir.join("returns.json"));
        let rec = |result: &Path| Return { original: a.to_string_lossy().into(), result: result.to_string_lossy().into(),
                                           plugin: "dxo".into(), applied: false };
        // another folder's result, on a share that may have gone away
        let away = Return { original: "/Volumes/gone/c.orf".into(), result: "/Volumes/gone/c-DxO.dng".into(),
                            plugin: "dxo".into(), applied: false };
        p.store(&[rec(&ra), rec(&dir.join("DxO/gone.dng")), away]).unwrap();
        // the result joins its original, from a folder not read
        let mut files = vec![a.clone(), b.clone()];
        p.beside_originals(&mut files);
        assert_eq!(files, vec![a.clone(), ra.clone(), b.clone()]);
        // and moves there when read with the subfolders
        let mut files = vec![a.clone(), b.clone(), ra.clone()];
        p.beside_originals(&mut files);
        assert_eq!(files, vec![a.clone(), ra.clone(), b.clone()]);
        // a deleted result is forgotten, and another folder's left unchecked
        let kept: Vec<String> = p.load().into_iter().map(|r| r.result).collect();
        assert_eq!(kept, vec![ra.to_string_lossy().into_owned(), "/Volumes/gone/c-DxO.dng".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn watch_args() {
        // the fields as App.tsx's editIn sends them
        let w: Watch = serde_json::from_value(json!({
            "token": 1, "plugin": "dxo-pureraw:x", "sources": ["/p/a.orf"], "exts": ["dng"], "match": "prefix",
            "subfolders": ["DxO", ""], "outputDir": "/out", "ignore": [],
        })).unwrap();
        assert_eq!(w.output_dir.as_deref(), Some("/out"));
    }

    #[test]
    fn manifest() {
        let job = Job {
            token: 1, plugin: "macro-studio:x".into(), mode: "rendered".into(),
            files: vec![StackFile { path: "/p/a-Edit.tif".into(), origin_path: Some("/p/a.orf".into()) },
                        StackFile { path: "/p/b.orf".into(), origin_path: None }],
            look: Some("".into()),
        };
        let m = manifest_json(&job, "immage-1", Path::new("/j/job.receipt.jsonl"), "0.38.0");
        // Macro Studio rejects a key it does not know, and a look it has not
        let mut keys: Vec<&str> = m.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, ["files", "host", "host_version", "job_id", "mode", "receipt_path", "return_mode", "version"]);
        assert_eq!(m["files"][0]["origin_path"], "/p/a.orf");
        assert!(m["files"][1].get("origin_path").is_none());
        assert_eq!(m["return_mode"], "review");
    }

    const RECEIPT: &str = concat!(
        r#"{"v":1,"type":"job_started","total_stacks":2,"leftover_paths":[]}"#, "\n",
        r#"{"v":1,"type":"stack_ready","stack_index":0}"#, "\n",
        r#"{"v":1,"type":"heartbeat"}"#, "\n",
        r#"{"v":1,"type":"stack_ready","stack_index":1}"#, "\n",
        r#"{"v":1,"type":"job_complete","done":2,"failed":0}"#, "\n",
        r#"{"v":1,"type":"stack_done","stack_index":0,"output_path":"/p/a-stacked.dng","origin_paths":["/p/a.orf","/p/b.orf"]}"#, "\n",
        r#"{"v":1,"type":"stack_done","stack_index":0,"output_path":"/p/a-stacked.tif","origin_paths":["/p/a.orf","/p/b.orf"]}"#, "\n",
        r#"{"v":1,"type":"something_new"}"#, "\n",
        r#"{"v":1,"type":"stack_do"#,
    );

    #[test]
    fn receipts() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-receipt");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("job.receipt.jsonl");
        std::fs::write(&path, RECEIPT).unwrap();
        // the line being written is left for the next read
        let records = receipt_records(&path);
        assert_eq!(records.len(), 8);
        // complete, but stack 1 is still open in Macro Studio; stack 0 saved
        // twice counts once
        assert!(terminal(&records).is_some());
        assert_eq!(outstanding(&records), 1);
        let back: Vec<Return> = records.iter().filter_map(|r| saved(r, "ms")).collect();
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].original, "/p/a.orf");
        assert_eq!(back[1].result, "/p/a-stacked.tif");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drain() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/test-drain");
        let _ = std::fs::remove_dir_all(&dir);
        let p = Plugins::new(dir.join("returns.json"));
        let job = |id: &str, receipt: &str| {
            let d = p.jobs_dir.join(id);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("job.receipt.jsonl"), receipt).unwrap();
            Pending { job_id: id.into(), token: 0, plugin: "ms".into(),
                      receipt: d.join("job.receipt.jsonl").to_string_lossy().into(),
                      dir: d.to_string_lossy().into(), started: now_secs() }
        };
        let open = job("open", RECEIPT);
        let finished = job("finished", &format!("{RECEIPT}\n{}\n",
            r#"{"v":1,"type":"stack_error","stack_index":1,"message":"closed without saving"}"#));
        p.store_ledger(&[open, finished.clone()]).unwrap();
        p.drain_jobs();
        // the saved files are taken back once each; the finished job goes,
        // its folder with it, and the one with a stack still open stays
        assert_eq!(p.load().len(), 2);
        let left: Vec<String> = p.ledger().into_iter().map(|j| j.job_id).collect();
        assert_eq!(left, ["open"]);
        assert!(!Path::new(&finished.dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
