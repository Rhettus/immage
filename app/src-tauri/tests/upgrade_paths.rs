// SPDX-License-Identifier: GPL-3.0-or-later
// Files an older Immage left on disk must still be found and read by this
// one. Anything that silently changes how they are named or read orphans the
// user's caches (a slow first open of every folder) or drops their data.
//
// The folder snapshot functions live in library_cmds.rs, which needs the
// whole Tauri app, so they cannot be called from here: the naming is checked
// against the algorithm v0.40.0 shipped (golden names below) and the current
// function text is compared with the v0.40.0 text kept in
// verify/fixtures/upgrade. The thumbnail cache (cache.rs) is compiled in
// directly and run on a cache laid out as v0.40.0 wrote it.
#![allow(dead_code)]

#[path = "../src/cache.rs"]
mod cache;
#[path = "../src/listing.rs"]
mod listing;

// typed_export.rs needs only LibraryImage from the rest of the app
mod typed_library {
    #[derive(serde::Serialize, serde::Deserialize, specta::Type)]
    pub struct LibraryImage {}
}
#[path = "../src/typed_export.rs"]
mod typed_export;

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn scratch(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("immage-upgrade-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

// the text of `fn name` up to its closing brace at column 0, without whitespace
fn function(src: &str, name: &str) -> String {
    let start = src.find(&format!("fn {name}(")).unwrap_or_else(|| panic!("fn {name} is gone"));
    let rest = &src[start..];
    let end = rest.find("\n}\n").expect("function end") + 3;
    rest[..end].split_whitespace().collect()
}

#[test]
fn snapshot_naming_and_reading_are_unchanged_since_v0_40_0() {
    let old = std::fs::read_to_string(repo().join("verify/fixtures/upgrade/snapshot_path-v0.40.0.rs.txt")).unwrap();
    let now = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/library_cmds.rs")).unwrap();
    for name in ["snapshot_path", "read_snapshot"] {
        assert_eq!(function(&old, name), function(&now, name),
                   "{name} changed: existing folder snapshots would no longer be found or read; migrate them, or update the fixture on purpose");
    }
}

#[test]
fn snapshot_golden_names() {
    // what v0.40.0's snapshot_path() made of these folders: "{dir}\0{recursive}\0{skip sorted, \0-joined}"
    assert_eq!(hex("/photos/2024\0false\0"), "7fcd28192cee38fc6639b25c3e58e3ca44edbeec91694c58da3740f1916a1587");
    assert_eq!(hex("/photos/2024\0true\0/photos/2024/a\0/photos/2024/b"),
               "c1a8ca52508421d32e0f8e3be493269e533be64bb42aa27633739a917574c7ea");
}

#[test]
fn a_v0_40_0_snapshot_is_a_plain_array_of_images_that_is_kept_whole() {
    let text = std::fs::read_to_string(repo().join("verify/fixtures/upgrade/snapshots/folder-v0.40.0.json")).unwrap();
    let list: serde_json::Value = serde_json::from_slice(text.as_bytes()).unwrap();
    // read_snapshot() hands back any JSON array untouched, so entries from before
    // later fields (imgid, body_serial, version, keywords) lose nothing
    assert!(list.is_array());
    assert_eq!(list.as_array().unwrap().len(), 3);
    assert_eq!(list[2]["exif"]["file_datetime"], "2023:11:11 09:00:00");
    assert!(list[0].get("imgid").is_none() && list[0]["exif"].get("body_serial").is_none());
}

#[test]
fn the_v0_40_0_thumbnail_names_are_still_the_current_names() {
    // known_name(): sha256 of "{path}\0{version}\0{size}" + ".last"
    let photo = Path::new("/photos/2024/IMG_0001.CR3");
    assert_eq!(cache::known_name(photo, 0, 240),
               "6e188f8a2fe1a248a4102dfd485672051bc3db0845ee5ec64214feda36c53e2e.last");
    assert_eq!(cache::known_name(photo, 2, 240), format!("{}.last", hex("/photos/2024/IMG_0001.CR3\02\0240")));
}

#[test]
fn a_thumbnail_cache_from_v0_40_0_is_found_and_read() {
    let dir = scratch("thumbs");
    let photos = dir.join("photos");
    std::fs::create_dir_all(&photos).unwrap();
    let photo = photos.join("IMG_0001.CR3");
    std::fs::write(&photo, b"raw bytes").unwrap();
    // v0.40.0 named a thumbnail by the photo's path, version, its size and modified
    // time in nanoseconds, its sidecar's stamp ("-" for none) and the thumbnail size
    let nanos = 1_700_000_000u128 * 1_000_000_000 + 123;
    std::fs::OpenOptions::new().write(true).open(&photo).unwrap()
        .set_modified(UNIX_EPOCH + Duration::new(1_700_000_000, 123)).unwrap();
    let old_name = format!("{}.jpg", hex(&format!("{}\00\0{}:{}\0-\0240", photo.to_string_lossy(), 9, nanos)));
    let cache_dir = dir.join("thumbs");
    std::fs::create_dir_all(&cache_dir).unwrap();
    let thumbs = cache::DiskCache::new(cache_dir.clone(), 1 << 20, false);
    let jpeg = cache::encode_jpeg(&[200, 100, 50, 255].repeat(16 * 8), 16, 8).unwrap();
    // the layout as the old version left it: the jpg, and the .last pointer to it
    std::fs::write(cache_dir.join(&old_name), &jpeg).unwrap();
    std::fs::write(cache_dir.join(cache::known_name(&photo, 0, 240)), old_name.as_bytes()).unwrap();

    let listed = Mutex::new(cache::Listed::default());
    assert_eq!(cache::refresh(&listed, &photo, 0, 240).as_deref(), Some(old_name.as_str()),
               "a thumbnail name no longer matches the one the old cache holds");
    assert_eq!(cache::listed_thumb_name(&listed, &photo, 0, 240).as_deref(), Some(old_name.as_str()));
    assert_eq!(thumbs.read(&old_name).as_deref(), Some(&jpeg[..]));
    assert_eq!(thumbs.read_known(&photo, 0, 240).as_deref(), Some(&jpeg[..]));
    // another size or version is another entry, not the old one
    assert_ne!(cache::refresh(&listed, &photo, 0, 480).as_deref(), Some(old_name.as_str()));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_v0_40_0_cache_without_pointers_learns_them_as_it_is_read() {
    let dir = scratch("nolast");
    let photo = dir.join("A.jpg");
    std::fs::write(&photo, b"jpeg").unwrap();
    let thumbs = cache::DiskCache::new(dir.join("thumbs"), 1 << 20, false);
    let listed = Mutex::new(cache::Listed::default());
    let name = cache::refresh(&listed, &photo, 0, 240).unwrap();
    thumbs.write(&name, b"thumb").unwrap();
    assert!(thumbs.read_known(&photo, 0, 240).is_none());
    thumbs.set_known(&photo, 0, 240, &name);
    assert_eq!(thumbs.read_known(&photo, 0, 240).as_deref(), Some(&b"thumb"[..]));
    let _ = std::fs::remove_dir_all(&dir);
}

fn fixture(name: &str) -> String {
    std::fs::read_to_string(repo().join("verify/fixtures/upgrade").join(name)).unwrap()
}

#[test]
fn presets_json_of_every_version_loads_as_presets_doc_without_loss() {
    use typed_export::PresetsDoc;
    // presets_load() is serde_json::from_str::<PresetsDoc>: version 1 was a bare list
    match serde_json::from_str::<PresetsDoc>(&fixture("presets-v1-bare-list.json")).unwrap() {
        PresetsDoc::List(l) => {
            assert_eq!(l.len(), 3);
            assert_eq!(l[0]["values"]["blacks"], -40);
            assert_eq!(l[1]["rawOnly"], true);
        }
        PresetsDoc::File(_) => panic!("a bare list was read as a versioned file"),
    }
    for (name, version, count) in [("presets-v2.json", 2, 2), ("presets-v3-current.json", 3, 2), ("presets-future.json", 99, 1)] {
        match serde_json::from_str::<PresetsDoc>(&fixture(name)).unwrap() {
            PresetsDoc::File(f) => {
                assert_eq!(f.version.as_i64(), Some(version), "{name}");
                assert_eq!(f.presets.len(), count, "{name}");
            }
            PresetsDoc::List(_) => panic!("{name} was read as a bare list"),
        }
    }
    // and what is saved again keeps every field of every preset
    let file = match serde_json::from_str::<PresetsDoc>(&fixture("presets-v2.json")).unwrap() { PresetsDoc::File(f) => f, _ => unreachable!() };
    let again: serde_json::Value = serde_json::from_str(&serde_json::to_string_pretty(&file).unwrap()).unwrap();
    assert_eq!(again, serde_json::from_str::<serde_json::Value>(&fixture("presets-v2.json")).unwrap());
}

#[test]
fn export_presets_v0_31_load_as_a_presets_file_without_loss() {
    // export_presets_load() reads the file as a PresetsFile and returns it
    let text = fixture("export-presets-v0.31.json");
    let f: typed_export::PresetsFile = serde_json::from_str(&text).unwrap();
    assert_eq!(f.version.as_i64(), Some(1));
    assert_eq!(f.presets.len(), 2);
    assert_eq!(f.presets[1]["icon"], "star");
    assert_eq!(f.presets[1]["settings"]["dir"], "/home/me/Exports");
    assert_eq!(serde_json::to_value(&f).unwrap(), serde_json::from_str::<serde_json::Value>(&text).unwrap());
}
