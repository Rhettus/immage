// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use std::time::Duration;
use tauri::Manager;

static TILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// OSM requires an identifying user agent and at least seven days of caching
// when the client does not interpret the server's cache headers.
#[tauri::command]
pub async fn map_tile(app: tauri::AppHandle, z: u32, x: u32, y: u32) -> Result<tauri::ipc::Response, String> {
    if z > 19 || x >= (1 << z) || y >= (1 << z) {
        return Err("invalid map tile".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("map-tiles");
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = TILE_LOCK.lock().map_err(|e| e.to_string())?;
        let path = cache.join(format!("{z}-{x}-{y}.png"));
        let fresh = std::fs::metadata(&path).and_then(|m| m.modified()).ok()
            .and_then(|t| t.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(7 * 86400));
        if fresh {
            return std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string());
        }
        let response = reqwest::blocking::Client::builder()
            .user_agent(concat!("Immage/", env!("CARGO_PKG_VERSION"), " (https://github.com/Rhettus/immage)"))
            .timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?
            .get(format!("https://tile.openstreetmap.org/{z}/{x}/{y}.png"))
            .send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        let bytes = response.bytes().map_err(|e| e.to_string())?.to_vec();
        std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(tauri::ipc::Response::new(bytes))
    }).await.map_err(|e| e.to_string())?
}
