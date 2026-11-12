//! Geoapify geocoding and its OS-keychain credential.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const ACCOUNT: &str = "geoapify-api-key";

fn entry(app: &AppHandle) -> Result<keyring::Entry, String> {
    keyring::Entry::new(app.config().identifier.as_str(), ACCOUNT)
        .map_err(|_| "Could not access the system credential store".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MapSearchResult {
    pub label: String,
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<[f64; 4]>,
}

#[derive(Deserialize)]
struct GeoResponse {
    #[serde(default)]
    features: Vec<GeoFeature>,
}

#[derive(Deserialize)]
struct GeoFeature {
    geometry: GeoGeometry,
    properties: GeoProperties,
    bbox: Option<[f64; 4]>,
}

#[derive(Deserialize)]
struct GeoGeometry {
    coordinates: Vec<f64>,
}

#[derive(Deserialize)]
struct GeoProperties {
    formatted: Option<String>,
    name: Option<String>,
}

fn parse_response(body: &str) -> Result<Vec<MapSearchResult>, String> {
    let parsed: GeoResponse = serde_json::from_str(body)
        .map_err(|_| "Geoapify returned an invalid response".to_string())?;
    Ok(parsed
        .features
        .into_iter()
        .take(5)
        .filter_map(|f| {
            let longitude = *f.geometry.coordinates.first()?;
            let latitude = *f.geometry.coordinates.get(1)?;
            if !longitude.is_finite()
                || !latitude.is_finite()
                || !(-180.0..=180.0).contains(&longitude)
                || !(-90.0..=90.0).contains(&latitude)
            {
                return None;
            }
            let label = f
                .properties
                .formatted
                .filter(|s| !s.trim().is_empty())
                .or(f.properties.name)
                .filter(|s| !s.trim().is_empty())?;
            let bounds = f.bbox.and_then(|b| {
                if b.iter().all(|n| n.is_finite())
                    && (-90.0..=90.0).contains(&b[1])
                    && (-180.0..=180.0).contains(&b[0])
                    && (-90.0..=90.0).contains(&b[3])
                    && (-180.0..=180.0).contains(&b[2])
                    && b[1] <= b[3]
                {
                    Some([b[1], b[0], b[3], b[2]])
                } else {
                    None
                }
            });
            Some(MapSearchResult {
                label,
                latitude,
                longitude,
                bounds,
            })
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub fn map_search_key_status(app: AppHandle) -> Result<bool, String> {
    match entry(&app)?.get_password() {
        Ok(s) => Ok(!s.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(_) => Err("Could not access the system credential store".into()),
    }
}

#[tauri::command]
#[specta::specta]
pub fn map_search_key_save(app: AppHandle, key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty".into());
    }
    entry(&app)?
        .set_password(key)
        .map_err(|_| "Could not save the API key to the system credential store".to_string())
}

#[tauri::command]
#[specta::specta]
pub fn map_search_key_remove(app: AppHandle) -> Result<(), String> {
    match entry(&app)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("Could not remove the API key from the system credential store".into()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn map_search(app: AppHandle, query: String) -> Result<Vec<crate::typed_library::Place>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let key = entry(&app)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "Add a Geoapify API key in map settings".to_string(),
        _ => "Could not access the system credential store".to_string(),
    })?;
    if key.trim().is_empty() {
        return Err("Add a Geoapify API key in map settings".into());
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        request(
            "https://api.geoapify.com/v1/geocode/search",
            &query,
            &key,
            std::time::Duration::from_secs(12),
        )
    })
    .await
    .map_err(|_| "Map search task failed".to_string())?;
    result.map(|found| found.into_iter().map(Into::into).collect())
}

// coordinates are finite here (parse_response drops the rest), which the
// exported type needs: serde_json's Number is a plain `number` for the page
impl From<MapSearchResult> for crate::typed_library::Place {
    fn from(r: MapSearchResult) -> Self {
        let n = |v: f64| serde_json::Number::from_f64(v).unwrap_or_else(|| 0.into());
        Self {
            label: r.label,
            latitude: n(r.latitude),
            longitude: n(r.longitude),
            bounds: r.bounds.map(|b| (n(b[0]), n(b[1]), n(b[2]), n(b[3]))),
        }
    }
}

fn request(
    url: &str,
    query: &str,
    key: &str,
    timeout: std::time::Duration,
) -> Result<Vec<MapSearchResult>, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|_| "Could not start the map search request".to_string())?;
    let response = client
        .get(url)
        .query(&[("text", query), ("apiKey", key), ("limit", "5")])
        .send()
        .map_err(|_| "Map search request failed".to_string())?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "Geoapify API key was rejected",
            429 => "Geoapify search quota was reached",
            _ => "Geoapify rejected the map search request",
        }
        .into());
    }
    let body = response
        .text()
        .map_err(|_| "Map search request failed".to_string())?;
    parse_response(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_geoapify_coordinates_bounds_and_caps_at_five() {
        let feature = |name: &str| {
            serde_json::json!({
                "geometry": {"coordinates": [-122.3, 47.6]},
                "properties": {"formatted": name, "name": "fallback"},
                "bbox": [-123.0, 47.0, -122.0, 48.0]
            })
        };
        let body = serde_json::json!({"features": (0..7).map(|i| feature(&format!("Place {i}"))).collect::<Vec<_>>()});
        let results = parse_response(&body.to_string()).unwrap();
        assert_eq!(results.len(), 5);
        assert_eq!(
            results[0],
            MapSearchResult {
                label: "Place 0".into(),
                latitude: 47.6,
                longitude: -122.3,
                bounds: Some([47.0, -123.0, 48.0, -122.0])
            }
        );
    }

    #[test]
    fn malformed_and_unusable_responses_are_safe_errors_or_omitted() {
        assert_eq!(
            parse_response("not json").unwrap_err(),
            "Geoapify returned an invalid response"
        );
        let body =
            r#"{"features":[{"geometry":{"coordinates":[1]},"properties":{"formatted":"bad"}}]}"#;
        assert!(parse_response(body).unwrap().is_empty());
    }

    #[test]
    fn mocked_http_status_and_timeout_errors_never_expose_the_key_or_url() {
        let mut server = mockito::Server::new();
        let key = "private-test-key";
        let _m = server
            .mock("GET", "/geocode/search")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("text".into(), "Seattle".into()),
                mockito::Matcher::UrlEncoded("apiKey".into(), key.into()),
                mockito::Matcher::UrlEncoded("limit".into(), "5".into()),
            ]))
            .with_status(403)
            .with_body("key rejected: private-test-key")
            .create();
        let err = request(
            &format!("{}/geocode/search", server.url()),
            "Seattle",
            key,
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(err, "Geoapify API key was rejected");
        assert!(!err.contains(key));

        _m.assert();
        _m.remove();
        let _quota = server
            .mock("GET", "/geocode/search")
            .match_query(mockito::Matcher::Any)
            .with_status(429)
            .with_body(format!("quota response containing {key}"))
            .create();
        let err = request(
            &format!("{}/geocode/search", server.url()),
            "Seattle",
            key,
            std::time::Duration::from_secs(1),
        )
        .unwrap_err();
        assert_eq!(err, "Geoapify search quota was reached");
        assert!(!err.contains(key));

        _quota.assert();
        _quota.remove();
        let _slow = server
            .mock("GET", "/geocode/search")
            .match_query(mockito::Matcher::Any)
            .with_status(200)
            .with_body(r#"{"features":[]}"#)
            .with_chunked_body(|w| {
                std::thread::sleep(std::time::Duration::from_millis(150));
                w.write_all(b"{}")
            })
            .create();
        let err = request(
            &format!("{}/geocode/search", server.url()),
            "Seattle",
            key,
            std::time::Duration::from_millis(20),
        )
        .unwrap_err();
        assert_eq!(err, "Map search request failed");
        assert!(!err.contains(key));
    }
}
