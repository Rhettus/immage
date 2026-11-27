// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Find's value lists over the whole library: every kind, keyword, camera,
//! body, lens, capture month and exposure setting with how many photos hold it,
//! for the search's folders. Under Search in = All folders the page lists these
//! instead of what its loaded result pages hold.
//!
//! The counts are those of `facets` / `facetsWithin` in filter.ts: each list is
//! counted over the photos every filter but its own admits, so choosing a camera
//! narrows the lenses and the other cameras stay listed. Photos under a mapped
//! morfPhoto folder are counted by SQL over the local copy
//! (`mirror_query::Source::facets`); the photos of Immage's own cache (every
//! other root, and a mapped folder whose copy is not complete yet) are counted
//! in Rust with `search_filters::passes`, batch by batch, outside the cache's
//! lock.
//!
//! Order. kinds, exposure settings (by value) and months (newest first) come
//! out in filter.ts's order. Names (keywords, cameras, bodies, lenses) come out
//! in plain code point order; the page sorts what it shows by `localeCompare`,
//! which Rust cannot do the same way.
//!
//! Threads and locks. The command is async and runs on a blocking thread; it
//! takes no lock of its own. The cache is read in batches of 256 rows, its lock
//! held for one batch at a time, never while counting. Cancel is the request id
//! of `local_search_cancel`.

use crate::{
    clip_providers,
    immich_search::SearchArgs,
    local_search::{self, LocalSearchArgs},
    local_search_cmds, mirror_overrides::Overrides, mirror_query,
    morf_photo,
    search_cache::SearchCache,
    search_filters::{self as sf, GridFilter},
    typed_library::LibraryImage,
    AppState,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::State;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum List {
    Kinds,
    Keywords,
    Cameras,
    Bodies,
    Lenses,
    Months,
    Iso,
    Aperture,
    Focal,
    Shutter,
}

const ALL: [List; 10] = [
    List::Kinds,
    List::Keywords,
    List::Cameras,
    List::Bodies,
    List::Lenses,
    List::Months,
    List::Iso,
    List::Aperture,
    List::Focal,
    List::Shutter,
];

impl List {
    fn parse(name: &str) -> Option<List> {
        Some(match name {
            "kinds" => List::Kinds,
            "keywords" => List::Keywords,
            "cameras" => List::Cameras,
            "bodies" => List::Bodies,
            "lenses" => List::Lenses,
            "months" => List::Months,
            "iso" => List::Iso,
            "aperture" => List::Aperture,
            "focal" => List::Focal,
            "shutter" => List::Shutter,
            _ => return None,
        })
    }
}

/// Counts per value, with the smallest number a value was recorded as (the
/// exposure lists sort by it).
pub(crate) struct Tallies(Vec<HashMap<String, (u32, f64)>>);

impl Tallies {
    pub(crate) fn new() -> Tallies {
        Tallies(vec![HashMap::new(); ALL.len()])
    }
    pub(crate) fn merge(&mut self, other: Tallies) {
        for (list, map) in other.0.into_iter().enumerate() {
            for (key, (n, number)) in map {
                let entry = self.0[list].entry(key).or_insert((0, number));
                entry.0 += n;
                entry.1 = entry.1.min(number);
            }
        }
    }
    pub(crate) fn add(&mut self, list: List, key: String, n: u32, number: f64) {
        let entry = self.0[list as usize].entry(key).or_insert((0, number));
        entry.0 += n;
        entry.1 = entry.1.min(number);
    }
    #[cfg(test)]
    pub(crate) fn snapshot(&self, list: List) -> Vec<(String, u32, u64)> {
        let mut all: Vec<_> =
            self.0[list as usize].iter().map(|(k, v)| (k.clone(), v.0, v.1.to_bits())).collect();
        all.sort();
        all
    }
    fn bump(&mut self, list: List, key: &str, number: f64) {
        if !key.is_empty() {
            self.add(list, key.to_owned(), 1, number);
        }
    }
}

/// Each keyword and every level above it: "a|b|c" gives "a", "a|b", "a|b|c".
pub(crate) fn levels(keyword: &str, mut each: impl FnMut(&str)) {
    for (at, c) in keyword.char_indices() {
        if c == '|' && at > 0 {
            each(&keyword[..at]);
        }
    }
    if !keyword.is_empty() {
        each(keyword);
    }
}

/// The filter a list is counted under: every choice but its own.
pub(crate) fn without(list: List, f: &GridFilter, r: &SearchArgs) -> (GridFilter, SearchArgs) {
    let (mut f, mut r) = (f.clone(), r.clone());
    match list {
        List::Kinds => {
            f.kinds.clear();
            r.raw_only = false;
        }
        List::Keywords => f.keywords.clear(),
        List::Cameras => f.cameras.clear(),
        List::Bodies => f.bodies.clear(),
        List::Lenses => f.lenses.clear(),
        List::Months => {
            f.taken_from.clear();
            f.taken_to.clear();
            r.taken_from = None;
            r.taken_to = None;
        }
        List::Iso => f.iso.clear(),
        List::Aperture => f.aperture.clear(),
        List::Focal => f.focal.clear(),
        List::Shutter => f.shutter.clear(),
    }
    (f, r)
}

type Counted = Vec<(String, u32)>;

#[derive(Default, Serialize, specta::Type)]
pub struct FacetReply {
    pub kinds: Counted,
    pub keywords: Counted,
    pub cameras: Counted,
    pub bodies: Counted,
    pub lenses: Counted,
    pub months: Counted,
    pub iso: Counted,
    pub aperture: Counted,
    pub focal: Counted,
    pub shutter: Counted,
}

impl Tallies {
    fn counted(&self, list: List) -> Vec<(&String, &(u32, f64))> {
        self.0[list as usize].iter().collect()
    }

    fn by_name(&self, list: List) -> Counted {
        let mut all = self.counted(list);
        all.sort_by(|a, b| a.0.cmp(b.0));
        all.into_iter().map(|(k, v)| (k.clone(), v.0)).collect()
    }

    fn by_value(&self, list: List) -> Counted {
        let mut all = self.counted(list);
        all.sort_by(|a, b| a.1 .1.total_cmp(&b.1 .1).then_with(|| a.0.cmp(b.0)));
        all.into_iter().map(|(k, v)| (k.clone(), v.0)).collect()
    }

    // the RAW group (every raw format) first, then each raw extension, then the
    // other extensions, each by name
    fn kinds(&self) -> Counted {
        let is_raw = |ext: &str| sf::kind(&format!("x.{ext}")) == "RAW";
        let exts = self.by_name(List::Kinds);
        let raw: u32 = exts.iter().filter(|(e, _)| is_raw(e)).map(|(_, n)| n).sum();
        let mut out = Vec::with_capacity(exts.len() + 1);
        if raw > 0 {
            out.push(("RAW".to_owned(), raw));
        }
        out.extend(exts.iter().filter(|(e, _)| is_raw(e)).cloned());
        out.extend(exts.into_iter().filter(|(e, _)| !is_raw(e)));
        out
    }

    fn reply(&self, lists: &[List]) -> FacetReply {
        let has = |l: List| lists.contains(&l);
        FacetReply {
            kinds: if has(List::Kinds) { self.kinds() } else { Vec::new() },
            keywords: if has(List::Keywords) { self.by_name(List::Keywords) } else { Vec::new() },
            cameras: if has(List::Cameras) { self.by_name(List::Cameras) } else { Vec::new() },
            bodies: if has(List::Bodies) { self.by_name(List::Bodies) } else { Vec::new() },
            lenses: if has(List::Lenses) { self.by_name(List::Lenses) } else { Vec::new() },
            months: if has(List::Months) {
                let mut m = self.by_name(List::Months);
                m.reverse();
                m
            } else {
                Vec::new()
            },
            iso: if has(List::Iso) { self.by_value(List::Iso) } else { Vec::new() },
            aperture: if has(List::Aperture) { self.by_value(List::Aperture) } else { Vec::new() },
            focal: if has(List::Focal) { self.by_value(List::Focal) } else { Vec::new() },
            shutter: if has(List::Shutter) { self.by_value(List::Shutter) } else { Vec::new() },
        }
    }
}

/// The counts of one photo for one list, as filter.ts's `facets` takes them.
pub(crate) fn tally_image(t: &mut Tallies, list: List, i: &LibraryImage, capture: Option<&str>) {
    let number = |n: &serde_json::Number| n.as_f64().unwrap_or(0.0);
    match list {
        List::Kinds => t.bump(list, &sf::ext_name(&i.filename), 0.0),
        List::Keywords => {
            let mut seen: Vec<String> = Vec::new();
            for keyword in &i.keywords {
                levels(keyword, |level| {
                    if !seen.iter().any(|s| s == level) {
                        seen.push(level.to_owned());
                    }
                });
            }
            for level in seen {
                t.add(list, level, 1, 0.0);
            }
        }
        List::Cameras => t.bump(list, &sf::camera_key(&i.exif.maker, &i.exif.model), 0.0),
        List::Bodies => t.add(
            list,
            sf::body_key(&i.exif.maker, &i.exif.model, &i.exif.body_serial),
            1,
            0.0,
        ),
        List::Lenses => t.bump(list, &i.exif.lens, 0.0),
        List::Months => {
            if let Some(day) = sf::date_of(i, capture) {
                t.add(list, day.format("%Y-%m").to_string(), 1, 0.0);
            }
        }
        List::Iso => t.bump(list, &sf::iso_key(number(&i.exif.iso)), number(&i.exif.iso)),
        List::Aperture => {
            t.bump(list, &sf::aperture_key(number(&i.exif.aperture)), number(&i.exif.aperture));
        }
        List::Focal => {
            t.bump(list, &sf::focal_key(number(&i.exif.focal_length)), number(&i.exif.focal_length));
        }
        List::Shutter => {
            t.bump(list, &sf::shutter_key(number(&i.exif.exposure)), number(&i.exif.exposure));
        }
    }
}

#[derive(Deserialize, specta::Type)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct FindFacetsArgs {
    /// "library" (All folders) or "folder"
    pub scope: String,
    pub folder: Option<String>,
    pub recursive: bool,
    pub filters: GridFilter,
    pub remote: SearchArgs,
    /// the lists to count; none means every list
    pub lists: Vec<String>,
}

impl Default for FindFacetsArgs {
    fn default() -> Self {
        Self {
            scope: "library".into(),
            folder: None,
            recursive: false,
            filters: GridFilter::default(),
            remote: SearchArgs::default(),
            lists: Vec::new(),
        }
    }
}

impl FindFacetsArgs {
    fn search(&self) -> LocalSearchArgs {
        LocalSearchArgs {
            scope: self.scope.clone(),
            folder: self.folder.clone(),
            recursive: self.recursive,
            filters: self.filters.clone(),
            remote: self.remote.clone(),
            ..LocalSearchArgs::default()
        }
    }

    fn lists(&self) -> Result<Vec<List>, String> {
        if self.lists.is_empty() {
            return Ok(ALL.to_vec());
        }
        self.lists
            .iter()
            .map(|n| List::parse(n).ok_or_else(|| "Unknown Find list".to_owned()))
            .collect()
    }
}

fn covered(scopes: &[(PathBuf, bool)], path: &Path) -> bool {
    scopes.iter().any(|(scope, recursive)| {
        if *recursive { path.starts_with(scope) } else { path.parent() == Some(scope.as_path()) }
    })
}

/// Counts for the search's folders; `cancelled` is polled between batches.
pub(crate) fn facets(
    cache: Option<&SearchCache>,
    runtime: &Path,
    overrides: &Overrides,
    args: &FindFacetsArgs,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<FacetReply, String> {
    let search = args.search();
    search.validate()?;
    let lists = args.lists()?;
    let (roots, hidden) = clip_providers::library_roots(runtime);
    let morf = morf_photo::load(runtime);
    let filters = args.filters.canonical();
    let mut tallies = Tallies::new();

    // the mapped catalog, from its local copy once that is complete
    let mut source = None;
    if let Some(mapped) = morf.mapped_root() {
        let scopes: Vec<(PathBuf, bool)> =
            local_search_cmds::provider_scopes(&search, &roots, &hidden, &mapped)
                .into_iter()
                .filter(|(scope, _)| morf.covers(scope))
                .collect();
        if !scopes.is_empty() && mirror_query::Source::ready(runtime, &morf) {
            source = Some(mirror_query::Source {
                runtime: runtime.to_owned(),
                config: morf.clone(),
                scopes,
                overrides: overrides.clone(),
            });
        }
    }
    if let Some(source) = &source {
        source.facets(&filters, &args.remote, &hidden, &lists, &mut tallies, cancelled)?;
    }

    // Immage's own photo cache, for everything the local copy did not count
    let Some(cache) = cache else { return Ok(tallies.reply(&lists)) };
    let skip: &[(PathBuf, bool)] = source.as_ref().map_or(&[], |s| s.scopes.as_slice());
    let variants: Vec<(List, GridFilter, SearchArgs)> = lists
        .iter()
        .map(|&l| {
            let (f, r) = without(l, &filters, &args.remote);
            (l, f, r)
        })
        .collect();
    let mut after = 0;
    loop {
        if cancelled() {
            return Err("Search cancelled".into());
        }
        let batch = cache.candidates(
            after,
            "edited",
            local_search::ANALYSIS_VERSION,
            local_search::MODEL_VERSION,
            false,
        )?;
        if batch.is_empty() {
            return Ok(tallies.reply(&lists));
        }
        for row in batch {
            after = row.variant_id;
            let path = Path::new(&row.path);
            if !local_search::in_scope(path, &search, &roots, &hidden) || covered(skip, path) {
                continue;
            }
            let version = if row.copy_key.is_empty() {
                Some(0)
            } else {
                row.copy_key.strip_prefix("version:").and_then(|s| s.parse::<u32>().ok())
            };
            let Some(version) = version else { continue };
            let Some(image) = row
                .metadata
                .as_deref()
                .and_then(|raw| local_search::cached_image(raw, &row.path, version))
            else {
                continue;
            };
            let capture = row.capture_raw.as_deref();
            for (list, f, r) in &variants {
                if sf::passes(&image, capture, f, r) {
                    tally_image(&mut tallies, *list, &image, capture);
                }
            }
        }
    }
}

/// Every value the library holds for Find's lists, with counts, for the search's
/// folders. The page cancels a request it has outgrown with `local_search_cancel`.
#[tauri::command]
#[specta::specta]
pub async fn find_facets(
    state: State<'_, AppState>,
    args: FindFacetsArgs,
    request_id: u64,
) -> Result<FacetReply, String> {
    let ticket = state.local_search_requests.begin(request_id)?;
    let cache: Option<Arc<SearchCache>> = state.search_cache.clone();
    let runtime = state.runtime.clone();
    let overrides = state.mirror.snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || ticket.cancelled();
        let result = facets(cache.as_deref(), &runtime, &overrides, &args, &cancelled);
        if cancelled() {
            Err("Search cancelled".to_owned())
        } else {
            result
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_levels_count_each_prefix_once() {
        let mut got = Vec::new();
        levels("a|b|c", |l| got.push(l.to_owned()));
        assert_eq!(got, ["a", "a|b", "a|b|c"]);
        let mut got = Vec::new();
        levels("|a", |l| got.push(l.to_owned()));
        assert_eq!(got, ["|a"]);
        let mut got = Vec::new();
        levels("a||b", |l| got.push(l.to_owned()));
        assert_eq!(got, ["a", "a|", "a||b"]);
    }

    #[test]
    fn kinds_list_the_raw_group_then_raw_then_other_extensions() {
        let mut t = Tallies::new();
        for (ext, n) in [("JPG", 4), ("ARW", 2), ("CR2", 1), ("DNG", 3), ("PNG", 1)] {
            t.add(List::Kinds, ext.into(), n, 0.0);
        }
        let kinds: Vec<_> = t.kinds();
        assert_eq!(
            kinds,
            vec![("RAW".into(), 6), ("ARW".into(), 2), ("CR2".into(), 1), ("DNG".into(), 3), ("JPG".into(), 4), ("PNG".into(), 1)]
        );
    }

    // verify/find-facets.test.mjs writes the photos, filters and what filter.ts
    // answers for them; Rust must answer the same
    #[test]
    fn lists_and_matches_equal_filter_ts() {
        let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../verify/fixtures/find-facets.json")).unwrap();
        let fixture: serde_json::Value = serde_json::from_str(&text).unwrap();
        let photos: Vec<LibraryImage> = serde_json::from_value(fixture["photos"].clone()).unwrap();
        let names = [
            ("kinds", List::Kinds), ("keywords", List::Keywords), ("cameras", List::Cameras), ("bodies", List::Bodies),
            ("lenses", List::Lenses), ("months", List::Months), ("iso", List::Iso), ("aperture", List::Aperture),
            ("focal", List::Focal), ("shutter", List::Shutter),
        ];
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 30);
        let mut compared = 0;
        for (n, case) in cases.iter().enumerate() {
            let filter: GridFilter = serde_json::from_value(case["filter"].clone()).unwrap();
            let remote = SearchArgs::default();
            let matches: Vec<usize> = (0..photos.len()).filter(|&i| sf::passes(&photos[i], None, &filter, &remote)).collect();
            let want: Vec<usize> = serde_json::from_value(case["matches"].clone()).unwrap();
            assert_eq!(matches, want, "case {n}: {}", case["filter"]);
            for (name, list) in names {
                let (f, r) = without(list, &filter, &remote);
                let mut t = Tallies::new();
                for p in photos.iter().filter(|p| sf::passes(p, None, &f, &r)) {
                    tally_image(&mut t, list, p, None);
                }
                let got = t.reply(&[list]);
                let got = match list {
                    List::Kinds => got.kinds, List::Keywords => got.keywords, List::Cameras => got.cameras,
                    List::Bodies => got.bodies, List::Lenses => got.lenses, List::Months => got.months,
                    List::Iso => got.iso, List::Aperture => got.aperture, List::Focal => got.focal,
                    List::Shutter => got.shutter,
                };
                let want: Vec<(String, u32)> = serde_json::from_value(case["lists"][name].clone()).unwrap();
                assert_eq!(got, want, "case {n} list {name}: {}", case["filter"]);
                compared += 1;
            }
        }
        eprintln!("{} filters, {compared} lists equal filter.ts", cases.len());
    }
}
