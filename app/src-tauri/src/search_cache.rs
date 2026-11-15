// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Disposable metadata for local semantic search. This database is independent
//! of darktable's per-process catalog: losing it only requires reanalysis.

use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 5;

/// A stable cache-owned identity for one source file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub id: i64,
    pub path: String,
    pub original_fingerprint: String,
}

/// One original or virtual-copy editing state of an asset.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    pub id: i64,
    pub asset_id: i64,
    pub copy_key: String,
    pub edited_fingerprint: String,
    pub capture_time_ns: Option<i64>,
    pub capture_time_raw: Option<String>,
    pub timezone_offset_seconds: Option<i32>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct RootStatus {
    pub path: String,
    pub mount: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct Counts {
    pub assets: i64,
    pub variants: i64,
    pub metadata: i64,
    pub analyses: i64,
}
pub struct Candidate {
    pub asset_id: i64,
    pub variant_id: i64,
    pub path: String,
    pub copy_key: String,
    pub capture_raw: Option<String>,
    pub metadata: Option<String>,
    pub embedding: Option<Vec<u8>>,
}
/// SQLite metadata/index store. The connection is serialized because rusqlite
/// connections are not Sync; callers should keep expensive file work outside.
pub struct SearchCache {
    db: Mutex<Connection>,
    instance: String,
}

impl SearchCache {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("search cache directory unavailable ({e}); using session-only SQLite");
                return Self::from_connection(
                    Connection::open_in_memory().map_err(|e| e.to_string())?,
                );
            }
        }
        let open = || {
            Connection::open(path)
                .map_err(|e| e.to_string())
                .and_then(Self::from_connection)
        };
        match open() {
            Ok(cache) => Ok(cache),
            Err(first) => {
                // The database contains only disposable search metadata. Keep
                // a damaged or newer file for inspection and let the app run
                // with a fresh cache, even on a read-only/unavailable volume.
                let corrupt = [
                    "file is not a database",
                    "database disk image is malformed",
                    "malformed database schema",
                    "unsupported file format",
                ]
                .iter()
                .any(|pattern| first.to_ascii_lowercase().contains(pattern));
                if corrupt && path.exists() {
                    let suffix = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos();
                    let backup = path.with_file_name(format!(
                        "{}.unusable-{suffix}",
                        path.file_name().unwrap_or_default().to_string_lossy()
                    ));
                    if std::fs::rename(path, &backup).is_ok() {
                        for ext in ["sqlite-wal", "sqlite-shm"] {
                            let side = path.with_extension(ext);
                            if side.exists() {
                                let _ = std::fs::rename(
                                    &side,
                                    backup.with_file_name(format!(
                                        "{}-{ext}",
                                        backup.file_name().unwrap_or_default().to_string_lossy()
                                    )),
                                );
                            }
                        }
                    }
                }
                match open() {
                    Ok(cache) => {
                        eprintln!("search cache reset after startup error ({first})");
                        Ok(cache)
                    }
                    Err(second) => {
                        eprintln!("search cache persistence unavailable ({first}; {second}); using session-only SQLite");
                        Self::from_connection(
                            Connection::open_in_memory().map_err(|e| e.to_string())?,
                        )
                    }
                }
            }
        }
    }

    fn from_connection(db: Connection) -> Result<Self, String> {
        let has_meta: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='search_cache_meta')",
            [], |r| r.get(0)).map_err(|e| e.to_string())?;
        let prior: Option<i64> = if has_meta {
            db.query_row(
                "SELECT value FROM search_cache_meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        } else {
            None
        };
        if prior.is_some_and(|v| v > SCHEMA_VERSION) {
            return Err("search cache was created by a newer Immage version".into());
        }
        db.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        db.pragma_update(None, "journal_mode", "WAL")
            .map_err(|e| e.to_string())?;
        let schema = db.unchecked_transaction().map_err(|e| e.to_string())?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS search_cache_meta (
                key TEXT PRIMARY KEY, value INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS search_roots (
                path TEXT PRIMARY KEY, mount TEXT, state TEXT NOT NULL DEFAULT 'pending',
                checked_at INTEGER, error TEXT
             );
             CREATE TABLE IF NOT EXISTS assets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL UNIQUE,
                original_fingerprint TEXT NOT NULL,
                updated_at INTEGER NOT NULL DEFAULT (unixepoch())
             );
             CREATE TABLE IF NOT EXISTS variants (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                copy_key TEXT NOT NULL DEFAULT '',
                edited_fingerprint TEXT NOT NULL,
                capture_time_ns INTEGER,
                capture_time_raw TEXT,
                timezone_offset_seconds INTEGER,
                metadata_json TEXT,
                UNIQUE(asset_id, copy_key)
             );
             CREATE TABLE IF NOT EXISTS analyses (
                asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
                subject TEXT NOT NULL DEFAULT 'edited' CHECK(subject IN ('original','edited')),
                analysis_version INTEGER NOT NULL,
                model_version TEXT NOT NULL,
                embedding BLOB NOT NULL,
                analyzed_at INTEGER NOT NULL DEFAULT (unixepoch()),
                CHECK((subject='original' AND variant_id IS NULL) OR (subject='edited' AND variant_id IS NOT NULL))
             );
             CREATE INDEX IF NOT EXISTS variants_capture_time ON variants(capture_time_ns);"
        ).map_err(|e| e.to_string())?;
        if prior == Some(1) {
            db.execute_batch(
                "ALTER TABLE analyses RENAME TO analyses_v1;
                 CREATE TABLE analyses (
                   variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
                   subject TEXT NOT NULL DEFAULT 'edited' CHECK(subject IN ('original','edited')),
                   analysis_version INTEGER NOT NULL, model_version TEXT NOT NULL,
                   embedding BLOB NOT NULL, analyzed_at INTEGER NOT NULL DEFAULT (unixepoch()),
                   PRIMARY KEY(variant_id,subject,analysis_version,model_version));
                 INSERT INTO analyses(variant_id,subject,analysis_version,model_version,embedding,analyzed_at)
                   SELECT variant_id,'edited',analysis_version,model_version,embedding,analyzed_at FROM analyses_v1;
                 DROP TABLE analyses_v1;
                 ALTER TABLE variants ADD COLUMN capture_time_raw TEXT;
                 ALTER TABLE variants ADD COLUMN timezone_offset_seconds INTEGER;"
            ).map_err(|e| e.to_string())?;
        }
        if prior.is_some_and(|v| v < 3) {
            db.execute_batch(
                "ALTER TABLE analyses RENAME TO analyses_v2;
                 CREATE TABLE analyses (
                   asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
                   variant_id INTEGER REFERENCES variants(id) ON DELETE CASCADE,
                   subject TEXT NOT NULL CHECK(subject IN ('original','edited')),
                   analysis_version INTEGER NOT NULL, model_version TEXT NOT NULL,
                   embedding BLOB NOT NULL, analyzed_at INTEGER NOT NULL DEFAULT (unixepoch()),
                   CHECK((subject='original' AND variant_id IS NULL) OR (subject='edited' AND variant_id IS NOT NULL)));
                 INSERT OR IGNORE INTO analyses(asset_id,variant_id,subject,analysis_version,model_version,embedding,analyzed_at)
                   SELECT variants.asset_id,
                     CASE WHEN analyses_v2.subject='original' THEN NULL ELSE analyses_v2.variant_id END,
                     analyses_v2.subject,analyses_v2.analysis_version,analyses_v2.model_version,
                     analyses_v2.embedding,analyses_v2.analyzed_at
                   FROM analyses_v2 JOIN variants ON variants.id=analyses_v2.variant_id;
                 DROP TABLE analyses_v2;
                 CREATE UNIQUE INDEX original_analysis_key ON analyses(asset_id,analysis_version,model_version) WHERE subject='original';
                 CREATE UNIQUE INDEX edited_analysis_key ON analyses(variant_id,analysis_version,model_version) WHERE subject='edited';"
            ).map_err(|e| e.to_string())?;
        }
        if prior.is_some_and(|v| v < 4) {
            db.execute_batch("ALTER TABLE variants ADD COLUMN metadata_json TEXT;")
                .map_err(|e| e.to_string())?;
        }
        db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS original_analysis_key ON analyses(asset_id,analysis_version,model_version) WHERE subject='original';
                          CREATE UNIQUE INDEX IF NOT EXISTS edited_analysis_key ON analyses(variant_id,analysis_version,model_version) WHERE subject='edited';")
            .map_err(|e| e.to_string())?;
        db.execute(
            "INSERT INTO search_cache_meta(key,value) VALUES('schema_version',?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [SCHEMA_VERSION],
        )
        .map_err(|e| e.to_string())?;
        schema.commit().map_err(|e| e.to_string())?;
        Ok(Self {
            db: Mutex::new(db),
            instance: uuid::Uuid::new_v4().to_string(),
        })
    }

    /// Register a path and its original/edited fingerprints. A fingerprint
    /// change drops only analyses for that version; stable IDs survive refresh.
    #[allow(clippy::too_many_arguments)] // Explicit source, edit and capture metadata contract.
    pub fn upsert_variant(
        &self,
        path: &str,
        copy_key: &str,
        original_fingerprint: &str,
        edited_fingerprint: &str,
        capture_time_ns: Option<i64>,
        capture_time_raw: Option<&str>,
        timezone_offset_seconds: Option<i32>,
    ) -> Result<Variant, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let old_original: Option<String> = tx
            .query_row(
                "SELECT original_fingerprint FROM assets WHERE path=?1",
                [path],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO assets(path,original_fingerprint) VALUES(?1,?2)
             ON CONFLICT(path) DO UPDATE SET original_fingerprint=excluded.original_fingerprint,
             updated_at=unixepoch()",
            params![path, original_fingerprint],
        )
        .map_err(|e| e.to_string())?;
        let asset_id: i64 = tx
            .query_row("SELECT id FROM assets WHERE path=?1", [path], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if old_original
            .as_deref()
            .is_some_and(|old| old != original_fingerprint)
        {
            tx.execute("UPDATE variants SET metadata_json=NULL,capture_time_ns=NULL,capture_time_raw=NULL,timezone_offset_seconds=NULL,edited_fingerprint='invalid:' || ?2 || ':' || edited_fingerprint WHERE asset_id=?1", params![asset_id,original_fingerprint])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM analyses WHERE asset_id=?1", [asset_id])
                .map_err(|e| e.to_string())?;
        }
        let old_edited: Option<String> = tx
            .query_row(
                "SELECT edited_fingerprint FROM variants WHERE asset_id=?1 AND copy_key=?2",
                params![asset_id, copy_key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO variants(asset_id,copy_key,edited_fingerprint,capture_time_ns,capture_time_raw,timezone_offset_seconds)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(asset_id,copy_key) DO UPDATE SET
             edited_fingerprint=excluded.edited_fingerprint,
             capture_time_ns=CASE WHEN ?7 OR (?5 IS NOT NULL AND variants.capture_time_raw IS NOT NULL AND ?5 != variants.capture_time_raw) THEN excluded.capture_time_ns ELSE coalesce(excluded.capture_time_ns,variants.capture_time_ns) END,
             capture_time_raw=CASE WHEN ?7 THEN excluded.capture_time_raw ELSE coalesce(excluded.capture_time_raw,variants.capture_time_raw) END,
             timezone_offset_seconds=CASE WHEN ?7 OR (?5 IS NOT NULL AND variants.capture_time_raw IS NOT NULL AND ?5 != variants.capture_time_raw) THEN excluded.timezone_offset_seconds ELSE coalesce(excluded.timezone_offset_seconds,variants.timezone_offset_seconds) END",
            params![asset_id, copy_key, edited_fingerprint, capture_time_ns, capture_time_raw, timezone_offset_seconds, old_original.as_deref().is_some_and(|old|old!=original_fingerprint)]
        ).map_err(|e| e.to_string())?;
        let id: i64 = tx
            .query_row(
                "SELECT id FROM variants WHERE asset_id=?1 AND copy_key=?2",
                params![asset_id, copy_key],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if old_edited
            .as_deref()
            .is_some_and(|old| old != edited_fingerprint)
            && old_original
                .as_deref()
                .is_some_and(|old| old == original_fingerprint)
        {
            tx.execute("UPDATE variants SET metadata_json=NULL WHERE id=?1", [id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "DELETE FROM analyses WHERE variant_id=?1 AND subject='edited'",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
        let (capture_time_ns, capture_time_raw, timezone_offset_seconds) = tx
            .query_row(
                "SELECT capture_time_ns,capture_time_raw,timezone_offset_seconds FROM variants WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Variant {
            id,
            asset_id,
            copy_key: copy_key.into(),
            edited_fingerprint: edited_fingerprint.into(),
            capture_time_ns,
            capture_time_raw,
            timezone_offset_seconds,
        })
    }

    /// Store an embedding only for the exact analysis/model version.
    /// Store only if the source/edit fingerprint still matches the analysis
    /// input. This closes the race between slow inference and a file/edit change.
    #[cfg(test)]
    pub fn put_analysis(
        &self,
        variant_id: i64,
        subject: &str,
        expected_fingerprint: &str,
        analysis_version: i64,
        model_version: &str,
        embedding: &[u8],
    ) -> Result<bool, String> {
        if !matches!(subject, "original" | "edited") {
            return Err("invalid analysis subject".into());
        }
        let mut guard = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let tx = guard.transaction().map_err(|e| e.to_string())?;
        let column = if subject == "original" {
            "assets.original_fingerprint"
        } else {
            "variants.edited_fingerprint"
        };
        let query = format!("SELECT {column} FROM variants JOIN assets ON assets.id=variants.asset_id WHERE variants.id=?1");
        let fingerprint: String = tx
            .query_row(&query, [variant_id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if fingerprint != expected_fingerprint {
            return Ok(false);
        }
        let asset_id: i64 = tx
            .query_row(
                "SELECT asset_id FROM variants WHERE id=?1",
                [variant_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute("INSERT OR REPLACE INTO analyses(asset_id,variant_id,subject,analysis_version,model_version,embedding)
                    VALUES(?1,?2,?3,?4,?5,?6)",
                    params![asset_id, (subject == "edited").then_some(variant_id), subject,
                            analysis_version, model_version, embedding])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    #[cfg(test)]
    pub fn analysis(
        &self,
        variant_id: i64,
        subject: &str,
        analysis_version: i64,
        model_version: &str,
    ) -> Result<Option<Vec<u8>>, String> {
        if !matches!(subject, "original" | "edited") {
            return Err("invalid analysis subject".into());
        }
        self.db.lock().map_err(|_| "search cache lock poisoned")?
            .query_row("SELECT embedding FROM analyses WHERE subject=?2 AND analysis_version=?3 AND model_version=?4
                        AND ((?2='edited' AND variant_id=?1) OR (?2='original' AND asset_id=(SELECT asset_id FROM variants WHERE id=?1)))",
                       params![variant_id, subject, analysis_version, model_version], |r| r.get(0))
            .optional().map_err(|e| e.to_string())
    }

    pub fn asset(&self, id: i64) -> Result<Option<Asset>, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .query_row(
                "SELECT id,path,original_fingerprint FROM assets WHERE id=?1",
                [id],
                |r| {
                    Ok(Asset {
                        id: r.get(0)?,
                        path: r.get(1)?,
                        original_fingerprint: r.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn variant(&self, path: &str, copy_key: &str) -> Result<Option<Variant>, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .query_row(
                "SELECT variants.id,variants.asset_id,variants.copy_key,variants.edited_fingerprint,
                        variants.capture_time_ns,variants.capture_time_raw,variants.timezone_offset_seconds
                 FROM variants JOIN assets ON assets.id=variants.asset_id
                 WHERE assets.path=?1 AND variants.copy_key=?2",
                params![path, copy_key],
                |r| {
                    Ok(Variant {
                        id: r.get(0)?, asset_id: r.get(1)?, copy_key: r.get(2)?,
                        edited_fingerprint: r.get(3)?, capture_time_ns: r.get(4)?,
                        capture_time_raw: r.get(5)?, timezone_offset_seconds: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    /// Keep the already-extracted library metadata in SQLite without an
    /// engine imgid; cached records are never treated as darktable IDs.
    #[cfg(test)]
    pub fn store_metadata(&self, variant_id: i64, metadata: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute(
                "UPDATE variants SET metadata_json=?2 WHERE id=?1",
                params![variant_id, metadata],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn metadata(&self, variant_id: i64) -> Result<Option<String>, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .query_row(
                "SELECT metadata_json FROM variants WHERE id=?1",
                [variant_id],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.flatten())
            .map_err(|e| e.to_string())
    }

    pub fn store_metadata_if_current(
        &self,
        variant_id: i64,
        original: &str,
        edited: &str,
        metadata: &str,
    ) -> Result<bool, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute(
                "UPDATE variants SET metadata_json=?4 WHERE id=?1 AND edited_fingerprint=?3
             AND asset_id IN (SELECT id FROM assets WHERE original_fingerprint=?2)",
                params![variant_id, original, edited, metadata],
            )
            .map(|n| n == 1)
            .map_err(|e| e.to_string())
    }

    pub fn path_metadata(
        &self,
        path: &str,
    ) -> Result<Vec<(String, String, String, String)>, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let mut query = db.prepare("SELECT variants.copy_key,assets.original_fingerprint,variants.edited_fingerprint,variants.metadata_json
            FROM variants JOIN assets ON assets.id=variants.asset_id WHERE assets.path=?1 AND variants.metadata_json IS NOT NULL
            ORDER BY variants.id").map_err(|e| e.to_string())?;
        let rows = query
            .query_map([path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn revision(&self) -> Result<String, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let external: i64 = db
            .query_row("PRAGMA data_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "{}:{}:{external}",
            self.instance,
            db.total_changes()
        ))
    }
    pub fn candidates(
        &self,
        after: i64,
        subject: &str,
        version: i64,
        model: &str,
        with_embedding: bool,
    ) -> Result<Vec<Candidate>, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let join = match subject {
            "edited" => "n.variant_id=v.id",
            "original" => "n.asset_id=a.id",
            _ => return Err("Invalid analysis subject".into()),
        };
        // A fixed subject-specific join uses the partial analysis indexes and
        // avoids an OR join over every vector in a large library.
        let sql = if with_embedding {
            format!(
                "SELECT a.id,v.id,a.path,v.copy_key,v.capture_time_raw,v.metadata_json,n.embedding
          FROM variants v JOIN assets a ON a.id=v.asset_id LEFT JOIN analyses n
          ON n.analysis_version=?2 AND n.model_version=?3 AND n.subject='{subject}' AND {join}
          WHERE v.id>?1 ORDER BY v.id LIMIT 256"
            )
        } else {
            "SELECT a.id,v.id,a.path,v.copy_key,v.capture_time_raw,v.metadata_json,NULL FROM variants v JOIN assets a ON a.id=v.asset_id WHERE v.id>?1 ORDER BY v.id LIMIT 256".into()
        };
        let mut query = db.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows = if with_embedding {
            query.query(params![after, version, model])
        } else {
            query.query([after])
        }
        .map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            result.push(Candidate {
                asset_id: row.get(0).map_err(|e| e.to_string())?,
                variant_id: row.get(1).map_err(|e| e.to_string())?,
                path: row.get(2).map_err(|e| e.to_string())?,
                copy_key: row.get(3).map_err(|e| e.to_string())?,
                capture_raw: row.get(4).map_err(|e| e.to_string())?,
                metadata: row.get(5).map_err(|e| e.to_string())?,
                embedding: row.get(6).map_err(|e| e.to_string())?,
            });
        }
        Ok(result)
    }
    pub fn image_query(
        &self,
        variant: i64,
        subject: &str,
        version: i64,
        model: &str,
    ) -> Result<Option<(i64, Vec<u8>)>, String> {
        self.db.lock().map_err(|_|"search cache lock poisoned")?.query_row("SELECT v.asset_id,n.embedding FROM variants v JOIN analyses n ON n.subject=?2 AND n.analysis_version=?3 AND n.model_version=?4 AND ((?2='edited' AND n.variant_id=v.id) OR (?2='original' AND n.asset_id=v.asset_id)) WHERE v.id=?1",params![variant,subject,version,model],|row| Ok((row.get(0)?,row.get(1)?))).optional().map_err(|e|e.to_string())
    }
    pub fn counts(&self) -> Result<Counts, String> {
        self.db.lock().map_err(|_|"search cache lock poisoned")?.query_row(
            "SELECT (SELECT count(*) FROM assets),(SELECT count(*) FROM variants),(SELECT count(*) FROM variants WHERE metadata_json IS NOT NULL),(SELECT count(*) FROM analyses)",[],|row| Ok(Counts{assets:row.get(0)?,variants:row.get(1)?,metadata:row.get(2)?,analyses:row.get(3)?})).map_err(|e|e.to_string())
    }
    /// Clear disposable rows while retaining root identity and AUTOINCREMENT
    /// sequences. Late work cannot accidentally target a newly reused ID.
    pub fn clear(&self) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute("DELETE FROM assets", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn assets(&self) -> Result<Vec<Asset>, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let mut q = db
            .prepare("SELECT id,path,original_fingerprint FROM assets ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok(Asset {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    original_fingerprint: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn roots(&self) -> Result<Vec<RootStatus>, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let mut q = db
            .prepare("SELECT path,mount,state,error FROM search_roots ORDER BY path")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| {
                Ok(RootStatus {
                    path: r.get(0)?,
                    mount: r.get(1)?,
                    state: r.get(2)?,
                    error: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
    pub fn root_mount(&self, path: &str) -> Result<Option<String>, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .query_row(
                "SELECT mount FROM search_roots WHERE path=?1",
                [path],
                |r| r.get(0),
            )
            .optional()
            .map(|v| v.flatten())
            .map_err(|e| e.to_string())
    }
    pub fn root_state(
        &self,
        path: &str,
        mount: Option<&str>,
        state: &str,
        error: Option<&str>,
    ) -> Result<(), String> {
        self.db.lock().map_err(|_| "search cache lock poisoned")?.execute(
            "INSERT INTO search_roots(path,mount,state,checked_at,error) VALUES(?1,?2,?3,unixepoch(),?4)
             ON CONFLICT(path) DO UPDATE SET mount=coalesce(excluded.mount,search_roots.mount),state=excluded.state,checked_at=excluded.checked_at,error=excluded.error",
            params![path,mount,state,error]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn remove_unchanged_asset(&self, asset: &Asset) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute(
                "DELETE FROM assets WHERE id=?1 AND path=?2 AND original_fingerprint=?3",
                params![asset.id, asset.path, asset.original_fingerprint],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn path_variants(&self, path: &str) -> Result<Vec<Variant>, String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let mut q=db.prepare("SELECT variants.id,asset_id,copy_key,edited_fingerprint,capture_time_ns,capture_time_raw,timezone_offset_seconds
            FROM variants JOIN assets ON assets.id=variants.asset_id WHERE assets.path=?1 ORDER BY variants.id").map_err(|e| e.to_string())?;
        let rows = q
            .query_map([path], |r| {
                Ok(Variant {
                    id: r.get(0)?,
                    asset_id: r.get(1)?,
                    copy_key: r.get(2)?,
                    edited_fingerprint: r.get(3)?,
                    capture_time_ns: r.get(4)?,
                    capture_time_raw: r.get(5)?,
                    timezone_offset_seconds: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn invalidate_edited(&self, path: &str, copy_key: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM analyses WHERE subject='edited' AND variant_id IN
            (SELECT variants.id FROM variants JOIN assets ON assets.id=asset_id WHERE assets.path=?1 AND copy_key=?2)",params![path,copy_key]).map_err(|e| e.to_string())?;
        tx.execute("UPDATE variants SET metadata_json=NULL,edited_fingerprint='invalid:' || lower(hex(randomblob(16))) WHERE asset_id IN (SELECT id FROM assets WHERE path=?1) AND copy_key=?2",params![path,copy_key]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn remove_path(&self, path: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute("DELETE FROM assets WHERE path=?1", [path])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn remove_variant(&self, path: &str, copy_key: &str) -> Result<(), String> {
        self.db.lock().map_err(|_| "search cache lock poisoned")?.execute("DELETE FROM variants WHERE asset_id IN (SELECT id FROM assets WHERE path=?1) AND copy_key=?2",params![path,copy_key])
            .map(|_| ()).map_err(|e| e.to_string())
    }

    /// Called only after a verified transfer with matching source/destination
    /// fingerprints. Moves retain identities; copies allocate independent ones.
    /// Fingerprints are checked again inside the transaction against the snapshot.
    pub fn transferred(
        &self,
        source: &str,
        dest: &str,
        original: &str,
        variants: &[Variant],
        moved: bool,
    ) -> Result<bool, String> {
        if variants.is_empty() || source == dest {
            return Ok(false);
        }
        let db = self.db.lock().map_err(|_| "search cache lock poisoned")?;
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let asset_id = variants[0].asset_id;
        let valid: bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM assets WHERE id=?1 AND path=?2 AND original_fingerprint=?3)",params![asset_id,source,original],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !valid {
            return Ok(false);
        }
        let count: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM variants WHERE asset_id=?1",
                [asset_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if count != variants.len() as i64 {
            return Ok(false);
        }
        for v in variants {
            let valid:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM variants WHERE id=?1 AND asset_id=?2 AND copy_key=?3 AND edited_fingerprint=?4)",params![v.id,asset_id,v.copy_key,v.edited_fingerprint],|r|r.get(0)).map_err(|e|e.to_string())?;
            if !valid {
                return Ok(false);
            }
        }
        // The verified destination replaces any disposable stale record there.
        tx.execute("DELETE FROM assets WHERE path=?1", [dest])
            .map_err(|e| e.to_string())?;
        let target_id = if moved {
            tx.execute(
                "UPDATE assets SET path=?2,updated_at=unixepoch() WHERE id=?1",
                params![asset_id, dest],
            )
            .map_err(|e| e.to_string())?;
            asset_id
        } else {
            tx.execute(
                "INSERT INTO assets(path,original_fingerprint) VALUES(?1,?2)",
                params![dest, original],
            )
            .map_err(|e| e.to_string())?;
            let id = tx.last_insert_rowid();
            tx.execute("INSERT INTO analyses(asset_id,variant_id,subject,analysis_version,model_version,embedding,analyzed_at)
                SELECT ?1,NULL,subject,analysis_version,model_version,embedding,analyzed_at FROM analyses WHERE asset_id=?2 AND subject='original'",params![id,asset_id]).map_err(|e|e.to_string())?;
            id
        };
        for v in variants {
            let json: Option<String> = tx
                .query_row(
                    "SELECT metadata_json FROM variants WHERE id=?1",
                    [v.id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let rebased = json
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|mut value| {
                    let fields = value.as_object_mut()?;
                    fields.insert("path".into(), serde_json::json!(dest));
                    fields.insert(
                        "filename".into(),
                        serde_json::json!(Path::new(dest).file_name()?.to_str()?),
                    );
                    serde_json::to_string(&value).ok()
                });
            if moved {
                tx.execute(
                    "UPDATE variants SET metadata_json=?2 WHERE id=?1",
                    params![v.id, rebased],
                )
                .map_err(|e| e.to_string())?;
            } else {
                tx.execute("INSERT INTO variants(asset_id,copy_key,edited_fingerprint,capture_time_ns,capture_time_raw,timezone_offset_seconds,metadata_json)
                    SELECT ?1,copy_key,edited_fingerprint,capture_time_ns,capture_time_raw,timezone_offset_seconds,?3 FROM variants WHERE id=?2",params![target_id,v.id,rebased]).map_err(|e|e.to_string())?;
                let new_variant = tx.last_insert_rowid();
                tx.execute("INSERT INTO analyses(asset_id,variant_id,subject,analysis_version,model_version,embedding,analyzed_at)
                    SELECT ?1,?2,subject,analysis_version,model_version,embedding,analyzed_at FROM analyses WHERE variant_id=?3 AND subject='edited'",params![target_id,new_variant,v.id]).map_err(|e|e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Verified relocation preserves identity and embeddings; callers must
    /// verify source/destination bytes before invoking this method.
    #[cfg(test)]
    pub fn relocate_verified(&self, id: i64, new_path: &str) -> Result<bool, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute(
                "UPDATE assets SET path=?2,updated_at=unixepoch() WHERE id=?1",
                params![id, new_path],
            )
            .map(|n| n == 1)
            .map_err(|e| e.to_string())
    }

    #[cfg(test)]
    pub fn remove_asset(&self, id: i64) -> Result<bool, String> {
        self.db
            .lock()
            .map_err(|_| "search cache lock poisoned")?
            .execute("DELETE FROM assets WHERE id=?1", [id])
            .map(|n| n == 1)
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> SearchCache {
        SearchCache::from_connection(Connection::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn clear_cascades_preserves_root_identity_and_never_reuses_ids() {
        let dir = tempfile::tempdir().unwrap();
        let cache = SearchCache::open(&dir.path().join("cache.sqlite")).unwrap();
        let v = cache
            .upsert_variant("/photos/a.jpg", "0", "original", "edited", None, None, None)
            .unwrap();
        cache.store_metadata(v.id, "{}").unwrap();
        cache
            .put_analysis(v.id, "edited", "edited", 1, "model", b"vector")
            .unwrap();
        cache
            .root_state("/photos", Some("drive"), "online", None)
            .unwrap();
        let before = cache.counts().unwrap();
        assert_eq!(
            (
                before.assets,
                before.variants,
                before.metadata,
                before.analyses
            ),
            (1, 1, 1, 1)
        );
        cache.clear().unwrap();
        let after = cache.counts().unwrap();
        assert_eq!(
            (after.assets, after.variants, after.metadata, after.analyses),
            (0, 0, 0, 0)
        );
        assert_eq!(
            cache.root_mount("/photos").unwrap().as_deref(),
            Some("drive")
        );
        let new = cache
            .upsert_variant("/photos/a.jpg", "0", "original", "edited", None, None, None)
            .unwrap();
        assert!(new.id > v.id);
        assert!(cache
            .put_analysis(v.id, "edited", "edited", 1, "model", b"late")
            .is_err());
    }
    #[test]
    fn source_and_metadata_changes_reject_late_jobs_for_all_versions() {
        let cache = cache();
        let a = cache
            .upsert_variant(
                "/a",
                "",
                "raw1",
                "edit1",
                Some(12),
                Some("time1"),
                Some(3600),
            )
            .unwrap();
        let b = cache
            .upsert_variant(
                "/a",
                "version:2",
                "raw1",
                "copy1",
                Some(12),
                Some("time1"),
                Some(3600),
            )
            .unwrap();
        let refreshed = cache
            .upsert_variant("/a", "", "raw1", "edit1", None, None, None)
            .unwrap();
        assert_eq!(refreshed.capture_time_ns, Some(12));
        cache.invalidate_edited("/a", "").unwrap();
        assert!(!cache
            .put_analysis(a.id, "edited", "edit1", 1, "m", &[1])
            .unwrap());
        cache
            .upsert_variant("/a", "", "raw2", "edit2", None, None, None)
            .unwrap();
        assert!(!cache
            .put_analysis(b.id, "edited", "copy1", 1, "m", &[1])
            .unwrap());
        let copy = cache.variant("/a", "version:2").unwrap().unwrap();
        assert_eq!(copy.capture_time_ns, None);
        assert_eq!(copy.capture_time_raw, None);
        assert_eq!(copy.timezone_offset_seconds, None);
        cache
            .upsert_variant(
                "/a",
                "",
                "raw2",
                "edit2",
                Some(10),
                Some("new time"),
                Some(3600),
            )
            .unwrap();
        let retimed = cache
            .upsert_variant("/a", "", "raw2", "edit3", None, Some("changed time"), None)
            .unwrap();
        assert_eq!(retimed.capture_time_ns, None);
        assert_eq!(retimed.timezone_offset_seconds, None);
    }

    #[test]
    fn cache_transfer_rejects_changed_snapshots_and_invalidation_keeps_original_analysis() {
        let cache = cache();
        let a = cache
            .upsert_variant("/a", "", "raw", "edit1", None, None, None)
            .unwrap();
        cache
            .put_analysis(a.id, "original", "raw", 1, "m", &[1])
            .unwrap();
        cache
            .put_analysis(a.id, "edited", "edit1", 1, "m", &[2])
            .unwrap();
        cache.store_metadata(a.id, "{}").unwrap();
        cache.invalidate_edited("/a", "").unwrap();
        assert_eq!(
            cache.analysis(a.id, "original", 1, "m").unwrap(),
            Some(vec![1])
        );
        assert_eq!(cache.analysis(a.id, "edited", 1, "m").unwrap(), None);
        assert_eq!(cache.metadata(a.id).unwrap(), None);
        cache
            .upsert_variant("/a", "", "raw", "edit2", None, None, None)
            .unwrap();
        assert!(!cache
            .transferred("/a", "/b", "raw", std::slice::from_ref(&a), true)
            .unwrap());
        assert!(cache.variant("/b", "").unwrap().is_none());
        assert!(cache.variant("/a", "").unwrap().is_some());
        cache.remove_variant("/a", "").unwrap();
        assert_eq!(cache.analysis(a.id, "original", 1, "m").unwrap(), None);
    }

    #[test]
    fn stale_metadata_writes_are_rejected_and_source_changes_clear_siblings() {
        let cache = cache();
        let a = cache
            .upsert_variant("/a", "", "raw1", "edit1", None, None, None)
            .unwrap();
        let b = cache
            .upsert_variant("/a", "version:2", "raw1", "copy1", None, None, None)
            .unwrap();
        assert!(cache
            .store_metadata_if_current(a.id, "raw1", "edit1", "{}")
            .unwrap());
        assert!(cache
            .store_metadata_if_current(b.id, "raw1", "copy1", "{}")
            .unwrap());
        cache
            .upsert_variant("/a", "", "raw1", "edit2", None, None, None)
            .unwrap();
        assert_eq!(cache.metadata(a.id).unwrap(), None);
        assert!(!cache
            .store_metadata_if_current(a.id, "raw1", "edit1", "stale")
            .unwrap());
        assert_eq!(cache.metadata(b.id).unwrap().as_deref(), Some("{}"));
        cache
            .upsert_variant("/a", "", "raw2", "edit3", None, None, None)
            .unwrap();
        assert_eq!(cache.metadata(b.id).unwrap(), None);
        assert!(!cache
            .store_metadata_if_current(b.id, "raw1", "copy1", "stale source")
            .unwrap());
    }

    #[test]
    fn ids_are_cache_owned_stable_and_copies_are_separate() {
        let cache = cache();
        let original = cache
            .upsert_variant(
                "/photos/a.raw",
                "",
                "raw-v1",
                "edit-v1",
                Some(1_735_000_123_456_789_123),
                Some("2024:12:31 23:59:59.123456789"),
                Some(-28800),
            )
            .unwrap();
        let again = cache
            .upsert_variant(
                "/photos/a.raw",
                "",
                "raw-v1",
                "edit-v1",
                Some(1_735_000_123_456_789_123),
                Some("2024:12:31 23:59:59.123456789"),
                Some(-28800),
            )
            .unwrap();
        let copy = cache
            .upsert_variant(
                "/photos/a.raw",
                "darktable-copy-2",
                "raw-v1",
                "edit-copy",
                Some(1_735_000_123_456_789_123),
                Some("2024:12:31 23:59:59.123456789"),
                Some(-28800),
            )
            .unwrap();
        assert_eq!(original.id, again.id);
        assert_eq!(original.asset_id, copy.asset_id);
        assert_ne!(original.id, copy.id);
        assert_eq!(original.capture_time_ns, Some(1_735_000_123_456_789_123));
        assert_eq!(
            original.capture_time_raw.as_deref(),
            Some("2024:12:31 23:59:59.123456789")
        );
        assert_eq!(original.timezone_offset_seconds, Some(-28800));
        cache
            .store_metadata(original.id, r#"{"maker":"Example"}"#)
            .unwrap();
        assert_eq!(
            cache.metadata(original.id).unwrap().as_deref(),
            Some(r#"{"maker":"Example"}"#)
        );
    }

    #[test]
    fn original_or_edited_changes_invalidate_analysis_and_version_is_keyed() {
        let cache = cache();
        let v = cache
            .upsert_variant("/photos/a.raw", "", "raw-v1", "edit-v1", None, None, None)
            .unwrap();
        assert!(cache
            .put_analysis(v.id, "original", "raw-v1", 1, "clip-vit-b32-a", &[1, 2, 3])
            .unwrap());
        assert!(cache
            .put_analysis(v.id, "edited", "edit-v1", 1, "clip-vit-b32-a", &[4, 5, 6])
            .unwrap());
        assert_eq!(
            cache
                .analysis(v.id, "original", 1, "clip-vit-b32-a")
                .unwrap(),
            Some(vec![1, 2, 3])
        );
        assert_eq!(
            cache.analysis(v.id, "edited", 2, "clip-vit-b32-a").unwrap(),
            None
        );
        let copy = cache
            .upsert_variant(
                "/photos/a.raw",
                "darktable-copy-2",
                "raw-v1",
                "edit-copy",
                None,
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            cache
                .analysis(copy.id, "original", 1, "clip-vit-b32-a")
                .unwrap(),
            Some(vec![1, 2, 3])
        );
        cache
            .upsert_variant("/photos/a.raw", "", "raw-v1", "edit-v2", None, None, None)
            .unwrap();
        assert_eq!(
            cache
                .analysis(v.id, "original", 1, "clip-vit-b32-a")
                .unwrap(),
            Some(vec![1, 2, 3])
        );
        assert_eq!(
            cache.analysis(v.id, "edited", 1, "clip-vit-b32-a").unwrap(),
            None
        );
        assert!(!cache
            .put_analysis(v.id, "edited", "edit-v1", 1, "clip-vit-b32-a", &[4])
            .unwrap());
        assert!(cache
            .put_analysis(v.id, "edited", "edit-v2", 1, "clip-vit-b32-a", &[4])
            .unwrap());
        cache
            .upsert_variant("/photos/a.raw", "", "raw-v2", "edit-v2", None, None, None)
            .unwrap();
        assert_eq!(
            cache
                .analysis(v.id, "original", 1, "clip-vit-b32-a")
                .unwrap(),
            None
        );
        assert_eq!(
            cache.analysis(v.id, "edited", 1, "clip-vit-b32-a").unwrap(),
            None
        );
    }

    #[test]
    fn verified_move_preserves_id_and_analysis_but_delete_cascades() {
        let cache = cache();
        let v = cache
            .upsert_variant("/old/a.raw", "", "raw-v1", "edit-v1", None, None, None)
            .unwrap();
        assert!(cache
            .put_analysis(v.id, "edited", "edit-v1", 1, "clip-vit-b32-a", &[9])
            .unwrap());
        assert!(cache.relocate_verified(v.asset_id, "/new/a.raw").unwrap());
        assert_eq!(cache.asset(v.asset_id).unwrap().unwrap().path, "/new/a.raw");
        assert_eq!(
            cache.analysis(v.id, "edited", 1, "clip-vit-b32-a").unwrap(),
            Some(vec![9])
        );
        assert!(cache.remove_asset(v.asset_id).unwrap());
        assert_eq!(
            cache.analysis(v.id, "edited", 1, "clip-vit-b32-a").unwrap(),
            None
        );
    }

    #[test]
    fn migrates_v1_rows_without_losing_edits() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE search_cache_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            INSERT INTO search_cache_meta VALUES('schema_version',1);
            CREATE TABLE assets(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL UNIQUE,
              original_fingerprint TEXT NOT NULL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()));
            CREATE TABLE variants(id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
              copy_key TEXT NOT NULL DEFAULT '',edited_fingerprint TEXT NOT NULL,capture_time_ns INTEGER,UNIQUE(asset_id,copy_key));
            CREATE TABLE analyses(variant_id INTEGER NOT NULL REFERENCES variants(id) ON DELETE CASCADE,
              analysis_version INTEGER NOT NULL,model_version TEXT NOT NULL,embedding BLOB NOT NULL,
              analyzed_at INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(variant_id,analysis_version,model_version));
            INSERT INTO assets(id,path,original_fingerprint) VALUES(1,'/a','raw');
            INSERT INTO variants(id,asset_id,edited_fingerprint) VALUES(2,1,'edit');
            INSERT INTO analyses(variant_id,analysis_version,model_version,embedding) VALUES(2,1,'model',x'0102');")
            .unwrap();
        let cache = SearchCache::from_connection(db).unwrap();
        assert_eq!(
            cache.analysis(2, "edited", 1, "model").unwrap(),
            Some(vec![1, 2])
        );
        assert_eq!(cache.analysis(2, "original", 1, "model").unwrap(), None);
        let version: i64 = cache
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM search_cache_meta WHERE key='schema_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn newer_cache_is_rejected_before_schema_mutation() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE search_cache_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
            INSERT INTO search_cache_meta VALUES('schema_version',999);",
        )
        .unwrap();
        assert!(matches!(SearchCache::from_connection(db), Err(e) if e.contains("newer Immage")));
    }

    #[test]
    fn corrupt_cache_is_quarantined_and_rebuilt() {
        let path = std::env::temp_dir().join(format!(
            "immage-search-cache-corrupt-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, b"not a sqlite database").unwrap();
        let cache = SearchCache::open(&path).unwrap();
        let value = cache
            .upsert_variant("/p/a.jpg", "", "raw", "edit", None, None, None)
            .unwrap();
        assert!(cache.asset(value.asset_id).unwrap().is_some());
        let backups: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("immage-search-cache-corrupt-")
                    && entry.file_name().to_string_lossy().contains("unusable")
            })
            .map(|entry| entry.path())
            .collect();
        assert!(!backups.is_empty());
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
        for backup in backups {
            let _ = std::fs::remove_file(backup);
        }
    }

    #[test]
    fn locked_valid_cache_is_left_in_place_and_search_is_session_only() {
        let path = std::env::temp_dir().join(format!(
            "immage-search-cache-locked-{}.sqlite",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        drop(SearchCache::open(&path).unwrap());
        let lock = Connection::open(&path).unwrap();
        lock.pragma_update(None, "journal_mode", "DELETE").unwrap();
        lock.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let before = std::fs::metadata(&path).unwrap().len();
        let cache = SearchCache::open(&path).unwrap();
        assert!(cache
            .upsert_variant(
                "/session-only/photo.jpg",
                "",
                "raw",
                "edit",
                None,
                None,
                None
            )
            .is_ok());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), before);
        let quarantined = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .contains("immage-search-cache-locked-")
                    && e.file_name().to_string_lossy().contains("unusable")
            });
        assert!(!quarantined);
        lock.execute_batch("ROLLBACK").unwrap();
        drop(lock);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
