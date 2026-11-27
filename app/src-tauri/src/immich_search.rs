// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Library panel's Immich card: search, thumbnails and originals, with the
// client and key of immich_upload.rs. written against Immich 3.3's
// structured search filter (3.2 and later); blocking, callers run it off the
// async runtime
use std::path::{Path, PathBuf};

use serde::Deserialize;
use specta::Type;
use serde_json::{json, Map, Value};

use crate::immich_upload::{status, Immich};
use crate::typed_app::{Asset, AssetExif, Named, SearchPage};

// what darktable opens as raw; Immich has no raw flag, so these go to the
// server as file name endings, upper and lower case
pub const RAW_EXTENSIONS: &[&str] = &[
    "3fr", "ari", "arw", "bay", "cr2", "cr3", "crw", "dcr", "dcs", "dng", "erf", "fff", "iiq", "k25", "kdc",
    "mdc", "mef", "mos", "mrw", "nef", "nrw", "orf", "ori", "pef", "raf", "raw", "rw2", "rwl", "sr2", "srf",
    "srw", "x3f",
];

// where Immich's paths are on this computer: an external library seen by
// the server as /mnt/photos may be /Volumes/photos here
#[derive(Deserialize, Clone, Default, Type)]
pub struct PathMap {
    #[serde(default)]
    pub immich: String,
    #[serde(default)]
    pub local: String,
}

#[derive(serde::Serialize, Deserialize, Clone, Default, Type)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
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
    // search includes the trash, where Immich puts external-library photos
    // that are gone from disk; they cannot be opened
    f.insert("trashedAt".into(), json!({ "eq": null }));
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

// A path on the Immich server, split into its root and components. The server
// is usually POSIX but may be Windows, and this computer may be either, so the
// host's Path rules cannot judge it: "/photos" is not absolute on Windows.
// Both separators are accepted. The root is "/", a drive ("C:", any case), or
// "\\" for UNC; a relative path has none.
pub(crate) fn server_path(p: &str) -> Option<(String, Vec<&str>)> {
    let b = p.as_bytes();
    let (root, rest) = if b.len() >= 2 && (p.starts_with("\\\\") || p.starts_with("//")) {
        ("\\\\".to_string(), &p[2..])
    } else if p.starts_with('/') || p.starts_with('\\') {
        ("/".to_string(), &p[1..])
    } else if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\') {
        (p[..2].to_ascii_uppercase(), &p[3..])
    } else {
        return None;
    };
    let parts = rest.split(['/', '\\']).filter(|c| !c.is_empty()).collect();
    Some((root, parts))
}

/// Reverse of `local_path`: translate a local directory inside `map.local`
/// into the corresponding Immich server folder prefix with a trailing separator
/// so prefix filters never match sibling directories.
pub(crate) fn local_to_server_folder(
    folder: &Path,
    map: &PathMap,
    canonical_local: Option<&Path>,
) -> Option<String> {
    let local_root = Path::new(map.local.trim());
    let server_raw = map.immich.trim();
    let (server_root, _) = server_path(server_raw)?;
    if !local_root.is_absolute() || !folder.is_absolute() {
        return None;
    }
    let relative = folder
        .strip_prefix(local_root)
        .ok()
        .or_else(|| canonical_local.and_then(|c| folder.strip_prefix(c).ok()))?;
    let sep = if server_root == "\\\\" || (server_root != "/" && server_raw.contains('\\')) {
        '\\'
    } else {
        '/'
    };
    let mut out = server_raw.trim_end_matches(['/', '\\']).to_string();
    for part in relative.components() {
        let std::path::Component::Normal(name) = part else {
            return None;
        };
        let name = name.to_str()?;
        if name.contains(['/', '\\', '\0']) {
            return None;
        }
        out.push(sep);
        out.push_str(name);
    }
    out.push(sep);
    Some(out)
}

// a path as Immich has it, on this computer, when the file is there
pub fn local_path(original: &str, map: &PathMap) -> Option<PathBuf> {
    let to = Path::new(map.local.trim());
    let (from_root, from) = server_path(map.immich.trim())?;
    if !to.is_absolute() || from.is_empty() {
        return None;
    }
    // Component matching avoids string-prefix mistakes such as mapping
    // /mnt/photos2 through /mnt/photos. Only ordinary names are accepted below
    // the mapped root.
    let (root, parts) = server_path(original.trim())?;
    if root != from_root || parts.len() <= from.len() || parts[..from.len()] != from[..] {
        return None;
    }
    let mut rest = PathBuf::new();
    for c in &parts[from.len()..] {
        if matches!(*c, "." | "..") {
            return None;
        }
        rest.push(c);
    }
    if rest.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return None;
    }

    // Canonicalize both sides so a symlink inside the mapped tree cannot
    // expose a file outside it. Existence alone does not establish that this
    // file has the same contents as the Immich asset.
    let root = std::fs::canonicalize(to).ok()?;
    let candidate = std::fs::canonicalize(root.join(rest)).ok()?;
    if !candidate.starts_with(&root) || !candidate.is_file() {
        return None;
    }
    Some(candidate)
}

// asset ids name cache files, so nothing but a uuid's characters
pub fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(id)
    } else {
        Err(format!("Immich: not an asset id: {id}"))
    }
}

// a text field as the page shows it: Immich sends some numbers as text and
// some text as numbers, and either is kept
fn text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn number(v: &Value) -> Option<serde_json::Number> {
    v.as_number().cloned()
}

fn named(id: &Value, name: &Value) -> Named {
    Named { id: id.as_str().unwrap_or("").into(), name: name.as_str().unwrap_or("").into() }
}

// what a filmstrip cell and the metadata panel need of an asset
fn asset(a: &Value, map: &PathMap) -> Asset {
    let x = &a["exifInfo"];
    let path = a["originalPath"].as_str().unwrap_or("");
    Asset {
        id: a["id"].as_str().unwrap_or("").into(),
        name: a["originalFileName"].as_str().unwrap_or("").into(),
        path: path.into(),
        local_path: local_path(path, map).map(|p| p.to_string_lossy().into_owned()),
        date: text(&a["localDateTime"]),
        rating: x["rating"].as_i64().unwrap_or(0).max(0),
        favorite: a["isFavorite"].as_bool().unwrap_or(false),
        width: x["exifImageWidth"].as_i64().or(a["width"].as_i64()).unwrap_or(0),
        height: x["exifImageHeight"].as_i64().or(a["height"].as_i64()).unwrap_or(0),
        exif: AssetExif {
            make: text(&x["make"]), model: text(&x["model"]), lens: text(&x["lensModel"]), iso: number(&x["iso"]),
            aperture: number(&x["fNumber"]), exposure: text(&x["exposureTime"]), focal: number(&x["focalLength"]),
            datetime: text(&x["dateTimeOriginal"]),
        },
    }
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
    pub fn search(&self, a: &SearchArgs, map: &PathMap) -> Result<SearchPage, String> {
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
        // the filter already leaves the trash out; a trashed asset that slips
        // through would open as a 404
        let items: Vec<Asset> = assets["items"].as_array()
            .map(|v| v.iter().filter(|x| x["isTrashed"] != true).map(|x| asset(x, map)).collect())
            .unwrap_or_default();
        let next = if a.smart() { &assets["nextPage"] } else { &assets["nextCursor"] };
        let next = match next {
            Value::String(s) if !s.is_empty() => Some(s.clone()),
            Value::Number(n) => Some(n.to_string()),
            _ => None,
        };
        Ok(SearchPage { items, next })
    }

    // [{ id, name }] of the external libraries; reading them takes the
    // admin's library.read, so a key without it gets none, not an error
    pub fn libraries(&self) -> Result<Vec<Named>, String> {
        let r = self.http.get(self.url("/libraries")).send().map_err(|e| e.to_string())?;
        if r.status() == reqwest::StatusCode::FORBIDDEN || r.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(Vec::new());
        }
        let list: Value = status(r)?.json().map_err(|e| e.to_string())?;
        let mut libs: Vec<Named> = list.as_array().cloned().unwrap_or_default().iter()
            .map(|l| named(&l["id"], &l["name"])).collect();
        libs.sort_by_key(|l| l.name.to_lowercase());
        Ok(libs)
    }

    // the values Immich knows for a field: country, state, city, camera-make,
    // camera-model or camera-lens-model, narrowed by the others given
    pub fn suggestions(&self, kind: &str, within: &Map<String, Value>) -> Result<Vec<String>, String> {
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
        Ok(v)
    }

    // the named people, by name
    pub fn people(&self) -> Result<Vec<Named>, String> {
        let mut out = Vec::new();
        for page in 1..=20 {
            let page = page.to_string();
            let r: Value = self.get_with("/people", &[("withHidden", "false"), ("size", "1000"), ("page", &page)])?
                .json().map_err(|e| e.to_string())?;
            out.extend(r["people"].as_array().cloned().unwrap_or_default().iter()
                .filter(|p| p["name"].as_str().is_some_and(|n| !n.is_empty()))
                .map(|p| named(&p["id"], &p["name"])));
            if r["hasNextPage"] != json!(true) {
                break;
            }
        }
        out.sort_by_key(|p| p.name.to_lowercase());
        Ok(out)
    }

    // a tag's full path as its name, by name
    pub fn tags(&self) -> Result<Vec<Named>, String> {
        let list: Value = status(self.http.get(self.url("/tags")).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let mut v: Vec<Named> = list.as_array().cloned().unwrap_or_default().iter()
            .map(|t| Named {
                id: t["id"].as_str().unwrap_or("").into(),
                name: t["value"].as_str().or(t["name"].as_str()).unwrap_or("").into(),
            }).collect();
        v.sort_by_key(|t| t.name.to_lowercase());
        Ok(v)
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

    // what a move needs of an asset before downloading it (move_cmds.rs):
    // its file name, size, and the SHA-1 of its content (base64) when the
    // server has one. an external library's asset may carry a checksum of
    // its path rather than its content, so only uploaded assets give one
    pub fn original_info(&self, id: &str) -> Result<OriginalInfo, String> {
        let r = status(self.http.get(self.url(&format!("/assets/{}", safe_id(id)?))).send()
            .map_err(|e| e.to_string())?)?;
        let a: Value = r.json().map_err(|e| format!("Immich: unexpected reply: {e}"))?;
        let name = a["originalFileName"].as_str().map(|n| Path::new(n).file_name()
            .map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()).filter(|n| !n.is_empty())
            .unwrap_or_else(|| id.to_string());
        let uploaded = a["libraryId"].is_null();
        Ok(OriginalInfo {
            name,
            size: a["exifInfo"]["fileSizeInByte"].as_u64(),
            checksum: a["checksum"].as_str().filter(|_| uploaded).map(str::to_string),
        })
    }

    // the original's bytes, to stream into a file of the caller's
    pub fn original_stream(&self, id: &str) -> Result<reqwest::blocking::Response, String> {
        status(self.http.get(self.url(&format!("/assets/{}/original", safe_id(id)?))).send()
            .map_err(|e| e.to_string())?)
    }

    /// Whether this Immich server answers, has Smart Search (CLIP) enabled,
    /// and accepts our API key with `asset.read`.
    pub fn smart_search_available(&self) -> Result<bool, String> {
        let resp = self
            .http
            .get(self.url("/server/features"))
            .send()
            .map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            // Fallback for future Immich versions that drop deprecated /server/features
            status(
                self.http
                    .get(self.url("/server/ping"))
                    .send()
                    .map_err(|e| e.to_string())?,
            )?;
        } else {
            let features: Value = status(resp)?.json().map_err(|e| e.to_string())?;
            if features.get("smartSearch").and_then(Value::as_bool) == Some(false) {
                return Ok(false);
            }
        }
        let missing = self.lacks(&["asset.read"])?;
        Ok(missing.is_empty())
    }

    /// Run Immich Smart Search scoped to a local mapped directory, returning
    /// local `LibraryImage` hits enriched with any cached local metadata and
    /// filtered by `args.filters`.
    #[allow(clippy::too_many_arguments)]
    pub fn smart_in_folder(
        &self,
        folder: &Path,
        recursive: bool,
        hidden: &[PathBuf],
        excluded: &[PathBuf],
        map: &PathMap,
        canonical_local: Option<&Path>,
        args: &crate::local_search::LocalSearchArgs,
        cache: &crate::search_cache::SearchCache,
        cancelled: impl Fn() -> bool,
    ) -> Result<crate::local_search::LocalPage, String> {
        use crate::local_search::{LocalHit, LocalPage};
        const MAX_PAGES: usize = 4;

        let mut start_page: u64 = 1;
        if let Some(cursor) = args.next.as_deref() {
            let page = cursor
                .strip_prefix("immich:")
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|p| *p >= 1)
                .ok_or("Invalid Immich search cursor")?;
            start_page = page;
        }

        let mut immich_args = args.remote.clone();
        immich_args.mode = "smart".into();
        immich_args.text = args.text.clone();
        if immich_args.library.is_empty() {
            immich_args.library = "external".into();
        }
        if args.filters.min_rating > 0 {
            immich_args.min_rating = Some(
                immich_args
                    .min_rating
                    .unwrap_or(0)
                    .max(args.filters.min_rating),
            );
        }
        if immich_args.taken_from.as_deref().unwrap_or("").is_empty()
            && !args.filters.taken_from.is_empty()
        {
            immich_args.taken_from = Some(args.filters.taken_from.clone());
        }
        if immich_args.taken_to.as_deref().unwrap_or("").is_empty()
            && !args.filters.taken_to.is_empty()
        {
            immich_args.taken_to = Some(args.filters.taken_to.clone());
        }
        if args.filters.kinds.len() == 1 && args.filters.kinds[0] == "RAW" {
            immich_args.raw_only = true;
        }

        // A server timestamp can use a different offset than the capture
        // clock. Apply minute bounds to the enriched local hit instead.
        let mut local_capture = SearchArgs::default();
        if immich_args.taken_from.as_ref().is_some_and(|bound| bound.len() > 10) {
            immich_args.taken_from = None;
            local_capture.taken_from = args.remote.taken_from.clone();
        }
        if immich_args.taken_to.as_ref().is_some_and(|bound| bound.len() > 10) {
            immich_args.taken_to = None;
            local_capture.taken_to = args.remote.taken_to.clone();
        }

        let needs_local_capture = args.filters.taken_from.len() > 10 || args.filters.taken_to.len() > 10
            || local_capture.taken_from.is_some() || local_capture.taken_to.is_some();

        let server_prefix = local_to_server_folder(folder, map, canonical_local);
        let canonical_folder = crate::volumes::answering(folder)
            .then(|| std::fs::canonicalize(folder).ok())
            .flatten()
            .filter(|c| c != folder);

        let needed = args.size as usize + 1;
        let mut hits: Vec<LocalHit> = Vec::new();
        let mut seen_paths = std::collections::HashSet::new();
        let mut use_path_filter = server_prefix.is_some();
        let mut current_page = start_page;
        let mut next_server_page: Option<u64> = None;
        let mut rank: usize = ((start_page.saturating_sub(1)) as usize).saturating_mul(250);

        for _ in 0..MAX_PAGES {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            let mut f = filter(&immich_args);
            if use_path_filter {
                if let (Some(prefix), Some(obj)) = (server_prefix.as_deref(), f.as_object_mut()) {
                    obj.insert("originalPath".into(), json!({ "startsWith": prefix }));
                }
            }
            let body = json!({
                "filter": f,
                "query": immich_args.text.trim(),
                "page": current_page,
                "size": 250,
                "withExif": true,
            });
            let response = self
                .http
                .post(self.url("/search/smart"))
                .json(&body)
                .send()
                .map_err(|e| e.to_string())?;
            let response = match status(response) {
                Ok(ok) => ok,
                Err(err)
                    if use_path_filter
                        && err.starts_with("Immich: 400")
                        && err.contains("originalPath") =>
                {
                    // Defensive compatibility if a server rejects originalPath in SearchFilter.
                    use_path_filter = false;
                    let fallback_body = json!({
                        "filter": filter(&immich_args),
                        "query": immich_args.text.trim(),
                        "page": current_page,
                        "size": 250,
                        "withExif": true,
                    });
                    status(
                        self.http
                            .post(self.url("/search/smart"))
                            .json(&fallback_body)
                            .send()
                            .map_err(|e| e.to_string())?,
                    )?
                }
                Err(err) => return Err(err),
            };
            if cancelled() {
                return Err("Search cancelled".into());
            }
            let r: Value = response.json().map_err(|e| e.to_string())?;
            let assets = &r["assets"];
            let items = assets["items"].as_array().cloned().unwrap_or_default();
            for raw_asset in items {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                if raw_asset["isTrashed"] == true {
                    continue;
                }
                let mapped_asset = asset(&raw_asset, map);
                let Some(local_str) = mapped_asset.local_path.as_deref() else {
                    continue;
                };
                let local_p = Path::new(local_str);
                let in_folder = if recursive {
                    local_p.starts_with(folder)
                        || canonical_folder
                            .as_deref()
                            .is_some_and(|c| local_p.starts_with(c))
                } else {
                    local_p.parent() == Some(folder)
                        || canonical_folder
                            .as_deref()
                            .is_some_and(|c| local_p.parent() == Some(c))
                };
                if !in_folder
                    || hidden.iter().any(|h| local_p.starts_with(h))
                    || excluded.iter().any(|ex| local_p.starts_with(ex))
                    || !crate::library_cmds::photo_candidate(local_p)
                {
                    continue;
                }
                if !seen_paths.insert(local_str.to_string()) {
                    continue;
                }
                let (image, capture, asset_id, variant_id) =
                    enrich_immich_hit(cache, local_str, &mapped_asset);
                // The server fallback has no local GPS metadata and its date
                // can be the upload date. Only a cached photo is authoritative.
                if variant_id.is_none() && (args.filters.gps == "none" || needs_local_capture) {
                    continue;
                }
                if !crate::search_filters::passes(
                    &image,
                    capture.as_deref(),
                    &args.filters,
                    &local_capture,
                ) {
                    continue;
                }
                rank += 1;
                let score = 1.0 / (60.0 + rank as f64);
                hits.push(LocalHit {
                    asset_id,
                    variant_id,
                    subject: "original".into(),
                    score,
                    image,
                });
                if hits.len() >= needed {
                    break;
                }
            }
            let next_raw = match &assets["nextPage"] {
                Value::String(s) => s.parse::<u64>().ok(),
                Value::Number(n) => n.as_u64(),
                _ => None,
            };
            next_server_page = next_raw.filter(|p| *p > current_page);
            if hits.len() >= needed || next_server_page.is_none() {
                break;
            }
            current_page = next_server_page.unwrap();
        }

        let has_more = hits.len() > args.size as usize || next_server_page.is_some();
        hits.truncate(args.size as usize);
        let next = if has_more {
            next_server_page.map(|p| format!("immich:{p}"))
        } else {
            None
        };
        Ok(LocalPage {
            items: hits,
            next,
            revision: "immich".into(),
        })
    }
}

fn parse_exposure_seconds(raw: Option<&str>) -> serde_json::Number {
    let val = raw
        .and_then(|s| {
            let trimmed = s.trim();
            if let Some((a, b)) = trimmed.split_once('/') {
                let num = a.trim().parse::<f64>().ok()?;
                let den = b.trim().parse::<f64>().ok()?;
                (den != 0.0).then_some(num / den)
            } else {
                trimmed.parse::<f64>().ok()
            }
        })
        .filter(|v| v.is_finite() && *v >= 0.0)
        .unwrap_or(0.0);
    serde_json::Number::from_f64(val).unwrap_or_else(|| serde_json::Number::from(0))
}

fn immich_datetime(raw: Option<&str>) -> String {
    let s = raw.unwrap_or("").trim();
    if s.len() >= 19 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' {
        format!(
            "{} {}",
            s[..10].replace('-', ":"),
            &s[11..19]
        )
    } else {
        s.to_string()
    }
}

fn asset_to_library_image(local_path: &str, a: &Asset) -> crate::typed_library::LibraryImage {
    let filename = Path::new(local_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&a.name)
        .to_string();
    let zero = || serde_json::Number::from(0);
    crate::typed_library::LibraryImage {
        imgid: 0,
        path: local_path.to_string(),
        filename,
        rating: a.rating.clamp(0, 5) as u8,
        rejected: false,
        labels: 0,
        edited: false,
        width: u32::try_from(a.width).unwrap_or(0),
        height: u32::try_from(a.height).unwrap_or(0),
        location: None,
        metadata: None,
        version_name: None,
        exif: crate::bindings::MetaExif {
            maker: a.exif.make.clone().unwrap_or_default(),
            model: a.exif.model.clone().unwrap_or_default(),
            lens: a.exif.lens.clone().unwrap_or_default(),
            body_serial: String::new(),
            exposure: parse_exposure_seconds(a.exif.exposure.as_deref()),
            aperture: a.exif.aperture.clone().unwrap_or_else(zero),
            iso: a.exif.iso.clone().unwrap_or_else(zero),
            focal_length: a.exif.focal.clone().unwrap_or_else(zero),
            exposure_bias: zero(),
            focus_distance: zero(),
            crop_factor: zero(),
            white_balance: String::new(),
            flash: String::new(),
            exposure_program: String::new(),
            metering_mode: String::new(),
            file_width: 0,
            file_height: 0,
            sensor_width: 0,
            sensor_height: 0,
            datetime: immich_datetime(a.exif.datetime.as_deref().or(a.date.as_deref())),
            capture_time_raw: String::new(),
            capture_offset: String::new(),
            file_datetime: String::new(),
        },
        keywords: Vec::new(),
        version: 0,
        copy: false,
        morfphoto_preview: None,
    }
}

fn enrich_immich_hit(
    cache: &crate::search_cache::SearchCache,
    local_path: &str,
    a: &Asset,
) -> (
    crate::typed_library::LibraryImage,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    if let Ok(Some(variant)) = cache.variant(local_path, "") {
        if let Ok(Some(raw)) = cache.metadata(variant.id) {
            if let Some(cached) = crate::local_search::cached_image(&raw, local_path, 0) {
                return (
                    cached,
                    variant.capture_time_raw,
                    Some(variant.asset_id.to_string()),
                    Some(variant.id.to_string()),
                );
            }
        }
    }
    (asset_to_library_image(local_path, a), None, None, None)
}

pub struct OriginalInfo {
    pub name: String,
    pub size: Option<u64>,
    pub checksum: Option<String>,
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
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn filter_defaults_to_external_photos() {
        let f = filter(&SearchArgs::default());
        assert_eq!(f, json!({ "type": { "eq": "IMAGE" }, "trashedAt": { "eq": null }, "libraryId": { "ne": null } }));
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
        assert_eq!(local_path("/mnt/photos/2026/a.raf", &map), Some(std::fs::canonicalize(dir.join("2026/a.raf")).unwrap()));
        assert_eq!(local_path("/mnt/photos/2026/b.raf", &map), None);
        assert_eq!(local_path("/mnt/photos2/2026/a.raf", &map), None);
        assert_eq!(local_path("/mnt/photos/2026/a.raf", &PathMap::default()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn paths_reject_traversal_and_symlink_escape() {
        use std::os::unix::fs::symlink;

        let dir = test_dir("immich-path-map-safety");
        let root = dir.join("root");
        let outside = dir.join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret.jpg"), b"not mapped").unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let map = PathMap { immich: "/mnt/photos".into(), local: root.to_string_lossy().into() };

        assert_eq!(local_path("/mnt/photos/../outside/secret.jpg", &map), None);
        assert_eq!(local_path("/mnt/photos/linked/secret.jpg", &map), None);
        assert_eq!(local_path("/mnt/photos2/secret.jpg", &map), None);
        assert_eq!(local_path("relative/file.jpg", &map), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_map_judges_server_paths_on_any_host() {
        let dir = test_dir("immich-path-map-server");
        std::fs::create_dir_all(dir.join("2026")).unwrap();
        std::fs::write(dir.join("2026/a.raf"), b"x").unwrap();
        let want = Some(std::fs::canonicalize(dir.join("2026/a.raf")).unwrap());
        let local: String = dir.to_string_lossy().into();
        let posix = PathMap { immich: "/photos/library".into(), local: local.clone() };
        assert_eq!(local_path("/photos/library/2026/a.raf", &posix), want);
        assert_eq!(local_path("/photos/other/2026/a.raf", &posix), None);
        assert_eq!(local_path("/photos/library2/2026/a.raf", &posix), None);
        assert_eq!(local_path("/photos/library", &posix), None);
        assert_eq!(local_path("/photos/library/../2026/a.raf", &posix), None);
        let win = PathMap { immich: "C:\\Photos".into(), local: local.clone() };
        assert_eq!(local_path("C:\\Photos\\2026\\a.raf", &win), want);
        assert_eq!(local_path("c:/Photos/2026/a.raf", &win), want);
        assert_eq!(local_path("D:\\Photos\\2026\\a.raf", &win), None);
        assert_eq!(local_path("C:\\Photos2\\2026\\a.raf", &win), None);
        assert_eq!(local_path("/Photos/2026/a.raf", &win), None);
        let unc = PathMap { immich: "\\\\nas\\share".into(), local };
        assert_eq!(local_path("\\\\nas\\share\\2026\\a.raf", &unc), want);
        assert_eq!(local_path("\\\\nas\\other\\2026\\a.raf", &unc), None);
        for bad in ["", "photos", "/", "C:", "C:photos"] {
            let map = PathMap { immich: bad.into(), local: dir.to_string_lossy().into() };
            assert_eq!(local_path("/photos/2026/a.raf", &map), None, "{bad}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_map_requires_absolute_roots() {
        let map = PathMap { immich: "mnt/photos".into(), local: "/tmp".into() };
        assert_eq!(local_path("mnt/photos/a.jpg", &map), None);
        let map = PathMap { immich: "/mnt/photos".into(), local: "photos".into() };
        assert_eq!(local_path("/mnt/photos/a.jpg", &map), None);
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
        let r = serde_json::to_value(&r).unwrap();
        assert_eq!(r["next"], "c2");
        let a = &r["items"][0];
        assert_eq!((a["id"].as_str(), a["name"].as_str(), a["rating"].as_i64()), (Some("a1"), Some("A.RAF"), Some(4)));
        assert_eq!((a["width"].as_i64(), a["exif"]["aperture"].as_f64()), (Some(6000), Some(2.8)));
        assert_eq!(a["localPath"], Value::Null);
        let r = c.search(&SearchArgs { mode: "smart".into(), text: "beach".into(), next: Some("2".into()),
                                       ..Default::default() }, &PathMap::default()).unwrap();
        assert_eq!(r.next, None);
    }

    #[test]
    fn search_drops_trashed_assets() {
        let mut server = mockito::Server::new();
        let _meta = server.mock("POST", "/api/search/metadata")
            .match_body(mockito::Matcher::PartialJson(json!({ "filter": { "trashedAt": { "eq": null } } })))
            .with_body(r#"{"assets":{"items":[
                {"id":"t1","originalFileName":"T.RAF","isTrashed":true,"localDateTime":"2026-10-05T06:50:16.000Z"},
                {"id":"a1","originalFileName":"A.RAF","isTrashed":false,"localDateTime":"2026-10-05T06:50:16.000Z"}],
                "nextCursor":null}}"#).create();
        let r = client(&server.url()).search(&SearchArgs::default(), &PathMap::default()).unwrap();
        let r = serde_json::to_value(&r).unwrap();
        assert_eq!(r["items"].as_array().unwrap().len(), 1);
        assert_eq!(r["items"][0]["id"], "a1");
    }

    #[test]
    fn libraries_without_permission_are_none() {
        let mut server = mockito::Server::new();
        let _l = server.mock("GET", "/api/libraries").with_status(403).with_body(r#"{"message":"Missing permission"}"#)
            .create();
        assert!(client(&server.url()).libraries().unwrap().is_empty());
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

    #[test]
    fn smart_search_availability_checks_features_and_permissions() {
        let mut server = mockito::Server::new();
        let _f = server
            .mock("GET", "/api/server/features")
            .with_body(r#"{"smartSearch":true}"#)
            .create();
        let _me = server
            .mock("GET", "/api/api-keys/me")
            .with_body(r#"{"permissions":["asset.read"]}"#)
            .create();
        assert_eq!(client(&server.url()).smart_search_available().unwrap(), true);

        let mut server = mockito::Server::new();
        let _f = server
            .mock("GET", "/api/server/features")
            .with_body(r#"{"smartSearch":false}"#)
            .create();
        assert_eq!(client(&server.url()).smart_search_available().unwrap(), false);

        // 404 on deprecated /server/features falls back to /server/ping
        let mut server = mockito::Server::new();
        let _f = server
            .mock("GET", "/api/server/features")
            .with_status(404)
            .create();
        let _p = server
            .mock("GET", "/api/server/ping")
            .with_body(r#"{"res":"pong"}"#)
            .create();
        let _me = server
            .mock("GET", "/api/api-keys/me")
            .with_body(r#"{"permissions":["all"]}"#)
            .create();
        assert_eq!(client(&server.url()).smart_search_available().unwrap(), true);

        // Missing asset.read permission -> false
        let mut server = mockito::Server::new();
        let _f = server
            .mock("GET", "/api/server/features")
            .with_body(r#"{"smartSearch":true}"#)
            .create();
        let _me = server
            .mock("GET", "/api/api-keys/me")
            .with_body(r#"{"permissions":["album.read"]}"#)
            .create();
        assert_eq!(client(&server.url()).smart_search_available().unwrap(), false);
    }

    #[test]
    fn local_to_server_folder_translates_posix_and_windows_roots() {
        let posix = PathMap {
            immich: "/mnt/photos".into(),
            local: "/Volumes/photos".into(),
        };
        assert_eq!(
            local_to_server_folder(Path::new("/Volumes/photos"), &posix, None).as_deref(),
            Some("/mnt/photos/")
        );
        assert_eq!(
            local_to_server_folder(Path::new("/Volumes/photos/2026/Trip"), &posix, None).as_deref(),
            Some("/mnt/photos/2026/Trip/")
        );
        assert_eq!(
            local_to_server_folder(Path::new("/Volumes/photos-other"), &posix, None),
            None
        );

        let win = PathMap {
            immich: "C:\\Photos".into(),
            local: "/Volumes/photos".into(),
        };
        assert_eq!(
            local_to_server_folder(Path::new("/Volumes/photos/2026"), &win, None).as_deref(),
            Some("C:\\Photos\\2026\\")
        );
    }

    #[test]
    fn smart_in_folder_scopes_recursive_nonrecursive_exclusions_and_400_fallback() {
        let dir = test_dir("immich-smart-folder");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::create_dir_all(dir.join("hidden")).unwrap();
        std::fs::create_dir_all(dir.join("morf")).unwrap();
        std::fs::write(dir.join("a.jpg"), b"a").unwrap();
        std::fs::write(dir.join("sub/b.jpg"), b"b").unwrap();
        std::fs::write(dir.join("hidden/h.jpg"), b"h").unwrap();
        std::fs::write(dir.join("morf/m.jpg"), b"m").unwrap();

        let cache = crate::search_cache::SearchCache::open(&dir.join("cache.sqlite")).unwrap();
        let map = PathMap {
            immich: "/mnt/photos".into(),
            local: dir.to_string_lossy().into(),
        };

        let mut server = mockito::Server::new();
        let body = r#"{"assets":{"items":[
            {"id":"1","originalFileName":"a.jpg","originalPath":"/mnt/photos/a.jpg","localDateTime":"2026-05-01T10:00:00.000Z","exifInfo":{"rating":5}},
            {"id":"2","originalFileName":"b.jpg","originalPath":"/mnt/photos/sub/b.jpg","localDateTime":"2026-05-02T10:00:00.000Z","exifInfo":{"rating":4}},
            {"id":"3","originalFileName":"h.jpg","originalPath":"/mnt/photos/hidden/h.jpg","localDateTime":"2026-05-03T10:00:00.000Z","exifInfo":{"rating":5}},
            {"id":"4","originalFileName":"m.jpg","originalPath":"/mnt/photos/morf/m.jpg","localDateTime":"2026-05-04T10:00:00.000Z","exifInfo":{"rating":5}}
        ],"nextPage":null}}"#;
        let _smart = server
            .mock("POST", "/api/search/smart")
            .match_body(mockito::Matcher::PartialJson(json!({
                "query": "dog",
                "filter": { "originalPath": { "startsWith": "/mnt/photos/" } }
            })))
            .with_body(body)
            .create();

        let args = crate::local_search::LocalSearchArgs {
            text: "dog".into(),
            scope: "folder".into(),
            folder: Some(dir.to_string_lossy().into()),
            ..Default::default()
        };
        let canon = std::fs::canonicalize(&dir).unwrap();
        let non_rec = client(&server.url())
            .smart_in_folder(
                &dir,
                false,
                &[canon.join("hidden")],
                &[canon.join("morf")],
                &map,
                Some(&canon),
                &args,
                &cache,
                || false,
            )
            .unwrap();
        assert_eq!(non_rec.items.len(), 1);
        assert_eq!(non_rec.items[0].image.filename, "a.jpg");

        let rec = client(&server.url())
            .smart_in_folder(
                &dir,
                true,
                &[canon.join("hidden")],
                &[canon.join("morf")],
                &map,
                Some(&canon),
                &args,
                &cache,
                || false,
            )
            .unwrap();
        let names: Vec<_> = rec.items.iter().map(|i| i.image.filename.as_str()).collect();
        assert_eq!(names, vec!["a.jpg", "b.jpg"]);

        // Server rejecting originalPath with HTTP 400 triggers fallback without originalPath
        let mut server = mockito::Server::new();
        let reject = server
            .mock("POST", "/api/search/smart")
            .match_body(mockito::Matcher::Regex("originalPath".into()))
            .with_status(400)
            .with_body(r#"{"message":"property originalPath should not exist"}"#)
            .expect(1)
            .create();
        let retry = server
            .mock("POST", "/api/search/smart")
            .with_body(body)
            .expect(1)
            .create();
        let fallback_page = client(&server.url())
            .smart_in_folder(
                &dir,
                false,
                &[],
                &[],
                &map,
                Some(&canon),
                &args,
                &cache,
                || false,
            )
            .unwrap();
        reject.assert();
        retry.assert();
        assert_eq!(fallback_page.items.len(), 1);
        assert_eq!(fallback_page.items[0].image.filename, "a.jpg");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
