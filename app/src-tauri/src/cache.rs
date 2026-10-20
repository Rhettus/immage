// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// what Immage keeps on disk to show again quickly: library thumbnails,
// Immich's thumbnails and the Immich originals opened here. each folder has
// a size limit of its own, so one big download does not flush every
// thumbnail; over it, the entries read least recently go. reading an entry
// touches its time and nothing else does, so a folder opened every day
// stays however long ago it was first cached

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MB: u64 = 1024 * 1024;
const GB: u64 = 1024 * MB;
// below this much free space a thumbnail is not written, whatever the limit
const MIN_FREE: u64 = 5 * GB;

pub struct DiskCache {
    dir: PathBuf,
    limit: AtomicU64,
    // the folder's size: counted from the disk at first use, then kept as
    // entries are added, and counted again at each eviction
    used: Mutex<Option<u64>>,
    // thumbnails are skipped on a nearly full disk; an original is still
    // needed to open the photo, so is written regardless
    guard_space: bool,
    space: Mutex<Option<(Instant, bool)>>,
}

// one entry: a file, or a folder of them (an original and its sidecar),
// with the newest time of any file in it
struct Entry {
    path: PathBuf,
    size: u64,
    time: SystemTime,
    // a sidecar holds the user's edit of a downloaded original: never evicted
    keep: bool,
}

impl DiskCache {
    pub fn new(dir: PathBuf, limit: u64, guard_space: bool) -> Arc<Self> {
        Arc::new(Self { dir, limit: AtomicU64::new(limit), used: Mutex::new(None), guard_space,
                        space: Mutex::new(None) })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        let ok = !name.is_empty() && !name.starts_with('.')
            && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
        ok.then(|| self.dir.join(name))
    }

    pub fn read(&self, name: &str) -> Option<Vec<u8>> {
        let path = self.path(name)?;
        let bytes = std::fs::read(&path).ok()?;
        touch(&path);
        Some(bytes)
    }

    // the entry was read: its time moves to now
    pub fn touch(&self, name: &str) {
        if let Some(path) = self.path(name) {
            if path.is_dir() {
                // a folder's own time does not change on every system, so a
                // marker inside it carries the time
                let _ = std::fs::write(path.join(".used"), b"");
            } else {
                touch(&path);
            }
        }
    }

    // written beside and renamed, so a reader never finds half a file
    pub fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.path(name).ok_or_else(|| format!("cache: bad name {name}"))?;
        if self.guard_space && !self.space_free() {
            return Err("cache: the disk is nearly full".into());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let part = self.dir.join(format!(".{name}.part"));
        std::fs::write(&part, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&part, &path).map_err(|e| {
            let _ = std::fs::remove_file(&part);
            e.to_string()
        })?;
        self.added(name);
        Ok(())
    }

    // an entry just put in the folder (by write(), or a download made into
    // it directly): counted, and the limit kept
    pub fn added(&self, name: &str) {
        let Some(path) = self.path(name) else { return };
        let mut used = self.used.lock().unwrap();
        let total = match *used {
            Some(n) => n + entry(&path).map_or(0, |e| e.size),
            None => scan(&self.dir).iter().map(|e| e.size).sum(),
        };
        *used = Some(total);
        if total > self.limit.load(Ordering::Relaxed) {
            self.evict(&mut used, Some(&path));
        }
    }

    // down to nine tenths of the limit, so the next few writes do not each
    // count the folder again
    fn evict(&self, used: &mut Option<u64>, spare: Option<&Path>) {
        let target = self.limit.load(Ordering::Relaxed) / 10 * 9;
        let mut list = scan(&self.dir);
        let mut total: u64 = list.iter().map(|e| e.size).sum();
        list.retain(|e| !e.keep && Some(e.path.as_path()) != spare);
        list.sort_by_key(|e| e.time);
        for e in list {
            if total <= target {
                break;
            }
            if remove(&e.path).is_ok() {
                total -= e.size;
            }
        }
        *used = Some(total);
    }

    pub fn set_limit(&self, limit: u64) {
        self.limit.store(limit, Ordering::Relaxed);
        let mut used = self.used.lock().unwrap();
        let total = used.unwrap_or_else(|| scan(&self.dir).iter().map(|e| e.size).sum());
        if total > limit {
            self.evict(&mut used, None);
        } else {
            *used = Some(total);
        }
    }

    pub fn usage(&self) -> u64 {
        let mut used = self.used.lock().unwrap();
        let total = scan(&self.dir).iter().map(|e| e.size).sum();
        *used = Some(total);
        total
    }

    // everything but edited originals
    pub fn clear(&self) {
        let mut used = self.used.lock().unwrap();
        let mut total = 0;
        for e in scan(&self.dir) {
            if e.keep || remove(&e.path).is_err() {
                total += e.size;
            }
        }
        *used = Some(total);
    }

    // whether the disk has room to spare; asked of the system at most once
    // a minute, as listing the disks is not free
    fn space_free(&self) -> bool {
        let mut space = self.space.lock().unwrap();
        if let Some((at, ok)) = *space {
            if at.elapsed() < Duration::from_secs(60) {
                return ok;
            }
        }
        let ok = free_space(&self.dir).is_none_or(|n| n >= MIN_FREE);
        *space = Some((Instant::now(), ok));
        ok
    }
}

fn touch(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}

fn remove(path: &Path) -> std::io::Result<()> {
    if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) }
}

fn entry(path: &Path) -> Option<Entry> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_file() {
        return Some(Entry { path: path.into(), size: meta.len(), time: meta.modified().ok()?, keep: false });
    }
    let mut e = Entry { path: path.into(), size: 0, time: UNIX_EPOCH, keep: false };
    for f in std::fs::read_dir(path).ok()?.flatten() {
        let Ok(m) = f.metadata() else { continue };
        if !m.is_file() {
            continue;
        }
        e.size += m.len();
        e.time = e.time.max(m.modified().unwrap_or(UNIX_EPOCH));
        e.keep |= f.file_name().to_string_lossy().to_lowercase().ends_with(".xmp");
    }
    Some(e)
}

// the folder's entries; dot files are writes in progress and markers
fn scan(dir: &Path) -> Vec<Entry> {
    let Ok(list) = std::fs::read_dir(dir) else { return Vec::new() };
    list.flatten()
        .filter(|f| !f.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|f| entry(&f.path()))
        .collect()
}

// the free space of the disk holding the folder, or None when no disk
// listed holds it
fn free_space(dir: &Path) -> Option<u64> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks.list().iter()
        .filter(|d| dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len())
        .map(|d| d.available_space())
}

// darktable's sidecar for a version of a photo: IMG_1.CR3.xmp, and for
// version 2 IMG_1_02.CR3.xmp (dt_image_path_append_version_no_db())
fn sidecar(photo: &Path, version: i64) -> PathBuf {
    let mut s = photo.as_os_str().to_os_string();
    if version > 0 {
        let name = photo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let (stem, ext) = name.rsplit_once('.').map_or((name.as_str(), ""), |(a, b)| (a, b));
        let named = if ext.is_empty() { format!("{stem}_{version:02}") } else { format!("{stem}_{version:02}.{ext}") };
        s = photo.with_file_name(named).into_os_string();
    }
    s.push(".xmp");
    PathBuf::from(s)
}

fn stamp(meta: &std::fs::Metadata) -> String {
    let t = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    format!("{}:{t}", meta.len())
}

// a library thumbnail's name in the cache: the photo's path, size and
// time, its sidecar's (so an edit, here or in darktable, makes a new one)
// and the size asked for. None when the photo is not there
pub fn thumb_name(photo: &Path, version: i64, size: u32) -> Option<String> {
    let meta = std::fs::metadata(photo).ok()?;
    let side = std::fs::metadata(sidecar(photo, version)).map_or_else(|_| "-".into(), |m| stamp(&m));
    let mut h = Sha256::new();
    h.update(photo.to_string_lossy().as_bytes());
    h.update(format!("\0{version}\0{}\0{side}\0{size}", stamp(&meta)));
    Some(format!("{}.jpg", h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>()))
}

// a thumbnail as stored: JPEG from the engine's RGBA
pub fn encode_jpeg(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let rgb: Vec<u8> = rgba.as_chunks::<4>().0.iter().flat_map(|p| [p[0], p[1], p[2]]).collect();
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode(&rgb, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

pub struct Caches {
    pub thumbs: Arc<DiskCache>,
    pub immich_thumbs: Arc<DiskCache>,
    pub immich_originals: Arc<DiskCache>,
}

// the limits until Preferences sends its own, the same as its defaults
pub const DEFAULT_LIMITS: Limits = Limits { thumbs: GB, immich_thumbs: 512 * MB, immich_originals: 10 * GB };

#[derive(Clone, Copy, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub thumbs: u64,
    pub immich_thumbs: u64,
    pub immich_originals: u64,
}

impl Caches {
    pub fn new(root: &Path) -> Self {
        let l = DEFAULT_LIMITS;
        Self {
            thumbs: DiskCache::new(root.join("thumbs"), l.thumbs, true),
            immich_thumbs: DiskCache::new(root.join("immich-thumbs"), l.immich_thumbs, true),
            immich_originals: DiskCache::new(root.join("immich-originals"), l.immich_originals, false),
        }
    }

    pub fn by_name(&self, which: &str) -> Option<&Arc<DiskCache>> {
        match which {
            "thumbs" => Some(&self.thumbs),
            "immichThumbs" => Some(&self.immich_thumbs),
            "immichOriginals" => Some(&self.immich_originals),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("immage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn age(path: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    #[test]
    fn least_recently_read_goes_first() {
        let dir = test_dir("cache-lru");
        let c = DiskCache::new(dir.clone(), 1000, false);
        for (n, a) in [("a", 300), ("b", 200), ("c", 100)] {
            c.write(n, &[0; 300]).unwrap();
            age(&dir.join(n), a);
        }
        // a is the oldest written, but read since
        assert!(c.read("a").is_some());
        c.write("d", &[0; 300]).unwrap();
        // 1200 over 1000: b goes, leaving 900, within nine tenths
        assert!(dir.join("a").exists() && !dir.join("b").exists());
        assert!(dir.join("c").exists() && dir.join("d").exists());
        assert_eq!(c.usage(), 900);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn edited_originals_stay() {
        let dir = test_dir("cache-originals");
        let c = DiskCache::new(dir.clone(), 1000, false);
        for (id, a, xmp) in [("x1", 300, true), ("x2", 200, false)] {
            std::fs::create_dir_all(dir.join(id)).unwrap();
            std::fs::write(dir.join(id).join("A.RAF"), [0; 400]).unwrap();
            age(&dir.join(id).join("A.RAF"), a);
            if xmp {
                std::fs::write(dir.join(id).join("A.RAF.xmp"), b"").unwrap();
                age(&dir.join(id).join("A.RAF.xmp"), a);
            }
            c.added(id);
        }
        std::fs::create_dir_all(dir.join("x3")).unwrap();
        std::fs::write(dir.join("x3").join("B.RAF"), [0; 400]).unwrap();
        c.added("x3");
        assert!(dir.join("x1").exists() && !dir.join("x2").exists() && dir.join("x3").exists());
        c.clear();
        assert!(dir.join("x1").exists() && !dir.join("x3").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_stay_in_the_folder() {
        let c = DiskCache::new(test_dir("cache-names"), 1000, false);
        assert!(c.write("../x", b"1").is_err());
        assert!(c.write(".hidden", b"1").is_err());
        assert!(c.read("a/b").is_none());
    }

    #[test]
    fn a_thumbnail_name_follows_the_sidecar() {
        let dir = test_dir("cache-key");
        std::fs::create_dir_all(&dir).unwrap();
        let photo = dir.join("IMG_1.CR3");
        std::fs::write(&photo, b"raw").unwrap();
        let bare = thumb_name(&photo, 0, 240).unwrap();
        assert_eq!(thumb_name(&photo, 0, 240).unwrap(), bare);
        assert_ne!(thumb_name(&photo, 0, 480).unwrap(), bare);
        assert_ne!(thumb_name(&photo, 1, 240).unwrap(), bare);
        std::fs::write(dir.join("IMG_1.CR3.xmp"), b"edit").unwrap();
        assert_ne!(thumb_name(&photo, 0, 240).unwrap(), bare);
        assert_eq!(sidecar(&photo, 2), dir.join("IMG_1_02.CR3.xmp"));
        assert!(thumb_name(&dir.join("gone.CR3"), 0, 240).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn jpeg_round_trip() {
        let jpeg = encode_jpeg(&[200, 100, 50, 255].repeat(16 * 8), 16, 8).unwrap();
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    }
}
