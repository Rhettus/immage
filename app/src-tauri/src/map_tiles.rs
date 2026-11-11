// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use std::collections::HashMap;
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::time::Duration;
use tauri::Manager;

// one client for every tile, so its connections to the tile server are reused
static CLIENT: LazyLock<Result<reqwest::blocking::Client, String>> = LazyLock::new(|| {
    reqwest::blocking::Client::builder()
        .user_agent(concat!("Immage/", env!("CARGO_PKG_VERSION"), " (https://github.com/Rhettus/immage)"))
        .timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())
});

// a tile asked for twice at once is fetched once: the second waits on the
// first's lock and then finds it cached. entries go once nobody holds them
type Locks = Mutex<HashMap<(u32, u32, u32), Arc<Mutex<()>>>>;
static TILES: LazyLock<Locks> = LazyLock::new(Default::default);

// two downloads at once instead of one, still light on OSM's volunteer
// servers (their tile usage policy asks clients to keep the load low)
const DOWNLOADS: usize = 2;
static ACTIVE: Mutex<usize> = Mutex::new(0);
static FREED: Condvar = Condvar::new();

struct Download;

impl Download {
    fn start() -> Self {
        let mut active = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
        while *active >= DOWNLOADS {
            active = FREED.wait(active).unwrap_or_else(|e| e.into_inner());
        }
        *active += 1;
        Download
    }
}

impl Drop for Download {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        FREED.notify_one();
    }
}

// OSM requires an identifying user agent and at least seven days of caching
// when the client does not interpret the server's cache headers.
#[tauri::command]
pub async fn map_tile(app: tauri::AppHandle, z: u32, x: u32, y: u32) -> Result<tauri::ipc::Response, String> {
    if z > 19 || x >= (1 << z) || y >= (1 << z) {
        return Err("invalid map tile".into());
    }
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("map-tiles");
    tauri::async_runtime::spawn_blocking(move || {
        tile(&cache, z, x, y, &|z, x, y| {
            let client = CLIENT.as_ref().map_err(|e| e.clone())?;
            let response = client.get(format!("https://tile.openstreetmap.org/{z}/{x}/{y}.png"))
                .send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
            response.bytes().map_err(|e| e.to_string()).map(|b| b.to_vec())
        }).map(tauri::ipc::Response::new)
    }).await.map_err(|e| e.to_string())?
}

type Downloader<'a> = &'a dyn Fn(u32, u32, u32) -> Result<Vec<u8>, String>;

fn tile(cache: &std::path::Path, z: u32, x: u32, y: u32, download: Downloader) -> Result<Vec<u8>, String> {
    let key = (z, x, y);
    let lock = TILES.lock().map_err(|e| e.to_string())?.entry(key).or_default().clone();
    let result = {
        let _guard = lock.lock().map_err(|e| e.to_string())?;
        fetch(cache, z, x, y, download)
    };
    let mut tiles = TILES.lock().map_err(|e| e.to_string())?;
    // the map's own reference and this one: no one else waits on it
    if Arc::strong_count(&lock) == 2 {
        tiles.remove(&key);
    }
    result
}

fn fetch(cache: &std::path::Path, z: u32, x: u32, y: u32, download: Downloader) -> Result<Vec<u8>, String> {
    let path = cache.join(format!("{z}-{x}-{y}.png"));
    let fresh = std::fs::metadata(&path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.elapsed().ok()).is_some_and(|age| age < Duration::from_secs(7 * 86400));
    if fresh {
        return std::fs::read(&path).map_err(|e| e.to_string());
    }
    let bytes = {
        let _download = Download::start();
        download(z, x, y)?
    };
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    // written aside and renamed, so a reader never sees half a tile
    let part = cache.join(format!("{z}-{x}-{y}.png.part"));
    std::fs::write(&part, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};

    // the download gate is global, so these tests take turns
    static SERIAL: Mutex<()> = Mutex::new(());

    fn dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("immage-map-tiles-{}-{name}", std::process::id()))
    }

    #[test]
    fn same_tile_fetched_once() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let cache = dir("same");
        let calls = AtomicUsize::new(0);
        let results: Vec<_> = std::thread::scope(|s| {
            let handles: Vec<_> = (0..4).map(|_| s.spawn(|| {
                tile(&cache, 3, 1, 2, &|_, _, _| {
                    calls.fetch_add(1, SeqCst);
                    std::thread::sleep(Duration::from_millis(100));
                    Ok(vec![1, 2, 3])
                })
            })).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(calls.load(SeqCst), 1);
        assert!(results.iter().all(|r| r.as_deref() == Ok(&[1u8, 2, 3][..])));
        assert!(!TILES.lock().unwrap().contains_key(&(3, 1, 2)));
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn at_most_two_downloads() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let cache = dir("gate");
        let live = AtomicUsize::new(0);
        let max = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for i in 0..6 {
                let (cache, live, max) = (&cache, &live, &max);
                s.spawn(move || {
                    tile(cache, 5, i, 0, &|_, _, _| {
                        let now = live.fetch_add(1, SeqCst) + 1;
                        max.fetch_max(now, SeqCst);
                        std::thread::sleep(Duration::from_millis(100));
                        live.fetch_sub(1, SeqCst);
                        Ok(vec![0])
                    }).unwrap();
                });
            }
        });
        assert!(max.load(SeqCst) <= DOWNLOADS);
        assert_eq!(max.load(SeqCst), 2);
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn cached_tile_not_downloaded() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let cache = dir("cached");
        assert_eq!(tile(&cache, 2, 1, 1, &|_, _, _| Ok(vec![9, 8])).unwrap(), vec![9, 8]);
        let again = tile(&cache, 2, 1, 1, &|_, _, _| Err("must not download".into()));
        assert_eq!(again.unwrap(), vec![9, 8]);
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn failed_download_leaves_no_file() {
        let _s = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let cache = dir("failed");
        let result = tile(&cache, 4, 3, 3, &|_, _, _| Err("offline".into()));
        assert_eq!(result, Err("offline".to_string()));
        assert!(!cache.join("4-3-3.png").exists());
        assert!(!cache.join("4-3-3.png.part").exists());
        let _ = std::fs::remove_dir_all(&cache);
    }
}
