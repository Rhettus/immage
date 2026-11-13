// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::cache::Caches;
use serde_json::{Map, Value};
use crate::typed_app::{Album, Named, Resolved, SearchPage};
use tauri::{ipc::Response, AppHandle, Manager, State};
use crate::immich_upload;
use crate::immich_search;
use crate::bindings;

// the Immich side of exporting: run off the async runtime, as the client
// blocks
async fn immich_call<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&immich_upload::Immich) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let conn = tauri_plugin_immporter::immich_connection(app)
        .ok_or("Immich is not set up: add its URL and API key in Preferences")?;
    tauri::async_runtime::spawn_blocking(move || f(&immich_upload::Immich::new(&conn)?))
        .await
        .map_err(|e| e.to_string())?
}

// the albums to export to, by name
#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_albums(app: AppHandle) -> Result<Vec<Album>, String> {
    immich_call(&app, |c| c.albums()).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_create_album(app: AppHandle, name: String) -> Result<Album, String> {
    immich_call(&app, move |c| c.create_album(name.trim())).await
}

// the permissions an export needs that the key lacks
#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_export_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.missing_permissions()).await
}

// the Library panel's Immich card (immich_search.rs)
// the permissions its search, thumbnails and downloads need that the key lacks
#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_browse_check(app: AppHandle) -> Result<Vec<String>, String> {
    immich_call(&app, |c| c.lacks(immich_upload::BROWSE_PERMISSIONS)).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_search(app: AppHandle, args: immich_search::SearchArgs, map: Option<immich_search::PathMap>)
    -> Result<SearchPage, String> {
    immich_call(&app, move |c| c.search(&args, &map.unwrap_or_default())).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_libraries(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.libraries()).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_suggestions(app: AppHandle, kind: String, within: Option<Map<String, Value>>) -> Result<Vec<String>, String> {
    immich_call(&app, move |c| c.suggestions(&kind, &within.unwrap_or_default())).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_people(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.people()).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_tags(app: AppHandle) -> Result<Vec<Named>, String> {
    immich_call(&app, |c| c.tags()).await
}

// Immich's thumbnail as its encoded image (WebP or JPEG); asking again
// does not go to the server while the cache keeps it
#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_thumb(app: AppHandle, caches: State<'_, Caches>, id: String) -> Result<bindings::Frame, String> {
    immich_search::safe_id(&id)?;
    let cache = caches.immich_thumbs.clone();
    let name = id.clone();
    let hit = tauri::async_runtime::spawn_blocking(move || cache.read(&name)).await.map_err(|e| e.to_string())?;
    if let Some(b) = hit {
        return Ok(bindings::Frame(Response::new(b)));
    }
    let cache = caches.immich_thumbs.clone();
    immich_call(&app, move |c| {
        let bytes = c.thumb(&id)?;
        let _ = cache.write(&id, &bytes);
        Ok(bytes)
    }).await.map(|b| bindings::Frame(Response::new(b)))
}

// a file to open for an Immich asset: the external library's own file when
// this computer has it, else the original downloaded into the cache
#[tauri::command]
#[specta::specta]
pub(crate) async fn immich_resolve(app: AppHandle, id: String, name: String, path: String,
                        map: Option<immich_search::PathMap>) -> Result<Resolved, String> {
    if let Some(p) = immich_search::local_path(&path, &map.unwrap_or_default()) {
        return Ok(Resolved { path: p.to_string_lossy().into_owned(), downloaded: false });
    }
    let cache = app.state::<Caches>().immich_originals.clone();
    let p = immich_call(&app, move |c| {
        let (p, fresh) = c.original(&id, &name, cache.dir())?;
        if fresh { cache.added(&id) } else { cache.touch(&id) }
        Ok(p)
    }).await?;
    Ok(Resolved { path: p.to_string_lossy().into_owned(), downloaded: true })
}

