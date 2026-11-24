// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Find's filters as SQL over the local morfPhoto copy, so a search reads only
//! the rows that match and the filter lists count every photo without loading
//! one. `search_filters::passes` stays the reference: every condition here is
//! written to give exactly its answer for the same photo version (the parity
//! tests below run both over the same rows), and a version is one row.
//!
//! Threads and locks. Everything here opens its own read-only connection
//! (`morf_mirror::open_reader`) and holds no lock: no `Mirror.state`, no
//! `Mirror.overrides`, no `SearchCache` lock, nothing shared. The overrides
//! (what Immage changed itself and the server has not indexed yet) are a copy
//! the caller took first (`Mirror::snapshot`) and hands over in `Source`.
//! Callers run it on a blocking thread (never the event loop) and give a
//! `cancelled` check, polled between SQL batches. A page of a search is read in
//! batches of `BATCH` rows, so one statement never runs unbounded on a path the
//! user waits on.
//!
//! Overrides. A photo with a change is left out of the SQL (its path is in a
//! `NOT IN` over `json_each`), read on its own with the changes laid over it,
//! tested with `search_filters::passes`, and merged into the SQL's rows in
//! server path and version order; the facets count it the same way.

use crate::{
    find_facets::{List, Tallies},
    immich_search::SearchArgs,
    mirror_overrides::Overrides,
    morf_mirror as mm,
    morf_photo::{library_image, Config},
    search_filters::{self as sf, GridFilter},
    typed_library::LibraryImage,
};
use rusqlite::{params_from_iter, types::Value, Connection};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
};

const BATCH: usize = 300;
const THREADS: usize = 4;

/// The complete local copy of a mapped catalog and the folders of it a query
/// covers (local folders, each with whether its subfolders are included).
#[derive(Clone)]
pub(crate) struct Source {
    pub(crate) runtime: PathBuf,
    pub(crate) config: Config,
    pub(crate) scopes: Vec<(PathBuf, bool)>,
    /// A copy of what Immage changed itself, taken before the query.
    pub(crate) overrides: Overrides,
}

/// A page's resume point: the last row returned, by server path and version.
pub(crate) type After = (String, u32);

// ---- the WHERE clause ----

pub(crate) struct Where {
    clauses: Vec<String>,
    params: Vec<Value>,
    // a clause reads a version's columns, so versions must be joined
    versions: bool,
}

impl Where {
    fn new() -> Where {
        Where { clauses: Vec::new(), params: Vec::new(), versions: false }
    }
    fn and(&mut self, clause: impl Into<String>, params: impl IntoIterator<Item = Value>) {
        let clause = clause.into();
        self.versions |= clause.contains("v.");
        self.clauses.push(clause);
        self.params.extend(params);
    }
    fn none(&mut self) {
        self.clauses.push("0".into());
    }
    // the photos with an override are read on their own
    fn exclude_paths(&mut self, json: &str) {
        self.and("p.server_path NOT IN (SELECT value FROM json_each(?))", [Value::Text(json.into())]);
    }
    fn one_of(&mut self, column: &str, values: &[String], recorded: bool) {
        if values.is_empty() {
            return;
        }
        let marks = vec!["?"; values.len()].join(",");
        let recorded = if recorded { format!(" AND {column} != ''") } else { String::new() };
        self.and(
            format!("({column} IN ({marks}){recorded})"),
            values.iter().map(|v| Value::Text(v.clone())),
        );
    }
    fn day(&mut self, from: &str, to: &str) {
        if from.is_empty() && to.is_empty() {
            return;
        }
        self.and("v.day IS NOT NULL", []);
        for (bound, op) in [(from, ">="), (to, "<=")] {
            if bound.is_empty() {
                continue;
            }
            match sf::day_text(bound) {
                Some(text) => self.and(format!("v.day {op} ?"), [Value::Text(text)]),
                None => self.none(),
            }
        }
    }
    fn sql(&self) -> String {
        if self.clauses.is_empty() { "1".into() } else { self.clauses.join(" AND ") }
    }
}

// Range predicates for a folder, or a folder and everything below it, as
// `morf_mirror::scope` writes them: "<folder>/" up to "<folder>0".
fn subtree(column: &str, base: &str, recursive: bool) -> (String, Vec<Value>) {
    if recursive && column == "p.server_path" {
        // the files of a folder and below are the paths from "<folder>/" on; the
        // unique index on the path then also gives the order a page needs
        (
            format!("({column} >= ? AND {column} < ?)"),
            vec![Value::Text(format!("{base}/")), Value::Text(format!("{base}0"))],
        )
    } else if recursive {
        (
            format!("({column} = ? OR ({column} >= ? AND {column} < ?))"),
            vec![
                Value::Text(base.into()),
                Value::Text(format!("{base}/")),
                Value::Text(format!("{base}0")),
            ],
        )
    } else {
        (format!("{column} = ?"), vec![Value::Text(base.into())])
    }
}

/// The server folders of local ones, for the scope of a query; a folder that
/// is not under the mapped root is dropped.
fn server_dirs(config: &Config, local: &[(PathBuf, bool)]) -> Vec<(String, bool)> {
    local
        .iter()
        .filter_map(|(path, recursive)| {
            config
                .server_folder(path)
                .ok()
                .map(|base| (base.trim_end_matches('/').to_owned(), *recursive))
        })
        .collect()
}

/// Everything `passes` decides, as a clause over photos `p` and versions `v`;
/// None when no row can match (a server-only filter is set).
pub(crate) fn compile(
    root: &str,
    scopes: &[(String, bool)],
    hidden: &[String],
    f: &GridFilter,
    r: &SearchArgs,
    fold_case: bool,
) -> Option<Where> {
    // These Immich-only filters have no local mapping and match nothing
    if r.favorites
        || !r.person_ids.is_empty()
        || !r.tag_ids.is_empty()
        || !r.album_ids.is_empty()
        || r.country.as_ref().is_some_and(|s| !s.is_empty())
        || r.city.as_ref().is_some_and(|s| !s.is_empty())
        || !matches!(r.library.as_str(), "" | "all" | "external")
    {
        return None;
    }
    let mut w = Where::new();
    if scopes.is_empty() {
        return None;
    }
    // the whole mirror needs no folder test
    if !scopes.iter().any(|(base, recursive)| *recursive && base == root) {
        let mut parts = Vec::new();
        let mut params = Vec::new();
        for (base, recursive) in scopes {
            let (clause, bound) = subtree(if *recursive { "p.server_path" } else { "p.dir" }, base, *recursive);
            parts.push(clause);
            params.extend(bound);
        }
        w.and(format!("({})", parts.join(" OR ")), params);
    }
    // only what the folder listing shows: files with a photo extension
    w.and("p.f_photo = 1", []);
    for base in hidden {
        let (clause, bound) = subtree("p.dir", base, true);
        w.and(format!("NOT {clause}"), bound);
    }
    if fold_case {
        // two server paths that differ only in case are one local file: keep the
        // lowest id, as `morf_mirror::build_images` does
        w.and(
            "NOT EXISTS (SELECT 1 FROM photos q WHERE lower(q.server_path) = lower(p.server_path)
              AND q.id < p.id)",
            [],
        );
    }
    let rating = f.min_rating.max(r.min_rating.unwrap_or(0));
    if rating > 0 {
        w.and("(v.rejected = 0 AND v.rating >= ?)", [Value::Integer(rating.into())]);
    }
    match f.rejected.as_str() {
        "hide" => w.and("v.rejected = 0", []),
        "only" => w.and("v.rejected = 1", []),
        _ => {}
    }
    match f.edited.as_str() {
        "edited" => w.and("v.edited = 1", []),
        "unedited" => w.and("v.edited = 0", []),
        _ => {}
    }
    if f.labels != 0 || f.unlabeled {
        let unlabeled = if f.unlabeled { " OR v.labels = 0" } else { "" };
        w.and(format!("((v.labels & ?) != 0{unlabeled})"), [Value::Integer(f.labels.into())]);
    }
    if r.raw_only {
        w.and("p.f_raw = 1", []);
    }
    if !f.kinds.is_empty() {
        let marks = vec!["?"; f.kinds.len()].join(",");
        w.and(
            format!("(p.f_ext IN ({marks}) OR p.f_kind IN ({marks}))"),
            f.kinds.iter().chain(f.kinds.iter()).map(|k| Value::Text(k.clone())),
        );
    }
    w.one_of("p.f_camera", &f.cameras, true);
    if !f.bodies.is_empty() {
        w.one_of("p.f_body", &f.bodies, false);
    }
    w.one_of("p.lens", &f.lenses, true);
    for (column, value) in [("p.make", &r.make), ("p.model", &r.model), ("p.lens", &r.lens)] {
        if let Some(s) = value.as_ref().filter(|s| !s.trim().is_empty()) {
            w.and(format!("({column} = ? AND {column} != '')"), [Value::Text(s.clone())]);
        }
    }
    for keyword in &f.keywords {
        // the keyword, or one below it ("a" takes "a|b"): the range "a|" .. "a}"
        w.and(
            "EXISTS (SELECT 1 FROM keywords k WHERE k.photo_id = v.photo_id AND k.version = v.version
              AND (k.keyword = ? OR (k.keyword >= ? AND k.keyword < ?)))",
            [
                Value::Text(keyword.clone()),
                Value::Text(format!("{keyword}|")),
                Value::Text(format!("{keyword}}}")),
            ],
        );
    }
    w.day(&f.taken_from, &f.taken_to);
    w.day(r.taken_from.as_deref().unwrap_or(""), r.taken_to.as_deref().unwrap_or(""));
    w.one_of("p.f_iso", &f.iso, true);
    w.one_of("p.f_aperture", &f.aperture, true);
    w.one_of("p.f_focal", &f.focal, true);
    w.one_of("p.f_shutter", &f.shutter, true);
    Some(w)
}

const FROM: &str = "FROM photos p JOIN versions v ON v.photo_id = p.id";

// ---- reading ----

impl Source {
    /// Whether the local copy of this catalog is complete and belongs to the
    /// server the Accelerator is set to now.
    pub(crate) fn ready(runtime: &Path, config: &Config) -> bool {
        let Some(mut conn) = mm::open_reader(runtime) else { return false };
        let Ok(tx) = conn.transaction() else { return false };
        mm::read_identity(&tx, config).is_some_and(|identity| identity.complete)
    }

    fn open(&self) -> Result<Connection, String> {
        let mut conn = mm::open_reader(&self.runtime).ok_or("The local catalog is unavailable")?;
        // identity and rows are read in one transaction; the caller starts it
        let complete = {
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            mm::read_identity(&tx, &self.config).is_some_and(|identity| identity.complete)
        };
        if complete { Ok(conn) } else { Err("The local catalog is not complete".into()) }
    }

    fn hidden_dirs(&self, hidden: &[PathBuf]) -> Vec<String> {
        server_dirs(&self.config, &hidden.iter().map(|h| (h.clone(), true)).collect::<Vec<_>>())
            .into_iter()
            .map(|(dir, _)| dir)
            .collect()
    }

    /// Up to `limit` matching photo versions after `after`, in server path and
    /// version order, that `accept` takes (the caller's scope and name checks).
    /// Rows are read in batches; `cancelled` is checked before each.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn page(
        &self,
        filter: &GridFilter,
        remote: &SearchArgs,
        hidden: &[PathBuf],
        name: Option<&str>,
        after: Option<&After>,
        limit: usize,
        accept: &dyn Fn(&LibraryImage) -> bool,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Vec<(After, LibraryImage)>, String> {
        let mut conn = self.open()?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let scopes = server_dirs(&self.config, &self.scopes);
        let root = self.config.server_root();
        let Some(mut w) = compile(&root, &scopes, &self.hidden_dirs(hidden), filter, remote, mm::FOLD_CASE)
        else {
            return Ok(Vec::new());
        };
        // an ASCII name narrows the rows in SQL (LIKE folds ASCII case); the
        // caller's check stays the authority
        if let Some(needle) = name.filter(|n| n.is_ascii() && !n.is_empty()) {
            let escaped = needle.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            w.and("p.filename LIKE ? ESCAPE '\\'", [Value::Text(format!("%{escaped}%"))]);
        }
        if let Some(json) = self.overrides.json_paths() {
            w.exclude_paths(&json);
        }
        // the changed photos that match, after the resume point, in order
        let mut extra: VecDeque<(After, LibraryImage)> = self
            .override_images(&tx, hidden)?
            .into_iter()
            .filter(|(key, image)| {
                after.is_none_or(|a| key > a) && sf::passes(image, None, filter, remote) && accept(image)
            })
            .collect();
        let mut cursor = after.cloned();
        let mut found: Vec<(After, LibraryImage)> = Vec::new();
        loop {
            if cancelled() {
                return Err("Search cancelled".into());
            }
            let mut sql = format!("SELECT {} {FROM} WHERE {}", mm::ROW_COLUMNS, w.sql());
            let mut params: Vec<Value> = w.params.clone();
            if let Some((path, version)) = &cursor {
                sql.push_str(" AND (p.server_path, v.version) > (?, ?)");
                params.push(Value::Text(path.clone()));
                params.push(Value::Integer((*version).into()));
            }
            sql.push_str(" ORDER BY p.server_path, v.version LIMIT ?");
            params.push(Value::Integer(BATCH as i64));
            let mut statement = tx.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params_from_iter(params.iter()), mm::row_from)
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(statement);
            let Some(last) = rows.last() else { break };
            let next = (last.path.clone(), last.version.version);
            let full = rows.len() == BATCH;
            let mut ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
            ids.dedup();
            let mut keywords = mm::keywords_of(&tx, &ids).map_err(|e| e.to_string())?;
            for mut row in rows {
                let key = (row.path.clone(), row.version.version);
                while extra.front().is_some_and(|(k, _)| *k < key) {
                    found.extend(extra.pop_front());
                    if found.len() == limit {
                        return Ok(found);
                    }
                }
                row.version.keywords = keywords.remove(&(row.id, key.1)).unwrap_or_default();
                let Some(image) = self.image(row) else { continue };
                if accept(&image) {
                    found.push((key, image));
                    if found.len() == limit {
                        return Ok(found);
                    }
                }
            }
            if !full {
                break;
            }
            cursor = Some(next);
        }
        for item in extra {
            found.push(item);
            if found.len() == limit {
                break;
            }
        }
        Ok(found)
    }

    // The photos Immage changed itself, as they are now: their rows read from
    // the copy, the changes laid over them, in server path and version order,
    // limited to the query's folders. A photo moved or copied in has no row of
    // the copy's and comes from the override alone.
    fn override_images(&self, tx: &Connection, hidden: &[PathBuf]) -> Result<Vec<(After, LibraryImage)>, String> {
        let Some(json) = self.overrides.json_paths() else { return Ok(Vec::new()) };
        let err = |e: rusqlite::Error| e.to_string();
        let mut statement = tx
            .prepare(&format!(
                "SELECT {} {FROM} WHERE p.server_path IN (SELECT value FROM json_each(?1))
                 ORDER BY p.server_path, v.version",
                mm::ROW_COLUMNS
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([json], mm::row_from)
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(statement);
        let mut ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
        ids.dedup();
        let mut keywords = mm::keywords_of(tx, &ids).map_err(err)?;
        let rows = mm::merge_rows(rows, &mut keywords, &self.overrides);
        let mut images = Vec::new();
        for row in rows {
            let key = (row.path.clone(), row.version.version);
            let Some(image) = self.image(row) else { continue };
            if self.in_query(Path::new(&image.path), hidden) {
                images.push((key, image));
            }
        }
        Ok(images)
    }

    // whether a local file is in the folders the query covers
    fn in_query(&self, path: &Path, hidden: &[PathBuf]) -> bool {
        !hidden.iter().any(|h| path.starts_with(h))
            && self.scopes.iter().any(|(scope, recursive)| {
                if *recursive { path.starts_with(scope) } else { path.parent() == Some(scope.as_path()) }
            })
    }

    // the row as `Photo::images` maps the server's listing; None when it does
    // not map to a local photo path
    fn image(&self, row: mm::Row) -> Option<LibraryImage> {
        let path = self.config.local_file(&row.path).ok()?;
        if !crate::library_cmds::photo_candidate(&path) {
            return None;
        }
        let filename = path.file_name()?.to_str()?.to_owned();
        library_image(&path, &filename, &row.exif, row.version).ok()
    }

    /// Adds each requested list's counts over the photos in scope into
    /// `tallies`, each list over the photos every filter but its own admits. The
    /// lists are counted on up to `THREADS` threads, each with a read connection
    /// of its own (readers share no lock), polling `cancelled` as they go.
    pub(crate) fn facets(
        &self,
        filter: &GridFilter,
        remote: &SearchArgs,
        hidden: &[PathBuf],
        lists: &[List],
        tallies: &mut Tallies,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<(), String> {
        let scopes = server_dirs(&self.config, &self.scopes);
        let hidden_dirs = self.hidden_dirs(hidden);
        let root = self.config.server_root();
        let exclude = self.overrides.json_paths();
        // keywords are the slow list: give them a thread of their own
        let mut groups: Vec<Vec<List>> = vec![Vec::new(); THREADS.min(lists.len().max(1))];
        let mut ordered: Vec<List> = lists.to_vec();
        ordered.sort_by_key(|l| *l != List::Keywords);
        for (n, list) in ordered.into_iter().enumerate() {
            let at = if n == 0 { 0 } else { 1 + (n - 1) % (groups.len().max(2) - 1).max(1) };
            let at = at.min(groups.len() - 1);
            groups[at].push(list);
        }
        let results: Vec<Result<Tallies, String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = groups
                .iter()
                .filter(|g| !g.is_empty())
                .map(|group| {
                    let (scopes, hidden, root, exclude) = (&scopes, &hidden_dirs, &root, &exclude);
                    scope.spawn(move || -> Result<Tallies, String> {
                        let mut conn = self.open()?;
                        let tx = conn.transaction().map_err(|e| e.to_string())?;
                        let mut mine = Tallies::new();
                        for &list in group {
                            if cancelled() {
                                return Err("Search cancelled".into());
                            }
                            let (f, r) = crate::find_facets::without(list, filter, remote);
                            let Some(mut w) = compile(root, scopes, hidden, &f, &r, mm::FOLD_CASE) else { continue };
                            if let Some(json) = exclude {
                                w.exclude_paths(json);
                            }
                            tally(&tx, list, &w, &mut mine, cancelled)?;
                        }
                        Ok(mine)
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("Counting failed".into()))).collect()
        });
        for result in results {
            tallies.merge(result?);
        }
        // the photos Immage changed itself, counted one at a time as `passes` sees them
        if exclude.is_some() {
            let mut conn = self.open()?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let images = self.override_images(&tx, hidden)?;
            for &list in lists {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let (f, r) = crate::find_facets::without(list, filter, remote);
                if compile(&root, &scopes, &hidden_dirs, &f, &r, mm::FOLD_CASE).is_none() {
                    continue;
                }
                for (_, image) in &images {
                    if sf::passes(image, None, &f, &r) {
                        crate::find_facets::tally_image(tallies, list, image, None);
                    }
                }
            }
        }
        Ok(())
    }
}

// the column a scalar list counts, with the number its values sort by
fn column(list: List) -> Option<(&'static str, &'static str)> {
    Some(match list {
        List::Kinds => ("p.f_ext", "0"),
        List::Cameras => ("p.f_camera", "0"),
        List::Bodies => ("p.f_body", "0"),
        List::Lenses => ("p.lens", "0"),
        List::Iso => ("p.f_iso", "MIN(p.iso)"),
        List::Aperture => ("p.f_aperture", "MIN(p.aperture)"),
        List::Focal => ("p.f_focal", "MIN(p.focal)"),
        List::Shutter => ("p.f_shutter", "MIN(p.shutter_s)"),
        List::Months => ("substr(v.day, 1, 7)", "0"),
        List::Keywords => return None,
    })
}

fn tally(
    tx: &Connection,
    list: List,
    w: &Where,
    tallies: &mut Tallies,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    let Some((column, number)) = column(list) else {
        return keywords(tx, w, tallies, cancelled);
    };
    // an unrecorded value is not a choice, except a body without a serial, which
    // filter.ts lists as "Serial not recorded"
    let recorded = match list {
        List::Bodies => String::new(),
        List::Months => " AND v.day IS NOT NULL".into(),
        _ => format!(" AND {column} != ''"),
    };
    // counts are of versions: from the photos alone (each knows how many it has)
    // when no clause reads a version
    let (count, from) = if w.versions || list == List::Months {
        ("COUNT(*)", FROM)
    } else {
        ("SUM(p.nver)", "FROM photos p")
    };
    let sql = format!(
        "SELECT {column}, {count}, {number} {from} WHERE {}{recorded} GROUP BY {column}",
        w.sql()
    );
    let mut statement = tx.prepare(&sql).map_err(err)?;
    let mut rows = statement.query(params_from_iter(w.params.iter())).map_err(err)?;
    while let Some(row) = rows.next().map_err(err)? {
        tallies.add(
            list,
            row.get::<_, String>(0).map_err(err)?,
            row.get::<_, u32>(1).map_err(err)?,
            row.get::<_, f64>(2).map_err(err)?,
        );
    }
    Ok(())
}

// Each keyword and every level above it, once per photo version.
fn keywords(
    tx: &Connection,
    w: &Where,
    tallies: &mut Tallies,
    cancelled: &(dyn Fn() -> bool + Sync),
) -> Result<(), String> {
    let err = |e: rusqlite::Error| e.to_string();
    let sql = format!(
        "SELECT k.photo_id, k.version, k.keyword FROM keywords k
         JOIN versions v ON v.photo_id = k.photo_id AND v.version = k.version
         JOIN photos p ON p.id = k.photo_id WHERE {} ORDER BY k.photo_id, k.version",
        w.sql()
    );
    let mut statement = tx.prepare(&sql).map_err(err)?;
    let mut rows = statement.query(params_from_iter(w.params.iter())).map_err(err)?;
    let mut current = (0i64, u32::MAX);
    let mut levels: Vec<String> = Vec::new();
    let mut seen = 0usize;
    while let Some(row) = rows.next().map_err(err)? {
        seen += 1;
        if seen.is_multiple_of(20_000) && cancelled() {
            return Err("Search cancelled".into());
        }
        let key = (row.get::<_, i64>(0).map_err(err)?, row.get::<_, u32>(1).map_err(err)?);
        if key != current {
            for level in levels.drain(..) {
                tallies.add(List::Keywords, level, 1, 0.0);
            }
            current = key;
        }
        let keyword = row.get_ref(2).map_err(err)?.as_str().map_err(|e| e.to_string())?;
        crate::find_facets::levels(keyword, |level| {
            if !levels.iter().any(|l| l == level) {
                levels.push(level.to_owned());
            }
        });
    }
    for level in levels.drain(..) {
        tallies.add(List::Keywords, level, 1, 0.0);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::find_facets::{tally_image, without, Tallies};
    use serde_json::{json, Value as Json};

    pub(crate) struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
        fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
            &items[self.below(items.len())]
        }
        fn chance(&mut self, percent: u64) -> bool {
            self.next() % 100 < percent
        }
    }

    const CAMERAS: &[(&str, &str)] = &[
        ("NIKON CORPORATION", "NIKON Z 6"),
        ("Canon", "Canon EOS R5"),
        ("SONY", "ILCE-7M3"),
        ("FUJIFILM", "X-T4"),
        ("OLYMPUS IMAGING CORP.", "E-3"),
        ("OM Digital Solutions", "OM-1MarkII"),
        ("RICOH IMAGING COMPANY, LTD.", "PENTAX K-3 Mark III"),
        ("Leica Camera AG", "LEICA M11"),
        ("Panasonic", "DC-GH5"),
        ("Acme", " X1 "),
        ("", ""),
        ("", "Bare model"),
    ];
    const LENSES: &[&str] = &[
        "RF24-105mm F4 L IS USM",
        "NIKKOR Z 24-70mm f/4 S",
        "FE 24-70mm F2.8 GM",
        "",
        "Canon RF 50mm F1.8 STM",
        "TAMRON 28-75mm F/2.8",
        "Sigma 35mm F1.4",
    ];
    const SERIALS: &[&str] = &["", "", "123", " 456 ", "123", "A-9"];
    const ISO: &[f64] = &[0.0, 100.0, 100.4, 100.5, 400.0, 1600.0, 6400.0, 3199.5, 12800.0];
    const APERTURE: &[f64] = &[0.0, 1.8, 2.25, 2.55, 2.8, 4.0, 5.6, 8.0, 11.04, 22.0];
    const FOCAL: &[f64] = &[0.0, 24.0, 24.5, 35.0, 35.4, 50.0, 85.0, 200.0, 0.4];
    const SHUTTER: &[f64] = &[
        0.0, 0.000125, 0.004, 0.0039, 0.0125, 0.29, 0.2999, 0.3, 0.301, 0.5, 1.0, 2.5, 2.55, 30.0,
    ];
    const NAMES: &[&str] = &[
        "a.ARW", "b.arw", "c.jpg", "d.JPEG", "e.tif", "f.png", "g.nef", "h.cr3", "i.dng", "j.heic",
        "k.ori", "l.bmp", "m.jpe", "n.txt", "o.TIFF", "p.raf",
    ];
    const DIRS: &[&str] = &["/photos", "/photos/2024/a", "/photos/2024/b", "/photos/2025", "/photos/2024"];
    const TAKEN: &[Option<&str>] = &[
        None,
        Some("2024-05-06T10:11:12"),
        Some("2024-05-06"),
        Some("2023-12-31T23:59:59"),
        Some("2024-02-30T10:00:00"),
        Some("2024-05"),
        Some("20240506T101112"),
        Some("2025-01-01T00:00:00+02:00"),
        Some("2024-06-15T08:00:00"),
        Some("2022-11-01T08:00:00"),
    ];
    const KEYWORDS: &[&str] = &[
        "a", "a|b", "a|b|c", "ab", "a b", "á", "x|y", "a}b", "a|}", "Places|France|Paris",
        "Places|France", "Places", "People|Ann", "b|a", "|lead",
    ];

    pub(crate) fn config() -> Config {
        Config {
            enabled: true,
            url: "http://nas.example:8080".into(),
            server_path: "/photos".into(),
            local_path: "/mnt/photos".into(),
        }
    }

    // `count` photos with a handful of versions each, spread over every value
    // the filters read, and the ties and boundaries the rounding rules turn on
    pub(crate) fn photos(count: usize, seed: u64) -> Vec<Json> {
        let mut rng = Rng(seed);
        (0..count)
            .map(|n| {
                let (make, model) = *rng.pick(CAMERAS);
                let dir = *rng.pick(DIRS);
                let name = if n < NAMES.len() { NAMES[n] } else { rng.pick(NAMES) };
                let versions: Vec<Json> = (0..1 + rng.below(3))
                    .map(|v| {
                        let rating = rng.below(6);
                        let keywords: Vec<&str> =
                            (0..rng.below(4)).map(|_| *rng.pick(KEYWORDS)).collect();
                        json!({
                            "version": v, "copy": v > 0, "rating": rating,
                            "rejected": rng.chance(20), "labels": rng.below(32),
                            "edited": match rng.below(3) { 0 => Json::Null, 1 => json!(true), _ => json!(false) },
                            "taken_at": rng.pick(TAKEN), "latitude": null, "longitude": null,
                            "keywords": keywords,
                        })
                    })
                    .collect();
                json!({
                    "id": n as i64 + 1, "seq": 1, "state": "present",
                    "path": format!("{dir}/{n}-{name}"),
                    "make": make, "camera_model": model, "lens": rng.pick(LENSES),
                    "body_serial": rng.pick(SERIALS),
                    "iso": rng.pick(ISO), "aperture": rng.pick(APERTURE),
                    "focal_length": rng.pick(FOCAL), "shutter_speed_s": rng.pick(SHUTTER),
                    "versions": versions,
                })
            })
            .collect()
    }

    pub(crate) struct Fixture {
        pub dir: tempfile::TempDir,
        pub source: Source,
        pub all: Vec<LibraryImage>,
    }

    pub(crate) fn fixture(items: Vec<Json>) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        crate::morf_mirror::test_fill(dir.path(), &config(), items);
        let listing =
            crate::morf_mirror::folder(dir.path(), &config(), Path::new("/mnt/photos"), true, &Overrides::default())
                .unwrap();
        let source = Source {
            runtime: dir.path().to_owned(),
            config: config(),
            scopes: vec![(PathBuf::from("/mnt/photos"), true)],
            overrides: Overrides::default(),
        };
        Fixture { dir, source, all: listing.images }
    }

    // the mirror alone, for sizes where loading every image would be the test
    pub(crate) fn fixture_without_reference(items: Vec<Json>) -> (Source, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        crate::morf_mirror::test_fill(dir.path(), &config(), items);
        let source = Source {
            runtime: dir.path().to_owned(),
            config: config(),
            scopes: vec![(PathBuf::from("/mnt/photos"), true)],
            overrides: Overrides::default(),
        };
        (source, dir)
    }

    fn key(i: &LibraryImage) -> (String, u32) {
        (i.path.clone(), i.version)
    }

    fn sql_keys(f: &Fixture, filter: &GridFilter, remote: &SearchArgs) -> Vec<(String, u32)> {
        f.source
            .page(&filter.canonical(), remote, &[], None, None, usize::MAX, &|_| true, &|| false)
            .unwrap()
            .into_iter()
            .map(|(_, i)| key(&i))
            .collect()
    }

    fn reference_keys(f: &Fixture, filter: &GridFilter, remote: &SearchArgs) -> Vec<(String, u32)> {
        let filter = filter.canonical();
        f.all
            .iter()
            .filter(|i| sf::passes(i, None, &filter, remote))
            .map(key)
            .collect()
    }

    fn some(rng: &mut Rng, percent: u64) -> bool {
        rng.chance(percent)
    }

    fn vectors(f: &Fixture) -> Vec<(GridFilter, SearchArgs)> {
        let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
        let mut out: Vec<(GridFilter, SearchArgs)> = vec![(GridFilter::default(), SearchArgs::default())];
        let mut add = |f: GridFilter, r: SearchArgs| out.push((f, r));
        // one condition at a time, with the edge values of each
        for n in 1..=5 {
            add(GridFilter { min_rating: n, ..Default::default() }, SearchArgs::default());
        }
        for v in ["all", "hide", "only"] {
            add(GridFilter { rejected: v.into(), ..Default::default() }, SearchArgs::default());
            add(GridFilter { rejected: v.into(), min_rating: 3, ..Default::default() }, SearchArgs::default());
        }
        for v in ["all", "edited", "unedited"] {
            add(GridFilter { edited: v.into(), ..Default::default() }, SearchArgs::default());
        }
        for (labels, unlabeled) in [(1, false), (3, false), (0, true), (5, true), (31, false), (16, true)] {
            add(GridFilter { labels, unlabeled, ..Default::default() }, SearchArgs::default());
        }
        for kinds in [vec!["RAW"], vec!["ARW"], vec!["JPG"], vec!["JPEG"], vec!["TIFF"], vec!["TIF"],
                      vec!["PNG", "HEIC"], vec!["ORI"], vec!["BMP", "RAW"], vec!["NOPE"]] {
            add(GridFilter { kinds: kinds.iter().map(|s| s.to_string()).collect(), ..Default::default() }, SearchArgs::default());
        }
        for cameras in [vec!["NIKON CORPORATION NIKON Z 6"], vec!["Nikon Z 6"], vec!["Canon EOS R5", "Sony ILCE-7M3"],
                        vec!["SONY ILCE-7M3"], vec!["Acme X1"], vec!["Bare model"], vec![""], vec!["OM System OM-1 Mark II"],
                        vec!["OM Digital Solutions OM-1MarkII"], vec!["Nobody"]] {
            add(GridFilter { cameras: cameras.iter().map(|s| s.to_string()).collect(), ..Default::default() }, SearchArgs::default());
        }
        let bodies = [r#"["Nikon","Z 6","123"]"#, r#"["NIKON CORPORATION","NIKON Z 6","123"]"#,
                      r#"["Acme","X1","456"]"#, "", r#"["Canon","EOS R5","A-9"]"#];
        for body in bodies {
            add(GridFilter { bodies: vec![body.into()], ..Default::default() }, SearchArgs::default());
        }
        for lenses in [vec!["RF24-105mm F4 L IS USM"], vec!["Canon RF 24-105mm F4 L IS USM"], vec!["Nikkor Z 24-70mm f/4 S"],
                       vec!["NIKKOR Z 24-70mm f/4 S"], vec!["Canon RF 50mm F1.8 STM", "Tamron 28-75mm F/2.8"], vec![""], vec!["Sigma 35mm F1.4"]] {
            add(GridFilter { lenses: lenses.iter().map(|s| s.to_string()).collect(), ..Default::default() }, SearchArgs::default());
        }
        for keywords in [vec!["a"], vec!["a|b"], vec!["a|b|c"], vec!["ab"], vec!["a", "a b"], vec!["Places"], vec!["Places|France"],
                         vec!["Places", "People"], vec!["á"], vec!["x"], vec!["a}b"], vec!["|lead"], vec!["a|"], vec!["b", "a"]] {
            add(GridFilter { keywords: keywords.iter().map(|s| s.to_string()).collect(), ..Default::default() }, SearchArgs::default());
        }
        for (from, to) in [("2024-05-06", ""), ("", "2024-05-06"), ("2024-05-06", "2024-05-06"), ("2023-12-31", "2024-01-01"),
                           ("2024-02-30", ""), ("2025-01-01", "2025-12-31"), ("2000-01-01", "2030-01-01"), ("", "2021-01-01")] {
            add(GridFilter { taken_from: from.into(), taken_to: to.into(), ..Default::default() }, SearchArgs::default());
            add(GridFilter::default(), SearchArgs { taken_from: Some(from.into()).filter(|s: &String| !s.is_empty()),
                taken_to: Some(to.into()).filter(|s: &String| !s.is_empty()), ..Default::default() });
        }
        for (iso, ap, fo, sh) in [("100", "f/2.3", "24 mm", "1/250"), ("101", "f/2.5", "35 mm", "0.3s"), ("3200", "f/2.8", "0 mm", "1/3"),
                                  ("6400", "f/11", "50 mm", "2.5s"), ("12800", "f/22", "200 mm", "30s"), ("1600", "f/1.8", "24 mm", "1/80"),
                                  ("400", "f/5.6", "85 mm", "1/8000"), ("nope", "f/9", "1 mm", "1/1")] {
            add(GridFilter { iso: vec![iso.into()], ..Default::default() }, SearchArgs::default());
            add(GridFilter { aperture: vec![ap.into()], ..Default::default() }, SearchArgs::default());
            add(GridFilter { focal: vec![fo.into()], ..Default::default() }, SearchArgs::default());
            add(GridFilter { shutter: vec![sh.into()], ..Default::default() }, SearchArgs::default());
        }
        add(GridFilter::default(), SearchArgs { raw_only: true, ..Default::default() });
        add(GridFilter::default(), SearchArgs { min_rating: Some(4), ..Default::default() });
        add(GridFilter { min_rating: 2, ..Default::default() }, SearchArgs { min_rating: Some(4), ..Default::default() });
        add(GridFilter::default(), SearchArgs { make: Some("Nikon".into()), ..Default::default() });
        add(GridFilter::default(), SearchArgs { model: Some("Z 6".into()), ..Default::default() });
        add(GridFilter::default(), SearchArgs { lens: Some("FE 24-70mm F2.8 GM".into()), ..Default::default() });
        add(GridFilter::default(), SearchArgs { make: Some("  ".into()), ..Default::default() });
        add(GridFilter::default(), SearchArgs { favorites: true, ..Default::default() });
        add(GridFilter::default(), SearchArgs { person_ids: vec!["p".into()], ..Default::default() });
        add(GridFilter::default(), SearchArgs { city: Some("Paris".into()), ..Default::default() });
        add(GridFilter::default(), SearchArgs { library: "other".into(), ..Default::default() });
        add(GridFilter::default(), SearchArgs { library: "external".into(), ..Default::default() });
        // random combinations of the values the photos hold
        let images = &f.all;
        for _ in 0..400 {
            let mut g = GridFilter::default();
            let mut r = SearchArgs::default();
            let any = &images[rng.below(images.len())];
            if some(&mut rng, 25) { g.min_rating = rng.below(6) as u8; }
            if some(&mut rng, 20) { g.rejected = rng.pick(&["all", "hide", "only"]).to_string(); }
            if some(&mut rng, 20) { g.edited = rng.pick(&["all", "edited", "unedited"]).to_string(); }
            if some(&mut rng, 20) { g.labels = rng.below(32) as u32; g.unlabeled = rng.chance(50); }
            if some(&mut rng, 25) { g.kinds = vec![sf::ext_name(&any.filename)]; }
            if some(&mut rng, 20) { g.kinds = vec![sf::kind(&any.filename).to_owned()]; }
            if some(&mut rng, 25) { g.cameras = vec![sf::camera_key(&any.exif.maker, &any.exif.model)]; }
            if some(&mut rng, 15) { g.bodies = vec![sf::body_key(&any.exif.maker, &any.exif.model, &any.exif.body_serial)]; }
            if some(&mut rng, 20) { g.lenses = vec![any.exif.lens.clone()]; }
            if some(&mut rng, 25) { for _ in 0..1 + rng.below(2) { g.keywords.push(rng.pick(KEYWORDS).to_string()); } }
            if some(&mut rng, 20) { let d = sf::capture_day(any.exif.capture_time_raw.as_str()).unwrap_or_else(|| "2024-05-06".into()); g.taken_from = d; }
            if some(&mut rng, 15) { g.taken_to = "2024-12-31".into(); }
            let n = |v: &serde_json::Number| v.as_f64().unwrap_or(0.0);
            if some(&mut rng, 15) { g.iso = vec![sf::iso_key(n(&any.exif.iso))]; }
            if some(&mut rng, 15) { g.aperture = vec![sf::aperture_key(n(&any.exif.aperture))]; }
            if some(&mut rng, 15) { g.focal = vec![sf::focal_key(n(&any.exif.focal_length))]; }
            if some(&mut rng, 15) { g.shutter = vec![sf::shutter_key(n(&any.exif.exposure)), "1/250".into()]; }
            if some(&mut rng, 10) { r.raw_only = true; }
            if some(&mut rng, 10) { r.min_rating = Some(rng.below(6) as u8); }
            if some(&mut rng, 5) { r.taken_to = Some("2024-06-01".into()); }
            out.push((g, r));
        }
        out
    }

    #[test]
    fn sql_answers_exactly_as_passes_for_every_filter() {
        let f = fixture(photos(300, 0x5eed));
        assert!(f.all.len() > 450, "{} versions", f.all.len());
        let cases = vectors(&f);
        let mut matched = 0;
        for (n, (filter, remote)) in cases.iter().enumerate() {
            let (sql, reference) = (sql_keys(&f, filter, remote), reference_keys(&f, filter, remote));
            assert_eq!(sql, reference, "vector {n}: {}", serde_json::to_string(filter).unwrap());
            matched += usize::from(!reference.is_empty());
        }
        // most vectors select something and some select everything or nothing
        assert!(cases.len() >= 500, "{} vectors", cases.len());
        assert!(matched > cases.len() / 2, "{matched} of {} select something", cases.len());
        eprintln!("{} filter vectors over {} photo versions", cases.len(), f.all.len());
    }

    #[test]
    fn pages_resume_where_the_last_one_stopped() {
        let f = fixture(photos(120, 7));
        let filter = GridFilter { min_rating: 1, ..Default::default() };
        let remote = SearchArgs::default();
        let whole = sql_keys(&f, &filter, &remote);
        assert!(whole.len() > 40);
        let mut joined = Vec::new();
        let mut after = None;
        loop {
            let page = f
                .source
                .page(&filter, &remote, &[], None, after.as_ref(), 17, &|_| true, &|| false)
                .unwrap();
            let Some(last) = page.last().map(|(k, _)| k.clone()) else { break };
            joined.extend(page.iter().map(|(_, i)| key(i)));
            after = Some(last);
        }
        assert_eq!(joined, whole);
        // what the caller declines is skipped, and the page still fills
        let even = f
            .source
            .page(&filter, &remote, &[], None, None, 10, &|i| i.version == 0, &|| false)
            .unwrap();
        assert_eq!(even.len(), 10);
        assert!(even.iter().all(|(_, i)| i.version == 0));
        // a name narrows the rows without changing which a name check takes
        let named = f
            .source
            .page(&filter, &remote, &[], Some("nef"), None, 1000, &|i| i.filename.to_lowercase().contains("nef"), &|| false)
            .unwrap();
        assert!(!named.is_empty());
        // cancellation stops a search between batches
        assert!(f.source.page(&filter, &remote, &[], None, None, 10, &|_| true, &|| true).is_err());
    }

    #[test]
    fn folders_hidden_folders_and_case_folding() {
        let mut items = photos(40, 11);
        items.push(json!({"id": 900, "seq": 1, "state": "present", "path": "/photos/Dup/X.ARW",
            "versions": [{"version": 0, "copy": false, "rating": 0, "rejected": false, "labels": 0,
            "edited": null, "taken_at": null, "latitude": null, "longitude": null, "keywords": []}]}));
        items.push(json!({"id": 901, "seq": 1, "state": "present", "path": "/photos/Dup/x.arw",
            "versions": [{"version": 0, "copy": false, "rating": 0, "rejected": false, "labels": 0,
            "edited": null, "taken_at": null, "latitude": null, "longitude": null, "keywords": []}]}));
        let f = fixture(items);
        let one = |scopes: Vec<(&str, bool)>, hidden: &[&str], fold: bool| -> Vec<String> {
            let scopes: Vec<(String, bool)> = scopes.into_iter().map(|(s, r)| (s.to_owned(), r)).collect();
            let hidden: Vec<String> = hidden.iter().map(|s| s.to_string()).collect();
            let w = compile("/photos", &scopes, &hidden, &GridFilter::default(), &SearchArgs::default(), fold).unwrap();
            let conn = mm::open_reader(f.dir.path()).unwrap();
            let sql = format!("SELECT DISTINCT p.server_path {FROM} WHERE {} ORDER BY 1", w.sql());
            let mut st = conn.prepare(&sql).unwrap();
            st.query_map(params_from_iter(w.params.iter()), |r| r.get::<_, String>(0)).unwrap().map(|r| r.unwrap()).collect()
        };
        let direct = one(vec![("/photos/2024", false)], &[], false);
        assert!(direct.iter().all(|p| p.rsplit_once('/').unwrap().0 == "/photos/2024"), "{direct:?}");
        let tree = one(vec![("/photos/2024", true)], &[], false);
        assert!(tree.iter().any(|p| p.starts_with("/photos/2024/a/")) && tree.len() > direct.len());
        let hidden = one(vec![("/photos", true)], &["/photos/2024"], false);
        assert!(!hidden.iter().any(|p| p.starts_with("/photos/2024/")), "{hidden:?}");
        assert!(hidden.iter().any(|p| p.starts_with("/photos/2025/")));
        let both = one(vec![("/photos/2025", true), ("/photos/2024/a", false)], &[], false);
        assert!(both.iter().all(|p| p.starts_with("/photos/2025/") || p.starts_with("/photos/2024/a/")));
        assert!(compile("/photos", &[], &[], &GridFilter::default(), &SearchArgs::default(), false).is_none());
        // case folding keeps the lowest id of two paths that differ in case
        let unfolded = one(vec![("/photos/Dup", false)], &[], false);
        assert_eq!(unfolded.len(), 2);
        assert_eq!(one(vec![("/photos/Dup", false)], &[], true), vec!["/photos/Dup/X.ARW"]);
    }

    // the same counts a list gets from `passes`, one photo at a time
    fn counted_by_passes(f: &Fixture, filter: &GridFilter, remote: &SearchArgs, lists: &[crate::find_facets::List]) -> Tallies {
        let filter = filter.canonical();
        let mut t = Tallies::new();
        for &list in lists {
            let (g, r) = without(list, &filter, remote);
            for image in &f.all {
                if sf::passes(image, None, &g, &r) {
                    tally_image(&mut t, list, image, None);
                }
            }
        }
        t
    }

    #[test]
    fn facet_counts_match_passes_with_narrowing() {
        use crate::find_facets::List::*;
        let f = fixture(photos(300, 0xfacade));
        let lists = [Kinds, Keywords, Cameras, Bodies, Lenses, Months, Iso, Aperture, Focal, Shutter];
        let cases = vectors(&f);
        let mut checked = 0;
        for (n, (filter, remote)) in cases.iter().enumerate().step_by(7) {
            let mut sql = Tallies::new();
            f.source.facets(&filter.canonical(), remote, &[], &lists, &mut sql, &|| false).unwrap();
            let reference = counted_by_passes(&f, filter, remote, &lists);
            for list in lists {
                assert_eq!(sql.snapshot(list), reference.snapshot(list), "vector {n} list {list:?}");
            }
            checked += 1;
        }
        assert!(checked > 70);
    }

    // ---- overrides ----

    use crate::mirror_overrides::{FieldOverride, PhotoRow};
    use crate::morf_photo::VersionFields;
    use std::collections::BTreeMap;
    use std::time::Instant;

    enum Op {
        Fields(String, u32, FieldOverride),
        Gone(String),
        Removed(String, u32),
        Added(String, PhotoRow),
    }

    fn patch(rng: &mut Rng) -> FieldOverride {
        let mut p = FieldOverride::default();
        if rng.chance(60) { p.rating = Some(rng.below(6) as u8); }
        if rng.chance(30) { p.rejected = Some(rng.chance(50)); }
        if rng.chance(30) { p.labels = Some(rng.below(32) as u32); }
        if rng.chance(40) {
            p.keywords = Some((0..rng.below(4)).map(|_| rng.pick(KEYWORDS).to_string()).collect());
        }
        if rng.chance(30) { p.edited = Some(rng.chance(50)); }
        if rng.chance(30) { p.taken_at = rng.pick(TAKEN).map(str::to_owned); }
        p
    }

    // The mirror's photos as a model: server path -> rows, read straight from the
    // copy before any override.
    fn model(f: &Fixture) -> BTreeMap<String, PhotoRow> {
        let conn = mm::open_reader(f.dir.path()).unwrap();
        let mut paths: Vec<String> = f
            .all
            .iter()
            .map(|i| config().server_folder(Path::new(&i.path)).unwrap())
            .collect();
        paths.dedup();
        paths.into_iter().map(|p| { let row = mm::read_photo(&conn, &p).unwrap().unwrap(); (p, row) }).collect()
    }

    fn random_ops(model: &BTreeMap<String, PhotoRow>, seed: u64, share: u64) -> Vec<Op> {
        let mut rng = Rng(seed);
        let paths: Vec<&String> = model.keys().collect();
        let mut ops = Vec::new();
        for (n, path) in paths.iter().enumerate() {
            if !rng.chance(share) {
                continue;
            }
            let photo = &model[*path];
            match rng.below(6) {
                0 => ops.push(Op::Gone((*path).clone())),
                1 if photo.versions.len() > 1 => {
                    ops.push(Op::Removed((*path).clone(), photo.versions[1].version));
                }
                2 => {
                    // moved or copied in, as another photo's row, under a new path
                    let source = &model[*rng.pick(&paths)];
                    let dir = rng.pick(DIRS);
                    ops.push(Op::Added(format!("{dir}/moved{n}-{}", rng.pick(NAMES)), source.clone()));
                }
                _ => {
                    for _ in 0..1 + rng.below(2) {
                        let v = rng.pick(&photo.versions).version;
                        ops.push(Op::Fields((*path).clone(), v, patch(&mut rng)));
                    }
                }
            }
        }
        ops
    }

    fn overrides_of(ops: &[Op]) -> Overrides {
        let mut o = Overrides::default();
        let now = Instant::now();
        for op in ops {
            match op {
                Op::Fields(p, v, patch) => o.note_fields(p, *v, patch.clone(), now),
                Op::Gone(p) => o.note_gone(p, now),
                Op::Removed(p, v) => o.note_version_removed(p, *v, now),
                Op::Added(p, row) => o.note_added(p, row.clone(), now),
            }
        }
        o
    }

    // The same changes laid over the model by hand, field by field, without
    // `Overrides`, and the model as library images in server path order.
    fn reference_images(model: &BTreeMap<String, PhotoRow>, ops: &[Op]) -> Vec<LibraryImage> {
        let mut model = model.clone();
        for op in ops {
            match op {
                Op::Fields(p, v, patch) => {
                    let Some(version) = model.get_mut(p).and_then(|r| r.versions.iter_mut().find(|x| x.version == *v)) else { continue };
                    if let Some(r) = patch.rating { version.rating = r; }
                    if let Some(r) = patch.rejected { version.rejected = r; }
                    if let Some(l) = patch.labels { version.labels = l; }
                    if let Some(k) = &patch.keywords { version.keywords = k.clone(); }
                    if let Some(e) = patch.edited { version.edited = Some(e); }
                    if let Some(t) = &patch.taken_at { version.taken_at = Some(t.clone()); }
                }
                Op::Gone(p) => { model.remove(p); }
                Op::Removed(p, v) => {
                    if let Some(r) = model.get_mut(p) {
                        r.versions.retain(|x| x.version != *v);
                        if r.versions.is_empty() { model.remove(p); }
                    }
                }
                Op::Added(p, row) => { model.insert(p.clone(), row.clone()); }
            }
        }
        let mut images = Vec::new();
        for (path, row) in &model {
            let Ok(local) = config().local_file(path) else { continue };
            if !crate::library_cmds::photo_candidate(&local) { continue; }
            let name = local.file_name().unwrap().to_str().unwrap().to_owned();
            for version in &row.versions {
                let version: VersionFields = version.clone();
                images.push(library_image(&local, &name, &row.exif, version).unwrap());
            }
        }
        images
    }

    fn sql_keys_with(source: &Source, filter: &GridFilter, remote: &SearchArgs) -> Vec<(String, u32)> {
        source
            .page(&filter.canonical(), remote, &[], None, None, usize::MAX, &|_| true, &|| false)
            .unwrap()
            .into_iter()
            .map(|(_, i)| key(&i))
            .collect()
    }

    fn reference_keys_of(images: &[LibraryImage], filter: &GridFilter, remote: &SearchArgs) -> Vec<(String, u32)> {
        let filter = filter.canonical();
        images.iter().filter(|i| sf::passes(i, None, &filter, remote)).map(key).collect()
    }

    #[test]
    fn sql_with_overrides_answers_as_passes_over_the_changed_rows() {
        let mut f = fixture(photos(300, 0xbeef));
        let model = model(&f);
        let cases = vectors(&f);
        let mut changed_answers = 0;
        for (round, share) in [(1u64, 10u64), (2, 35), (3, 90)] {
            let ops = random_ops(&model, 0x1234 + round, share);
            assert!(!ops.is_empty());
            f.source.overrides = overrides_of(&ops);
            let reference = reference_images(&model, &ops);
            for (n, (filter, remote)) in cases.iter().enumerate() {
                let (sql, expect) = (sql_keys_with(&f.source, filter, remote), reference_keys_of(&reference, filter, remote));
                assert_eq!(sql, expect, "round {round} vector {n}: {}", serde_json::to_string(filter).unwrap());
                changed_answers += usize::from(sql != reference_keys(&f, filter, remote));
            }
        }
        // the overrides did change what the filters find
        assert!(changed_answers > 200, "{changed_answers}");
    }

    #[test]
    fn pages_with_overrides_resume_in_order_and_decline_what_the_caller_declines() {
        let mut f = fixture(photos(200, 0xaced));
        let model = model(&f);
        let ops = random_ops(&model, 77, 40);
        f.source.overrides = overrides_of(&ops);
        let reference = reference_images(&model, &ops);
        let remote = SearchArgs::default();
        for filter in [GridFilter::default(), GridFilter { min_rating: 2, ..Default::default() }, GridFilter { edited: "edited".into(), ..Default::default() }] {
            let whole = reference_keys_of(&reference, &filter, &remote);
            assert!(whole.len() > 50);
            for size in [1usize, 7, 17, 301] {
                let mut joined = Vec::new();
                let mut after = None;
                loop {
                    let page = f.source.page(&filter, &remote, &[], None, after.as_ref(), size, &|_| true, &|| false).unwrap();
                    let Some(last) = page.last().map(|(k, _)| k.clone()) else { break };
                    joined.extend(page.iter().map(|(_, i)| key(i)));
                    after = Some(last);
                }
                assert_eq!(joined, whole, "pages of {size}");
            }
            // what the caller declines is skipped from the changed photos too
            let even: Vec<_> = f.source.page(&filter, &remote, &[], None, None, usize::MAX, &|i| i.version == 0, &|| false).unwrap();
            assert_eq!(even.len(), whole.iter().filter(|(_, v)| *v == 0).count());
        }
    }

    #[test]
    fn hidden_folders_and_scopes_apply_to_the_changed_photos() {
        let mut f = fixture(photos(120, 5));
        let model = model(&f);
        let ops = random_ops(&model, 9, 60);
        let reference = reference_images(&model, &ops);
        f.source.overrides = overrides_of(&ops);
        f.source.scopes = vec![(PathBuf::from("/mnt/photos/2024"), true), (PathBuf::from("/mnt/photos"), false)];
        let hidden = [PathBuf::from("/mnt/photos/2024/a")];
        let inside = |i: &LibraryImage| {
            let p = Path::new(&i.path);
            !p.starts_with("/mnt/photos/2024/a")
                && (p.starts_with("/mnt/photos/2024") || p.parent() == Some(Path::new("/mnt/photos")))
        };
        let got: Vec<_> = f.source
            .page(&GridFilter::default(), &SearchArgs::default(), &hidden, None, None, usize::MAX, &|_| true, &|| false)
            .unwrap().into_iter().map(|(_, i)| key(&i)).collect();
        let expect: Vec<_> = reference.iter().filter(|i| inside(i)).map(key).collect();
        assert_eq!(got, expect);
        assert!(got.len() > 20);
    }

    #[test]
    fn facet_counts_with_overrides_match_passes_over_the_changed_rows() {
        use crate::find_facets::List::*;
        let mut f = fixture(photos(300, 0xfeed));
        let model = model(&f);
        let ops = random_ops(&model, 31, 40);
        f.source.overrides = overrides_of(&ops);
        let reference = reference_images(&model, &ops);
        let lists = [Kinds, Keywords, Cameras, Bodies, Lenses, Months, Iso, Aperture, Focal, Shutter];
        let mut checked = 0;
        for (n, (filter, remote)) in vectors(&f).iter().enumerate().step_by(7) {
            let mut sql = Tallies::new();
            f.source.facets(&filter.canonical(), remote, &[], &lists, &mut sql, &|| false).unwrap();
            let mut expect = Tallies::new();
            let canonical = filter.canonical();
            for &list in &lists {
                let (g, r) = without(list, &canonical, remote);
                for image in &reference {
                    if sf::passes(image, None, &g, &r) {
                        tally_image(&mut expect, list, image, None);
                    }
                }
            }
            for list in lists {
                assert_eq!(sql.snapshot(list), expect.snapshot(list), "vector {n} list {list:?}");
            }
            checked += 1;
        }
        assert!(checked > 70);
    }

    // cargo test --release --locked -- --ignored --nocapture mirror_query::tests::timings
    #[test]
    #[ignore = "builds a 150,000-photo mirror; run in release"]
    fn timings_at_150k_photos() {
        use crate::find_facets::List::*;
        use std::time::Instant;
        let started = Instant::now();
        let (f, _dir) = fixture_without_reference(photos(150_000, 99));
        eprintln!("built a mirror of 150000 photos in {:?}", started.elapsed());
        let remote = SearchArgs::default();
        let page = |filter: &GridFilter| {
            let t = Instant::now();
            let rows = f.page(filter, &remote, &[], None, None, 251, &|_| true, &|| false).unwrap();
            (t.elapsed(), rows.len())
        };
        eprintln!("(a) unfiltered first page: {:?}", page(&GridFilter::default()));
        let narrow = GridFilter {
            min_rating: 4,
            keywords: vec!["Places|France|Paris".into()],
            cameras: vec!["Nikon Z 6".into()],
            ..Default::default()
        };
        eprintln!("(b) narrow filter, keyword + camera + rating: {:?}", page(&narrow));
        let rare = GridFilter { keywords: vec!["Places|France|Paris".into()], iso: vec!["3200".into()], ..Default::default() };
        eprintln!("(b) narrow filter, keyword + a value nobody has: {:?}", page(&rare));
        let dated = GridFilter { taken_from: "2024-05-06".into(), taken_to: "2024-05-06".into(), edited: "edited".into(), ..Default::default() };
        eprintln!("(b) narrow filter, one day + edited: {:?}", page(&dated));
        let all = [Kinds, Keywords, Cameras, Bodies, Lenses, Months, Iso, Aperture, Focal, Shutter];
        for (name, filter) in [("no filter", GridFilter::default()), ("narrowed by camera and rating", narrow.clone())] {
            let t = Instant::now();
            let mut tallies = Tallies::new();
            f.facets(&filter.canonical(), &remote, &[], &all, &mut tallies, &|| false).unwrap();
            eprintln!("(c) every list, {name}: {:?}", t.elapsed());
            for list in all {
                let t = Instant::now();
                let mut tallies = Tallies::new();
                f.facets(&filter.canonical(), &remote, &[], &[list], &mut tallies, &|| false).unwrap();
                eprintln!("      {list:?}: {:?}", t.elapsed());
            }
        }
    }
}
