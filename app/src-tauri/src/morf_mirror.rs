// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! A durable local copy of the morfPhoto catalog: the fields Find's filters
//! use, for every photo and version under the mapped server folder.
//!
//! Threads and locks. One sync thread owns the only writer connection to
//! `<runtime>/morfphoto-mirror.sqlite`; an exclusive lock file (`File::try_lock`,
//! flock on Unix, LockFileEx on Windows) makes one Immage instance the writer,
//! others only read. Nothing else writes the mirror, so syncs are single-flight.
//!
//! The one lock is `Mirror.state`, a strict leaf: it guards in-memory status
//! values only, is never held across HTTP, SQLite, disk or keychain work, and
//! is never taken while holding any other lock. Callers that may hold other
//! locks (the engine's, the analysis queue's) use `kick`, which sets an atomic
//! and notifies without waiting for `state`. A notify that races the sync
//! thread's check is lost, so the thread waits in slices of `WAIT_SLICE` and a
//! lost kick costs at most that long. Reset, stop and generation are atomics
//! too.
//!
//! The sync thread yields to the user: before each page it waits while
//! `Tagged::quiet_for()` is under `QUIET` (the user opened, rendered or browsed
//! a photo a moment ago), at most `QUIET_CAP` per page. Every command here
//! only reads or sets in-memory state.

use crate::morf_photo::{
    encode_plus_query, header_str, read_response_body, Api, Config, PageOutcome, Version,
    MAX_PAGE_BYTES, PAGE_SIZE, REQUEST_TIMEOUT,
};
use reqwest::header::{ACCEPT_ENCODING, AUTHORIZATION, ETAG, IF_NONE_MATCH};
use reqwest::StatusCode;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::File,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, PoisonError,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(crate) const FILE: &str = "morfphoto-mirror.sqlite";
const LOCK: &str = "morfphoto-mirror.lock";
const USER_VERSION: i64 = 1;
const TICK: Duration = Duration::from_secs(60);
const WAIT_SLICE: Duration = Duration::from_secs(5);
const QUIET: Duration = Duration::from_millis(300);
const QUIET_CAP: Duration = Duration::from_secs(10);
const SNAPSHOT_MIN_INTERVAL: Duration = Duration::from_secs(600);
const NO_FEED_RETRY: Duration = Duration::from_secs(3600);
const BACKOFF_FIRST: Duration = Duration::from_secs(30);
const BACKOFF_MAX: Duration = Duration::from_secs(900);
const BACKOFF_DISK_FULL: Duration = Duration::from_secs(300);
const PAGE_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_STATUS_BYTES: u64 = 65536;
const CHANGES_LIMIT: usize = 500;

const SCHEMA: &str = "
CREATE TABLE mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE photos (
    id INTEGER PRIMARY KEY,
    server_path TEXT NOT NULL UNIQUE,
    dir TEXT NOT NULL,
    filename TEXT NOT NULL,
    extension TEXT, kind TEXT,
    size INTEGER, mtime INTEGER, sidecar_fp TEXT,
    make TEXT, model TEXT, lens TEXT, body_key TEXT, body_serial TEXT,
    camera_label TEXT, iso_label TEXT, aperture_label TEXT, focal_label TEXT, shutter_label TEXT,
    exif_taken_at TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    gen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX photos_dir ON photos(dir);
CREATE INDEX photos_camera ON photos(camera_label);
CREATE INDEX photos_lens ON photos(lens);
CREATE INDEX photos_iso ON photos(iso_label);
CREATE INDEX photos_aperture ON photos(aperture_label);
CREATE INDEX photos_focal ON photos(focal_label);
CREATE INDEX photos_shutter ON photos(shutter_label);
CREATE TABLE versions (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    copy INTEGER NOT NULL, rating INTEGER NOT NULL, rejected INTEGER NOT NULL,
    labels INTEGER NOT NULL, edited INTEGER NOT NULL, taken_at TEXT,
    PRIMARY KEY (photo_id, version)
) WITHOUT ROWID;
CREATE INDEX versions_rating ON versions(rating, rejected);
CREATE INDEX versions_taken ON versions(taken_at);
CREATE TABLE keywords (
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    PRIMARY KEY (photo_id, version, keyword)
) WITHOUT ROWID;
CREATE INDEX keywords_keyword ON keywords(keyword);
";

#[derive(Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    // Immage Accelerator is off or not configured
    Off,
    // the mirror could not be opened; Immage runs without it
    Unavailable,
    Idle,
    Syncing,
    Error,
}

// in-memory values only: the leaf lock's data
struct SyncState {
    phase: Phase,
    done: u64,
    total: u64,
    synced_at: Option<i64>,
    photos: u64,
    complete: bool,
    error: Option<String>,
    disk_full: bool,
}

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MirrorStatus {
    phase: Phase,
    // sync progress in the server's change numbers; total is 0 when unknown
    done: u64,
    total: u64,
    // seconds since the epoch of the last complete sync
    synced_at: Option<i64>,
    // photos in the local copy
    photos: u64,
    complete: bool,
    error: Option<String>,
    disk_full: bool,
}

pub(crate) struct Mirror {
    state: Mutex<SyncState>,
    wake: Condvar,
    kicked: AtomicBool,
    reset: AtomicBool,
    stopping: AtomicBool,
    // bumped by a reset; a page fetched under an older value is dropped
    generation: AtomicU64,
    quiet: Box<dyn Fn() -> Duration + Send + Sync>,
}

// everything the sync thread keeps between cycles
struct Worker {
    conn: Connection,
    status_etag: Option<String>,
    last_status: Option<ServerStatus>,
    retry_at: Option<Instant>,
    failures: u32,
    last_snapshot: Option<Instant>,
    no_feed_until: Option<Instant>,
}

#[derive(Clone)]
struct ServerStatus {
    catalog_id: Option<String>,
    high_water: Option<i64>,
    revision: Option<String>,
}

#[derive(Debug)]
enum Fail {
    // a reset, stop or identity change landed; run again from the top
    Aborted,
    // the server's catalog_id changed mid-run; the next cycle clears
    CatalogChanged,
    // /library/changes answered 404: an older server
    NoFeed,
    Error { message: String, disk_full: bool },
}

impl Fail {
    fn message(message: impl Into<String>) -> Self {
        Fail::Error {
            message: message.into(),
            disk_full: false,
        }
    }
}

impl From<rusqlite::Error> for Fail {
    fn from(error: rusqlite::Error) -> Self {
        let disk_full = matches!(&error, rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == rusqlite::ErrorCode::DiskFull);
        Fail::Error {
            message: format!("local catalog database: {error}"),
            disk_full,
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64)
}

impl Mirror {
    // starts the sync thread; nothing here touches a file on the caller's thread
    pub(crate) fn start(
        runtime: &Path,
        quiet: impl Fn() -> Duration + Send + Sync + 'static,
    ) -> Arc<Mirror> {
        let mirror = Arc::new(Mirror::new(quiet));
        let thread = mirror.clone();
        let runtime = runtime.to_path_buf();
        if std::thread::Builder::new()
            .name("morfphoto-mirror".into())
            .spawn(move || thread.run(&runtime))
            .is_err()
        {
            mirror.with_state(|s| s.phase = Phase::Unavailable);
        }
        mirror
    }

    fn new(quiet: impl Fn() -> Duration + Send + Sync + 'static) -> Mirror {
        Mirror {
            state: Mutex::new(SyncState {
                phase: Phase::Off,
                done: 0,
                total: 0,
                synced_at: None,
                photos: 0,
                complete: false,
                error: None,
                disk_full: false,
            }),
            wake: Condvar::new(),
            kicked: AtomicBool::new(true),
            reset: AtomicBool::new(false),
            stopping: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            quiet: Box::new(quiet),
        }
    }

    fn with_state<R>(&self, f: impl FnOnce(&mut SyncState) -> R) -> R {
        f(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner))
    }

    // Safe while holding any other lock: sets an atomic and notifies without
    // taking `state`. A notify that lands between the sync thread's check and
    // its wait is lost; the thread's wait slice bounds that to WAIT_SLICE.
    pub(crate) fn kick(&self) {
        self.kicked.store(true, Ordering::Release);
        self.wake.notify_one();
    }

    // Forget, a changed server or server folder, or the Resync button: the sync
    // thread empties the tables (never the file) and syncs again. The flag is
    // set before the generation moves, so a run that sees the new generation
    // finds the flag set.
    pub(crate) fn request_reset(&self) {
        self.reset.store(true, Ordering::Release);
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.kick();
    }

    pub(crate) fn stop(&self) {
        self.stopping.store(true, Ordering::Release);
        self.wake.notify_all();
    }

    // memory only
    pub(crate) fn status(&self) -> MirrorStatus {
        self.with_state(|s| MirrorStatus {
            phase: s.phase,
            done: s.done,
            total: s.total,
            synced_at: s.synced_at,
            photos: s.photos,
            complete: s.complete,
            error: s.error.clone(),
            disk_full: s.disk_full,
        })
    }

    fn aborted(&self, generation: u64) -> bool {
        self.stopping.load(Ordering::Acquire)
            || self.reset.load(Ordering::Acquire)
            || self.generation.load(Ordering::Acquire) != generation
    }

    // waits while the user is busy with photos; false when the run is stale
    fn wait_quiet(&self, generation: u64) -> bool {
        let started = Instant::now();
        while (self.quiet)() < QUIET && started.elapsed() < QUIET_CAP {
            if self.aborted(generation) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        !self.aborted(generation)
    }

    fn wait_for_work(&self, deadline: Instant) {
        let mut guard = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        loop {
            if self.kicked.load(Ordering::Acquire)
                || self.reset.load(Ordering::Acquire)
                || self.stopping.load(Ordering::Acquire)
            {
                return;
            }
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            guard = self
                .wake
                .wait_timeout(guard, (deadline - now).min(WAIT_SLICE))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    fn run(self: Arc<Self>, runtime: &Path) {
        let _ = std::fs::create_dir_all(runtime);
        // held until the thread ends; the lock goes with the file handle
        let lock = take_writer_lock(&runtime.join(LOCK));
        let path = runtime.join(FILE);
        let mut worker = if lock.is_some() {
            let conn = open_or_quarantine(&path);
            if conn.is_none() {
                self.with_state(|s| s.phase = Phase::Unavailable);
            }
            conn.map(|conn| Worker {
                conn,
                status_etag: None,
                last_status: None,
                retry_at: None,
                failures: 0,
                last_snapshot: None,
                no_feed_until: None,
            })
        } else {
            None
        };
        if let Some(w) = &worker {
            self.load_summary(&w.conn);
        }
        loop {
            if self.stopping.load(Ordering::Acquire) {
                return;
            }
            self.kicked.store(false, Ordering::Release);
            match worker.as_mut() {
                Some(w) => self.cycle(runtime, w),
                None if lock.is_none() => self.read_only_summary(&path),
                None => {}
            }
            self.wait_for_work(Instant::now() + TICK);
        }
    }

    fn load_summary(&self, conn: &Connection) {
        let photos = count_photos(conn).unwrap_or(0);
        let complete = meta_get(conn, "complete").ok().flatten().as_deref() == Some("1");
        let synced = meta_get(conn, "synced_at")
            .ok()
            .flatten()
            .and_then(|v| v.parse().ok());
        self.with_state(|s| {
            s.photos = photos;
            s.complete = complete;
            s.synced_at = synced;
        });
    }

    // another Immage instance writes; show what it has committed
    fn read_only_summary(&self, path: &Path) {
        if let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            let _ = conn.busy_timeout(Duration::from_secs(2));
            self.load_summary(&conn);
            self.with_state(|s| {
                if s.phase != Phase::Syncing {
                    s.phase = Phase::Idle;
                }
            });
        }
    }

    fn cycle(&self, runtime: &Path, w: &mut Worker) {
        let reset = self.reset.swap(false, Ordering::AcqRel);
        let generation = self.generation.load(Ordering::Acquire);
        let config = crate::morf_photo::load(runtime);
        if reset {
            w.retry_at = None;
            w.failures = 0;
            w.status_etag = None;
            w.last_status = None;
            w.last_snapshot = None;
            w.no_feed_until = None;
            if let Err(fail) = clear_all(&mut w.conn) {
                self.record_failure(w, fail);
                return;
            }
            self.load_summary(&w.conn);
            self.with_state(|s| {
                s.done = 0;
                s.total = 0;
                s.error = None;
                s.disk_full = false;
            });
        }
        let enabled = config.enabled && config.validate_mapping().is_ok() && config.origin().is_ok();
        if !enabled {
            self.with_state(|s| s.phase = Phase::Off);
            return;
        }
        if !reset && w.retry_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        let mut api = match config.client(None) {
            Ok(api) => api,
            Err(message) => {
                self.record_failure(w, Fail::message(message));
                return;
            }
        };
        match self.sync(w, &config, &mut api, generation) {
            Ok(()) => {
                w.failures = 0;
                w.retry_at = None;
                self.with_state(|s| {
                    s.phase = Phase::Idle;
                    s.error = None;
                    s.disk_full = false;
                });
            }
            Err(Fail::Aborted) => {
                self.with_state(|s| s.phase = Phase::Idle);
                self.kick();
            }
            Err(Fail::CatalogChanged) => {
                w.status_etag = None;
                w.last_status = None;
                self.kick();
            }
            Err(fail) => self.record_failure(w, fail),
        }
    }

    fn record_failure(&self, w: &mut Worker, fail: Fail) {
        let (message, disk_full) = match fail {
            Fail::Error { message, disk_full } => (message, disk_full),
            Fail::NoFeed => ("morfPhoto has no change feed".into(), false),
            Fail::Aborted | Fail::CatalogChanged => return,
        };
        w.failures = w.failures.saturating_add(1);
        let mut wait = BACKOFF_FIRST
            .saturating_mul(1u32 << w.failures.saturating_sub(1).min(10))
            .min(BACKOFF_MAX);
        if disk_full {
            wait = wait.max(BACKOFF_DISK_FULL);
        }
        w.retry_at = Some(Instant::now() + wait);
        eprintln!("morfPhoto local catalog: {message}");
        self.with_state(|s| {
            s.phase = Phase::Error;
            s.error = Some(message);
            s.disk_full = disk_full;
        });
    }

    // one pass: probe the server, then delta or snapshot
    fn sync(
        &self,
        w: &mut Worker,
        config: &Config,
        api: &mut Api,
        generation: u64,
    ) -> Result<(), Fail> {
        let origin = config.origin().map_err(Fail::message)?;
        ensure_identity(&mut w.conn, &origin, &config.server_root())?;
        self.load_summary(&w.conn);
        let status = self.probe(w, api)?;
        let delta = status.catalog_id.is_some()
            && status.high_water.is_some()
            && w.no_feed_until.is_none_or(|at| Instant::now() >= at);
        if delta {
            match self.sync_delta(w, api, config, &status, generation) {
                Err(Fail::NoFeed) => {
                    w.no_feed_until = Some(Instant::now() + NO_FEED_RETRY);
                }
                other => return other,
            }
        }
        self.sync_snapshot(w, api, config, &status, generation)
    }

    fn probe(&self, w: &mut Worker, api: &mut Api) -> Result<ServerStatus, Fail> {
        let etag = w
            .status_etag
            .clone()
            .filter(|_| w.last_status.is_some());
        match fetch(api, Route::Status, &[], etag.as_deref(), REQUEST_TIMEOUT, MAX_STATUS_BYTES)? {
            Fetched::NotModified => w
                .last_status
                .clone()
                .ok_or_else(|| Fail::message("Unexpected HTTP 304 from morfPhoto")),
            Fetched::NotFound => Err(Fail::message("morfPhoto index status unavailable")),
            Fetched::Body { bytes, etag } => {
                let value: Value = serde_json::from_slice(&bytes)
                    .map_err(|_| Fail::message("Invalid morfPhoto index status"))?;
                let text = |key: &str| {
                    value
                        .get(key)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                };
                let status = ServerStatus {
                    catalog_id: text("catalog_id"),
                    high_water: value.get("high_water").and_then(Value::as_i64),
                    revision: text("catalog_revision"),
                };
                w.status_etag = etag;
                w.last_status = Some(status.clone());
                Ok(status)
            }
        }
    }

    fn set_syncing(&self, done: u64, total: u64) {
        self.with_state(|s| {
            s.phase = Phase::Syncing;
            s.done = done;
            s.total = total;
        });
    }

    fn sync_delta(
        &self,
        w: &mut Worker,
        api: &mut Api,
        config: &Config,
        status: &ServerStatus,
        generation: u64,
    ) -> Result<(), Fail> {
        let (Some(catalog_id), Some(high_water)) = (status.catalog_id.as_deref(), status.high_water)
        else {
            return Err(Fail::NoFeed);
        };
        if meta_get(&w.conn, "catalog_id")?.as_deref() != Some(catalog_id) {
            let tx = w.conn.transaction()?;
            clear_tables(&tx)?;
            meta_set(&tx, "catalog_id", catalog_id)?;
            write_identity(&tx, config)?;
            tx.commit()?;
            self.load_summary(&w.conn);
        }
        let complete = meta_get(&w.conn, "complete")?.as_deref() == Some("1");
        if complete && meta_get(&w.conn, "high_water")?.and_then(|v| v.parse().ok()) == Some(high_water)
        {
            meta_set(&w.conn, "synced_at", &now_secs().to_string())?;
            self.load_summary(&w.conn);
            return Ok(());
        }
        let mut cursor = read_cursor(&w.conn)?;
        let root = config.server_root();
        self.set_syncing(cursor.0.max(0) as u64, high_water.max(0) as u64);
        loop {
            if !self.wait_quiet(generation) {
                return Err(Fail::Aborted);
            }
            let query = [
                ("after_seq", cursor.0.to_string()),
                ("after_id", cursor.1.to_string()),
                ("limit", CHANGES_LIMIT.to_string()),
            ];
            let bytes = match fetch(api, Route::Changes, &query, None, PAGE_TIMEOUT, MAX_PAGE_BYTES)? {
                Fetched::NotFound => return Err(Fail::NoFeed),
                Fetched::NotModified => {
                    let tx = w.conn.transaction()?;
                    finish(&tx, high_water)?;
                    tx.commit()?;
                    self.load_summary(&w.conn);
                    return Ok(());
                }
                Fetched::Body { bytes, .. } => bytes,
            };
            let reply: Changes = serde_json::from_slice(&bytes)
                .map_err(|_| Fail::message("Invalid morfPhoto change feed"))?;
            if reply.catalog_id != catalog_id {
                return Err(Fail::CatalogChanged);
            }
            let next = reply.next.map(|c| (c.seq, c.id));
            if next == Some(cursor) {
                return Err(Fail::message("morfPhoto change feed did not advance"));
            }
            let new_cursor = end_cursor(next, &reply.items, reply.high_water, cursor);
            self.apply_delta(
                &mut w.conn,
                &root,
                &reply.items,
                new_cursor,
                reply.high_water,
                next.is_none(),
                generation,
            )?;
            cursor = new_cursor;
            self.set_syncing(cursor.0.max(0) as u64, reply.high_water.max(0) as u64);
            self.load_summary(&w.conn);
            if next.is_none() {
                return Ok(());
            }
        }
    }

    // One page in one write transaction: whole-file replace of versions and
    // keywords, tombstones remove rows, the cursor is committed with the page.
    // The generation is checked again just before COMMIT.
    #[allow(clippy::too_many_arguments)]
    fn apply_delta(
        &self,
        conn: &mut Connection,
        root: &str,
        items: &[ChangeItem],
        cursor: (i64, i64),
        high_water: i64,
        complete: bool,
        generation: u64,
    ) -> Result<(), Fail> {
        let tx = conn.transaction()?;
        for item in items {
            if item.state == "present" && under_root(root, &item.path) {
                upsert_file(&tx, item.id, &item.path, &item.fields, &item.versions, item.seq, 0)?;
            } else {
                tx.prepare_cached("DELETE FROM photos WHERE id = ?1")?
                    .execute(params![item.id])?;
            }
        }
        meta_set(&tx, "cursor_seq", &cursor.0.to_string())?;
        meta_set(&tx, "cursor_id", &cursor.1.to_string())?;
        // high_water is written only by `finish`: it says the rows have caught
        // up with the server. Written per page, an interrupted catch-up would
        // look current and the next cycle would skip the remaining pages.
        if complete {
            finish(&tx, high_water)?;
        }
        if self.aborted(generation) {
            return Err(Fail::Aborted);
        }
        tx.commit()?;
        Ok(())
    }

    // Servers without /library/changes: page the whole recursive listing,
    // stamp each row with the run's generation and sweep unstamped rows only
    // after an uninterrupted run. An interrupted run leaves extra rows, never
    // missing ones, and `complete` stays as it was.
    fn sync_snapshot(
        &self,
        w: &mut Worker,
        api: &mut Api,
        config: &Config,
        status: &ServerStatus,
        generation: u64,
    ) -> Result<(), Fail> {
        let stored_id = meta_get(&w.conn, "catalog_id")?;
        if stored_id.as_deref() != Some("snapshot") {
            let tx = w.conn.transaction()?;
            clear_tables(&tx)?;
            meta_set(&tx, "catalog_id", "snapshot")?;
            write_identity(&tx, config)?;
            tx.commit()?;
            self.load_summary(&w.conn);
        }
        let complete = meta_get(&w.conn, "complete")?.as_deref() == Some("1");
        let stored_revision = meta_get(&w.conn, "snapshot_revision")?;
        if complete && status.revision.is_some() && stored_revision == status.revision {
            meta_set(&w.conn, "synced_at", &now_secs().to_string())?;
            self.load_summary(&w.conn);
            return Ok(());
        }
        if w.last_snapshot.is_some_and(|at| at.elapsed() < SNAPSHOT_MIN_INTERVAL) {
            return Ok(());
        }
        w.last_snapshot = Some(Instant::now());
        let run: i64 = meta_get(&w.conn, "gen")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
            + 1;
        meta_set(&w.conn, "gen", &run.to_string())?;
        let root = config.server_root();
        let folder = (!root.is_empty()).then_some(root.as_str());
        let mut seen = 0usize;
        let mut revision: Option<String> = None;
        let mut total: Option<usize> = None;
        let mut cursor: Option<String> = None;
        self.set_syncing(0, 0);
        for page in 1..=1_000_000usize {
            if !self.wait_quiet(generation) {
                return Err(Fail::Aborted);
            }
            let (items, page_total, has_more, next_cursor, page_revision) = match &cursor {
                Some(cursor) => {
                    let (reply, rev) = api
                        .cursor_page(folder, true, cursor, PAGE_SIZE, PAGE_TIMEOUT)
                        .map_err(Fail::message)?;
                    (reply.items, None, reply.has_more, reply.next_cursor, rev)
                }
                None => match api
                    .page(folder, true, None, page, PAGE_SIZE, PAGE_TIMEOUT)
                    .map_err(Fail::message)?
                {
                    PageOutcome::Ok { page: reply, revision, .. } => {
                        (reply.items, reply.total, reply.has_more, reply.next_cursor, revision)
                    }
                    PageOutcome::NotModified => {
                        return Err(Fail::message("Unexpected HTTP 304 on catalog page"))
                    }
                },
            };
            if page == 1 {
                revision = page_revision.clone();
                total = page_total;
            } else if page_revision != revision {
                return Err(Fail::message("morfPhoto catalog changed during the sync"));
            }
            let count = items.len();
            let tx = w.conn.transaction()?;
            for item in &items {
                let Some(id) = item.exif.get("id").and_then(Value::as_i64) else {
                    return Err(Fail::message("morfPhoto listing has no file ids"));
                };
                if under_root(&root, &item.path) {
                    upsert_file(&tx, id, &item.path, &item.exif, &item.versions, 0, run)?;
                }
            }
            if self.aborted(generation) {
                return Err(Fail::Aborted);
            }
            tx.commit()?;
            seen += count;
            self.set_syncing(seen as u64, total.unwrap_or(0) as u64);
            self.load_summary(&w.conn);
            let finished = match total {
                Some(total) => seen >= total,
                None => has_more != Some(true),
            };
            if finished {
                if total.is_some_and(|total| seen != total) {
                    return Err(Fail::message("morfPhoto listing changed during pagination"));
                }
                break;
            }
            if count == 0 {
                return Err(Fail::message("morfPhoto listing ended early"));
            }
            if total.is_none() {
                cursor = Some(
                    next_cursor.ok_or_else(|| Fail::message("Invalid morfPhoto pagination"))?,
                );
            }
        }
        let tx = w.conn.transaction()?;
        tx.execute("DELETE FROM photos WHERE gen != ?1", params![run])?;
        if let Some(revision) = &revision {
            meta_set(&tx, "snapshot_revision", revision)?;
        } else {
            tx.execute("DELETE FROM mirror_meta WHERE key = 'snapshot_revision'", [])?;
        }
        finish(&tx, 0)?;
        if self.aborted(generation) {
            return Err(Fail::Aborted);
        }
        tx.commit()?;
        self.load_summary(&w.conn);
        Ok(())
    }
}

#[derive(Deserialize)]
struct Cursor {
    seq: i64,
    id: i64,
}

#[derive(Deserialize)]
struct Changes {
    catalog_id: String,
    high_water: i64,
    #[serde(default)]
    next: Option<Cursor>,
    items: Vec<ChangeItem>,
}

#[derive(Deserialize)]
struct ChangeItem {
    id: i64,
    seq: i64,
    state: String,
    path: String,
    #[serde(default)]
    versions: Vec<Version>,
    #[serde(flatten)]
    fields: Map<String, Value>,
}

enum Route {
    Status,
    Changes,
}

enum Fetched {
    NotModified,
    NotFound,
    Body { bytes: Vec<u8>, etag: Option<String> },
}

fn fetch(
    api: &mut Api,
    route: Route,
    query: &[(&str, String)],
    if_none_match: Option<&str>,
    timeout: Duration,
    limit: u64,
) -> Result<Fetched, Fail> {
    let mut url = api.endpoint.clone();
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| Fail::message("Invalid morfPhoto endpoint"))?;
        match route {
            Route::Status => {
                segments.pop().extend(["index", "status"]);
            }
            Route::Changes => {
                segments.push("changes");
            }
        }
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    encode_plus_query(&mut url);
    let response = api
        .send_authed(|api| {
            let mut request = api
                .client
                .get(url.clone())
                .header(AUTHORIZATION, api.auth.clone())
                .header(ACCEPT_ENCODING, "gzip")
                .timeout(timeout);
            if let Some(etag) = if_none_match {
                if let Ok(value) = reqwest::header::HeaderValue::from_str(etag) {
                    request = request.header(IF_NONE_MATCH, value);
                }
            }
            request
        })
        .map_err(|error| {
            Fail::message(if error.is_timeout() {
                "morfPhoto request timed out"
            } else {
                "morfPhoto request failed"
            })
        })?;
    match response.status() {
        StatusCode::NOT_MODIFIED => return Ok(Fetched::NotModified),
        StatusCode::NOT_FOUND => return Ok(Fetched::NotFound),
        status if !status.is_success() => {
            return Err(Fail::message(format!("morfPhoto returned HTTP {}", status.as_u16())))
        }
        _ => {}
    }
    let etag = header_str(response.headers(), ETAG);
    let bytes = read_response_body(response, limit).map_err(Fail::message)?;
    Ok(Fetched::Body { bytes, etag })
}

// Where the next run starts. A page with `next` continues there. The last page
// (`next` null) ends at the feed's high_water with the largest id, so a later
// row (seq above high_water) is fetched and nothing is fetched twice; the last
// item's (seq, id) counts if it is larger.
fn end_cursor(
    next: Option<(i64, i64)>,
    items: &[ChangeItem],
    high_water: i64,
    cursor: (i64, i64),
) -> (i64, i64) {
    if let Some(next) = next {
        return next;
    }
    let last = items.last().map_or(cursor, |item| (item.seq, item.id));
    (high_water, i64::MAX).max(last).max(cursor)
}

fn under_root(root: &str, path: &str) -> bool {
    path.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'))
}

fn text(fields: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match fields.get(*key) {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    })
}

fn int(fields: &Map<String, Value>, key: &str) -> Option<i64> {
    fields.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
}

// Replaces one photo: another row with the same path under a different id is
// removed first, the row upserted, and its versions and keywords rewritten
// whole.
fn upsert_file(
    tx: &Transaction,
    id: i64,
    path: &str,
    fields: &Map<String, Value>,
    versions: &[Version],
    seq: i64,
    generation: i64,
) -> Result<(), Fail> {
    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
    let filename = text(fields, &["filename"]).unwrap_or_else(|| name.to_owned());
    let taken = text(fields, &["exif_taken_at", "taken_at"])
        .or_else(|| versions.iter().find_map(|v| v.taken_at.clone()));
    tx.prepare_cached("DELETE FROM photos WHERE server_path = ?1 AND id != ?2")?
        .execute(params![path, id])?;
    tx.prepare_cached(
        "INSERT INTO photos (id, server_path, dir, filename, extension, kind, size, mtime,
             sidecar_fp, make, model, lens, body_key, body_serial, camera_label, iso_label,
             aperture_label, focal_label, shutter_label, exif_taken_at, seq, gen)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
             ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(id) DO UPDATE SET
             server_path = excluded.server_path, dir = excluded.dir,
             filename = excluded.filename, extension = excluded.extension,
             kind = excluded.kind, size = excluded.size, mtime = excluded.mtime,
             sidecar_fp = excluded.sidecar_fp, make = excluded.make, model = excluded.model,
             lens = excluded.lens, body_key = excluded.body_key,
             body_serial = excluded.body_serial, camera_label = excluded.camera_label,
             iso_label = excluded.iso_label, aperture_label = excluded.aperture_label,
             focal_label = excluded.focal_label, shutter_label = excluded.shutter_label,
             exif_taken_at = excluded.exif_taken_at, seq = excluded.seq, gen = excluded.gen",
    )?
    .execute(params![
        id,
        path,
        dir,
        filename,
        text(fields, &["file_ext", "extension"]),
        text(fields, &["kind"]),
        int(fields, "size"),
        int(fields, "mtime"),
        text(fields, &["sidecars", "sidecar_fp"]),
        text(fields, &["make"]),
        text(fields, &["camera_model", "model"]),
        text(fields, &["lens"]),
        text(fields, &["body_key"]),
        text(fields, &["body_serial"]),
        text(fields, &["camera", "camera_label"]),
        text(fields, &["iso_label"]),
        text(fields, &["aperture_label"]),
        text(fields, &["focal_label"]),
        text(fields, &["shutter_label"]),
        taken,
        seq,
        generation,
    ])?;
    tx.prepare_cached("DELETE FROM versions WHERE photo_id = ?1")?
        .execute(params![id])?;
    tx.prepare_cached("DELETE FROM keywords WHERE photo_id = ?1")?
        .execute(params![id])?;
    let mut insert_version = tx.prepare_cached(
        "INSERT OR REPLACE INTO versions (photo_id, version, copy, rating, rejected, labels,
             edited, taken_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;
    let mut insert_keyword = tx.prepare_cached(
        "INSERT OR IGNORE INTO keywords (photo_id, version, keyword) VALUES (?1, ?2, ?3)",
    )?;
    for version in versions {
        insert_version.execute(params![
            id,
            version.version,
            version.copy,
            version.rating.min(5),
            version.rejected,
            version.labels & 31,
            version.edited.unwrap_or(false),
            version.taken_at,
        ])?;
        for keyword in &version.keywords {
            insert_keyword.execute(params![id, version.version, keyword])?;
        }
    }
    Ok(())
}

fn finish(tx: &Connection, high_water: i64) -> Result<(), rusqlite::Error> {
    meta_set(tx, "complete", "1")?;
    meta_set(tx, "synced_at", &now_secs().to_string())?;
    if high_water != 0 {
        meta_set(tx, "high_water", &high_water.to_string())?;
    }
    Ok(())
}

fn read_cursor(conn: &Connection) -> Result<(i64, i64), rusqlite::Error> {
    let get = |key| {
        meta_get(conn, key).map(|v| v.and_then(|v| v.parse().ok()).unwrap_or(0))
    };
    Ok((get("cursor_seq")?, get("cursor_id")?))
}

fn meta_get(conn: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    conn.query_row("SELECT value FROM mirror_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO mirror_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn count_photos(conn: &Connection) -> Result<u64, rusqlite::Error> {
    conn.query_row("SELECT COUNT(*) FROM photos", [], |r| r.get::<_, i64>(0))
        .map(|n| n.max(0) as u64)
}

fn clear_tables(tx: &Connection) -> Result<(), rusqlite::Error> {
    tx.execute_batch(
        "DELETE FROM keywords; DELETE FROM versions; DELETE FROM photos; DELETE FROM mirror_meta;",
    )
}

fn write_identity(tx: &Connection, config: &Config) -> Result<(), Fail> {
    meta_set(tx, "origin", &config.origin().map_err(Fail::message)?)?;
    meta_set(tx, "server_root", &config.server_root())?;
    Ok(())
}

// the mirror belongs to one server and one server folder; the local mount is
// not part of it, as paths are stored the server's way
fn ensure_identity(conn: &mut Connection, origin: &str, root: &str) -> Result<(), Fail> {
    let tx = conn.transaction()?;
    if meta_get(&tx, "origin")?.as_deref() != Some(origin)
        || meta_get(&tx, "server_root")?.as_deref() != Some(root)
    {
        clear_tables(&tx)?;
        meta_set(&tx, "origin", origin)?;
        meta_set(&tx, "server_root", root)?;
    }
    tx.commit()?;
    Ok(())
}

fn clear_all(conn: &mut Connection) -> Result<(), Fail> {
    let tx = conn.transaction()?;
    clear_tables(&tx)?;
    tx.commit()?;
    Ok(())
}

fn take_writer_lock(path: &Path) -> Option<File> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .ok()?;
    file.try_lock().ok()?;
    Some(file)
}

fn open_conn(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    // disposable: a power loss may cost the last pages, never the file
    conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version != USER_VERSION {
        reset_schema(&conn).map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

// a version mismatch empties the mirror; the next sync fills it again
fn reset_schema(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(&format!(
        "BEGIN;
         DROP TABLE IF EXISTS keywords;
         DROP TABLE IF EXISTS versions;
         DROP TABLE IF EXISTS photos;
         DROP TABLE IF EXISTS mirror_meta;
         {SCHEMA}
         PRAGMA user_version = {USER_VERSION};
         COMMIT;"
    ))
}

// A damaged file is kept aside for inspection, as SearchCache::open does. No
// in-memory fallback: without a usable file Immage runs without a mirror.
fn open_or_quarantine(path: &Path) -> Option<Connection> {
    let first = match open_conn(path) {
        Ok(conn) => return Some(conn),
        Err(first) => first,
    };
    let lower = first.to_ascii_lowercase();
    let corrupt = [
        "file is not a database",
        "database disk image is malformed",
        "malformed database schema",
        "unsupported file format",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern));
    if corrupt && path.exists() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let backup = path.with_file_name(format!("{name}.unusable-{suffix}"));
        if std::fs::rename(path, &backup).is_ok() {
            for ext in ["-wal", "-shm"] {
                let side = path.with_file_name(format!("{name}{ext}"));
                if side.exists() {
                    let _ = std::fs::rename(
                        &side,
                        path.with_file_name(format!("{name}.unusable-{suffix}{ext}")),
                    );
                }
            }
        }
    }
    match open_conn(path) {
        Ok(conn) => {
            eprintln!("morfPhoto local catalog reset after startup error ({first})");
            Some(conn)
        }
        Err(second) => {
            eprintln!("morfPhoto local catalog unavailable ({first}; {second})");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::atomic::AtomicUsize,
        thread,
    };

    fn mirror() -> Mirror {
        Mirror::new(|| Duration::from_secs(60))
    }

    fn worker(dir: &Path) -> Worker {
        Worker {
            conn: open_conn(&dir.join(FILE)).unwrap(),
            status_etag: None,
            last_status: None,
            retry_at: None,
            failures: 0,
            last_snapshot: None,
            no_feed_until: None,
        }
    }

    fn version(number: u32, rating: u8, keywords: &[&str]) -> Value {
        json!({"version": number, "copy": number > 0, "rating": rating, "rejected": false,
               "labels": 1, "edited": null, "taken_at": "2026-06-01T10:11:12",
               "latitude": null, "longitude": null, "keywords": keywords})
    }

    fn item(id: i64, seq: i64, path: &str, versions: Vec<Value>) -> Value {
        json!({"id": id, "seq": seq, "state": "present", "path": path,
               "camera_model": "Camera", "camera": "Maker Camera", "lens": "50mm",
               "iso_label": "100", "versions": versions})
    }

    fn tombstone(id: i64, seq: i64, state: &str, path: &str) -> Value {
        json!({"id": id, "seq": seq, "state": state, "path": path})
    }

    fn items(values: Vec<Value>) -> Vec<ChangeItem> {
        values.into_iter().map(|v| serde_json::from_value(v).unwrap()).collect()
    }

    fn apply(m: &Mirror, conn: &mut Connection, values: Vec<Value>, cursor: (i64, i64), complete: bool) {
        match m.apply_delta(conn, "/photos", &items(values), cursor, 10, complete, 0) {
            Ok(()) => {}
            Err(Fail::Error { message, .. }) => panic!("{message}"),
            Err(_) => panic!("apply failed"),
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn delta_pages_replace_versions_and_apply_tombstones() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        apply(&m, &mut w.conn, vec![
            item(1, 1, "/photos/a.ARW", vec![version(0, 3, &["Trips|June"]), version(1, 5, &["x"])]),
            item(2, 2, "/photos/b.ARW", vec![version(0, 1, &[])]),
            item(3, 3, "/photos/c.ARW", vec![version(0, 1, &[])]),
        ], (3, 3), false);
        assert_eq!((count(&w.conn, "photos"), count(&w.conn, "versions"), count(&w.conn, "keywords")), (3, 4, 2));
        // the cursor is committed with the page, and a partial run is not complete
        assert_eq!(read_cursor(&w.conn).unwrap(), (3, 3));
        assert_eq!(meta_get(&w.conn, "complete").unwrap(), None);

        // a changed photo replaces its versions and keywords whole
        apply(&m, &mut w.conn, vec![
            item(1, 4, "/photos/a.ARW", vec![version(0, 4, &["Trips|July"])]),
            tombstone(2, 5, "missing", "/photos/b.ARW"),
            tombstone(3, 6, "deleted", "/photos/c.ARW"),
            // not under the mapped server folder
            item(9, 7, "/other/z.ARW", vec![version(0, 1, &[])]),
        ], (7, 9), true);
        assert_eq!((count(&w.conn, "photos"), count(&w.conn, "versions"), count(&w.conn, "keywords")), (1, 1, 1));
        let (rating, keyword): (i64, String) = w.conn.query_row(
            "SELECT v.rating, k.keyword FROM versions v JOIN keywords k USING (photo_id, version)",
            [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((rating, keyword.as_str()), (4, "Trips|July"));
        assert_eq!(read_cursor(&w.conn).unwrap(), (7, 9));
        assert_eq!(meta_get(&w.conn, "complete").unwrap().as_deref(), Some("1"));
        let camera: String = w.conn.query_row(
            "SELECT camera_label FROM photos WHERE id = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(camera, "Maker Camera");
    }

    #[test]
    fn same_path_under_another_id_replaces_the_old_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        apply(&m, &mut w.conn, vec![item(1, 1, "/photos/a.ARW", vec![version(0, 1, &["old"])])], (1, 1), false);
        apply(&m, &mut w.conn, vec![item(5, 2, "/photos/a.ARW", vec![version(0, 2, &[])])], (2, 5), false);
        let ids: Vec<i64> = w.conn.prepare("SELECT id FROM photos").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        assert_eq!(ids, [5]);
        assert_eq!(count(&w.conn, "keywords"), 0);
    }

    #[test]
    fn a_stale_generation_rolls_the_page_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        m.request_reset();
        let result = m.apply_delta(
            &mut w.conn, "/photos",
            &items(vec![item(1, 1, "/photos/a.ARW", vec![version(0, 1, &[])])]),
            (1, 1), 1, false, 0);
        assert!(matches!(result, Err(Fail::Aborted)));
        assert_eq!(count(&w.conn, "photos"), 0);
        assert_eq!(meta_get(&w.conn, "cursor_seq").unwrap(), None);
    }

    #[test]
    fn a_changed_identity_clears_the_tables() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        ensure_identity(&mut w.conn, "http://nas", "/photos").unwrap();
        apply(&m, &mut w.conn, vec![item(1, 1, "/photos/a.ARW", vec![version(0, 1, &[])])], (1, 1), true);
        ensure_identity(&mut w.conn, "http://nas", "/photos").unwrap();
        assert_eq!(count(&w.conn, "photos"), 1);
        ensure_identity(&mut w.conn, "http://nas", "/other").unwrap();
        assert_eq!(count(&w.conn, "photos"), 0);
        assert_eq!(meta_get(&w.conn, "complete").unwrap(), None);
        assert_eq!(meta_get(&w.conn, "server_root").unwrap().as_deref(), Some("/other"));
    }

    #[test]
    fn the_last_page_ends_the_cursor_at_high_water() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        let last = items(vec![item(3, 3, "/photos/c.ARW", vec![version(0, 1, &[])])]);
        let cursor = end_cursor(None, &last, 10, (0, 0));
        assert_eq!(cursor, (10, i64::MAX));
        assert_eq!(end_cursor(None, &[], 10, (12, 5)), (12, 5));
        m.apply_delta(&mut w.conn, "/photos", &last, cursor, 10, true, 0).ok().unwrap();
        assert_eq!(read_cursor(&w.conn).unwrap(), (10, i64::MAX));
        // a row stamped after high_water is strictly after the stored cursor
        assert!((11, 1) > read_cursor(&w.conn).unwrap());
        assert!((10, 99) < read_cursor(&w.conn).unwrap());
    }

    // a routed fake server: the handler gets the request target and answers
    // (status, body). it keeps serving until dropped.
    struct Fake {
        url: String,
        requests: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        handle: Option<thread::JoinHandle<()>>,
    }

    impl Fake {
        fn new(handler: impl Fn(&str) -> (u16, Value) + Send + 'static) -> Fake {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let (log, halt) = (requests.clone(), stop.clone());
            let handle = thread::spawn(move || {
                while !halt.load(Ordering::Acquire) {
                    let Ok((mut stream, _)) = listener.accept() else {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    };
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let mut target = String::new();
                    let mut first = true;
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        if first {
                            target = line.split_whitespace().nth(1).unwrap_or_default().to_owned();
                            first = false;
                        }
                    }
                    log.lock().unwrap().push(target.clone());
                    let (status, body) = handler(&target);
                    let body = body.to_string();
                    let _ = write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                }
            });
            Fake { url, requests, stop, handle: Some(handle) }
        }
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn config(url: &str) -> Config {
        Config {
            enabled: true,
            url: url.into(),
            server_path: "/photos/".into(),
            local_path: "/mnt/photos".into(),
        }
    }

    fn run_sync(m: &Mirror, w: &mut Worker, config: &Config) -> Result<(), Fail> {
        let mut api = config.client(Some("key")).unwrap();
        m.sync(w, config, &mut api, m.generation.load(Ordering::Acquire))
    }

    fn feed(catalog: &'static str) -> impl Fn(&str) -> (u16, Value) {
        move |target| {
            if target.contains("/index/status") {
                return (200, json!({"catalog_id": catalog, "high_water": 3}));
            }
            if target.contains("after_seq=0") {
                return (200, json!({"catalog_id": catalog, "high_water": 3,
                    "next": {"seq": 2, "id": 2},
                    "items": [item(1, 1, "/photos/a.ARW", vec![version(0, 1, &[])]),
                              item(2, 2, "/photos/b.ARW", vec![version(0, 2, &[])])]}));
            }
            (200, json!({"catalog_id": catalog, "high_water": 3, "next": null,
                "items": [item(3, 3, "/photos/c.ARW", vec![version(0, 3, &[])])]}))
        }
    }

    #[test]
    fn delta_sync_pages_the_feed_and_a_new_catalog_id_starts_over() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        let fake = Fake::new(feed("aaaa"));
        let config = config(&fake.url);
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(count(&w.conn, "photos"), 3);
        assert_eq!(meta_get(&w.conn, "complete").unwrap().as_deref(), Some("1"));
        assert_eq!(read_cursor(&w.conn).unwrap(), (3, i64::MAX));
        let status = m.status();
        assert_eq!((status.photos, status.complete, status.synced_at.is_some()), (3, true, true));
        // up to date: only the status probe is repeated
        let before = fake.requests.lock().unwrap().len();
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(fake.requests.lock().unwrap().len(), before + 1);
        drop(fake);

        // a rebuilt catalog on the server: everything is dropped and fetched again
        let fake = Fake::new(feed("bbbb"));
        let config = Config { url: fake.url.clone(), ..config };
        w.status_etag = None;
        w.last_status = None;
        // the origin changed with the port, so identity clears too; the id
        // change alone is covered by the catalog_id check
        meta_set(&w.conn, "origin", &config.origin().unwrap()).unwrap();
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(meta_get(&w.conn, "catalog_id").unwrap().as_deref(), Some("bbbb"));
        assert_eq!(count(&w.conn, "photos"), 3);
    }

    #[test]
    fn an_interrupted_catch_up_resumes_instead_of_looking_current() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        // stage 0: a full sync to high_water 1. stage 1: the server moves to 3;
        // the first catch-up page commits, the second fails. stage 2: it answers.
        let stage = Arc::new(AtomicU64::new(0));
        let s = stage.clone();
        let fake = Fake::new(move |target: &str| {
            let stage = s.load(Ordering::SeqCst);
            let hw = if stage == 0 { 1 } else { 3 };
            if target.contains("/index/status") {
                return (200, json!({"catalog_id": "aaaa", "high_water": hw}));
            }
            if target.contains("after_seq=0") {
                return (200, json!({"catalog_id": "aaaa", "high_water": 1, "next": null,
                    "items": [item(1, 1, "/photos/a.ARW", vec![version(0, 1, &[])])]}));
            }
            if target.contains("after_seq=1") {
                return (200, json!({"catalog_id": "aaaa", "high_water": 3,
                    "next": {"seq": 2, "id": 2},
                    "items": [item(2, 2, "/photos/b.ARW", vec![version(0, 2, &[])])]}));
            }
            if stage == 1 {
                return (500, json!({"error": "busy"}));
            }
            (200, json!({"catalog_id": "aaaa", "high_water": 3, "next": null,
                "items": [item(3, 3, "/photos/c.ARW", vec![version(0, 3, &[])])]}))
        });
        let config = config(&fake.url);
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(meta_get(&w.conn, "complete").unwrap().as_deref(), Some("1"));
        stage.store(1, Ordering::SeqCst);
        w.status_etag = None;
        assert!(run_sync(&m, &mut w, &config).is_err());
        assert_eq!(count(&w.conn, "photos"), 2);
        assert_eq!(meta_get(&w.conn, "high_water").unwrap().as_deref(), Some("1"));
        // still complete from the first sync, but not current: the next cycle
        // fetches the rest
        stage.store(2, Ordering::SeqCst);
        w.status_etag = None;
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(count(&w.conn, "photos"), 3);
        assert_eq!(meta_get(&w.conn, "high_water").unwrap().as_deref(), Some("3"));
    }

    fn listing(paths: &[(i64, &str)]) -> Value {
        json!({"page": 1, "page_size": PAGE_SIZE, "total": paths.len(),
               "items": paths.iter().map(|(id, path)|
                   item(*id, 0, path, vec![version(0, 1, &[])])).collect::<Vec<_>>()})
    }

    #[test]
    fn an_old_server_falls_back_to_a_swept_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        let round = Arc::new(AtomicUsize::new(0));
        let handler_round = round.clone();
        let fake = Fake::new(move |target| {
            if target.contains("/index/status") {
                return (200, json!({"catalog_id": "x", "high_water": 9}));
            }
            if target.contains("/library/changes") {
                return (404, json!({}));
            }
            match handler_round.load(Ordering::Acquire) {
                0 => (200, listing(&[(1, "/photos/a.ARW"), (2, "/photos/b.ARW"), (3, "/photos/c.ARW")])),
                1 => (200, listing(&[(1, "/photos/a.ARW"), (2, "/photos/b.ARW")])),
                _ => (500, json!({})),
            }
        });
        let config = config(&fake.url);
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(count(&w.conn, "photos"), 3);
        assert_eq!(meta_get(&w.conn, "complete").unwrap().as_deref(), Some("1"));

        // within 10 minutes the snapshot is not repeated
        round.store(1, Ordering::Release);
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(count(&w.conn, "photos"), 3);

        // a failed run sweeps nothing
        w.last_snapshot = None;
        round.store(2, Ordering::Release);
        assert!(run_sync(&m, &mut w, &config).is_err());
        assert_eq!(count(&w.conn, "photos"), 3);

        // an uninterrupted run removes what the server no longer lists
        w.last_snapshot = None;
        round.store(1, Ordering::Release);
        assert!(run_sync(&m, &mut w, &config).is_ok());
        assert_eq!(count(&w.conn, "photos"), 2);
    }

    #[test]
    fn an_interrupted_snapshot_keeps_unstamped_rows() {
        let dir = tempfile::tempdir().unwrap();
        let mut w = worker(dir.path());
        let m = mirror();
        let fake = Fake::new(|target| {
            if target.contains("/index/status") {
                return (200, json!({}));
            }
            if target.contains("page=2&") {
                return (503, json!({}));
            }
            let items: Vec<Value> = (1..=PAGE_SIZE as i64)
                .map(|id| item(id, 0, &format!("/photos/{id}.ARW"), vec![version(0, 1, &[])]))
                .collect();
            (200, json!({"page": 1, "page_size": PAGE_SIZE, "total": PAGE_SIZE + 1, "items": items}))
        });
        let config = config(&fake.url);
        ensure_identity(&mut w.conn, &config.origin().unwrap(), "/photos").unwrap();
        meta_set(&w.conn, "catalog_id", "snapshot").unwrap();
        meta_set(&w.conn, "complete", "1").unwrap();
        let tx = w.conn.transaction().unwrap();
        upsert_file(&tx, 9000, "/photos/old.ARW", &Map::new(), &[], 0, 0).unwrap_or_else(|_| panic!());
        tx.commit().unwrap();
        // page 2 fails: the first page is kept, the old row is not swept and
        // the mirror stays as complete as it was
        assert!(run_sync(&m, &mut w, &config).is_err());
        assert_eq!(count(&w.conn, "photos"), PAGE_SIZE as i64 + 1);
        assert_eq!(meta_get(&w.conn, "complete").unwrap().as_deref(), Some("1"));
    }

    #[test]
    fn a_user_version_mismatch_clears_and_a_corrupt_file_is_quarantined() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FILE);
        {
            let mut w = worker(dir.path());
            let m = mirror();
            apply(&m, &mut w.conn, vec![item(1, 1, "/photos/a.ARW", vec![version(0, 1, &[])])], (1, 1), true);
            w.conn.pragma_update(None, "user_version", USER_VERSION + 1).unwrap();
        }
        let conn = open_conn(&path).unwrap();
        assert_eq!(count(&conn, "photos"), 0);
        assert_eq!(meta_get(&conn, "complete").unwrap(), None);
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, USER_VERSION);
        drop(conn);

        std::fs::write(&path, b"this is not a database, and it is long enough to be read as one").unwrap();
        let conn = open_or_quarantine(&path).expect("a fresh mirror replaces the damaged one");
        assert_eq!(count(&conn, "photos"), 0);
        let kept = std::fs::read_dir(dir.path()).unwrap().flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".unusable-"));
        assert!(kept, "the damaged file stays for inspection");
    }

    #[test]
    fn only_one_instance_holds_the_writer_lock() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK);
        let first = take_writer_lock(&path);
        assert!(first.is_some());
        assert!(take_writer_lock(&path).is_none());
        drop(first);
        assert!(take_writer_lock(&path).is_some());
    }

    #[test]
    fn a_kick_does_not_wait_for_the_state_lock() {
        let m = Arc::new(mirror());
        m.kicked.store(false, Ordering::Release);
        let held = m.clone();
        let (locked, release) = std::sync::mpsc::channel();
        let (done, finished) = std::sync::mpsc::channel();
        let holder = thread::spawn(move || {
            let _guard = held.state.lock().unwrap();
            locked.send(()).unwrap();
            let _ = finished.recv_timeout(Duration::from_secs(10));
        });
        release.recv().unwrap();
        // the state lock is held elsewhere; kick, reset and stop return anyway
        m.kick();
        m.request_reset();
        m.stop();
        assert!(m.kicked.load(Ordering::Acquire) && m.reset.load(Ordering::Acquire));
        done.send(()).unwrap();
        holder.join().unwrap();
    }
}
