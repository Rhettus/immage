// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
use crate::{
    local_search::{self, LocalPage, LocalSearchArgs, ProviderMetadata},
    AppState,
};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, State};
#[derive(Default)]
pub struct Requests(Mutex<HashMap<u64, Arc<AtomicBool>>>);
struct Ticket {
    id: u64,
    requests: Arc<Requests>,
    cancelled: Arc<AtomicBool>,
}
impl Requests {
    fn begin(self: &Arc<Self>, id: u64) -> Result<Ticket, String> {
        let mut requests = self.0.lock().map_err(|_| "Search request lock poisoned")?;
        if id == 0 || requests.contains_key(&id) {
            return Err("Invalid or duplicate local search request".into());
        }
        if requests.len() >= 4 {
            return Err("Local search is busy; retry shortly".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        requests.insert(id, cancelled.clone());
        Ok(Ticket {
            id,
            requests: self.clone(),
            cancelled,
        })
    }
    fn cancel(&self, id: u64) {
        if let Ok(requests) = self.0.lock() {
            if let Some(cancelled) = requests.get(&id) {
                cancelled.store(true, Ordering::Release);
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(requests) = self.0.lock() {
            for cancelled in requests.values() {
                cancelled.store(true, Ordering::Release);
            }
        }
    }
}
impl Ticket {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn publish<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let _guard = self.requests.0.lock().ok()?;
        if self.cancelled() {
            None
        } else {
            Some(publish())
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.0.lock() {
            requests.remove(&self.id);
        }
    }
}
fn provider_scopes(
    args: &LocalSearchArgs,
    roots: &[PathBuf],
    hidden: &[PathBuf],
    mapped: &Path,
) -> Vec<(PathBuf, bool)> {
    let folder = args.folder.as_deref().map(Path::new);
    let mut scopes = Vec::new();
    for root in roots {
        let (scope, recursive) = match (args.scope.as_str(), folder) {
            ("folder", Some(folder)) if folder.starts_with(root) => (folder, args.recursive),
            ("folder", Some(folder)) if args.recursive && root.starts_with(folder) => (root.as_path(), true),
            ("folder", _) => continue,
            _ => (root.as_path(), true),
        };
        let scope = if scope.starts_with(mapped) {
            scope
        } else if recursive && mapped.starts_with(scope) {
            mapped
        } else {
            continue;
        };
        if !hidden.iter().any(|path| scope.starts_with(path)) {
            scopes.push((scope.to_path_buf(), recursive));
        }
    }
    scopes.sort();
    let mut distinct: Vec<(PathBuf, bool)> = Vec::new();
    for (scope, recursive) in scopes {
        if !distinct.iter().any(|(parent, all)| scope == *parent || (*all && scope.starts_with(parent))) {
            distinct.push((scope, recursive));
        }
    }
    distinct
}

#[tauri::command]
#[specta::specta]
pub async fn local_search(
    app: AppHandle,
    state: State<'_, AppState>,
    args: LocalSearchArgs,
    request_id: u64,
) -> Result<LocalPage, String> {
    args.validate()?;
    let cache = state
        .search_cache
        .clone()
        .ok_or("Local metadata cache is unavailable")?;
    let ticket = state.local_search_requests.begin(request_id)?;
    let models = state.clip_models.clone();
    let engine = state.tagged.clone();
    let runtime = state.runtime.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    if !state
        .analysis_queue
        .submit_foreground(format!("local-search:{request_id}"), move |job| {
            let cancelled = || job.cancelled() || ticket.cancelled();
            let result = (|| {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let config = crate::settings::read_key(&runtime, "immage.library")
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .unwrap_or_default();
                let paths = |key: &str| {
                    config[key]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str())
                        .map(PathBuf::from)
                        .collect::<Vec<_>>()
                };
                let roots = paths("folders");
                let hidden = paths("hidden");
                let config = crate::morf_photo::load(&runtime);
                let remote = &args.remote;
                let supports_remote = remote.taken_from.is_none() && remote.taken_to.is_none()
                    && remote.min_rating.is_none() && !remote.favorites && !remote.raw_only
                    && remote.make.is_none() && remote.model.is_none() && remote.lens.is_none()
                    && remote.country.is_none() && remote.city.is_none()
                    && remote.person_ids.is_empty() && remote.tag_ids.is_empty() && remote.album_ids.is_empty();
                if args.mode == "smart" && args.scope == "folder" && args.image_variant.is_none()
                    && args.filters.edited != "edited" && !args.text.trim().is_empty()
                    && supports_remote
                {
                    if let Some(folder) = args.folder.as_deref().map(std::path::Path::new) {
                        if config.covers(folder) && roots.iter().any(|root| folder.starts_with(root))
                            && !hidden.iter().any(|root| folder.starts_with(root)
                                || (args.recursive && root.starts_with(folder)))
                        {
                            match config.semantic(folder, &args) {
                                Ok((mut page, indexed, eligible)) if !cancelled() => {
                                    if indexed < eligible {
                                        let _ = app.emit("morfphoto-coverage",
                                            serde_json::json!({ "indexed": indexed, "eligible": eligible }));
                                    }
                                    for hit in &mut page.items {
                                        hit.image.imgid = engine.cached_photo(&hit.image.path, 0);
                                    }
                                    return Ok(page);
                                }
                                _ if cancelled() => return Err("Search cancelled".into()),
                                _ if args.next.as_deref().is_some_and(|c| c.starts_with("morfphoto:")) =>
                                    return Err("morfPhoto semantic search unavailable".into()),
                                _ => {
                                    let _ = app.emit("morfphoto-fallback", folder.to_string_lossy().as_ref());
                                }
                            }
                        }
                    }
                }
                let vector = if args.mode == "smart" && !args.text.trim().is_empty() {
                    Some(crate::clip_infer::text(
                        &models, &engine, &runtime, &args.text,
                    )?)
                } else {
                    None
                };
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let mut provider = ProviderMetadata::default();
                if let Some(mapped) = config.mapped_root() {
                    for (scope, recursive) in provider_scopes(&args, &roots, &hidden, &mapped) {
                        if !config.covers(&scope) {
                            continue;
                        }
                        let result = config.list_cached(Some(&runtime), &scope, recursive, cancelled);
                        if cancelled() {
                            return Err("Search cancelled".into());
                        }
                        match result {
                            Ok((images, cache_write)) => {
                                provider.add(scope, recursive, images);
                                if let Some(write) = cache_write {
                                    tauri::async_runtime::spawn_blocking(move || write.persist());
                                }
                            }
                            Err(_) => {
                                let _ = app.emit("morfphoto-fallback", scope.to_string_lossy().as_ref());
                            }
                        }
                    }
                }
                let mut page = local_search::retrieve_with_provider(
                    &cache, &args, &roots, &hidden, vector, &provider, cancelled,
                )?;
                for hit in &mut page.items {
                    hit.image.imgid =
                        engine.cached_photo(&hit.image.path, i64::from(hit.image.version));
                }
                Ok(page)
            })();
            let _ = job.commit(|| ticket.publish(|| send.send(result)));
        })
    {
        return Err("Background queue is full; retry local search shortly".into());
    }
    receive.await.map_err(|_| "Search cancelled".to_string())?
}
#[tauri::command]
#[specta::specta]
pub fn local_search_cancel(state: State<'_, AppState>, request_id: u64) {
    state.local_search_requests.cancel(request_id);
}
/// Resolve the clicked file version to a cache identity, never an engine ID.
#[tauri::command]
#[specta::specta]
pub async fn local_search_seed(state: State<'_, AppState>, path: String, version: u32) -> Result<Option<String>, String> {
    let Some(cache) = state.search_cache.clone() else { return Ok(None); };
    tauri::async_runtime::spawn_blocking(move || seed(&cache, &path, version)).await.map_err(|e| e.to_string())?
}
fn seed(cache: &crate::search_cache::SearchCache, path: &str, version: u32) -> Result<Option<String>, String> {
    let key = if version == 0 { String::new() } else { format!("version:{version}") };
    Ok(cache.path_variants(path)?.into_iter().find(|v| v.copy_key == key).map(|v| v.id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_scopes_intersect_roots_folders_and_recursion() {
        let path = Path::new("/library/share");
        let roots = vec![PathBuf::from("/library"), path.join("overlap"), path.with_file_name("share-other")];
        let mut args = LocalSearchArgs::default();
        assert_eq!(provider_scopes(&args, &roots, &[], path), vec![(path.to_path_buf(), true)]);
        args.scope = "folder".into();
        args.folder = Some("/library".into());
        assert!(provider_scopes(&args, &roots, &[], path).is_empty());
        args.recursive = true;
        assert_eq!(provider_scopes(&args, &roots, &[], path), vec![(path.to_path_buf(), true)]);
        assert!(provider_scopes(&args, &roots, &[path.to_path_buf()], path).is_empty());
        args.folder = Some("/library/share/a".into());
        args.recursive = false;
        assert_eq!(provider_scopes(&args, &roots, &[], path), vec![(path.join("a"), false)]);
    }

    #[test]
    fn cancellation_retains_admission_until_work_exits_and_blocks_late_publication() {
        let requests = Arc::new(Requests::default());
        let mut tickets = Vec::new();
        for id in 1..=4 {
            tickets.push(requests.begin(id).unwrap());
        }
        assert!(requests.begin(1).is_err());
        assert!(requests.begin(5).is_err());
        requests.cancel(1);
        assert!(tickets[0].cancelled());
        assert!(tickets[0].publish(|| panic!("late publish")).is_none());
        assert!(requests.begin(5).is_err());
        tickets.remove(0);
        let next = requests.begin(5).unwrap();
        assert_eq!(next.publish(|| 42), Some(42));
        requests.cancel_all();
        assert!(next.cancelled());
    }
}

#[cfg(test)]
mod seed_tests {
    use super::*;
    #[test]
    fn clicked_version_resolves_its_own_cache_identity() {
        let dir = tempfile::tempdir().unwrap();
        let cache = crate::search_cache::SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let a = cache.upsert_variant("/photos/a.jpg", "", "source", "edit", None, None, None).unwrap();
        let b = cache.upsert_variant("/photos/a.jpg", "version:2", "source", "copy", None, None, None).unwrap();
        assert_eq!(seed(&cache, "/photos/a.jpg", 0).unwrap(), Some(a.id.to_string()));
        assert_eq!(seed(&cache, "/photos/a.jpg", 2).unwrap(), Some(b.id.to_string()));
        assert_eq!(seed(&cache, "/photos/a.jpg", 1).unwrap(), None);
        assert_eq!(seed(&cache, "/photos/missing.jpg", 0).unwrap(), None);
    }
}
