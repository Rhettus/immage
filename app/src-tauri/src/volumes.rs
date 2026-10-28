// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the drive each of the library's folders is on, for the folder tree's
// drive headings: folders of the same name on the Mac and on a NAS are
// told apart by the drive they sit under, as in Lightroom

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{mpsc, LazyLock, Mutex};
use std::time::{Duration, Instant};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Volume {
    pub path: String,
    // where the drive is mounted: the folders of one drive share it
    pub mount: String,
    pub name: String,
    // the server a network share comes from
    pub host: Option<String>,
    pub network: bool,
    // false when the folder is not there, as when its share is not mounted,
    // or its drive is not answering (answering()); the rest is then only a
    // guess, and the client keeps what it last saw
    pub online: bool,
}

pub fn volume(path: &str) -> Volume {
    // a drive that is not answering is offline, and only its mount is known
    let online = answering(Path::new(path)) && Path::new(path).is_dir();
    let found = if online { probe(Path::new(path)) } else { drive_of(Path::new(path)) };
    let mut v = found.unwrap_or_else(|| Volume {
        path: String::new(),
        mount: String::new(),
        name: String::new(),
        host: None,
        network: false,
        online,
    });
    v.path = path.to_string();
    v.online = online;
    v
}

// how long a drive has to answer, and how long an answer is trusted for
const DRIVE_WAIT: Duration = Duration::from_secs(3);
const DRIVE_FRESH: Duration = Duration::from_secs(2);

#[derive(Default)]
struct Drive {
    stuck: bool,
    answered: Option<Instant>,
}

// drives by mount point. a share whose server has gone away but is still
// mounted holds stat() and readdir() in the kernel for good, as can a
// failing disk, so a stat is tried on a thread of its own first. while it
// waits, the drive is stuck and is not tried again; it answers again when
// that stat returns
static DRIVES: LazyLock<Mutex<HashMap<String, Drive>>> = LazyLock::new(Default::default);

// whether the path can be touched without waiting for ever: its drive has
// answered a stat within DRIVE_WAIT
pub fn answering(path: &Path) -> bool {
    let drive = drive_of(path).map(|v| v.mount).unwrap_or_default();
    {
        let mut drives = DRIVES.lock().unwrap();
        let s = drives.entry(drive.clone()).or_default();
        if s.stuck {
            return false;
        }
        if s.answered.is_some_and(|t| t.elapsed() < DRIVE_FRESH) {
            return true;
        }
    }
    let (tx, rx) = mpsc::channel();
    let (at, key) = (path.to_path_buf(), drive.clone());
    std::thread::spawn(move || {
        // not found is an answer too
        let _ = std::fs::metadata(&at);
        let mut drives = DRIVES.lock().unwrap();
        let s = drives.entry(key).or_default();
        s.stuck = false;
        s.answered = Some(Instant::now());
        let _ = tx.send(());
    });
    if rx.recv_timeout(DRIVE_WAIT).is_ok() {
        return true;
    }
    // under the lock the stat's thread answers with, so a late answer is
    // never overwritten
    let mut drives = DRIVES.lock().unwrap();
    if rx.try_recv().is_ok() {
        return true;
    }
    drives.entry(drive).or_default().stuck = true;
    false
}

// the server in a mount's source: //user@nas.local/Pictures, nas:/export,
// \\nas\share
fn host_of(source: &str) -> Option<String> {
    let s = source.replace('\\', "/");
    let host = if let Some(rest) = s.strip_prefix("//") {
        let h = rest.split('/').next()?;
        h.rsplit('@').next()?.to_string()
    } else if let Some((h, _)) = s.split_once(':') {
        if h.contains('/') { return None; }
        h.to_string()
    } else {
        return None;
    };
    (!host.is_empty()).then_some(host)
}

#[cfg(not(windows))]
fn last_component(mount: &str) -> String {
    Path::new(mount).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| mount.to_string())
}

// a local disk's own name ("Macintosh HD"), asked of that disk alone:
// sysinfo's list of disks asks every share too
#[cfg(target_os = "macos")]
fn disk_name(mount: &str) -> Option<String> {
    use std::ffi::CString;
    let c = CString::new(mount).ok()?;
    let mut list: libc::attrlist = unsafe { std::mem::zeroed() };
    list.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    list.volattr = libc::ATTR_VOL_INFO | libc::ATTR_VOL_NAME;
    let mut buf = [0u8; 1024];
    let got = unsafe {
        libc::getattrlist(c.as_ptr(), &mut list as *mut _ as *mut libc::c_void, buf.as_mut_ptr() as *mut libc::c_void,
                          buf.len(), 0)
    };
    if got != 0 { return None; }
    // the buffer's length, then the name's attrreference_t: its offset from
    // the reference itself, and its length with the terminating NUL
    let offset = i32::from_ne_bytes(buf[4..8].try_into().ok()?);
    let len = u32::from_ne_bytes(buf[8..12].try_into().ok()?) as usize;
    let start = 4usize.checked_add_signed(offset as isize)?;
    let name = buf.get(start..start + len)?;
    let name = String::from_utf8_lossy(name).trim_end_matches('\0').to_string();
    (!name.is_empty()).then_some(name)
}

// the mounts as the kernel last saw them: MNT_NOWAIT asks no server, so a
// share that has gone away is listed without waiting on it. returns
// (source, mount point, file system type, local)
#[cfg(target_os = "macos")]
fn mounts() -> Vec<(String, String, String, bool)> {
    use std::ffi::CStr;
    let n = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
    if n <= 0 { return Vec::new(); }
    // room for a mount made in between
    let mut list: Vec<libc::statfs> = vec![unsafe { std::mem::zeroed() }; n as usize + 4];
    let size = (list.len() * std::mem::size_of::<libc::statfs>()) as libc::c_int;
    let n = unsafe { libc::getfsstat(list.as_mut_ptr(), size, libc::MNT_NOWAIT) };
    let text = |a: &[libc::c_char]| unsafe { CStr::from_ptr(a.as_ptr()) }.to_string_lossy().into_owned();
    list.iter().take(n.max(0) as usize)
        .map(|st| (text(&st.f_mntfromname), text(&st.f_mntonname), text(&st.f_fstypename),
                   st.f_flags & libc::MNT_LOCAL as u32 != 0))
        .collect()
}

// the drive a path is on, from the mount table alone: the longest mount
// point it is under, the home folder's being the startup disk
#[cfg(target_os = "macos")]
fn drive_of(path: &Path) -> Option<Volume> {
    let (source, mount, fstype, local) = mounts().into_iter()
        .filter(|(_, at, _, _)| path.starts_with(at))
        .max_by_key(|(_, at, _, _)| at.len())?;
    let network = !local || matches!(fstype.as_str(), "smbfs" | "afpfs" | "nfs" | "webdav");
    // the home folder is on the system's data volume, which Finder shows as
    // the startup disk itself
    let mount = if mount == "/System/Volumes/Data" { "/".to_string() } else { mount };
    let name = last_component(&mount);
    Some(Volume { path: String::new(), mount, name, host: if network { host_of(&source) } else { None }, network,
                  online: true })
}

#[cfg(target_os = "macos")]
fn probe(path: &Path) -> Option<Volume> {
    let mut v = drive_of(path)?;
    if !v.network {
        v.name = disk_name(&v.mount).unwrap_or_else(|| if v.mount == "/" { "Macintosh HD".into() } else { v.name });
    }
    Some(v)
}

// /proc/self/mounts' fields escape spaces and the like as octal: \040
#[cfg(any(target_os = "linux", test))]
fn unescape(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 3 < b.len() && b[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            out.push(u8::from_str_radix(&s[i + 1..i + 4], 8).unwrap_or(b'?'));
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// the mount holding a path, from a mounts table: the longest mount point
// it is under. returns (source, mount point, file system type)
#[cfg(any(target_os = "linux", test))]
fn mount_of(table: &str, path: &Path) -> Option<(String, String, String)> {
    table.lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let (src, at, fs) = (f.next()?, f.next()?, f.next()?);
            Some((unescape(src), unescape(at), fs.to_string()))
        })
        .filter(|(_, at, _)| path.starts_with(at))
        .max_by_key(|(_, at, _)| at.len())
}

#[cfg(any(target_os = "linux", test))]
fn is_network_fs(fs: &str) -> bool {
    matches!(fs, "nfs" | "nfs4" | "cifs" | "smb3" | "smbfs" | "fuse.sshfs" | "sshfs" | "davfs" | "fuse.rclone" | "9p")
}

#[cfg(any(target_os = "linux", test))]
fn from_table(table: &str, path: &Path) -> Option<Volume> {
    let (source, mount, fs) = mount_of(table, path)?;
    let network = is_network_fs(&fs);
    let name = if mount == "/" { "Computer".into() } else { last_component(&mount) };
    Some(Volume { path: String::new(), mount, name, host: if network { host_of(&source) } else { None }, network, online: true })
}

#[cfg(target_os = "linux")]
fn probe(path: &Path) -> Option<Volume> {
    let there = path.ancestors().find(|p| p.exists())?;
    let there = std::fs::canonicalize(there).ok()?;
    from_table(&std::fs::read_to_string("/proc/self/mounts").ok()?, &there)
}

// the mount table, which asks no server; the path as given, as resolving
// its links would
#[cfg(target_os = "linux")]
fn drive_of(path: &Path) -> Option<Volume> {
    from_table(&std::fs::read_to_string("/proc/self/mounts").ok()?, path)
}

// a UNC path, or a drive letter mapped to a share: the drive's type asks
// no server
#[cfg(windows)]
fn drive_of(path: &Path) -> Option<Volume> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    const DRIVE_REMOTE: u32 = 4;
    let p = path.to_string_lossy();
    let (mount, network) = if let Some(rest) = p.strip_prefix(r"\\") {
        let mut parts = rest.splitn(3, '\\');
        (format!(r"\\{}\{}\", parts.next()?, parts.next().unwrap_or_default()), true)
    } else {
        let root = format!("{}\\", p.get(..2).filter(|d| d.ends_with(':'))?);
        let remote = unsafe { GetDriveTypeW(&HSTRING::from(root.as_str())) } == DRIVE_REMOTE;
        (root, remote)
    };
    let drive = mount.trim_end_matches('\\').to_string();
    let name = drive.rsplit('\\').next().unwrap_or(&drive).to_string();
    Some(Volume { path: String::new(), host: if network && mount.starts_with(r"\\") { host_of(&mount) } else { None },
                  mount, name, network, online: true })
}

#[cfg(windows)]
fn probe(path: &Path) -> Option<Volume> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumeInformationW, GetVolumePathNameW};
    const DRIVE_REMOTE: u32 = 4;
    let there = path.ancestors().find(|p| p.exists()).unwrap_or(path);
    let mut root = [0u16; 261];
    unsafe { GetVolumePathNameW(&HSTRING::from(there.as_os_str()), &mut root) }.ok()?;
    let len = root.iter().position(|&c| c == 0).unwrap_or(root.len());
    let mount = String::from_utf16_lossy(&root[..len]);
    let at = HSTRING::from(mount.as_str());
    let unc = mount.starts_with(r"\\");
    let network = unc || unsafe { GetDriveTypeW(&at) } == DRIVE_REMOTE;
    let mut label = [0u16; 261];
    let _ = unsafe { GetVolumeInformationW(&at, Some(&mut label), None, None, None, None) };
    let label = String::from_utf16_lossy(&label[..label.iter().position(|&c| c == 0).unwrap_or(0)]);
    let drive = mount.trim_end_matches('\\').to_string();
    let name = if unc { drive.rsplit('\\').next().unwrap_or(&drive).to_string() }
               else if label.is_empty() { drive.clone() } else { format!("{label} ({drive})") };
    Some(Volume { path: String::new(), mount: mount.clone(), name, host: if unc { host_of(&mount) } else { None }, network, online: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const TABLE: &str = "\
/dev/nvme0n1p2 / ext4 rw,relatime 0 0
/dev/nvme0n1p1 /boot/efi vfat rw 0 0
//nas.local/Pictures /mnt/Pictures cifs rw,vers=3.0 0 0
nas:/export/photos /mnt/My\\040Photos nfs4 rw 0 0
";

    #[test]
    fn longest_mount_wins() {
        let v = from_table(TABLE, Path::new("/mnt/Pictures/2026/05")).unwrap();
        assert_eq!(v.mount, "/mnt/Pictures");
        assert_eq!(v.name, "Pictures");
        assert!(v.network);
        assert_eq!(v.host.as_deref(), Some("nas.local"));
        let home = from_table(TABLE, Path::new("/home/me/Pictures/2026")).unwrap();
        assert_eq!(home.mount, "/");
        assert_eq!(home.name, "Computer");
        assert!(!home.network);
        // a mount point that is only a prefix of the name is not its mount
        assert_eq!(from_table(TABLE, Path::new("/mnt/Pictures2")).unwrap().mount, "/");
    }

    #[test]
    fn escaped_mount_and_nfs_host() {
        let v = from_table(TABLE, Path::new("/mnt/My Photos/2026")).unwrap();
        assert_eq!(v.mount, "/mnt/My Photos");
        assert_eq!(v.host.as_deref(), Some("nas"));
    }

    // the startup disk from the mount table, named as Finder names it,
    // without listing every disk
    #[cfg(target_os = "macos")]
    #[test]
    fn startup_disk() {
        let home = std::env::var("HOME").unwrap();
        let v = drive_of(Path::new(&home)).unwrap();
        assert_eq!(v.mount, "/");
        assert!(!v.network);
        assert!(!probe(Path::new(&home)).unwrap().name.is_empty());
        assert!(disk_name("/").is_some());
    }

    // a stuck drive is not tried again, and answers once its stat returns
    #[test]
    fn stuck_drive() {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert!(answering(&dir));
        let drive = drive_of(&dir).map(|v| v.mount).unwrap_or_default();
        DRIVES.lock().unwrap().entry(drive.clone()).or_default().stuck = true;
        let start = Instant::now();
        assert!(!answering(&dir));
        assert!(start.elapsed() < Duration::from_millis(100));
        DRIVES.lock().unwrap().remove(&drive);
        assert!(answering(&dir));
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("//siftu@192.168.0.249/Pictures").as_deref(), Some("192.168.0.249"));
        assert_eq!(host_of(r"\\nas\share\").as_deref(), Some("nas"));
        assert_eq!(host_of("/dev/disk3s5"), None);
    }
}
