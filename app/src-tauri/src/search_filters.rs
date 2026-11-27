// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
use crate::{immich_search::SearchArgs, typed_library::LibraryImage};
use chrono::{NaiveDate, NaiveTime};
#[derive(Default, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct GridFilter {
    pub min_rating: u8,
    pub rejected: String,
    pub edited: String,
    pub labels: u32,
    pub unlabeled: bool,
    pub kinds: Vec<String>,
    pub cameras: Vec<String>,
    pub bodies: Vec<String>,
    pub lenses: Vec<String>,
    pub keywords: Vec<String>,
    pub taken_from: String,
    pub taken_to: String,
    pub gps: String,
    pub iso: Vec<String>,
    pub aperture: Vec<String>,
    pub focal: Vec<String>,
    pub shutter: Vec<String>,
    pub text_field: String,
    pub text_query: String,
    pub orientations: Vec<String>,
    pub aspect_ratios: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub min_megapixels: f64,
    pub max_megapixels: f64,
}

pub(crate) const TEXT_FIELDS: [&str; 7] = [
    "title", "description", "creator", "publisher", "rights", "notes", "version_name",
];

pub(crate) fn ratio_parts(value: &str) -> Option<(u64, u64)> {
    let (a, b) = value.split_once(':')?;
    let a = a.parse::<u64>().ok()?;
    let b = b.parse::<u64>().ok()?;
    ((1..=1000).contains(&a) && (1..=1000).contains(&b)).then_some((a.max(b), a.min(b)))
}

fn geometry_matches(width: u32, height: u32, filter: &GridFilter) -> bool {
    if filter.orientations.is_empty() && filter.aspect_ratios.is_empty()
        && filter.width == 0 && filter.height == 0
        && filter.min_megapixels == 0.0 && filter.max_megapixels == 0.0
    {
        return true;
    }
    if width == 0 || height == 0 {
        return false;
    }
    let orientation = match width.cmp(&height) {
        std::cmp::Ordering::Greater => "landscape",
        std::cmp::Ordering::Less => "portrait",
        std::cmp::Ordering::Equal => "square",
    };
    let long = u64::from(width.max(height));
    let short = u64::from(width.min(height));
    let megapixels = (long * short) as f64 / 1_000_000.0;
    selected(&filter.orientations, orientation)
        && (filter.width == 0 || filter.width == width)
        && (filter.height == 0 || filter.height == height)
        && (filter.min_megapixels == 0.0 || megapixels >= filter.min_megapixels)
        && (filter.max_megapixels == 0.0 || megapixels <= filter.max_megapixels)
        && (filter.aspect_ratios.is_empty()
            || filter.aspect_ratios.iter().filter_map(|v| ratio_parts(v)).any(|(a, b)| {
                (long * b).abs_diff(short * a) * 100 <= short * a
            }))
}

fn text_matches(image: &LibraryImage, field: &str, query: &str) -> bool {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return true;
    }
    let matches = |value: &str| value.to_lowercase().contains(&query);
    let all = field.is_empty() || field == "any";
    if (all || field == "version_name") && image.version_name.as_deref().is_some_and(matches) {
        return true;
    }
    image.metadata.as_ref().is_some_and(|text| {
        [
            ("title", &text.title),
            ("description", &text.description),
            ("creator", &text.creator),
            ("publisher", &text.publisher),
            ("rights", &text.rights),
            ("notes", &text.notes),
        ]
        .into_iter()
        .any(|(key, value)| (all || field == key) && matches(value))
    })
}
// Years are four digits, so the day as text sorts as the date does (the
// mirror's SQL compares days as text).
fn day(value: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(&value.get(..10)?.replace(':', "-"), "%Y-%m-%d")
        .ok()
        .filter(|d| (0..=9999).contains(&chrono::Datelike::year(d)))
}
/// The capture day of a morfPhoto version's `taken_at`.
pub(crate) fn capture_day(taken_at: &str) -> Option<String> {
    day(taken_at).map(|d| d.format("%Y-%m-%d").to_string())
}
fn minute(value: &str) -> Option<NaiveTime> {
    if !matches!(value.as_bytes().get(10), Some(b'T' | b' ')) {
        return None;
    }
    let time = value.get(11..16)?;
    if !time.bytes().enumerate().all(|(i, b)| {
        if i == 2 { b == b':' } else { b.is_ascii_digit() }
    }) {
        return None;
    }
    NaiveTime::parse_from_str(time, "%H:%M").ok()
}
/// Capture filter bounds use a date or the recorded local minute.
pub(crate) fn date_bound(value: &str) -> Option<(NaiveDate, Option<NaiveTime>)> {
    let date = day(value)?;
    match value.len() {
        10 => Some((date, None)),
        16 if value.as_bytes()[10] == b'T' => Some((date, Some(minute(value)?))),
        _ => None,
    }
}
fn selected(values: &[String], value: &str) -> bool {
    values.is_empty() || (!value.is_empty() && values.iter().any(|v| v == value))
}
impl GridFilter {
    /// The filter with its chosen cameras, bodies and lenses in the one spelling
    /// every source is mapped to (`camera_names`), so a value picked from either
    /// spelling matches. `passes` and the SQL over the mirror take this form.
    pub fn canonical(&self) -> GridFilter {
        let mut f = self.clone();
        f.cameras = self.cameras.iter().map(|c| crate::camera_names::camera_label(c)).collect();
        f.bodies = self.bodies.iter().map(|b| crate::camera_names::body_key(b)).collect();
        f.lenses = self.lenses.iter().map(|l| crate::camera_names::lens(l)).collect();
        f
    }
}
fn exact(expected: &Option<String>, value: &str) -> bool {
    expected
        .as_ref()
        .is_none_or(|s| s.trim().is_empty() || (!value.is_empty() && s == value))
}
fn date_range(value: Option<&str>, from: &str, to: &str) -> bool {
    let compare = |bound: &str| {
        let (bound_day, bound_time) = date_bound(bound)?;
        let value = value?;
        let value_day = day(value)?;
        Some(match bound_time {
            Some(bound_time) => (value_day, minute(value)?).cmp(&(bound_day, bound_time)),
            None => value_day.cmp(&bound_day),
        })
    };
    (from.is_empty() || compare(from).is_some_and(|order| order.is_ge()))
        && (to.is_empty() || compare(to).is_some_and(|order| order.is_le()))
}
pub fn validate(f: &GridFilter, r: &SearchArgs) -> Result<(), String> {
    if !f.orientations.iter().all(|v| matches!(v.as_str(), "landscape" | "portrait" | "square"))
        || !f.aspect_ratios.iter().all(|v| ratio_parts(v).is_some())
        || ![f.min_megapixels, f.max_megapixels].iter().all(|v| v.is_finite() && *v >= 0.0)
    {
        return Err("Invalid image geometry filter".into());
    }
    if !matches!(f.text_field.as_str(), "" | "any")
        && !TEXT_FIELDS.contains(&f.text_field.as_str())
    {
        return Err("Invalid metadata field".into());
    }
    if f.min_rating > 5
        || r.min_rating.is_some_and(|v| v > 5)
        || !matches!(f.rejected.as_str(), "" | "all" | "hide" | "only")
        || !matches!(f.edited.as_str(), "" | "all" | "edited" | "unedited")
        || !matches!(f.gps.as_str(), "" | "any" | "has" | "none")
        || f.labels > 31
    {
        return Err("Invalid local search filter".into());
    }
    for date in [
        &f.taken_from,
        &f.taken_to,
        r.taken_from.as_deref().unwrap_or(""),
        r.taken_to.as_deref().unwrap_or(""),
    ] {
        if !date.is_empty() && date_bound(date).is_none() {
            return Err("Invalid capture date filter".into());
        }
    }
    Ok(())
}
pub(crate) fn kind(name: &str) -> &'static str {
    match name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" | "jpe" => "JPEG",
        "tif" | "tiff" => "TIFF",
        "heic" | "heif" | "hif" => "HEIF",
        "png" => "PNG",
        "avif" => "AVIF",
        "webp" => "WEBP",
        "jxl" => "JXL",
        "exr" => "EXR",
        "pfm" => "PFM",
        "ppm" | "pgm" | "pnm" => "PNM",
        "gif" => "GIF",
        "j2k" | "jp2" => "JPEG 2000",
        "qoi" => "QOI",
        "bmp" => "BMP",
        _ => "RAW",
    }
}
// JavaScript toFixed for positive finite camera values: round the exact binary
// significand to decimal, with ties up. This avoids 2.55*10 rounding drift.
fn decimal(value: f64, places: u32) -> Option<String> {
    if !value.is_finite() || value <= 0.0 || value > 1e9 {
        return None;
    }
    let bits = value.to_bits();
    let exp = ((bits >> 52) & 2047) as i32 - 1023 - 52;
    let significand = u128::from((bits & ((1u64 << 52) - 1)) | (1u64 << 52)) * 10u128.pow(places);
    let rounded = if exp >= 0 {
        significand.checked_shl(exp as u32)?
    } else {
        let shift = (-exp) as u32;
        if shift >= 128 {
            0
        } else {
            (significand >> shift)
                + u128::from((significand & ((1u128 << shift) - 1)) >= (1u128 << (shift - 1)))
        }
    };
    let scale = 10u128.pow(places);
    let whole = rounded / scale;
    let fraction = rounded % scale;
    Some(if places == 0 || fraction == 0 {
        whole.to_string()
    } else {
        format!("{whole}.{fraction:0width$}", width = places as usize)
            .trim_end_matches('0')
            .to_string()
    })
}
// The file's extension as Find's File type lists it (filter.ts `fileExt`):
// upper case, .jpeg and .jpe as JPG, .tif as TIFF; "" without one.
pub(crate) fn ext_name(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((_, ext)) if !ext.is_empty() && !ext.contains('.') => {
            let ext = ext.to_uppercase();
            match ext.as_str() {
                "JPEG" | "JPE" => "JPG".into(),
                "TIF" => "TIFF".into(),
                _ => ext,
            }
        }
        _ => String::new(),
    }
}
pub(crate) fn is_raw_file(name: &str) -> bool {
    std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| crate::immich_search::RAW_EXTENSIONS.contains(&s.to_ascii_lowercase().as_str()))
}
pub(crate) fn camera_key(maker: &str, model: &str) -> String {
    format!("{maker} {model}").trim().to_string()
}
pub(crate) fn body_key(maker: &str, model: &str, serial: &str) -> String {
    if serial.trim().is_empty() {
        String::new()
    } else {
        serde_json::to_string(&[maker, model, serial.trim()]).unwrap_or_default()
    }
}
// The exposure values as the camera shows them, "" where not recorded; one
// value per label (1/250 whatever the exact fraction). filter.ts `exposureLabel`.
pub(crate) fn iso_key(v: f64) -> String {
    if v.is_finite() && v > 0.0 { v.round().to_string() } else { String::new() }
}
pub(crate) fn aperture_key(v: f64) -> String {
    decimal(v, 1).map(|s| format!("f/{s}")).unwrap_or_default()
}
pub(crate) fn focal_key(v: f64) -> String {
    decimal(v, 0).map(|s| format!("{s} mm")).unwrap_or_default()
}
pub(crate) fn shutter_key(v: f64) -> String {
    if !(v.is_finite() && v > 0.0) {
        String::new()
    } else if v >= 0.3 {
        decimal(v, 1).map(|s| format!("{s}s")).unwrap_or_default()
    } else {
        format!("1/{}", (1.0 / v).round())
    }
}
// The capture day of a photo: the precise raw text where there is one, else
// EXIF's, never the file's time.
pub(crate) fn date_of(i: &LibraryImage, capture: Option<&str>) -> Option<NaiveDate> {
    capture_text(i, capture).and_then(day)
}
fn capture_text<'a>(i: &'a LibraryImage, capture: Option<&'a str>) -> Option<&'a str> {
    [
        capture,
        Some(i.exif.capture_time_raw.as_str()).filter(|raw| {
            i.exif.datetime.is_empty() || raw.get(..19) == i.exif.datetime.get(..19)
        }),
        Some(i.exif.datetime.as_str()),
    ]
        .into_iter()
        .flatten()
        .find(|text| day(text).is_some())
}
pub(crate) fn gps_coordinates(location: &crate::bindings::Location) -> Option<(f64, f64)> {
    let lat = location.latitude.as_f64()?;
    let lon = location.longitude.as_f64()?;
    (lat.abs() <= 90.0 && lon.abs() <= 180.0).then_some((lat, lon))
}
pub fn passes(i: &LibraryImage, capture: Option<&str>, f: &GridFilter, r: &SearchArgs) -> bool {
    // These server identities/fields have no verified local mapping. Unknown
    // never satisfies a selected filter; five stars are not an Immich favorite.
    if r.favorites
        || !r.person_ids.is_empty()
        || !r.tag_ids.is_empty()
        || !r.album_ids.is_empty()
        || r.country.as_ref().is_some_and(|s| !s.is_empty())
        || r.city.as_ref().is_some_and(|s| !s.is_empty())
        || !matches!(r.library.as_str(), "" | "all" | "external")
    {
        return false;
    }
    let rating = f.min_rating.max(r.min_rating.unwrap_or(0));
    if (rating > 0 && (i.rejected || i.rating < rating))
        || (f.rejected == "hide" && i.rejected)
        || (f.rejected == "only" && !i.rejected)
        || (f.edited == "edited" && !i.edited)
        || (f.edited == "unedited" && i.edited)
    {
        return false;
    }
    if (f.labels != 0 || f.unlabeled)
        && (i.labels & f.labels) == 0
        && !(f.unlabeled && i.labels == 0)
    {
        return false;
    }
    let raw = is_raw_file(&i.filename);
    // a type is chosen by its extension or its coarser kind, as filter.ts does
    if (r.raw_only && !raw)
        || !(f.kinds.is_empty()
            || f.kinds.iter().any(|k| *k == ext_name(&i.filename) || k == kind(&i.filename)))
    {
        return false;
    }
    let camera = camera_key(&i.exif.maker, &i.exif.model);
    let body = body_key(&i.exif.maker, &i.exif.model, &i.exif.body_serial);
    if !selected(&f.cameras, &camera)
        || !(f.bodies.is_empty() || f.bodies.contains(&body))
        || !selected(&f.lenses, &i.exif.lens)
        || !exact(&r.make, &i.exif.maker)
        || !exact(&r.model, &i.exif.model)
        || !exact(&r.lens, &i.exif.lens)
    {
        return false;
    }
    if !f.keywords.iter().all(|k| {
        i.keywords
            .iter()
            .any(|v| v == k || v.starts_with(&format!("{k}|")))
    }) {
        return false;
    }
    // Capture dates never fall back to filesystem modification dates here.
    let date = capture_text(i, capture);
    if !date_range(date, &f.taken_from, &f.taken_to)
        || !date_range(
            date,
            r.taken_from.as_deref().unwrap_or(""),
            r.taken_to.as_deref().unwrap_or(""),
        )
    {
        return false;
    }
    let has_gps = i.location.as_ref().and_then(gps_coordinates).is_some();
    if (f.gps == "has" && !has_gps) || (f.gps == "none" && has_gps) {
        return false;
    }
    if !text_matches(i, &f.text_field, &f.text_query) {
        return false;
    }
    if !geometry_matches(i.exif.file_width, i.exif.file_height, f) {
        return false;
    }
    let number = |v: &serde_json::Number| v.as_f64().unwrap_or(0.0);
    let iso = iso_key(number(&i.exif.iso));
    let aperture = aperture_key(number(&i.exif.aperture));
    let focal = focal_key(number(&i.exif.focal_length));
    let shutter = shutter_key(number(&i.exif.exposure));
    selected(&f.iso, &iso)
        && selected(&f.aperture, &aperture)
        && selected(&f.focal, &focal)
        && selected(&f.shutter, &shutter)
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_bounds_use_recorded_minute_and_include_its_seconds() {
        let within = |value| {
            date_range(Some(value), "2026-11-27T12:30", "2026-11-27T12:30")
        };
        assert!(within("2026-11-27T12:30:59.123-08:00"));
        assert!(within("2026:11:27 12:30:00"));
        assert!(!within("2026-11-27T12:31:00"));
        assert!(!within("2026-11-27"));
        assert!(date_range(Some("2026-11-27"), "2026-11-27", "2026-11-27"));
    }

    #[test]
    fn image_geometry_requires_known_dimensions_and_accepts_rotated_ratios() {
        let filter = GridFilter {
            aspect_ratios: vec!["3:2".into()],
            orientations: vec!["portrait".into()],
            min_megapixels: 24.0,
            max_megapixels: 24.0,
            width: 4000,
            height: 6000,
            ..GridFilter::default()
        };
        assert!(geometry_matches(4000, 6000, &filter));
        assert!(!geometry_matches(6000, 4000, &filter));
        assert!(!geometry_matches(4000, 0, &filter));
        let ratio = GridFilter { aspect_ratios: filter.aspect_ratios, ..GridFilter::default() };
        assert!(geometry_matches(6000, 3990, &ratio));
        assert!(!geometry_matches(6000, 3950, &ratio));
    }
    #[test]
    fn decimal_matches_camera_filter_rounding() {
        assert_eq!(decimal(2.55, 1).as_deref(), Some("2.5"));
        assert_eq!(decimal(2.25, 1).as_deref(), Some("2.3"));
        assert_eq!(decimal(35.0, 0).as_deref(), Some("35"));
        assert!(decimal(f64::NAN, 1).is_none());
    }
}
