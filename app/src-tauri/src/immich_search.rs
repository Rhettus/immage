// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card: search, thumbnails and originals, with the
// client and key of immich_upload.rs. written against Immich 3.3's
// structured search filter (3.2 and later); blocking, callers run it off the
// async runtime
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::immich_upload::{status, Immich};

// what darktable opens as raw; Immich has no raw flag, so these go to the
// server as file name endings, upper and lower case
const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "dcr", "dcs", "dng", "erf", "fff", "iiq", "k25", "kdc",
    "mdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "ori", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf",
    "srw", "x3f",
];

// where Immich's paths are on this computer: an external library seen by
// the server as /mnt/photos may be /Volumes/photos here
#[derive(Deserialize, Clone, Default)]
pub struct PathMap {
    #[serde(default)]
    pub immich: String,
    #[serde(default)]
    pub local: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchArgs {
    // "smart" asks Immich's machine learning; "filename" matches the file
    // name or description
    pub mode: String,
    pub text: String,
    // "external" (any external library), "all", or a library id
    pub library: String,
    // YYYY-MM-DD, both inclusive
    pub taken_from: Option<String>,
    pub taken_to: Option<String>,
    pub min_rating: Option<u8>,
    pub favorites: bool,
    pub raw_only: bool,
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub person_ids: Vec<String>,
    pub tag_ids: Vec<String>,
    pub album_ids: Vec<String>,
    // from the previous page's reply
    pub next: Option<String>,
    pub size: Option<u32>,
}

impl SearchArgs {
    fn smart(&self) -> bool {
        // smart search needs words to look for; without them it is a plain
        // listing
        self.mode == "smart" && !self.text.trim().is_empty()
    }
}

fn some(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

// the day after a YYYY-MM-DD, so "taken to" includes the whole day
fn next_day(day: &str) -> Option<String> {
    let d = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    Some(d.succ_opt()?.format("%Y-%m-%d").to_string())
}

// Immich's SearchFilter for the args; the web app's search page takes the
// same object, so Show Results in Immich uses it too
pub fn filter(a: &SearchArgs) -> Value {
    let mut f = Map::new();
    f.insert("type".into(), json!({ "eq": "IMAGE" }));
    match a.library.as_str() {
        "all" => {}
        "" | "external" => { f.insert("libraryId".into(), json!({ "ne": null })); }
        id => { f.insert("libraryId".into(), json!({ "eq": id })); }
    }
    let mut taken = Map::new();
    if let Some(d) = some(&a.taken_from) {
        taken.insert("gte".into(), json!(format!("{d}T00:00:00.000Z")));
    }
    if let Some(d) = some(&a.taken_to).and_then(next_day) {
        taken.insert("lt".into(), json!(format!("{d}T00:00:00.000Z")));
    }
    if !taken.is_empty() {
        f.insert("takenAt".into(), Value::Object(taken));
    }
    if let Some(r) = a.min_rating.filter(|r| (1..=5).contains(r)) {
        f.insert("rating".into(), json!({ "gte": r }));
    }
    if a.favorites {
        f.insert("isFavorite".into(), json!({ "eq": true }));
    }
    for (key, v) in [("make", &a.make), ("model", &a.model), ("lensModel", &a.lens), ("country", &a.country),
                     ("city", &a.city)] {
        if let Some(v) = some(v) {
            f.insert(key.into(), json!({ "eq": v }));
        }
    }
    for (key, ids) in [("personIds", &a.person_ids), ("tagIds", &a.tag_ids), ("albumIds", &a.album_ids)] {
        if !ids.is_empty() {
            f.insert(key.into(), json!({ "all": ids }));
        }
    }

    // the filter has one level of "or": a file name search (name or
    // description) and raw only both need it, so every pairing of the two
    // becomes a branch
    let text = a.text.trim();
    let words: Vec<Value> = if a.mode != "smart" && !text.is_empty() {
        let like = format!("%{text}%");
        vec![json!({ "originalFileName": { "like": like } }), json!({ "description": { "like": like } })]
    } else {
        vec![json!({})]
    };
    let raws: Vec<Option<String>> = if a.raw_only {
        RAW_EXTENSIONS.iter().flat_map(|e| [format!(".{e}"), format!(".{}", e.to_uppercase())]).map(Some).collect()
    } else {
        vec![None]
    };
    let mut branches = Vec::new();
    for w in &words {
        for r in &raws {
            let mut b = w.clone();
            if let Some(ext) = r {
                b["originalFileName"]["endsWith"] = json!(ext);
            }
            if b.as_object().is_some_and(|o| !o.is_empty()) {
                branches.push(b);
            }
        }
    }
    match branches.len() {
        0 => {}
        // a single branch is plain AND
        1 => {
            for (k, v) in branches.remove(0).as_object().unwrap() {
                f.insert(k.clone(), v.clone());
            }
        }
        _ => { f.insert("or".into(), json!(branches)); }
    }
    Value::Object(f)
}

// a path as Immich has it, on this computer, when the file is there
pub fn local_path(original: &str, map: &PathMap) -> Option<PathBuf> {
    let from = map.immich.trim().trim_end_matches('/');
    let to = map.local.trim();
    if from.is_empty() || to.is_empty() {
        return None;
    }
    let rest = original.strip_prefix(from)?;
    // a whole folder name: /mnt/photos does not cover /mnt/photos2
    let rest = rest.strip_prefix('/')?;
    let p = Path::new(to).join(rest);
    p.is_file().then_some(p)
}

// asset ids name cache files, so nothing but a uuid's characters
pub fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(id)
    } else {
        Err(format!("Immich: not an asset id: {id}"))
    }
}

// what a filmstrip cell and the metadata panel need of an asset
fn asset(a: &Value, map: &PathMap) -> Value {
    let x = &a["exifInfo"];
    let path = a["originalPath"].as_str().unwrap_or("");
    json!({
        "id": a["id"],
        "name": a["originalFileName"],
        "path": path,
        "localPath": local_path(path, map),
        "date": a["localDateTime"],
        "rating": x["rating"].as_i64().unwrap_or(0).max(0),
        "favorite": a["isFavorite"].as_bool().unwrap_or(false),
        "width": x["exifImageWidth"].as_i64().or(a["width"].as_i64()).unwrap_or(0),
        "height": x["exifImageHeight"].as_i64().or(a["height"].as_i64()).unwrap_or(0),
        "exif": {
            "make": x["make"], "model": x["model"], "lens": x["lensModel"], "iso": x["iso"],
            "aperture": x["fNumber"], "exposure": x["exposureTime"], "focal": x["focalLength"],
            "datetime": x["dateTimeOriginal"],
        },
    })
}

impl Immich {
    // a GET with query parameters (reqwest's .query() needs a feature this
    // build does not enable)
    fn get_with<K: AsRef<str>, V: AsRef<str>>(&self, path: &str, q: &[(K, V)])
        -> Result<reqwest::blocking::Response, String> {
        let url = reqwest::Url::parse_with_params(&self.url(path), q.iter().map(|(k, v)| (k.as_ref(), v.as_ref())))
            .map_err(|e| e.to_string())?;
        status(self.http.get(url).send().map_err(|e| e.to_string())?)
    }

    // one page: { items, next } with next to pass back for the page after,
    // null at the end
    pub fn search(&self, a: &SearchArgs, map: &PathMap) -> Result<Value, String> {
        let size = a.size.unwrap_or(250).clamp(1, 1000);
        let mut body = json!({ "filter": filter(a), "size": size, "withExif": true });
        let path = if a.smart() {
            body["query"] = json!(a.text.trim());
            // smart search still pages by number, the metadata one by cursor
            if let Some(p) = a.next.as_deref().and_then(|p| p.parse::<u64>().ok()) {
                body["page"] = json!(p);
            }
            "/search/smart"
        } else {
            body["orderBy"] = json!({ "field": "localDateTime", "direction": "desc" });
            if let Some(c) = a.next.as_deref().filter(|c| !c.is_empty()) {
                body["cursor"] = json!(c);
            }
            "/search/metadata"
        };
        let r: Value = status(self.http.post(self.url(path)).json(&body).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let assets = &r["assets"];
        let items: Vec<Value> = assets["items"].as_array().map(|v| v.iter().map(|x| asset(x, map)).collect())
            .unwrap_or_default();
        let next = if a.smart() { &assets["nextPage"] } else { &assets["nextCursor"] };
        let next = match next {
            Value::String(s) if !s.is_empty() => json!(s),
            Value::Number(n) => json!(n.to_string()),
            _ => Value::Null,
        };
        Ok(json!({ "items": items, "next": next }))
    }

    // [{ id, name }] of the external libraries; reading them takes the
    // admin's library.read, so a key without it gets none, not an error
    pub fn libraries(&self) -> Result<Value, String> {
        let r = self.http.get(self.url("/libraries")).send().map_err(|e| e.to_string())?;
        if r.status() == reqwest::StatusCode::FORBIDDEN || r.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(json!([]));
        }
        let list: Value = status(r)?.json().map_err(|e| e.to_string())?;
        let mut libs: Vec<Value> = list.as_array().cloned().unwrap_or_default().iter()
            .map(|l| json!({ "id": l["id"], "name": l["name"] })).collect();
        libs.sort_by_key(|l| l["name"].as_str().unwrap_or("").to_lowercase());
        Ok(json!(libs))
    }

    // the values Immich knows for a field: country, state, city, camera-make,
    // camera-model or camera-lens-model, narrowed by the others given
    pub fn suggestions(&self, kind: &str, within: &Map<String, Value>) -> Result<Value, String> {
        let mut q: Vec<(String, String)> = vec![("type".into(), kind.into())];
        for (k, v) in within {
            if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                q.push((k.clone(), s.into()));
            }
        }
        let list: Value = self.get_with("/search/suggestions", &q)?.json().map_err(|e| e.to_string())?;
        let mut v: Vec<String> = list.as_array().cloned().unwrap_or_default().iter()
            .filter_map(|s| s.as_str().map(String::from)).filter(|s| !s.is_empty()).collect();
        v.sort_by_key(|s| s.to_lowercase());
        Ok(json!(v))
    }

    // [{ id, name }] of the named people, by name
    pub fn people(&self) -> Result<Value, String> {
        let mut out = Vec::new();
        for page in 1..=20 {
            let page = page.to_string();
            let r: Value = self.get_with("/people", &[("withHidden", "false"), ("size", "1000"), ("page", &page)])?
                .json().map_err(|e| e.to_string())?;
            out.extend(r["people"].as_array().cloned().unwrap_or_default().iter()
                .filter(|p| p["name"].as_str().is_some_and(|n| !n.is_empty()))
                .map(|p| json!({ "id": p["id"], "name": p["name"] })));
            if r["hasNextPage"] != json!(true) {
                break;
            }
        }
        out.sort_by_key(|p| p["name"].as_str().unwrap_or("").to_lowercase());
        Ok(json!(out))
    }

    // [{ id, name }] with a tag's full path as its name, by name
    pub fn tags(&self) -> Result<Value, String> {
        let list: Value = status(self.http.get(self.url("/tags")).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let mut v: Vec<Value> = list.as_array().cloned().unwrap_or_default().iter()
            .map(|t| json!({ "id": t["id"], "name": t["value"].as_str().or(t["name"].as_str()) })).collect();
        v.sort_by_key(|t| t["name"].as_str().unwrap_or("").to_lowercase());
        Ok(json!(v))
    }

    // Immich's small thumbnail, from the server; main.rs keeps it in the cache
    pub fn thumb(&self, id: &str) -> Result<Vec<u8>, String> {
        let r = self.get_with(&format!("/assets/{}/thumbnail", safe_id(id)?), &[("size", "thumbnail")])?;
        Ok(r.bytes().map_err(|e| e.to_string())?.to_vec())
    }

    // the original file, downloaded into cache/<id>/<name> unless already
    // there (the flag says which); written beside and renamed, so a broken
    // download is never taken for the file
    pub fn original(&self, id: &str, name: &str, cache: &Path) -> Result<(PathBuf, bool), String> {
        let dir = cache.join(safe_id(id)?);
        let name = Path::new(name).file_name().map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty()).unwrap_or_else(|| id.to_string());
        let file = dir.join(&name);
        if file.is_file() {
            return Ok((file, false));
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let mut r = status(self.http.get(self.url(&format!("/assets/{id}/original"))).send()
            .map_err(|e| e.to_string())?)?;
        let part = dir.join(format!("{name}.part"));
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        if let Err(e) = r.copy_to(&mut out) {
            let _ = std::fs::remove_file(&part);
            return Err(format!("Immich: download failed: {e}"));
        }
        drop(out);
        std::fs::rename(&part, &file).map_err(|e| e.to_string())?;
        Ok((file, true))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> Immich {
        Immich::new(&tauri_plugin_immporter::ImmichConnection {
            url: url.into(), api_key: "k".into(), accept_invalid_certs: false,
        }).unwrap()
    }

    fn test_dir(name: &str) -> PathBuf {
        // inside the build tree, not the system's temp folder
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn filter_defaults_to_external_photos() {
        let f = filter(&SearchArgs::default());
        assert_eq!(f, json!({ "type": { "eq": "IMAGE" }, "libraryId": { "ne": null } }));
        let f = filter(&SearchArgs { library: "all".into(), ..Default::default() });
        assert!(f.get("libraryId").is_none());
    }

    #[test]
    fn filter_fields() {
        let f = filter(&SearchArgs {
            library: "L".into(), taken_from: Some("2026-01-01".into()), taken_to: Some("2026-01-31".into()),
            min_rating: Some(3), favorites: true, make: Some("FUJIFILM".into()), lens: Some(" ".into()),
            person_ids: vec!["p".into()], ..Default::default()
        });
        assert_eq!(f["libraryId"], json!({ "eq": "L" }));
        assert_eq!(f["takenAt"], json!({ "gte": "2026-01-01T00:00:00.000Z", "lt": "2026-02-01T00:00:00.000Z" }));
        assert_eq!(f["rating"], json!({ "gte": 3 }));
        assert_eq!(f["isFavorite"], json!({ "eq": true }));
        assert_eq!(f["make"], json!({ "eq": "FUJIFILM" }));
        assert!(f.get("lensModel").is_none());
        assert_eq!(f["personIds"], json!({ "all": ["p"] }));
    }

    #[test]
    fn filename_and_raw_share_the_or() {
        let f = filter(&SearchArgs { mode: "filename".into(), text: "dsc".into(), ..Default::default() });
        assert_eq!(f["or"], json!([
            { "originalFileName": { "like": "%dsc%" } }, { "description": { "like": "%dsc%" } },
        ]));
        let f = filter(&SearchArgs { raw_only: true, ..Default::default() });
        assert_eq!(f["or"].as_array().unwrap().len(), RAW_EXTENSIONS.len() * 2);
        assert_eq!(f["or"][0], json!({ "originalFileName": { "endsWith": ".3fr" } }));
        let f = filter(&SearchArgs { mode: "filename".into(), text: "dsc".into(), raw_only: true, ..Default::default() });
        let or = f["or"].as_array().unwrap();
        assert_eq!(or.len(), RAW_EXTENSIONS.len() * 4);
        assert_eq!(or[0], json!({ "originalFileName": { "like": "%dsc%", "endsWith": ".3fr" } }));
        assert!(or.contains(&json!({ "description": { "like": "%dsc%" }, "originalFileName": { "endsWith": ".NEF" } })));
        // smart search words are the query, not a filter
        let f = filter(&SearchArgs { mode: "smart".into(), text: "beach".into(), ..Default::default() });
        assert!(f.get("or").is_none());
    }

    #[test]
    fn paths_map_to_this_computer() {
        let dir = test_dir("immich-path-map");
        std::fs::create_dir_all(dir.join("2026")).unwrap();
        std::fs::write(dir.join("2026/a.raf"), b"x").unwrap();
        let map = PathMap { immich: "/mnt/photos/".into(), local: dir.to_string_lossy().into() };
        assert_eq!(local_path("/mnt/photos/2026/a.raf", &map), Some(dir.join("2026/a.raf")));
        assert_eq!(local_path("/mnt/photos/2026/b.raf", &map), None);
        assert_eq!(local_path("/mnt/photos2/2026/a.raf", &map), None);
        assert_eq!(local_path("/mnt/photos/2026/a.raf", &PathMap::default()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_pages_and_maps_assets() {
        let mut server = mockito::Server::new();
        let _meta = server.mock("POST", "/api/search/metadata").match_header("x-api-key", "k")
            .match_body(mockito::Matcher::PartialJson(json!({ "cursor": "c1", "withExif": true, "size": 250 })))
            .with_body(r#"{"albums":{},"assets":{"items":[{"id":"a1","originalFileName":"A.RAF",
                "originalPath":"/nas/A.RAF","localDateTime":"2026-10-05T06:50:16.000Z","isFavorite":true,
                "width":6000,"height":4000,"exifInfo":{"rating":4,"make":"FUJIFILM","fNumber":2.8}}],
                "nextCursor":"c2"}}"#).create();
        let _smart = server.mock("POST", "/api/search/smart")
            .match_body(mockito::Matcher::PartialJson(json!({ "query": "beach", "page": 2 })))
            .with_body(r#"{"albums":{},"assets":{"items":[],"nextPage":null}}"#).create();
        let c = client(&server.url());
        let r = c.search(&SearchArgs { next: Some("c1".into()), ..Default::default() }, &PathMap::default()).unwrap();
        assert_eq!(r["next"], "c2");
        let a = &r["items"][0];
        assert_eq!((a["id"].as_str(), a["name"].as_str(), a["rating"].as_i64()), (Some("a1"), Some("A.RAF"), Some(4)));
        assert_eq!((a["width"].as_i64(), a["exif"]["aperture"].as_f64()), (Some(6000), Some(2.8)));
        assert_eq!(a["localPath"], Value::Null);
        let r = c.search(&SearchArgs { mode: "smart".into(), text: "beach".into(), next: Some("2".into()),
                                       ..Default::default() }, &PathMap::default()).unwrap();
        assert_eq!(r["next"], Value::Null);
    }

    #[test]
    fn libraries_without_permission_are_none() {
        let mut server = mockito::Server::new();
        let _l = server.mock("GET", "/api/libraries").with_status(403).with_body(r#"{"message":"Missing permission"}"#)
            .create();
        assert_eq!(client(&server.url()).libraries().unwrap(), json!([]));
    }

    #[test]
    fn thumbs_and_cached_originals() {
        let dir = test_dir("immich-cache");
        let mut server = mockito::Server::new();
        let thumb = server.mock("GET", "/api/assets/ab-12/thumbnail")
            .match_query(mockito::Matcher::UrlEncoded("size".into(), "thumbnail".into()))
            .with_body("webp").expect(1).create();
        let orig = server.mock("GET", "/api/assets/ab-12/original").with_body("raw bytes").expect(1).create();
        let c = client(&server.url());
        assert_eq!(c.thumb("ab-12").unwrap(), b"webp");
        thumb.assert();
        let (f, fresh) = c.original("ab-12", "../A.RAF", &dir.join("o")).unwrap();
        assert!(fresh);
        assert_eq!(f, dir.join("o/ab-12/A.RAF"));
        assert_eq!(c.original("ab-12", "A.RAF", &dir.join("o")).unwrap(), (f.clone(), false));
        assert_eq!(std::fs::read(&f).unwrap(), b"raw bytes");
        orig.assert();
        assert!(c.thumb("../x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
