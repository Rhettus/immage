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

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use crate::immich_search::{self, PathMap};
use crate::immich_upload;
use crate::volumes;
use crate::AppState;

// a destination that takes nothing for this long is given up on, as one
// that is not answering; the write that hangs is left to its thread
const STALL: Duration = Duration::from_secs(30);
const CHUNK: usize = 1 << 20;
const CANCELLED: &str = "cancelled";

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
    bytes: AtomicU64,
    // every chunk read or written, checksums included: what the stall guard watches
    activity: AtomicU64,
    // tests corrupt the copy here, before it is read back
    before_verify: Option<fn(&Path)>,
}

impl Ctx {
    fn new(cancel: Arc<AtomicBool>) -> Ctx {
        Ctx { cancel, bytes: AtomicU64::new(0), activity: AtomicU64::new(0), before_verify: None }
    }
}

fn text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
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
            if c.cancel.load(Ordering::SeqCst) {
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
            v.push(Unit {
                key: format!("immich:{id}"),
                name: info.name.clone(),
                imgids: Vec::new(),
                versions: 1,
                files: vec![UnitFile { from: None, rel: PathBuf::from(&info.name), size: info.size.unwrap_or(0) }],
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
                clash: if u.here { "here".into() } else { c.label().into() },
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
    let mut out = File::create(&part).map_err(|e| format!("{}: {e}", target.display()))?;
    let (mut a, mut b) = (Sha256::new(), <sha1::Sha1 as sha1::Digest>::new());
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.cancel.load(Ordering::SeqCst) {
            drop(out);
            return Err(fail(CANCELLED.into()));
        }
        let n = match from.read(&mut buf) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(fail(format!("reading: {e}"))),
        };
        if n == 0 {
            break;
        }
        a.update(&buf[..n]);
        sha1::Digest::update(&mut b, &buf[..n]);
        if let Err(e) = out.write_all(&buf[..n]) {
            return Err(fail(format!("{}: {e}", target.display())));
        }
        ctx.bytes.fetch_add(n as u64, Ordering::SeqCst);
        ctx.activity.fetch_add(1, Ordering::SeqCst);
    }
    if let Err(e) = out.sync_all() {
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
fn transfer_unit(u: &Unit, dest: &Path, rel: &[PathBuf], there: &[bool], copy: bool, rename: bool, ctx: &Ctx,
                 open: Opener) -> Result<(bool, Option<String>), String> {
    let mut placed = Placed::default();
    let result = (|| -> Result<(), String> {
        for ((f, r), same) in u.files.iter().zip(rel).zip(there) {
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
        match std::fs::remove_file(from) {
            Ok(()) => gone |= i == 0,
            Err(e) if i == 0 => return Ok((false, Some(format!("{} was copied, but not removed: {e}", from.display())))),
            Err(e) => warning = Some(format!("{} was left behind: {e}", from.display())),
        }
    }
    Ok((gone, warning))
}

// moves (or, with `copy`, copies) the photos into `req.dest`. units whose
// names clash with other files are skipped unless named in `keep_both`,
// which numbers their names. progress goes to the window as
// "move-progress"; move_cancel stops the file being copied and the rest
#[tauri::command]
#[specta::specta]
pub(crate) async fn move_files(app: AppHandle, state: State<'_, AppState>, job: u64, req: MoveRequest, copy: bool,
                               keep_both: Vec<String>) -> Result<MoveSummary, String> {
    let dest = PathBuf::from(&req.dest);
    {
        let d = dest.clone();
        tauri::async_runtime::spawn_blocking(move || check_dest(&d)).await.map_err(|e| e.to_string())??;
    }
    let units = units(&app, &state, &req).await?;
    let cancel = Arc::new(AtomicBool::new(false));
    state.move_cancels.lock().unwrap().insert(job, cancel.clone());
    let _registered = CancelEntry { map: &state.move_cancels, job };
    let mut s = MoveSummary { dest: text(&dest), done: vec![], removed: vec![], skipped: vec![], failed: vec![],
                              warnings: vec![], cancelled: false };
    let total = units.len();
    let bytes_total: u64 = units.iter().filter(|u| !u.here).flat_map(|u| &u.files).map(|f| f.size).sum();
    let ctx = Arc::new(Ctx::new(cancel.clone()));
    let conn = tauri_plugin_immporter::immich_connection(&app).map(Arc::new);
    for (n, u) in units.into_iter().enumerate() {
        if cancel.load(Ordering::SeqCst) {
            s.cancelled = true;
            break;
        }
        let _ = app.emit("move-progress", json!({ "job": job, "done": n, "total": total,
            "bytes": ctx.bytes.load(Ordering::SeqCst), "bytesTotal": bytes_total, "file": u.name }));
        if u.here {
            s.skipped.push(u.name.clone());
            continue;
        }
        let (d, ctx2, keep, conn) = (dest.clone(), ctx.clone(), keep_both.contains(&u.key), conn.clone());
        let (tx, rx) = mpsc::channel();
        let unit = u.clone();
        // its own thread, which a destination that stops answering can keep
        std::thread::spawn(move || {
            let names: Vec<PathBuf> = unit.files.iter().map(|f| f.rel.clone()).collect();
            let (c, there) = clash(&unit, &d, &names, Some(&ctx2));
            let r = match c {
                Clash::Same if copy || unit.keep_source => Ok(None),
                Clash::Different if !keep => Ok(None),
                _ => {
                    let (names, there) = if c == Clash::Different {
                        let n = numbered(&unit, &d);
                        let free = vec![false; n.len()];
                        (n, free)
                    } else {
                        (names, there)
                    };
                    let rename = unit.files[0].from.as_ref()
                        .is_some_and(|p| same_drive(p.parent().unwrap_or(Path::new("")), &d));
                    let client: std::cell::OnceCell<Result<immich_upload::Immich, String>> = std::cell::OnceCell::new();
                    let open = |id: &str| -> Result<Box<dyn Read>, String> {
                        let c = client.get_or_init(|| match &conn {
                            Some(c) => immich_upload::Immich::new(&**c),
                            None => Err("Immich is not set up".into()),
                        });
                        let c = c.as_ref().map_err(|e| e.clone())?;
                        Ok(Box::new(c.original_stream(id)?))
                    };
                    transfer_unit(&unit, &d, &names, &there, copy, rename, &ctx2, &open).map(Some)
                }
            };
            let _ = tx.send(r);
        });
        let app2 = app.clone();
        let ctx3 = ctx.clone();
        let name = u.name.clone();
        let waited = tauri::async_runtime::spawn_blocking(move || {
            let (mut shown, mut seen) = (ctx3.bytes.load(Ordering::SeqCst), ctx3.activity.load(Ordering::SeqCst));
            let mut since = Instant::now();
            loop {
                match rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(r) => return Some(r),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Some(Err("the copy stopped".into())),
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                let b = ctx3.bytes.load(Ordering::SeqCst);
                if b != shown {
                    shown = b;
                    let _ = app2.emit("move-progress", json!({ "job": job, "done": n, "total": total,
                        "bytes": b, "bytesTotal": bytes_total, "file": name }));
                }
                let a = ctx3.activity.load(Ordering::SeqCst);
                if a != seen {
                    (seen, since) = (a, Instant::now());
                } else if since.elapsed() > STALL {
                    ctx3.cancel.store(true, Ordering::SeqCst);
                    return None;
                }
            }
        }).await.map_err(|e| e.to_string())?;
        match waited {
            None => {
                s.failed.push(MoveFailure { name: u.name.clone(), error: "the destination stopped answering".into() });
                break;
            }
            Some(Err(e)) if e == CANCELLED => {
                s.cancelled = true;
                break;
            }
            Some(Err(e)) => s.failed.push(MoveFailure { name: u.name.clone(), error: e }),
            Some(Ok(None)) => s.skipped.push(u.name.clone()),
            Some(Ok(Some((gone, warning)))) => {
                s.done.push(u.name.clone());
                s.warnings.extend(warning);
                // only once the file is gone: one put back later imports fresh
                if gone {
                    for id in &u.imgids {
                        let _ = state.engine("move_files").request(json!({ "cmd": "forget", "imgid": id }));
                    }
                    s.removed.extend(&u.imgids);
                }
            }
        }
    }
    let _ = app.emit("move-progress", json!({ "job": job, "done": total, "total": total,
        "bytes": ctx.bytes.load(Ordering::SeqCst), "bytesTotal": bytes_total, "file": "" }));
    Ok(s)
}

// removes a move job's cancel flag when it goes out of scope
struct CancelEntry<'a> {
    map: &'a Mutex<HashMap<u64, Arc<AtomicBool>>>,
    job: u64,
}

impl Drop for CancelEntry<'_> {
    fn drop(&mut self) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.job);
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
}
