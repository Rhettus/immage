// moving and copying photos into a folder, from a thumbnail dropped on the
// Folders panel. each photo goes with its sidecars (every version's XMP and
// the .dtdata), as one unit: copied beside the destination name, flushed,
// read back and checked against the source's checksum, then renamed into
// place. a move removes the source only once the whole unit is verified, then
// drops the photo from the engine's library, as trash_files does. edits live
// in the sidecars (the library is in memory), so they arrive with the files.
// on the same drive a move is a rename and nothing is copied
//
// an Immich result is always a copy: the external library's own file when
// this computer has it (Immich still owns it), else the original downloaded
// and checked against the server's SHA-1

use crate::immich_search::{self, PathMap};
use crate::immich_upload;
use crate::volumes;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

// a destination that takes nothing for this long is given up on, as one
// that is not answering; the write that hangs is left to its thread
const STALL: Duration = Duration::from_secs(30);
const CHUNK: usize = 1 << 20;
const CANCELLED: &str = "cancelled";
const WORKER_LIMIT: usize = 8;

// A blocked filesystem call can outlive the job that gave up waiting for it.
// Keep its admission slot and names reserved until that actual thread exits.
static WORKERS: OnceLock<Mutex<usize>> = OnceLock::new();
static DESTINATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

struct WorkerPermit;

impl WorkerPermit {
    fn try_acquire() -> Option<Self> {
        let mut n = WORKERS
            .get_or_init(|| Mutex::new(0))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if *n >= WORKER_LIMIT {
            return None;
        }
        *n += 1;
        Some(Self)
    }
}

impl Drop for WorkerPermit {
    fn drop(&mut self) {
        let mut n = WORKERS
            .get_or_init(|| Mutex::new(0))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        *n = n.saturating_sub(1);
    }
}

struct DestinationReservation(Vec<String>);

fn reservation_key(path: &Path) -> String {
    // A NAS mounted on Linux can still be case-insensitive. Conservatively
    // serialize case variants even on case-sensitive disks; both names can
    // still be transferred there, in input order.
    text(path).to_lowercase()
}

fn reservation_path(path: &Path) -> PathBuf {
    // Resolve existing parent components even when a sidecar's subdirectory
    // has not been created yet. Different symlink spellings must share a lock.
    let mut ancestor = path;
    let mut tail = Vec::new();
    loop {
        if let Ok(mut resolved) = std::fs::canonicalize(ancestor) {
            for component in tail.iter().rev() { resolved.push(component); }
            return resolved;
        }
        let Some(name) = ancestor.file_name() else { return path.to_path_buf() };
        tail.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else { return path.to_path_buf() };
        ancestor = parent;
    }
}

impl DestinationReservation {
    // Atomically reserve all names. A conflict with a live transfer is treated
    // like a destination clash and can be resolved by Keep Both.
    fn try_new(dest: &Path, names: &[PathBuf], unit: &Unit) -> Option<Self> {
        let root = canonical(dest);
        let keys: Vec<PathBuf> = names
            .iter()
            .flat_map(|p| {
                let target = root.join(p);
                vec![target.clone(), part_of(&target)]
            })
            .collect();
        let mut keys: Vec<String> = keys.into_iter().map(|p| reservation_key(&reservation_path(&p))).collect();
        // Prevent concurrent move jobs from acting on one source unit.
        keys.extend(
            unit.files
                .iter()
                .filter_map(|f| f.from.as_ref())
                .map(|p| reservation_key(&reservation_path(p))),
        );
        let mut reserved = DESTINATIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if keys.iter().any(|p| reserved.contains(p)) {
            return None;
        }
        reserved.extend(keys.iter().cloned());
        Some(Self(keys))
    }
}

impl Drop for DestinationReservation {
    fn drop(&mut self) {
        let mut reserved = DESTINATIONS
            .get_or_init(|| Mutex::new(HashSet::new()))
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        for p in &self.0 {
            reserved.remove(p);
        }
    }
}

// a dropped thumbnail: a library photo by its id, or an Immich asset by its
// id and server path
#[derive(Deserialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveSource {
    #[serde(default)]
    pub imgid: Option<i64>,
    #[serde(default)]
    pub asset: Option<String>,
    #[serde(default)]
    pub asset_path: Option<String>,
}

#[derive(Deserialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveRequest {
    pub sources: Vec<MoveSource>,
    pub dest: String,
    #[serde(default)]
    pub map: Option<PathMap>,
}

// one photo as the confirmation shows it. clash: "none" (nothing there by
// its names), "same" (every file already there, identical), "different"
// (a file of the same name with other content), "here" (already in the
// destination folder)
#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct PlanUnit {
    pub key: String,
    pub name: String,
    pub imgids: Vec<i64>,
    pub versions: u32,
    pub files: u32,
    pub bytes: u64,
    pub clash: String,
    pub download: bool,
    pub keep_source: bool,
}

#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct MovePlan {
    pub dest: String,
    pub units: Vec<PlanUnit>,
    pub bytes: u64,
    pub free: Option<u64>,
    pub same_drive: bool,
    pub network: bool,
}

#[derive(Serialize, Clone, Type)]
pub struct MoveFailure {
    pub name: String,
    pub error: String,
}

#[derive(Serialize, Clone, Type)]
#[serde(rename_all = "camelCase")]
pub struct MoveSummary {
    pub dest: String,
    // the photos now in the destination, moved or copied
    pub done: Vec<String>,
    // the library photos whose source is gone, dropped from the library
    pub removed: Vec<i64>,
    pub skipped: Vec<String>,
    pub failed: Vec<MoveFailure>,
    pub warnings: Vec<String>,
    pub cancelled: bool,
}

#[derive(Clone, Debug)]
struct UnitFile {
    // none for an Immich download
    from: Option<PathBuf>,
    // where it goes, under the destination
    rel: PathBuf,
    size: u64,
}

#[derive(Clone, Debug)]
struct Unit {
    key: String,
    name: String,
    imgids: Vec<i64>,
    versions: u32,
    // the photo's file first, then its sidecars
    files: Vec<UnitFile>,
    // an Immich asset to download, and the server's base64 SHA-1 of it
    download: Option<(String, Option<String>)>,
    keep_source: bool,
    here: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Clash {
    None,
    Same,
    Different,
}

impl Clash {
    fn label(self) -> &'static str {
        match self {
            Clash::None => "none",
            Clash::Same => "same",
            Clash::Different => "different",
        }
    }
}

// what a copy reports to, and is stopped by
struct Ctx {
    cancel: Arc<AtomicBool>,
    job_cancel: Option<Arc<AtomicBool>>,
    bytes: AtomicU64,
    // every chunk read or written, checksums included: what the stall guard watches
    activity: AtomicU64,
    // tests corrupt the copy here, before it is read back
    before_verify: Option<fn(&Path)>,
}

impl Ctx {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
            || self.job_cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst))
    }

    fn new(cancel: Arc<AtomicBool>) -> Ctx {
        Ctx {
            cancel,
            job_cancel: None,
            bytes: AtomicU64::new(0),
            activity: AtomicU64::new(0),
            before_verify: None,
        }
    }
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn file_names(u: &Unit) -> Vec<PathBuf> {
    u.files.iter().map(|f| f.rel.clone()).collect()
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

// standard base64 with padding, as Immich gives its checksums
fn base64(d: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                s.push(A[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

struct Sums {
    sha256: String,
    sha1: String,
}

// a file's checksums, read in chunks so a cancel stops it
fn sums(path: &Path, ctx: Option<&Ctx>) -> Result<Sums, String> {
    let mut f = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let (mut a, mut b) = (Sha256::new(), <sha1::Sha1 as sha1::Digest>::new());
    let mut buf = vec![0u8; CHUNK];
    loop {
        if let Some(c) = ctx {
            if c.cancelled() {
                return Err(CANCELLED.into());
            }
            c.activity.fetch_add(1, Ordering::SeqCst);
        }
        let n = f.read(&mut buf).map_err(|e| format!("{}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        a.update(&buf[..n]);
        sha1::Digest::update(&mut b, &buf[..n]);
    }
    Ok(Sums { sha256: hex(&a.finalize()), sha1: base64(&sha1::Digest::finalize(b)) })
}

// whether two files hold the same bytes
fn identical(a: &Path, b: &Path, ctx: Option<&Ctx>) -> bool {
    let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) else { return false };
    ma.len() == mb.len()
        && matches!((sums(a, ctx), sums(b, ctx)), (Ok(x), Ok(y)) if x.sha256 == y.sha256)
}

// what is at the destination by a unit's names
fn clash(u: &Unit, dest: &Path, rel: &[PathBuf], ctx: Option<&Ctx>) -> (Clash, Vec<bool>) {
    let mut there = Vec::new();
    let mut any = false;
    let mut differs = false;
    for (f, r) in u.files.iter().zip(rel) {
        let target = dest.join(r);
        let exists = target.symlink_metadata().is_ok();
        let same = exists && match (&f.from, &u.download) {
            (Some(from), _) => identical(from, &target, ctx),
            (None, Some((_, Some(sum)))) => std::fs::metadata(&target).map(|m| m.len() == f.size).unwrap_or(false)
                && sums(&target, ctx).map(|s| &s.sha1 == sum).unwrap_or(false),
            _ => false,
        };
        any |= exists;
        differs |= exists && !same;
        there.push(same);
    }
    let c = if differs {
        Clash::Different
    } else if any && there.iter().all(|t| *t) {
        Clash::Same
    } else {
        Clash::None
    };
    (c, there)
}

// a unit's destination names, with its stem numbered for Keep Both: the
// photo IMG.CR3 becomes IMG_1.CR3, its sidecars IMG_1.CR3.xmp and
// IMG_1_01.CR3.xmp, which darktable reads as versions 0 and 1 of it (a
// version takes two digits or more, so _1 is not one)
fn renamed(u: &Unit, n: u32) -> Vec<PathBuf> {
    let first = u.files[0].rel.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    let stem = match first.rfind('.') {
        Some(i) if i > 0 => first[..i].to_string(),
        _ => first.clone(),
    };
    u.files.iter().map(|f| {
        if n == 0 {
            return f.rel.clone();
        }
        let name = f.rel.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
        let new = match name.strip_prefix(&stem) {
            Some(rest) => format!("{stem}_{n}{rest}"),
            None => name,
        };
        f.rel.with_file_name(new)
    }).collect()
}

// the first numbering whose names are all free
#[cfg(test)]
fn numbered(u: &Unit, dest: &Path) -> Vec<PathBuf> {
    (1..10_000).map(|n| renamed(u, n))
        .find(|names| names.iter().all(|r| dest.join(r).symlink_metadata().is_err()))
        .unwrap_or_else(|| renamed(u, 10_000))
}

#[cfg(unix)]
fn free_space(p: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut s) } != 0 {
        return None;
    }
    Some(s.f_bavail as u64 * s.f_frsize as u64)
}

#[cfg(windows)]
fn free_space(p: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut free = 0u64;
    unsafe { GetDiskFreeSpaceExW(&HSTRING::from(p.as_os_str()), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

#[cfg(unix)]
fn same_drive(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!((std::fs::metadata(a), std::fs::metadata(b)), (Ok(x), Ok(y)) if x.dev() == y.dev())
}

#[cfg(windows)]
fn same_drive(a: &Path, b: &Path) -> bool {
    volumes::volume(&text(a)).mount.eq_ignore_ascii_case(&volumes::volume(&text(b)).mount)
}

// the folder's own name, case and links resolved, to tell a photo already there
fn canonical(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

// whether two names are one file. the inode with the modification time,
// not the device: two mounts of one share have different devices but the
// server's file ids. identical bytes were checked first, so a match here
// that is really two files only keeps a source a move would have removed
#[cfg(unix)]
fn same_file(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    matches!((std::fs::metadata(a), std::fs::metadata(b)),
        (Ok(x), Ok(y)) if x.ino() == y.ino() && x.mtime() == y.mtime() && x.mtime_nsec() == y.mtime_nsec())
}

#[cfg(not(unix))]
fn same_file(_a: &Path, _b: &Path) -> bool {
    false
}

static MARKER: AtomicU64 = AtomicU64::new(0);

// whether folder `b` shows folder `a`'s contents: a file made in `a` is
// looked for in `b`. sees through what neither canonicalize nor the inode
// does (a share mounted twice through different clients, a case-folded
// name). a marker that cannot be made answers yes, so nothing is removed
fn same_folder(a: &Path, b: &Path) -> bool {
    if canonical(a) == canonical(b) {
        return true;
    }
    let name = format!(".immage-alias-{}-{}", std::process::id(), MARKER.fetch_add(1, Ordering::SeqCst));
    let marker = a.join(&name);
    if std::fs::OpenOptions::new().write(true).create_new(true).open(&marker).is_err() {
        return true;
    }
    let seen = b.join(&name).symlink_metadata().is_ok();
    let _ = std::fs::remove_file(&marker);
    seen
}

// whether any file a move found already at the destination (`there`) is
// its own source under another name: a link to it, the same file through a
// bind mount or case-folded name, or a folder that is the source folder
// mounted again. removing the sources then deletes the only copy
fn aliased(u: &Unit, dest: &Path, rel: &[PathBuf], there: &[bool]) -> bool {
    let mut folders: Vec<(PathBuf, PathBuf)> = Vec::new();
    for ((f, r), t) in u.files.iter().zip(rel).zip(there) {
        let Some(from) = &f.from else { continue };
        if !*t {
            continue;
        }
        let target = dest.join(r);
        if target.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(true) || same_file(from, &target) {
            return true;
        }
        let pair = (from.parent().unwrap_or(Path::new("")).to_path_buf(), target.parent().unwrap_or(dest).to_path_buf());
        if !folders.contains(&pair) {
            folders.push(pair);
        }
    }
    folders.iter().any(|(a, b)| same_folder(a, b))
}

// a sidecar's place under the destination: beside the photo, or in the
// same subfolder it had beside it
fn relative(sidecar: &Path, dir: &Path) -> PathBuf {
    sidecar.strip_prefix(dir).map(Path::to_path_buf)
        .unwrap_or_else(|_| PathBuf::from(sidecar.file_name().unwrap_or_default()))
}

fn local_unit(path: &Path, imgids: Vec<i64>, sidecars: Vec<PathBuf>, dest: &Path, keep_source: bool) -> Unit {
    let dir = path.parent().unwrap_or(Path::new("")).to_path_buf();
    let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let mut files = vec![UnitFile { from: Some(path.to_path_buf()), rel: relative(path, &dir), size: size(path) }];
    let mut seen = std::collections::HashSet::new();
    for s in sidecars {
        if s.is_file() && seen.insert(s.clone()) {
            files.push(UnitFile { rel: relative(&s, &dir), size: size(&s), from: Some(s) });
        }
    }
    let versions = files.iter().filter(|f| f.rel.extension().is_some_and(|e| e.eq_ignore_ascii_case("xmp"))).count()
        .max(imgids.len()).max(1) as u32;
    Unit {
        key: text(path),
        name: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
        imgids,
        versions,
        files,
        download: None,
        keep_source,
        here: canonical(&dir) == canonical(dest),
    }
}

// an Immich file's sidecar on this computer: name.ext.xmp beside it
fn mapped_sidecars(p: &Path) -> Vec<PathBuf> {
    let mut x = p.as_os_str().to_owned();
    x.push(".xmp");
    let x = PathBuf::from(x);
    if x.is_file() { vec![x] } else { Vec::new() }
}

fn immich_client(app: &AppHandle) -> Result<immich_upload::Immich, String> {
    let conn = tauri_plugin_immporter::immich_connection(app)
        .ok_or("Immich is not set up: add its URL and API key in Preferences")?;
    immich_upload::Immich::new(&conn)
}

// the units to move, from the engine's say of where each photo is: the
// page names photos, never files
async fn units(app: &AppHandle, state: &State<'_, AppState>, req: &MoveRequest) -> Result<Vec<Unit>, String> {
    let dest = PathBuf::from(&req.dest);
    let mut by_path: Vec<(PathBuf, Vec<i64>)> = Vec::new();
    let mut out = Vec::new();
    let mut assets = Vec::new();
    for s in &req.sources {
        if let Some(id) = s.imgid.filter(|i| *i > 0) {
            let reply = state.engine("move_plan").request(json!({ "cmd": "meta", "imgid": id }))?;
            let path = reply["image"]["path"].as_str().unwrap_or_default();
            if path.is_empty() {
                continue;
            }
            let path = PathBuf::from(path);
            match by_path.iter_mut().find(|(p, _)| *p == path) {
                Some((_, ids)) => ids.push(id),
                None => by_path.push((path, vec![id])),
            }
        } else if let Some(a) = &s.asset {
            assets.push((a.clone(), s.asset_path.clone().unwrap_or_default()));
        }
    }
    for (path, ids) in by_path {
        let reply = state.engine("move_plan").request(json!({ "cmd": "sidecars", "imgid": ids[0] }))?;
        let sidecars = reply["files"].as_array().into_iter().flatten().filter_map(|f| f.as_str()).map(PathBuf::from).collect();
        out.push(local_unit(&path, ids, sidecars, &dest, false));
    }
    if assets.is_empty() {
        return Ok(out);
    }
    let map = req.map.clone().unwrap_or_default();
    let app = app.clone();
    let remote = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Unit>, String> {
        let mut client = None;
        let mut v = Vec::new();
        for (id, server) in assets {
            if let Some(p) = immich_search::local_path(&server, &map) {
                let sidecars = mapped_sidecars(&p);
                let mut u = local_unit(&p, Vec::new(), sidecars, &dest, true);
                u.key = format!("immich:{id}");
                v.push(u);
                continue;
            }
            if client.is_none() {
                client = Some(immich_client(&app)?);
            }
            let info = client.as_ref().unwrap().original_info(&id)?;
            let name = Path::new(&info.name).file_name().and_then(|n| n.to_str())
                .filter(|n| !n.is_empty()).ok_or("Immich original has no file name")?.to_string();
            v.push(Unit {
                key: format!("immich:{id}"),
                name: name.clone(),
                imgids: Vec::new(),
                versions: 1,
                files: vec![UnitFile { from: None, rel: PathBuf::from(&name), size: info.size.unwrap_or(0) }],
                download: Some((id, info.checksum)),
                keep_source: true,
                here: false,
            });
        }
        Ok(v)
    }).await.map_err(|e| e.to_string())??;
    out.extend(remote);
    Ok(out)
}

fn check_dest(dest: &Path) -> Result<(), String> {
    if !volumes::answering(dest) {
        return Err(format!("{} is not answering", dest.display()));
    }
    if !dest.is_dir() {
        return Err(format!("{} is not a folder", dest.display()));
    }
    Ok(())
}

// what dropping these photos on `dest` would do, for the confirmation
#[tauri::command]
#[specta::specta]
pub(crate) async fn move_plan(app: AppHandle, state: State<'_, AppState>, req: MoveRequest) -> Result<MovePlan, String> {
    let dest = PathBuf::from(&req.dest);
    {
        let d = dest.clone();
        tauri::async_runtime::spawn_blocking(move || check_dest(&d)).await.map_err(|e| e.to_string())??;
    }
    let units = units(&app, &state, &req).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut plan = Vec::new();
        let mut bytes = 0;
        let mut same = true;
        for u in &units {
            let rel: Vec<PathBuf> = u.files.iter().map(|f| f.rel.clone()).collect();
            let (c, there) = if u.here { (Clash::Same, vec![true; rel.len()]) } else { clash(u, &dest, &rel, None) };
            let here = u.here || (c == Clash::Same && !u.keep_source && aliased(u, &dest, &rel, &there));
            let size: u64 = u.files.iter().map(|f| f.size).sum();
            bytes += u.files.iter().zip(&there).filter(|(_, t)| !**t).map(|(f, _)| f.size).sum::<u64>();
            match &u.files[0].from {
                Some(p) if !u.keep_source => same &= same_drive(p.parent().unwrap_or(Path::new("")), &dest),
                _ => same = false,
            }
            plan.push(PlanUnit {
                key: u.key.clone(),
                name: u.name.clone(),
                imgids: u.imgids.clone(),
                versions: u.versions,
                files: u.files.len() as u32,
                bytes: size,
                clash: if here { "here".into() } else { c.label().into() },
                download: u.download.is_some(),
                keep_source: u.keep_source,
            });
        }
        MovePlan {
            dest: text(&dest),
            units: plan,
            bytes,
            free: free_space(&dest),
            same_drive: same && !units.is_empty(),
            network: volumes::volume(&text(&dest)).network,
        }
    }).await.map_err(|e| e.to_string())
}

// the copy beside its name, hidden until it is verified
fn part_of(target: &Path) -> PathBuf {
    let name = target.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default();
    target.with_file_name(format!(".{name}.immage-part"))
}

// written straight from the disk, not the page cache, so the read back
// that verifies a copy reads what the drive (or the server) holds
fn drop_cache(f: &File) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::io::AsRawFd;
        unsafe { libc::posix_fadvise(f.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    }
    #[cfg(not(target_os = "linux"))]
    let _ = f;
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

// `from` into `target` through a part file: written and flushed, read back
// and its checksum compared with what was read, then renamed into place.
// `expect` is a base64 SHA-1 the bytes must also match (Immich's)
fn copy_verified(from: &mut dyn Read, target: &Path, expect: Option<&str>, mtime: Option<std::time::SystemTime>,
                 ctx: &Ctx) -> Result<(), String> {
    let part = part_of(target);
    let fail = |e: String| {
        let _ = std::fs::remove_file(&part);
        e
    };
    let mut out = std::fs::OpenOptions::new().write(true).create_new(true).open(&part)
        .map_err(|e| format!("{}: {e}", part.display()))?;
    let (mut a, mut b) = (Sha256::new(), <sha1::Sha1 as sha1::Digest>::new());
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.cancelled() {
            drop(out);
            return Err(fail(CANCELLED.into()));
        }
        let n = match from.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                drop(out);
                return Err(fail(format!("reading: {e}")));
            }
        };
        if n == 0 {
            break;
        }
        a.update(&buf[..n]);
        sha1::Digest::update(&mut b, &buf[..n]);
        if let Err(e) = out.write_all(&buf[..n]) {
            drop(out);
            return Err(fail(format!("{}: {e}", target.display())));
        }
        ctx.bytes.fetch_add(n as u64, Ordering::SeqCst);
        ctx.activity.fetch_add(1, Ordering::SeqCst);
    }
    if let Err(e) = out.sync_all() {
        drop(out);
        return Err(fail(format!("{}: {e}", target.display())));
    }
    if let Some(t) = mtime {
        let _ = out.set_modified(t);
    }
    drop_cache(&out);
    drop(out);
    let (read, read1) = (hex(&a.finalize()), base64(&sha1::Digest::finalize(b)));
    if let Some(f) = ctx.before_verify {
        f(&part);
    }
    let back = sums(&part, Some(ctx)).map_err(fail)?;
    if back.sha256 != read {
        return Err(fail(format!("{}: checksum mismatch after copying", target.display())));
    }
    if expect.is_some_and(|e| e != read1) {
        return Err(fail(format!("{}: download does not match Immich's checksum", target.display())));
    }
    if ctx.cancelled() { return Err(fail(CANCELLED.into())); }
    std::fs::rename(&part, target).map_err(|e| fail(format!("{}: {e}", target.display())))?;
    sync_dir(target.parent().unwrap_or(Path::new(".")));
    Ok(())
}

// what a unit left in the destination, undone if it fails part way
#[derive(Default)]
struct Placed {
    created: Vec<PathBuf>,
    renamed: Vec<(PathBuf, PathBuf)>,
}

impl Placed {
    fn undo(&self) {
        for (from, to) in self.renamed.iter().rev() {
            let _ = std::fs::rename(to, from);
        }
        for p in &self.created {
            let _ = std::fs::remove_file(p);
        }
    }
}

type Opener<'a> = &'a dyn Fn(&str) -> Result<Box<dyn Read>, String>;

// one photo and its sidecars into `dest` under `rel`, then, for a move,
// the sources removed. returns whether the photo's own file is gone from
// where it was, and any warning
#[allow(clippy::too_many_arguments)]
fn transfer_unit(u: &Unit, dest: &Path, rel: &[PathBuf], there: &[bool], copy: bool, rename: bool, ctx: &Ctx,
                 open: Opener) -> Result<(bool, Option<String>), String> {
    let mut placed = Placed::default();
    let result = (|| -> Result<(), String> {
        for ((f, r), same) in u.files.iter().zip(rel).zip(there) {
            if ctx.cancelled() { return Err(CANCELLED.into()); }
            if *same {
                continue;
            }
            let target = dest.join(r);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
            }
            if target.symlink_metadata().is_ok() {
                return Err(format!("{} appeared at the destination", target.display()));
            }
            if ctx.cancelled() { return Err(CANCELLED.into()); }
            match &f.from {
                Some(from) if rename && !copy && !u.keep_source => {
                    if std::fs::rename(from, &target).is_ok() {
                        ctx.bytes.fetch_add(f.size, Ordering::SeqCst);
                        placed.renamed.push((from.clone(), target));
                        continue;
                    }
                    // another drive after all (a bind mount): copied below
                    let mut src = File::open(from).map_err(|e| format!("{}: {e}", from.display()))?;
                    let mtime = src.metadata().and_then(|m| m.modified()).ok();
                    copy_verified(&mut src, &target, None, mtime, ctx)?;
                }
                Some(from) => {
                    let mut src = File::open(from).map_err(|e| format!("{}: {e}", from.display()))?;
                    let mtime = src.metadata().and_then(|m| m.modified()).ok();
                    copy_verified(&mut src, &target, None, mtime, ctx)?;
                }
                None => {
                    let (id, sum) = u.download.as_ref().ok_or("nothing to copy")?;
                    let mut src = open(id)?;
                    copy_verified(&mut *src, &target, sum.as_deref(), None, ctx)?;
                }
            }
            placed.created.push(target);
        }
        Ok(())
    })();
    if let Err(e) = result {
        placed.undo();
        return Err(e);
    }
    if copy || u.keep_source {
        return Ok((false, None));
    }
    if ctx.cancelled() {
        placed.undo();
        return Err(CANCELLED.into());
    }
    // verified: the sources go, the photo's file first, so a sidecar that
    // will not go is left over rather than a photo without its edits
    let renamed: Vec<&PathBuf> = placed.renamed.iter().map(|(f, _)| f).collect();
    let mut gone = false;
    let mut warning = None;
    for (i, f) in u.files.iter().enumerate() {
        let Some(from) = &f.from else { continue };
        if renamed.contains(&from) {
            gone |= i == 0;
            continue;
        }
        if ctx.cancelled() {
            // Once the photo is gone, the verified destination must stay.
            if gone { return Ok((true, Some("stopped; some original sidecars were left behind".into()))); }
            placed.undo();
            return Err(CANCELLED.into());
        }
        match std::fs::remove_file(from) {
            Ok(()) => gone |= i == 0,
            Err(e) if i == 0 => return Ok((false, Some(format!("{} was copied, but not removed: {e}", from.display())))),
            Err(e) => warning = Some(format!("{} was left behind: {e}", from.display())),
        }
    }
    Ok((gone, warning))
}

type TransferResult = Result<Option<(bool, Option<String>)>, String>;

// Reservation precedes checksum comparison: a positive "already there" result
// must remain valid until a move removes its sources.
#[cfg(test)]
fn transfer_photo(u: &Unit, dest: &Path, copy: bool, keep: bool, ctx: &Ctx, open: Opener) -> TransferResult {
    transfer_photo_indexed(u, dest, copy, keep, ctx, open, None)
}

#[allow(clippy::too_many_arguments)]
fn transfer_photo_indexed(u: &Unit, dest: &Path, copy: bool, keep: bool, ctx: &Ctx, open: Opener,
    index: Option<&crate::search_cache::SearchCache>) -> TransferResult {
    let original = file_names(u);
    let mut reservation = DestinationReservation::try_new(dest, &original, u);
    let mut selected = original;
    let mut there = vec![false; selected.len()];
    let mut needs_number = reservation.is_none() && keep;
    if reservation.is_some() {
        let (c, same) = clash(u, dest, &selected, Some(ctx));
        if ctx.cancelled() { return Err(CANCELLED.into()); }
        if c == Clash::Same && (copy || u.keep_source) { return Ok(None); }
        if c == Clash::Different && !keep { return Ok(None); }
        // the sources would go with nothing placed: only if they are not
        // the very files found there
        if c == Clash::Same && aliased(u, dest, &selected, &same) { return Ok(None); }
        there = same;
        needs_number = c == Clash::Different;
    }
    if needs_number {
        drop(reservation.take());
        for n in 1..=10_000 {
            if ctx.cancelled() { return Err(CANCELLED.into()); }
            let candidate = renamed(u, n);
            if candidate.iter().any(|p| dest.join(p).symlink_metadata().is_ok()) { continue; }
            if let Some(r) = DestinationReservation::try_new(dest, &candidate, u) {
                // Recheck after claiming the names, including for another job
                // that finished between the filesystem check and reservation.
                if candidate.iter().any(|p| dest.join(p).symlink_metadata().is_ok()) { continue; }
                selected = candidate;
                there = vec![false; selected.len()];
                reservation = Some(r);
                break;
            }
        }
    }
    let Some(_reservation) = reservation else {
        return Err("source or destination names are in use, or no unused numbered name is available".into());
    };
    if ctx.cancelled() { return Err(CANCELLED.into()); }
    let rename = u.files[0].from.as_ref()
        .is_some_and(|p| same_drive(p.parent().unwrap_or(Path::new("")), dest));
    let snapshot = index.and_then(|index| {
        let source = u.files.first()?.from.as_ref()?;
        let variants = index.path_variants(source.to_str()?).ok()?;
        let asset = index.asset(variants.first()?.asset_id).ok()??;
        let listed = Mutex::new(crate::cache::Listed::default());
        for v in &variants {
            let version = if v.copy_key.is_empty() { 0 } else { v.copy_key.strip_prefix("version:")?.parse().ok()? };
            let (original, edited) = crate::cache::listed_metadata_fingerprints(&listed, source, version)?;
            if original != asset.original_fingerprint || edited != v.edited_fingerprint {
                // A recent rating/save may have invalidated only edited results.
                // Refresh stamps before moving so unchanged original analysis
                // can still travel with the verified file.
                index.upsert_variant(source.to_str()?, &v.copy_key, &original, &edited, None, None, None).ok()?;
            }
        }
        let variants = index.path_variants(source.to_str()?).ok()?;
        let asset = index.asset(variants.first()?.asset_id).ok()??;
        Some((asset, variants))
    });
    let result = transfer_unit(u, dest, &selected, &there, copy, rename, ctx, open)?;
    if let (Some(index), Some((asset, variants))) = (index, snapshot) {
        let target = dest.join(&selected[0]);
        let listed = Mutex::new(crate::cache::Listed::default());
        let matches = variants.iter().all(|v| {
            let version = if v.copy_key.is_empty() { Some(0) } else { v.copy_key.strip_prefix("version:").and_then(|s| s.parse().ok()) };
            version.and_then(|version| crate::cache::listed_metadata_fingerprints(&listed, &target, version))
                .is_some_and(|(original, edited)| original == asset.original_fingerprint && edited == v.edited_fingerprint)
        });
        if matches {
            if let Err(e) = index.transferred(&asset.path, &text(&target), &asset.original_fingerprint, &variants, result.0) {
                eprintln!("search cache transfer: {e}");
            }
        }
    }
    Ok(Some(result))
}

struct Batch {
    units: Vec<Unit>,
    dest: PathBuf,
    workers: usize,
    cancel: Arc<AtomicBool>,
    stall: Duration,
}

struct TransferProgress {
    done: usize,
    total: usize,
    bytes: u64,
    bytes_total: u64,
    file: String,
}

// Only path strings are compared here. Filesystem probes and checksums belong
// to workers, where a blocked call can time out without blocking the coordinator.
fn scheduling_keys(u: &Unit) -> HashSet<String> {
    let mut keys = HashSet::new();
    for f in &u.files {
        keys.insert(format!("dest:{}", reservation_key(&f.rel)));
        keys.insert(format!("dest:{}", reservation_key(&part_of(&f.rel))));
        if let Some(source) = &f.from { keys.insert(format!("source:{}", reservation_key(source))); }
    }
    keys
}

// The same coordinator runs in production and in headless regression tests.
// Completion/catalog callbacks are serial; only whole photo tasks run in parallel.
fn transfer_batch<F>(batch: Batch, run: F, mut progress: impl FnMut(TransferProgress),
                     mut forget: impl FnMut(&[i64])) -> MoveSummary
where F: Fn(&Unit, &Ctx) -> TransferResult + Send + Sync + 'static {
    let Batch { units, dest, workers, cancel, stall } = batch;
    let mut s = MoveSummary { dest: text(&dest), done: vec![], removed: vec![], skipped: vec![],
                              failed: vec![], warnings: vec![], cancelled: false };
    let total = units.len();
    let bytes_total = units.iter().filter(|u| !u.here).flat_map(|u| &u.files).map(|f| f.size).sum();
    struct Active { unit: Unit, keys: HashSet<String>, ctx: Arc<Ctx>, since: Instant, seen: u64 }
    let run = Arc::new(run);
    let (tx, rx) = mpsc::channel::<(usize, TransferResult)>();
    let mut pending: std::collections::VecDeque<_> = units.into_iter().enumerate().collect();
    let mut active: HashMap<usize, Active> = HashMap::new();
    let (mut completed, mut finished_bytes) = (0usize, 0u64);
    let mut admission_wait: Option<Instant> = None;
    let mut stopping = false;
    let poll = (stall / 4).clamp(Duration::from_millis(1), Duration::from_millis(100));
    loop {
        if cancel.load(Ordering::SeqCst) {
            s.cancelled = true;
            stopping = true;
            pending.clear();
            for a in active.values() { a.ctx.cancel.store(true, Ordering::SeqCst); }
        }
        while active.len() < workers && !pending.is_empty() && !stopping {
            let (index, u) = pending.pop_front().unwrap();
            if u.here { s.skipped.push(u.name); completed += 1; continue; }
            let keys = scheduling_keys(&u);
            // Preserve input order for overlapping names, including Keep Both.
            // Independent names still get all available workers.
            if active.values().any(|a| !a.keys.is_disjoint(&keys)) {
                pending.push_front((index, u));
                break;
            }
            let Some(permit) = WorkerPermit::try_acquire() else {
                pending.push_front((index, u));
                if active.is_empty() && admission_wait.get_or_insert_with(Instant::now).elapsed() >= stall {
                    while let Some((_, u)) = pending.pop_front() {
                        s.failed.push(MoveFailure { name: u.name, error: "all transfer workers are busy; try again after other jobs finish".into() });
                        completed += 1;
                    }
                }
                break;
            };
            admission_wait = None;
            let mut context = Ctx::new(Arc::new(AtomicBool::new(false)));
            context.job_cancel = Some(cancel.clone());
            let ctx = Arc::new(context);
            let (worker_ctx, worker_unit, task, send) = (ctx.clone(), u.clone(), run.clone(), tx.clone());
            let spawned = std::thread::Builder::new().name("photo-transfer".into()).spawn(move || {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| task(&worker_unit, &worker_ctx)))
                    .unwrap_or_else(|_| Err("the transfer worker stopped unexpectedly".into()));
                // All filesystem work and reservation cleanup have finished.
                drop(permit);
                let _ = send.send((index, r));
            });
            match spawned {
                Ok(_) => { active.insert(index, Active { unit: u, keys, ctx, since: Instant::now(), seen: 0 }); }
                Err(e) => { s.failed.push(MoveFailure { name: u.name, error: format!("cannot start transfer worker: {e}") }); completed += 1; }
            }
        }
        progress(TransferProgress { done: completed, total, bytes: finished_bytes + active.values().map(|a| a.ctx.bytes.load(Ordering::SeqCst)).sum::<u64>(),
            bytes_total, file: active.values().min_by_key(|a| &a.unit.key).map(|a| a.unit.name.clone()).unwrap_or_default() });
        if active.is_empty() && pending.is_empty() { break; }
        if let Ok((index, result)) = rx.recv_timeout(poll) {
            if let Some(a) = active.remove(&index) {
                finished_bytes += a.ctx.bytes.load(Ordering::SeqCst);
                completed += 1;
                match result {
                    Err(e) if e == CANCELLED => {
                        if cancel.load(Ordering::SeqCst) { s.cancelled = true; }
                        else { s.failed.push(MoveFailure { name: a.unit.name, error: "stopped after another transfer stalled".into() }); }
                    }
                    Err(e) => s.failed.push(MoveFailure { name: a.unit.name, error: e }),
                    Ok(None) => s.skipped.push(a.unit.name),
                    Ok(Some((gone, warning))) => {
                        s.done.push(a.unit.name);
                        s.warnings.extend(warning);
                        if gone { forget(&a.unit.imgids); s.removed.extend(&a.unit.imgids); }
                    }
                }
            }
        }
        let now = Instant::now();
        let mut stalled = Vec::new();
        for (id, a) in &mut active {
            let activity = a.ctx.activity.load(Ordering::SeqCst);
            if activity != a.seen { a.seen = activity; a.since = now; }
            else if now.duration_since(a.since) >= stall { stalled.push(*id); }
        }
        for id in stalled {
            let a = active.remove(&id).unwrap();
            a.ctx.cancel.store(true, Ordering::SeqCst);
            finished_bytes += a.ctx.bytes.load(Ordering::SeqCst);
            s.failed.push(MoveFailure { name: a.unit.name, error: "the transfer stopped answering".into() });
            completed += 1;
            stopping = true;
        }
        if stopping {
            if !s.cancelled {
                while let Some((_, u)) = pending.pop_front() {
                    s.failed.push(MoveFailure { name: u.name, error: "not started because another transfer stalled".into() });
                    completed += 1;
                }
            }
            pending.clear();
            for a in active.values() { a.ctx.cancel.store(true, Ordering::SeqCst); }
        }
    }
    progress(TransferProgress { done: completed, total, bytes: finished_bytes, bytes_total, file: String::new() });
    s
}

fn transfer_workers(value: Option<String>) -> usize {
    value.and_then(|s| s.trim().parse::<usize>().ok()).filter(|n| (1..=WORKER_LIMIT).contains(n)).unwrap_or(2)
}

// Moves or copies photos with a per-job worker preference snapshot. The blocking
// coordinator runs away from Tauri's async workers so Stop remains available.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn move_files(app: AppHandle, state: State<'_, AppState>, settings: State<'_, crate::settings::Settings>,
                               job: u64, req: MoveRequest, copy: bool, keep_both: Vec<String>) -> Result<MoveSummary, String> {
    let workers = transfer_workers(settings.get(crate::settings::THUMB_THREADS));
    let cancel = Arc::new(AtomicBool::new(false));
    state.move_cancels.lock().unwrap().insert(job, cancel.clone());
    let _registered = CancelEntry { map: &state.move_cancels, job };
    let dest = PathBuf::from(&req.dest);
    {
        let d = dest.clone();
        tauri::async_runtime::spawn_blocking(move || check_dest(&d)).await.map_err(|e| e.to_string())??;
    }
    let units = units(&app, &state, &req).await?;
    let index = state.search_cache.clone();
    let conn = tauri_plugin_immporter::immich_connection(&app).map(Arc::new);
    tauri::async_runtime::spawn_blocking(move || {
        let d = dest.clone();
        let forgotten = app.clone();
        transfer_batch(Batch { units, dest, workers, cancel, stall: STALL }, move |unit, ctx| {
            let client: std::cell::OnceCell<Result<immich_upload::Immich, String>> = std::cell::OnceCell::new();
            let open = |id: &str| -> Result<Box<dyn Read>, String> {
                let c = client.get_or_init(|| match &conn {
                    Some(c) => immich_upload::Immich::new(c), None => Err("Immich is not set up".into()),
                });
                let c = c.as_ref().map_err(|e| e.clone())?;
                Ok(Box::new(c.original_stream(id)?))
            };
            transfer_photo_indexed(unit, &d, copy, keep_both.contains(&unit.key), ctx, &open, index.as_deref())
        }, |p| {
            let _ = app.emit("move-progress", json!({ "job": job, "done": p.done, "total": p.total,
                "bytes": p.bytes, "bytesTotal": p.bytes_total, "file": p.file }));
        }, |ids| {
            for id in ids { let _ = forgotten.state::<AppState>().engine("move_files").request(json!({ "cmd": "forget", "imgid": id })); }
        })
    }).await.map_err(|e| e.to_string())
}

// removes a move job's cancel flag when it goes out of scope
struct CancelEntry<'a> {
    map: &'a Mutex<HashMap<u64, Arc<AtomicBool>>>,
    job: u64,
}

impl Drop for CancelEntry<'_> {
    fn drop(&mut self) {
        if let Some(cancel) = self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.job)
        {
            cancel.store(true, Ordering::SeqCst);
        }
    }
}

// stops move_files' `job`: the file being copied is abandoned, its part file
// removed, and the photo's sources kept
#[tauri::command]
#[specta::specta]
pub(crate) fn move_cancel(state: State<'_, AppState>, job: u64) {
    if let Some(c) = state.move_cancels.lock().unwrap().get(&job) {
        c.store(true, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Condvar;

    // Admission is intentionally process-wide. Tests that occupy all slots
    // must not compete with other scheduler tests in the same test process.
    static ADMISSION_TEST: Mutex<()> = Mutex::new(());


    fn test_dir(name: &str) -> PathBuf {
        // inside the build tree, not the system's temp folder
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("move-tests").join(name);
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::create_dir_all(d.join("dest")).unwrap();
        d
    }

    // a photo with two versions' sidecars and a mask sidecar
    fn photo(dir: &Path, name: &str) -> Unit {
        let raw = dir.join(name);
        std::fs::write(&raw, vec![7u8; 3 * CHUNK + 17]).unwrap();
        let stem = name.rsplit_once('.').unwrap();
        let sidecars = vec![
            dir.join(format!("{name}.xmp")),
            dir.join(format!("{}_01.{}.xmp", stem.0, stem.1)),
            dir.join(format!("{name}.dtdata")),
        ];
        for s in &sidecars {
            std::fs::write(s, format!("edit of {}", s.display())).unwrap();
        }
        local_unit(&raw, vec![1, 2], sidecars, Path::new("/nonexistent"), false)
    }

    fn no_open(_: &str) -> Result<Box<dyn Read>, String> {
        Err("no Immich in tests".into())
    }

    fn names(u: &Unit) -> Vec<PathBuf> {
        u.files.iter().map(|f| f.rel.clone()).collect()
    }

    fn ctx() -> Ctx {
        Ctx::new(Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn verified_transfers_preserve_analysis_rebase_metadata_and_separate_copy_ids() {
        for copy in [false,true] {
            let temp=tempfile::tempdir().unwrap();
            let src=temp.path().join("src"); let dest=temp.path().join("dest");
            std::fs::create_dir_all(&src).unwrap(); std::fs::create_dir_all(&dest).unwrap();
            let unit=photo(&src,"A.CR3");
            let path=src.join("A.CR3");
            let index=crate::search_cache::SearchCache::open(&temp.path().join("cache.sqlite")).unwrap();
            let listed=Mutex::new(crate::cache::Listed::default());
            let mut originals=Vec::new();
            for version in [0,1] {
                let (original,edited)=crate::cache::listed_metadata_fingerprints(&listed,&path,version).unwrap();
                let key=if version==0 {String::new()} else {format!("version:{version}")};
                let row=index.upsert_variant(path.to_str().unwrap(),&key,&original,&edited,None,None,None).unwrap();
                index.store_metadata(row.id,&json!({"path":path,"filename":"A.CR3","version":version}).to_string()).unwrap();
                index.put_analysis(row.id,"edited",&edited,1,"test-model",&[version as u8,9]).unwrap();
                index.put_analysis(row.id,"original",&original,1,"test-model",&[7,8]).unwrap();
                originals.push(row);
            }
            // Exercise the actual Keep Both destination selection as well.
            if copy { std::fs::write(dest.join("A.CR3"),b"another photo").unwrap(); }
            let target=if copy {dest.join(&renamed(&unit,1)[0])} else {dest.join("A.CR3")};
            assert!(transfer_photo_indexed(&unit,&dest,copy,copy,&ctx(),&no_open,Some(&index)).unwrap().is_some());
            let moved=index.path_variants(target.to_str().unwrap()).unwrap();
            assert_eq!(moved.len(),2);
            for (old,new) in originals.iter().zip(&moved) {
                assert_eq!(old.id==new.id,!copy);
                assert_eq!(old.asset_id==new.asset_id,!copy);
                assert_eq!(index.analysis(new.id,"edited",1,"test-model").unwrap(),Some(vec![if old.copy_key.is_empty(){0}else{1},9]));
                assert_eq!(index.analysis(new.id,"original",1,"test-model").unwrap(),Some(vec![7,8]));
                let metadata:serde_json::Value=serde_json::from_str(&index.metadata(new.id).unwrap().unwrap()).unwrap();
                assert_eq!(metadata["path"],text(&target));
                assert_eq!(metadata["filename"],target.file_name().unwrap().to_str().unwrap());
            }
            assert_eq!(index.path_variants(path.to_str().unwrap()).unwrap().is_empty(),!copy);
            if copy {
                index.remove_path(target.to_str().unwrap()).unwrap();
                assert_eq!(index.analysis(originals[0].id,"original",1,"test-model").unwrap(),Some(vec![7,8]));
            }
        }
    }

    #[test]
    fn global_worker_admission_is_bounded_and_recovers() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let mut permits: Vec<_> = (0..WORKER_LIMIT)
            .map(|_| WorkerPermit::try_acquire().unwrap())
            .collect();
        assert!(WorkerPermit::try_acquire().is_none());
        permits.pop();
        assert!(WorkerPermit::try_acquire().is_some());
        drop(permits);
        // The temporary permit above is dropped at statement end; capacity is
        // available again for later jobs.
        assert!(WorkerPermit::try_acquire().is_some());
    }

    #[test]
    fn reservations_cover_destinations_parts_sources_and_release_on_exit() {
        let d = test_dir("reservations");
        let a = photo(&d.join("src"), "A.CR3");
        let dest = d.join("dest");
        let names = names(&a);
        let first = DestinationReservation::try_new(&dest, &names, &a).unwrap();
        assert!(DestinationReservation::try_new(&dest, &names, &a).is_none());

        // A final name cannot overlap another transfer's temporary part file.
        let mut part_collision = a.clone();
        part_collision.files = vec![UnitFile {
            from: None,
            rel: ".A.CR3.immage-part".into(),
            size: 0,
        }];
        assert!(DestinationReservation::try_new(
            &dest,
            &file_names(&part_collision),
            &part_collision
        )
        .is_none());

        // The same source unit cannot be moved to two destinations at once.
        assert!(DestinationReservation::try_new(&d.join("elsewhere"), &names, &a).is_none());
        drop(first);
        assert!(DestinationReservation::try_new(&dest, &names, &a).is_some());
    }

    fn small_photo(dir: &Path, name: &str, id: i64) -> Unit {
        std::fs::create_dir_all(dir).unwrap();
        let raw = dir.join(name);
        let xmp = dir.join(format!("{name}.xmp"));
        std::fs::write(&raw, format!("original photo {name} id {id}")).unwrap();
        std::fs::write(&xmp, format!("edits for {id}")).unwrap();
        local_unit(&raw, vec![id], vec![xmp], Path::new("/nonexistent"), false)
    }

    fn batch(units: Vec<Unit>, dest: &Path, workers: usize, cancel: Arc<AtomicBool>, stall: Duration) -> Batch {
        Batch { units, dest: dest.to_path_buf(), workers, cancel, stall }
    }

    #[test]
    fn preference_defaults_and_valid_worker_counts() {
        for value in [None, Some("0"), Some("9"), Some("bad"), Some("-1")] {
            assert_eq!(transfer_workers(value.map(str::to_string)), 2);
        }
        for n in [1, 2, 3, 4, 6, 8] {
            assert_eq!(transfer_workers(Some(format!(" {n} "))), n);
        }
    }

    #[test]
    fn photo_batches_overlap_up_to_each_worker_limit_and_verify_sidecars() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        for workers in [1, 2, 3, 4, 6, 8] {
            let d = test_dir(&format!("parallel-{workers}"));
            let units: Vec<_> = (0..workers + 2).map(|n| small_photo(&d.join("src"), &format!("photo-{n}.ORF"), n as i64 + 1)).collect();
            let originals = units.clone();
            let gate = Arc::new((Mutex::new((0usize, false)), Condvar::new()));
            let (worker_gate, dest) = (gate.clone(), d.join("dest"));
            let task_dest = dest.clone();
            let events = Arc::new(Mutex::new(Vec::new()));
            let reports = events.clone();
            let b = batch(units, &dest, workers, Arc::new(AtomicBool::new(false)), Duration::from_secs(5));
            let coordinator = std::thread::spawn(move || transfer_batch(b, move |u, ctx| {
                let (lock, changed) = &*worker_gate;
                let mut g = lock.lock().unwrap();
                g.0 += 1;
                changed.notify_all();
                g = changed.wait_while(g, |g| !g.1).unwrap();
                drop(g);
                transfer_photo(u, &task_dest, true, false, ctx, &no_open)
            }, |p| reports.lock().unwrap().push((p.done, p.bytes)), |_| panic!("copy must not forget a source")));
            let (lock, changed) = &*gate;
            let g = lock.lock().unwrap();
            let (mut g, wait) = changed.wait_timeout_while(g, Duration::from_secs(3), |g| g.0 < workers).unwrap();
            let admitted = g.0;
            // Always release the gate before asserting, even on a slow failure.
            g.1 = true;
            changed.notify_all();
            drop(g);
            let result = coordinator.join().unwrap();
            assert!(!wait.timed_out(), "{workers} workers did not overlap");
            assert_eq!(admitted, workers, "admission exceeded the job preference");
            assert!(result.failed.is_empty());
            assert_eq!(result.done.len(), workers + 2);
            for u in &originals {
                for f in &u.files {
                    assert_eq!(std::fs::read(f.from.as_ref().unwrap()).unwrap(), std::fs::read(dest.join(&f.rel)).unwrap());
                }
            }
            let events = events.lock().unwrap();
            assert!(events.windows(2).all(|p| p[1].0 >= p[0].0 && p[1].1 >= p[0].1), "progress regressed");
            let expected: u64 = originals.iter().flat_map(|u| &u.files).map(|f| f.size).sum();
            assert_eq!(events.last(), Some(&(workers + 2, expected)), "final progress omitted completed bytes");
        }
    }

    #[test]
    fn cancelling_keeps_completed_moves_and_never_starts_queued_photos() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let d = test_dir("batch-cancel");
        let units: Vec<_> = ["done.ORF", "blocked.ORF", "queued.ORF"].iter().enumerate()
            .map(|(i, name)| small_photo(&d.join("src"), name, i as i64 + 1)).collect();
        let dest = d.join("dest");
        let task_dest = dest.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let b = batch(units, &dest, 1, cancel.clone(), Duration::from_secs(2));
        let (started, started_rx) = mpsc::channel();
        let (release, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let called = calls.clone();
        let coordinator = std::thread::spawn(move || {
            let mut forgotten = Vec::new();
            let result = transfer_batch(b, move |u, ctx| {
                called.lock().unwrap().push(u.name.clone());
                if u.name == "blocked.ORF" {
                    started.send(()).unwrap();
                    release_rx.lock().unwrap().recv().unwrap();
                }
                transfer_unit(u, &task_dest, &file_names(u), &vec![false; u.files.len()], false, false, ctx, &no_open).map(Some)
            }, |_| {}, |ids| forgotten.extend_from_slice(ids));
            (result, forgotten)
        });
        started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        cancel.store(true, Ordering::SeqCst);
        release.send(()).unwrap();
        let (result, forgotten) = coordinator.join().unwrap();
        assert!(result.cancelled);
        assert_eq!(result.done, vec!["done.ORF"]);
        assert_eq!(forgotten, vec![1]);
        assert_eq!(result.removed, vec![1]);
        assert_eq!(*calls.lock().unwrap(), vec!["done.ORF", "blocked.ORF"]);
        assert!(!d.join("src/done.ORF").exists());
        assert!(dest.join("done.ORF.xmp").exists());
        for name in ["blocked.ORF", "queued.ORF"] {
            assert!(d.join("src").join(name).exists());
            assert!(!dest.join(name).exists());
        }
    }

    #[test]
    fn duplicate_names_keep_input_order_without_clobbering_photos_or_sidecars() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let d = test_dir("ordered-names");
        let units = vec![small_photo(&d.join("src/a"), "same.ORF", 1), small_photo(&d.join("src/b"), "same.ORF", 2)];
        let dest = d.join("dest");
        let task_dest = dest.clone();
        let result = transfer_batch(batch(units.clone(), &dest, 2, Arc::new(AtomicBool::new(false)), Duration::from_secs(2)),
            move |u, ctx| transfer_photo(u, &task_dest, true, true, ctx, &no_open), |_| {}, |_| {});
        assert!(result.failed.is_empty());
        assert_eq!(result.done.len(), 2);
        for (u, name) in units.iter().zip(["same.ORF", "same_1.ORF"]) {
            assert_eq!(std::fs::read(u.files[0].from.as_ref().unwrap()).unwrap(), std::fs::read(dest.join(name)).unwrap());
            assert_eq!(std::fs::read(u.files[1].from.as_ref().unwrap()).unwrap(), std::fs::read(dest.join(format!("{name}.xmp"))).unwrap());
        }
    }

    #[test]
    fn stalled_workers_retain_capacity_and_names_until_late_io_returns() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let d = test_dir("stalled-recovery");
        let u = small_photo(&d.join("src"), "blocked.ORF", 1);
        let queued = small_photo(&d.join("src"), "queued.ORF", 2);
        let dest = d.join("dest");
        let task_dest = dest.clone();
        let (release, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let started = Arc::new(AtomicU64::new(0));
        let calls = started.clone();
        let result = transfer_batch(batch(vec![u.clone(), queued], &dest, 1, Arc::new(AtomicBool::new(false)), Duration::from_millis(80)), move |u, ctx| {
            let _reservation = DestinationReservation::try_new(&task_dest, &file_names(u), u).unwrap();
            calls.fetch_add(1, Ordering::SeqCst);
            release_rx.lock().unwrap().recv().unwrap();
            transfer_unit(u, &task_dest, &file_names(u), &vec![false; u.files.len()], false, false, ctx, &no_open).map(Some)
        }, |_| {}, |_| panic!("a timed-out move must not forget its source"));
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(result.failed.len(), 2);
        assert!(result.failed.iter().any(|f| f.error.contains("stopped answering")));
        assert!(DestinationReservation::try_new(&dest, &file_names(&u), &u).is_none());
        let spare: Vec<_> = (0..WORKER_LIMIT - 1).map(|_| WorkerPermit::try_acquire().unwrap()).collect();
        assert!(WorkerPermit::try_acquire().is_none(), "timed-out worker lost its permit");
        let task_dest = dest.clone();
        let b = batch(vec![u], &dest, 1, Arc::new(AtomicBool::new(false)), Duration::from_secs(2));
        let recovered = std::thread::spawn(move || transfer_batch(b,
            move |u, ctx| transfer_photo(u, &task_dest, true, false, ctx, &no_open), |_| {}, |_| {}));
        release.send(()).unwrap();
        let result = recovered.join().unwrap();
        drop(spare);
        assert!(result.failed.is_empty());
        assert_eq!(result.done, vec!["blocked.ORF"]);
        assert!(d.join("src/blocked.ORF").exists(), "late cancelled worker removed the original");
        assert!(dest.join("blocked.ORF.xmp").exists());
        assert!(!dest.join(".blocked.ORF.immage-part").exists());
    }

    #[test]
    fn another_photos_activity_does_not_hide_a_stalled_transfer() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let d = test_dir("independent-stalls");
        let units = vec![small_photo(&d.join("src"), "blocked.ORF", 1), small_photo(&d.join("src"), "busy.ORF", 2), small_photo(&d.join("src"), "queued.ORF", 3)];
        let dest = d.join("dest");
        let (release, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let busy_progress = Arc::new(AtomicU64::new(0));
        let reads = busy_progress.clone();
        // Each read really advances copy_verified's per-photo activity counter.
        struct SlowRead { remaining: usize, reads: Arc<AtomicU64> }
        impl Read for SlowRead {
            fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
                if self.remaining == 0 { return Ok(0); }
                std::thread::sleep(Duration::from_millis(10));
                let n = out.len().min(4096).min(self.remaining);
                out[..n].fill(7);
                self.remaining -= n;
                self.reads.fetch_add(1, Ordering::SeqCst);
                Ok(n)
            }
        }
        let elapsed = Instant::now();
        let result = transfer_batch(batch(units, &dest, 2, Arc::new(AtomicBool::new(false)), Duration::from_millis(150)), move |u, ctx| {
            if u.name == "blocked.ORF" {
                release_rx.lock().unwrap().recv().unwrap();
                return Err(CANCELLED.into());
            }
            if u.name == "queued.ORF" { panic!("queued photo must not start after stall"); }
            copy_verified(&mut SlowRead { remaining: 4096 * 300, reads: reads.clone() }, &dest.join("busy.ORF"), None, None, ctx)?;
            Ok(Some((false, None)))
        }, |_| {}, |_| {});
        release.send(()).unwrap();
        assert!(elapsed.elapsed() < Duration::from_secs(2));
        assert!(busy_progress.load(Ordering::SeqCst) > 2);
        assert_eq!(result.failed.len(), 3);
        assert!(result.failed.iter().any(|f| f.name == "blocked.ORF" && f.error.contains("stopped answering")));
        // Wait for the detached closure's permit to return through the real
        // admission path before another test occupies the whole global cap.
        let task_dest = d.join("dest");
        let recovery = small_photo(&d.join("src"), "recovery.ORF", 4);
        let permits: Vec<_> = (0..WORKER_LIMIT - 1).map(|_| WorkerPermit::try_acquire().unwrap()).collect();
        let recovered = transfer_batch(batch(vec![recovery], &task_dest, 1, Arc::new(AtomicBool::new(false)), Duration::from_secs(2)),
            move |u, ctx| transfer_photo(u, &task_dest, true, false, ctx, &no_open), |_| {}, |_| {});
        drop(permits);
        assert!(recovered.failed.is_empty());
    }

    #[test]
    fn existing_part_files_are_never_truncated_or_removed() {
        let d = test_dir("part-ownership");
        let target = d.join("dest/photo.ORF");
        let part = part_of(&target);
        std::fs::write(&part, b"another transfer owns these bytes").unwrap();
        let error = copy_verified(&mut &b"new photo"[..], &target, None, None, &ctx()).unwrap_err();
        assert!(error.contains("immage-part"));
        assert_eq!(std::fs::read(&part).unwrap(), b"another transfer owns these bytes");
        assert!(!target.exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn case_variants_transfer_in_order_on_a_case_sensitive_disk() {
        let _serial = ADMISSION_TEST.lock().unwrap();
        let d = test_dir("case-variants");
        let upper = small_photo(&d.join("src"), "A.ORF", 1);
        let lower = small_photo(&d.join("src"), "a.ORF", 2);
        let dest = d.join("dest");
        let task_dest = dest.clone();
        let result = transfer_batch(batch(vec![upper.clone(), lower.clone()], &dest, 2, Arc::new(AtomicBool::new(false)), Duration::from_secs(2)),
            move |u, ctx| transfer_photo(u, &task_dest, true, false, ctx, &no_open), |_| {}, |_| {});
        assert!(result.failed.is_empty());
        assert_eq!(result.done, vec!["A.ORF", "a.ORF"]);
        for u in [upper, lower] {
            assert_eq!(std::fs::read(u.files[0].from.as_ref().unwrap()).unwrap(), std::fs::read(dest.join(&u.name)).unwrap());
        }
    }

    #[cfg(unix)]
    #[test]
    fn destination_symlink_aliases_share_reservations_before_parent_creation() {
        let d = test_dir("symlink-reservations");
        let dest = d.join("dest");
        std::fs::create_dir(dest.join("actual")).unwrap();
        std::os::unix::fs::symlink(dest.join("actual"), dest.join("alias")).unwrap();
        let mut unit = small_photo(&d.join("src"), "raw.ORF", 1);
        unit.files.clear();
        let first = DestinationReservation::try_new(&dest, &["actual/new/raw.ORF".into()], &unit).unwrap();
        assert!(DestinationReservation::try_new(&dest, &["alias/new/raw.ORF".into()], &unit).is_none());
        drop(first);
        assert!(DestinationReservation::try_new(&dest, &["alias/new/raw.ORF".into()], &unit).is_some());
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        // SHA-1 of "abc", as Immich would send it
        let mut h = <sha1::Sha1 as sha1::Digest>::new();
        sha1::Digest::update(&mut h, b"abc");
        assert_eq!(base64(&sha1::Digest::finalize(h)), "qZk+NkcGgWq6PiVxeFDCbJzQ2J0=");
    }

    #[test]
    fn move_copies_verifies_and_removes_the_sources() {
        let d = test_dir("move");
        let u = photo(&d.join("src"), "IMG_1000.CR3");
        let dest = d.join("dest");
        let (c, there) = clash(&u, &dest, &names(&u), None);
        assert_eq!(c, Clash::None);
        let (gone, warning) = transfer_unit(&u, &dest, &names(&u), &there, false, false, &ctx(), &no_open).unwrap();
        assert!(gone && warning.is_none());
        for f in &u.files {
            assert!(!f.from.as_ref().unwrap().exists());
            assert!(dest.join(&f.rel).is_file());
        }
        assert!(dest.join("IMG_1000_01.CR3.xmp").is_file());
        assert_eq!(std::fs::metadata(dest.join("IMG_1000.CR3")).unwrap().len(), 3 * CHUNK as u64 + 17);
        let parts: Vec<_> = std::fs::read_dir(&dest).unwrap().flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".immage-part")).collect();
        assert!(parts.is_empty());
    }

    #[test]
    fn copy_keeps_the_sources() {
        let d = test_dir("copy");
        let u = photo(&d.join("src"), "A.NEF");
        let dest = d.join("dest");
        let (gone, _) = transfer_unit(&u, &dest, &names(&u), &[false; 4], true, false, &ctx(), &no_open).unwrap();
        assert!(!gone);
        assert!(u.files.iter().all(|f| f.from.as_ref().unwrap().is_file() && dest.join(&f.rel).is_file()));
    }

    #[test]
    fn same_drive_move_renames() {
        let d = test_dir("rename");
        let u = photo(&d.join("src"), "B.ARW");
        let dest = d.join("dest");
        assert!(same_drive(&d.join("src"), &dest));
        let c = ctx();
        let (gone, _) = transfer_unit(&u, &dest, &names(&u), &[false; 4], false, true, &c, &no_open).unwrap();
        assert!(gone);
        assert!(dest.join("B.ARW.xmp").is_file() && !d.join("src/B.ARW").exists());
    }

    #[test]
    fn a_corrupt_copy_keeps_the_source_and_leaves_nothing() {
        let d = test_dir("corrupt");
        let u = photo(&d.join("src"), "C.RAF");
        let dest = d.join("dest");
        let mut c = ctx();
        c.before_verify = Some(|p| {
            if p.to_string_lossy().contains("C.RAF.immage-part") {
                let mut f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
                f.write_all(b"X").unwrap();
            }
        });
        let e = transfer_unit(&u, &dest, &names(&u), &[false; 4], false, false, &c, &no_open).unwrap_err();
        assert!(e.contains("checksum mismatch"), "{e}");
        assert!(u.files.iter().all(|f| f.from.as_ref().unwrap().is_file()));
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
    }

    #[test]
    fn a_failure_after_renames_puts_them_back() {
        let d = test_dir("undo");
        let mut u = photo(&d.join("src"), "D.DNG");
        let dest = d.join("dest");
        // a sidecar that has gone missing since the plan
        u.files.push(UnitFile { from: Some(d.join("src/missing.xmp")), rel: "missing.xmp".into(), size: 1 });
        let there = vec![false; u.files.len()];
        assert!(transfer_unit(&u, &dest, &names(&u), &there, false, true, &ctx(), &no_open).is_err());
        assert!(d.join("src/D.DNG").is_file() && d.join("src/D.DNG.xmp").is_file());
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
    }

    // M1: a destination that is the source under another name must not
    // have the sources removed as "already there"
    #[cfg(unix)]
    #[test]
    fn a_move_onto_its_own_files_removes_nothing() {
        let d = test_dir("alias-link");
        let u = photo(&d.join("src"), "L.CR3");
        let dest = d.join("dest");
        for f in &u.files {
            std::os::unix::fs::symlink(f.from.as_ref().unwrap(), dest.join(&f.rel)).unwrap();
        }
        assert_eq!(clash(&u, &dest, &names(&u), None).0, Clash::Same);
        assert!(transfer_photo(&u, &dest, false, false, &ctx(), &no_open).unwrap().is_none());
        assert!(u.files.iter().all(|f| f.from.as_ref().unwrap().is_file()));

        // the same file by a hard link: one inode, kept too
        let d = test_dir("alias-hard");
        let u = photo(&d.join("src"), "H.CR3");
        let dest = d.join("dest");
        for f in &u.files {
            std::fs::hard_link(f.from.as_ref().unwrap(), dest.join(&f.rel)).unwrap();
        }
        assert!(transfer_photo(&u, &dest, false, false, &ctx(), &no_open).unwrap().is_none());
        assert!(u.files.iter().all(|f| f.from.as_ref().unwrap().is_file()));
    }

    #[test]
    fn a_real_copy_already_there_lets_a_move_finish() {
        let d = test_dir("alias-none");
        let u = photo(&d.join("src"), "R.CR3");
        let dest = d.join("dest");
        for f in &u.files {
            std::fs::copy(f.from.as_ref().unwrap(), dest.join(&f.rel)).unwrap();
        }
        let (gone, _) = transfer_photo(&u, &dest, false, false, &ctx(), &no_open).unwrap().unwrap();
        assert!(gone);
        assert!(u.files.iter().all(|f| !f.from.as_ref().unwrap().exists()));
        assert!(u.files.iter().all(|f| dest.join(&f.rel).is_file()));
        // no marker left in the source folder
        assert_eq!(std::fs::read_dir(d.join("src")).unwrap().count(), 0);
    }

    #[test]
    fn the_folder_probe_sees_one_folder_by_two_names() {
        let d = test_dir("alias-probe");
        assert!(!same_folder(&d.join("src"), &d.join("dest")));
        assert!(same_folder(&d.join("src"), &d.join("src")));
        // a folder the marker cannot be made in answers yes
        assert!(same_folder(&d.join("missing"), &d.join("dest")));
        assert_eq!(std::fs::read_dir(d.join("src")).unwrap().count(), 0);
    }

    #[test]
    fn a_cancel_removes_the_part_file() {
        let d = test_dir("cancel");
        let u = photo(&d.join("src"), "E.CR2");
        let dest = d.join("dest");
        let c = ctx();
        c.cancel.store(true, Ordering::SeqCst);
        let e = transfer_unit(&u, &dest, &names(&u), &[false; 4], false, false, &c, &no_open).unwrap_err();
        assert_eq!(e, CANCELLED);
        assert!(d.join("src/E.CR2").is_file());
        assert_eq!(std::fs::read_dir(&dest).unwrap().count(), 0);
    }

    #[test]
    fn clashes_are_told_apart_and_numbered() {
        let d = test_dir("clash");
        let u = photo(&d.join("src"), "F.ORF");
        let dest = d.join("dest");
        // an identical copy already there: nothing to do
        for f in &u.files {
            std::fs::copy(f.from.as_ref().unwrap(), dest.join(&f.rel)).unwrap();
        }
        assert_eq!(clash(&u, &dest, &names(&u), None).0, Clash::Same);
        // the same photo edited since: different
        std::fs::write(dest.join("F.ORF.xmp"), "another edit").unwrap();
        assert_eq!(clash(&u, &dest, &names(&u), None).0, Clash::Different);
        let n = numbered(&u, &dest);
        assert_eq!(n, vec![PathBuf::from("F_1.ORF"), "F_1.ORF.xmp".into(), "F_1_01.ORF.xmp".into(), "F_1.ORF.dtdata".into()]);
        std::fs::write(dest.join("F_1.ORF"), "taken").unwrap();
        assert_eq!(numbered(&u, &dest)[0], PathBuf::from("F_2.ORF"));
        let (gone, _) = transfer_unit(&u, &dest, &numbered(&u, &dest), &[false; 4], false, false, &ctx(), &no_open).unwrap();
        assert!(gone && dest.join("F_2_01.ORF.xmp").is_file());
        assert_eq!(std::fs::read_to_string(dest.join("F.ORF.xmp")).unwrap(), "another edit");
    }

    #[test]
    fn a_download_is_checked_against_immich() {
        let d = test_dir("download");
        let dest = d.join("dest");
        let body = b"raw bytes from the server".to_vec();
        let mut h = <sha1::Sha1 as sha1::Digest>::new();
        sha1::Digest::update(&mut h, &body);
        let good = base64(&sha1::Digest::finalize(h));
        let unit = |sum: &str| Unit {
            key: "immich:1".into(), name: "G.CR3".into(), imgids: vec![], versions: 1,
            files: vec![UnitFile { from: None, rel: "G.CR3".into(), size: body.len() as u64 }],
            download: Some(("1".into(), Some(sum.into()))), keep_source: true, here: false,
        };
        let b2 = body.clone();
        let open = move |_: &str| -> Result<Box<dyn Read>, String> { Ok(Box::new(std::io::Cursor::new(b2.clone()))) };
        let e = transfer_unit(&unit("AAAA"), &dest, &["G.CR3".into()], &[false], true, false, &ctx(), &open).unwrap_err();
        assert!(e.contains("Immich's checksum"), "{e}");
        assert!(!dest.join("G.CR3").exists());
        transfer_unit(&unit(&good), &dest, &["G.CR3".into()], &[false], true, false, &ctx(), &open).unwrap();
        assert_eq!(std::fs::read(dest.join("G.CR3")).unwrap(), body);
        assert_eq!(clash(&unit(&good), &dest, &["G.CR3".into()], None).0, Clash::Same);
    }

    #[test]
    fn a_sidecar_in_a_subfolder_keeps_its_place() {
        let dir = Path::new("/photos/2026");
        assert_eq!(relative(Path::new("/photos/2026/.dt/x.dtdata"), dir), PathBuf::from(".dt/x.dtdata"));
        assert_eq!(relative(Path::new("/elsewhere/x.xmp"), dir), PathBuf::from("x.xmp"));
    }

    #[test]
    fn a_photo_already_in_the_folder_is_marked_here() {
        let d = test_dir("here");
        let u = photo(&d.join("src"), "H.CR3");
        let raw = d.join("src/H.CR3");
        let sidecars: Vec<PathBuf> = u.files[1..].iter().map(|f| d.join("src").join(&f.rel)).collect();
        // dropped on its own folder: nothing to move, however the folder is spelled
        assert!(local_unit(&raw, vec![1], sidecars.clone(), &d.join("src"), false).here);
        assert!(local_unit(&raw, vec![1], sidecars.clone(), &d.join("src/../src"), false).here);
        assert!(local_unit(&raw, vec![1], sidecars.clone(), &d.join("src/"), false).here);
        assert!(!local_unit(&raw, vec![1], sidecars, &d.join("dest"), false).here);
    }

    #[test]
    fn a_unit_takes_its_existing_sidecars_once_and_counts_versions() {
        let d = test_dir("unit");
        let u = photo(&d.join("src"), "V.DNG");
        let raw = d.join("src/V.DNG");
        let mut sidecars: Vec<PathBuf> = u.files[1..].iter().map(|f| d.join("src").join(&f.rel)).collect();
        // listed twice and one that is not on disk: each file once, the missing one left out
        sidecars.push(sidecars[0].clone());
        sidecars.push(d.join("src/V_02.DNG.xmp"));
        let unit = local_unit(&raw, vec![1, 2], sidecars, &d.join("dest"), true);
        assert_eq!(names(&unit), vec![PathBuf::from("V.DNG"), "V.DNG.xmp".into(), "V_01.DNG.xmp".into(), "V.DNG.dtdata".into()]);
        assert_eq!(unit.versions, 2, "two .xmp files are two versions");
        assert!(unit.keep_source && unit.download.is_none());
        // a photo with no sidecar is one version
        let lone = d.join("src/L.JPG");
        std::fs::write(&lone, b"x").unwrap();
        let unit = local_unit(&lone, vec![], vec![], &d.join("dest"), false);
        assert_eq!((unit.versions, unit.files.len()), (1, 1));
    }

    #[test]
    fn a_destination_must_be_a_folder() {
        let d = test_dir("dest");
        assert!(check_dest(&d.join("dest")).is_ok());
        let file = d.join("src/f.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(check_dest(&file).unwrap_err().contains("not a folder") || check_dest(&file).unwrap_err().contains("not answering"));
        assert!(check_dest(&d.join("nowhere")).is_err());
    }
}
