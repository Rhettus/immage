// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Session handles for cached library rows, never SQLite or darktable IDs.
//! Only advertised cached rows need a handle; uncached engine IDs pass through.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const FIRST_HANDLE: i64 = 1 << 40; // exact in JS, outside darktable's int32 IDs
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Photo {
    pub path: String,
    pub version: i64,
}
#[derive(Default)]
pub struct LibraryIds {
    next: i64,
    handles: HashMap<i64, Photo>,
    by_photo: HashMap<Photo, i64>,
    real: HashMap<Photo, i64>,
    reverse: HashMap<i64, i64>,
    gates: HashMap<String, Arc<Mutex<()>>>,
    active: Option<Photo>,
}
impl LibraryIds {
    pub fn advertise(&mut self, path: &str, version: i64) -> i64 {
        let photo = Photo {
            path: path.into(),
            version,
        };
        if let Some(id) = self.by_photo.get(&photo) {
            return *id;
        }
        if let Some(id) = self.real.get(&photo) {
            return *id;
        }
        self.next = self.next.max(FIRST_HANDLE) + 1;
        let id = self.next;
        self.handles.insert(id, photo.clone());
        self.by_photo.insert(photo, id);
        id
    }
    pub fn photo(&self, id: i64) -> Result<Option<Photo>, String> {
        if id < FIRST_HANDLE {
            return Ok(None);
        }
        self.handles
            .get(&id)
            .cloned()
            .map(Some)
            .ok_or_else(|| "unknown cached photo handle".into())
    }
    pub fn resolved(&self, photo: &Photo) -> Option<i64> {
        self.real.get(photo).copied()
    }
    pub fn gate(&mut self, path: &str) -> Arc<Mutex<()>> {
        self.gates.entry(path.into()).or_default().clone()
    }
    pub fn restart(&mut self) {
        self.active = None;
        self.real.clear();
        self.reverse.clear();
    }
    pub(crate) fn lookup(&self, id: i64) -> Option<Photo> {
        self.handles.get(&id).cloned().or_else(|| {
            self.real
                .iter()
                .find(|(_, real)| **real == id)
                .map(|(photo, _)| photo.clone())
        })
    }

    pub(crate) fn active_photo(&self) -> Option<Photo> {
        self.active.clone()
    }

    /// Cache consequences of successful operations, shared by all request paths.
    pub fn changed(&mut self, req: &Value, reply: &Value) -> Vec<(Photo, bool)> {
        let command = req["cmd"].as_str().unwrap_or_default();
        let mut affected = Vec::new();
        if matches!(command, "save" | "close" | "open") {
            if let Some(photo) = self.active.clone() {
                affected.push((photo, false));
            }
        }
        if command == "open" {
            self.active = reply["imgid"]
                .as_i64()
                .and_then(|id| self.lookup(id))
                .or_else(|| {
                    req["path"].as_str().map(|path| Photo {
                        path: path.into(),
                        version: 0,
                    })
                });
        } else if command == "close" {
            self.active = None;
        }
        if command == "forget_folder" {
            if let Some(path) = req["path"].as_str() {
                let folder = std::path::Path::new(path);
                self.real.retain(|photo, id| {
                    if std::path::Path::new(&photo.path).starts_with(folder) {
                        self.reverse.remove(id);
                        return false;
                    }
                    true
                });
                if self.active.as_ref().is_some_and(|photo| std::path::Path::new(&photo.path).starts_with(folder)) {
                    self.active = None;
                }
            }
        }
        if matches!(
            command,
            "meta_set"
                | "keywords_set"
                | "capture_times"
                | "history_discard"
                | "paste_batch"
                | "remove_copy"
                | "forget"
        ) {
            let mut identity = req.clone();
            let _ = request_ids(&mut identity, &mut |id| {
                if let Some(photo) = self.lookup(id) {
                    if !affected.iter().any(|(p, _)| *p == photo) {
                        affected.push((photo, command == "remove_copy"));
                    }
                }
                Ok(id)
            });
        }
        if command == "forget" {
            for (photo, _) in &affected {
                let removed: Vec<_> = self
                    .real
                    .iter()
                    .filter(|(p, _)| p.path == photo.path)
                    .map(|(p, id)| (p.clone(), *id))
                    .collect();
                for (p, id) in removed {
                    self.real.remove(&p);
                    self.reverse.remove(&id);
                }
            }
            // Files are removed/relocated by their owning command; forget only
            // clears engine bindings and must not delete a transferred index row.
            affected.clear();
        } else if command == "remove_copy" {
            for (photo, _) in &affected {
                if let Some(id) = self.real.remove(photo) {
                    self.reverse.remove(&id);
                }
            }
        }
        affected
    }

    // Learn imported versions before rewriting their IDs, including siblings.
    pub fn reply(&mut self, reply: &mut Value) {
        self.learn(reply);
        self.translate(reply);
    }
    fn learn(&mut self, value: &Value) {
        match value {
            Value::Object(fields) => {
                if let (Some(path), Some(id)) = (
                    fields.get("path").and_then(Value::as_str),
                    fields.get("imgid").and_then(Value::as_i64),
                ) {
                    if id > 0 && id < FIRST_HANDLE {
                        let photo = Photo {
                            path: path.into(),
                            version: fields.get("version").and_then(Value::as_i64).unwrap_or(0),
                        };
                        if let Some(old) = self.real.insert(photo.clone(), id) {
                            self.reverse.remove(&old);
                        }
                        if let Some(handle) = self.by_photo.get(&photo) {
                            self.reverse.insert(id, *handle);
                        }
                    }
                }
                for child in fields.values() {
                    self.learn(child);
                }
            }
            Value::Array(children) => {
                for child in children {
                    self.learn(child);
                }
            }
            _ => {}
        }
    }
    fn translate(&self, value: &mut Value) {
        match value {
            Value::Object(fields) => {
                for (key, child) in fields {
                    if key == "imgid" {
                        if let Some(handle) = child.as_i64().and_then(|id| self.reverse.get(&id)) {
                            *child = json!(handle);
                        }
                    } else if key == "imgids" {
                        if let Some(ids) = child.as_array_mut() {
                            for id in ids {
                                if let Some(handle) =
                                    id.as_i64().and_then(|id| self.reverse.get(&id))
                                {
                                    *id = json!(handle);
                                }
                            }
                        }
                    } else {
                        self.translate(child);
                    }
                }
            }
            Value::Array(children) => {
                for child in children {
                    self.translate(child);
                }
            }
            _ => {}
        }
    }
}
/// Rewrites only image identity fields, never request/render/job numbers.
pub fn request_ids(
    value: &mut Value,
    resolve: &mut impl FnMut(i64) -> Result<i64, String>,
) -> Result<(), String> {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                if key == "imgid" {
                    if let Some(id) = child.as_i64() {
                        *child = json!(resolve(id)?);
                    }
                } else if key == "imgids" {
                    if let Some(ids) = child.as_array_mut() {
                        for id in ids {
                            if let Some(n) = id.as_i64() {
                                *id = json!(resolve(n)?);
                            }
                        }
                    }
                } else {
                    request_ids(child, resolve)?;
                }
            }
        }
        Value::Array(children) => {
            for child in children {
                request_ids(child, resolve)?;
            }
        }
        _ => {}
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn forgetting_a_folder_clears_engine_ids_for_every_version() {
        let mut ids = LibraryIds::default();
        let path = "/library/month/nested/photo.jpg";
        let sibling = "/library/month-old/photo.jpg";
        let handles: Vec<_> = (0..=5).map(|version| ids.advertise(path, version)).collect();
        for version in 0..=5 {
            ids.reply(&mut json!({"path":path,"version":version,"imgid":version + 1}));
        }
        ids.reply(&mut json!({"path":sibling,"version":0,"imgid":7}));
        ids.changed(&json!({"cmd":"open","path":path,"imgid":1}), &json!({"imgid":1}));
        ids.changed(&json!({"cmd":"forget_folder","path":"/library/month"}), &json!({}));
        for id in handles {
            let photo = ids.photo(id).unwrap().unwrap();
            assert_eq!(ids.resolved(&photo), None);
        }
        assert_eq!(ids.advertise(sibling, 0), 7);
        assert_eq!(ids.active_photo(), None);
    }

    #[test]
    fn mutations_target_exact_versions_and_forget_does_not_remove_moved_cache_rows() {
        let mut ids = LibraryIds::default();
        let a = ids.advertise("/a", 0);
        let b = ids.advertise("/a", 2);
        ids.reply(&mut json!({"images":[{"imgid":1,"path":"/a","version":0},{"imgid":2,"path":"/a","version":2}]}));
        assert_eq!(
            ids.changed(&json!({"cmd":"keywords_set","imgid":b}), &json!({})),
            vec![(
                Photo {
                    path: "/a".into(),
                    version: 2
                },
                false
            )]
        );
        ids.changed(
            &json!({"cmd":"open","path":"/a","imgid":b}),
            &json!({"imgid":b}),
        );
        assert_eq!(
            ids.changed(&json!({"cmd":"save"}), &json!({})),
            vec![(
                Photo {
                    path: "/a".into(),
                    version: 2
                },
                false
            )]
        );
        assert_eq!(
            ids.changed(&json!({"cmd":"remove_copy","imgid":b}), &json!({})),
            vec![(
                Photo {
                    path: "/a".into(),
                    version: 2
                },
                true
            )]
        );
        assert_eq!(ids.resolved(&ids.photo(b).unwrap().unwrap()), None);
        assert!(ids
            .changed(&json!({"cmd":"forget","imgid":a}), &json!({}))
            .is_empty());
        assert_eq!(ids.resolved(&ids.photo(a).unwrap().unwrap()), None);
    }

    #[test]
    fn cached_handles_resolve_exact_versions_and_roundtrip_nested_replies() {
        let mut ids = LibraryIds::default();
        let a = ids.advertise("/a.raw", 0);
        let b = ids.advertise("/a.raw", 2);
        assert_ne!(a, b);
        assert_eq!(a, ids.advertise("/a.raw", 0));
        let photo = ids.photo(b).unwrap().unwrap();
        assert_eq!(ids.resolved(&photo), None);
        let mut reply = json!({"images":[{"path":"/a.raw","version":0,"imgid":17},{"path":"/a.raw","version":2,"imgid":19}],"imgids":[17,19],"rid":17});
        ids.reply(&mut reply);
        assert_eq!(reply["images"][0]["imgid"], a);
        assert_eq!(reply["images"][1]["imgid"], b);
        assert_eq!(reply["imgids"], json!([a, b]));
        assert_eq!(reply["rid"], 17);
        assert_eq!(ids.resolved(&photo), Some(19));
        let mut req = json!({"cmd":"capture_times","entries":[{"imgid":b}],"imgids":[a,b],"id":a,"job":b,"rid":a});
        request_ids(&mut req, &mut |id| {
            Ok(ids.photo(id)?.and_then(|p| ids.resolved(&p)).unwrap_or(id))
        })
        .unwrap();
        assert_eq!(req["entries"][0]["imgid"], 19);
        assert_eq!(req["imgids"], json!([17, 19]));
        assert_eq!(req["id"], a);
        assert_eq!(req["job"], b);
        assert_eq!(req["rid"], a);
    }
    #[test]
    fn cold_ids_stay_unchanged_and_restart_keeps_handles_but_not_engine_ids() {
        let mut ids = LibraryIds::default();
        ids.reply(&mut json!({"image":{"path":"/cold","version":0,"imgid":5}}));
        assert_eq!(ids.advertise("/cold", 0), 5);
        let handle = ids.advertise("/warm", 3);
        let photo = ids.photo(handle).unwrap().unwrap();
        ids.reply(&mut json!({"image":{"path":"/warm","version":3,"imgid":7}}));
        assert_eq!(ids.resolved(&photo), Some(7));
        ids.restart();
        assert_eq!(ids.advertise("/warm", 3), handle);
        assert_eq!(ids.resolved(&photo), None);
        ids.reply(&mut json!({"image":{"path":"/warm","version":3,"imgid":42}}));
        assert_eq!(ids.resolved(&photo), Some(42));
        assert!(ids.photo(FIRST_HANDLE + 999).is_err());
        assert!(Arc::ptr_eq(&ids.gate("/warm"), &ids.gate("/warm")));
    }
}
