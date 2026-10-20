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

pub struct Plugins {
    returns_path: PathBuf,
    // the hand-offs still waiting, by token; a cancelled one leaves
    live: Mutex<HashSet<u64>>,
    // one reader or writer of the returns file at a time
    io: Mutex<()>,
}

impl Plugins {
    pub fn new(returns_path: PathBuf) -> Self {
        Plugins { returns_path, live: Mutex::new(HashSet::new()), io: Mutex::new(()) }
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

    // each result whose original is among a folder's files moves to just
    // after it, or joins it there when it lives in a folder not being read
    // (PureRAW's DxO subfolder). results deleted since are forgotten
    pub fn beside_originals(&self, files: &mut Vec<PathBuf>) {
        let _io = self.io.lock().unwrap();
        let mut returns = self.load();
        let before = returns.len();
        returns.retain(|r| Path::new(&r.result).is_file());
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
    }
    v
}

// the installed applications a plugin kind can use, newest version first
// (the highest name: "DxO PureRAW 5" before "DxO PureRAW 4")
#[tauri::command]
pub fn plugin_find_apps(patterns: Vec<String>) -> Vec<String> {
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
    out
}

// the application started with the files, or given them when it runs
// already: on macOS through `open -a`, as a drop on its Dock icon is
#[tauri::command]
pub async fn plugin_launch(app_path: String, files: Vec<String>) -> Result<(), String> {
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
pub fn plugin_watch(app: AppHandle, state: State<'_, Plugins>, watch: Watch) {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        p.store(&[rec(&ra), rec(&dir.join("DxO/gone.dng"))]).unwrap();
        // the result joins its original, from a folder not read
        let mut files = vec![a.clone(), b.clone()];
        p.beside_originals(&mut files);
        assert_eq!(files, vec![a.clone(), ra.clone(), b.clone()]);
        // and moves there when read with the subfolders
        let mut files = vec![a.clone(), b.clone(), ra.clone()];
        p.beside_originals(&mut files);
        assert_eq!(files, vec![a.clone(), ra.clone(), b.clone()]);
        // a deleted result is forgotten
        assert_eq!(p.load().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
