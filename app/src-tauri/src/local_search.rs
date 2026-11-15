// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
//! Exact bounded-memory retrieval over disposable, model-versioned vectors.
use crate::{
    immich_search::SearchArgs,
    search_cache::SearchCache,
    search_filters::{self, GridFilter},
    typed_library::LibraryImage,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::BinaryHeap,
    path::{Path, PathBuf},
};
pub const ANALYSIS_VERSION: i64 = 1;
pub const MODEL_VERSION: &str = crate::clip_models::REVISION;
#[derive(Clone, Serialize, Deserialize, specta::Type)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct LocalSearchArgs {
    pub text: String,
    pub mode: String,
    pub image_variant: Option<String>,
    pub subject: String,
    pub scope: String,
    pub folder: Option<String>,
    pub recursive: bool,
    pub filters: GridFilter,
    pub remote: SearchArgs,
    pub next: Option<String>,
    pub size: u32,
}
impl Default for LocalSearchArgs {
    fn default() -> Self {
        Self {
            text: String::new(),
            mode: "smart".into(),
            image_variant: None,
            subject: "edited".into(),
            scope: "library".into(),
            folder: None,
            recursive: false,
            filters: GridFilter::default(),
            remote: SearchArgs::default(),
            next: None,
            size: 100,
        }
    }
}
impl LocalSearchArgs {
    pub fn validate(&self) -> Result<(), String> {
        if self.text.len() > 65536
            || !matches!(self.mode.as_str(), "smart" | "filename")
            || !matches!(self.subject.as_str(), "original" | "edited")
            || !matches!(self.scope.as_str(), "folder" | "library")
            || self.size == 0
            || self.size > 250
            || self.next.as_ref().is_some_and(|s| s.len() > 2048)
        {
            return Err("Invalid local search request".into());
        }
        if self.scope == "folder"
            && self
                .folder
                .as_ref()
                .is_none_or(|s| !Path::new(s).is_absolute())
        {
            return Err("Choose a current folder for local search".into());
        }
        if self.image_variant.is_some() && (!self.text.trim().is_empty() || self.mode != "smart") {
            return Err("Choose text or an image query".into());
        }
        search_filters::validate(&self.filters, &self.remote)
    }
}
#[derive(Serialize, specta::Type)]
pub struct LocalHit {
    pub asset_id: String,
    pub variant_id: String,
    pub subject: String,
    pub score: f64,
    pub image: LibraryImage,
}
#[derive(Serialize, specta::Type)]
pub struct LocalPage {
    pub items: Vec<LocalHit>,
    pub next: Option<String>,
    pub revision: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    signature: String,
    revision: String,
    score: f64,
    variant_id: i64,
}
struct Ranked {
    score: f64,
    id: i64,
    hit: LocalHit,
}
impl PartialEq for Ranked {
    fn eq(&self, o: &Self) -> bool {
        self.score.to_bits() == o.score.to_bits() && self.id == o.id
    }
}
impl Eq for Ranked {}
impl PartialOrd for Ranked {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Ranked {
    fn cmp(&self, o: &Self) -> Ordering {
        o.score.total_cmp(&self.score).then(self.id.cmp(&o.id))
    }
}
pub fn decode(bytes: &[u8]) -> Result<Vec<f32>, String> {
    if bytes.len() != 512 * 4 {
        return Err("Invalid cached embedding dimensions".into());
    }
    let values: Vec<f32> = bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect();
    validate_vector(&values)?;
    Ok(values)
}
fn validate_vector(values: &[f32]) -> Result<(), String> {
    if values.len() != 512 || values.iter().any(|v| !v.is_finite()) {
        return Err("Invalid embedding values".into());
    }
    let norm = values
        .iter()
        .map(|&v| f64::from(v) * f64::from(v))
        .sum::<f64>();
    if (norm - 1.0).abs() > 1e-4 {
        return Err("Embedding is not normalized".into());
    }
    Ok(())
}
fn in_scope(path: &Path, args: &LocalSearchArgs, roots: &[PathBuf], hidden: &[PathBuf]) -> bool {
    if hidden.iter().any(|p| path.starts_with(p)) || !roots.iter().any(|p| path.starts_with(p)) {
        return false;
    }
    if args.scope == "library" {
        return true;
    }
    let folder = Path::new(args.folder.as_deref().unwrap_or(""));
    if args.recursive {
        path.starts_with(folder)
    } else {
        path.parent() == Some(folder)
    }
}
pub fn retrieve(
    cache: &SearchCache,
    args: &LocalSearchArgs,
    roots: &[PathBuf],
    hidden: &[PathBuf],
    text_vector: Option<Vec<f32>>,
    cancelled: impl Fn() -> bool,
) -> Result<LocalPage, String> {
    args.validate()?;
    let revision = cache.revision()?;
    let (vector, exclude) = if let Some(id) = &args.image_variant {
        let id = id
            .parse::<i64>()
            .ok()
            .filter(|v| *v > 0)
            .ok_or("Invalid indexed photo identity")?;
        let (asset, bytes) = cache
            .image_query(id, &args.subject, ANALYSIS_VERSION, MODEL_VERSION)?
            .ok_or("This photo has no current local embedding")?;
        (Some(decode(&bytes)?), Some(asset))
    } else {
        (text_vector, None)
    };
    if let Some(v) = &vector {
        validate_vector(v)?;
    }
    if args.mode == "smart" && !args.text.trim().is_empty() && vector.is_none() {
        return Err("Local text analysis is unavailable".into());
    }
    let mut parameters = serde_json::to_value(args).map_err(|e| e.to_string())?;
    parameters.as_object_mut().unwrap().remove("next");
    let mut hash = Sha256::new();
    hash.update(
        serde_json::to_vec(&(parameters, roots, hidden, MODEL_VERSION, ANALYSIS_VERSION))
            .map_err(|e| e.to_string())?,
    );
    if let Some(v) = &vector {
        for n in v {
            hash.update(n.to_le_bytes());
        }
    }
    let signature = format!("{:x}", hash.finalize());
    let cursor = args
        .next
        .as_ref()
        .map(|s| serde_json::from_str::<Cursor>(s).map_err(|_| "Invalid local search cursor"))
        .transpose()?;
    if cursor.as_ref().is_some_and(|c| {
        c.signature != signature
            || c.revision != revision
            || !c.score.is_finite()
            || c.variant_id <= 0
    }) {
        return Err("Local index or query changed; restart the search".into());
    }
    let mut heap = BinaryHeap::new();
    let needed = args.size as usize + 1;
    let mut after = 0;
    loop {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        if cache.revision() != Ok(revision.clone()) {
            return Err("Local index changed; restart the search".into());
        }
        let batch = cache.candidates(
            after,
            &args.subject,
            ANALYSIS_VERSION,
            MODEL_VERSION,
            vector.is_some(),
        )?;
        if batch.is_empty() {
            break;
        }
        for row in batch {
            after = row.variant_id;
            if cancelled() {
                return Err("Search cancelled".into());
            }
            if exclude == Some(row.asset_id) || !in_scope(Path::new(&row.path), args, roots, hidden)
            {
                continue;
            }
            let Some(raw) = row.metadata.as_deref() else {
                continue;
            };
            let Ok(mut metadata) = serde_json::from_str::<serde_json::Value>(raw) else {
                continue;
            };
            let Some(object) = metadata.as_object_mut() else {
                continue;
            };
            object.insert("imgid".into(), serde_json::json!(0));
            let Ok(image) = serde_json::from_value::<LibraryImage>(metadata) else {
                continue;
            };
            if image.path != row.path
                || (if row.copy_key.is_empty() { Some(0) } else { row.copy_key.strip_prefix("version:").and_then(|s|s.parse::<u32>().ok()) }) != Some(image.version)
                || Path::new(&image.path).file_name().and_then(|p| p.to_str())
                    != Some(image.filename.as_str())
                || !search_filters::passes(
                    &image,
                    row.capture_raw.as_deref(),
                    &args.filters,
                    &args.remote,
                )
            {
                continue;
            }
            if args.mode == "filename"
                && !image
                    .filename
                    .to_lowercase()
                    .contains(&args.text.to_lowercase())
            {
                continue;
            }
            let score = if let Some(q) = &vector {
                let Some(bytes) = row.embedding.as_deref() else {
                    continue;
                };
                let Ok(v) = decode(bytes) else {
                    continue;
                };
                q.iter()
                    .zip(v.iter())
                    .map(|(a, b)| f64::from(*a) * f64::from(*b))
                    .sum::<f64>()
                    .clamp(-1.0, 1.0)
            } else {
                0.0
            };
            if cursor.as_ref().is_some_and(|c| {
                score > c.score || (score == c.score && row.variant_id <= c.variant_id)
            }) {
                continue;
            }
            heap.push(Ranked {
                score,
                id: row.variant_id,
                hit: LocalHit {
                    asset_id: row.asset_id.to_string(),
                    variant_id: row.variant_id.to_string(),
                    subject: args.subject.clone(),
                    score,
                    image,
                },
            });
            if heap.len() > needed {
                heap.pop();
            }
        }
    }
    if cancelled() {
        return Err("Search cancelled".into());
    }
    if cache.revision() != Ok(revision.clone()) {
        return Err("Local index changed; restart the search".into());
    }
    let mut sorted = heap.into_vec();
    sorted.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.id.cmp(&b.id)));
    let more = sorted.len() > args.size as usize;
    sorted.truncate(args.size as usize);
    let next = if more {
        sorted
            .last()
            .map(|last| {
                serde_json::to_string(&Cursor {
                    signature,
                    revision: revision.clone(),
                    score: last.score,
                    variant_id: last.id,
                })
                .map_err(|e| e.to_string())
            })
            .transpose()?
    } else {
        None
    };
    Ok(LocalPage {
        items: sorted.into_iter().map(|r| r.hit).collect(),
        next,
        revision,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_cache::Variant;
    fn unit(x: f32, y: f32) -> Vec<f32> {
        let mut v = vec![0.0; 512];
        v[0] = x;
        v[1] = y;
        v
    }
    fn seed(cache: &SearchCache, path: &Path, version: u32, vector: &[f32]) -> Variant {
        let edit = format!("edit-{version}");
        let variant = cache
            .upsert_variant(
                &path.to_string_lossy(),
                &(if version==0 { String::new() } else { format!("version:{version}") }),
                "source",
                &edit,
                None,
                None,
                None,
            )
            .unwrap();
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../tests/engine-replies/import.json")).unwrap();
        let mut image = fixtures
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|v| v["reply"]["images"].as_array().into_iter().flatten())
            .next()
            .unwrap()
            .clone();
        image.as_object_mut().unwrap().remove("imgid");
        image["path"] = serde_json::json!(path);
        image["filename"] = serde_json::json!(path.file_name().unwrap().to_str().unwrap());
        image["version"] = serde_json::json!(version);
        image["copy"] = serde_json::json!(version > 0);
        image["rating"] = serde_json::json!(4);
        image["rejected"] = serde_json::json!(false);
        image["labels"] = serde_json::json!(1);
        image["keywords"] = serde_json::json!(["Places|Beach"]);
        image["exif"]["datetime"] = serde_json::json!("2025:04:03 12:00:00");
        cache
            .store_metadata(variant.id, &image.to_string())
            .unwrap();
        let bytes: Vec<_> = vector.iter().flat_map(|v| v.to_le_bytes()).collect();
        cache
            .put_analysis(
                variant.id,
                "edited",
                &edit,
                ANALYSIS_VERSION,
                MODEL_VERSION,
                &bytes,
            )
            .unwrap();
        variant
    }
    struct Fixture {
        _dir: tempfile::TempDir,
        cache: SearchCache,
        roots: Vec<PathBuf>,
        hidden: Vec<PathBuf>,
        a: Variant,
        copy: Variant,
    }
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let root = dir.path().join("photos");
        let other = dir.path().join("other");
        let a = seed(&cache, &root.join("a.jpg"), 0, &unit(1.0, 0.0));
        seed(&cache, &root.join("b.jpg"), 0, &unit(1.0, 0.0));
        seed(&cache, &root.join("nested/c.jpg"), 0, &unit(0.6, 0.8));
        seed(
            &cache,
            &dir.path().join("photos-other/outside.jpg"),
            0,
            &unit(1.0, 0.0),
        );
        seed(&cache, &root.join("hidden/d.jpg"), 0, &unit(1.0, 0.0));
        seed(&cache, &other.join("e.jpg"), 0, &unit(0.0, 1.0));
        let copy = seed(&cache, &root.join("a.jpg"), 1, &unit(1.0, 0.0));
        Fixture {
            _dir: dir,
            cache,
            roots: vec![root.clone(), other],
            hidden: vec![root.join("hidden")],
            a,
            copy,
        }
    }
    fn run(f: &Fixture, args: &LocalSearchArgs) -> Result<LocalPage, String> {
        retrieve(
            &f.cache,
            args,
            &f.roots,
            &f.hidden,
            Some(unit(1.0, 0.0)),
            || false,
        )
    }
    /// Synthetic vectors isolate retrieval; this does not measure CLIP inference.
    #[test]
    #[ignore = "manual retrieval benchmark"]
    fn benchmark_cached_retrieval() {
        let f = fixture();
        let count = std::env::var("IMMAGE_SEARCH_BENCH_ROWS").ok().and_then(|s|s.parse::<usize>().ok()).unwrap_or(10_000).clamp(100,100_000);
        for n in 0..count {
            let angle = (n % 1000) as f32 / 1000.0;
            seed(&f.cache, &f.roots[0].join(format!("bench-{n:06}.jpg")), 0, &unit(angle, (1.0-angle*angle).sqrt()));
        }
        for (label,args) in [
            ("metadata",LocalSearchArgs{mode:"filename".into(),size:250,..Default::default()}),
            ("vector",LocalSearchArgs{text:"synthetic query".into(),size:250,..Default::default()}),
        ] {
            let mut samples=Vec::new();
            for _ in 0..6 { let start=std::time::Instant::now(); let page=run(&f,&args).unwrap();assert_eq!(page.items.len(),250);samples.push(start.elapsed().as_secs_f64()*1000.0); }
            let first=samples.remove(0);samples.sort_by(f64::total_cmp);
            eprintln!("SEARCH_BENCH rows={} mode={} first_ms={:.3} warm_median_ms={:.3} warm_samples_ms={:?} debug={}",count+7,label,first,samples[2],samples,cfg!(debug_assertions));
        }
    }

    #[test]
    fn ranks_with_stable_ties_paginates_and_enforces_component_scopes() {
        let f = fixture();
        let mut args = LocalSearchArgs {
            text: "cat".into(),
            size: 2,
            ..Default::default()
        };
        let first = run(&f, &args).unwrap();
        assert_eq!(
            first
                .items
                .iter()
                .map(|i| i.image.filename.as_str())
                .collect::<Vec<_>>(),
            vec!["a.jpg", "b.jpg"]
        );
        args.next = first.next;
        let second = run(&f, &args).unwrap();
        assert_eq!(second.items[0].variant_id, f.copy.id.to_string());
        assert_eq!(second.items[1].image.filename, "c.jpg");
        args.next = second.next;
        let third = run(&f, &args).unwrap();
        assert_eq!(third.items.len(), 1);
        assert_eq!(third.items[0].image.filename, "e.jpg");
        assert!(third.next.is_none());
        args.next = None;
        args.size = 100;
        args.scope = "folder".into();
        args.folder = Some(f.roots[0].to_string_lossy().into_owned());
        assert_eq!(run(&f, &args).unwrap().items.len(), 3);
        args.recursive = true;
        assert_eq!(run(&f, &args).unwrap().items.len(), 4);
    }
    #[test]
    fn indexed_image_excludes_original_and_all_copies_and_rejects_stale_versions() {
        let f = fixture();
        let args = LocalSearchArgs {
            image_variant: Some(f.a.id.to_string()),
            ..Default::default()
        };
        let page = run(&f, &args).unwrap();
        assert_eq!(page.items.len(), 3);
        assert!(page
            .items
            .iter()
            .all(|i| i.asset_id != f.a.asset_id.to_string()));
        f.cache
            .invalidate_edited(&f.roots[0].join("a.jpg").to_string_lossy(), "")
            .unwrap();
        assert!(run(&f, &args).err().unwrap().contains("no current"));
    }
    #[test]
    fn cursor_rejects_filter_query_and_index_changes() {
        let f = fixture();
        let mut args = LocalSearchArgs {
            text: "cat".into(),
            size: 1,
            ..Default::default()
        };
        let first = run(&f, &args).unwrap();
        args.next = first.next;
        args.filters.min_rating = 5;
        assert!(run(&f, &args).is_err());
        args.filters.min_rating = 0;
        args.text = "dog".into();
        assert!(run(&f, &args).is_err());
        args.text = "cat".into();
        f.cache
            .invalidate_edited(&f.roots[0].join("b.jpg").to_string_lossy(), "")
            .unwrap();
        assert!(run(&f, &args).is_err());
    }
    #[test]
    fn metadata_listing_needs_no_model_and_unknown_selected_filters_exclude() {
        let f = fixture();
        let mut args = LocalSearchArgs {
            mode: "filename".into(),
            text: "a.jpg".into(),
            ..Default::default()
        };
        let search = |a: &LocalSearchArgs| {
            retrieve(&f.cache, a, &f.roots, &f.hidden, None, || false).unwrap()
        };
        assert_eq!(search(&args).items.len(), 2);
        args.remote.favorites = true;
        assert!(search(&args).items.is_empty());
        args.remote.favorites = false;
        args.remote.person_ids.push("server-person".into());
        assert!(search(&args).items.is_empty());
        args.remote.person_ids.clear();
        args.remote.country = Some("US".into());
        assert!(search(&args).items.is_empty());
        args.remote.country = None;
        args.filters.keywords.push("Places".into());
        assert_eq!(search(&args).items.len(), 2);
        args.filters.min_rating = 5;
        assert!(search(&args).items.is_empty());
    }
    #[test]
    fn original_analysis_is_shared_and_missing_or_corrupt_embeddings_are_skipped() {
        let f = fixture();
        let args = LocalSearchArgs {
            text: "cat".into(),
            subject: "original".into(),
            ..Default::default()
        };
        assert!(run(&f, &args).unwrap().items.is_empty());
        let bytes: Vec<_> = unit(1.0, 0.0)
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        f.cache
            .put_analysis(
                f.a.id,
                "original",
                "source",
                ANALYSIS_VERSION,
                MODEL_VERSION,
                &bytes,
            )
            .unwrap();
        assert_eq!(run(&f, &args).unwrap().items.len(), 2);
        f.cache
            .put_analysis(
                f.a.id,
                "original",
                "source",
                ANALYSIS_VERSION,
                MODEL_VERSION,
                b"broken",
            )
            .unwrap();
        assert!(run(&f, &args).unwrap().items.is_empty());
        assert!(decode(&vec![0; 512 * 4]).is_err());
        let nan: Vec<_> = vec![f32::NAN; 512]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        assert!(decode(&nan).is_err());
    }
    #[test]
    fn cancellation_and_mid_scan_mutation_never_publish_a_page() {
        let f = fixture();
        let args = LocalSearchArgs::default();
        assert!(retrieve(&f.cache, &args, &f.roots, &f.hidden, None, || true).is_err());
        let calls = std::cell::Cell::new(0);
        let result = retrieve(&f.cache, &args, &f.roots, &f.hidden, None, || {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                f.cache
                    .invalidate_edited(&f.roots[0].join("b.jpg").to_string_lossy(), "")
                    .unwrap();
            }
            false
        });
        assert!(result.is_err());
    }
    #[test]
    fn crosses_candidate_batches_and_detects_other_connection_changes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.sqlite");
        let cache = SearchCache::open(&path).unwrap();
        let root = dir.path().join("photos");
        for n in 0..270 {
            seed(
                &cache,
                &root.join(format!("{n:03}.jpg")),
                0,
                &unit(1.0, 0.0),
            );
        }
        let mut args = LocalSearchArgs {
            text: "cat".into(),
            size: 250,
            ..Default::default()
        };
        let first = retrieve(
            &cache,
            &args,
            std::slice::from_ref(&root),
            &[],
            Some(unit(1.0, 0.0)),
            || false,
        )
        .unwrap();
        assert_eq!(first.items.len(), 250);
        args.next = first.next;
        let second = retrieve(
            &cache,
            &args,
            std::slice::from_ref(&root),
            &[],
            Some(unit(1.0, 0.0)),
            || false,
        )
        .unwrap();
        assert_eq!(second.items.len(), 20);
        assert!(second.next.is_none());
        assert!(first
            .items
            .iter()
            .all(|a| second.items.iter().all(|b| a.variant_id != b.variant_id)));
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute(
            "UPDATE variants SET capture_time_raw='2026-01-01T00:00:00Z' WHERE id=1",
            [],
        )
        .unwrap();
        assert!(retrieve(
            &cache,
            &args,
            std::slice::from_ref(&root),
            &[],
            Some(unit(1.0, 0.0)),
            || false
        )
        .is_err());
    }
    #[test]
    fn date_filters_require_capture_data_and_honor_precise_raw_local_date() {
        let f = fixture();
        let path = f.roots[0].join("a.jpg");
        let mut metadata: serde_json::Value =
            serde_json::from_str(&f.cache.metadata(f.a.id).unwrap().unwrap()).unwrap();
        metadata["exif"]["datetime"] = serde_json::json!("");
        metadata["exif"]["file_datetime"] = serde_json::json!("2025:04:03 12:00:00");
        f.cache
            .store_metadata(f.a.id, &metadata.to_string())
            .unwrap();
        let mut args = LocalSearchArgs {
            mode: "filename".into(),
            text: "a.jpg".into(),
            ..Default::default()
        };
        args.filters.taken_from = "2025-01-01".into();
        let page = retrieve(&f.cache, &args, &f.roots, &f.hidden, None, || false).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].variant_id, f.copy.id.to_string());
        f.cache
            .upsert_variant(
                &path.to_string_lossy(),
                "",
                "source",
                "edit-0",
                None,
                Some("2024-12-31T23:59:59.999999999-08:00"),
                Some(-28800),
            )
            .unwrap();
        args.filters.taken_from = "2024-12-31".into();
        args.filters.taken_to = "2024-12-31".into();
        let page = retrieve(&f.cache, &args, &f.roots, &f.hidden, None, || false).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].variant_id, f.a.id.to_string());
    }
}
