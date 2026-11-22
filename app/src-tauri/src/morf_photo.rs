// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::cache::DiskCache;
use crate::typed_library::LibraryImage;
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use reqwest::{
    blocking::Client,
    header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, AUTHORIZATION, CONTENT_ENCODING, CONTENT_TYPE, ETAG, IF_NONE_MATCH},
    StatusCode, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};

pub(crate) const SETTINGS: &str = "native.morfphoto";
const PAGE_SIZE: usize = 500;
const MAX_PAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_INDEX_STATUS_BYTES: u64 = 65536;
const MAX_CATALOG_CACHE_DECOMPRESSED_BYTES: u64 = 128 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const LIST_TIMEOUT: Duration = Duration::from_secs(25);
const SEMANTIC_TIMEOUT: Duration = Duration::from_secs(22);
const THUMBNAIL_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;
const SUBFOLDER_CACHE_CAP: usize = 512;
const CATALOG_CACHE_MAX_FILES: usize = 32;
const CATALOG_CACHE_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CATALOG_CACHE_VERSION: u32 = 1;
const CATALOG_CACHE_DIR: &str = "morfphoto-cache";

static HTTP_CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
static CREDENTIAL_CACHE: Mutex<Option<Credential>> = Mutex::new(None);
static SUBFOLDER_CACHE: OnceLock<Mutex<SubfolderCacheState>> = OnceLock::new();
static CACHE_PART_SEQ: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct SubfolderCacheState {
    seq: u64,
    entries: HashMap<SubfolderKey, CachedSubfolders>,
}

#[derive(Hash, Eq, PartialEq, Clone)]
struct SubfolderKey {
    origin: String,
    server_path: String,
    local_path: String,
    folder: String,
}

struct CachedSubfolders {
    etag: String,
    items: Vec<(PathBuf, bool)>,
    seq: u64,
}

#[derive(Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    pub enabled: bool,
    pub url: String,
    pub server_path: String,
    pub local_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Credential {
    pub origin: String,
    pub key: String,
}

#[derive(Serialize, Deserialize)]
struct CatalogCacheEntry {
    version: u32,
    #[serde(default)]
    etag: Option<String>,
    #[serde(default)]
    catalog_revision: Option<String>,
    images: Vec<LibraryImage>,
}

pub(crate) struct CatalogCacheWrite {
    path: PathBuf,
    etag: Option<String>,
    catalog_revision: Option<String>,
    images: Vec<LibraryImage>,
}

impl CatalogCacheWrite {
    pub(crate) fn persist(self) {
        let Some(dir) = self.path.parent() else {
            return;
        };
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let entry = CatalogCacheEntry {
            version: CATALOG_CACHE_VERSION,
            etag: self.etag,
            catalog_revision: self.catalog_revision,
            images: self.images,
        };
        let Ok(json) = serde_json::to_vec(&entry) else {
            return;
        };
        let mut compressed = Vec::new();
        let mut encoder = GzEncoder::new(&mut compressed, Compression::fast());
        if encoder.write_all(&json).is_err() || encoder.finish().is_err() {
            return;
        }
        let Some(name) = self.path.file_name().and_then(|n| n.to_str()) else {
            return;
        };
        let seq = CACHE_PART_SEQ.fetch_add(1, Ordering::Relaxed);
        let part = dir.join(format!(".{name}.{}.{seq}.part", std::process::id()));
        if std::fs::write(&part, &compressed).is_err() {
            let _ = std::fs::remove_file(&part);
            return;
        }
        if std::fs::rename(&part, &self.path).is_err() {
            let _ = std::fs::remove_file(&part);
            return;
        }
        evict_catalog_cache(dir, &self.path);
    }
}

pub(crate) fn load(runtime: &Path) -> Config {
    crate::settings::read_key(runtime, SETTINGS)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub(crate) fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new("app.immage", "morfphoto-api-key")
        .map_err(|_| "morfPhoto keychain is unavailable".into())
}

pub(crate) fn credential(entry: &keyring::Entry) -> Result<Option<Credential>, String> {
    match entry.get_password() {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|_| "Invalid morfPhoto keychain entry".into()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("morfPhoto keychain is unavailable".into()),
    }
}

pub(crate) fn invalidate_credential_cache() {
    if let Ok(mut guard) = CREDENTIAL_CACHE.lock() {
        *guard = None;
    }
}

pub(crate) fn clear_caches(runtime: Option<&Path>) {
    invalidate_credential_cache();
    if let Some(cache) = SUBFOLDER_CACHE.get() {
        if let Ok(mut guard) = cache.lock() {
            guard.entries.clear();
        }
    }
    if let Some(runtime) = runtime {
        let _ = std::fs::remove_dir_all(runtime.join(CATALOG_CACHE_DIR));
    }
}

fn http_client() -> Result<&'static Client, String> {
    HTTP_CLIENT
        .get_or_init(|| {
            Client::builder()
                .connect_timeout(REQUEST_TIMEOUT)
                .redirect(reqwest::redirect::Policy::none())
                .pool_idle_timeout(Duration::from_secs(25))
                .pool_max_idle_per_host(8)
                .tcp_nodelay(true)
                .build()
                .map_err(|_| "Could not create morfPhoto client".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

fn subfolder_cache() -> &'static Mutex<SubfolderCacheState> {
    SUBFOLDER_CACHE.get_or_init(|| Mutex::new(SubfolderCacheState::default()))
}

fn build_auth_header(key: &str) -> Result<HeaderValue, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("morfPhoto API key is required".into());
    }
    let mut auth = HeaderValue::from_str(&format!("Bearer {trimmed}"))
        .map_err(|_| "Invalid morfPhoto API key")?;
    auth.set_sensitive(true);
    Ok(auth)
}

fn load_fresh_credential(origin: &str) -> Result<Credential, String> {
    let found = credential(&entry()?)?
        .filter(|value| value.origin == origin)
        .ok_or("morfPhoto API key is required for this server")?;
    if let Ok(mut guard) = CREDENTIAL_CACHE.lock() {
        *guard = Some(found.clone());
    }
    Ok(found)
}

fn header_str(headers: &HeaderMap, name: impl reqwest::header::AsHeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn read_response_body(
    response: reqwest::blocking::Response,
    limit: u64,
) -> Result<Vec<u8>, String> {
    let is_gzip = response
        .headers()
        .get(CONTENT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.to_ascii_lowercase().contains("gzip"));
    let mut body = Vec::new();
    let read_result = if is_gzip {
        GzDecoder::new(response)
            .take(limit + 1)
            .read_to_end(&mut body)
    } else {
        response.take(limit + 1).read_to_end(&mut body)
    };
    read_result.map_err(|_| "Could not read morfPhoto response".to_string())?;
    if body.len() as u64 > limit {
        return Err("morfPhoto response exceeded its size limit".into());
    }
    Ok(body)
}

fn encode_plus_query(url: &mut Url) {
    // QUrlQuery interprets a literal '+' as a plus, including in folder names.
    if let Some(query) = url.query() {
        let encoded = query.replace('+', "%20");
        url.set_query(Some(&encoded));
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn touch_cache_file(path: &Path) {
    if std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|mtime| mtime.elapsed().ok())
        .is_some_and(|age| age < Duration::from_secs(60))
    {
        return;
    }
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn read_catalog_cache(path: &Path) -> Option<CatalogCacheEntry> {
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    GzDecoder::new(file)
        .take(MAX_CATALOG_CACHE_DECOMPRESSED_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_CATALOG_CACHE_DECOMPRESSED_BYTES {
        return None;
    }
    let entry: CatalogCacheEntry = serde_json::from_slice(&bytes).ok()?;
    if entry.version != CATALOG_CACHE_VERSION {
        return None;
    }
    touch_cache_file(path);
    Some(entry)
}

fn evict_catalog_cache(dir: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(".json.gz") {
            continue;
        }
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let size = meta.len();
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        total_bytes = total_bytes.saturating_add(size);
        files.push((path, size, mtime));
    }
    let mut count = files.len();
    if count <= CATALOG_CACHE_MAX_FILES && total_bytes <= CATALOG_CACHE_MAX_BYTES {
        return;
    }
    files.sort_by_key(|(_, _, mtime)| *mtime);
    for (path, size, _) in files {
        if count <= CATALOG_CACHE_MAX_FILES && total_bytes <= CATALOG_CACHE_MAX_BYTES {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            count = count.saturating_sub(1);
            total_bytes = total_bytes.saturating_sub(size);
        }
    }
}

fn clean_local(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|part| part == Component::ParentDir)
}

fn clean_server(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && !path.split('/').any(|part| part == "." || part == "..")
}

impl Config {
    fn endpoint(&self) -> Result<Url, String> {
        let mut url = Url::parse(self.url.trim()).map_err(|_| "Invalid morfPhoto server URL")?;
        if !matches!(url.scheme(), "https" | "http")
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Invalid morfPhoto server URL".into());
        }
        url.path_segments_mut()
            .map_err(|_| "Invalid morfPhoto server URL")?
            .pop_if_empty()
            .extend(["api", "v1", "library"]);
        Ok(url)
    }

    pub(crate) fn origin(&self) -> Result<String, String> {
        Ok(self.endpoint()?.origin().ascii_serialization())
    }

    pub(crate) fn validate_mapping(&self) -> Result<(), String> {
        if !clean_server(self.server_path.trim()) || !clean_local(Path::new(self.local_path.trim()))
        {
            return Err("morfPhoto requires absolute server and local paths".into());
        }
        Ok(())
    }

    pub(crate) fn mapped_root(&self) -> Option<PathBuf> {
        let mount = PathBuf::from(self.local_path.trim());
        (self.enabled && self.validate_mapping().is_ok() && crate::volumes::on_network(&mount))
            .then_some(mount)
    }

    pub(crate) fn covers(&self, path: &Path) -> bool {
        clean_local(path)
            && self
                .mapped_root()
                .is_some_and(|mount| path.starts_with(mount))
    }

    fn server_folder(&self, path: &Path) -> Result<String, String> {
        let relative = path
            .strip_prefix(self.local_path.trim())
            .map_err(|_| "Folder is outside the morfPhoto mount")?;
        let mut server = self.server_path.trim().trim_end_matches('/').to_owned();
        for part in relative.components() {
            let Component::Normal(name) = part else {
                return Err("Invalid morfPhoto folder path".into());
            };
            let name = name.to_str().ok_or("Invalid morfPhoto folder name")?;
            if name.contains(['\\', '\0']) {
                return Err("Invalid morfPhoto folder name".into());
            }
            server.push('/');
            server.push_str(name);
        }
        if server.is_empty() {
            server.push('/');
        }
        Ok(server)
    }

    fn catalog_cache_path(
        &self,
        runtime: &Path,
        path: &Path,
        recursive: bool,
    ) -> Result<PathBuf, String> {
        let origin = self.origin()?;
        let server_folder = self.server_folder(path)?;
        let key = format!(
            "{origin}\0{}\0{}\0{server_folder}\0{recursive}",
            self.server_path.trim(),
            self.local_path.trim(),
        );
        Ok(runtime
            .join(CATALOG_CACHE_DIR)
            .join(format!("{}.json.gz", sha256_hex(&key))))
    }

    pub(crate) fn read_cached_listing(
        &self,
        runtime: &Path,
        path: &Path,
        recursive: bool,
    ) -> Option<Vec<LibraryImage>> {
        let cache_path = self.catalog_cache_path(runtime, path, recursive).ok()?;
        read_catalog_cache(&cache_path).map(|entry| entry.images)
    }

    fn client(&self, key: Option<&str>) -> Result<Api, String> {
        let endpoint = self.endpoint()?;
        let origin = endpoint.origin().ascii_serialization();
        let (auth, from_cache) = match key {
            Some(key) => (build_auth_header(key)?, false),
            None => {
                let cached = CREDENTIAL_CACHE
                    .lock()
                    .ok()
                    .and_then(|guard| guard.clone())
                    .filter(|value| value.origin == origin);
                match cached {
                    Some(value) => (build_auth_header(&value.key)?, true),
                    None => (build_auth_header(&load_fresh_credential(&origin)?.key)?, false),
                }
            }
        };
        Ok(Api {
            client: http_client()?,
            endpoint,
            auth,
            from_cache,
        })
    }

    pub(crate) fn test(&self, key: Option<&str>) -> Result<(), String> {
        let mut api = self.client(key)?;
        api.page(None, false, None, 1, 1, REQUEST_TIMEOUT)?;
        Ok(())
    }

    pub(crate) fn catalog_available(&self, path: &Path) -> Result<(), String> {
        let mut api = self.client(None)?;
        self.catalog_available_with_api(path, &mut api)
    }

    fn catalog_available_with_api(&self, path: &Path, api: &mut Api) -> Result<(), String> {
        let server_folder = self.server_folder(path)?;
        let folder = (server_folder != "/").then_some(server_folder.as_str());
        api.page(folder, true, None, 1, 1, REQUEST_TIMEOUT)?;
        Ok(())
    }

    #[allow(dead_code)]
    pub(crate) fn thumbnail(&self, path: &Path) -> Option<Vec<u8>> {
        if !self.covers(path) {
            return None;
        }
        let server_path = self.server_folder(path).ok()?;
        let mut api = self.client(None).ok()?;
        api.thumbnail(&server_path)
    }

    pub(crate) fn thumbnail_cached(&self, path: &Path, cache: &DiskCache) -> Option<Vec<u8>> {
        if !self.covers(path) {
            return None;
        }
        let mut api = self.client(None).ok()?;
        self.thumbnail_cached_with_api(path, cache, &mut api)
    }

    fn thumbnail_cached_with_api(
        &self,
        path: &Path,
        cache: &DiskCache,
        api: &mut Api,
    ) -> Option<Vec<u8>> {
        let server_path = self.server_folder(path).ok()?;
        let origin = self.origin().ok()?;
        let stem = sha256_hex(&format!("{origin}\0{server_path}"));
        let jpg_name = format!("{stem}.jpg");
        let etag_name = format!("{stem}.etag");
        let cached_jpg = cache.read(&jpg_name);
        let cached_etag = cache
            .read(&etag_name)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let send_etag = cached_jpg.as_ref().and(cached_etag.as_deref());
        match api.thumbnail_with_etag(&server_path, send_etag)? {
            ThumbnailOutcome::NotModified => cached_jpg,
            ThumbnailOutcome::Ok { bytes, etag } => {
                let _ = cache.write(&jpg_name, &bytes);
                if let Some(etag) = etag {
                    let _ = cache.write(&etag_name, etag.as_bytes());
                }
                Some(bytes)
            }
        }
    }

    #[allow(dead_code)]
    pub(crate) fn list(
        &self,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool + Sync,
    ) -> Result<Vec<LibraryImage>, String> {
        let (images, _) = self.list_streaming(None, path, recursive, cancelled, |_, _, _| {})?;
        Ok(images)
    }

    pub(crate) fn list_cached(
        &self,
        cache_dir: Option<&Path>,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool + Sync,
    ) -> Result<(Vec<LibraryImage>, Option<CatalogCacheWrite>), String> {
        self.list_streaming(cache_dir, path, recursive, cancelled, |_, _, _| {})
    }

    pub(crate) fn list_streaming(
        &self,
        cache_dir: Option<&Path>,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool + Sync,
        on_page: impl FnMut(Vec<LibraryImage>, usize, Option<usize>),
    ) -> Result<(Vec<LibraryImage>, Option<CatalogCacheWrite>), String> {
        let mut api = self.client(None)?;
        self.list_streaming_with_api(cache_dir, path, recursive, cancelled, on_page, &mut api)
    }

    fn collect_page_items(
        &self,
        path: &Path,
        recursive: bool,
        folder: Option<&str>,
        items: Vec<Photo>,
        seen: &mut HashSet<String>,
    ) -> Result<Vec<LibraryImage>, String> {
        let mut page_images = Vec::new();
        for item in items {
            if !seen.insert(item.path.clone()) {
                return Err("Duplicate morfPhoto path in listing".into());
            }
            let mapped = self.local_file(&item.path)?;
            if !mapped.starts_with(path) || (!recursive && mapped.parent() != Some(path)) {
                if folder.is_none() {
                    continue;
                }
                return Err("morfPhoto returned a path outside the requested folder".into());
            }
            if !crate::library_cmds::photo_candidate(&mapped) {
                continue;
            }
            page_images.extend(item.images(&mapped)?);
        }
        Ok(page_images)
    }

    fn list_streaming_with_api(
        &self,
        cache_dir: Option<&Path>,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool + Sync,
        mut on_page: impl FnMut(Vec<LibraryImage>, usize, Option<usize>),
        api: &mut Api,
    ) -> Result<(Vec<LibraryImage>, Option<CatalogCacheWrite>), String> {
        if cancelled() {
            return Err("cancelled".into());
        }
        let server_folder = self.server_folder(path)?;
        let folder = (server_folder != "/" || !recursive).then_some(server_folder.as_str());
        let cache_path = cache_dir
            .map(|runtime| self.catalog_cache_path(runtime, path, recursive))
            .transpose()?;
        let cached = cache_path.as_deref().and_then(read_catalog_cache);
        let cached_etag = cached
            .as_ref()
            .and_then(|entry| entry.etag.as_deref())
            .filter(|etag| !etag.is_empty());

        let started = Instant::now();
        let deadline = started + LIST_TIMEOUT;
        let failure = |page: usize, reason: String| {
            format!(
                "morfPhoto catalog page {page} after {} ms (recursive={recursive}): {reason}",
                started.elapsed().as_millis()
            )
        };

        let timeout = deadline
            .saturating_duration_since(Instant::now())
            .min(REQUEST_TIMEOUT);
        if timeout.is_zero() {
            return Err(failure(1, "morfPhoto listing timed out".into()));
        }

        let (page1, etag1, rev1) = match api
            .page(folder, recursive, cached_etag, 1, PAGE_SIZE, timeout)
            .map_err(|reason| failure(1, reason))?
        {
            PageOutcome::NotModified => {
                let entry = cached.ok_or_else(|| {
                    failure(1, "Unexpected HTTP 304 without cached catalog".into())
                })?;
                return Ok((entry.images, None));
            }
            PageOutcome::Ok {
                page,
                etag,
                revision,
            } => (page, etag, revision),
        };

        if let Some(total) = page1.total {
            if page1.items.len() != total.min(PAGE_SIZE) {
                return Err(failure(1, "morfPhoto listing changed during pagination".into()));
            }
        }

        let mut seen = HashSet::new();
        let page1_images = self
            .collect_page_items(path, recursive, folder, page1.items, &mut seen)
            .map_err(|reason| failure(1, reason))?;

        let make_cache_write = |images: Vec<LibraryImage>| -> Option<CatalogCacheWrite> {
            let path = cache_path.clone()?;
            if etag1.is_none() && rev1.is_none() {
                return None;
            }
            Some(CatalogCacheWrite {
                path,
                etag: etag1.clone(),
                catalog_revision: rev1.clone(),
                images,
            })
        };

        if let Some(total) = page1.total {
            on_page(page1_images.clone(), seen.len(), Some(total));
            if seen.len() >= total {
                let write = make_cache_write(page1_images.clone());
                return Ok((page1_images, write));
            }

            let total_pages = total.div_ceil(PAGE_SIZE);
            if total_pages == 2 {
                if cancelled() {
                    return Err("cancelled".into());
                }
                let timeout = deadline
                    .saturating_duration_since(Instant::now())
                    .min(REQUEST_TIMEOUT);
                if timeout.is_zero() {
                    return Err(failure(2, "morfPhoto listing timed out".into()));
                }
                let (page2, rev2) = match api
                    .page(folder, recursive, None, 2, PAGE_SIZE, timeout)
                    .map_err(|reason| failure(2, reason))?
                {
                    PageOutcome::Ok { page, revision, .. } => (page, revision),
                    PageOutcome::NotModified => {
                        return Err(failure(2, "Unexpected HTTP 304 on catalog page".into()))
                    }
                };
                if page2.total != Some(total)
                    || (rev1.is_some() && rev2 != rev1)
                    || page2.items.len() != total.saturating_sub(seen.len()).min(PAGE_SIZE)
                {
                    return Err(failure(
                        2,
                        "morfPhoto listing changed during pagination".into(),
                    ));
                }
                let page2_images = self
                    .collect_page_items(path, recursive, folder, page2.items, &mut seen)
                    .map_err(|reason| failure(2, reason))?;
                if seen.len() != total {
                    return Err(failure(
                        2,
                        "morfPhoto listing changed during pagination".into(),
                    ));
                }
                on_page(page2_images.clone(), seen.len(), Some(total));
                let mut all_images = page1_images;
                all_images.extend(page2_images);
                let write = make_cache_write(all_images.clone());
                return Ok((all_images, write));
            }

            // 3+ pages: fetch pages 2..=total_pages concurrently across 2 worker threads.
            let mut ordered_pages: Vec<Option<Vec<LibraryImage>>> = vec![None; total_pages];
            ordered_pages[0] = Some(page1_images);
            let next_page = AtomicUsize::new(2);
            let abort = AtomicBool::new(false);
            let api_ref: &Api = api;

            std::thread::scope(|scope| {
                let (tx, rx) = mpsc::channel::<Result<(usize, Page, Option<String>), String>>();
                for _ in 0..2 {
                    let tx = tx.clone();
                    let next_page = &next_page;
                    let abort = &abort;
                    let cancelled = &cancelled;
                    scope.spawn(move || loop {
                        if abort.load(Ordering::Acquire) || cancelled() {
                            abort.store(true, Ordering::Release);
                            break;
                        }
                        let page_num = next_page.fetch_add(1, Ordering::AcqRel);
                        if page_num > total_pages {
                            break;
                        }
                        let timeout = deadline
                            .saturating_duration_since(Instant::now())
                            .min(REQUEST_TIMEOUT);
                        if timeout.is_zero() {
                            abort.store(true, Ordering::Release);
                            let _ = tx.send(Err(failure(
                                page_num,
                                "morfPhoto listing timed out".into(),
                            )));
                            break;
                        }
                        match api_ref.page_readonly(folder, recursive, page_num, PAGE_SIZE, timeout)
                        {
                            Ok(PageOutcome::Ok { page, revision, .. }) => {
                                if tx.send(Ok((page_num, page, revision))).is_err() {
                                    abort.store(true, Ordering::Release);
                                    break;
                                }
                            }
                            Ok(PageOutcome::NotModified) => {
                                abort.store(true, Ordering::Release);
                                let _ = tx.send(Err(failure(
                                    page_num,
                                    "Unexpected HTTP 304 on catalog page".into(),
                                )));
                                break;
                            }
                            Err(reason) => {
                                abort.store(true, Ordering::Release);
                                let _ = tx.send(Err(failure(page_num, reason)));
                                break;
                            }
                        }
                    });
                }
                drop(tx);

                let expected_pages = total_pages - 1;
                let mut received_pages = 0usize;
                while received_pages < expected_pages {
                    if cancelled() {
                        abort.store(true, Ordering::Release);
                        return Err("cancelled".into());
                    }
                    match rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(Ok((page_num, reply, rev))) => {
                            if cancelled() {
                                abort.store(true, Ordering::Release);
                                return Err("cancelled".into());
                            }
                            let expected_len = if page_num < total_pages {
                                PAGE_SIZE
                            } else {
                                total - (total_pages - 1) * PAGE_SIZE
                            };
                            if reply.total != Some(total)
                                || (rev1.is_some() && rev != rev1)
                                || reply.items.len() != expected_len
                            {
                                abort.store(true, Ordering::Release);
                                return Err(failure(
                                    page_num,
                                    "morfPhoto listing changed during pagination".into(),
                                ));
                            }
                            let page_images = self
                                .collect_page_items(path, recursive, folder, reply.items, &mut seen)
                                .map_err(|reason| {
                                    abort.store(true, Ordering::Release);
                                    failure(page_num, reason)
                                })?;
                            ordered_pages[page_num - 1] = Some(page_images.clone());
                            on_page(page_images, seen.len(), Some(total));
                            received_pages += 1;
                        }
                        Ok(Err(err)) => {
                            abort.store(true, Ordering::Release);
                            return Err(err);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            if Instant::now() >= deadline {
                                abort.store(true, Ordering::Release);
                                return Err(failure(2, "morfPhoto listing timed out".into()));
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if received_pages < expected_pages {
                                abort.store(true, Ordering::Release);
                                return Err(failure(
                                    received_pages + 2,
                                    "morfPhoto listing stopped unexpectedly".into(),
                                ));
                            }
                            break;
                        }
                    }
                }
                Ok(())
            })?;

            if seen.len() != total {
                return Err(failure(
                    total_pages,
                    "morfPhoto listing changed during pagination".into(),
                ));
            }
            let all_images: Vec<LibraryImage> =
                ordered_pages.into_iter().flatten().flatten().collect();
            let write = make_cache_write(all_images.clone());
            return Ok((all_images, write));
        }

        // Keyset pagination fallback when server omits `total`.
        on_page(page1_images.clone(), seen.len(), None);
        let mut all_images = page1_images;
        let mut has_more = page1.has_more;
        let mut next_cursor = page1.next_cursor;

        for page_num in 2..=1_000_000 {
            if has_more != Some(true) {
                let write = make_cache_write(all_images.clone());
                return Ok((all_images, write));
            }
            let Some(cursor) = next_cursor.take() else {
                return Err(failure(page_num, "Invalid morfPhoto pagination".into()));
            };
            if cancelled() {
                return Err("cancelled".into());
            }
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .min(REQUEST_TIMEOUT);
            if timeout.is_zero() {
                return Err(failure(page_num, "morfPhoto listing timed out".into()));
            }
            let (reply, rev) = api
                .cursor_page(folder, recursive, &cursor, PAGE_SIZE, timeout)
                .map_err(|reason| failure(page_num, reason))?;
            if rev1.is_some() && rev != rev1 {
                return Err(failure(
                    page_num,
                    "morfPhoto listing changed during pagination".into(),
                ));
            }
            let page_images = self
                .collect_page_items(path, recursive, folder, reply.items, &mut seen)
                .map_err(|reason| failure(page_num, reason))?;
            on_page(page_images.clone(), seen.len(), None);
            all_images.extend(page_images);
            has_more = reply.has_more;
            next_cursor = reply.next_cursor;
        }
        Err("morfPhoto listing exceeded its page limit".into())
    }

    pub(crate) fn subfolders(&self, path: &Path) -> Result<Vec<(PathBuf, bool)>, String> {
        let mut api = self.client(None)?;
        self.subfolders_with_api(path, &mut api)
    }

    fn subfolders_with_api(
        &self,
        path: &Path,
        api: &mut Api,
    ) -> Result<Vec<(PathBuf, bool)>, String> {
        #[derive(Deserialize)]
        struct Folder {
            path: String,
            has_children: bool,
        }
        #[derive(Deserialize)]
        struct Reply {
            items: Vec<Folder>,
        }
        let server_folder = self.server_folder(path)?;
        let cache_key = SubfolderKey {
            origin: api.endpoint.origin().ascii_serialization(),
            server_path: self.server_path.trim().to_string(),
            local_path: self.local_path.trim().to_string(),
            folder: server_folder.clone(),
        };
        let cached = {
            let mut state = subfolder_cache()
                .lock()
                .map_err(|_| "Subfolder cache lock poisoned")?;
            let next_seq = state.seq.wrapping_add(1);
            if let Some(entry) = state.entries.get_mut(&cache_key) {
                entry.seq = next_seq;
                let cached = (entry.etag.clone(), entry.items.clone());
                state.seq = next_seq;
                Some(cached)
            } else {
                None
            }
        };

        let mut url = api.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| "Invalid morfPhoto endpoint")?
            .push("subfolders");
        url.query_pairs_mut()
            .append_pair("folder_path", &server_folder);
        encode_plus_query(&mut url);

        let response = api
            .send_authed(|api| {
                let mut req = api
                    .client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(REQUEST_TIMEOUT);
                if let Some((etag, _)) = &cached {
                    if let Ok(value) = HeaderValue::from_str(etag) {
                        req = req.header(IF_NONE_MATCH, value);
                    }
                }
                req
            })
            .map_err(|error| {
                if error.is_timeout() {
                    "Request timed out"
                } else {
                    "Request failed"
                }
            })?;

        if response.status() == StatusCode::NOT_MODIFIED {
            if let Some((_, items)) = cached {
                return Ok(items);
            }
            return Err("Unexpected HTTP 304 for subfolders".into());
        }
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let etag = header_str(response.headers(), ETAG);
        let body = read_response_body(response, MAX_PAGE_BYTES)?;
        let reply: Reply =
            serde_json::from_slice(&body).map_err(|_| "Invalid subfolder response")?;
        let items: Vec<(PathBuf, bool)> = reply
            .items
            .into_iter()
            .map(|folder| {
                let mapped = self.local_file(&folder.path)?;
                if mapped.parent() != Some(path) {
                    return Err("morfPhoto returned a folder outside the requested parent".into());
                }
                Ok((mapped, folder.has_children))
            })
            .collect::<Result<Vec<_>, String>>()?;

        if let Some(etag) = etag {
            if let Ok(mut state) = subfolder_cache().lock() {
                if state.entries.len() >= SUBFOLDER_CACHE_CAP
                    && !state.entries.contains_key(&cache_key)
                {
                    if let Some(oldest_key) = state
                        .entries
                        .iter()
                        .min_by_key(|(_, entry)| entry.seq)
                        .map(|(k, _)| k.clone())
                    {
                        state.entries.remove(&oldest_key);
                    }
                }
                state.seq = state.seq.wrapping_add(1);
                let seq = state.seq;
                state.entries.insert(
                    cache_key,
                    CachedSubfolders {
                        etag,
                        items: items.clone(),
                        seq,
                    },
                );
            }
        }
        Ok(items)
    }

    pub(crate) fn metrics(&self) -> Result<Value, String> {
        let mut api = self.client(None)?;
        self.metrics_with_api(&mut api)
    }

    fn metrics_with_api(&self, api: &mut Api) -> Result<Value, String> {
        let mut url = api.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| "Invalid morfPhoto endpoint")?
            .pop()
            .extend(["index", "status"]);
        let response = api
            .send_authed(|api| {
                api.client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(REQUEST_TIMEOUT)
            })
            .and_then(|response| response.error_for_status())
            .map_err(|_| "morfPhoto index status unavailable")?;
        let body = read_response_body(response, MAX_INDEX_STATUS_BYTES)
            .map_err(|_| "Invalid morfPhoto index status")?;
        serde_json::from_slice(&body).map_err(|_| "Invalid morfPhoto index status".into())
    }

    #[allow(dead_code)]
    pub(crate) fn catalog_revision(&self) -> Result<Option<String>, String> {
        let mut api = self.client(None)?;
        self.catalog_revision_with_api(&mut api)
    }

    #[allow(dead_code)]
    fn catalog_revision_with_api(&self, api: &mut Api) -> Result<Option<String>, String> {
        let metrics = self.metrics_with_api(api)?;
        Ok(metrics
            .get("catalog_revision")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned))
    }

    pub(crate) fn semantic(
        &self,
        folder: &Path,
        args: &crate::local_search::LocalSearchArgs,
    ) -> Result<(crate::local_search::LocalPage, usize, usize), String> {
        use crate::local_search::{LocalHit, LocalPage};
        #[derive(Deserialize)]
        struct Hit {
            score: f64,
            photo: Photo,
        }
        #[derive(Deserialize)]
        struct Reply {
            items: Vec<Hit>,
            next: Option<String>,
            revision: String,
            indexed: usize,
            eligible: usize,
        }
        let mut api = self.client(None)?;
        let mut url = api.endpoint.clone();
        url.path_segments_mut()
            .map_err(|_| "Invalid morfPhoto endpoint")?
            .pop()
            .extend(["search", "semantic"]);
        let f = &args.filters;
        let next = args
            .next
            .as_deref()
            .map(|cursor| cursor.strip_prefix("morfphoto:").ok_or("Local search cursor"))
            .transpose()?;
        let payload = json!({
            "text": args.text, "folder_path": self.server_folder(folder)?,
            "recursive": args.recursive, "size": args.size, "next": next,
            "filters": {
                "min_rating": f.min_rating, "labels": f.labels,
                "rejected": f.rejected, "unlabeled": if f.unlabeled {"true"} else {"false"},
                "kind": f.kinds, "camera": f.cameras, "body": f.bodies,
                "lens": f.lenses, "keyword": f.keywords, "iso": f.iso,
                "aperture": f.aperture, "focal": f.focal, "shutter": f.shutter,
                "taken_from": f.taken_from, "taken_to": f.taken_to,
            }
        });
        let response = api
            .send_authed(|api| {
                api.client
                    .post(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(SEMANTIC_TIMEOUT)
                    .json(&payload)
            })
            .map_err(|error| {
                if error.is_timeout() {
                    "morfPhoto semantic search timed out"
                } else {
                    "morfPhoto semantic request failed"
                }
            })?;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        let body = read_response_body(response, MAX_PAGE_BYTES)?;
        let reply: Reply = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for hit in reply.items {
            let mapped = self.local_file(&hit.photo.path)?;
            if !mapped.starts_with(folder)
                || (!args.recursive && mapped.parent() != Some(folder))
            {
                return Err("morfPhoto semantic result outside scope".into());
            }
            if !crate::library_cmds::photo_candidate(&mapped) {
                continue;
            }
            if let Some(image) = hit.photo.images(&mapped)?.into_iter().find(|i| i.version == 0) {
                items.push(LocalHit {
                    asset_id: None,
                    variant_id: None,
                    subject: "original".into(),
                    score: hit.score,
                    image,
                });
            }
        }
        Ok((
            LocalPage {
                items,
                next: reply.next.map(|cursor| format!("morfphoto:{cursor}")),
                revision: reply.revision,
            },
            reply.indexed,
            reply.eligible,
        ))
    }

    #[cfg(test)]
    fn list_with_api(
        &self,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool + Sync,
        mut api: Api,
    ) -> Result<Vec<LibraryImage>, String> {
        let (images, _) = self.list_streaming_with_api(
            None,
            path,
            recursive,
            cancelled,
            |_, _, _| {},
            &mut api,
        )?;
        Ok(images)
    }

    fn local_file(&self, path: &str) -> Result<PathBuf, String> {
        if !clean_server(path) {
            return Err("Invalid morfPhoto photo path".into());
        }
        let root = self.server_path.trim().trim_end_matches('/');
        let relative = path
            .strip_prefix(root)
            .and_then(|s| s.strip_prefix('/'))
            .ok_or("morfPhoto photo is outside its mapped root")?;
        let mut mapped = PathBuf::from(self.local_path.trim());
        for segment in relative.split('/') {
            let mut components = Path::new(segment).components();
            if !matches!(components.next(), Some(Component::Normal(_)))
                || components.next().is_some()
                || (cfg!(windows) && (segment.contains(':') || segment.ends_with(['.', ' '])))
            {
                return Err("Invalid morfPhoto filename".into());
            }
            mapped.push(segment);
        }
        Ok(mapped)
    }
}

struct Api {
    client: &'static Client,
    endpoint: Url,
    auth: HeaderValue,
    from_cache: bool,
}

#[derive(Deserialize)]
struct Page {
    items: Vec<Photo>,
    #[serde(default)]
    total: Option<usize>,
    #[serde(default)]
    page: Option<usize>,
    #[serde(default)]
    page_size: Option<usize>,
    #[serde(default)]
    has_more: Option<bool>,
    #[serde(default)]
    next_cursor: Option<String>,
}

enum PageOutcome {
    NotModified,
    Ok {
        page: Page,
        etag: Option<String>,
        revision: Option<String>,
    },
}

enum ThumbnailOutcome {
    NotModified,
    Ok {
        bytes: Vec<u8>,
        etag: Option<String>,
    },
}

impl Api {
    fn send_authed(
        &mut self,
        build: impl Fn(&Api) -> reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::Response, reqwest::Error> {
        let response = build(self).send()?;
        if response.status() == StatusCode::UNAUTHORIZED && self.from_cache {
            invalidate_credential_cache();
            let origin = self.endpoint.origin().ascii_serialization();
            if let Ok(cred) = load_fresh_credential(&origin) {
                if let Ok(auth) = build_auth_header(&cred.key) {
                    self.auth = auth;
                    self.from_cache = false;
                    return build(self).send();
                }
            }
        }
        Ok(response)
    }

    fn send_readonly(
        &self,
        build: impl Fn(&Api) -> reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::Response, reqwest::Error> {
        let response = build(self).send()?;
        if response.status() == StatusCode::UNAUTHORIZED && self.from_cache {
            invalidate_credential_cache();
        }
        Ok(response)
    }

    #[allow(dead_code)]
    fn thumbnail(&mut self, server_path: &str) -> Option<Vec<u8>> {
        match self.thumbnail_with_etag(server_path, None)? {
            ThumbnailOutcome::Ok { bytes, .. } => Some(bytes),
            ThumbnailOutcome::NotModified => None,
        }
    }

    fn thumbnail_with_etag(
        &mut self,
        server_path: &str,
        if_none_match: Option<&str>,
    ) -> Option<ThumbnailOutcome> {
        let mut url = self.endpoint.clone();
        url.path_segments_mut()
            .ok()?
            .pop()
            .extend(["thumbnail", "cached"]);
        url.query_pairs_mut().append_pair("path", server_path);
        encode_plus_query(&mut url);
        let response = self
            .send_authed(|api| {
                let mut req = api
                    .client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .timeout(THUMBNAIL_TIMEOUT);
                if let Some(etag) = if_none_match {
                    if let Ok(value) = HeaderValue::from_str(etag) {
                        req = req.header(IF_NONE_MATCH, value);
                    }
                }
                req
            })
            .ok()?;
        if response.status() == StatusCode::NOT_MODIFIED && if_none_match.is_some() {
            return Some(ThumbnailOutcome::NotModified);
        }
        if !response.status().is_success() {
            return None;
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)?
            .to_str()
            .ok()?
            .split(';')
            .next()
            .map(str::trim);
        if content_type != Some("image/jpeg") {
            return None;
        }
        let etag = header_str(response.headers(), ETAG);
        let mut bytes = Vec::new();
        response
            .take(MAX_THUMBNAIL_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        (bytes.len() as u64 <= MAX_THUMBNAIL_BYTES && bytes.starts_with(&[0xff, 0xd8]))
            .then_some(ThumbnailOutcome::Ok { bytes, etag })
    }

    fn offset_url(
        &self,
        folder: Option<&str>,
        recursive: bool,
        page: usize,
        size: usize,
    ) -> Url {
        let mut url = self.endpoint.clone();
        {
            let mut params = url.query_pairs_mut();
            params
                .append_pair("page", &page.to_string())
                .append_pair("page_size", &size.to_string());
            if let Some(folder) = folder {
                params.append_pair("folder_path", folder);
            }
            if recursive {
                params.append_pair("recursive", "true");
            }
        }
        encode_plus_query(&mut url);
        url
    }

    fn cursor_url(
        &self,
        folder: Option<&str>,
        recursive: bool,
        cursor: &str,
        size: usize,
    ) -> Url {
        let mut url = self.endpoint.clone();
        {
            let mut params = url.query_pairs_mut();
            params
                .append_pair("cursor", cursor)
                .append_pair("skip_total", "1")
                .append_pair("page_size", &size.to_string());
            if let Some(folder) = folder {
                params.append_pair("folder_path", folder);
            }
            if recursive {
                params.append_pair("recursive", "true");
            }
        }
        encode_plus_query(&mut url);
        url
    }

    fn decode_page_response(
        response: reqwest::blocking::Response,
        size: usize,
        expected_page: Option<usize>,
    ) -> Result<PageOutcome, String> {
        if response.status() == StatusCode::NOT_MODIFIED {
            return Ok(PageOutcome::NotModified);
        }
        if !response.status().is_success() {
            return Err(format!(
                "morfPhoto returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let etag = header_str(response.headers(), ETAG);
        let revision = header_str(response.headers(), "x-catalog-revision");
        let bytes = read_response_body(response, MAX_PAGE_BYTES)?;
        let reply: Page =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid morfPhoto library response")?;
        if expected_page.is_some_and(|p| reply.page.is_some_and(|got| got != p))
            || reply.page_size.is_some_and(|got| got != size)
            || reply.items.len() > size
        {
            return Err("Invalid morfPhoto pagination".into());
        }
        Ok(PageOutcome::Ok {
            page: reply,
            etag,
            revision,
        })
    }

    fn page(
        &mut self,
        folder: Option<&str>,
        recursive: bool,
        if_none_match: Option<&str>,
        page: usize,
        size: usize,
        timeout: Duration,
    ) -> Result<PageOutcome, String> {
        let url = self.offset_url(folder, recursive, page, size);
        let response = self
            .send_authed(|api| {
                let mut req = api
                    .client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(timeout);
                if let Some(etag) = if_none_match {
                    if let Ok(value) = HeaderValue::from_str(etag) {
                        req = req.header(IF_NONE_MATCH, value);
                    }
                }
                req
            })
            .map_err(|error| {
                if error.is_timeout() {
                    "morfPhoto catalog request timed out"
                } else {
                    "morfPhoto catalog request failed"
                }
            })?;
        Self::decode_page_response(response, size, Some(page))
    }

    fn page_readonly(
        &self,
        folder: Option<&str>,
        recursive: bool,
        page: usize,
        size: usize,
        timeout: Duration,
    ) -> Result<PageOutcome, String> {
        let url = self.offset_url(folder, recursive, page, size);
        let response = self
            .send_readonly(|api| {
                api.client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(timeout)
            })
            .map_err(|error| {
                if error.is_timeout() {
                    "morfPhoto catalog request timed out"
                } else {
                    "morfPhoto catalog request failed"
                }
            })?;
        Self::decode_page_response(response, size, Some(page))
    }

    fn cursor_page(
        &mut self,
        folder: Option<&str>,
        recursive: bool,
        cursor: &str,
        size: usize,
        timeout: Duration,
    ) -> Result<(Page, Option<String>), String> {
        let url = self.cursor_url(folder, recursive, cursor, size);
        let response = self
            .send_authed(|api| {
                api.client
                    .get(url.clone())
                    .header(AUTHORIZATION, api.auth.clone())
                    .header(ACCEPT_ENCODING, "gzip")
                    .timeout(timeout)
            })
            .map_err(|error| {
                if error.is_timeout() {
                    "morfPhoto catalog request timed out"
                } else {
                    "morfPhoto catalog request failed"
                }
            })?;
        match Self::decode_page_response(response, size, None)? {
            PageOutcome::Ok { page, revision, .. } => Ok((page, revision)),
            PageOutcome::NotModified => Err("Unexpected HTTP 304 on cursor page".into()),
        }
    }
}

#[derive(Deserialize)]
struct Photo {
    path: String,
    versions: Vec<Version>,
    #[serde(flatten)]
    exif: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
struct Version {
    version: u32,
    copy: bool,
    rating: u8,
    rejected: bool,
    labels: u32,
    edited: Option<bool>,
    taken_at: Option<String>,
    latitude: Option<f64>,
    longitude: Option<f64>,
    keywords: Vec<String>,
}

impl Photo {
    fn images(self, path: &Path) -> Result<Vec<LibraryImage>, String> {
        let filename = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("Invalid mapped filename")?;
        let mut versions = HashSet::new();
        if self.versions.is_empty() {
            return Err("morfPhoto photo has no versions".into());
        }
        self.versions
            .into_iter()
            .map(|version| {
                if !versions.insert(version.version) {
                    return Err("Duplicate morfPhoto version".into());
                }
                let text = |key: &str| self.exif.get(key).and_then(Value::as_str).unwrap_or_default();
                let number = |key: &str| self.exif.get(key).and_then(Value::as_f64).unwrap_or(0.0);
                let capture = version.taken_at.as_deref().unwrap_or_default();
                let datetime = capture.get(..10).zip(capture.get(10..)).map_or_else(
                    || capture.to_owned(),
                    |(date, time)| format!("{}{}", date.replace('-', ":"), time.replacen('T', " ", 1)),
                );
                let file_datetime = if capture.is_empty() {
                    self.exif
                        .get("mtime")
                        .and_then(Value::as_i64)
                        .filter(|mtime| *mtime > 0)
                        .and_then(|mtime| chrono::DateTime::from_timestamp(mtime, 0))
                        .map(|mtime| {
                            mtime
                                .with_timezone(&chrono::Local)
                                .format("%Y:%m:%d %H:%M:%S")
                                .to_string()
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let location = version
                    .latitude
                    .zip(version.longitude)
                    .filter(|(lat, lon)| lat.abs() <= 90.0 && lon.abs() <= 180.0)
                    .map(|(latitude, longitude)| {
                        json!({ "latitude": latitude, "longitude": longitude })
                    });
                serde_json::from_value(json!({
                    "imgid": 0, "path": path, "filename": filename,
                    "rating": version.rating.min(5), "rejected": version.rejected,
                    "labels": version.labels & 31, "edited": version.edited.unwrap_or(false),
                    "width": 0, "height": 0, "location": location, "keywords": version.keywords,
                    "version": version.version, "copy": version.copy,
                    "morfphotoPreview": true,
                    "exif": {
                        "maker": text("make"), "model": text("camera_model"), "lens": text("lens"),
                        "body_serial": text("body_serial"), "exposure": number("shutter_speed_s"),
                        "aperture": number("aperture"), "iso": number("iso"), "focal_length": number("focal_length"),
                        "exposure_bias": number("exposure_compensation"), "focus_distance": 0,
                        "datetime": datetime, "capture_time_raw": capture, "file_datetime": file_datetime
                    }
                }))
                .map_err(|_| "Invalid morfPhoto metadata".into())
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cache::Caches;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        sync::Arc,
        thread,
    };

    #[test]
    fn maps_components_in_both_directions() {
        let temp = tempfile::tempdir().unwrap();
        let config = Config {
            server_path: "/srv/photos/".into(),
            local_path: temp.path().to_str().unwrap().into(),
            ..Config::default()
        };
        let folder = temp.path().join("June + July");
        assert_eq!(
            config.server_folder(&folder).unwrap(),
            "/srv/photos/June + July"
        );
        assert_eq!(
            config.local_file("/srv/photos/June + July/a.jpg").unwrap(),
            folder.join("a.jpg")
        );
        for path in [
            "/srv/photos2/a.jpg",
            "/srv/photos/../a.jpg",
            "/srv/photos/a\\b.jpg",
            "/srv/photos/",
        ] {
            assert!(config.local_file(path).is_err(), "{path}");
        }
    }

    fn read_http_request<R: BufRead>(reader: &mut R) -> Option<String> {
        let mut request = String::new();
        loop {
            let mut line = String::new();
            if reader.read_line(&mut line).ok()? == 0 || line == "\r\n" {
                break;
            }
            request.push_str(&line);
        }
        if request.is_empty() {
            None
        } else {
            Some(request)
        }
    }

    fn mock_api(responses: Vec<(u16, Value)>) -> (String, thread::JoinHandle<Vec<String>>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|(status, response)| {
                    let (mut stream, _) = server.accept().unwrap();
                    stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let request = read_http_request(&mut reader).unwrap_or_default();
                    let body = response.to_string();
                    write!(
                        stream,
                        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                    request
                })
                .collect()
        });
        (url, handle)
    }

    fn mock_raw(
        responses: Vec<(u16, Vec<(&'static str, String)>, Vec<u8>)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|(status, headers, body)| {
                    let (mut stream, _) = server.accept().unwrap();
                    stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
                    let mut reader = BufReader::new(&mut stream);
                    let request = read_http_request(&mut reader).unwrap_or_default();
                    write!(stream, "HTTP/1.1 {status} Test\r\n").unwrap();
                    for (k, v) in headers {
                        write!(stream, "{k}: {v}\r\n").unwrap();
                    }
                    if status != 304 {
                        write!(stream, "Content-Length: {}\r\n", body.len()).unwrap();
                    }
                    write!(stream, "Connection: close\r\n\r\n").unwrap();
                    if status != 304 && !body.is_empty() {
                        stream.write_all(&body).unwrap();
                    }
                    request
                })
                .collect()
        });
        (url, handle)
    }

    fn gzip_bytes(input: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = GzEncoder::new(&mut out, Compression::fast());
        encoder.write_all(input).unwrap();
        encoder.finish().unwrap();
        out
    }

    fn photo(path: String) -> Value {
        json!({"path":path, "camera_model":"Camera", "shutter_speed_s":0.01,
        "versions":[
            {"version":0,"copy":false,"rating":4,"rejected":false,"labels":1,"edited":null,
             "taken_at":"2026-06-01T10:11:12","latitude":1.0,"longitude":2.0,"keywords":["Trips|June"]},
            {"version":2,"copy":true,"rating":0,"rejected":true,"labels":4,"edited":true,"keywords":[]}
        ]})
    }

    #[test]
    fn authenticated_listing_encodes_folder_and_keeps_versions() {
        let temp = tempfile::tempdir().unwrap();
        let (url, server) = mock_api(vec![(
            200,
            json!({
                "page": 1, "page_size": PAGE_SIZE, "total": 1,
                "items": [photo("/srv/photos/June + July/a.jpg".into())]
            }),
        )]);
        let config = Config {
            url,
            server_path: "/srv/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        // No physical directory or original is needed to construct the listing.
        let folder = temp.path().join("June + July");
        let images = config
            .list_with_api(
                &folder,
                false,
                || false,
                config.client(Some("test-key")).unwrap(),
            )
            .unwrap();
        assert_eq!(images.len(), 2);
        assert_eq!(images[0].path, folder.join("a.jpg").to_str().unwrap());
        assert_eq!(images[0].exif.model, "Camera");
        assert_eq!(images[0].exif.datetime, "2026:06:01 10:11:12");
        assert_eq!(images[0].keywords, ["Trips|June"]);
        assert_eq!(images[1].version, 2);
        assert!(images[1].copy && images[1].rejected && images[1].edited);
        let requests = server.join().unwrap();
        assert!(requests[0].contains("folder_path=%2Fsrv%2Fphotos%2FJune%20%2B%20July"));
        assert!(requests[0].contains("authorization: Bearer test-key"));
    }

    #[test]
    fn thumbnail_uses_the_authenticated_cached_route() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = Config {
            url: format!("http://{}/morf", server.local_addr().unwrap()),
            ..Config::default()
        };
        let worker = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
            let mut reader = BufReader::new(&mut stream);
            let request = read_http_request(&mut reader).unwrap();
            assert!(request.starts_with("GET /morf/api/v1/thumbnail/cached?path=%2Fphotos%2FA%20%2B%20B.ORF "));
            assert!(request.contains("authorization: Bearer test-key"));
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\xff\xd8\xff\xd9").unwrap();
        });
        assert_eq!(
            config.client(Some("test-key")).unwrap().thumbnail("/photos/A + B.ORF"),
            Some(vec![0xff, 0xd8, 0xff, 0xd9])
        );
        worker.join().unwrap();
    }

    #[test]
    fn empty_is_success_and_a_failed_second_page_discards_the_listing() {
        let temp = tempfile::tempdir().unwrap();
        let (url, empty_server) = mock_api(vec![(
            200,
            json!({
                "page": 1, "page_size": PAGE_SIZE, "total": 0, "items": []
            }),
        )]);
        let mut config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let list = |config: &Config| {
            config.list_with_api(
                temp.path(),
                true,
                || false,
                config.client(Some("key")).unwrap(),
            )
        };
        assert!(list(&config).unwrap().is_empty());
        empty_server.join().unwrap();

        let items: Vec<_> = (0..PAGE_SIZE)
            .map(|i| photo(format!("/photos/{i}.jpg")))
            .collect();
        let (url, failing_server) = mock_api(vec![
            (
                200,
                json!({"page":1, "page_size": PAGE_SIZE, "total":PAGE_SIZE + 1, "items":items}),
            ),
            (503, json!({})),
        ]);
        config.url = url;
        let Err(error) = list(&config) else {
            panic!("a failed second page must discard the listing");
        };
        assert!(error.starts_with("morfPhoto catalog page 2 after "), "{error}");
        assert!(
            error.ends_with(" (recursive=true): morfPhoto returned HTTP 503"),
            "{error}"
        );
        assert_eq!(failing_server.join().unwrap().len(), 2);
    }

    #[test]
    fn semantic_timeout_has_margin_above_backend_proxy() {
        assert!(SEMANTIC_TIMEOUT >= Duration::from_secs(20));
        assert_eq!(SEMANTIC_TIMEOUT, Duration::from_secs(22));
    }

    #[test]
    fn gzip_decompression_handles_compressed_plain_and_oversized_payloads() {
        let temp = tempfile::tempdir().unwrap();
        let items: Vec<_> = (0..10).map(|i| photo(format!("/photos/{i}.jpg"))).collect();
        let json_body = json!({
            "page": 1, "page_size": PAGE_SIZE, "total": 10, "items": items
        })
        .to_string();
        assert!(json_body.len() >= 1024);
        let compressed = gzip_bytes(json_body.as_bytes());
        assert!(compressed.len() < json_body.len());

        let bomb = gzip_bytes(&vec![b' '; (MAX_PAGE_BYTES + 1024) as usize]);

        let (url, server) = mock_raw(vec![
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("Content-Encoding", "gzip".into()),
                ],
                compressed,
            ),
            (
                200,
                vec![("Content-Type", "application/json".into())],
                json_body.into_bytes(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("Content-Encoding", "GZIP".into()),
                ],
                bomb,
            ),
        ]);

        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let gzipped = config
            .list_with_api(
                temp.path(),
                false,
                || false,
                config.client(Some("k")).unwrap(),
            )
            .unwrap();
        assert_eq!(gzipped.len(), 20);

        let plain = config
            .list_with_api(
                temp.path(),
                false,
                || false,
                config.client(Some("k")).unwrap(),
            )
            .unwrap();
        assert_eq!(plain.len(), 20);

        let err = config
            .list_with_api(
                temp.path(),
                false,
                || false,
                config.client(Some("k")).unwrap(),
            )
            .err()
            .unwrap();
        assert!(
            err.contains("morfPhoto response exceeded its size limit"),
            "{err}"
        );

        let requests = server.join().unwrap();
        for req in &requests {
            assert!(
                req.to_ascii_lowercase().contains("accept-encoding: gzip"),
                "{req}"
            );
        }
    }

    #[test]
    fn keep_alive_reuses_single_tcp_connection() {
        let temp = tempfile::tempdir().unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let worker = thread::spawn(move || {
            let mut accepts = 0usize;
            let (mut stream, _) = server.accept().unwrap();
            accepts += 1;
            stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            for i in 0..3 {
                let req = read_http_request(&mut reader).unwrap();
                assert!(!req.is_empty());
                if i < 2 {
                    let body = json!({
                        "page": 1, "page_size": if i == 0 { 1 } else { PAGE_SIZE },
                        "total": 0, "items": []
                    })
                    .to_string();
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}",
                        body.len()
                    )
                    .unwrap();
                } else {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\xff\xd8\xff\xd9")
                        .unwrap();
                }
                stream.flush().unwrap();
            }
            accepts
        });

        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("key")).unwrap();
        config.catalog_available_with_api(temp.path(), &mut api).unwrap();
        let images = config
            .list_with_api(temp.path(), false, || false, config.client(Some("key")).unwrap())
            .unwrap();
        assert!(images.is_empty());
        assert_eq!(
            config.client(Some("key")).unwrap().thumbnail("/photos/a.jpg"),
            Some(vec![0xff, 0xd8, 0xff, 0xd9])
        );
        assert_eq!(worker.join().unwrap(), 1);
    }

    #[test]
    fn catalog_disk_cache_cold_warm_304_and_refresh() {
        let temp = tempfile::tempdir().unwrap();
        let runtime = temp.path().join("runtime");
        let photos_dir = temp.path().join("mount");

        let body1 = json!({
            "page": 1, "page_size": PAGE_SIZE, "total": 1,
            "items": [photo("/photos/a.jpg".into())]
        })
        .to_string();
        let body2 = json!({
            "page": 1, "page_size": PAGE_SIZE, "total": 1,
            "items": [photo("/photos/b.jpg".into())]
        })
        .to_string();

        let (url, server) = mock_raw(vec![
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("ETag", "\"cat-rev1\"".into()),
                    ("X-Catalog-Revision", "rev1".into()),
                ],
                body1.into_bytes(),
            ),
            (
                304,
                vec![("ETag", "\"cat-rev1\"".into())],
                Vec::new(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("ETag", "\"cat-rev2\"".into()),
                    ("X-Catalog-Revision", "rev2".into()),
                ],
                body2.into_bytes(),
            ),
        ]);

        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: photos_dir.to_str().unwrap().into(),
            enabled: true,
        };

        // 1. Cold miss writes cache
        assert!(config.read_cached_listing(&runtime, &photos_dir, false).is_none());
        let mut api = config.client(Some("k")).unwrap();
        let mut pages = 0;
        let (images1, write1) = config
            .list_streaming_with_api(
                Some(&runtime),
                &photos_dir,
                false,
                || false,
                |_, _, _| pages += 1,
                &mut api,
            )
            .unwrap();
        assert_eq!(pages, 1);
        assert_eq!(images1.len(), 2);
        write1.expect("cache write on 200 with ETag").persist();

        let seeded = config.read_cached_listing(&runtime, &photos_dir, false).unwrap();
        assert_eq!(seeded.len(), 2);
        assert_eq!(seeded[0].path, photos_dir.join("a.jpg").to_str().unwrap());

        // 2. Warm 304 returns cached images with zero body and no rewrite
        let mut pages_304 = 0;
        let (images_304, write_304) = config
            .list_streaming_with_api(
                Some(&runtime),
                &photos_dir,
                false,
                || false,
                |_, _, _| pages_304 += 1,
                &mut api,
            )
            .unwrap();
        assert_eq!(pages_304, 0);
        assert!(write_304.is_none());
        assert_eq!(images_304.len(), 2);
        assert_eq!(images_304[0].path, photos_dir.join("a.jpg").to_str().unwrap());

        // 3. Updated catalog (200 with new ETag) refreshes cache
        let (images2, write2) = config
            .list_streaming_with_api(
                Some(&runtime),
                &photos_dir,
                false,
                || false,
                |_, _, _| {},
                &mut api,
            )
            .unwrap();
        assert_eq!(images2[0].path, photos_dir.join("b.jpg").to_str().unwrap());
        write2.unwrap().persist();
        let seeded2 = config.read_cached_listing(&runtime, &photos_dir, false).unwrap();
        assert_eq!(seeded2[0].path, photos_dir.join("b.jpg").to_str().unwrap());

        let requests = server.join().unwrap();
        assert!(!requests[0].to_ascii_lowercase().contains("if-none-match:"));
        assert!(requests[1].contains("if-none-match: \"cat-rev1\""));
        assert!(requests[2].contains("if-none-match: \"cat-rev1\""));

        clear_caches(Some(&runtime));
        assert!(!runtime.join(CATALOG_CACHE_DIR).exists());
    }

    #[test]
    fn catalog_cache_evicts_oldest_beyond_32_files() {
        let temp = tempfile::tempdir().unwrap();
        let cache_dir = temp.path().join(CATALOG_CACHE_DIR);
        for i in 0..35u64 {
            let path = cache_dir.join(format!("entry-{i:02}.json.gz"));
            CatalogCacheWrite {
                path: path.clone(),
                etag: Some(format!("\"e{i}\"")),
                catalog_revision: Some(format!("r{i}")),
                images: Vec::new(),
            }
            .persist();
            let file = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            let _ = file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + i));
        }
        let path_last = cache_dir.join("entry-35.json.gz");
        CatalogCacheWrite {
            path: path_last,
            etag: Some("\"e35\"".into()),
            catalog_revision: Some("r35".into()),
            images: Vec::new(),
        }
        .persist();

        let remaining: Vec<_> = std::fs::read_dir(&cache_dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(remaining.len(), CATALOG_CACHE_MAX_FILES);
        assert!(!remaining.contains(&"entry-00.json.gz".to_string()));
        assert!(!remaining.contains(&"entry-03.json.gz".to_string()));
        assert!(remaining.contains(&"entry-35.json.gz".to_string()));
    }

    #[test]
    fn progressive_streaming_emits_page1_before_pages_2_and_3() {
        let temp = tempfile::tempdir().unwrap();
        let total = PAGE_SIZE * 2 + 3;
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let page1_emitted = Arc::new(AtomicBool::new(false));
        let gate = page1_emitted.clone();

        let worker = thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = server.accept().unwrap();
                stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let req = read_http_request(&mut reader).unwrap();
                let line1 = req.lines().next().unwrap();
                let page_num: usize = if line1.contains("page=1&") {
                    1
                } else if line1.contains("page=2&") {
                    2
                } else {
                    3
                };
                if page_num > 1 {
                    let start = Instant::now();
                    while !gate.load(Ordering::Acquire) {
                        assert!(
                            start.elapsed() < Duration::from_secs(3),
                            "Page 1 callback did not fire before page {page_num}"
                        );
                        thread::sleep(Duration::from_millis(5));
                    }
                }
                let start_idx = (page_num - 1) * PAGE_SIZE;
                let count = if page_num < 3 { PAGE_SIZE } else { 3 };
                let items: Vec<_> = (start_idx..start_idx + count)
                    .map(|i| photo(format!("/photos/{i}.jpg")))
                    .collect();
                let body = gzip_bytes(
                    json!({
                        "page": page_num, "page_size": PAGE_SIZE, "total": total, "items": items
                    })
                    .to_string()
                    .as_bytes(),
                );
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nETag: \"cat-r1\"\r\nX-Catalog-Revision: r1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .unwrap();
                stream.write_all(&body).unwrap();
            }
        });

        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("k")).unwrap();
        let mut batches = Vec::new();
        let (all, write) = config
            .list_streaming_with_api(
                Some(temp.path()),
                temp.path(),
                true,
                || false,
                |imgs, seen, tot| {
                    if batches.is_empty() {
                        page1_emitted.store(true, Ordering::Release);
                    }
                    batches.push((imgs.len(), seen, tot));
                },
                &mut api,
            )
            .unwrap();
        worker.join().unwrap();
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0], (PAGE_SIZE * 2, PAGE_SIZE, Some(total)));
        assert_eq!(batches[2].1, total);
        assert_eq!(all.len(), total * 2);
        assert!(write.is_some());
    }

    #[test]
    fn concurrent_streaming_detects_revision_change_and_cancellation() {
        let temp = tempfile::tempdir().unwrap();
        let total = PAGE_SIZE * 2 + 1;
        let items_p1: Vec<_> = (0..PAGE_SIZE).map(|i| photo(format!("/photos/{i}.jpg"))).collect();
        let items_p2: Vec<_> = (PAGE_SIZE..PAGE_SIZE * 2)
            .map(|i| photo(format!("/photos/{i}.jpg")))
            .collect();
        let items_p3 = vec![photo(format!("/photos/{}.jpg", PAGE_SIZE * 2))];

        let (url, server1) = mock_raw(vec![
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("X-Catalog-Revision", "rev-a".into()),
                ],
                json!({"page": 1, "page_size": PAGE_SIZE, "total": total, "items": items_p1.clone()})
                    .to_string()
                    .into_bytes(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("X-Catalog-Revision", "rev-b".into()),
                ],
                json!({"page": 2, "page_size": PAGE_SIZE, "total": total, "items": items_p2})
                    .to_string()
                    .into_bytes(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("X-Catalog-Revision", "rev-a".into()),
                ],
                json!({"page": 3, "page_size": PAGE_SIZE, "total": total, "items": items_p3})
                    .to_string()
                    .into_bytes(),
            ),
        ]);

        let mut config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("k")).unwrap();
        let err = config
            .list_streaming_with_api(None, temp.path(), true, || false, |_, _, _| {}, &mut api)
            .err()
            .unwrap();
        assert!(err.contains("changed during pagination"), "{err}");
        server1.join().unwrap();

        // Cancellation after page 1 stops remaining pages cleanly.
        let (url2, server2) = mock_raw(vec![(
            200,
            vec![("Content-Type", "application/json".into())],
            json!({"page": 1, "page_size": PAGE_SIZE, "total": PAGE_SIZE * 3, "items": items_p1})
                .to_string()
                .into_bytes(),
        )]);
        config.url = url2;
        let cancel_flag = AtomicBool::new(false);
        let mut api2 = config.client(Some("k")).unwrap();
        let err = config
            .list_streaming_with_api(
                None,
                temp.path(),
                true,
                || cancel_flag.load(Ordering::Acquire),
                |_, _, _| cancel_flag.store(true, Ordering::Release),
                &mut api2,
            )
            .err()
            .unwrap();
        assert_eq!(err, "cancelled");
        server2.join().unwrap();
    }

    #[test]
    fn keyset_pagination_fallback_uses_cursor_and_skip_total() {
        let temp = tempfile::tempdir().unwrap();
        let (url, server) = mock_api(vec![
            (
                200,
                json!({
                    "items": [photo("/photos/1.jpg".into())],
                    "has_more": true,
                    "next_cursor": "cur-1"
                }),
            ),
            (
                200,
                json!({
                    "items": [photo("/photos/2.jpg".into())],
                    "has_more": false,
                    "next_cursor": null
                }),
            ),
        ]);
        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("k")).unwrap();
        let mut totals = Vec::new();
        let (images, _) = config
            .list_streaming_with_api(
                None,
                temp.path(),
                false,
                || false,
                |_, _, total| totals.push(total),
                &mut api,
            )
            .unwrap();
        assert_eq!(images.len(), 4);
        assert_eq!(totals, vec![None, None]);
        let requests = server.join().unwrap();
        assert!(requests[1].contains("cursor=cur-1"));
        assert!(requests[1].contains("skip_total=1"));
    }

    #[test]
    fn subfolder_cache_uses_etag_and_304_not_modified() {
        let temp = tempfile::tempdir().unwrap();
        let (url, server) = mock_raw(vec![
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("ETag", "\"sub-etag-1\"".into()),
                ],
                json!({"items": [{"path": "/photos/2026", "has_children": true}]})
                    .to_string()
                    .into_bytes(),
            ),
            (
                304,
                vec![("ETag", "\"sub-etag-1\"".into())],
                Vec::new(),
            ),
        ]);
        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        clear_caches(None);
        let mut api = config.client(Some("k")).unwrap();
        let first = config.subfolders_with_api(temp.path(), &mut api).unwrap();
        assert_eq!(first, vec![(temp.path().join("2026"), true)]);
        let second = config.subfolders_with_api(temp.path(), &mut api).unwrap();
        assert_eq!(second, vec![(temp.path().join("2026"), true)]);

        let requests = server.join().unwrap();
        assert!(!requests[0].to_ascii_lowercase().contains("if-none-match:"));
        assert!(requests[1].contains("if-none-match: \"sub-etag-1\""));
        clear_caches(None);
    }

    #[test]
    fn thumbnail_cache_uses_etag_304_and_refreshes_on_200() {
        let temp = tempfile::tempdir().unwrap();
        let caches = Caches::new(&temp.path().join("cache"));
        let photo_path = temp.path().join("mount/a.jpg");
        let jpg1 = vec![0xff, 0xd8, 0xff, 0xe0, 0x01];
        let jpg2 = vec![0xff, 0xd8, 0xff, 0xe0, 0x02];

        let (url, server) = mock_raw(vec![
            (
                200,
                vec![
                    ("Content-Type", "image/jpeg".into()),
                    ("ETag", "\"thumb-1\"".into()),
                ],
                jpg1.clone(),
            ),
            (
                304,
                vec![("ETag", "\"thumb-1\"".into())],
                Vec::new(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "image/jpeg".into()),
                    ("ETag", "\"thumb-2\"".into()),
                ],
                jpg2.clone(),
            ),
        ]);
        let config = Config {
            url,
            server_path: "/photos".into(),
            local_path: temp.path().join("mount").to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("k")).unwrap();

        assert_eq!(
            config.thumbnail_cached_with_api(&photo_path, &caches.morfphoto_thumbs, &mut api),
            Some(jpg1.clone())
        );
        assert_eq!(
            config.thumbnail_cached_with_api(&photo_path, &caches.morfphoto_thumbs, &mut api),
            Some(jpg1)
        );
        assert_eq!(
            config.thumbnail_cached_with_api(&photo_path, &caches.morfphoto_thumbs, &mut api),
            Some(jpg2)
        );

        let requests = server.join().unwrap();
        assert!(!requests[0].to_ascii_lowercase().contains("if-none-match:"));
        assert!(requests[1].contains("if-none-match: \"thumb-1\""));
        assert!(requests[2].contains("if-none-match: \"thumb-1\""));
    }

    #[test]
    fn catalog_available_and_catalog_revision_use_lightweight_gzip_requests() {
        let temp = tempfile::tempdir().unwrap();
        let status_body = gzip_bytes(
            json!({"catalog_revision": "abcdef0123456789"})
                .to_string()
                .as_bytes(),
        );
        let (url, server) = mock_raw(vec![
            (
                200,
                vec![("Content-Type", "application/json".into())],
                json!({"page": 1, "page_size": 1, "total": 42, "items": []})
                    .to_string()
                    .into_bytes(),
            ),
            (
                200,
                vec![
                    ("Content-Type", "application/json".into()),
                    ("Content-Encoding", "gzip".into()),
                ],
                status_body,
            ),
        ]);
        let config = Config {
            url,
            server_path: "/srv/photos".into(),
            local_path: temp.path().to_str().unwrap().into(),
            enabled: true,
        };
        let mut api = config.client(Some("k")).unwrap();
        config.catalog_available_with_api(temp.path(), &mut api).unwrap();
        assert_eq!(
            config.catalog_revision_with_api(&mut api).unwrap().as_deref(),
            Some("abcdef0123456789")
        );
        let requests = server.join().unwrap();
        assert!(requests[0].contains("page=1&page_size=1&folder_path=%2Fsrv%2Fphotos&recursive=true"));
        assert!(requests[0].to_ascii_lowercase().contains("accept-encoding: gzip"));
        assert!(requests[1].starts_with("GET /api/v1/index/status "));
        assert!(requests[1].to_ascii_lowercase().contains("accept-encoding: gzip"));
    }
}
