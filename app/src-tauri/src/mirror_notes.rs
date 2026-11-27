// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! What the commands tell the local copy of the morfPhoto catalog after they
//! changed a photo under the mapped folder (see `mirror_overrides`). Each
//! command calls one of these once its file work has succeeded, outside its own
//! locks; the call reads the saved mapping and notes the change on a blocking
//! thread, and the commands never wait for it. A photo outside the mapped
//! folder, or an Accelerator that is off, makes it a no-op.

use crate::{
    library_ids::Photo,
    mirror_overrides::{taken_at, FieldOverride},
    morf_mirror::Mirror,
    morf_photo::{self, Config},
    AppState,
};
use serde_json::{Map, Value};
use std::path::Path;

/// Runs `f` with the mirror and the saved mapping, here on the calling thread
/// (a blocking one: the mapping is read from disk).
pub(crate) fn now(mirror: &Mirror, runtime: &Path, f: impl FnOnce(&Mirror, &Config)) {
    let config = morf_photo::load(runtime);
    if config.enabled {
        f(mirror, &config);
    }
}

/// `now` on the blocking pool, unawaited.
pub(crate) fn defer(state: &AppState, f: impl FnOnce(&Mirror, &Config) + Send + 'static) {
    let (mirror, runtime) = (state.mirror.clone(), state.runtime.clone());
    tauri::async_runtime::spawn_blocking(move || now(&mirror, &runtime, f));
}

fn version_of(photo: &Photo) -> Option<u32> {
    u32::try_from(photo.version).ok()
}

/// Fields of one version changed.
pub(crate) fn fields(state: &AppState, photo: Option<Photo>, patch: FieldOverride) {
    let Some(photo) = photo else { return };
    let Some(version) = version_of(&photo) else { return };
    if patch.is_empty() {
        return;
    }
    defer(state, move |mirror, config| {
        mirror.fields_changed(config, Path::new(&photo.path), version, patch);
    });
}

/// A virtual copy removed.
pub(crate) fn copy_removed(state: &AppState, photo: Option<Photo>) {
    let Some(photo) = photo else { return };
    let Some(version) = version_of(&photo) else { return };
    defer(state, move |mirror, config| mirror.copy_removed(config, Path::new(&photo.path), version));
}

/// A photo trashed or deleted with all its versions.
pub(crate) fn gone(state: &AppState, paths: Vec<String>) {
    defer(state, move |mirror, config| {
        for path in &paths {
            mirror.file_gone(config, Path::new(path));
        }
    });
}

/// The fields `meta_set` was given, as the engine applies them: a rating takes
/// the photo out of the rejected state, a rejection leaves the stars alone.
pub(crate) fn meta_fields(fields: &Map<String, Value>) -> FieldOverride {
    let rating = fields.get("rating").and_then(Value::as_i64).map(|r| r.clamp(0, 5) as u8);
    let rejected = fields.get("rejected").and_then(Value::as_bool);
    let location = fields.get("location").and_then(|value| {
        if value.is_null() {
            Some(None)
        } else {
            let parsed = serde_json::from_value(value.clone()).ok()?;
            crate::search_filters::gps_coordinates(&parsed).map(Some)
        }
    });
    FieldOverride {
        location,
        text: morf_photo::VersionText::from_request(fields),
        rating: rating.filter(|_| rejected != Some(true)),
        rejected: rejected.or_else(|| rating.map(|_| false)),
        labels: fields.get("labels").and_then(Value::as_i64).map(|l| (l & 31) as u32),
        ..FieldOverride::default()
    }
}

pub(crate) fn keywords_fields(keywords: Vec<String>) -> FieldOverride {
    FieldOverride { keywords: Some(keywords), ..FieldOverride::default() }
}

pub(crate) fn edited_fields(edited: bool) -> FieldOverride {
    FieldOverride { edited: Some(edited), ..FieldOverride::default() }
}

/// A capture time the engine wrote, in its "YYYY:MM:DD HH:MM:SS" spelling.
pub(crate) fn capture_fields(after: &str) -> FieldOverride {
    FieldOverride {
        taken_at: Some(taken_at(after)).filter(|t| !t.is_empty()),
        ..FieldOverride::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn given(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn meta_set_fields_become_the_fields_the_engine_sets() {
        let rated = meta_fields(&given(json!({"rating": 4})));
        assert_eq!((rated.rating, rated.rejected, rated.labels), (Some(4), Some(false), None));
        let over = meta_fields(&given(json!({"rating": 9, "labels": 33})));
        assert_eq!((over.rating, over.labels), (Some(5), Some(1)));
        // a rejection keeps the stars the photo has
        let rejected = meta_fields(&given(json!({"rejected": true, "rating": 2})));
        assert_eq!((rejected.rating, rejected.rejected), (None, Some(true)));
        let restored = meta_fields(&given(json!({"rejected": false})));
        assert_eq!((restored.rating, restored.rejected), (None, Some(false)));
        assert!(meta_fields(&given(json!({"location": {"latitude": 1}}))).is_empty());
        let text = meta_fields(&given(json!({"title": "x", "notes": ""}))).text;
        assert_eq!(text.title.as_deref(), Some("x"));
        assert_eq!(text.notes.as_deref(), Some(""));
        assert_eq!(meta_fields(&given(json!({"location": null}))).location, Some(None));
        assert_eq!(
            meta_fields(&given(json!({"location": {"latitude": 0, "longitude": 0}}))).location,
            Some(Some((0.0, 0.0))),
        );
    }

    #[test]
    fn a_capture_time_has_the_servers_spelling() {
        assert_eq!(capture_fields("2024:05:06 10:11:12").taken_at.as_deref(), Some("2024-05-06T10:11:12"));
        assert!(capture_fields("").taken_at.is_none());
    }
}
