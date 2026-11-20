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
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// How Find's indicator sees the analysis backlog. The status command, a sync
/// one, reads the atomics only, so it never waits on the service, the queue or
/// the cache. `pending` is -1 until a complete count; the times are
/// milliseconds since `now_ms`'s epoch plus one, 0 meaning never.
/// `unavailable` holds the variants the status probe found missing or offline, left
/// out of `pending` until a later probe reaches them again. It is a leaf lock:
/// held for memory work only, with no other lock taken inside it.
struct Progress {
    installed: AtomicBool,
    pending: AtomicI64,
    running: AtomicUsize,
    last_work_ms: AtomicU64,
    wanted_ms: AtomicU64,
    unavailable: Mutex<HashMap<i64, String>>,
}
impl Progress {
    fn new() -> Self {
        Progress {
            installed: AtomicBool::new(false),
            pending: AtomicI64::new(-1),
            running: AtomicUsize::new(0),
            last_work_ms: AtomicU64::new(0),
            wanted_ms: AtomicU64::new(0),
            unavailable: Mutex::default(),
        }
    }
    fn count_requested(&self) -> bool {
        let wanted = self.wanted_ms.load(Ordering::Acquire);
        wanted != 0 && now_ms().saturating_sub(wanted) <= WANTED_FOR_MS
    }
    fn is_unavailable(&self, variant: i64, path: &str) -> bool {
        self.unavailable
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&variant)
            .is_some_and(|checked| checked == path)
    }
    fn update_availability(&self, observations: AvailabilityObservations) -> bool {
        let mut changed = false;
        let mut unavailable = self.unavailable.lock().unwrap_or_else(|e| e.into_inner());
        for (variant, path, gone) in observations {
            if gone {
                changed |= unavailable.get(&variant) != Some(&path);
                unavailable.insert(variant, path);
            } else {
                changed |= unavailable.remove(&variant).is_some();
            }
        }
        changed
    }
}
fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}
/// A photo job that finished this recently still counts as working.
const ACTIVE_FOR_MS: u64 = 15_000;
/// The page's last request keeps the backlog counted this long.
const WANTED_FOR_MS: u64 = 10_000;
const COUNT_EVERY: Duration = Duration::from_secs(5);
const SCAN_EVERY: Duration = Duration::from_secs(5);
const COUNT_PAGE: u32 = 1024;
const AVAILABILITY_PAGE: u32 = 64;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct AnalysisProgress {
    pub installed: bool,
    pub pending: Option<u32>,
    pub running: u32,
    pub active: bool,
    pub paused: bool,
}

/// Counts a photo job while it does real work, on every way out. Taken only
/// once the job's checks pass: a photo that is missing, offline or changed is
/// offered again at every scan and must not read as analysis in progress.
struct RunGuard(Arc<Progress>);
impl RunGuard {
    fn new(progress: &Arc<Progress>) -> Self {
        progress.running.fetch_add(1, Ordering::AcqRel);
        RunGuard(progress.clone())
    }
    /// A result was stored, so the backlog really moved.
    fn stored(&self) {
        self.0.last_work_ms.store(now_ms(), Ordering::Release);
    }
}
impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.running.fetch_sub(1, Ordering::AcqRel);
    }
}

pub struct Control {
    stop: Arc<AtomicBool>,
    progress: Arc<Progress>,
}
impl Control {
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
    /// For the status command: memory only. Asking also keeps the service
    /// counting the backlog for the next few seconds.
    pub fn status(&self, paused: bool) -> AnalysisProgress {
        let p = &self.progress;
        let now = now_ms();
        p.wanted_ms.store(now, Ordering::Release);
        let running = p.running.load(Ordering::Acquire) as u32;
        let last = p.last_work_ms.load(Ordering::Acquire);
        let pending = p.pending.load(Ordering::Acquire);
        AnalysisProgress {
            installed: p.installed.load(Ordering::Acquire),
            pending: u32::try_from(pending).ok(),
            running,
            active: running > 0 || (last != 0 && now.saturating_sub(last) < ACTIVE_FOR_MS),
            paused,
        }
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
    after: AtomicI64,
    stop: Arc<AtomicBool>,
    progress: Arc<Progress>,
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
    let progress = Arc::new(Progress::new());
    if let Some(cache) = cache {
        let service = Arc::new(Service {
            cache,
            models,
            queue,
            engine,
            output,
            runtime,
            after: AtomicI64::new(0),
            stop: stop.clone(),
            progress: progress.clone(),
        });
        // Dispatch and counting never wait on the availability probe. The
        // probe runs only while Find requests counts, independently of pause.
        std::thread::spawn(move || {
            let mut last_scan: Option<Instant> = None;
            let mut last_count: Option<Instant> = None;
            let mut availability = AvailabilityProbe::default();
            while !service.stop.load(Ordering::Acquire) {
                // No directory creation, download or engine request without installed assets.
                let installed = service.models.installed();
                let p = &service.progress;
                p.installed.store(installed, Ordering::Release);
                if installed {
                    let availability_changed = availability.collect(p);
                    if last_scan.is_none_or(|t| t.elapsed() >= SCAN_EVERY) {
                        last_scan = Some(Instant::now());
                        let next = service.clone();
                        service.queue.submit("clip:scan".into(), move |job| {
                            if !job.cancelled() && !next.stop.load(Ordering::Acquire) {
                                if let Err(e) = next.scan(&job) {
                                    eprintln!("local analysis: {e}");
                                }
                            }
                        });
                    }
                    if p.count_requested() {
                        let count_due = last_count.is_none_or(|t| t.elapsed() >= COUNT_EVERY);
                        if count_due || availability_changed {
                            let selection = library_selection(&service.runtime);
                            if count_due {
                                last_count = Some(Instant::now());
                                availability.start(&service, &selection);
                            }
                            if let Some(n) = count_backlog(
                                &service.cache,
                                &selection,
                                &service.stop,
                                &p.unavailable,
                                COUNT_PAGE,
                            ) {
                                p.pending.store(n as i64, Ordering::Release);
                            }
                        }
                    }
                } else {
                    p.pending.store(-1, Ordering::Release);
                    last_scan = None;
                    last_count = None;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        });
    }
    Control { stop, progress }
}
// photos on a network share are analysed only once the user has opened,
// rendered or browsed no photo for this long (Tagged::mark_active).
// importing one there can take a minute (a large DNG over a slow share), and
// the engine's import, which every photo open also takes, is held while the
// file is read; an open cannot cut that read short, so it is not started
// while the user is working. one already under way still delays an open
const SHARE_QUIET: Duration = Duration::from_secs(120);

impl Service {
    // whether work on this photo waits for a quiet spell (SHARE_QUIET). the
    // row stays pending and a later scan offers it again
    fn deferred(&self, path: &str) -> bool {
        self.engine.quiet_for() < SHARE_QUIET && crate::volumes::on_network(Path::new(path))
    }

    fn scan(self: &Arc<Self>, job: &Job) -> Result<(), String> {
        // Verify the installed package before any lazy photo import/render.
        self.models.prepare_text("")?;
        if job.cancelled() {
            return Ok(());
        }
        let mut after = self.after.load(Ordering::Acquire);
        let selection = library_selection(&self.runtime);
        let quiet = self.engine.quiet_for();
        // Without recent Find polling, retry previously marked paths through
        // the normal analysis budget so a restored photo can still be analysed.
        let availability_is_checked = self.progress.count_requested();
        let mut shares = HashMap::<PathBuf, bool>::new();
        // Pass over pages of deferred or unavailable photos so local work
        // can still be offered when it follows them in the index.
        for _ in 0..64 {
            if job.cancelled() || self.stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let rows = self.cache.pending_analyses(after, 32)?;
            after = rows.last().map_or(0, |r| r.variant_id);
            if job
                .commit(|| self.after.store(after, Ordering::Release))
                .is_none()
                || rows.is_empty()
            {
                break;
            }
            let mut offered = false;
            for row in rows {
                if job.cancelled() || self.stop.load(Ordering::Acquire) {
                    return Ok(());
                }
                let path = Path::new(&row.path);
                if !selected(path, &selection)
                    || (availability_is_checked
                        && self.progress.is_unavailable(row.variant_id, &row.path))
                {
                    continue;
                }
                let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
                if quiet < SHARE_QUIET
                    && *shares
                        .entry(dir)
                        .or_insert_with(|| crate::volumes::on_network(path))
                {
                    continue;
                }
                offered = true;
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
                // only edited analyses are queued: Find no longer reads original ones
                if row.needs_edited {
                    let service = self.clone();
                    let row = row.clone();
                    self.queue
                        .submit(format!("clip:edited:{}", row.variant_id), move |job| {
                            if let Err(e) = service.analyze(&row, "edited", &job) {
                                eprintln!("local analysis: {e}");
                            }
                        });
                }
            }
            if offered {
                break;
            }
        }
        Ok(())
    }
    fn refresh_metadata(&self, row: &PendingAnalysis, job: &Job) -> Result<(), String> {
        if job.cancelled() || self.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if !selected(Path::new(&row.path), &library_selection(&self.runtime))
            || self.deferred(&row.path)
        {
            return Ok(());
        }
        let version = version(&row.copy_key)?;
        let before = photo_fingerprints(row, version);
        let Some((original, edited)) = before.as_ref() else {
            return Ok(());
        };
        if original != &row.original {
            return Ok(());
        }
        let running = RunGuard::new(&self.progress);
        let imgid = self.engine.cached_photo(&row.path, version);
        let reply = self
            .engine
            .request(self.engine.tag(), json!({"cmd":"meta","imgid":imgid}))?;
        if job.cancelled() || before != photo_fingerprints(row, version) {
            return Ok(());
        }
        if let Some(mut image) = reply.get("image").cloned() {
            let (ns, raw, offset) = crate::library_cmds::precise_capture(&image);
            if let Some(fields) = image.as_object_mut() {
                fields.remove("imgid");
            }
            let metadata = serde_json::to_string(&image).map_err(|e| e.to_string())?;
            let stored = job
                .commit(|| {
                    self.cache.finish_analysis_metadata(
                        row,
                        edited,
                        &metadata,
                        (ns, raw.as_deref(), offset),
                    )
                })
                .transpose()?;
            if stored == Some(true) {
                running.stored();
            }
        }
        Ok(())
    }

    fn analyze(&self, row: &PendingAnalysis, subject: &str, job: &Job) -> Result<(), String> {
        if job.cancelled() || self.stop.load(Ordering::Acquire) {
            return Ok(());
        }
        if !selected(Path::new(&row.path), &library_selection(&self.runtime))
            || self.deferred(&row.path)
        {
            return Ok(());
        }
        let version = version(&row.copy_key)?;
        if !current(row, subject, version) {
            return Ok(());
        }
        let running = RunGuard::new(&self.progress);
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
        let preview = match preview {
            Ok(p) => p,
            // The engine read the file but could not decode it (an unsupported
            // DNG, say; library_analysis_preview) and the file is as listed:
            // remember it, so the photo is not imported and tried again at
            // every launch. Any other error (a failed read, memory, a failed
            // write, engine exit or restart, timeout, a share that did not
            // answer, a cancelled job) is retried later.
            Err(e) => {
                if e.starts_with("cannot decode image ")
                    && !job.cancelled()
                    && !self.stop.load(Ordering::Acquire)
                    && current(row, subject, version)
                {
                    let _ = self.cache.put_analysis_failure(
                        row,
                        subject,
                        crate::local_search::ANALYSIS_VERSION,
                        crate::local_search::MODEL_VERSION,
                    );
                }
                return Err(e);
            }
        };
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
        let stored = job
            .commit(|| {
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
        if stored == Some(true) {
            running.stored();
        }
        Ok(())
    }
}
type AvailabilityObservations = Vec<(i64, String, bool)>;

#[derive(Default)]
struct AvailabilityProbe {
    after: i64,
    running: Option<JoinHandle<AvailabilityObservations>>,
}

impl AvailabilityProbe {
    fn collect(&mut self, progress: &Progress) -> bool {
        if self
            .running
            .as_ref()
            .is_some_and(|batch| batch.is_finished())
        {
            if let Ok(observations) = self.running.take().unwrap().join() {
                return progress.update_availability(observations);
            }
        }
        false
    }

    fn start(&mut self, service: &Service, selection: &serde_json::Value) {
        // A filesystem call can stall even after the drive answered. Keep at
        // most one such batch outstanding, without using a queue worker.
        if self.running.is_some() {
            return;
        }
        let Ok(mut rows) = service
            .cache
            .pending_analysis_paths(self.after, AVAILABILITY_PAGE)
        else {
            return;
        };
        self.after = if rows.len() == AVAILABILITY_PAGE as usize {
            rows.last().map_or(0, |row| row.0)
        } else {
            0
        };
        rows.retain(|(_, path)| selected(Path::new(path), selection));
        if !rows.is_empty() {
            let stop = service.stop.clone();
            self.running = Some(std::thread::spawn(move || probe_availability(rows, &stop)));
        }
    }
}

fn probe_availability(rows: Vec<(i64, String)>, stop: &AtomicBool) -> AvailabilityObservations {
    let mut answers = HashMap::new();
    let mut observations = Vec::new();
    for (id, path) in rows {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let photo = Path::new(&path);
        let mount = crate::volumes::mount_identity(photo);
        let answering = *answers
            .entry(mount)
            .or_insert_with(|| crate::volumes::answering(photo));
        if stop.load(Ordering::Acquire) {
            break;
        }
        let gone = !answering || std::fs::metadata(photo).is_err();
        observations.push((id, path, gone));
    }
    observations
}

/// Photos waiting for metadata or an edited analysis in the selected folders,
/// leaving out those the probe found missing or offline. Pages by id with the
/// cache lock held for one page at a time; None when stopped or on an error,
/// so a partial count is never stored.
fn count_backlog(
    cache: &SearchCache,
    selection: &serde_json::Value,
    stop: &AtomicBool,
    unavailable: &Mutex<HashMap<i64, String>>,
    page: u32,
) -> Option<u32> {
    let (mut after, mut total) = (0i64, 0u32);
    let mut still_unavailable = HashSet::new();
    loop {
        if stop.load(Ordering::Acquire) {
            return None;
        }
        let mut rows = cache.pending_analysis_paths(after, page).ok()?;
        let end = (rows.len() as u32) < page;
        after = rows.last().map_or(0, |row| row.0);
        rows.retain(|(_, path)| selected(Path::new(path), selection));
        {
            let gone = unavailable.lock().unwrap_or_else(|e| e.into_inner());
            for (id, path) in rows {
                if gone.get(&id) == Some(&path) {
                    still_unavailable.insert(id);
                } else {
                    total = total.saturating_add(1);
                }
            }
        }
        if end {
            unavailable
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .retain(|id, _| still_unavailable.contains(id));
            return Some(total);
        }
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
fn photo_fingerprints(row: &PendingAnalysis, version: i64) -> Option<(String, String)> {
    let path = Path::new(&row.path);
    if !crate::volumes::answering(path) {
        return None;
    }
    crate::cache::listed_metadata_fingerprints(
        &Mutex::new(crate::cache::Listed::default()),
        path,
        version,
    )
}

fn current(row: &PendingAnalysis, subject: &str, version: i64) -> bool {
    photo_fingerprints(row, version).is_some_and(|(original, edited)| {
        original == row.original && (subject == "original" || edited == row.edited)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control() -> Control {
        Control {
            stop: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Progress::new()),
        }
    }

    #[test]
    fn backlog_counts_selected_photos_across_pages() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        for i in 0..5 {
            cache
                .upsert_variant(&format!("/photos/{i}.jpg"), "", "s", "e", None, None, None)
                .unwrap();
        }
        cache
            .upsert_variant("/photos/hidden/h.jpg", "", "s", "e", None, None, None)
            .unwrap();
        cache
            .upsert_variant("/elsewhere/x.jpg", "", "s", "e", None, None, None)
            .unwrap();
        let config = json!({"folders":["/photos"],"hidden":["/photos/hidden"]});
        let stop = AtomicBool::new(false);
        // page sizes smaller than, equal to and larger than the backlog agree
        for page in [1, 2, 7, 8, 1024] {
            assert_eq!(count_backlog(&cache, &config, &stop, &Mutex::default(), page), Some(5), "page {page}");
        }
        assert_eq!(count_backlog(&cache, &json!({"folders":[]}), &stop, &Mutex::default(), 2), Some(0));
        stop.store(true, Ordering::Release);
        assert_eq!(count_backlog(&cache, &config, &stop, &Mutex::default(), 2), None);
    }

    #[test]
    fn backlog_leaves_out_analysed_photos() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let v = cache
            .upsert_variant("/photos/a.jpg", "", "s", "e", None, None, None)
            .unwrap();
        cache.store_metadata(v.id, "{}").unwrap();
        let config = json!({"folders":["/photos"]});
        let stop = AtomicBool::new(false);
        assert_eq!(count_backlog(&cache, &config, &stop, &Mutex::default(), 8), Some(1));
        let row = cache.pending_analyses(0, 8).unwrap().remove(0);
        cache
            .put_analysis(
                row.variant_id,
                "edited",
                &row.edited,
                crate::local_search::ANALYSIS_VERSION,
                crate::local_search::MODEL_VERSION,
                &[0u8; 4],
            )
            .unwrap();
        assert_eq!(count_backlog(&cache, &config, &stop, &Mutex::default(), 8), Some(0));
    }

    #[test]
    fn status_is_active_while_running_and_shortly_after() {
        let c = control();
        let s = c.status(false);
        assert!(!s.installed && s.pending.is_none() && !s.active && !s.paused);
        c.progress.pending.store(3, Ordering::Release);
        c.progress.installed.store(true, Ordering::Release);
        assert_eq!(c.status(true).pending, Some(3));
        assert!(c.status(true).paused);
        let guard = RunGuard::new(&c.progress);
        let s = c.status(false);
        assert!(s.active && s.running == 1);
        guard.stored();
        drop(guard);
        let s = c.status(false);
        assert!(s.active && s.running == 0, "a finished job counts for a while");
        c.progress
            .last_work_ms
            .store(now_ms().saturating_sub(ACTIVE_FOR_MS + 1), Ordering::Release);
        assert!(!c.status(false).active);
    }

    #[test]
    fn backlog_leaves_out_unavailable_photos_until_they_return() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let a_path = dir.path().join("a.jpg");
        let b_path = dir.path().join("b.jpg");
        let a_path = a_path.to_str().unwrap();
        let b_path = b_path.to_str().unwrap();
        cache
            .upsert_variant(a_path, "", "s", "e", None, None, None)
            .unwrap();
        cache
            .upsert_variant(b_path, "", "s", "e", None, None, None)
            .unwrap();
        std::fs::write(b_path, b"photo").unwrap();
        let config = json!({"folders":[dir.path()]});
        let stop = AtomicBool::new(false);
        let progress = Progress::new();

        // The status probe needs no analysis queue or idle engine, so the
        // same missing and restored files are detected while analysis is paused.
        progress.update_availability(probe_availability(
            cache.pending_analysis_paths(0, 8).unwrap(),
            &stop,
        ));
        assert_eq!(
            count_backlog(&cache, &config, &stop, &progress.unavailable, 8),
            Some(1)
        );
        std::fs::write(a_path, b"restored photo").unwrap();
        progress.update_availability(probe_availability(
            cache.pending_analysis_paths(0, 8).unwrap(),
            &stop,
        ));
        assert_eq!(
            count_backlog(&cache, &config, &stop, &progress.unavailable, 8),
            Some(2)
        );
    }

    #[test]
    fn a_job_that_stores_nothing_does_not_keep_the_indicator_working() {
        let c = control();
        c.progress.pending.store(1, Ordering::Release);
        drop(RunGuard::new(&c.progress));
        let s = c.status(false);
        assert_eq!(s.pending, Some(1));
        assert!(!s.active && s.running == 0, "a retry that stored nothing is waiting");
    }

    #[test]
    fn guard_decrements_on_early_return_and_panic() {
        let progress = Arc::new(Progress::new());
        let early = |p: &Arc<Progress>| -> Result<(), String> {
            let _running = RunGuard::new(p);
            assert_eq!(p.running.load(Ordering::Acquire), 1);
            Err("early".into())
        };
        assert!(early(&progress).is_err());
        assert_eq!(progress.running.load(Ordering::Acquire), 0);
        assert_eq!(progress.last_work_ms.load(Ordering::Acquire), 0);
        let p = progress.clone();
        let result = std::panic::catch_unwind(move || {
            let _running = RunGuard::new(&p);
            panic!("job failed");
        });
        assert!(result.is_err());
        assert_eq!(progress.running.load(Ordering::Acquire), 0);
    }

    #[test]
    fn asking_for_status_marks_the_page_as_waiting() {
        let c = control();
        assert_eq!(c.progress.wanted_ms.load(Ordering::Acquire), 0);
        c.status(false);
        assert_ne!(c.progress.wanted_ms.load(Ordering::Acquire), 0);
    }
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
    fn failed_render_is_not_pending_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let v = cache
            .upsert_variant("/photos/a.dng", "", "source", "edit", None, None, None)
            .unwrap();
        cache.store_metadata(v.id, "{}").unwrap();
        let (av, mv) = (
            crate::local_search::ANALYSIS_VERSION,
            crate::local_search::MODEL_VERSION,
        );
        let row = cache.pending_analyses(0, 32).unwrap().remove(0);
        assert!(cache.put_analysis_failure(&row, "original", av, mv).unwrap());
        assert!(cache.put_analysis_failure(&row, "edited", av, mv).unwrap());
        assert!(cache.pending_analyses(0, 32).unwrap().is_empty());
        // a stale fingerprint is not recorded
        let mut stale = row.clone();
        stale.original = "other".into();
        assert!(!cache.put_analysis_failure(&stale, "original", av, mv).unwrap());
        // the file changed: tried again
        cache
            .upsert_variant("/photos/a.dng", "", "source2", "edit2", None, None, None)
            .unwrap();
        let rows = cache.pending_analyses(0, 32).unwrap();
        assert!(rows[0].needs_edited);
    }

    #[test]
    fn failed_render_is_retried_by_another_app_version_or_after_a_while() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let v = cache
            .upsert_variant("/photos/a.dng", "", "source", "edit", None, None, None)
            .unwrap();
        cache.store_metadata(v.id, "{}").unwrap();
        let (av, mv) = (
            crate::local_search::ANALYSIS_VERSION,
            crate::local_search::MODEL_VERSION,
        );
        let row = cache.pending_analyses(0, 32).unwrap().remove(0);
        assert!(cache.put_analysis_failure(&row, "original", av, mv).unwrap());
        assert!(cache.put_analysis_failure(&row, "edited", av, mv).unwrap());
        assert!(cache.pending_analyses(0, 32).unwrap().is_empty());
        cache.set_render_failures(0, "0.0.1");
        assert!(cache.pending_analyses(0, 32).unwrap()[0].needs_edited);
        cache.set_render_failures(31 * 24 * 3600, env!("CARGO_PKG_VERSION"));
        assert!(cache.pending_analyses(0, 32).unwrap()[0].needs_edited);
        cache.set_render_failures(29 * 24 * 3600, env!("CARGO_PKG_VERSION"));
        assert!(cache.pending_analyses(0, 32).unwrap().is_empty());
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
        assert!(rows.iter().all(|r| r.needs_edited));
        cache
            .put_analysis(
                a.id,
                "edited",
                "edit",
                crate::local_search::ANALYSIS_VERSION,
                "old-model",
                &[0; 2048],
            )
            .unwrap();
        assert!(cache.pending_analyses(0, 32).unwrap()[0].needs_edited);
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
            after: AtomicI64::new(0),
            stop: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(Progress::new()),
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
        assert_eq!(page.items[0].variant_id, Some(variant.id.to_string()));
        assert_eq!(page.items[0].image.version, 2);
    }
}
