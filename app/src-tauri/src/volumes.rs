// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the drive each of the library's folders is on, for the folder tree's
// drive headings: folders of the same name on the Mac and on a NAS are
// told apart by the drive they sit under, as in Lightroom

use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Volume {
    pub path: String,
    // where the drive is mounted: the folders of one drive share it
    pub mount: String,
    pub name: String,
    // the server a network share comes from
    pub host: Option<String>,
    pub network: bool,
    // false when the folder is not there, as when its share is not mounted;
    // the rest is then only a guess, and the client keeps what it last saw
    pub online: bool,
}

pub fn volume(path: &str) -> Volume {
    let online = Path::new(path).is_dir();
    let mut v = probe(Path::new(path)).unwrap_or_else(|| Volume {
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

// a local disk's own name ("Macintosh HD"), when sysinfo lists it
#[cfg(target_os = "macos")]
fn disk_name(mount: &str) -> Option<String> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks.list().iter()
        .find(|d| d.mount_point() == Path::new(mount))
        .map(|d| d.name().to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
}

#[cfg(target_os = "macos")]
fn probe(path: &Path) -> Option<Volume> {
    use std::ffi::{CStr, CString};
    use std::os::unix::ffi::OsStrExt;
    // a folder that is gone is placed by the nearest one still there
    let there = path.ancestors().find(|p| p.exists())?;
    let c = CString::new(there.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c.as_ptr(), &mut st) } != 0 { return None; }
    let text = |a: &[libc::c_char]| unsafe { CStr::from_ptr(a.as_ptr()) }.to_string_lossy().into_owned();
    let mut mount = text(&st.f_mntonname);
    let fstype = text(&st.f_fstypename);
    let source = text(&st.f_mntfromname);
    let network = st.f_flags & libc::MNT_LOCAL as u32 == 0
        || matches!(fstype.as_str(), "smbfs" | "afpfs" | "nfs" | "webdav");
    // the home folder is on the system's data volume, which Finder shows as
    // the startup disk itself
    if mount == "/System/Volumes/Data" { mount = "/".into(); }
    let name = if network { last_component(&mount) }
               else { disk_name(&mount).unwrap_or_else(|| if mount == "/" { "Macintosh HD".into() } else { last_component(&mount) }) };
    Some(Volume { path: String::new(), mount, name, host: if network { host_of(&source) } else { None }, network, online: true })
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

    #[test]
    fn hosts() {
        assert_eq!(host_of("//siftu@192.168.0.249/Pictures").as_deref(), Some("192.168.0.249"));
        assert_eq!(host_of(r"\\nas\share\").as_deref(), Some("nas"));
        assert_eq!(host_of("/dev/disk3s5"), None);
    }
}
