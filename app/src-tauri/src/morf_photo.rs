// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::typed_library::LibraryImage;
use reqwest::{blocking::Client, header::HeaderValue, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::Read,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

pub(crate) const SETTINGS: &str = "native.morfphoto";
const PAGE_SIZE: usize = 500;
const MAX_PAGE_BYTES: u64 = 16 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const LIST_TIMEOUT: Duration = Duration::from_secs(25);
const THUMBNAIL_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;

#[derive(Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Config {
    pub enabled: bool,
    pub url: String,
    pub server_path: String,
    pub local_path: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct Credential {
    pub origin: String,
    pub key: String,
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

    fn client(&self, key: Option<&str>) -> Result<Api, String> {
        let endpoint = self.endpoint()?;
        let stored;
        let key = match key {
            Some(key) => key,
            None => {
                stored = credential(&entry()?)?
                    .filter(|value| value.origin == endpoint.origin().ascii_serialization())
                    .ok_or("morfPhoto API key is required for this server")?;
                &stored.key
            }
        };
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", key.trim()))
            .map_err(|_| "Invalid morfPhoto API key")?;
        if key.trim().is_empty() {
            return Err("morfPhoto API key is required".into());
        }
        auth.set_sensitive(true);
        let client = Client::builder()
            .connect_timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Could not create morfPhoto client")?;
        Ok(Api {
            client,
            endpoint,
            auth,
        })
    }

    pub(crate) fn test(&self, key: Option<&str>) -> Result<(), String> {
        self.client(key)?.page(None, false, 1, 1, REQUEST_TIMEOUT)?;
        Ok(())
    }

    pub(crate) fn thumbnail(&self, path: &Path) -> Option<Vec<u8>> {
        if !self.covers(path) {
            return None;
        }
        let server_path = self.server_folder(path).ok()?;
        self.client(None).ok()?.thumbnail(&server_path)
    }

    pub(crate) fn list(
        &self,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool,
    ) -> Result<Vec<LibraryImage>, String> {
        self.list_with_api(path, recursive, cancelled, self.client(None)?)
    }

    pub(crate) fn metrics(&self) -> Result<Value, String> {
        let api = self.client(None)?;
        let mut url = api.endpoint.clone();
        url.path_segments_mut().map_err(|_| "Invalid morfPhoto endpoint")?
            .pop().extend(["index", "status"]);
        let response = api.client.get(url)
            .header(reqwest::header::AUTHORIZATION, api.auth)
            .timeout(REQUEST_TIMEOUT)
            .send().and_then(|response| response.error_for_status())
            .map_err(|_| "morfPhoto index status unavailable")?;
        serde_json::from_reader(response.take(65536)).map_err(|_| "Invalid morfPhoto index status".into())
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
        let api = self.client(None)?;
        let mut url = api.endpoint.clone();
        url.path_segments_mut().map_err(|_| "Invalid morfPhoto endpoint")?
            .pop().extend(["search", "semantic"]);
        let f = &args.filters;
        let next = args.next.as_deref().map(|cursor| {
            cursor.strip_prefix("morfphoto:").ok_or("Local search cursor")
        }).transpose()?;
        let response = api.client.post(url)
            .header(reqwest::header::AUTHORIZATION, api.auth)
            .timeout(Duration::from_secs(9))
            .json(&json!({
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
            }))
            .send().and_then(|response| response.error_for_status())
            .map_err(|_| "morfPhoto semantic search unavailable")?;
        let mut body = Vec::new();
        response.take(MAX_PAGE_BYTES + 1).read_to_end(&mut body).map_err(|e| e.to_string())?;
        if body.len() as u64 > MAX_PAGE_BYTES {
            return Err("morfPhoto semantic reply too large".into());
        }
        let reply: Reply = serde_json::from_slice(&body).map_err(|e| e.to_string())?;
        let mut items = Vec::new();
        for hit in reply.items {
            let mapped = self.local_file(&hit.photo.path)?;
            if !mapped.starts_with(folder) || (!args.recursive && mapped.parent() != Some(folder)) {
                return Err("morfPhoto semantic result outside scope".into());
            }
            if !crate::library_cmds::photo_candidate(&mapped) {
                continue;
            }
            if let Some(image) = hit.photo.images(&mapped)?.into_iter().find(|i| i.version == 0) {
                items.push(LocalHit {
                    asset_id: None, variant_id: None, subject: "original".into(),
                    score: hit.score, image,
                });
            }
        }
        Ok((LocalPage { items, next: reply.next.map(|cursor| format!("morfphoto:{cursor}")),
            revision: reply.revision }, reply.indexed, reply.eligible))
    }

    fn list_with_api(
        &self,
        path: &Path,
        recursive: bool,
        cancelled: impl Fn() -> bool,
        api: Api,
    ) -> Result<Vec<LibraryImage>, String> {
        let server_folder = self.server_folder(path)?;
        let folder = (server_folder != "/" || !recursive).then_some(server_folder.as_str());
        let deadline = Instant::now() + LIST_TIMEOUT;
        let mut images = Vec::new();
        let mut seen = HashSet::new();
        let mut total = None;
        for page in 1..=1_000_000 {
            if cancelled() {
                return Err("cancelled".into());
            }
            let timeout = deadline
                .saturating_duration_since(Instant::now())
                .min(REQUEST_TIMEOUT);
            if timeout.is_zero() {
                return Err("morfPhoto listing timed out".into());
            }
            let reply = api.page(folder, recursive, page, PAGE_SIZE, timeout)?;
            if total.get_or_insert(reply.total) != &reply.total
                || reply.items.len() != reply.total.saturating_sub(seen.len()).min(PAGE_SIZE)
            {
                return Err("morfPhoto listing changed during pagination".into());
            }
            for item in reply.items {
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
                images.extend(item.images(&mapped)?);
            }
            if seen.len() == reply.total {
                return Ok(images);
            }
        }
        Err("morfPhoto listing exceeded its page limit".into())
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
    client: Client,
    endpoint: Url,
    auth: HeaderValue,
}

#[derive(Deserialize)]
struct Page {
    items: Vec<Photo>,
    total: usize,
    page: usize,
    page_size: usize,
}

impl Api {
    fn thumbnail(&self, server_path: &str) -> Option<Vec<u8>> {
        let mut url = self.endpoint.clone();
        url.path_segments_mut().ok()?.pop().extend(["thumbnail", "cached"]);
        url.query_pairs_mut().append_pair("path", server_path);
        let query = url.query()?.replace('+', "%20");
        url.set_query(Some(&query));
        let response = self.client.get(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.clone())
            .timeout(THUMBNAIL_TIMEOUT)
            .send().ok()?.error_for_status().ok()?;
        if response.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()? != "image/jpeg" {
            return None;
        }
        let mut bytes = Vec::new();
        response.take(MAX_THUMBNAIL_BYTES + 1).read_to_end(&mut bytes).ok()?;
        (bytes.len() as u64 <= MAX_THUMBNAIL_BYTES && bytes.starts_with(&[0xff, 0xd8]))
            .then_some(bytes)
    }

    fn page(
        &self,
        folder: Option<&str>,
        recursive: bool,
        page: usize,
        size: usize,
        timeout: Duration,
    ) -> Result<Page, String> {
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
        // QUrlQuery interprets a literal '+' as a plus, including in folder names.
        let query = url.query().unwrap_or_default().replace('+', "%20");
        url.set_query(Some(&query));
        let response = self
            .client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, self.auth.clone())
            .timeout(timeout)
            .send()
            .map_err(|_| "morfPhoto request failed")?;
        if !response.status().is_success() {
            return Err(format!(
                "morfPhoto returned HTTP {}",
                response.status().as_u16()
            ));
        }
        let mut bytes = Vec::new();
        response
            .take(MAX_PAGE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read morfPhoto library response")?;
        if bytes.len() as u64 > MAX_PAGE_BYTES {
            return Err("morfPhoto response exceeded its size limit".into());
        }
        let reply: Page =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid morfPhoto library response")?;
        if reply.page != page || reply.page_size != size || reply.items.len() > size {
            return Err("Invalid morfPhoto pagination".into());
        }
        Ok(reply)
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
        self.versions.into_iter().map(|version| {
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
                self.exif.get("mtime").and_then(Value::as_i64)
                    .filter(|mtime| *mtime > 0)
                    .and_then(|mtime| chrono::DateTime::from_timestamp(mtime, 0))
                    .map(|mtime| mtime.with_timezone(&chrono::Local).format("%Y:%m:%d %H:%M:%S").to_string())
                    .unwrap_or_default()
            } else {
                String::new()
            };
            let location = version.latitude.zip(version.longitude)
                .filter(|(lat, lon)| lat.abs() <= 90.0 && lon.abs() <= 180.0)
                .map(|(latitude, longitude)| json!({ "latitude": latitude, "longitude": longitude }));
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
            })).map_err(|_| "Invalid morfPhoto metadata".into())
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        net::TcpListener,
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

    fn mock_api(responses: Vec<(u16, Value)>) -> (String, thread::JoinHandle<Vec<String>>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let handle = thread::spawn(move || {
            responses.into_iter().map(|(status, response)| {
                let (mut stream, _) = server.accept().unwrap();
                stream.set_read_timeout(Some(REQUEST_TIMEOUT)).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                let body = response.to_string();
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                request
            }).collect()
        });
        (url, handle)
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
            let mut request = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                    break;
                }
                request.push_str(&line);
            }
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
        assert_eq!(list(&config).err().unwrap(), "morfPhoto returned HTTP 503");
        assert_eq!(failing_server.join().unwrap().len(), 2);
    }
}
