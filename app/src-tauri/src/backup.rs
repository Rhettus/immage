// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Backup and Restore in Preferences: the user's settings, presets, looks,
//! plugin list and darktable's keyword data in one .zip, and back again.
//!
//! Layout: `manifest.json` at the root, then every file under `<id>/`, where
//! the id is one of COMPONENTS. API keys live in the OS keychain and are never
//! part of a backup.
//!
//! Restore replaces what it restores, after keeping a copy of it under
//! `<runtime>/backups/pre-restore-<time>/`. The whole archive is read, checked
//! and staged on disk before anything is replaced, so a bad file leaves the
//! app as it was. The engine holds data.db open, so that component is
//! copied with the engine's `data_backup` command and replaced only while the
//! engine is stopped.

use crate::settings::{self, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const FORMAT: u64 = 1;
const MANIFEST: &str = "manifest.json";
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const KEEP_PRE_RESTORE: usize = 3;

// runs the closure it is given with the engine stopped
type WithEngineStopped<'a> = &'a dyn Fn(&mut dyn FnMut() -> Result<(), String>) -> Result<(), String>;

// (id, label, the one file it is, or None for a folder of files)
const COMPONENTS: [(&str, &str, Option<&str>); 6] = [
    ("settings", "Preferences & library", Some("settings.json")),
    ("presets", "Edit presets", Some("presets.json")),
    ("export_presets", "Export presets", Some("export-presets.json")),
    ("looks", "Looks", None),
    ("plugins", "Edit In plugins", Some("plugins.json")),
    ("darktable", "Keywords & darktable data", Some("data.db")),
];

fn label(id: &str) -> &'static str {
    COMPONENTS.iter().find(|c| c.0 == id).map(|c| c.1).unwrap_or("")
}

// a bomb defence, not a promise about real backups: a data.db with years of
// keywords is megabytes
#[derive(Clone, Copy)]
struct Limits {
    total: u64,
    entries: usize,
    // an entry larger than `ratio_from` may not expand more than `ratio` times
    ratio_from: u64,
    ratio: u64,
}

const LIMITS: Limits = Limits { total: 4 << 30, entries: 20_000, ratio_from: 64 << 20, ratio: 200 };

fn looks_dir(runtime: &Path) -> PathBuf {
    runtime.join("looks")
}

fn data_db(runtime: &Path) -> PathBuf {
    runtime.join("config").join("data.db")
}

// where a one-file component lives; the file's own name is its name in the zip
fn file_source(runtime: &Path, id: &str) -> Option<PathBuf> {
    match id {
        "presets" => Some(runtime.join("presets.json")),
        "export_presets" => Some(runtime.join("export-presets.json")),
        "plugins" => Some(runtime.join("plugins.json")),
        "darktable" => Some(data_db(runtime)),
        "settings" => Some(runtime.join(settings::FILE)),
        _ => None,
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ComponentInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub bytes: u64,
    pub files: usize,
}

// the regular files of the looks folder; links and folders are left alone
fn looks_files(runtime: &Path) -> Vec<(String, u64)> {
    let Ok(dir) = std::fs::read_dir(looks_dir(runtime)) else { return Vec::new() };
    let mut out: Vec<(String, u64)> = dir
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = std::fs::symlink_metadata(e.path()).ok()?;
            (meta.is_file()).then(|| (e.file_name().to_string_lossy().into_owned(), meta.len()))
        })
        .filter(|(name, _)| safe_leaf(name).is_ok())
        .collect();
    out.sort();
    out
}

pub fn components(runtime: &Path, settings: &Settings) -> Vec<ComponentInfo> {
    COMPONENTS
        .iter()
        .map(|(id, label, _)| {
            let (available, bytes, files) = match *id {
                "settings" => {
                    let n = serde_json::to_string_pretty(&settings.all()).map(|t| t.len() as u64).unwrap_or(0);
                    (true, n, 1)
                }
                "looks" => {
                    let f = looks_files(runtime);
                    (!f.is_empty(), f.iter().map(|x| x.1).sum(), f.len())
                }
                other => {
                    let len = file_source(runtime, other).and_then(|p| std::fs::metadata(p).ok()).filter(|m| m.is_file());
                    (len.is_some(), len.map(|m| m.len()).unwrap_or(0), 1)
                }
            };
            ComponentInfo { id: id.to_string(), label: label.to_string(), available, bytes, files: if available { files } else { 0 } }
        })
        .collect()
}

fn known(id: &str) -> Result<(), String> {
    if COMPONENTS.iter().any(|c| c.0 == id) { Ok(()) } else { Err(format!("unknown backup component \"{id}\"")) }
}

// one name inside a component's folder: no separators, no dots-only names
fn safe_leaf(name: &str) -> Result<(), String> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', '\0'])
        || name.chars().any(|c| c.is_control());
    if bad { Err(format!("unsafe file name \"{}\" in the backup", name.escape_debug())) } else { Ok(()) }
}

// what an archive entry name stands for: the manifest, or a file of a known
// component. Anything else, including a name that could leave the folder it
// is extracted into, makes the whole archive refused
#[derive(Debug, PartialEq)]
enum Entry {
    Manifest,
    Dir,
    File { id: &'static str, rest: String },
}

fn classify(name: &str) -> Result<Entry, String> {
    let unsafe_name = || format!("unsafe entry name \"{}\" in the backup", name.escape_debug());
    if name == MANIFEST {
        return Ok(Entry::Manifest);
    }
    if name.is_empty() || name.starts_with('/') || name.contains(['\\', '\0']) {
        return Err(unsafe_name());
    }
    let dir = name.ends_with('/');
    let parts: Vec<&str> = name.trim_end_matches('/').split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
        return Err(unsafe_name());
    }
    let Some(c) = COMPONENTS.iter().find(|c| c.0 == parts[0]) else {
        return Err(format!("the backup holds an unknown component \"{}\"", parts[0].escape_debug()));
    };
    if parts.len() == 1 {
        return if dir { Ok(Entry::Dir) } else { Err(unsafe_name()) };
    }
    if parts.len() > 2 || dir {
        // components have no subfolders
        return Err(unsafe_name());
    }
    match c.2 {
        Some(fixed) if fixed != parts[1] => Err(unsafe_name()),
        _ => {
            safe_leaf(parts[1])?;
            Ok(Entry::File { id: c.0, rest: parts[1].to_string() })
        }
    }
}

fn parse_version(v: &str) -> Vec<u64> {
    v.split('-').next().unwrap_or("").split('.').map(|p| p.trim().parse().unwrap_or(0)).collect()
}

// whether `backup` is a later version than `app`, compared number by number
pub fn newer(backup: &str, app: &str) -> bool {
    let (mut a, mut b) = (parse_version(backup), parse_version(app));
    let n = a.len().max(b.len());
    a.resize(n, 0);
    b.resize(n, 0);
    a > b
}

fn io(path: &Path, e: std::io::Error) -> String {
    format!("{}: {e}", path.display())
}

// ---- create ----

fn add_file(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, source: &Path) -> Result<u64, String> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .large_file(true);
    let mut f = std::fs::File::open(source).map_err(|e| io(source, e))?;
    zip.start_file(name, options).map_err(|e| e.to_string())?;
    std::io::copy(&mut f, zip).map_err(|e| io(source, e))
}

fn add_bytes(zip: &mut zip::ZipWriter<std::fs::File>, name: &str, bytes: &[u8]) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file(name, options).map_err(|e| e.to_string())?;
    zip.write_all(bytes).map_err(|e| e.to_string())
}

/// Writes the chosen components to `dest`, atomically. `snapshot` makes a
/// consistent copy of data.db at the path it is given (the engine has the file
/// open); it is not called when darktable is not chosen.
pub fn create(
    runtime: &Path,
    settings: &Settings,
    ids: &[String],
    dest: &Path,
    version: &str,
    created: &str,
    snapshot: &dyn Fn(&Path) -> Result<(), String>,
) -> Result<(), String> {
    for id in ids {
        known(id)?;
    }
    if ids.is_empty() {
        return Err("choose something to back up".into());
    }
    let mut part = dest.as_os_str().to_owned();
    part.push(".part");
    let part = PathBuf::from(part);
    let scratch = runtime.join("backups").join(format!("snapshot-{}", std::process::id()));
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&part).map_err(|e| io(&part, e))?;
        let mut zip = zip::ZipWriter::new(file);
        let mut manifest = serde_json::Map::new();
        let mut seen = HashSet::new();
        for id in ids.iter().filter(|id| seen.insert(id.as_str())) {
            let mut files: Vec<String> = Vec::new();
            let mut bytes = 0u64;
            match id.as_str() {
                "settings" => {
                    let text = serde_json::to_string_pretty(&settings.all()).map_err(|e| e.to_string())?;
                    add_bytes(&mut zip, "settings/settings.json", text.as_bytes())?;
                    files.push("settings.json".into());
                    bytes = text.len() as u64;
                }
                "looks" => {
                    for (name, _) in looks_files(runtime) {
                        bytes += add_file(&mut zip, &format!("looks/{name}"), &looks_dir(runtime).join(&name))?;
                        files.push(name);
                    }
                }
                "darktable" => {
                    std::fs::create_dir_all(&scratch).map_err(|e| io(&scratch, e))?;
                    let copy = scratch.join("data.db");
                    snapshot(&copy)?;
                    bytes = add_file(&mut zip, "darktable/data.db", &copy)?;
                    files.push("data.db".into());
                }
                other => {
                    let src = file_source(runtime, other).ok_or_else(|| format!("unknown backup component \"{other}\""))?;
                    if !src.is_file() {
                        continue;
                    }
                    let name = src.file_name().unwrap().to_string_lossy().into_owned();
                    bytes = add_file(&mut zip, &format!("{other}/{name}"), &src)?;
                    files.push(name);
                }
            }
            if files.is_empty() {
                continue;
            }
            manifest.insert(id.clone(), json!({ "files": files, "bytes": bytes }));
        }
        if manifest.is_empty() {
            return Err("there is nothing to back up in the chosen items".into());
        }
        let text = serde_json::to_string_pretty(&json!({
            "format": FORMAT, "app": "Immage", "version": version, "created": created, "components": manifest,
        }))
        .map_err(|e| e.to_string())?;
        add_bytes(&mut zip, MANIFEST, text.as_bytes())?;
        let file = zip.finish().map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| io(&part, e))?;
        drop(file);
        std::fs::rename(&part, dest).map_err(|e| io(dest, e))
    })();
    let _ = std::fs::remove_dir_all(&scratch);
    if result.is_err() {
        let _ = std::fs::remove_file(&part);
    }
    result
}

// ---- read ----

#[derive(Serialize, Debug, PartialEq)]
pub struct Held {
    pub id: String,
    pub label: String,
    pub bytes: u64,
    pub files: usize,
}

#[derive(Serialize, Debug)]
pub struct Summary {
    pub version: String,
    pub created: String,
    pub newer: bool,
    pub components: Vec<Held>,
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, String> {
    let f = std::fs::File::open(path).map_err(|e| io(path, e))?;
    zip::ZipArchive::new(f).map_err(|_| "that file is not an Immage backup".to_string())
}

// the archive's entries, every name checked, with declared sizes capped. Index
// order, so a duplicate name is refused rather than shadowing
fn entries(zip: &mut zip::ZipArchive<std::fs::File>, limits: &Limits) -> Result<Vec<(usize, Entry, u64)>, String> {
    if zip.len() > limits.entries {
        return Err("the backup holds too many files".into());
    }
    let mut out = Vec::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let f = zip.by_index_raw(i).map_err(|e| e.to_string())?;
        let name = f.name().map_err(|e| e.to_string())?.to_string();
        let entry = classify(&name)?;
        if !names.insert(name.clone()) {
            return Err(format!("the backup lists \"{}\" twice", name.escape_debug()));
        }
        // a link would be written as a file here, but nothing about it is
        // something a backup makes
        if f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(format!("unsafe entry \"{}\" in the backup", name.escape_debug()));
        }
        let size = f.size();
        if size > limits.ratio_from && size / f.compressed_size().max(1) > limits.ratio {
            return Err("the backup expands far more than a real one would, and was not opened".into());
        }
        total = total.saturating_add(size);
        if total > limits.total {
            return Err("the backup is larger than Immage will unpack".into());
        }
        out.push((i, entry, size));
    }
    Ok(out)
}

fn read_manifest(zip: &mut zip::ZipArchive<std::fs::File>, list: &[(usize, Entry, u64)]) -> Result<Value, String> {
    let Some((i, _, size)) = list.iter().find(|e| e.1 == Entry::Manifest) else {
        return Err("that file is not an Immage backup".into());
    };
    if *size > 1 << 20 {
        return Err("that file is not an Immage backup".into());
    }
    let mut text = String::new();
    zip.by_index(*i).map_err(|e| e.to_string())?.take(1 << 20).read_to_string(&mut text)
        .map_err(|_| "the backup's manifest cannot be read".to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|_| "the backup's manifest is damaged".to_string())?;
    if v["app"] != "Immage" {
        return Err("that file is not an Immage backup".into());
    }
    match v["format"].as_u64() {
        Some(FORMAT) => Ok(v),
        Some(_) => Err("that backup was made by a newer Immage; update Immage to restore it".into()),
        None => Err("the backup's manifest is damaged".into()),
    }
}

pub fn inspect(path: &Path, app_version: &str) -> Result<Summary, String> {
    inspect_with(path, app_version, &LIMITS)
}

fn inspect_with(path: &Path, app_version: &str, limits: &Limits) -> Result<Summary, String> {
    let mut zip = open_zip(path)?;
    let list = entries(&mut zip, limits)?;
    let manifest = read_manifest(&mut zip, &list)?;
    let mut held: Vec<Held> = Vec::new();
    for (id, label, _) in COMPONENTS {
        let mine: Vec<u64> = list.iter().filter_map(|(_, e, size)| match e {
            Entry::File { id: i, .. } if *i == id => Some(*size),
            _ => None,
        }).collect();
        if !mine.is_empty() {
            held.push(Held { id: id.into(), label: label.into(), bytes: mine.iter().sum(), files: mine.len() });
        }
    }
    let version = manifest["version"].as_str().unwrap_or("").to_string();
    Ok(Summary {
        newer: newer(&version, app_version),
        created: manifest["created"].as_str().unwrap_or("").to_string(),
        version,
        components: held,
    })
}

// ---- restore ----

// the chosen components, read out of the archive into `staging/<id>/`
// and checked. Nothing outside `staging` is touched
fn stage(path: &Path, ids: &[String], staging: &Path, limits: &Limits) -> Result<(), String> {
    let mut zip = open_zip(path)?;
    let list = entries(&mut zip, limits)?;
    read_manifest(&mut zip, &list)?;
    for id in ids {
        if !list.iter().any(|(_, e, _)| matches!(e, Entry::File { id: i, .. } if i == id)) {
            return Err(format!("the backup holds no {}", label(id).to_lowercase()));
        }
    }
    let mut budget = limits.total;
    for (i, entry, _) in &list {
        let Entry::File { id, rest } = entry else { continue };
        if !ids.iter().any(|c| c == id) {
            continue;
        }
        let dir = staging.join(id);
        std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
        let dest = dir.join(rest);
        let mut src = zip.by_index(*i).map_err(|e| e.to_string())?;
        let mut out = std::fs::File::create(&dest).map_err(|e| io(&dest, e))?;
        let mut buf = vec![0u8; 64 << 10];
        loop {
            let n = src.read(&mut buf).map_err(|e| format!("the backup is damaged: {e}"))?;
            if n == 0 {
                break;
            }
            // the declared size was checked, but a lying entry is cut off here
            if n as u64 > budget {
                return Err("the backup is larger than Immage will unpack".into());
            }
            budget -= n as u64;
            out.write_all(&buf[..n]).map_err(|e| io(&dest, e))?;
        }
    }
    for id in ids {
        validate(id, &staging.join(id))?;
    }
    Ok(())
}

fn validate(id: &str, dir: &Path) -> Result<(), String> {
    let name = label(id);
    let read = |file: &str| -> Result<Vec<u8>, String> { std::fs::read(dir.join(file)).map_err(|e| io(&dir.join(file), e)) };
    match id {
        "settings" => {
            let text = String::from_utf8(read("settings.json")?).map_err(|_| format!("{name}: not text"))?;
            settings::parse(&text).map(|_| ()).ok_or_else(|| format!("{name}: settings.json is not a list of settings"))
        }
        "presets" | "export_presets" => {
            let file = if id == "presets" { "presets.json" } else { "export-presets.json" };
            serde_json::from_slice::<Value>(&read(file)?).map(|_| ()).map_err(|_| format!("{name}: {file} is damaged"))
        }
        "plugins" => serde_json::from_slice::<Vec<crate::plugins::PluginConfig>>(&read("plugins.json")?)
            .map(|_| ())
            .map_err(|_| format!("{name}: plugins.json is damaged")),
        "darktable" => {
            let mut head = [0u8; 16];
            let mut f = std::fs::File::open(dir.join("data.db")).map_err(|e| io(&dir.join("data.db"), e))?;
            if f.read_exact(&mut head).is_err() || &head != SQLITE_HEADER {
                return Err(format!("{name}: data.db is not a SQLite database"));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    std::fs::copy(from, to).map(|_| ()).map_err(|e| io(from, e))
}

// puts `from` at `to`: a rename where the folders share a drive, a copy
// through a temporary name where they do not, so `to` is never half written
fn put(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| io(parent, e))?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let mut tmp = to.as_os_str().to_owned();
    tmp.push(".restoring");
    let tmp = PathBuf::from(tmp);
    std::fs::copy(from, &tmp).map_err(|e| io(from, e))?;
    std::fs::rename(&tmp, to).map_err(|e| io(to, e))
}

// the current files of a component, saved to `pre/<id>/`
fn save_current(runtime: &Path, settings: &Settings, id: &str, pre: &Path) -> Result<(), String> {
    let dir = pre.join(id);
    match id {
        "settings" => {
            std::fs::create_dir_all(&dir).map_err(|e| io(&dir, e))?;
            let text = serde_json::to_string_pretty(&settings.all()).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(settings::FILE), text).map_err(|e| io(&dir, e))
        }
        "looks" => {
            for (name, _) in looks_files(runtime) {
                copy_file(&looks_dir(runtime).join(&name), &dir.join(&name))?;
            }
            Ok(())
        }
        other => {
            let Some(src) = file_source(runtime, other) else { return Ok(()) };
            // data.db may have its journal files beside it
            for suffix in ["", "-wal", "-shm"] {
                let mut p = src.as_os_str().to_owned();
                p.push(suffix);
                let p = PathBuf::from(p);
                if p.is_file() {
                    copy_file(&p, &dir.join(p.file_name().unwrap()))?;
                }
            }
            Ok(())
        }
    }
}

// a restored plugin list never brings program paths with it: those are set
// only through the app (plugins.rs), so a backup from elsewhere cannot make
// Immage start a program it chose. A plugin that is here keeps its program
fn plugins_without_programs(runtime: &Path, staged: &Path) -> Result<(), String> {
    let mut list: Vec<crate::plugins::PluginConfig> =
        serde_json::from_slice(&std::fs::read(staged).map_err(|e| io(staged, e))?).map_err(|e| e.to_string())?;
    let current: Vec<crate::plugins::PluginConfig> = std::fs::read(runtime.join("plugins.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    for p in &mut list {
        p.app = current.iter().find(|c| c.id == p.id).map(|c| c.app.clone()).unwrap_or_default();
    }
    let text = serde_json::to_string_pretty(&list).map_err(|e| e.to_string())?;
    std::fs::write(staged, text).map_err(|e| io(staged, e))
}

fn replace(runtime: &Path, settings: &Settings, id: &str, staging: &Path) -> Result<(), String> {
    let dir = staging.join(id);
    match id {
        "settings" => {
            let text = std::fs::read_to_string(dir.join(settings::FILE)).map_err(|e| io(&dir, e))?;
            let map = settings::parse(&text).ok_or("the settings in the backup are damaged")?;
            settings.replace_all(map)
        }
        "looks" => {
            let live = looks_dir(runtime);
            std::fs::create_dir_all(&live).map_err(|e| io(&live, e))?;
            for (name, _) in looks_files(runtime) {
                std::fs::remove_file(live.join(&name)).map_err(|e| io(&live, e))?;
            }
            for e in std::fs::read_dir(&dir).map_err(|e| io(&dir, e))?.filter_map(|e| e.ok()) {
                put(&e.path(), &live.join(e.file_name()))?;
            }
            Ok(())
        }
        other => {
            let dest = file_source(runtime, other).ok_or_else(|| format!("unknown backup component \"{other}\""))?;
            let staged = dir.join(dest.file_name().unwrap());
            if other == "plugins" {
                plugins_without_programs(runtime, &staged)?;
            }
            if other == "darktable" {
                // a journal left by the old file would be applied to the new one
                for suffix in ["-wal", "-shm"] {
                    let mut p = dest.as_os_str().to_owned();
                    p.push(suffix);
                    let _ = std::fs::remove_file(PathBuf::from(p));
                }
            }
            put(&staged, &dest)
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub components: Vec<String>,
    pub engine_restarted: bool,
    pub saved_to: String,
}

// the folders of earlier restores, newest kept
fn prune(backups: &Path) {
    let Ok(dir) = std::fs::read_dir(backups) else { return };
    let mut old: Vec<String> = dir
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("pre-restore-"))
        .collect();
    old.sort();
    let drop = old.len().saturating_sub(KEEP_PRE_RESTORE);
    for name in &old[..drop] {
        let _ = std::fs::remove_dir_all(backups.join(name));
    }
}

/// Replaces the chosen components with the backup's. `stopped` runs the
/// replacement; for darktable's data it is given a closure to run with the
/// engine stopped (the real one stops it, holds its lock, and lets the
/// supervisor start it again afterwards). `stamp` names the folder the
/// replaced files are saved to.
pub fn restore(
    runtime: &Path,
    settings: &Settings,
    path: &Path,
    ids: &[String],
    stamp: &str,
    stopped: WithEngineStopped,
) -> Result<Restored, String> {
    restore_with(runtime, settings, path, ids, stamp, stopped, &LIMITS)
}

fn restore_with(
    runtime: &Path,
    settings: &Settings,
    path: &Path,
    ids: &[String],
    stamp: &str,
    stopped: WithEngineStopped,
    limits: &Limits,
) -> Result<Restored, String> {
    for id in ids {
        known(id)?;
    }
    let mut chosen: Vec<String> = Vec::new();
    for id in ids {
        if !chosen.contains(id) {
            chosen.push(id.clone());
        }
    }
    if chosen.is_empty() {
        return Err("choose something to restore".into());
    }
    let backups = runtime.join("backups");
    let staging = backups.join(format!("staging-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| io(&staging, e))?;
    let result = (|| -> Result<Restored, String> {
        // everything checked before anything is replaced
        stage(path, &chosen, &staging, limits)?;
        let mut pre = backups.join(format!("pre-restore-{stamp}"));
        let mut n = 1;
        while pre.exists() {
            n += 1;
            pre = backups.join(format!("pre-restore-{stamp}-{n}"));
        }
        std::fs::create_dir_all(&pre).map_err(|e| io(&pre, e))?;
        let mut run = || -> Result<(), String> {
            // data.db first: it is the one that needs the engine stopped, and
            // a failure there leaves the rest as it was
            let mut order: Vec<&String> = chosen.iter().collect();
            order.sort_by_key(|id| id.as_str() != "darktable");
            for id in order {
                save_current(runtime, settings, id, &pre)?;
                replace(runtime, settings, id, &staging)
                    .map_err(|e| format!("{e} (what was there is in {})", pre.display()))?;
            }
            Ok(())
        };
        let engine = chosen.iter().any(|c| c == "darktable");
        if engine {
            stopped(&mut run)?;
        } else {
            run()?;
        }
        prune(&backups);
        Ok(Restored { components: chosen.clone(), engine_restarted: engine, saved_to: pre.to_string_lossy().into_owned() })
    })();
    let _ = std::fs::remove_dir_all(&staging);
    result
}

// ---- commands ----

#[tauri::command]
pub async fn backup_components(app: AppHandle) -> Result<Vec<ComponentInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        components(&state.runtime, &app.state::<Settings>())
    })
    .await
    .map_err(|e| e.to_string())
}

// the save and open dialogs are Rust's (the page has no dialog:allow-save)
#[tauri::command]
pub async fn backup_pick_save(app: AppHandle) -> Result<Option<String>, String> {
    let name = format!("Immage Backup {}.zip", chrono::Local::now().format("%Y-%m-%d"));
    Ok(crate::pick_save(&app, "Immage backup", &["zip"], &name).await?.map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn backup_pick_open(app: AppHandle) -> Result<Option<String>, String> {
    let picked = crate::pick_files(&app, "Immage backup", &["zip"], false).await?;
    Ok(picked.into_iter().next().map(|p| p.to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn backup_create(app: AppHandle, path: String, components: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::AppState>();
        let created = chrono::Local::now().to_rfc3339();
        create(&state.runtime, &app.state::<Settings>(), &components, Path::new(&path), env!("CARGO_PKG_VERSION"), &created,
               &|to| {
                   let reply = state.engine("backup_create").request(json!({ "cmd": "data_backup", "path": to.to_string_lossy() }))?;
                   match reply["error"].as_str() {
                       Some(e) => Err(e.to_string()),
                       None => Ok(()),
                   }
               })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_inspect(path: String) -> Result<Summary, String> {
    tauri::async_runtime::spawn_blocking(move || inspect(Path::new(&path), env!("CARGO_PKG_VERSION")))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn backup_restore(app: AppHandle, path: String, components: Vec<String>) -> Result<Restored, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state: State<'_, crate::AppState> = app.state();
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
        restore(&state.runtime, &app.state::<Settings>(), Path::new(&path), &components, &stamp, &|run| {
            // the engine lock is held while the file is swapped, so the
            // supervisor cannot start the new engine on the old file
            let mut engine = state.engine("backup_restore");
            engine.stop_for_restart();
            run()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("immage-backup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_db(tag: &str) -> Vec<u8> {
        let mut v = SQLITE_HEADER.to_vec();
        v.extend_from_slice(tag.as_bytes());
        v
    }

    // a runtime folder with every component present
    fn runtime(name: &str, tag: &str) -> (PathBuf, Settings) {
        let r = dir(name);
        let s = Settings::load(&r);
        s.set("immage.theme", tag).unwrap();
        s.set(settings::GPU_EDITS, "off").unwrap();
        std::fs::write(r.join("presets.json"), format!("[{{\"name\":\"{tag}\"}}]")).unwrap();
        std::fs::write(r.join("export-presets.json"), format!("{{\"p\":\"{tag}\"}}")).unwrap();
        std::fs::create_dir_all(r.join("looks")).unwrap();
        std::fs::write(r.join("looks/A.dtstyle"), format!("a-{tag}")).unwrap();
        std::fs::write(r.join("looks/B.dtstyle"), format!("b-{tag}")).unwrap();
        std::fs::write(r.join("plugins.json"), format!("[{{\"id\":\"p1\",\"name\":\"{tag}\",\"app\":\"/bin/{tag}\"}}]")).unwrap();
        std::fs::create_dir_all(r.join("config")).unwrap();
        std::fs::write(r.join("config/data.db"), fake_db(tag)).unwrap();
        (r, s)
    }

    fn all() -> Vec<String> {
        COMPONENTS.iter().map(|c| c.0.to_string()).collect()
    }

    fn make(r: &Path, s: &Settings, ids: &[String], zip: &Path) {
        let db = std::fs::read(r.join("config/data.db")).ok();
        create(r, s, ids, zip, "0.44.1", "2026-11-11T00:00:00Z", &|to| {
            std::fs::write(to, db.clone().ok_or("no db")?).map_err(|e| e.to_string())
        })
        .unwrap();
    }

    fn direct(run: &mut dyn FnMut() -> Result<(), String>) -> Result<(), String> {
        run()
    }

    fn restore_all(r: &Path, s: &Settings, zip: &Path, ids: &[String], stamp: &str) -> Result<Restored, String> {
        restore(r, s, zip, ids, stamp, &direct)
    }

    fn raw_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut z = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (n, b) in entries {
            z.start_file(*n, o).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    const MAN: &str = "{\"format\":1,\"app\":\"Immage\",\"version\":\"0.44.1\",\"created\":\"x\",\"components\":{}}";

    fn snapshot_of(r: &Path) -> Vec<(String, Vec<u8>)> {
        fn walk(d: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) {
            for e in std::fs::read_dir(d).unwrap().filter_map(|e| e.ok()) {
                let p = e.path();
                if p.file_name().is_some_and(|n| n == "backups") {
                    continue;
                }
                if p.is_dir() {
                    walk(&p, base, out);
                } else {
                    out.push((p.strip_prefix(base).unwrap().to_string_lossy().into_owned(), std::fs::read(&p).unwrap()));
                }
            }
        }
        let mut out = Vec::new();
        walk(r, r, &mut out);
        out.sort();
        out
    }

    #[test]
    fn lists_what_exists() {
        let (r, s) = runtime("list", "one");
        let list = components(&r, &s);
        assert!(list.iter().all(|c| c.available));
        assert_eq!(list.iter().find(|c| c.id == "looks").unwrap().files, 2);
        std::fs::remove_file(r.join("plugins.json")).unwrap();
        std::fs::remove_dir_all(r.join("looks")).unwrap();
        let list = components(&r, &s);
        assert!(!list.iter().find(|c| c.id == "plugins").unwrap().available);
        assert!(!list.iter().find(|c| c.id == "looks").unwrap().available);
        assert!(list.iter().find(|c| c.id == "settings").unwrap().available);
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn round_trip_every_component() {
        let (r, s) = runtime("round", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &all(), &zip);
        let before = snapshot_of(&r);
        // change everything, then restore
        let (_, _) = (s.set("immage.theme", "changed").unwrap(), 0);
        std::fs::write(r.join("presets.json"), "[]").unwrap();
        std::fs::write(r.join("export-presets.json"), "{}").unwrap();
        std::fs::write(r.join("looks/C.dtstyle"), "extra").unwrap();
        std::fs::remove_file(r.join("looks/A.dtstyle")).unwrap();
        std::fs::write(r.join("plugins.json"), "[]").unwrap();
        std::fs::write(r.join("config/data.db"), fake_db("changed")).unwrap();
        std::fs::write(r.join("config/data.db-wal"), "stale").unwrap();
        let out = restore_all(&r, &s, &zip, &all(), "20261111-000001").unwrap();
        assert!(out.engine_restarted);
        assert!(!r.join("config/data.db-wal").exists());
        let mut after: Vec<_> = snapshot_of(&r).into_iter().filter(|(n, _)| n != "out.zip").collect();
        let mut expect: Vec<_> = before.into_iter().filter(|(n, _)| n != "out.zip").collect();
        after.sort();
        expect.sort();
        // plugins.json comes back without the program (that is set in the app only)
        let plug = |v: &mut Vec<(String, Vec<u8>)>| v.retain(|(n, _)| n != "plugins.json");
        plug(&mut after);
        plug(&mut expect);
        assert_eq!(after, expect);
        assert_eq!(Settings::load(&r).get(settings::GPU_EDITS).as_deref(), Some("off"));
        assert_eq!(s.get("immage.theme").as_deref(), Some("one"));
        let plugins: Vec<crate::plugins::PluginConfig> = serde_json::from_slice(&std::fs::read(r.join("plugins.json")).unwrap()).unwrap();
        assert_eq!(plugins[0].name, "one");
        // the plugin existed here with a program, so it keeps that one
        assert_eq!(plugins[0].app, "");
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn restore_into_a_fresh_runtime() {
        let (r, s) = runtime("src", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &all(), &zip);
        let fresh = dir("fresh");
        let fs = Settings::load(&fresh);
        restore_all(&fresh, &fs, &zip, &all(), "20261111-000001").unwrap();
        assert_eq!(fs.get("immage.theme").as_deref(), Some("one"));
        assert_eq!(std::fs::read(fresh.join("looks/B.dtstyle")).unwrap(), b"b-one");
        assert_eq!(std::fs::read(fresh.join("config/data.db")).unwrap(), fake_db("one"));
        let plugins: Vec<crate::plugins::PluginConfig> = serde_json::from_slice(&std::fs::read(fresh.join("plugins.json")).unwrap()).unwrap();
        assert_eq!(plugins[0].app, "");
        std::fs::remove_dir_all(r).unwrap();
        std::fs::remove_dir_all(fresh).unwrap();
    }

    #[test]
    fn partial_backup_and_partial_restore() {
        let (r, s) = runtime("partial", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &["presets".into(), "looks".into()], &zip);
        let info = inspect(&zip, "0.44.1").unwrap();
        assert_eq!(info.components.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["presets", "looks"]);
        assert!(!info.newer);
        std::fs::write(r.join("presets.json"), "[]").unwrap();
        std::fs::write(r.join("export-presets.json"), "{\"keep\":1}").unwrap();
        s.set("immage.theme", "kept").unwrap();
        let out = restore_all(&r, &s, &zip, &["presets".into()], "20261111-000001").unwrap();
        assert!(!out.engine_restarted);
        assert_eq!(std::fs::read_to_string(r.join("presets.json")).unwrap(), "[{\"name\":\"one\"}]");
        assert_eq!(std::fs::read_to_string(r.join("export-presets.json")).unwrap(), "{\"keep\":1}");
        assert_eq!(s.get("immage.theme").as_deref(), Some("kept"));
        // looks were not chosen
        std::fs::write(r.join("looks/A.dtstyle"), "mine").unwrap();
        restore_all(&r, &s, &zip, &["presets".into()], "20261111-000002").unwrap();
        assert_eq!(std::fs::read(r.join("looks/A.dtstyle")).unwrap(), b"mine");
        // a component the backup lacks is refused
        let err = restore_all(&r, &s, &zip, &["darktable".into()], "20261111-000003").unwrap_err();
        assert!(err.contains("holds no"), "{err}");
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn looks_are_replaced_not_merged() {
        let (r, s) = runtime("looks", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &["looks".into()], &zip);
        std::fs::write(r.join("looks/Extra.dtstyle"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hostname", r.join("looks/Link.dtstyle")).unwrap();
        restore_all(&r, &s, &zip, &["looks".into()], "20261111-000001").unwrap();
        assert!(!r.join("looks/Extra.dtstyle").exists());
        assert!(r.join("looks/A.dtstyle").exists() && r.join("looks/B.dtstyle").exists());
        // the symlink was neither backed up nor followed
        let pre = std::fs::read_dir(r.join("backups/pre-restore-20261111-000001/looks")).unwrap().count();
        assert_eq!(pre, 3);
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn pre_restore_copy_is_made_and_pruned() {
        let (r, s) = runtime("prune", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &all(), &zip);
        s.set("immage.theme", "before").unwrap();
        for n in 1..=5 {
            restore_all(&r, &s, &zip, &["settings".into(), "darktable".into()], &format!("20261111-00000{n}")).unwrap();
        }
        let mut kept: Vec<String> = std::fs::read_dir(r.join("backups")).unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        kept.sort();
        assert_eq!(kept, ["pre-restore-20261111-000003", "pre-restore-20261111-000004", "pre-restore-20261111-000005"]);
        let first = std::fs::read_dir(r.join("backups")).unwrap().count();
        assert_eq!(first, 3);
        // the first restore saved what was there
        let (r2, s2) = runtime("prune2", "two");
        make(&r, &s, &all(), &zip);
        restore_all(&r2, &s2, &zip, &["settings".into(), "darktable".into()], "20261111-000009").unwrap();
        let saved = r2.join("backups/pre-restore-20261111-000009");
        assert_eq!(std::fs::read(saved.join("darktable/data.db")).unwrap(), fake_db("two"));
        assert!(std::fs::read_to_string(saved.join("settings/settings.json")).unwrap().contains("two"));
        std::fs::remove_dir_all(r).unwrap();
        std::fs::remove_dir_all(r2).unwrap();
    }

    #[test]
    fn engine_is_stopped_around_the_data_swap() {
        let (r, s) = runtime("engine", "one");
        let zip = r.join("out.zip");
        make(&r, &s, &all(), &zip);
        let stops = Cell::new(0);
        let stop = |run: &mut dyn FnMut() -> Result<(), String>| {
            stops.set(stops.get() + 1);
            run()
        };
        restore(&r, &s, &zip, &["presets".into()], "20261111-000001", &stop).unwrap();
        assert_eq!(stops.get(), 0);
        restore(&r, &s, &zip, &["presets".into(), "darktable".into()], "20261111-000002", &stop).unwrap();
        assert_eq!(stops.get(), 1);
        // a stop that fails replaces nothing
        std::fs::write(r.join("presets.json"), "[]").unwrap();
        let fail = |_: &mut dyn FnMut() -> Result<(), String>| Err("stuck".to_string());
        assert!(restore(&r, &s, &zip, &["presets".into(), "darktable".into()], "20261111-000003", &fail).is_err());
        assert_eq!(std::fs::read_to_string(r.join("presets.json")).unwrap(), "[]");
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn hostile_names_are_refused() {
        let (r, s) = runtime("evil", "one");
        for name in ["../x", "/abs", "settings/../../x", "settings/..", "unknown/x", "looks\\a.dtstyle", "looks/..", "looks/a/b",
                     "settings/other.json", "presets.json", "looks//a", "looks/./a", "C:/x"] {
            let zip = r.join("evil.zip");
            raw_zip(&zip, &[(MANIFEST, MAN.as_bytes()), (name, b"{}")]);
            let before = snapshot_of(&r);
            assert!(inspect(&zip, "0.44.1").is_err(), "{name}");
            let err = restore_all(&r, &s, &zip, &["settings".into()], "20261111-000001");
            assert!(err.is_err(), "{name}");
            std::fs::remove_file(&zip).unwrap();
            assert_eq!(snapshot_of(&r), before.into_iter().filter(|(n, _)| n != "evil.zip").collect::<Vec<_>>(), "{name}");
        }
        // an unknown id asked for
        let zip = r.join("ok.zip");
        make(&r, &s, &["presets".into()], &zip);
        assert!(restore_all(&r, &s, &zip, &["../presets".into()], "20261111-000001").is_err());
        assert!(restore_all(&r, &s, &zip, &["keychain".into()], "20261111-000001").is_err());
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn not_a_backup() {
        let r = dir("notbackup");
        let zip = r.join("a.zip");
        raw_zip(&zip, &[("presets/presets.json", b"[]")]);
        assert!(inspect(&zip, "1.0.0").unwrap_err().contains("not an Immage backup"));
        std::fs::write(&zip, "plain text").unwrap();
        assert!(inspect(&zip, "1.0.0").is_err());
        raw_zip(&zip, &[(MANIFEST, b"{\"format\":2,\"app\":\"Immage\"}")]);
        assert!(inspect(&zip, "1.0.0").unwrap_err().contains("newer Immage"));
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn size_caps_stop_bombs() {
        let (r, s) = runtime("bomb", "one");
        let zip = r.join("bomb.zip");
        let zeros = vec![0u8; 2 << 20];
        raw_zip(&zip, &[(MANIFEST, MAN.as_bytes()), ("looks/big.dtstyle", &zeros)]);
        let total = Limits { total: 1 << 20, ..LIMITS };
        assert!(inspect_with(&zip, "1.0.0", &total).unwrap_err().contains("larger than"));
        let ratio = Limits { ratio_from: 1 << 20, ratio: 100, ..LIMITS };
        assert!(inspect_with(&zip, "1.0.0", &ratio).unwrap_err().contains("expands"));
        let before = snapshot_of(&r);
        let err = restore_with(&r, &s, &zip, &["looks".into()], "20261111-000001", &direct, &ratio);
        assert!(err.is_err());
        assert_eq!(snapshot_of(&r).into_iter().filter(|(n, _)| n != "bomb.zip").collect::<Vec<_>>(),
                   before.into_iter().filter(|(n, _)| n != "bomb.zip").collect::<Vec<_>>());
        let few = Limits { entries: 1, ..LIMITS };
        assert!(inspect_with(&zip, "1.0.0", &few).unwrap_err().contains("too many"));
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn a_bad_component_replaces_nothing() {
        let (r, s) = runtime("invalid", "one");
        let cases: [(&str, &str, &[u8]); 6] = [
            ("settings", "settings/settings.json", b"{\"a\": 1}"),
            ("settings", "settings/settings.json", b"[\"a\"]"),
            ("presets", "presets/presets.json", b"{not json"),
            ("plugins", "plugins/plugins.json", b"{\"id\":1}"),
            ("darktable", "darktable/data.db", b"not a database at all"),
            ("darktable", "darktable/data.db", b"short"),
        ];
        for (id, name, bytes) in cases {
            let zip = r.join("bad.zip");
            let good = fake_db("good");
            let mut entries: Vec<(&str, &[u8])> = vec![(MANIFEST, MAN.as_bytes()), (name, bytes), ("looks/Z.dtstyle", b"z")];
            for (n, b) in [("presets/presets.json", &b"[]"[..]), ("darktable/data.db", &good[..])] {
                if n != name {
                    entries.push((n, b));
                }
            }
            raw_zip(&zip, &entries);
            // the bad component is chosen together with valid ones
            let mut ids = vec!["looks".to_string(), id.to_string()];
            if id != "presets" {
                ids.push("presets".into());
            }
            let before = snapshot_of(&r);
            let err = restore_all(&r, &s, &zip, &ids, "20261111-000001");
            assert!(err.is_err(), "{name}");
            std::fs::remove_file(&zip).unwrap();
            assert_eq!(snapshot_of(&r).into_iter().collect::<Vec<_>>(), before.into_iter().filter(|(n, _)| n != "bad.zip").collect::<Vec<_>>(), "{name}");
            assert!(!r.join("backups/pre-restore-20261111-000001").exists(), "{name}");
        }
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn newer_versions() {
        assert!(newer("0.45.0", "0.44.1"));
        assert!(newer("0.44.10", "0.44.9"));
        assert!(newer("1.0", "0.99.9"));
        assert!(!newer("0.44.1", "0.44.1"));
        assert!(!newer("0.44.0", "0.44.1"));
        assert!(!newer("0.44", "0.44.0"));
        assert!(newer("0.44.2-beta", "0.44.1"));
        assert!(!newer("", "0.44.1"));
    }

    #[test]
    fn newer_backup_is_flagged() {
        let (r, s) = runtime("newer", "one");
        let zip = r.join("out.zip");
        create(&r, &s, &["presets".into()], &zip, "9.0.0", "now", &|_| Ok(())).unwrap();
        assert!(inspect(&zip, "0.44.1").unwrap().newer);
        assert!(!r.join("out.zip.part").exists());
        std::fs::remove_dir_all(r).unwrap();
    }

    #[test]
    fn failed_create_leaves_no_file() {
        let (r, s) = runtime("failcreate", "one");
        let zip = r.join("out.zip");
        let err = create(&r, &s, &["darktable".into()], &zip, "1.0.0", "now", &|_| Err("engine gone".into()));
        assert_eq!(err.unwrap_err(), "engine gone");
        assert!(!zip.exists() && !r.join("out.zip.part").exists());
        assert!(!r.join("backups").join(format!("snapshot-{}", std::process::id())).exists());
        assert!(create(&r, &s, &["bogus".into()], &zip, "1.0.0", "now", &|_| Ok(())).is_err());
        assert!(create(&r, &s, &[], &zip, "1.0.0", "now", &|_| Ok(())).is_err());
        std::fs::remove_dir_all(r).unwrap();
    }
}
