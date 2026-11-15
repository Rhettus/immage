// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded metadata backfill and automatic CPU embeddings after model opt-in.
use crate::{
    analysis_queue::{AnalysisQueue, Job},
    clip_models::Models,
    engine::Tagged,
    frame_output::FrameOutput,
    search_cache::{PendingAnalysis, SearchCache},
};
use serde_json::json;
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub struct Control(Arc<AtomicBool>);
impl Control {
    pub fn stop(&self) {
        self.0.store(true, Ordering::Release);
    }
}
impl Drop for Control {
    fn drop(&mut self) {
        self.stop();
    }
}
struct Service {
    cache: Arc<SearchCache>,
    models: Arc<Models>,
    queue: Arc<AnalysisQueue>,
    engine: Tagged,
    output: Arc<FrameOutput>,
    runtime: PathBuf,
    after: Mutex<i64>,
    stop: Arc<AtomicBool>,
}
pub fn start(
    cache: Option<Arc<SearchCache>>,
    models: Arc<Models>,
    queue: Arc<AnalysisQueue>,
    engine: Tagged,
    output: Arc<FrameOutput>,
    runtime: PathBuf,
) -> Control {
    let stop = Arc::new(AtomicBool::new(false));
    if let Some(cache) = cache {
        let service = Arc::new(Service {
            cache,
            models,
            queue,
            engine,
            output,
            runtime,
            after: Mutex::new(0),
            stop: stop.clone(),
        });
        std::thread::spawn(move || {
            while !service.stop.load(Ordering::Acquire) {
                // No directory creation, download or engine request without installed assets.
                if service.models.installed() {
                    let next = service.clone();
                    service.queue.submit("clip:scan".into(), move |job| {
                        if !job.cancelled() && !next.stop.load(Ordering::Acquire) {
                            if let Err(e) = next.scan(&job) {
                                eprintln!("local analysis: {e}");
                            }
                        }
                    });
                }
                std::thread::sleep(Duration::from_secs(5));
            }
        });
    }
    Control(stop)
}
impl Service {
    fn scan(self: &Arc<Self>, job: &Job) -> Result<(), String> {
        // Verify the installed package before any lazy photo import/render.
        self.models.prepare_text("")?;
        if job.cancelled() {
            return Ok(());
        }
        let mut after = self
            .after
            .lock()
            .map_err(|_| "Analysis scan lock poisoned")?;
        let rows = self.cache.pending_analyses(*after, 32)?;
        *after = rows.last().map_or(0, |r| r.variant_id);
        let selection = library_selection(&self.runtime);
        for row in rows {
            if !selected(Path::new(&row.path), &selection) {
                continue;
            }
            if row.needs_metadata {
                let service = self.clone();
                self.queue
                    .submit(format!("clip:metadata:{}", row.variant_id), move |job| {
                        if let Err(e) = service.refresh_metadata(&row, &job) {
                            eprintln!("local analysis metadata: {e}");
                        }
                    });
                continue;
            }
            for subject in ["original", "edited"] {
                if job.cancelled() || self.stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                if !(if subject == "original" {
                    row.needs_original
                } else {
                    row.needs_edited
                }) {
                    continue;
                }
                let key = if subject == "original" {
                    format!("clip:original:{}", row.asset_id)
                } else {
                    format!("clip:edited:{}", row.variant_id)
                };
                let service = self.clone();
                let row = row.clone();
                self.queue.submit(key, move |job| {
                    if let Err(e) = service.analyze(&row, subject, &job) {
                        eprintln!("local analysis: {e}");
                    }
                });
            }
        }
        Ok(())
    }
    fn refresh_metadata(&self, row: &PendingAnalysis, job: &Job) -> Result<(), String> {
        if job.cancelled() || self.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if !selected(Path::new(&row.path), &library_selection(&self.runtime)) {
            return Ok(());
        }
        let version = version(&row.copy_key)?;
        let listing = Mutex::new(crate::cache::Listed::default());
        let before =
            crate::cache::listed_metadata_fingerprints(&listing, Path::new(&row.path), version);
        let Some((original, edited)) = before.as_ref() else {
            return Ok(());
        };
        if original != &row.original {
            return Ok(());
        }
        let imgid = self.engine.cached_photo(&row.path, version);
        let reply = self
            .engine
            .request(self.engine.tag(), json!({"cmd":"meta","imgid":imgid}))?;
        if before
            != crate::cache::listed_metadata_fingerprints(&listing, Path::new(&row.path), version)
        {
            return Ok(());
        }
        if let Some(mut image) = reply.get("image").cloned() {
            let (ns, raw, offset) = crate::library_cmds::precise_capture(&image);
            if let Some(fields) = image.as_object_mut() {
                fields.remove("imgid");
            }
            let metadata = serde_json::to_string(&image).map_err(|e| e.to_string())?;
            job.commit(|| {
                self.cache.finish_analysis_metadata(
                    row,
                    edited,
                    &metadata,
                    (ns, raw.as_deref(), offset),
                )
            })
            .transpose()?;
        }
        Ok(())
    }

    fn analyze(&self, row: &PendingAnalysis, subject: &str, job: &Job) -> Result<(), String> {
        if job.cancelled() || self.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if !selected(Path::new(&row.path), &library_selection(&self.runtime)) {
            return Ok(());
        }
        let version = version(&row.copy_key)?;
        if !current(row, subject, version) {
            return Ok(());
        }
        let imgid = self.engine.cached_photo(&row.path, version);
        let tag = self.engine.tag();
        let out = self.output.path(&format!("analysis-{tag}.jpg"));
        let preview = (|| {
            self.engine.request(
                tag,
                json!({"cmd":"analysis_preview", "imgid":imgid,"subject":subject,"out":out}),
            )?;
            FrameOutput::read(&out).map_err(|e| e.to_string())
        })();
        self.output.remove(&out);
        let preview = preview?;
        if job.cancelled() || !current(row, subject, version) {
            return Ok(());
        }
        let mut reader = image::ImageReader::new(std::io::Cursor::new(preview));
        reader.set_format(image::ImageFormat::Jpeg);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(1024);
        limits.max_image_height = Some(1024);
        limits.max_alloc = Some(16 * 1024 * 1024);
        reader.limits(limits);
        let rgb = reader.decode().map_err(|e| e.to_string())?.to_rgb8();
        let vector = crate::clip_infer::image(
            &self.models,
            &self.engine,
            &self.runtime,
            rgb.as_raw(),
            rgb.width() as usize,
            rgb.height() as usize,
        )?;
        if !current(row, subject, version) {
            return Ok(());
        }
        let bytes = vector
            .into_iter()
            .flat_map(f32::to_le_bytes)
            .collect::<Vec<_>>();
        let expected = if subject == "original" {
            &row.original
        } else {
            &row.edited
        };
        job.commit(|| {
            self.cache.put_analysis(
                row.variant_id,
                subject,
                expected,
                crate::local_search::ANALYSIS_VERSION,
                crate::local_search::MODEL_VERSION,
                &bytes,
            )
        })
        .transpose()?;
        Ok(())
    }
}
fn library_selection(runtime: &Path) -> serde_json::Value {
    crate::settings::read_key(runtime, "immage.library")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}
fn selected(path: &Path, config: &serde_json::Value) -> bool {
    let within = |key: &str| {
        config[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .map(Path::new)
            .any(|root| root.is_absolute() && path.starts_with(root))
    };
    path.is_absolute() && within("folders") && !within("hidden")
}

fn version(key: &str) -> Result<i64, String> {
    if key.is_empty() {
        Ok(0)
    } else {
        key.strip_prefix("version:")
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| (1..1_000_000).contains(v))
            .ok_or_else(|| "Invalid indexed photo version".into())
    }
}
fn current(row: &PendingAnalysis, subject: &str, version: i64) -> bool {
    crate::cache::listed_metadata_fingerprints(
        &Mutex::new(crate::cache::Listed::default()),
        Path::new(&row.path),
        version,
    )
    .is_some_and(|(original, edited)| {
        original == row.original && (subject == "original" || edited == row.edited)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn background_selection_excludes_hidden_removed_and_component_prefix_paths() {
        let config = json!({"folders":["/photos"],"hidden":["/photos/excluded"]});
        assert!(selected(Path::new("/photos/a.jpg"), &config));
        assert!(!selected(Path::new("/photos-other/a.jpg"), &config));
        assert!(!selected(Path::new("/photos/excluded/a.jpg"), &config));
        assert!(!selected(Path::new("/removed/a.jpg"), &config));
        assert!(!selected(Path::new("relative/a.jpg"), &config));
        assert!(!selected(
            Path::new("/photos/a.jpg"),
            &json!({"folders":[]})
        ));
        assert!(!selected(
            Path::new("/photos/a.jpg"),
            &serde_json::Value::Null
        ));
    }

    #[test]
    fn pending_rows_share_originals_and_require_current_model_versions() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let a = cache
            .upsert_variant("/photos/a.jpg", "", "source", "edit", None, None, None)
            .unwrap();
        let b = cache
            .upsert_variant(
                "/photos/a.jpg",
                "version:2",
                "source",
                "copy",
                None,
                None,
                None,
            )
            .unwrap();
        assert!(cache
            .pending_analyses(0, 32)
            .unwrap()
            .iter()
            .all(|r| r.needs_metadata));
        cache.store_metadata(a.id, "{}").unwrap();
        cache.store_metadata(b.id, "{}").unwrap();
        let rows = cache.pending_analyses(0, 32).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.needs_original && r.needs_edited));
        cache
            .put_analysis(
                a.id,
                "original",
                "source",
                crate::local_search::ANALYSIS_VERSION,
                "old-model",
                &[0; 2048],
            )
            .unwrap();
        assert!(cache.pending_analyses(0, 32).unwrap()[0].needs_original);
        cache
            .put_analysis(
                a.id,
                "original",
                "source",
                crate::local_search::ANALYSIS_VERSION,
                crate::local_search::MODEL_VERSION,
                &[0; 2048],
            )
            .unwrap();
        assert!(cache
            .pending_analyses(0, 32)
            .unwrap()
            .iter()
            .all(|r| !r.needs_original && r.needs_edited));
        cache
            .put_analysis(
                a.id,
                "edited",
                "edit",
                crate::local_search::ANALYSIS_VERSION,
                crate::local_search::MODEL_VERSION,
                &[0; 2048],
            )
            .unwrap();
        let rows = cache.pending_analyses(0, 32).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].variant_id, b.id);
        assert!(cache.pending_analyses(b.id, 32).unwrap().is_empty());
    }
    #[test]
    fn metadata_backfill_cannot_recreate_cleared_or_changed_rows() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let a = cache
            .upsert_variant("/photos/a.jpg", "", "source", "edit", None, None, None)
            .unwrap();
        let row = cache.pending_analyses(0, 1).unwrap().remove(0);
        cache.invalidate_edited("/photos/a.jpg", "").unwrap();
        assert!(!cache
            .finish_analysis_metadata(&row, "fresh", "{}", (None, None, None))
            .unwrap());
        let row = cache.pending_analyses(0, 1).unwrap().remove(0);
        assert!(cache
            .finish_analysis_metadata(&row, "fresh", "{}", (None, Some("raw"), None))
            .unwrap());
        assert_eq!(cache.metadata(a.id).unwrap().as_deref(), Some("{}"));
        cache.clear().unwrap();
        cache
            .upsert_variant("/photos/a.jpg", "", "source", "edit", None, None, None)
            .unwrap();
        assert!(!cache
            .finish_analysis_metadata(&row, "fresh", "{}", (None, None, None))
            .unwrap());
    }

    #[test]
    fn input_guard_distinguishes_source_and_edit_changes_and_ignores_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.jpg");
        std::fs::write(&path, b"photo").unwrap();
        let (original, edited) = crate::cache::listed_metadata_fingerprints(
            &Mutex::new(crate::cache::Listed::default()),
            &path,
            0,
        )
        .unwrap();
        let row = PendingAnalysis {
            variant_id: 1,
            asset_id: 1,
            path: path.to_string_lossy().into_owned(),
            copy_key: String::new(),
            original,
            edited,
            needs_metadata: false,
            needs_original: true,
            needs_edited: true,
        };
        assert!(current(&row, "original", 0) && current(&row, "edited", 0));
        std::fs::write(path.with_extension("jpg.xmp"), b"changed edit").unwrap();
        assert!(current(&row, "original", 0));
        assert!(!current(&row, "edited", 0));
        std::fs::write(&path, b"changed source bytes").unwrap();
        assert!(!current(&row, "original", 0));
        std::fs::remove_file(&path).unwrap();
        assert!(!current(&row, "original", 0));
        assert_eq!(version("version:2").unwrap(), 2);
        assert!(version("version:1000000").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn metadata_refresh_lazily_imports_and_caches_current_virtual_copy_metadata() {
        use std::{os::unix::fs::PermissionsExt, sync::mpsc, time::Duration};

        let dir = tempfile::tempdir().unwrap();
        let photo = dir.path().join("source.jpg");
        std::fs::write(&photo, b"disposable source bytes").unwrap();
        let copy_key = "version:2";
        std::fs::write(
            dir.path().join("source_02.jpg.xmp"),
            b"disposable edit metadata",
        )
        .unwrap();
        let (original, edited) = crate::cache::listed_metadata_fingerprints(
            &Mutex::new(crate::cache::Listed::default()),
            &photo,
            2,
        )
        .unwrap();
        let cache = Arc::new(SearchCache::open(&dir.path().join("search.sqlite")).unwrap());
        let variant = cache
            .upsert_variant(
                photo.to_str().unwrap(),
                copy_key,
                &original,
                &edited,
                None,
                None,
                None,
            )
            .unwrap();
        let row = cache.pending_analyses(0, 1).unwrap().remove(0);
        assert_eq!(row.copy_key, copy_key);

        let bin = dir.path().join("fake-engine");
        let script = r#"#!/bin/sh
exec python3 -u -c '
import json, sys
from pathlib import Path
log = Path(sys.argv[1]).with_name("engine-requests")
paths = {}
for line in sys.stdin:
    req = json.loads(line)
    cmd = req.get("cmd")
    out = {"ok": True}
    if "tag" in req: out["tag"] = req["tag"]
    if "rid" in req: out["rid"] = req["rid"]
    with log.open("a") as f: f.write(json.dumps(req) + "\n")
    if cmd == "quit":
        print(json.dumps(out), flush=True)
        break
    if cmd == "import":
        path = req["files"][0]
        paths[8] = path
        out["images"] = [
            {"imgid": 7, "path": path, "version": 0},
            {"imgid": 8, "path": path, "version": 2},
        ]
    elif cmd == "meta":
        out["image"] = {
            "imgid": req["imgid"], "path": paths[req["imgid"]], "version": 2,
            "filename": "source.jpg", "rating": 4, "edited": True,
            "rejected": False, "labels": 1, "width": 64, "height": 32,
            "location": None, "keywords": [], "copy": True,
            "exif": {"maker":"Camera", "model":"Test", "lens":"Lens",
                     "exposure":0.01,"aperture":2.8,"iso":100,"focal_length":50,
                     "exposure_bias":0,"focus_distance":0,
                     "datetime": "2024:01:02 03:04:05",
                     "capture_time_raw": "2024:01:02 03:04:05.123456789",
                     "capture_offset": "+02:30"},
        }
    print(json.dumps(out), flush=True)
' "$0"
"#;
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let runtime = dir.path().join("runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        crate::settings::Settings::load(&runtime)
            .set(
                "immage.library",
                &json!({"folders":[dir.path()],"hidden":[]}).to_string(),
            )
            .unwrap();
        let mut engine = crate::engine::Engine::spawn(&bin, &runtime, &runtime).unwrap();
        engine.set_search_cache(Some(cache.clone()));
        let service = Arc::new(Service {
            cache: cache.clone(),
            models: Arc::new(Models::new(dir.path().join("no-models"))),
            queue: Arc::new(AnalysisQueue::new(1, 8)),
            engine: engine.tagged(),
            output: Arc::new(FrameOutput::new(&runtime)),
            runtime,
            after: Mutex::new(0),
            stop: Arc::new(AtomicBool::new(false)),
        });
        let (tx, rx) = mpsc::channel();
        let task_service = service.clone();
        let task_row = row.clone();
        assert!(service
            .queue
            .submit_foreground("metadata-refresh-test".into(), move |job| {
                tx.send(task_service.refresh_metadata(&task_row, &job))
                    .unwrap();
            }));
        rx.recv_timeout(Duration::from_secs(10)).unwrap().unwrap();
        engine.quit();

        let commands: Vec<String> = std::fs::read_to_string(dir.path().join("engine-requests"))
            .unwrap()
            .lines()
            .map(|line| {
                serde_json::from_str::<serde_json::Value>(line).unwrap()["cmd"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(commands.iter().filter(|cmd| *cmd == "import").count(), 1);
        assert_eq!(commands.iter().filter(|cmd| *cmd == "meta").count(), 1);
        let meta_position = commands.iter().position(|cmd| cmd == "meta").unwrap();
        assert!(commands.iter().position(|cmd| cmd == "import").unwrap() < meta_position);

        let stored: serde_json::Value =
            serde_json::from_str(&cache.metadata(variant.id).unwrap().unwrap()).unwrap();
        assert_eq!(stored["path"], photo.to_str().unwrap());
        assert_eq!(stored["version"], 2);
        assert!(
            stored.get("imgid").is_none(),
            "engine IDs must not enter the cache"
        );
        let current = cache
            .variant(photo.to_str().unwrap(), copy_key)
            .unwrap()
            .unwrap();
        assert_eq!(current.edited_fingerprint, edited);
        assert_eq!(
            current.capture_time_raw.as_deref(),
            Some("2024:01:02 03:04:05.123456789")
        );
        assert_eq!(current.timezone_offset_seconds, Some(9000));
        assert!(current.capture_time_ns.is_some());
        let args = crate::local_search::LocalSearchArgs {
            mode: "filename".into(),
            ..Default::default()
        };
        let page = crate::local_search::retrieve(
            &cache,
            &args,
            &[dir.path().to_path_buf()],
            &[],
            None,
            || false,
        )
        .unwrap();
        assert_eq!(
            page.items.len(),
            1,
            "backfilled metadata must be searchable with production version keys"
        );
        assert_eq!(page.items[0].variant_id, variant.id.to_string());
        assert_eq!(page.items[0].image.version, 2);
    }
}
