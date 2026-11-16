// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Background discovery and invalidation; never imports photos into darktable.
use crate::{
    analysis_queue::{AnalysisQueue, Job},
    cache,
    search_cache::SearchCache,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct Scan {
    files: Vec<PathBuf>,
    listed: cache::Listed,
    excluded: Vec<PathBuf>,
    mounts: Vec<(String, String)>,
}
fn walk(
    path: &Path,
    hidden: &[PathBuf],
    scan: &mut Scan,
    job: &Job,
    parent_mount: Option<&str>,
) -> Result<(), String> {
    if job.cancelled() {
        return Err("cancelled".into());
    }
    if hidden.iter().any(|p| path.starts_with(p)) {
        scan.excluded.push(path.to_path_buf());
        return Ok(());
    }
    let mount = crate::volumes::mount_identity(path);
    if let (Some(parent), Some(mount)) = (parent_mount, mount.as_deref()) {
        if parent != mount {
            scan.mounts
                .push((path.to_string_lossy().into_owned(), mount.into()));
        }
    }
    let entries = std::fs::read_dir(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut stamps = Vec::new();
    let mut dirs = Vec::new();
    for entry in entries {
        if job.cancelled() {
            return Err("cancelled".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let at = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            scan.excluded.push(at);
            continue;
        }
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            // Skipped links are never evidence that cached descendants vanished.
            scan.excluded.push(at);
            continue;
        }
        if kind.is_dir() {
            #[cfg(target_os = "macos")]
            if crate::library_cmds::is_package(&at) {
                scan.excluded.push(at);
                continue;
            }
            dirs.push(at);
        } else if kind.is_file() {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            stamps.push((at.clone(), Some(cache::stamp(&metadata))));
            if crate::library_cmds::photo_candidate(&at) {
                scan.files.push(at);
            }
        }
    }
    scan.listed.add(path, stamps);
    dirs.sort();
    for dir in dirs {
        walk(&dir, hidden, scan, job, mount.as_deref())?;
    }
    Ok(())
}

struct Observation<'a> {
    expected_mount: Option<&'a str>,
    actual_mount: &'a str,
    online: bool,
    verify: &'a dyn Fn() -> bool,
}
fn reconcile(
    index: &SearchCache,
    root: &Path,
    hidden: &[PathBuf],
    job: &Job,
    observed: Observation<'_>,
) -> Result<(), String> {
    let Observation {
        expected_mount,
        actual_mount,
        online,
        verify,
    } = observed;
    let path = root.to_str().ok_or("root path is not UTF-8")?;
    let expected = expected_mount
        .map(str::to_owned)
        .or(index.root_mount(path)?);
    if !online
        || expected
            .as_deref()
            .is_some_and(|mount| mount != actual_mount)
    {
        job.commit(|| {
            index.root_state(
                path,
                None,
                "offline",
                Some("drive or network share is unavailable"),
            )
        })
        .transpose()?;
        return Ok(());
    }
    let before: HashMap<_, _> = index
        .assets()?
        .into_iter()
        .filter(|a| Path::new(&a.path).starts_with(root))
        .map(|a| (a.path.clone(), a))
        .collect();
    if expected.is_none() && !before.is_empty() {
        job.commit(|| {
            index.root_state(
                path,
                None,
                "pending",
                Some("browse this folder to establish its drive identity"),
            )
        })
        .transpose()?;
        return Ok(());
    }
    // Preserve cached subtrees whose previously observed mount disappeared,
    // even when their parent folder is still on an available local drive.
    let mut protected = hidden.to_vec();
    for observed in index.roots()? {
        let child = PathBuf::from(&observed.path);
        if child != root && child.starts_with(root) {
            if let Some(expected) = observed.mount {
                if crate::volumes::mount_identity(&child).as_deref() != Some(&expected) {
                    protected.push(child);
                }
            }
        }
    }
    let mut scan = Scan::default();
    if let Err(error) = walk(root, &protected, &mut scan, job, None) {
        if !job.cancelled() {
            job.commit(|| index.root_state(path, None, "incomplete", Some(&error)))
                .transpose()?;
        }
        return Ok(()); // Partial reads never prove deletion.
    }
    if !verify() {
        job.commit(|| {
            index.root_state(
                path,
                None,
                "offline",
                Some("drive changed or disconnected during scan"),
            )
        })
        .transpose()?;
        return Ok(());
    }
    for (path, mount) in &scan.mounts {
        job.commit(|| index.root_state(path, Some(mount), "online", None))
            .transpose()?;
    }
    let listed = Mutex::new(scan.listed);
    let seen: HashSet<_> = scan
        .files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    // Upserts go in one transaction per directory (one cache lock and WAL
    // sync, not one per photo). Inputs are gathered before the write.
    struct Pending {
        path: String,
        key: String,
        original: String,
        edited: String,
        ns: Option<i64>,
        raw: Option<String>,
        offset: Option<i32>,
    }
    fn flush(index: &SearchCache, job: &Job, pending: &mut Vec<Pending>) -> Result<(), String> {
        if pending.is_empty() {
            return Ok(());
        }
        let items: Vec<_> = pending
            .iter()
            .map(|p| crate::search_cache::BatchItem {
                path: &p.path,
                copy_key: &p.key,
                original: &p.original,
                edited: &p.edited,
                capture_time_ns: p.ns,
                capture_time_raw: p.raw.as_deref(),
                timezone_offset_seconds: p.offset,
                metadata: None,
            })
            .collect();
        job.commit(|| index.upsert_metadata_batch(&items))
            .transpose()?;
        pending.clear();
        Ok(())
    }
    let mut pending: Vec<Pending> = Vec::new();
    let mut pending_dir: Option<PathBuf> = None;
    for photo in scan.files {
        if job.cancelled() {
            return Ok(());
        }
        if pending_dir.as_deref() != photo.parent() {
            flush(index, job, &mut pending)?;
            pending_dir = photo.parent().map(Path::to_path_buf);
        }
        let Some(path) = photo.to_str() else { continue };
        let Some(versions) = listed.lock().unwrap().versions(&photo) else {
            continue;
        };
        let old = index.path_variants(path)?;
        for version in &versions {
            let key = if *version == 0 {
                String::new()
            } else {
                format!("version:{version}")
            };
            let Some((original, edited)) =
                cache::listed_metadata_fingerprints(&listed, &photo, *version)
            else {
                continue;
            };
            let prior = old.iter().find(|v| v.copy_key == key).filter(|_| {
                before
                    .get(path)
                    .is_some_and(|a| a.original_fingerprint == original)
            });
            let ns = prior.and_then(|v| v.capture_time_ns);
            let raw = prior.and_then(|v| v.capture_time_raw.as_deref());
            let offset = prior.and_then(|v| v.timezone_offset_seconds);
            pending.push(Pending {
                path: path.to_string(),
                key,
                original,
                edited,
                ns,
                raw: raw.map(str::to_string),
                offset,
            });
        }
        for v in old {
            if let Some(version) = v
                .copy_key
                .strip_prefix("version:")
                .and_then(|n| n.parse::<i64>().ok())
            {
                if !versions.contains(&version) {
                    job.commit(|| index.remove_variant(path, &v.copy_key))
                        .transpose()?;
                }
            }
        }
    }
    flush(index, job, &mut pending)?;
    // Pruning needs a previously observed mount identity, a complete scan and
    // continued drive availability. A newly mounted/unknown empty directory is
    // never sufficient evidence to discard offline photos.
    if !verify() {
        job.commit(|| {
            index.root_state(
                path,
                None,
                "offline",
                Some("drive changed or disconnected during scan"),
            )
        })
        .transpose()?;
        return Ok(());
    }
    if expected.is_some() && !job.cancelled() {
        for asset in before.values() {
            let at = Path::new(&asset.path);
            if !seen.contains(&asset.path)
                && !scan
                    .excluded
                    .iter()
                    .chain(&protected)
                    .any(|p| at.starts_with(p))
            {
                job.commit(|| index.remove_unchanged_asset(asset))
                    .transpose()?;
            }
        }
    }
    job.commit(|| index.root_state(path, Some(actual_mount), "online", None))
        .transpose()?;
    Ok(())
}

pub fn startup(index: Option<Arc<SearchCache>>, runtime: &Path, queue: &AnalysisQueue) {
    let Some(index) = index else { return };
    let config = crate::settings::read_key(runtime, "immage.library")
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_default();
    let hidden: Vec<PathBuf> = config["hidden"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(PathBuf::from)
        .collect();
    let mut seen = HashSet::new();
    for root in config["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
    {
        if !seen.insert(root.to_string()) {
            continue;
        }
        let expected = config["volumes"][root]["mount"].as_str().map(str::to_owned);
        let (root, index, hidden) = (root.to_string(), index.clone(), hidden.clone());
        let key = format!("reconcile:{root}");
        let accepted = queue.submit(key, move |job| {
            if job.cancelled() {
                return;
            }
            let volume = crate::volumes::volume(&root);
            if let Err(error) = reconcile(
                &index,
                Path::new(&root),
                &hidden,
                &job,
                Observation {
                    expected_mount: expected.as_deref(),
                    actual_mount: &volume.mount,
                    online: volume.online,
                    verify: &|| {
                        let current = crate::volumes::volume(&root);
                        current.online && current.mount == volume.mount
                    },
                },
            ) {
                eprintln!("metadata reconciliation: {error}");
            }
        });
        if !accepted {
            eprintln!("metadata reconciliation queue is full; root deferred");
        }
    }
    eprintln!(
        "search cache: {} reconciliation jobs queued",
        queue.status().queued
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    fn run(
        index: Arc<SearchCache>,
        root: PathBuf,
        expected: Option<&str>,
        actual: &str,
        online: bool,
        hidden: Vec<PathBuf>,
    ) {
        let queue = AnalysisQueue::new(1, 2);
        let (tx, rx) = mpsc::channel();
        let expected = expected.map(str::to_owned);
        let actual = actual.to_string();
        assert!(queue.submit("scan".into(), move |job| tx
            .send(reconcile(
                &index,
                &root,
                &hidden,
                &job,
                Observation {
                    expected_mount: expected.as_deref(),
                    actual_mount: &actual,
                    online,
                    verify: &|| online
                }
            ))
            .unwrap()));
        rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
    }
    #[test]
    fn offline_wrong_mount_unknown_mount_and_incomplete_scans_never_delete() {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SearchCache::open(&dir.path().join("index.sqlite")).unwrap());
        let root = dir.path().join("photos");
        std::fs::create_dir(&root).unwrap();
        let gone = root.join("gone.raw").to_string_lossy().into_owned();
        index
            .upsert_variant(&gone, "", "old", "old", None, None, None)
            .unwrap();
        run(
            index.clone(),
            root.clone(),
            Some("/nas"),
            "/nas",
            false,
            vec![],
        );
        run(index.clone(), root.clone(), Some("/nas"), "/", true, vec![]);
        assert!(index.variant(&gone, "").unwrap().is_some());
        // Unknown mount gets observed, without pruning the first scan.
        run(index.clone(), root.clone(), None, "/", true, vec![]);
        assert!(index.variant(&gone, "").unwrap().is_some());
        let missing = root.join("missing-dir");
        let under = missing.join("a.raw").to_string_lossy().into_owned();
        index
            .upsert_variant(&under, "", "old", "old", None, None, None)
            .unwrap();
        run(index.clone(), missing, Some("/"), "/", true, vec![]);
        assert!(index.variant(&under, "").unwrap().is_some());
        run(index.clone(), root, Some("/"), "/", true, vec![]);
        assert!(index.variant(&gone, "").unwrap().is_none());
    }
    #[test]
    fn mid_scan_disconnect_and_disconnected_nested_mount_preserve_records() {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SearchCache::open(&dir.path().join("index.sqlite")).unwrap());
        let root = dir.path().join("photos");
        std::fs::create_dir(&root).unwrap();
        let nested = root.join("nas");
        std::fs::create_dir(&nested).unwrap();
        let gone = nested.join("offline.raw").to_string_lossy().into_owned();
        index
            .upsert_variant(&gone, "", "old", "old", None, None, None)
            .unwrap();
        index
            .root_state(
                nested.to_str().unwrap(),
                Some("/disconnected-nas"),
                "online",
                None,
            )
            .unwrap();
        run(index.clone(), root.clone(), Some("/"), "/", true, vec![]);
        assert!(index.variant(&gone, "").unwrap().is_some());
        let direct = root.join("other.raw").to_string_lossy().into_owned();
        index
            .upsert_variant(&direct, "", "old", "old", None, None, None)
            .unwrap();
        let queue = AnalysisQueue::new(1, 2);
        let (tx, rx) = mpsc::channel();
        let (cache, at) = (index.clone(), root.clone());
        assert!(queue.submit("disconnect".into(), move |job| tx
            .send(reconcile(
                &cache,
                &at,
                &[],
                &job,
                Observation {
                    expected_mount: Some("/"),
                    actual_mount: "/",
                    online: true,
                    verify: &|| false
                }
            ))
            .unwrap()));
        rx.recv_timeout(Duration::from_secs(3)).unwrap().unwrap();
        assert!(index.variant(&direct, "").unwrap().is_some());
    }

    #[test]
    fn discovery_invalidates_changed_sources_preserves_precision_and_protects_exclusions() {
        let dir = tempfile::tempdir().unwrap();
        let index = Arc::new(SearchCache::open(&dir.path().join("index.sqlite")).unwrap());
        let root = dir.path().join("photos");
        std::fs::create_dir(&root).unwrap();
        let photo = root.join("a.raw");
        std::fs::write(&photo, b"raw").unwrap();
        run(index.clone(), root.clone(), Some("/"), "/", true, vec![]);
        let path = photo.to_str().unwrap();
        let first = index.variant(path, "").unwrap().unwrap();
        let asset = index.asset(first.asset_id).unwrap().unwrap();
        index
            .upsert_variant(
                path,
                "",
                &asset.original_fingerprint,
                &first.edited_fingerprint,
                Some(123),
                Some("precise"),
                Some(3600),
            )
            .unwrap();
        index
            .put_analysis(
                first.id,
                "original",
                &asset.original_fingerprint,
                1,
                "m",
                &[1],
            )
            .unwrap();
        run(index.clone(), root.clone(), Some("/"), "/", true, vec![]);
        assert_eq!(
            index.variant(path, "").unwrap().unwrap().capture_time_ns,
            Some(123)
        );
        std::fs::write(&photo, b"changed raw pixels").unwrap();
        run(index.clone(), root.clone(), Some("/"), "/", true, vec![]);
        assert_eq!(index.variant(path, "").unwrap().unwrap().id, first.id);
        assert_eq!(index.analysis(first.id, "original", 1, "m").unwrap(), None);
        assert_eq!(
            index.variant(path, "").unwrap().unwrap().capture_time_ns,
            None
        );
        std::fs::remove_file(&photo).unwrap();
        run(
            index.clone(),
            root.clone(),
            Some("/"),
            "/",
            true,
            vec![photo.clone()],
        );
        assert!(index.variant(path, "").unwrap().is_some());
        run(index.clone(), root, Some("/"), "/", true, vec![]);
        assert!(index.variant(path, "").unwrap().is_none());
    }
}
