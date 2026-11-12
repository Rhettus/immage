//! The support bundle: Help > Create Support Bundle makes a .zip of diagnostics
//! (the engine's log, versions and machine, the preferences that are not the
//! defaults, and optionally a GUI benchmark report) with private values replaced
//! by scrub.rs. Nothing is uploaded; the user reviews the scrubbed text, removes
//! any lines, and saves the file where they choose.
//!
//! The scrubbed text stays here between the commands. The page gets lines to
//! show and sends back only the indexes of lines to drop, never text, so what
//! is saved is always what the scrubber produced.

use crate::scrub::{known_from_system, Known, Scrubber};
use crate::typed_app::{BundleFile, BundleView, PageValues};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

pub struct File {
    pub name: String,
    pub lines: Vec<String>,
}

pub struct Bundle {
    scrubber: Scrubber,
    files: Vec<File>,
}

#[derive(Default)]
pub struct BundleState(Mutex<Option<Bundle>>);

// the engine log is capped at 5 MB by the engine; this guards a file that is not
const LOG_LIMIT: u64 = 16 << 20;

pub fn read_log(runtime: &Path) -> String {
    let path = runtime.join("engine.log");
    match std::fs::metadata(&path) {
        Ok(m) if m.len() > LOG_LIMIT => "engine.log is larger than expected and was left out.".into(),
        Ok(_) => match std::fs::read(&path) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => format!("engine.log could not be read: {}", e.kind()),
        },
        Err(_) => "There is no engine.log yet.".into(),
    }
}

fn split_lines(text: &str) -> Vec<String> {
    text.lines().map(str::to_string).collect()
}

fn known_with(page: &PageValues) -> Known {
    let mut k = known_from_system();
    k.folders.extend(page.folders.iter().cloned());
    k.photos.extend(page.photos.iter().cloned());
    k.extra.extend(page.extra.iter().cloned());
    k
}

/// Scrubs the log, the system block and the preferences with one scrubber.
/// Separate from the commands so tests can run it without Tauri.
pub fn collect(known: Known, page_prefs: &Value, engine_log: &str, system: &Value) -> Bundle {
    let mut scrubber = Scrubber::new(known);
    let mut files = Vec::new();
    let mut add = |name: &str, text: String| {
        files.push(File { name: name.into(), lines: split_lines(&scrubber.scrub(&text)) });
    };
    add("system.json", serde_json::to_string_pretty(system).unwrap_or_default());
    add("preferences.json", serde_json::to_string_pretty(page_prefs).unwrap_or_default());
    add("engine.log", engine_log.to_string());
    Bundle { scrubber, files }
}

impl Bundle {
    fn view(&self) -> BundleView {
        let counts: BTreeMap<String, usize> = self.scrubber.counts();
        BundleView {
            files: self.files.iter().map(|f| BundleFile { name: f.name.clone(), lines: f.lines.clone() }).collect(),
            counts: counts.into_iter().map(|(k, n)| (k, n as u64)).collect(),
        }
    }

    fn set_file(&mut self, name: &str, text: &str) {
        let lines = split_lines(&self.scrubber.scrub(text));
        match self.files.iter_mut().find(|f| f.name == name) {
            Some(f) => f.lines = lines,
            None => self.files.push(File { name: name.into(), lines }),
        }
    }

    /// The files as saved: the lines the user removed are dropped.
    fn kept(&self, removed: &HashMap<String, Vec<usize>>) -> Vec<(String, String)> {
        self.files
            .iter()
            .map(|f| {
                let skip: std::collections::HashSet<usize> =
                    removed.get(&f.name).map(|v| v.iter().copied().collect()).unwrap_or_default();
                let mut text = String::new();
                for (i, l) in f.lines.iter().enumerate() {
                    if !skip.contains(&i) {
                        text.push_str(l);
                        text.push('\n');
                    }
                }
                (f.name.clone(), text)
            })
            .collect()
    }
}

pub fn write_zip(path: &Path, entries: &[(String, String)]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, text) in entries {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

// version of the engine's darktable and what the GPU offers, when it answers.
// The button is offered exactly when the engine is stuck or gone, and
// state.engine() waits on its mutex without a limit, so the requests run on
// their own thread and are given 3 s; a late answer is dropped
fn engine_facts(app: &AppHandle) -> (Value, Option<Value>) {
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    std::thread::spawn(move || {
        let state = handle.state::<crate::AppState>();
        let version = match state.engine("support_bundle").request(json!({ "cmd": "version" })) {
            Ok(r) => r["version"].clone(),
            Err(e) => json!(format!("the engine did not answer: {e}")),
        };
        let opencl = state.engine("support_bundle").request(json!({ "cmd": "opencl" })).ok().map(|mut r| {
            if let Some(o) = r.as_object_mut() {
                o.remove("ok");
            }
            r
        });
        let _ = tx.send((version, opencl));
    });
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .unwrap_or_else(|_| (json!("the engine was busy and did not answer within 3 s"), None))
}

#[tauri::command]
#[specta::specta]
pub async fn support_bundle_preview(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    bundle: State<'_, BundleState>,
    page: PageValues,
) -> Result<BundleView, String> {
    let dir = app.path().app_data_dir().ok();
    let runtime = state.runtime.clone();
    let app_version = app.package_info().version.to_string();
    let built = tauri::async_runtime::spawn_blocking(move || {
        let (darktable, opencl) = engine_facts(&app);
        let mut machine = crate::machine_block(dir.as_deref(), opencl);
        if let Some(o) = machine.as_object_mut() {
            o.insert("app".into(), json!(app_version));
            o.insert("build".into(), json!(crate::build_label()));
            o.insert("darktable".into(), darktable);
        }
        collect(known_with(&page), &page.prefs, &read_log(&runtime), &machine)
    })
    .await
    .map_err(|e| e.to_string())?;
    let view = built.view();
    *bundle.0.lock().unwrap() = Some(built);
    Ok(view)
}

/// A GUI benchmark report the user picks from the reports folder, added to the bundle.
#[tauri::command]
#[specta::specta]
pub async fn support_bundle_add_benchmark(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    bundle: State<'_, BundleState>,
) -> Result<Option<BundleView>, String> {
    if bundle.0.lock().unwrap().is_none() {
        return Err("the bundle was not started".into());
    }
    let dir = state.perf_dir.clone();
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = handle.dialog().file().add_filter("GUI benchmark report", &["json"]);
        if dir.is_dir() {
            dialog = dialog.set_directory(&dir);
        }
        dialog.blocking_pick_file().and_then(|f| f.into_path().ok())
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };
    let real = crate::path_inside(&path, &[&state.perf_dir]).map_err(|_| "pick a report from the GUI benchmark folder".to_string())?;
    if std::fs::metadata(&real).map_err(|e| e.to_string())?.len() > 64 << 20 {
        return Err("that report is too large".into());
    }
    let text = String::from_utf8_lossy(&std::fs::read(&real).map_err(|e| e.to_string())?).into_owned();
    let mut guard = bundle.0.lock().unwrap();
    let b = guard.as_mut().ok_or("the bundle was not started")?;
    b.set_file("benchmark.json", &text);
    Ok(Some(b.view()))
}

#[tauri::command]
#[specta::specta]
pub async fn support_bundle_save(
    app: AppHandle,
    bundle: State<'_, BundleState>,
    removed: HashMap<String, Vec<usize>>,
) -> Result<Option<String>, String> {
    let name = format!("immage-support-{}.zip", chrono::Local::now().format("%Y-%m-%d"));
    let Some(path) = crate::pick_save(&app, "Support bundle", &["zip"], &name).await? else { return Ok(None) };
    let entries = bundle.0.lock().unwrap().as_ref().ok_or("the bundle was not started")?.kept(&removed);
    tauri::async_runtime::spawn_blocking({
        let path = path.clone();
        move || write_zip(&path, &entries)
    })
    .await
    .map_err(|e| e.to_string())??;
    *bundle.0.lock().unwrap() = None;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Drops the held text when the dialog is cancelled.
#[tauri::command]
#[specta::specta]
pub fn support_bundle_discard(bundle: State<'_, BundleState>) {
    *bundle.0.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn planted() -> (Known, String) {
        let known = Known {
            home: vec!["/home/rhett".into()],
            users: vec!["rhett".into()],
            hosts: vec!["rhetts-box".into()],
            folders: vec!["/home/rhett/Pictures/Iceland 2026".into()],
            photos: vec!["DSC01234.ARW".into()],
            extra: vec!["photos.rhett-family.example".into()],
        };
        let log = "2026-11-11T10:00:00Z open /home/rhett/Pictures/Iceland 2026/DSC01234.ARW on rhetts-box\n\
                   2026-11-11T10:00:01Z upload to https://photos.rhett-family.example/api by rhett\n\
                   2026-11-11T10:00:02Z darktable 5.5.0 ready\n";
        (known, log.into())
    }

    #[test]
    fn preview_has_no_private_value() {
        let (known, log) = planted();
        let prefs = json!({ "immage.recent": "[\"/home/rhett/Pictures/Iceland 2026\"]" });
        let system = json!({ "os": "Linux", "note": "/home/rhett/.config" });
        let b = collect(known, &prefs, &log, &system);
        let all = serde_json::to_string(&b.view()).unwrap().to_lowercase();
        for secret in ["rhett", "iceland", "dsc01234", "rhetts-box"] {
            assert!(!all.contains(secret), "{secret} survived: {all}");
        }
        assert!(all.contains("2026-11-11t10:00:02z darktable 5.5.0 ready"));
        assert_eq!(b.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["system.json", "preferences.json", "engine.log"]);
    }

    #[test]
    fn removed_lines_are_dropped() {
        let (known, log) = planted();
        let b = collect(known, &json!({}), &log, &json!({}));
        let mut removed = HashMap::new();
        removed.insert("engine.log".to_string(), vec![0, 1]);
        let kept = b.kept(&removed);
        let engine = kept.iter().find(|(n, _)| n == "engine.log").unwrap();
        assert_eq!(engine.1.lines().count(), 1);
        assert!(engine.1.contains("darktable 5.5.0 ready"));
        let all = b.kept(&HashMap::new());
        assert_eq!(all.iter().find(|(n, _)| n == "engine.log").unwrap().1.lines().count(), 3);
    }

    #[test]
    fn benchmark_is_added_and_replaced_with_the_same_numbering() {
        let (known, log) = planted();
        let mut b = collect(known, &json!({}), &log, &json!({}));
        b.set_file("benchmark.json", "{\"photo\": \"DSC01234.ARW\", \"user\": \"rhett\"}");
        b.set_file("benchmark.json", "{\"photo\": \"DSC01234.ARW\"}");
        assert_eq!(b.files.iter().filter(|f| f.name == "benchmark.json").count(), 1);
        let text = b.files.last().unwrap().lines.join("\n");
        assert!(!text.contains("DSC01234"), "{text}");
    }

    #[test]
    fn zip_round_trip() {
        let dir = std::env::temp_dir().join(format!("immage-bundle-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("b.zip");
        let entries = vec![("engine.log".to_string(), "one\ntwo\n".to_string()), ("system.json".to_string(), "{}\n".to_string())];
        write_zip(&path, &entries).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(zip.len(), 2);
        for (name, text) in &entries {
            let mut got = String::new();
            zip.by_name(name).unwrap().read_to_string(&mut got).unwrap();
            assert_eq!(&got, text);
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_log_is_a_note() {
        let dir = std::env::temp_dir().join("immage-no-such-runtime-dir");
        assert!(read_log(&dir).contains("no engine.log"));
    }
}
