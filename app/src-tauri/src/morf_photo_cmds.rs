// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::morf_photo::{self, Config, Credential, SETTINGS};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MorfPhotoStatus {
    settings: Config,
    has_key: bool,
    has_stored_key: bool,
}

async fn worker<T: Send + 'static>(
    run: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(run)
        .await
        .map_err(|_| "morfPhoto preferences operation failed".to_string())?
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_metrics(
    state: State<'_, crate::AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let runtime = state.runtime.clone();
    worker(move || {
        let config = morf_photo::load(&runtime);
        config.enabled.then(|| config.metrics()).transpose()
    }).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_thumbnail(
    state: State<'_, crate::AppState>,
    caches: State<'_, crate::cache::Caches>,
    path: String,
) -> Result<crate::bindings::Frame, String> {
    let runtime = state.runtime.clone();
    let cache = caches.morfphoto_thumbs.clone();
    let jpeg = worker(move || {
        Ok(morf_photo::load(&runtime)
            .thumbnail_cached(Path::new(&path), &cache)
            .unwrap_or_default())
    })
    .await?;
    Ok(crate::bindings::Frame(tauri::ipc::Response::new(jpeg)))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_status(app: AppHandle) -> Result<MorfPhotoStatus, String> {
    worker(move || {
        let settings = app
            .state::<crate::settings::Settings>()
            .get(SETTINGS)
            .and_then(|raw| serde_json::from_str::<Config>(&raw).ok())
            .unwrap_or_default();
        let credential = morf_photo::entry()
            .and_then(|entry| morf_photo::credential(&entry))
            .ok()
            .flatten();
        let has_stored_key = credential.is_some();
        let has_key = credential
            .zip(settings.origin().ok())
            .is_some_and(|(credential, origin)| credential.origin == origin);
        Ok(MorfPhotoStatus {
            settings,
            has_key,
            has_stored_key,
        })
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_save(
    app: AppHandle,
    settings: Config,
    key: Option<String>,
) -> Result<(), String> {
    let runtime = app.state::<crate::AppState>().runtime.clone();
    worker(move || {
        if settings.enabled {
            settings.validate_mapping()?;
        }
        let previous_settings = morf_photo::load(&runtime);
        let mapping_changed = previous_settings.url.trim() != settings.url.trim()
            || previous_settings.server_path.trim() != settings.server_path.trim()
            || previous_settings.local_path.trim() != settings.local_path.trim();
        let saved = serde_json::to_string(&settings).map_err(|_| "Invalid morfPhoto settings")?;
        let store = app.state::<crate::settings::Settings>();
        if let Some(key) = key {
            let origin = settings.origin()?;
            let key = key.trim().to_string();
            if key.is_empty() || reqwest::header::HeaderValue::from_str(&key).is_err() {
                return Err("Invalid morfPhoto API key".into());
            }
            let entry = morf_photo::entry()?;
            let previous = morf_photo::credential(&entry)?.map(|credential| {
                serde_json::to_string(&credential).expect("credential contains only strings")
            });
            let next = serde_json::to_string(&Credential { origin, key })
                .map_err(|_| "Invalid morfPhoto credential")?;
            entry
                .set_password(&next)
                .map_err(|_| "Could not store morfPhoto API key")?;
            morf_photo::invalidate_credential_cache();
            if let Err(error) = store.set(SETTINGS, &saved) {
                let restored = match previous {
                    Some(previous) => entry.set_password(&previous),
                    None => entry.delete_credential(),
                };
                morf_photo::invalidate_credential_cache();
                if restored.is_err() {
                    return Err(
                        "Could not save morfPhoto settings or restore the previous key".into(),
                    );
                }
                return Err(error);
            }
            if mapping_changed {
                morf_photo::clear_caches(Some(&runtime));
            }
            app.state::<crate::AppState>().clip_providers.invalidate_morfphoto();
            return Ok(());
        }
        if settings.enabled {
            let origin = settings.origin()?;
            let has_key = morf_photo::credential(&morf_photo::entry()?)?
                .is_some_and(|credential| credential.origin == origin);
            if !has_key {
                return Err("morfPhoto API key is required for this server".into());
            }
        }
        store.set(SETTINGS, &saved)?;
        if mapping_changed {
            morf_photo::clear_caches(Some(&runtime));
        }
        app.state::<crate::AppState>().clip_providers.invalidate_morfphoto();
        Ok(())
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_test(settings: Config, key: Option<String>) -> Result<(), String> {
    worker(move || settings.test(key.as_deref())).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn morf_photo_forget(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    caches: State<'_, crate::cache::Caches>,
) -> Result<(), String> {
    let runtime = state.runtime.clone();
    let thumbs = caches.morfphoto_thumbs.clone();
    worker(move || {
        let mut settings = morf_photo::load(&runtime);
        settings.enabled = false;
        let saved = serde_json::to_string(&settings).map_err(|_| "Invalid morfPhoto settings")?;
        app.state::<crate::settings::Settings>()
            .set(SETTINGS, &saved)?;
        morf_photo::clear_caches(Some(&runtime));
        thumbs.clear();
        app.state::<crate::AppState>().clip_providers.invalidate_morfphoto();
        match morf_photo::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove morfPhoto API key".into()),
        }
    })
    .await
}
