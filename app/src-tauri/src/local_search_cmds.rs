// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
use crate::{
    clip_providers::{self, ActiveProviders, ClipProvider, ImmichCoverage},
    immich_upload::Immich,
    local_search::{self, LocalHit, LocalPage, LocalSearchArgs, ProviderMetadata, INDEX_CHANGED},
    morf_photo, AppState,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

const IMMICH_SMART_TIMEOUT: Duration = Duration::from_secs(22);

#[derive(Default)]
pub struct Requests(Mutex<HashMap<u64, Arc<AtomicBool>>>);
pub(crate) struct Ticket {
    id: u64,
    requests: Arc<Requests>,
    cancelled: Arc<AtomicBool>,
}
impl Requests {
    pub(crate) fn begin(self: &Arc<Self>, id: u64) -> Result<Ticket, String> {
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
    pub(crate) fn cancelled(&self) -> bool {
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

pub(crate) fn provider_scopes(
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
            ("folder", Some(folder)) if args.recursive && root.starts_with(folder) => {
                (root.as_path(), true)
            }
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
        if !distinct
            .iter()
            .any(|(parent, all)| scope == *parent || (*all && scope.starts_with(parent)))
        {
            distinct.push((scope, recursive));
        }
    }
    distinct
}

fn supports_morfphoto_filters(args: &LocalSearchArgs) -> bool {
    let remote = &args.remote;
    args.filters.edited != "edited"
        && remote.taken_from.is_none()
        && remote.taken_to.is_none()
        && remote.min_rating.is_none()
        && !remote.favorites
        && !remote.raw_only
        && remote.make.is_none()
        && remote.model.is_none()
        && remote.lens.is_none()
        && remote.country.is_none()
        && remote.city.is_none()
        && remote.person_ids.is_empty()
        && remote.tag_ids.is_empty()
        && remote.album_ids.is_empty()
}

fn emit_morfphoto_semantic_fallback(app: &AppHandle, reason: &str, fallback: &str) {
    let _ = app.emit(
        "morfphoto-semantic-fallback",
        serde_json::json!({ "reason": reason, "fallback": fallback }),
    );
}

fn emit_immich_semantic_fallback(app: &AppHandle, reason: &str) {
    let _ = app.emit(
        "immich-semantic-fallback",
        serde_json::json!({ "reason": reason }),
    );
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MultiCursor {
    sig: String,
    morfphoto: Vec<(String, Option<String>)>,
    immich: Vec<(String, Option<String>)>,
    local: Option<String>,
}

fn multi_signature(
    args: &LocalSearchArgs,
    roots: &[PathBuf],
    hidden: &[PathBuf],
) -> Result<String, String> {
    let mut params = serde_json::to_value(args).map_err(|e| e.to_string())?;
    if let Some(obj) = params.as_object_mut() {
        obj.remove("next");
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&(params, roots, hidden)).map_err(|e| e.to_string())?);
    Ok(format!("{:x}", hasher.finalize()))
}

/// Fuse ordered hit lists across providers using Reciprocal Rank Fusion
/// (`1 / (60 + rank)`). Lists must be passed in precedence order
/// (`morfPhoto`, `Immich`, `local`) so higher-precedence hit metadata wins on
/// duplicate `(path, version)` keys.
fn fuse_rrf(lists: Vec<Vec<LocalHit>>) -> Vec<LocalHit> {
    const K: f64 = 60.0;
    let mut entries: Vec<(f64, LocalHit)> = Vec::new();
    let mut index_by_key: HashMap<(String, u32), usize> = HashMap::new();
    for list in lists {
        let mut seen_in_list: HashSet<(String, u32)> = HashSet::new();
        for (rank, hit) in list.into_iter().enumerate() {
            let key = (hit.image.path.clone(), hit.image.version);
            if !seen_in_list.insert(key.clone()) {
                continue;
            }
            let add = 1.0 / (K + (rank + 1) as f64);
            if let Some(&idx) = index_by_key.get(&key) {
                entries[idx].0 += add;
            } else {
                let idx = entries.len();
                index_by_key.insert(key, idx);
                entries.push((add, hit));
            }
        }
    }
    entries.sort_by(|(sa, ha), (sb, hb)| {
        sb.total_cmp(sa)
            .then_with(|| ha.image.path.cmp(&hb.image.path))
            .then_with(|| ha.image.version.cmp(&hb.image.version))
    });
    entries
        .into_iter()
        .map(|(score, mut hit)| {
            hit.score = score;
            hit
        })
        .collect()
}

fn immich_client_for(
    app: &AppHandle,
    runtime: &Path,
    providers: &ActiveProviders,
    allow_fallback_map: bool,
) -> Option<(Immich, ImmichCoverage)> {
    let conn = tauri_plugin_immporter::immich_connection(app)?;
    let cov = providers.immich.clone().or_else(|| {
        if !allow_fallback_map {
            return None;
        }
        let map = clip_providers::effective_immich_path_map(app, runtime);
        let local_root = PathBuf::from(map.local.trim());
        if map.immich.trim().is_empty() || !local_root.is_absolute() {
            return None;
        }
        let canonical_root = crate::volumes::answering(&local_root)
            .then(|| std::fs::canonicalize(&local_root).ok())
            .flatten()
            .filter(|c| c != &local_root);
        Some(ImmichCoverage {
            local_root,
            canonical_root,
            server_root: map.immich.trim().to_string(),
        })
    })?;
    let client = Immich::new_with_timeout(&conn, IMMICH_SMART_TIMEOUT).ok()?;
    Some((client, cov))
}

#[allow(clippy::too_many_arguments)]
fn run_local_query(
    app: &AppHandle,
    cache: &crate::search_cache::SearchCache,
    models: &crate::clip_models::Models,
    engine: &crate::engine::Tagged,
    runtime: &Path,
    morf_config: &morf_photo::Config,
    args: &LocalSearchArgs,
    roots: &[PathBuf],
    hidden: &[PathBuf],
    excluded_vector_scopes: Vec<PathBuf>,
    cancelled: &(impl Fn() -> bool + Sync),
) -> Result<LocalPage, String> {
    let vector = if args.mode == "smart" && !args.text.trim().is_empty() {
        Some(crate::clip_infer::text(models, engine, runtime, &args.text)?)
    } else {
        None
    };
    if cancelled() {
        return Err("Search cancelled".into());
    }
    let mut provider = ProviderMetadata::default();
    if !excluded_vector_scopes.is_empty() {
        provider.exclude_vector_scopes(excluded_vector_scopes);
    }
    if let Some(mapped) = morf_config.mapped_root() {
        // A metadata query reads a complete local copy of the catalog by SQL, so
        // only the matching rows are loaded; a semantic query needs its images by
        // path and lists each folder as before.
        let metadata_only = vector.is_none() && args.image_variant.is_none();
        let sql = metadata_only && crate::mirror_query::Source::ready(runtime, morf_config);
        let mut from_copy = Vec::new();
        for (scope, recursive) in provider_scopes(args, roots, hidden, &mapped) {
            if !morf_config.covers(&scope) {
                continue;
            }
            if sql {
                from_copy.push((scope, recursive));
                continue;
            }
            let result = morf_config.list_cached(Some(runtime), &scope, recursive, cancelled);
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
                Err(reason) => {
                    eprintln!("morfPhoto catalog listing failed: {reason}");
                    let _ = app.emit("morfphoto-fallback", scope.to_string_lossy().as_ref());
                }
            }
        }
        if !from_copy.is_empty() {
            provider.add_mirror(crate::mirror_query::Source {
                runtime: runtime.to_owned(),
                config: morf_config.clone(),
                scopes: from_copy,
            });
            // the copy may be behind the server: ask for a sync, which never
            // blocks this search
            app.state::<AppState>().mirror.kick();
        }
    }
    let mut page =
        local_search::retrieve_with_provider(cache, args, roots, hidden, vector, &provider, cancelled)?;
    for hit in &mut page.items {
        hit.image.imgid = engine.cached_photo(&hit.image.path, i64::from(hit.image.version));
    }
    Ok(page)
}

#[allow(clippy::too_many_arguments)]
fn run_library_smart_search(
    app: &AppHandle,
    cache: &crate::search_cache::SearchCache,
    models: &crate::clip_models::Models,
    engine: &crate::engine::Tagged,
    clip_providers: &clip_providers::ProbeCache,
    runtime: &Path,
    morf_config: &morf_photo::Config,
    providers: &ActiveProviders,
    args: &LocalSearchArgs,
    roots: &[PathBuf],
    hidden: &[PathBuf],
    cancelled: &(impl Fn() -> bool + Sync),
) -> Result<LocalPage, String> {
    let sig = multi_signature(args, roots, hidden)?;
    let parsed_multi: Option<MultiCursor> = if let Some(next) = args.next.as_deref() {
        if let Some(raw) = next.strip_prefix("multi:") {
            let cursor: MultiCursor =
                serde_json::from_str(raw).map_err(|_| "Invalid multi-provider search cursor")?;
            if cursor.sig != sig {
                return Err(format!(
                    "{INDEX_CHANGED}: search parameters changed; restart the search"
                ));
            }
            Some(cursor)
        } else {
            None
        }
    } else {
        None
    };

    // Native single-provider pagination cursors bypass planning and go straight to their owner.
    if let Some(next) = args.next.as_deref() {
        if next.starts_with("morfphoto:") {
            let plan = clip_providers::plan_library_scopes(roots, hidden, providers, args.immich_searched);
            let scope = plan
                .morfphoto
                .first()
                .ok_or("morfPhoto scope is no longer available")?;
            let mut scope_args = args.clone();
            scope_args.scope = "folder".into();
            scope_args.folder = Some(scope.to_string_lossy().into_owned());
            scope_args.recursive = true;
            let (mut page, indexed, eligible) = morf_config.semantic(scope, &scope_args)?;
            if cancelled() {
                return Err("Search cancelled".into());
            }
            if indexed < eligible {
                let _ = app.emit(
                    "morfphoto-coverage",
                    serde_json::json!({ "indexed": indexed, "eligible": eligible }),
                );
            }
            for hit in &mut page.items {
                hit.image.imgid = engine.cached_photo(&hit.image.path, 0);
            }
            return Ok(page);
        }
        if next.starts_with("immich:") {
            let plan = clip_providers::plan_library_scopes(roots, hidden, providers, false);
            let (scope, excluded) = plan
                .immich
                .first()
                .ok_or("Immich scope is no longer available")?;
            let (client, cov) = immich_client_for(app, runtime, providers, true)
                .ok_or("Immich is unavailable")?;
            let mut page = client.smart_in_folder(
                scope,
                true,
                hidden,
                excluded,
                &cov.path_map(),
                cov.canonical_root.as_deref(),
                args,
                cache,
                cancelled,
            )?;
            if cancelled() {
                return Err("Search cancelled".into());
            }
            for hit in &mut page.items {
                hit.image.imgid =
                    engine.cached_photo(&hit.image.path, i64::from(hit.image.version));
            }
            return Ok(page);
        }
    }

    // Build scope plan respecting morfPhoto -> Immich -> local precedence.
    let edited_only = args.filters.edited == "edited";
    let effective_providers = if edited_only {
        ActiveProviders::default()
    } else if !supports_morfphoto_filters(args) {
        ActiveProviders {
            morfphoto_root: None,
            immich: providers.immich.clone(),
        }
    } else {
        providers.clone()
    };

    let plan = clip_providers::plan_library_scopes(
        roots,
        hidden,
        &effective_providers,
        args.immich_searched,
    );

    // If neither morfPhoto nor Immich covers any root (and no multi-cursor), use pure local path.
    if parsed_multi.is_none() && plan.morfphoto.is_empty() && plan.immich.is_empty() {
        return run_local_query(
            app,
            cache,
            models,
            engine,
            runtime,
            morf_config,
            args,
            roots,
            hidden,
            plan.local_excluded,
            cancelled,
        );
    }

    // Build per-scope worklists. On subsequent "multi:" pages, only fetch scopes
    // that still carry a `Some(cursor)`.
    let mut morf_jobs: Vec<(PathBuf, Option<String>)> = match &parsed_multi {
        Some(c) => c
            .morfphoto
            .iter()
            .filter_map(|(p, cur)| cur.as_ref().map(|cur| (PathBuf::from(p), Some(cur.clone()))))
            .collect(),
        None => plan.morfphoto.iter().map(|p| (p.clone(), None)).collect(),
    };
    let mut immich_jobs: Vec<(PathBuf, Vec<PathBuf>, Option<String>)> = match &parsed_multi {
        Some(c) => c
            .immich
            .iter()
            .filter_map(|(p, cur)| {
                cur.as_ref().map(|cur| {
                    let pb = PathBuf::from(p);
                    let ex = plan
                        .immich
                        .iter()
                        .find(|(s, _)| s == &pb)
                        .map(|(_, e)| e.clone())
                        .unwrap_or_default();
                    (pb, ex, Some(cur.clone()))
                })
            })
            .collect(),
        None => plan
            .immich
            .iter()
            .map(|(p, ex)| (p.clone(), ex.clone(), None))
            .collect(),
    };
    let mut local_cursor: Option<String> = parsed_multi.as_ref().and_then(|c| c.local.clone());
    let mut run_local = match &parsed_multi {
        Some(c) => c.local.is_some(),
        None => plan.has_local_scope,
    };
    let mut local_excluded = plan.local_excluded.clone();

    let total_sources = morf_jobs.len() + immich_jobs.len() + usize::from(run_local);
    let single_source_first_page = parsed_multi.is_none() && total_sources == 1;
    let per_source_size = if total_sources <= 1 {
        args.size
    } else {
        (args.size / total_sources as u32).max(1)
    };

    let mut hit_lists: Vec<Vec<LocalHit>> = Vec::new();
    let mut next_morf: Vec<(String, Option<String>)> = Vec::new();
    let mut next_immich: Vec<(String, Option<String>)> = Vec::new();
    let mut next_local: Option<String> = None;
    let mut any_remote_succeeded = false;

    // 1. morfPhoto scopes
    for (scope, cursor) in morf_jobs.drain(..) {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        let mut scope_args = args.clone();
        scope_args.scope = "folder".into();
        scope_args.folder = Some(scope.to_string_lossy().into_owned());
        scope_args.recursive = true;
        scope_args.size = per_source_size;
        scope_args.next = cursor;
        match morf_config.semantic(&scope, &scope_args) {
            Ok((mut page, indexed, eligible)) if !cancelled() => {
                if indexed < eligible {
                    let _ = app.emit(
                        "morfphoto-coverage",
                        serde_json::json!({ "indexed": indexed, "eligible": eligible }),
                    );
                }
                for hit in &mut page.items {
                    hit.image.imgid = engine.cached_photo(&hit.image.path, 0);
                }
                if single_source_first_page {
                    return Ok(page);
                }
                any_remote_succeeded = true;
                next_morf.push((scope.to_string_lossy().into_owned(), page.next));
                hit_lists.push(page.items);
            }
            Ok(_) => return Err("Search cancelled".into()),
            Err(reason) => {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                clip_providers.record_morfphoto_failure(runtime);
                let immich_covers = !args.immich_searched
                    && effective_providers
                        .immich
                        .as_ref()
                        .is_some_and(|cov| cov.covers(&scope));
                emit_morfphoto_semantic_fallback(
                    app,
                    &reason,
                    if immich_covers { "immich" } else { "local" },
                );
                if parsed_multi.is_none() {
                    if immich_covers {
                        // Fall through this scope to Immich: either lift its exclusion
                        // from an existing parent Immich scope or add a new Immich scope.
                        let mut lifted = false;
                        for (im_scope, ex, _) in &mut immich_jobs {
                            if clip_providers::path_within(&scope, im_scope) {
                                ex.retain(|e| e != &scope);
                                lifted = true;
                            }
                        }
                        if !lifted {
                            immich_jobs.push((scope, Vec::new(), None));
                        }
                    } else {
                        // Fall through this scope to local CLIP.
                        local_excluded.retain(|ex| ex != &scope);
                        run_local =
                            clip_providers::roots_have_uncovered_paths(roots, hidden, &local_excluded);
                    }
                }
            }
        }
    }

    // 2. Immich scopes
    if !immich_jobs.is_empty() {
        let client_and_cov = immich_client_for(app, runtime, &effective_providers, parsed_multi.is_some());
        for (scope, excluded, cursor) in immich_jobs {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            let res = match &client_and_cov {
                Some((client, cov)) => {
                    let mut scope_args = args.clone();
                    scope_args.size = per_source_size;
                    scope_args.next = cursor;
                    client.smart_in_folder(
                        &scope,
                        true,
                        hidden,
                        &excluded,
                        &cov.path_map(),
                        cov.canonical_root.as_deref(),
                        &scope_args,
                        cache,
                        cancelled,
                    )
                }
                None => Err("Immich is unavailable".into()),
            };
            match res {
                Ok(mut page) if !cancelled() => {
                    for hit in &mut page.items {
                        hit.image.imgid =
                            engine.cached_photo(&hit.image.path, i64::from(hit.image.version));
                    }
                    if single_source_first_page && hit_lists.is_empty() && !run_local {
                        return Ok(page);
                    }
                    any_remote_succeeded = true;
                    next_immich.push((scope.to_string_lossy().into_owned(), page.next));
                    hit_lists.push(page.items);
                }
                Ok(_) => return Err("Search cancelled".into()),
                Err(reason) => {
                    if cancelled() {
                        return Err("Search cancelled".into());
                    }
                    clip_providers.record_immich_failure(app, runtime);
                    emit_immich_semantic_fallback(app, &reason);
                    if parsed_multi.is_none() {
                        local_excluded.retain(|ex| ex != &scope);
                        run_local =
                            clip_providers::roots_have_uncovered_paths(roots, hidden, &local_excluded);
                    }
                }
            }
        }
    }

    // 3. Local CLIP for remaining uncovered scopes
    if run_local {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        let mut local_args = args.clone();
        local_args.size = if hit_lists.is_empty() && parsed_multi.is_none() {
            args.size
        } else {
            per_source_size
        };
        local_args.next = local_cursor.take();
        match run_local_query(
            app,
            cache,
            models,
            engine,
            runtime,
            morf_config,
            &local_args,
            roots,
            hidden,
            local_excluded,
            cancelled,
        ) {
            Ok(page) => {
                if hit_lists.is_empty() && parsed_multi.is_none() {
                    return Ok(page);
                }
                next_local = page.next;
                hit_lists.push(page.items);
            }
            Err(err) if any_remote_succeeded && !cancelled() && !models.installed() => {
                // Remote providers already produced results; do not fail the whole
                // library search merely because the optional local CLIP model is absent.
                eprintln!("local CLIP skipped for remaining library scopes: {err}");
            }
            Err(err) => return Err(err),
        }
    }

    let items = fuse_rrf(hit_lists);
    let has_more = next_morf.iter().any(|(_, c)| c.is_some())
        || next_immich.iter().any(|(_, c)| c.is_some())
        || next_local.is_some();
    let next = if has_more {
        let encoded = serde_json::to_string(&MultiCursor {
            sig,
            morfphoto: next_morf,
            immich: next_immich,
            local: next_local,
        })
        .map_err(|e| e.to_string())?;
        Some(format!("multi:{encoded}"))
    } else {
        None
    };

    Ok(LocalPage {
        items,
        next,
        revision: "multi".into(),
    })
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
    let clip_providers = state.clip_providers.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    if !state
        .analysis_queue
        .submit_foreground(format!("local-search:{request_id}"), move |job| {
            let cancelled = || job.cancelled() || ticket.cancelled();
            let result = (|| {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let (roots, hidden) = clip_providers::library_roots(&runtime);
                let morf_config = morf_photo::load(&runtime);
                let is_smart_text = args.mode == "smart"
                    && args.image_variant.is_none()
                    && !args.text.trim().is_empty();

                if is_smart_text {
                    let providers = clip_providers.resolve(&app, &runtime);
                    if cancelled() {
                        return Err("Search cancelled".into());
                    }

                    if args.scope == "folder" {
                        if let Some(folder) = args.folder.as_deref().map(Path::new) {
                            let in_roots = roots.iter().any(|root| folder.starts_with(root));
                            let in_hidden = hidden.iter().any(|root| folder.starts_with(root));
                            if in_roots && !in_hidden {
                                // 1. morfPhoto (highest precedence)
                                let morf_cursor = args
                                    .next
                                    .as_deref()
                                    .is_some_and(|c| c.starts_with("morfphoto:"));
                                let try_morf = supports_morfphoto_filters(&args)
                                    && morf_config.covers(folder)
                                    && !hidden.iter().any(|root| {
                                        folder.starts_with(root)
                                            || (args.recursive && root.starts_with(folder))
                                    })
                                    && (morf_cursor
                                        || providers.for_path(folder) == ClipProvider::MorfPhoto);
                                if try_morf {
                                    match morf_config.semantic(folder, &args) {
                                        Ok((mut page, indexed, eligible)) if !cancelled() => {
                                            if indexed < eligible {
                                                let _ = app.emit(
                                                    "morfphoto-coverage",
                                                    serde_json::json!({
                                                        "indexed": indexed,
                                                        "eligible": eligible
                                                    }),
                                                );
                                            }
                                            for hit in &mut page.items {
                                                hit.image.imgid =
                                                    engine.cached_photo(&hit.image.path, 0);
                                            }
                                            return Ok(page);
                                        }
                                        Ok(_) => return Err("Search cancelled".into()),
                                        Err(reason) => {
                                            if cancelled() {
                                                return Err("Search cancelled".into());
                                            }
                                            clip_providers.record_morfphoto_failure(&runtime);
                                            if morf_cursor {
                                                return Err(reason);
                                            }
                                            let next_fallback = if !args.immich_searched
                                                && args.filters.edited != "edited"
                                                && providers
                                                    .immich
                                                    .as_ref()
                                                    .is_some_and(|cov| cov.covers(folder))
                                            {
                                                "immich"
                                            } else {
                                                "local"
                                            };
                                            emit_morfphoto_semantic_fallback(
                                                &app,
                                                &reason,
                                                next_fallback,
                                            );
                                        }
                                    }
                                }

                                // 2. Immich (second precedence)
                                let immich_cursor = args
                                    .next
                                    .as_deref()
                                    .is_some_and(|c| c.starts_with("immich:"));
                                let try_immich = !args.immich_searched
                                    && args.filters.edited != "edited"
                                    && (immich_cursor
                                        || providers
                                            .immich
                                            .as_ref()
                                            .is_some_and(|cov| cov.covers(folder)));
                                if try_immich {
                                    let res = match immich_client_for(
                                        &app,
                                        &runtime,
                                        &providers,
                                        immich_cursor,
                                    ) {
                                        Some((client, cov)) => client.smart_in_folder(
                                            folder,
                                            args.recursive,
                                            &hidden,
                                            &[],
                                            &cov.path_map(),
                                            cov.canonical_root.as_deref(),
                                            &args,
                                            &cache,
                                            cancelled,
                                        ),
                                        None => Err("Immich is unavailable".into()),
                                    };
                                    match res {
                                        Ok(mut page) if !cancelled() => {
                                            for hit in &mut page.items {
                                                hit.image.imgid = engine.cached_photo(
                                                    &hit.image.path,
                                                    i64::from(hit.image.version),
                                                );
                                            }
                                            return Ok(page);
                                        }
                                        Ok(_) => return Err("Search cancelled".into()),
                                        Err(reason) => {
                                            if cancelled() {
                                                return Err("Search cancelled".into());
                                            }
                                            clip_providers.record_immich_failure(&app, &runtime);
                                            if immich_cursor {
                                                return Err(reason);
                                            }
                                            emit_immich_semantic_fallback(&app, &reason);
                                        }
                                    }
                                }
                            }
                        }
                    } else if args.scope == "library" {
                        return run_library_smart_search(
                            &app,
                            &cache,
                            &models,
                            &engine,
                            &clip_providers,
                            &runtime,
                            &morf_config,
                            &providers,
                            &args,
                            &roots,
                            &hidden,
                            &cancelled,
                        );
                    }
                }

                // 3. Local CLIP (third precedence) and all metadata/filename/similar queries
                run_local_query(
                    &app,
                    &cache,
                    &models,
                    &engine,
                    &runtime,
                    &morf_config,
                    &args,
                    &roots,
                    &hidden,
                    Vec::new(),
                    &cancelled,
                )
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
pub async fn local_search_seed(
    state: State<'_, AppState>,
    path: String,
    version: u32,
) -> Result<Option<String>, String> {
    let Some(cache) = state.search_cache.clone() else {
        return Ok(None);
    };
    tauri::async_runtime::spawn_blocking(move || seed(&cache, &path, version))
        .await
        .map_err(|e| e.to_string())?
}

fn seed(
    cache: &crate::search_cache::SearchCache,
    path: &str,
    version: u32,
) -> Result<Option<String>, String> {
    let key = if version == 0 {
        String::new()
    } else {
        format!("version:{version}")
    };
    Ok(cache
        .path_variants(path)?
        .into_iter()
        .find(|v| v.copy_key == key)
        .map(|v| v.id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dummy_hit(path: &str, rating: u8) -> LocalHit {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/engine-replies/import.json")).unwrap();
        let mut image = fixtures
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|v| v["reply"]["images"].as_array().into_iter().flatten())
            .next()
            .unwrap()
            .clone();
        image["imgid"] = serde_json::json!(0);
        image["path"] = serde_json::json!(path);
        image["filename"] = serde_json::json!(
            Path::new(path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("a.jpg")
        );
        image["rating"] = serde_json::json!(rating);
        image["version"] = serde_json::json!(0);
        image["copy"] = serde_json::json!(false);
        LocalHit {
            asset_id: None,
            variant_id: None,
            subject: "original".into(),
            score: 0.0,
            image: serde_json::from_value(image).unwrap(),
        }
    }

    #[test]
    fn fuse_rrf_merges_ranks_and_prefers_higher_precedence_provider_metadata() {
        let morf = vec![dummy_hit("/nas/shared.jpg", 5), dummy_hit("/nas/only-morf.jpg", 3)];
        let immich = vec![dummy_hit("/nas/shared.jpg", 1), dummy_hit("/immich/a.jpg", 4)];
        let local = vec![dummy_hit("/local/b.jpg", 2)];

        let merged = fuse_rrf(vec![morf, immich, local]);
        assert_eq!(merged.len(), 4);
        // /nas/shared.jpg appeared at rank 1 in two lists -> highest fused score,
        // and keeps morfPhoto's rating (5) over Immich's (1).
        assert_eq!(merged[0].image.path, "/nas/shared.jpg");
        assert_eq!(merged[0].image.rating, 5);
        // Remaining rank-1 and rank-2 hits are deterministic and deduplicated.
        assert_eq!(merged[1].image.path, "/local/b.jpg");
        assert_eq!(merged[2].image.path, "/immich/a.jpg");
        assert_eq!(merged[3].image.path, "/nas/only-morf.jpg");
    }

    #[test]
    fn provider_scopes_intersect_roots_folders_and_recursion() {
        let path = Path::new("/library/share");
        let roots = vec![
            PathBuf::from("/library"),
            path.join("overlap"),
            path.with_file_name("share-other"),
        ];
        let mut args = LocalSearchArgs::default();
        assert_eq!(
            provider_scopes(&args, &roots, &[], path),
            vec![(path.to_path_buf(), true)]
        );
        args.scope = "folder".into();
        args.folder = Some("/library".into());
        assert!(provider_scopes(&args, &roots, &[], path).is_empty());
        args.recursive = true;
        assert_eq!(
            provider_scopes(&args, &roots, &[], path),
            vec![(path.to_path_buf(), true)]
        );
        assert!(provider_scopes(&args, &roots, &[path.to_path_buf()], path).is_empty());
        args.folder = Some("/library/share/a".into());
        args.recursive = false;
        assert_eq!(
            provider_scopes(&args, &roots, &[], path),
            vec![(path.join("a"), false)]
        );
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
        let cache =
            crate::search_cache::SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let a = cache
            .upsert_variant("/photos/a.jpg", "", "source", "edit", None, None, None)
            .unwrap();
        let b = cache
            .upsert_variant("/photos/a.jpg", "version:2", "source", "copy", None, None, None)
            .unwrap();
        assert_eq!(
            seed(&cache, "/photos/a.jpg", 0).unwrap(),
            Some(a.id.to_string())
        );
        assert_eq!(
            seed(&cache, "/photos/a.jpg", 2).unwrap(),
            Some(b.id.to_string())
        );
        assert_eq!(seed(&cache, "/photos/a.jpg", 1).unwrap(), None);
        assert_eq!(seed(&cache, "/photos/missing.jpg", 0).unwrap(), None);
    }
}
