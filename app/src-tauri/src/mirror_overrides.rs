// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! What Immage itself changed under the mapped folder, kept until the server
//! has re-indexed it: a rating, label, keyword, edit status or capture time
//! written to a sidecar, or a photo moved, copied, renamed or deleted. The local
//! copy of the catalog (`morf_mirror`) shows the server's state, which lags
//! these by the server's indexing time; readers lay this over it so a change
//! shows at once in folders and in Find.
//!
//! Everything here is plain data and pure functions. The one lock that guards
//! an `Overrides` is `Mirror.overrides` (morf_mirror.rs); readers clone it first
//! and never hold it while they query. In memory only: after a restart the
//! server has normally caught up, and if not, the server's state shows until
//! it does.

use crate::morf_photo::{ExifFields, VersionFields};
use std::{
    collections::{BTreeMap, HashMap},
    time::{Duration, Instant},
};

/// A change the server reports more than this long after we made ours is
/// newer than ours (another client, or the server's own edit): ours is dropped.
pub(crate) const NEWER_AFTER: Duration = Duration::from_secs(60);
/// No override outlives this, whatever the server says.
pub(crate) const MAX_AGE: Duration = Duration::from_secs(30 * 60);

/// A whole mirrored photo: the fields its versions share, and each version.
#[derive(Clone, Debug)]
pub(crate) struct PhotoRow {
    pub(crate) exif: ExifFields,
    pub(crate) versions: Vec<VersionFields>,
}

/// The sidecar fields Immage changed on one version; `None` is "not changed".
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct FieldOverride {
    pub(crate) rating: Option<u8>,
    pub(crate) rejected: Option<bool>,
    pub(crate) labels: Option<u32>,
    pub(crate) keywords: Option<Vec<String>>,
    pub(crate) edited: Option<bool>,
    pub(crate) taken_at: Option<String>,
    // Some(None) clears the coordinates.
    pub(crate) location: Option<Option<(f64, f64)>>,
    pub(crate) text: crate::morf_photo::VersionText,
}

// "2024:05:06 10:11:12" and "2024-05-06T10:11:12+02:00" compare as one time
fn stamp(text: &str) -> String {
    let (date, time) = text.get(..10).zip(text.get(10..)).unwrap_or((text, ""));
    format!("{}{}", date.replace(':', "-"), time.replacen(' ', "T", 1))
        .chars()
        .take(19)
        .collect()
}

/// A capture time as the server stores it (`YYYY-MM-DDTHH:MM:SS`) from the
/// engine's "YYYY:MM:DD HH:MM:SS".
pub(crate) fn taken_at(text: &str) -> String {
    stamp(text)
}

impl FieldOverride {
    pub(crate) fn is_empty(&self) -> bool {
        *self == FieldOverride::default()
    }

    // later changes win over earlier ones
    fn merge(&mut self, later: FieldOverride) {
        macro_rules! take {
            ($($field:ident),*) => { $(if later.$field.is_some() { self.$field = later.$field; })* };
        }
        take!(rating, rejected, labels, keywords, edited, taken_at, location);
        self.text.merge(later.text);
    }

    fn apply(&self, v: &mut VersionFields) {
        if let Some(rating) = self.rating {
            v.rating = rating.min(5);
        }
        if let Some(rejected) = self.rejected {
            v.rejected = rejected;
        }
        if let Some(labels) = self.labels {
            v.labels = labels & 31;
        }
        if let Some(keywords) = &self.keywords {
            v.keywords.clone_from(keywords);
        }
        if let Some(edited) = self.edited {
            v.edited = Some(edited);
        }
        if let Some(taken) = &self.taken_at {
            v.taken_at = Some(taken.clone());
        }
        if let Some(location) = self.location {
            v.latitude = location.map(|(lat, _)| lat);
            v.longitude = location.map(|(_, lon)| lon);
        }
        v.text.merge(self.text.clone());
    }

    /// Whether the server's version already has every value this one sets.
    fn converged(&self, v: &VersionFields) -> bool {
        let sorted = |k: &[String]| {
            let mut k = k.to_vec();
            k.sort();
            k
        };
        self.rating.is_none_or(|r| r.min(5) == v.rating.min(5))
            && self.rejected.is_none_or(|r| r == v.rejected)
            && self.labels.is_none_or(|l| l & 31 == v.labels & 31)
            && self.keywords.as_ref().is_none_or(|k| sorted(k) == sorted(&v.keywords))
            && self.edited.is_none_or(|e| e == v.edited.unwrap_or(false))
            && self.text.converged(&v.text)
            && self.location.is_none_or(|expected| {
                match (expected, v.latitude.zip(v.longitude)) {
                    (None, None) => true,
                    (Some((lat, lon)), Some((vlat, vlon))) => {
                        (lat - vlat).abs() < 1e-6 && (lon - vlon).abs() < 1e-6
                    }
                    _ => false,
                }
            })
            && self
                .taken_at
                .as_ref()
                .is_none_or(|t| v.taken_at.as_deref().is_some_and(|s| stamp(s) == stamp(t)))
    }
}

/// One version's change: new fields, a version that is gone (a removed virtual
/// copy), or one that is new (a created virtual copy) and not yet indexed.
#[derive(Clone, Debug)]
pub(crate) struct VersionOverride {
    patch: FieldOverride,
    removed: bool,
    added: Option<VersionFields>,
    made: Instant,
}

#[derive(Clone, Debug)]
enum FileChange {
    // deleted, or moved away
    Gone,
    // moved or copied in, as the mirror row of its source
    Added(PhotoRow),
}

#[derive(Clone, Debug)]
struct FileEntry {
    change: FileChange,
    made: Instant,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Overrides {
    // server path -> version -> change
    versions: HashMap<String, BTreeMap<u32, VersionOverride>>,
    // server path -> change of the whole file
    files: HashMap<String, FileEntry>,
}

impl Overrides {
    pub(crate) fn is_empty(&self) -> bool {
        self.versions.is_empty() && self.files.is_empty()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.paths().len()
    }

    /// Every server path with a change, sorted.
    pub(crate) fn paths(&self) -> Vec<&str> {
        let mut paths: Vec<&str> =
            self.versions.keys().chain(self.files.keys()).map(String::as_str).collect();
        paths.sort_unstable();
        paths.dedup();
        paths
    }

    pub(crate) fn touches(&self, path: &str) -> bool {
        self.versions.contains_key(path) || self.files.contains_key(path)
    }

    /// The paths of photos moved or copied in.
    pub(crate) fn added_paths(&self) -> Vec<&str> {
        let mut paths: Vec<&str> = self
            .files
            .iter()
            .filter(|(_, e)| matches!(e.change, FileChange::Added(_)))
            .map(|(p, _)| p.as_str())
            .collect();
        paths.sort_unstable();
        paths
    }

    /// Whether a change of the whole file leaves the photo at `path` present
    /// (moved or copied in) or absent (deleted, moved away); None when there is
    /// no such change.
    pub(crate) fn present_after(&self, path: &str) -> Option<bool> {
        self.files.get(path).map(|e| matches!(e.change, FileChange::Added(_)))
    }

    /// The paths as a JSON array, for a query's `json_each`; None when empty.
    pub(crate) fn json_paths(&self) -> Option<String> {
        (!self.is_empty()).then(|| serde_json::to_string(&self.paths()).unwrap_or_else(|_| "[]".into()))
    }

    /// Only the changes of these paths.
    pub(crate) fn restrict(&self, paths: &[&str]) -> Overrides {
        let mut out = Overrides::default();
        for path in paths {
            if let Some(v) = self.versions.get(*path) {
                out.versions.insert((*path).to_owned(), v.clone());
            }
            if let Some(f) = self.files.get(*path) {
                out.files.insert((*path).to_owned(), f.clone());
            }
        }
        out
    }

    pub(crate) fn note_fields(&mut self, path: &str, version: u32, patch: FieldOverride, now: Instant) {
        if patch.is_empty() {
            return;
        }
        let entry = self
            .versions
            .entry(path.to_owned())
            .or_default()
            .entry(version)
            .or_insert_with(|| VersionOverride {
                patch: FieldOverride::default(),
                removed: false,
                added: None,
                made: now,
            });
        entry.patch.merge(patch);
        entry.made = now;
    }

    pub(crate) fn note_version_removed(&mut self, path: &str, version: u32, now: Instant) {
        self.versions.entry(path.to_owned()).or_default().insert(
            version,
            VersionOverride { patch: FieldOverride::default(), removed: true, added: None, made: now },
        );
    }

    pub(crate) fn note_version_added(&mut self, path: &str, version: VersionFields, now: Instant) {
        self.versions.entry(path.to_owned()).or_default().insert(
            version.version,
            VersionOverride {
                patch: FieldOverride::default(),
                removed: false,
                added: Some(version),
                made: now,
            },
        );
    }

    // a change of the whole file supersedes the changes of its versions
    pub(crate) fn note_gone(&mut self, path: &str, now: Instant) {
        self.versions.remove(path);
        self.files.insert(path.to_owned(), FileEntry { change: FileChange::Gone, made: now });
    }

    pub(crate) fn note_added(&mut self, path: &str, row: PhotoRow, now: Instant) {
        self.versions.remove(path);
        self.files.insert(path.to_owned(), FileEntry { change: FileChange::Added(row), made: now });
    }

    pub(crate) fn clear(&mut self) {
        self.versions.clear();
        self.files.clear();
    }

    /// The photo at `path` as it is now: `base` (the server's row, if any) with
    /// the changes laid over it. None when it is gone or has no version left.
    pub(crate) fn effective(&self, path: &str, base: Option<PhotoRow>) -> Option<PhotoRow> {
        let mut photo = match self.files.get(path) {
            Some(FileEntry { change: FileChange::Gone, .. }) => return None,
            Some(FileEntry { change: FileChange::Added(row), .. }) => row.clone(),
            None => base?,
        };
        if let Some(changes) = self.versions.get(path) {
            for (number, change) in changes {
                if change.removed {
                    photo.versions.retain(|v| v.version != *number);
                    continue;
                }
                if let Some(added) = &change.added {
                    if !photo.versions.iter().any(|v| v.version == *number) {
                        photo.versions.push(added.clone());
                    }
                }
                if let Some(v) = photo.versions.iter_mut().find(|v| v.version == *number) {
                    change.patch.apply(v);
                }
            }
            photo.versions.sort_by_key(|v| v.version);
        }
        (!photo.versions.is_empty()).then_some(photo)
    }

    /// The server has just reported `path`: `server` is its row, None when the
    /// server says it is missing or deleted. Drops what the server has caught up
    /// with, and what the server changed later than we did.
    pub(crate) fn expire_path(&mut self, path: &str, server: Option<&PhotoRow>, now: Instant) {
        if let Some(entry) = self.files.get(path) {
            let done = matches!(
                (&entry.change, server),
                (FileChange::Gone, None) | (FileChange::Added(_), Some(_))
            );
            if done {
                self.files.remove(path);
            }
        }
        let Some(changes) = self.versions.get_mut(path) else { return };
        match server {
            // the photo is gone from the server: nothing is left to correct
            None => changes.clear(),
            Some(server) => changes.retain(|number, change| {
                let late = now.saturating_duration_since(change.made) > NEWER_AFTER;
                let there = server.versions.iter().find(|v| v.version == *number);
                let done = late
                    || match there {
                        None => change.removed || change.added.is_none(),
                        Some(v) => !change.removed && change.patch.converged(v),
                    };
                !done
            }),
        }
        if changes.is_empty() {
            self.versions.remove(path);
        }
    }

    /// Drops what has stood for `MAX_AGE`.
    pub(crate) fn expire_age(&mut self, now: Instant) {
        let old = |made: Instant| now.saturating_duration_since(made) > MAX_AGE;
        self.files.retain(|_, e| !old(e.made));
        for changes in self.versions.values_mut() {
            changes.retain(|_, c| !old(c.made));
        }
        self.versions.retain(|_, c| !c.is_empty());
    }
}

/// A version's fields from the engine's image, for a created virtual copy.
pub(crate) fn version_from_image(image: &crate::typed_library::LibraryImage) -> VersionFields {
    VersionFields {
        version: image.version,
        copy: image.copy,
        rating: image.rating.min(5),
        rejected: image.rejected,
        labels: image.labels & 31,
        edited: Some(image.edited),
        taken_at: Some(image.exif.capture_time_raw.clone())
            .filter(|t| !t.is_empty())
            .or_else(|| (!image.exif.datetime.is_empty()).then(|| taken_at(&image.exif.datetime))),
        latitude: image.location.as_ref().map(|l| l.latitude.as_f64().unwrap_or(0.0)),
        longitude: image.location.as_ref().map(|l| l.longitude.as_f64().unwrap_or(0.0)),
        keywords: image.keywords.clone(),
        text: crate::morf_photo::VersionText::from_image(image),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn exif() -> ExifFields {
        ExifFields {
            maker: "Maker".into(),
            model: "Model".into(),
            lens: String::new(),
            body_serial: String::new(),
            shutter: 0.0,
            aperture: 0.0,
            iso: 0.0,
            focal: 0.0,
            bias: 0.0,
            mtime: None,
            width: 0,
            height: 0,
        }
    }

    pub(crate) fn version(number: u32, rating: u8) -> VersionFields {
        VersionFields {
            version: number,
            copy: number > 0,
            rating,
            rejected: false,
            labels: 1,
            edited: None,
            taken_at: Some("2026-06-01T10:11:12".into()),
            latitude: None,
            longitude: None,
            keywords: vec!["a".into()],
            text: crate::morf_photo::VersionText::default(),
        }
    }

    fn photo(versions: Vec<VersionFields>) -> PhotoRow {
        PhotoRow { exif: exif(), versions }
    }

    fn rated(r: u8) -> FieldOverride {
        FieldOverride { rating: Some(r), ..Default::default() }
    }

    #[test]
    fn fields_replace_what_the_server_has_and_later_notes_win() {
        let now = Instant::now();
        let mut o = Overrides::default();
        o.note_fields("/p/a.ARW", 0, rated(4), now);
        o.note_fields(
            "/p/a.ARW",
            0,
            FieldOverride { rating: Some(5), keywords: Some(vec!["x".into()]), ..Default::default() },
            now,
        );
        o.note_fields("/p/a.ARW", 0, FieldOverride { rejected: Some(true), ..Default::default() }, now);
        let got = o.effective("/p/a.ARW", Some(photo(vec![version(0, 1), version(1, 2)]))).unwrap();
        assert_eq!((got.versions[0].rating, got.versions[0].rejected), (5, true));
        assert_eq!(got.versions[0].keywords, ["x"]);
        // the other version is as the server has it
        assert_eq!((got.versions[1].rating, got.versions[1].rejected), (2, false));
        // a path nobody changed, and an empty change
        assert!(o.effective("/p/b.ARW", None).is_none());
        o.note_fields("/p/c.ARW", 0, FieldOverride::default(), now);
        assert!(!o.touches("/p/c.ARW"));
    }

    #[test]
    fn gone_and_added_files_and_virtual_copies() {
        let now = Instant::now();
        let mut o = Overrides::default();
        o.note_fields("/p/a.ARW", 0, rated(3), now);
        o.note_gone("/p/a.ARW", now);
        assert!(o.effective("/p/a.ARW", Some(photo(vec![version(0, 1)]))).is_none());
        // an added file stands without a server row, and replaces one
        o.note_added("/q/a.ARW", photo(vec![version(0, 5)]), now);
        assert_eq!(o.effective("/q/a.ARW", None).unwrap().versions[0].rating, 5);
        assert_eq!(o.effective("/q/a.ARW", Some(photo(vec![version(0, 1)]))).unwrap().versions[0].rating, 5);
        assert_eq!(o.added_paths(), ["/q/a.ARW"]);
        // a change after the move applies to the added row
        o.note_fields("/q/a.ARW", 0, rated(2), now);
        assert_eq!(o.effective("/q/a.ARW", None).unwrap().versions[0].rating, 2);
        // a virtual copy removed, and one created
        o.note_version_removed("/r/x.ARW", 1, now);
        o.note_version_added("/r/x.ARW", version(2, 4), now);
        o.note_fields("/r/x.ARW", 2, rated(1), now);
        let got = o.effective("/r/x.ARW", Some(photo(vec![version(0, 1), version(1, 1)]))).unwrap();
        let numbers: Vec<_> = got.versions.iter().map(|v| (v.version, v.rating)).collect();
        assert_eq!(numbers, [(0, 1), (2, 1)]);
        // a photo with no version left is gone
        let mut o = Overrides::default();
        o.note_version_removed("/r/y.ARW", 0, now);
        assert!(o.effective("/r/y.ARW", Some(photo(vec![version(0, 1)]))).is_none());
        assert_eq!(o.json_paths().as_deref(), Some("[\"/r/y.ARW\"]"));
    }

    #[test]
    fn a_change_to_the_whole_file_supersedes_its_versions() {
        let now = Instant::now();
        let mut o = Overrides::default();
        o.note_fields("/p/a.ARW", 0, rated(3), now);
        o.note_added("/p/a.ARW", photo(vec![version(0, 5)]), now);
        assert_eq!(o.effective("/p/a.ARW", None).unwrap().versions[0].rating, 5);
        o.note_gone("/p/a.ARW", now);
        assert_eq!(o.len(), 1);
    }

    #[test]
    fn converged_fields_expire_and_others_wait() {
        let t0 = Instant::now();
        let mut o = Overrides::default();
        o.note_fields(
            "/p/a.ARW",
            0,
            FieldOverride {
                rating: Some(4),
                keywords: Some(vec!["b".into(), "a".into()]),
                taken_at: Some("2026:06:01 10:11:12".into()),
                ..Default::default()
            },
            t0,
        );
        // the server has a different rating: kept
        let mut server = photo(vec![version(0, 3)]);
        server.versions[0].keywords = vec!["a".into(), "b".into()];
        o.expire_path("/p/a.ARW", Some(&server), t0 + Duration::from_secs(5));
        assert!(o.touches("/p/a.ARW"));
        // the server has every value we set, whatever its spelling: dropped
        server.versions[0].rating = 4;
        o.expire_path("/p/a.ARW", Some(&server), t0 + Duration::from_secs(5));
        assert!(!o.touches("/p/a.ARW"));
    }

    #[test]
    fn a_server_change_long_after_ours_is_newer_than_ours() {
        let t0 = Instant::now();
        let mut o = Overrides::default();
        o.note_fields("/p/a.ARW", 0, rated(4), t0);
        let server = photo(vec![version(0, 2)]);
        o.expire_path("/p/a.ARW", Some(&server), t0 + NEWER_AFTER);
        assert!(o.touches("/p/a.ARW"), "exactly at the limit is not later");
        o.expire_path("/p/a.ARW", Some(&server), t0 + NEWER_AFTER + Duration::from_secs(1));
        assert!(!o.touches("/p/a.ARW"));
    }

    #[test]
    fn file_changes_expire_when_the_server_reports_the_path() {
        let t0 = Instant::now();
        let mut o = Overrides::default();
        o.note_gone("/p/a.ARW", t0);
        o.note_added("/q/a.ARW", photo(vec![version(0, 1)]), t0);
        // the server still lists the moved-away file, and not yet the new one
        o.expire_path("/p/a.ARW", Some(&photo(vec![version(0, 1)])), t0 + Duration::from_secs(1));
        o.expire_path("/q/a.ARW", None, t0 + Duration::from_secs(1));
        assert_eq!(o.len(), 2);
        // the server says the old path is missing and the new one present
        o.expire_path("/p/a.ARW", None, t0 + Duration::from_secs(2));
        o.expire_path("/q/a.ARW", Some(&photo(vec![version(0, 1)])), t0 + Duration::from_secs(2));
        assert!(o.is_empty());
    }

    #[test]
    fn version_changes_expire_with_their_version() {
        let t0 = Instant::now();
        let mut o = Overrides::default();
        o.note_version_removed("/p/a.ARW", 1, t0);
        o.note_version_added("/p/a.ARW", version(2, 1), t0);
        let both = photo(vec![version(0, 1), version(1, 1)]);
        o.expire_path("/p/a.ARW", Some(&both), t0 + Duration::from_secs(1));
        // the copy is still there and the new one not yet
        assert!(o.touches("/p/a.ARW"));
        let after = photo(vec![version(0, 1), version(2, 1)]);
        o.expire_path("/p/a.ARW", Some(&after), t0 + Duration::from_secs(2));
        assert!(o.is_empty());
        // a photo the server reports gone takes its version changes with it
        o.note_fields("/p/b.ARW", 0, rated(1), t0);
        o.expire_path("/p/b.ARW", None, t0);
        assert!(o.is_empty());
    }

    #[test]
    fn nothing_outlives_the_age_limit() {
        let t0 = Instant::now();
        let mut o = Overrides::default();
        o.note_fields("/p/a.ARW", 0, rated(1), t0);
        o.note_gone("/p/b.ARW", t0);
        o.note_added("/p/c.ARW", photo(vec![version(0, 1)]), t0 + Duration::from_secs(600));
        o.expire_age(t0 + MAX_AGE);
        assert_eq!(o.len(), 3);
        o.expire_age(t0 + MAX_AGE + Duration::from_secs(1));
        assert_eq!(o.paths(), ["/p/c.ARW"]);
        o.expire_age(t0 + Duration::from_secs(600) + MAX_AGE + Duration::from_secs(1));
        assert!(o.is_empty());
    }

    #[test]
    fn taken_at_has_one_spelling() {
        assert_eq!(taken_at("2024:05:06 10:11:12"), "2024-05-06T10:11:12");
        assert_eq!(taken_at("2024-05-06T10:11:12+02:00"), "2024-05-06T10:11:12");
        assert_eq!(taken_at("2024-05-06"), "2024-05-06");
    }
}
