// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Directory-level CLIP provider discovery, capability probing, and precedence.
//!
//! Precedence for every directory/photo path is strictly:
//! `morfPhoto` -> `Immich` -> `local`.
//!
//! Locking discipline:
//! - `ProbeCache::state` is a strict leaf lock held only for in-memory reads
//!   and writes (nanoseconds). It is never held across network, keyring,
//!   SQLite, or filesystem calls, and no other lock is acquired while holding
//!   it.
//! - `ProbeCache::probing` deduplicates background refreshes with an RAII drop
//!   guard so panics or early returns never wedge future probes.

use crate::immich_search::{self, PathMap};
use crate::immich_upload::Immich;
use crate::morf_photo;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use specta::Type;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_TTL: Duration = Duration::from_secs(30);
const FAILURE_TTL: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ClipProvider {
    MorfPhoto,
    Immich,
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RootClipProvider {
    pub path: String,
    pub provider: ClipProvider,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImmichCoverage {
    pub local_root: PathBuf,
    pub canonical_root: Option<PathBuf>,
    pub server_root: String,
}

impl ImmichCoverage {
    pub fn path_map(&self) -> PathMap {
        PathMap {
            immich: self.server_root.clone(),
            local: self.local_root.to_string_lossy().into_owned(),
        }
    }

    pub fn covers(&self, path: &Path) -> bool {
        path_within(path, &self.local_root)
            || self
                .canonical_root
                .as_deref()
                .is_some_and(|canon| path_within(path, canon))
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActiveProviders {
    pub morfphoto_root: Option<PathBuf>,
    pub immich: Option<ImmichCoverage>,
}

impl ActiveProviders {
    /// Strict directory precedence: morfPhoto -> Immich -> local.
    pub fn for_path(&self, path: &Path) -> ClipProvider {
        if self
            .morfphoto_root
            .as_deref()
            .is_some_and(|root| path_within(path, root))
        {
            return ClipProvider::MorfPhoto;
        }
        if self
            .immich
            .as_ref()
            .is_some_and(|coverage| coverage.covers(path))
        {
            return ClipProvider::Immich;
        }
        ClipProvider::Local
    }

    pub fn any_remote(&self) -> bool {
        self.morfphoto_root.is_some() || self.immich.is_some()
    }
}

pub fn path_within(path: &Path, root: &Path) -> bool {
    path.is_absolute()
        && root.is_absolute()
        && !path.components().any(|c| c == Component::ParentDir)
        && !root.components().any(|c| c == Component::ParentDir)
        && path.starts_with(root)
}

/// Whether morfPhoto's `/api/v1/index/status` JSON reports active CLIP service.
/// Disabled, missing, or errored-with-zero-indexed servers fall through.
pub fn morf_photo_clip_serving(metrics: &Value) -> bool {
    let Some(clip) = metrics.get("clip") else {
        return false;
    };
    let Some(state) = clip.get("state").and_then(Value::as_str) else {
        return false;
    };
    if state == "disabled" {
        return false;
    }
    if state == "error" && clip.get("indexed").and_then(Value::as_u64).unwrap_or(0) == 0 {
        return false;
    }
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryScopePlan {
    /// Distinct roots/subtrees handled by morfPhoto CLIP.
    pub morfphoto: Vec<PathBuf>,
    /// Distinct roots/subtrees handled by Immich CLIP, each with any nested
    /// morfPhoto subtrees that must be excluded from Immich results.
    pub immich: Vec<(PathBuf, Vec<PathBuf>)>,
    /// Subtrees excluded from local CLIP because morfPhoto or Immich covers them.
    pub local_excluded: Vec<PathBuf>,
    /// True if at least one library root has paths not fully covered by
    /// `local_excluded` (and `hidden`).
    pub has_local_scope: bool,
}

fn intersect_scopes(roots: &[PathBuf], hidden: &[PathBuf], covered: &Path) -> Vec<PathBuf> {
    let mut scopes = Vec::new();
    for root in roots {
        let scope = if path_within(root, covered) {
            root.as_path()
        } else if path_within(covered, root) {
            covered
        } else {
            continue;
        };
        if !hidden.iter().any(|h| path_within(scope, h)) {
            scopes.push(scope.to_path_buf());
        }
    }
    dedup_scopes(scopes)
}

fn dedup_scopes(mut scopes: Vec<PathBuf>) -> Vec<PathBuf> {
    scopes.sort();
    let mut distinct: Vec<PathBuf> = Vec::new();
    for scope in scopes {
        if !distinct.iter().any(|parent| path_within(&scope, parent)) {
            distinct.push(scope);
        }
    }
    distinct
}

pub fn roots_have_uncovered_paths(
    roots: &[PathBuf],
    hidden: &[PathBuf],
    excluded: &[PathBuf],
) -> bool {
    roots.iter().any(|root| {
        !hidden.iter().any(|h| path_within(root, h))
            && !excluded.iter().any(|ex| path_within(root, ex))
    })
}

/// Partition configured library roots across morfPhoto -> Immich -> local.
/// When `immich_already_searched` is true (e.g. Find's "Both" mode), Immich is
/// not queried a second time by `local_search`, while its covered subtrees
/// remain excluded from local CLIP so local vectors are not scanned for them.
pub fn plan_library_scopes(
    roots: &[PathBuf],
    hidden: &[PathBuf],
    providers: &ActiveProviders,
    immich_already_searched: bool,
) -> LibraryScopePlan {
    let morfphoto = providers
        .morfphoto_root
        .as_deref()
        .map(|root| intersect_scopes(roots, hidden, root))
        .unwrap_or_default();

    let raw_immich = providers
        .immich
        .as_ref()
        .map(|cov| {
            let mut scopes = intersect_scopes(roots, hidden, &cov.local_root);
            if let Some(canon) = cov.canonical_root.as_deref() {
                if canon != cov.local_root.as_path() {
                    scopes.extend(intersect_scopes(roots, hidden, canon));
                    scopes = dedup_scopes(scopes);
                }
            }
            scopes
        })
        .unwrap_or_default();

    let mut immich = Vec::new();
    let mut immich_covered = Vec::new();
    for scope in raw_immich {
        if morfphoto.iter().any(|mp| path_within(&scope, mp)) {
            continue;
        }
        immich_covered.push(scope.clone());
        if !immich_already_searched {
            let nested_morf: Vec<PathBuf> = morfphoto
                .iter()
                .filter(|mp| path_within(mp, &scope))
                .cloned()
                .collect();
            immich.push((scope, nested_morf));
        }
    }

    let mut local_excluded = morfphoto.clone();
    local_excluded.extend(immich_covered);
    let local_excluded = dedup_scopes(local_excluded);
    let has_local_scope = roots_have_uncovered_paths(roots, hidden, &local_excluded);

    LibraryScopePlan {
        morfphoto,
        immich,
        local_excluded,
        has_local_scope,
    }
}

pub fn library_roots(runtime: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let config = crate::settings::read_key(runtime, "immage.library")
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_default();
    let paths = |key: &str| {
        config[key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect::<Vec<_>>()
    };
    (paths("folders"), paths("hidden"))
}

pub fn root_providers(runtime: &Path, active: &ActiveProviders) -> Vec<RootClipProvider> {
    let (roots, hidden) = library_roots(runtime);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        if hidden.iter().any(|h| path_within(&root, h)) {
            continue;
        }
        let s = root.to_string_lossy().into_owned();
        if !seen.insert(s.clone()) {
            continue;
        }
        out.push(RootClipProvider {
            path: s,
            provider: active.for_path(&root),
        });
    }
    out
}

/// Resolve Immich's effective `PathMap` using the exact same precedence as
/// `app/src/immich.ts`: `immage.immichPathMap` in `settings.json`, falling back
/// to the embedded importer's `immich.pathPrefix` and `ui.destRoot`.
pub fn effective_immich_path_map(app: &AppHandle, runtime: &Path) -> PathMap {
    let stored: PathMap = crate::settings::read_key(runtime, "immage.immichPathMap")
        .and_then(|s| serde_json::from_str::<PathMap>(&s).ok())
        .unwrap_or_default();
    let mut immich = stored.immich.trim().to_string();
    let mut local = stored.local.trim().to_string();
    if immich.is_empty() || local.is_empty() {
        if let Ok(data) = app.path().app_data_dir() {
            let catalog = data.join("immporter").join("catalog.sqlite");
            if let Some((prefix, dest)) = read_importer_path_defaults(&catalog) {
                if immich.is_empty() {
                    immich = prefix;
                }
                if local.is_empty() {
                    local = dest;
                }
            }
        }
    }
    PathMap { immich, local }
}

fn read_importer_path_defaults(catalog_path: &Path) -> Option<(String, String)> {
    if !catalog_path.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(
        catalog_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let read = |key: &str| -> Option<Value> {
        let raw: String = conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0))
            .ok()?;
        serde_json::from_str(&raw).ok()
    };
    let prefix = read("immich")
        .and_then(|v| v.get("pathPrefix")?.as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();
    let dest = read("ui")
        .and_then(|v| v.get("destRoot")?.as_str().map(|s| s.trim().to_string()))
        .unwrap_or_default();
    Some((prefix, dest))
}

fn build_immich_coverage(map: &PathMap) -> Option<ImmichCoverage> {
    let server = map.immich.trim();
    let local = map.local.trim();
    if server.is_empty() || local.is_empty() {
        return None;
    }
    let (_, parts) = immich_search::server_path(server)?;
    if parts.is_empty() {
        return None;
    }
    let local_root = PathBuf::from(local);
    if !local_root.is_absolute() || local_root.components().any(|c| c == Component::ParentDir) {
        return None;
    }
    let canonical_root = crate::volumes::answering(&local_root)
        .then(|| std::fs::canonicalize(&local_root).ok())
        .flatten()
        .filter(|canon| canon != &local_root);
    Some(ImmichCoverage {
        local_root,
        canonical_root,
        server_root: server.to_string(),
    })
}

fn morfphoto_fingerprint(config: &morf_photo::Config) -> String {
    format!(
        "{}\0{}\0{}\0{}",
        config.enabled,
        config.url.trim(),
        config.server_path.trim(),
        config.local_path.trim()
    )
}

fn immich_fingerprint(
    conn: Option<&tauri_plugin_immporter::ImmichConnection>,
    map: &PathMap,
) -> String {
    match conn {
        Some(c) => format!(
            "1\0{}\0{}\0{}\0{}",
            c.url.trim(),
            c.accept_invalid_certs,
            map.immich.trim(),
            map.local.trim()
        ),
        None => format!("0\0{}\0{}", map.immich.trim(), map.local.trim()),
    }
}

#[derive(Clone)]
struct CachedProbe<T> {
    fingerprint: String,
    checked_at: Instant,
    ttl: Duration,
    value: T,
}

impl<T> CachedProbe<T> {
    fn fresh(&self, fingerprint: &str, now: Instant) -> bool {
        self.fingerprint == fingerprint && now.saturating_duration_since(self.checked_at) < self.ttl
    }
}

#[derive(Default)]
struct CacheState {
    primed: bool,
    morfphoto: Option<CachedProbe<Option<PathBuf>>>,
    immich: Option<CachedProbe<Option<ImmichCoverage>>>,
}

struct ProbingGuard(Arc<AtomicBool>);
impl Drop for ProbingGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

pub struct ProbeCache {
    state: Mutex<CacheState>,
    probing: Arc<AtomicBool>,
}

impl ProbeCache {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(CacheState::default()),
            probing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Non-blocking snapshot of the latest known CLIP providers (leaf lock only).
    pub fn cached(&self) -> ActiveProviders {
        let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        ActiveProviders {
            morfphoto_root: guard.morfphoto.as_ref().and_then(|p| p.value.clone()),
            immich: guard.immich.as_ref().and_then(|p| p.value.clone()),
        }
    }

    pub fn is_primed(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .primed
    }

    pub fn invalidate_morfphoto(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.morfphoto = None;
    }

    pub fn invalidate_immich(&self) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.immich = None;
    }

    /// Immediately mark morfPhoto CLIP unavailable for FAILURE_TTL so queries
    /// and background scans fall through without waiting for another timeout.
    pub fn record_morfphoto_failure(&self, runtime: &Path) {
        let config = morf_photo::load(runtime);
        let fp = morfphoto_fingerprint(&config);
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.morfphoto = Some(CachedProbe {
            fingerprint: fp,
            checked_at: Instant::now(),
            ttl: FAILURE_TTL,
            value: None,
        });
    }

    /// Immediately mark Immich CLIP unavailable for FAILURE_TTL so queries and
    /// background scans fall through to local CLIP immediately.
    pub fn record_immich_failure(&self, app: &AppHandle, runtime: &Path) {
        let conn = tauri_plugin_immporter::immich_connection(app);
        let map = effective_immich_path_map(app, runtime);
        let fp = immich_fingerprint(conn.as_ref(), &map);
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.immich = Some(CachedProbe {
            fingerprint: fp,
            checked_at: Instant::now(),
            ttl: FAILURE_TTL,
            value: None,
        });
    }

    /// Spawn at most one background probe thread to prime or refresh the cache
    /// without blocking the caller (used by `search_status`).
    pub fn trigger_background_refresh(self: &Arc<Self>, app: AppHandle, runtime: PathBuf) {
        if self
            .probing
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let cache = self.clone();
        let guard = ProbingGuard(self.probing.clone());
        std::thread::spawn(move || {
            let _guard = guard;
            let _ = cache.resolve(&app, &runtime);
        });
    }

    /// Return fresh active providers, probing any stale/unprimed provider off
    /// the lock. Call only from background/blocking threads, never the event loop.
    pub fn resolve(&self, app: &AppHandle, runtime: &Path) -> ActiveProviders {
        let now = Instant::now();

        // 1. morfPhoto
        let mp_config = morf_photo::load(runtime);
        let mp_fp = morfphoto_fingerprint(&mp_config);
        let cached_mp = {
            let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .morfphoto
                .as_ref()
                .filter(|p| p.fresh(&mp_fp, now))
                .map(|p| p.value.clone())
        };
        let morfphoto_root = match cached_mp {
            Some(val) => val,
            None => {
                let (val, ttl) = probe_morfphoto(&mp_config);
                let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                guard.morfphoto = Some(CachedProbe {
                    fingerprint: mp_fp,
                    checked_at: Instant::now(),
                    ttl,
                    value: val.clone(),
                });
                val
            }
        };

        // 2. Immich
        let map = effective_immich_path_map(app, runtime);
        // Fast-path: if Immich has no valid path mapping, skip keychain and network completely.
        let (immich_value, immich_fp, immich_ttl) = if build_immich_coverage(&map).is_none() {
            let fp = immich_fingerprint(None, &map);
            let cached_im = {
                let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                guard
                    .immich
                    .as_ref()
                    .filter(|p| p.fresh(&fp, now))
                    .map(|p| p.value.clone())
            };
            if let Some(val) = cached_im {
                (val, None, PROBE_TTL)
            } else {
                (None, Some(fp), PROBE_TTL)
            }
        } else {
            let conn = tauri_plugin_immporter::immich_connection(app);
            let fp = immich_fingerprint(conn.as_ref(), &map);
            let cached_im = {
                let guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
                guard
                    .immich
                    .as_ref()
                    .filter(|p| p.fresh(&fp, now))
                    .map(|p| p.value.clone())
            };
            match cached_im {
                Some(val) => (val, None, PROBE_TTL),
                None => {
                    let (val, ttl) = probe_immich(conn.as_ref(), &map);
                    (val, Some(fp), ttl)
                }
            }
        };

        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(fp) = immich_fp {
            guard.immich = Some(CachedProbe {
                fingerprint: fp,
                checked_at: Instant::now(),
                ttl: immich_ttl,
                value: immich_value.clone(),
            });
        }
        guard.primed = true;
        ActiveProviders {
            morfphoto_root,
            immich: immich_value,
        }
    }

    #[cfg(test)]
    pub(crate) fn set_for_test(&self, active: ActiveProviders) {
        let mut guard = self.state.lock().unwrap_or_else(|e| e.into_inner());
        guard.primed = true;
        guard.morfphoto = Some(CachedProbe {
            fingerprint: "test".into(),
            checked_at: Instant::now(),
            ttl: PROBE_TTL,
            value: active.morfphoto_root,
        });
        guard.immich = Some(CachedProbe {
            fingerprint: "test".into(),
            checked_at: Instant::now(),
            ttl: PROBE_TTL,
            value: active.immich,
        });
    }
}

fn probe_morfphoto(config: &morf_photo::Config) -> (Option<PathBuf>, Duration) {
    let Some(root) = config.mapped_root() else {
        return (None, PROBE_TTL);
    };
    match config.metrics() {
        Ok(metrics) => {
            let serving = morf_photo_clip_serving(&metrics);
            (serving.then_some(root), PROBE_TTL)
        }
        Err(_) => (None, FAILURE_TTL),
    }
}

fn probe_immich(
    conn: Option<&tauri_plugin_immporter::ImmichConnection>,
    map: &PathMap,
) -> (Option<ImmichCoverage>, Duration) {
    let Some(conn) = conn else {
        return (None, PROBE_TTL);
    };
    let Some(coverage) = build_immich_coverage(map) else {
        return (None, PROBE_TTL);
    };
    let Ok(client) = Immich::new_with_timeout(conn, PROBE_TIMEOUT) else {
        return (None, FAILURE_TTL);
    };
    match client.smart_search_available() {
        Ok(true) => (Some(coverage), PROBE_TTL),
        Ok(false) => (None, PROBE_TTL),
        Err(_) => (None, FAILURE_TTL),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn immich_cov(local: &str, server: &str) -> ImmichCoverage {
        ImmichCoverage {
            local_root: PathBuf::from(local),
            canonical_root: None,
            server_root: server.into(),
        }
    }

    #[test]
    fn precedence_orders_morfphoto_before_immich_before_local() {
        let active = ActiveProviders {
            morfphoto_root: Some(PathBuf::from("/nas/photos")),
            immich: Some(immich_cov("/nas/photos", "/mnt/photos")),
        };
        assert_eq!(
            active.for_path(Path::new("/nas/photos/2026/a.orf")),
            ClipProvider::MorfPhoto
        );
        assert_eq!(
            active.for_path(Path::new("/nas/photos-other/a.orf")),
            ClipProvider::Local
        );
        assert_eq!(
            active.for_path(Path::new("/local/a.orf")),
            ClipProvider::Local
        );
        assert_eq!(
            active.for_path(Path::new("relative/a.orf")),
            ClipProvider::Local
        );
        assert_eq!(
            active.for_path(Path::new("/nas/photos/../other/a.orf")),
            ClipProvider::Local
        );

        let immich_only = ActiveProviders {
            morfphoto_root: None,
            immich: Some(immich_cov("/nas/photos", "/mnt/photos")),
        };
        assert_eq!(
            immich_only.for_path(Path::new("/nas/photos/2026/a.orf")),
            ClipProvider::Immich
        );
        assert_eq!(
            immich_only.for_path(Path::new("/nas/photos2/a.orf")),
            ClipProvider::Local
        );
    }

    #[test]
    fn nested_providers_resolve_strictly_by_precedence() {
        // morfPhoto covers a subfolder inside Immich's root
        let active = ActiveProviders {
            morfphoto_root: Some(PathBuf::from("/nas/archive")),
            immich: Some(immich_cov("/nas", "/mnt/nas")),
        };
        assert_eq!(
            active.for_path(Path::new("/nas/archive/a.orf")),
            ClipProvider::MorfPhoto
        );
        assert_eq!(
            active.for_path(Path::new("/nas/other/b.orf")),
            ClipProvider::Immich
        );
        assert_eq!(
            active.for_path(Path::new("/local/c.orf")),
            ClipProvider::Local
        );

        // Immich covers a subfolder inside morfPhoto's root: morfPhoto still wins
        let inverted = ActiveProviders {
            morfphoto_root: Some(PathBuf::from("/nas")),
            immich: Some(immich_cov("/nas/sub", "/mnt/sub")),
        };
        assert_eq!(
            inverted.for_path(Path::new("/nas/sub/a.orf")),
            ClipProvider::MorfPhoto
        );
    }

    #[test]
    fn morfphoto_clip_serving_detects_active_vs_disabled_states() {
        assert!(!morf_photo_clip_serving(&json!({})));
        assert!(!morf_photo_clip_serving(&json!({"clip": {}})));
        assert!(!morf_photo_clip_serving(&json!({"clip": {"state": "disabled"}})));
        assert!(!morf_photo_clip_serving(&json!({"clip": {"state": "error", "indexed": 0}})));
        assert!(morf_photo_clip_serving(&json!({"clip": {"state": "error", "indexed": 42}})));
        for state in ["idle", "indexing", "starting", "paused", "retrying"] {
            assert!(
                morf_photo_clip_serving(&json!({"clip": {"state": state}})),
                "expected state={state} to count as serving"
            );
        }
    }

    #[test]
    fn library_scope_plan_partitions_and_excludes_nested_morfphoto_from_immich() {
        let roots = vec![PathBuf::from("/nas"), PathBuf::from("/local")];
        let hidden = vec![PathBuf::from("/nas/private")];
        let active = ActiveProviders {
            morfphoto_root: Some(PathBuf::from("/nas/archive")),
            immich: Some(immich_cov("/nas", "/mnt/nas")),
        };

        let plan = plan_library_scopes(&roots, &hidden, &active, false);
        assert_eq!(plan.morfphoto, vec![PathBuf::from("/nas/archive")]);
        assert_eq!(
            plan.immich,
            vec![(PathBuf::from("/nas"), vec![PathBuf::from("/nas/archive")])]
        );
        assert_eq!(plan.local_excluded, vec![PathBuf::from("/nas")]);
        assert!(plan.has_local_scope);

        // When Both mode already searches Immich, don't duplicate Immich query,
        // but keep /nas excluded from local CLIP.
        let both_plan = plan_library_scopes(&roots, &hidden, &active, true);
        assert_eq!(both_plan.morfphoto, vec![PathBuf::from("/nas/archive")]);
        assert!(both_plan.immich.is_empty());
        assert_eq!(both_plan.local_excluded, vec![PathBuf::from("/nas")]);
        assert!(both_plan.has_local_scope);

        // When all roots are covered, has_local_scope is false.
        let covered_only = plan_library_scopes(&[PathBuf::from("/nas")], &hidden, &active, false);
        assert!(!covered_only.has_local_scope);
    }

    #[test]
    fn probe_cache_invalidation_and_failure_recording() {
        let cache = ProbeCache::new();
        assert!(!cache.is_primed());
        assert_eq!(cache.cached(), ActiveProviders::default());

        cache.set_for_test(ActiveProviders {
            morfphoto_root: Some(PathBuf::from("/nas")),
            immich: Some(immich_cov("/photos", "/mnt/photos")),
        });
        assert!(cache.is_primed());
        assert!(cache.cached().any_remote());

        cache.invalidate_morfphoto();
        assert!(cache.cached().morfphoto_root.is_none());
        assert!(cache.cached().immich.is_some());

        cache.invalidate_immich();
        assert!(!cache.cached().any_remote());
    }

    #[test]
    fn read_importer_path_defaults_reads_sqlite_settings() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("catalog.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES ('immich', ?1), ('ui', ?2)",
            [
                r#"{"enabled":true,"url":"http://immich","pathPrefix":"/mnt/photos"}"#,
                r#"{"destRoot":"/Volumes/photos"}"#,
            ],
        )
        .unwrap();
        drop(conn);

        assert_eq!(
            read_importer_path_defaults(&db),
            Some(("/mnt/photos".into(), "/Volumes/photos".into()))
        );
        assert_eq!(read_importer_path_defaults(&dir.path().join("missing.sqlite")), None);
    }
}
