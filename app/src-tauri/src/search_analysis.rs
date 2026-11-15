// SPDX-License-Identifier: GPL-3.0-or-later
//! Automatic CPU embeddings for metadata already cached by folder browsing.
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
        for row in rows {
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
    fn analyze(&self, row: &PendingAnalysis, subject: &str, job: &Job) -> Result<(), String> {
        if job.cancelled() || self.stop.load(Ordering::Acquire) {
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
        assert!(
            cache.pending_analyses(0, 32).unwrap().is_empty(),
            "uncached metadata must not trigger analysis imports"
        );
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
}
