// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
use crate::{analysis_queue, clip_models, search_cache, search_reconcile, settings, AppState};
use tauri::{AppHandle, Manager, State};
pub const PAUSED: &str = "immage.analysisPaused";
#[derive(serde::Serialize, specta::Type)]
pub struct SearchStatus {
    pub counts: Option<search_cache::Counts>,
    pub roots: Vec<search_cache::RootStatus>,
    pub queue: analysis_queue::Status,
    pub model: clip_models::ModelStatus,
    /// The CLIP package is on disk (checked off the event loop): photo-content
    /// search works without the Preferences check, which only sets `model.verified`.
    pub model_installed: bool,
}
#[tauri::command]
#[specta::specta]
pub async fn search_status(state: State<'_, AppState>) -> Result<SearchStatus, String> {
    let cache = state.search_cache.clone();
    let queue = state.analysis_queue.status();
    let model = state.clip_models.status();
    let models = state.clip_models.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(SearchStatus {
            model_installed: models.installed(),
            counts: cache.as_ref().map(|c| c.counts()).transpose()?,
            roots: cache
                .as_ref()
                .map(|c| c.roots())
                .transpose()?
                .unwrap_or_default(),
            queue,
            model,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
#[specta::specta]
pub async fn search_pause(
    state: State<'_, AppState>,
    preferences: State<'_, settings::Settings>,
    paused: bool,
) -> Result<(), String> {
    let _control = state
        .search_clear_lock
        .lock()
        .map_err(|_| "Cache control lock poisoned")?;
    preferences.set(PAUSED, if paused { "1" } else { "0" })?;
    state.analysis_queue.pause(paused);
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub async fn search_cache_clear(app: AppHandle, rebuild: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _control = state
            .search_clear_lock
            .lock()
            .map_err(|_| "Cache control lock poisoned")?;
        let cache = state
            .search_cache
            .as_ref()
            .ok_or("Metadata cache is unavailable")?;
        state.analysis_queue.cancel();
        cache.clear()?;
        if rebuild {
            search_reconcile::startup(
                state.search_cache.clone(),
                &state.runtime,
                &state.analysis_queue,
            );
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
