// exports sent to an Immich album: the server and key the importer keeps
// (tauri_plugin_immporter::immich_connection), so the key never reaches the
// web view. the importer's own client only reads; uploading lives here.
// blocking calls: callers run them off the async runtime (spawn_blocking)
use std::path::Path;
use std::time::Duration;

use reqwest::blocking::{multipart, Client};
use serde_json::{json, Value};

// what an export needs of the key, beyond the importer's asset.read
pub const EXPORT_PERMISSIONS: &[&str] = &["asset.upload", "album.read", "album.create", "albumAsset.create"];
// what the Library panel's search needs: the results, their thumbnails, and
// the originals of those not on this computer
pub const BROWSE_PERMISSIONS: &[&str] = &["asset.read", "asset.view", "asset.download"];

pub struct Immich {
    pub(crate) http: Client,
    base: String,
}

pub(crate) fn status(r: reqwest::blocking::Response) -> Result<reqwest::blocking::Response, String> {
    if r.status().is_success() {
        return Ok(r);
    }
    let code = r.status();
    let body = r.text().unwrap_or_default();
    Err(format!("Immich: {code} {}", explain(&body)).trim().to_string())
}

// an error body as one line: its message, and for a validation failure
// what failed, which Immich gives as a list (message, errors or issues)
fn explain(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else { return body.to_string() };
    let mut parts = Vec::new();
    for key in ["message", "errors", "issues", "details"] {
        match &v[key] {
            Value::String(s) => parts.push(s.clone()),
            Value::Array(a) => parts.extend(a.iter().map(|x| match x {
                Value::String(s) => s.clone(),
                // { path: [...], message } as zod reports one
                o => {
                    let path = o["path"].as_array().map(|p| p.iter().map(|x| x.to_string().trim_matches('"').to_string())
                        .collect::<Vec<_>>().join(".")).or_else(|| o["property"].as_str().map(String::from));
                    let msg = o["message"].as_str().map(String::from).unwrap_or_else(|| o.to_string());
                    path.map_or(msg.clone(), |p| format!("{p}: {msg}"))
                }
            })),
            _ => {}
        }
    }
    if parts.is_empty() { body.to_string() } else { parts.join("; ") }
}

impl Immich {
    pub fn new(c: &tauri_plugin_immporter::ImmichConnection) -> Result<Self, String> {
        let mut key = reqwest::header::HeaderValue::from_str(&c.api_key).map_err(|e| e.to_string())?;
        key.set_sensitive(true);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-api-key", key);
        let http = Client::builder()
            .default_headers(headers)
            .danger_accept_invalid_certs(c.accept_invalid_certs)
            // an upload of a large TIFF over a slow link takes a while
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Immich { http, base: c.url.trim_end_matches('/').to_string() })
    }

    pub(crate) fn url(&self, path: &str) -> String {
        format!("{}/api{path}", self.base)
    }

    // the export permissions the key lacks
    pub fn missing_permissions(&self) -> Result<Vec<String>, String> {
        self.lacks(EXPORT_PERMISSIONS)
    }

    // which of these the key lacks; a key with "all" lacks none
    pub fn lacks(&self, wanted: &[&str]) -> Result<Vec<String>, String> {
        let me: Value = status(self.http.get(self.url("/api-keys/me")).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let have: Vec<&str> = me["permissions"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if have.contains(&"all") {
            return Ok(vec![]);
        }
        Ok(wanted.iter().filter(|p| !have.contains(p)).map(|p| p.to_string()).collect())
    }

    // [{ id, name, count }], by name
    pub fn albums(&self) -> Result<Value, String> {
        let list: Value = status(self.http.get(self.url("/albums")).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let mut albums: Vec<Value> = list.as_array().cloned().unwrap_or_default().iter()
            .map(|a| json!({ "id": a["id"], "name": a["albumName"], "count": a["assetCount"] }))
            .collect();
        albums.sort_by_key(|a| a["name"].as_str().unwrap_or("").to_lowercase());
        Ok(json!(albums))
    }

    pub fn create_album(&self, name: &str) -> Result<Value, String> {
        let a: Value = status(self.http.post(self.url("/albums")).json(&json!({ "albumName": name }))
            .send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        Ok(json!({ "id": a["id"], "name": a["albumName"], "count": 0 }))
    }

    // one file; its asset id, and whether Immich already had it (it then
    // keeps the old asset, which still goes into the album)
    pub fn upload(&self, file: &Path, created: &str) -> Result<(String, bool), String> {
        let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let size = std::fs::metadata(file).map(|m| m.len()).unwrap_or(0);
        let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "png" => "image/png",
            "tif" | "tiff" => "image/tiff",
            "webp" => "image/webp",
            "jxl" => "image/jxl",
            "avif" => "image/avif",
            _ => "application/octet-stream",
        };
        let form = |device: bool| -> Result<multipart::Form, String> {
            let part = multipart::Part::file(file).map_err(|e| e.to_string())?
                .file_name(name.clone()).mime_str(mime).map_err(|e| e.to_string())?;
            let mut f = multipart::Form::new();
            if device {
                // the same file uploaded again is recognized by its content
                // anyway; this id only has to be unique per device
                f = f.text("deviceAssetId", format!("immage-{name}-{size}")).text("deviceId", "immage");
            }
            Ok(f.text("fileCreatedAt", created.to_string())
                .text("fileModifiedAt", created.to_string())
                .part("assetData", part))
        };
        let send = |device: bool| -> Result<reqwest::blocking::Response, String> {
            status(self.http.post(self.url("/assets")).multipart(form(device)?).send().map_err(|e| e.to_string())?)
        };
        // older servers require the device fields; newer ones may refuse
        // them as unknown, so a rejected upload is tried once without
        let r: Value = match send(true) {
            Err(e) if e.starts_with("Immich: 400") && e.contains("device") => send(false)?,
            other => other?,
        }
        .json().map_err(|e| e.to_string())?;
        let id = r["id"].as_str().ok_or("Immich: the upload gave no asset id")?.to_string();
        Ok((id, r["status"].as_str() == Some("duplicate")))
    }

    // the assets into the album; one already in it is not an error
    pub fn add_to_album(&self, album: &str, ids: &[String]) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let r: Value = status(self.http.put(self.url(&format!("/albums/{album}/assets")))
            .json(&json!({ "ids": ids })).send().map_err(|e| e.to_string())?)?
            .json().map_err(|e| e.to_string())?;
        let failed: Vec<String> = r.as_array().cloned().unwrap_or_default().iter()
            .filter(|x| x["success"] == json!(false) && x["error"].as_str() != Some("duplicate"))
            .map(|x| format!("{}: {}", x["id"].as_str().unwrap_or("?"), x["error"].as_str().unwrap_or("failed")))
            .collect();
        if failed.is_empty() { Ok(()) } else { Err(format!("not added to the album: {}", failed.join(", "))) }
    }
}

// an EXIF date ("2026:10:08 14:03:22", maybe with more after) as the
// ISO 8601 time Immich requires, which must carry an offset: EXIF times are
// local, so this computer's offset for that date; now, when there is none
pub fn iso_time(exif: Option<&str>) -> String {
    use chrono::{Local, NaiveDateTime, TimeZone};
    let s = exif.unwrap_or("").trim();
    let local = s.get(..19)
        .and_then(|t| NaiveDateTime::parse_from_str(t, "%Y:%m:%d %H:%M:%S").ok())
        .and_then(|t| Local.from_local_datetime(&t).earliest());
    local.unwrap_or_else(Local::now).to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(url: &str) -> Immich {
        Immich::new(&tauri_plugin_immporter::ImmichConnection {
            url: url.into(), api_key: "k".into(), accept_invalid_certs: false,
        }).unwrap()
    }

    #[test]
    fn validation_errors_are_spelled_out() {
        assert_eq!(explain(r#"{"message":"Validation failed","errors":[{"path":["deviceId"],"message":"Unrecognized key"}]}"#),
                   "Validation failed; deviceId: Unrecognized key");
        assert_eq!(explain(r#"{"message":["fileCreatedAt must be a Date instance"],"error":"Bad Request"}"#),
                   "fileCreatedAt must be a Date instance");
        assert_eq!(explain("not json"), "not json");
    }

    #[test]
    fn exif_dates_become_iso() {
        // the local offset for that date, whatever this machine's zone is
        let offset = |t: &str| chrono::DateTime::parse_from_rfc3339(t).map(|d| d.naive_local().to_string());
        assert_eq!(offset(&iso_time(Some("2026:10:08 14:03:22"))).unwrap(), "2026-10-08 14:03:22");
        assert_eq!(offset(&iso_time(Some("2026:10:08 14:03:22.123"))).unwrap(), "2026-10-08 14:03:22");
        assert!(chrono::DateTime::parse_from_rfc3339(&iso_time(None)).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&iso_time(Some("n/a"))).is_ok());
    }

    #[test]
    fn permissions_albums_upload_and_album_add() {
        let mut server = mockito::Server::new();
        let _me = server.mock("GET", "/api/api-keys/me").match_header("x-api-key", "k")
            .with_body(r#"{"name":"immage","permissions":["asset.read","asset.upload","album.read"]}"#).create();
        let _albums = server.mock("GET", "/api/albums")
            .with_body(r#"[{"id":"b","albumName":"zoo","assetCount":3},{"id":"a","albumName":"Beach","assetCount":1}]"#)
            .create();
        let _create = server.mock("POST", "/api/albums")
            .match_body(mockito::Matcher::Json(json!({ "albumName": "New" })))
            .with_body(r#"{"id":"n","albumName":"New"}"#).create();
        let _up = server.mock("POST", "/api/assets")
            .match_body(mockito::Matcher::Regex("name=\"fileCreatedAt\"\r\n\r\n2026-10-08T14:03:22".into()))
            .with_body(r#"{"id":"x1","status":"duplicate"}"#).create();
        let _add = server.mock("PUT", "/api/albums/n/assets")
            .match_body(mockito::Matcher::Json(json!({ "ids": ["x1"] })))
            .with_body(r#"[{"id":"x1","success":false,"error":"duplicate"}]"#).create();

        let c = client(&server.url());
        assert_eq!(c.missing_permissions().unwrap(), vec!["album.create", "albumAsset.create"]);
        let albums = c.albums().unwrap();
        assert_eq!(albums[0]["name"], "Beach");
        assert_eq!(c.create_album("New").unwrap()["id"], "n");
        // inside the build tree, not the system's temp folder
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("immich-upload-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.jpg");
        std::fs::write(&file, b"jpeg").unwrap();
        assert_eq!(c.upload(&file, "2026-10-08T14:03:22").unwrap(), ("x1".to_string(), true));
        let _ = std::fs::remove_dir_all(&dir);
        c.add_to_album("n", &["x1".into()]).unwrap();
    }
}
