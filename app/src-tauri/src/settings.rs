// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the app's settings, in one settings.json in the runtime directory. values
// are strings, as in the web view's localStorage, so the page can keep its
// own keys here. Rust owns the file because a few settings are needed before
// the page exists (the webview renderer is read before GTK starts, the engine
// flags before it spawns), and a file the page cannot see could not be read
// by it. the keys under native. are those Rust reads itself
use serde::Deserialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub const FILE: &str = "settings.json";
const NATIVE: &str = "native.";
pub const RESOURCES: &str = "native.darktable-resources";
pub const GPU_EDITS: &str = "native.gpu-edits";
pub const RENDERER: &str = "native.webview-renderer";

// each native key began as a one-value file of this name in the runtime
// directory
const LOOSE: [(&str, &str); 3] = [
    (RESOURCES, "darktable-resources"),
    (GPU_EDITS, "gpu-edits"),
    (RENDERER, "webview-renderer"),
];

pub type Map = BTreeMap<String, String>;

pub struct Settings {
    runtime: PathBuf,
    map: Mutex<Map>,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn parse(text: &str) -> Option<Map> {
    // a null or number would deserialize into a string map on some parsers;
    // insist on an object of strings so a damaged file is not half-trusted
    Map::deserialize(&mut serde_json::Deserializer::from_str(text)).ok()
}

// atomic: a crash between the write and the rename leaves the old file whole
fn write(runtime: &Path, map: &Map) -> Result<(), String> {
    std::fs::create_dir_all(runtime).map_err(|e| e.to_string())?;
    let tmp = runtime.join(format!("{FILE}.tmp"));
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let result = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, runtime.join(FILE))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

// one key, without the store: renderer::init runs before Tauri exists. a
// native key still in its old loose file is read from there, so a first run
// after the move sees the user's choice before migrate has rewritten it
pub fn read_key(runtime: &Path, key: &str) -> Option<String> {
    let from_file = std::fs::read_to_string(runtime.join(FILE)).ok().and_then(|t| parse(&t)).and_then(|mut m| m.remove(key));
    from_file.or_else(|| {
        let name = LOOSE.iter().find(|(k, _)| *k == key)?.1;
        std::fs::read_to_string(runtime.join(name)).ok().map(|s| s.trim().to_string())
    })
}

impl Settings {
    pub fn load(runtime: &Path) -> Settings {
        let path = runtime.join(FILE);
        let map = match std::fs::read_to_string(&path) {
            Ok(text) => parse(&text).unwrap_or_else(|| {
                let aside = runtime.join(format!("{FILE}.corrupt-{}", now()));
                eprintln!("settings: {} is not valid, moved to {}", path.display(), aside.display());
                if let Err(e) = std::fs::rename(&path, &aside) {
                    eprintln!("settings: cannot move it aside: {e}");
                }
                Map::new()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Map::new(),
            Err(e) => {
                eprintln!("settings: cannot read {}: {e}", path.display());
                Map::new()
            }
        };
        Settings { runtime: runtime.to_path_buf(), map: Mutex::new(map) }
    }

    // moves the loose files of the native keys into the store, once. a key
    // already in the store wins, and its loose file is only deleted
    pub fn migrate(&self) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let mut found = Vec::new();
        for (key, name) in LOOSE {
            let path = self.runtime.join(name);
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            if !map.contains_key(key) {
                map.insert(key.to_string(), text.trim().to_string());
            }
            found.push(path);
        }
        if found.is_empty() {
            return Ok(());
        }
        // the loose files go only after the store holds their values
        write(&self.runtime, &map)?;
        for path in found {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }

    pub fn all(&self) -> Map {
        self.map.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub fn get(&self, key: &str) -> Option<String> {
        self.map.lock().unwrap().get(key).cloned()
    }

    // Restore's replacement of the whole map, native keys included, written
    // before the memory changes so a failed write leaves both as they were
    pub fn replace_all(&self, next: Map) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        write(&self.runtime, &next)?;
        *map = next;
        Ok(())
    }

    // applies the batch (None removes), then writes once. the lock is held
    // across the write so two batches cannot reach the file out of order; on a
    // failed write the memory is rolled back to match the disk
    pub fn apply(&self, changes: HashMap<String, Option<String>>) -> Result<(), String> {
        let mut map = self.map.lock().unwrap();
        let mut next = map.clone();
        for (key, value) in changes {
            match value {
                Some(v) => next.insert(key, v),
                None => next.remove(&key),
            };
        }
        if next == *map {
            return Ok(());
        }
        write(&self.runtime, &next)?;
        *map = next;
        Ok(())
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.apply(HashMap::from([(key.to_string(), Some(value.to_string()))]))
    }
}

#[tauri::command]
pub fn settings_all(settings: State<'_, Settings>) -> Map {
    settings.all()
}

// async so Tauri runs it off the main thread: the write fsyncs. native keys are
// refused here because only Rust's own setters may change them (they are
// validated there and read before the page exists)
#[tauri::command]
pub async fn settings_set(settings: State<'_, Settings>, changes: HashMap<String, Option<String>>) -> Result<(), String> {
    if let Some(key) = changes.keys().find(|k| k.starts_with(NATIVE)) {
        return Err(format!("settings: {key} is set by the app, not the page"));
    }
    settings.apply(changes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("immage-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn batch(items: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        items.iter().map(|(k, v)| (k.to_string(), v.map(str::to_string))).collect()
    }

    #[test]
    fn round_trip_and_batch() {
        let d = dir("round");
        let s = Settings::load(&d);
        assert!(s.all().is_empty());
        s.apply(batch(&[("a", Some("1")), ("b", Some("2")), ("c", Some("3"))])).unwrap();
        s.apply(batch(&[("b", None), ("c", Some("x")), ("zz", None)])).unwrap();
        let again = Settings::load(&d);
        assert_eq!(again.all(), BTreeMap::from([("a".into(), "1".into()), ("c".into(), "x".into())]));
        assert_eq!(read_key(&d, "c").as_deref(), Some("x"));
        assert_eq!(read_key(&d, "b"), None);
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn write_leaves_no_tmp_file() {
        let d = dir("tmp");
        let s = Settings::load(&d);
        s.set("k", "v").unwrap();
        assert!(d.join(FILE).is_file());
        assert!(!d.join(format!("{FILE}.tmp")).exists());
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        for bad in ["{not json", "[1,2]", "{\"a\": 1}"] {
            let d = dir("corrupt");
            std::fs::write(d.join(FILE), bad).unwrap();
            let s = Settings::load(&d);
            assert!(s.all().is_empty());
            assert!(!d.join(FILE).exists());
            let aside = std::fs::read_dir(&d).unwrap().filter_map(|e| e.ok())
                .any(|e| e.file_name().to_string_lossy().starts_with("settings.json.corrupt-"));
            assert!(aside, "{bad}");
            s.set("k", "v").unwrap();
            assert_eq!(Settings::load(&d).get("k").as_deref(), Some("v"));
            std::fs::remove_dir_all(d).unwrap();
        }
    }

    #[test]
    fn loose_files_migrate() {
        let d = dir("migrate");
        std::fs::write(d.join("darktable-resources"), "large\n").unwrap();
        std::fs::write(d.join("gpu-edits"), "off").unwrap();
        std::fs::write(d.join("webview-renderer"), "mesa").unwrap();
        // readable before the migration, as renderer::init does
        assert_eq!(read_key(&d, RENDERER).as_deref(), Some("mesa"));
        let s = Settings::load(&d);
        s.migrate().unwrap();
        for name in ["darktable-resources", "gpu-edits", "webview-renderer"] {
            assert!(!d.join(name).exists(), "{name}");
        }
        let again = Settings::load(&d);
        assert_eq!(again.get(RESOURCES).as_deref(), Some("large"));
        assert_eq!(again.get(GPU_EDITS).as_deref(), Some("off"));
        assert_eq!(again.get(RENDERER).as_deref(), Some("mesa"));
        std::fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn migration_keeps_a_stored_value() {
        let d = dir("migrate-keep");
        let s = Settings::load(&d);
        s.set(GPU_EDITS, "on").unwrap();
        std::fs::write(d.join("gpu-edits"), "off").unwrap();
        s.migrate().unwrap();
        assert!(!d.join("gpu-edits").exists());
        assert_eq!(read_key(&d, GPU_EDITS).as_deref(), Some("on"));
        std::fs::remove_dir_all(d).unwrap();
    }
}
