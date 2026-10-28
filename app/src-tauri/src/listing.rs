// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a folder's entries with each file's size and modified time, from the
// listing itself where the system gives them: on a network share a stat
// per file is a round trip each, and a listing carries many entries per
// round trip. macOS asks with getattrlistbulk(), Windows' listing has them
// already; elsewhere a stat would be needed, so they are left out (None)
// and looked up when they are wanted

use std::ffi::OsString;
use std::path::Path;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    File,
    Dir,
    // a link, or what the listing could not say: the caller follows it
    Other,
}

pub struct Entry {
    pub name: OsString,
    pub kind: Kind,
    // cache::stamp_of()'s "size:time" of a file, when the listing gave it
    pub stamp: Option<String>,
}

pub fn list(dir: &Path) -> Vec<Entry> {
    #[cfg(target_os = "macos")]
    if let Some(list) = bulk(dir) {
        return list;
    }
    plain(dir)
}

fn plain(dir: &Path) -> Vec<Entry> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    rd.flatten().map(|e| {
        let kind = match e.file_type() {
            Ok(t) if t.is_file() => Kind::File,
            Ok(t) if t.is_dir() => Kind::Dir,
            _ => Kind::Other,
        };
        // Windows' DirEntry::metadata() is the listing's own, without a stat
        #[cfg(windows)]
        let stamp = (kind == Kind::File).then(|| e.metadata().ok()).flatten().map(|m| crate::cache::stamp(&m));
        #[cfg(not(windows))]
        let stamp = None;
        Entry { name: e.file_name(), kind, stamp }
    }).collect()
}

// getattrlistbulk(2): name, type, modified time and size, packed for many
// entries per call. None when the folder's file system does not take it
#[cfg(target_os = "macos")]
fn bulk(dir: &Path) -> Option<Vec<Entry>> {
    use std::ffi::CString;
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    // sys/vnode.h's VREG and VDIR
    const VREG: u32 = 1;
    const VDIR: u32 = 2;

    let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 {
        return None;
    }
    let mut req: libc::attrlist = unsafe { std::mem::zeroed() };
    req.bitmapcount = libc::ATTR_BIT_MAP_COUNT;
    req.commonattr = libc::ATTR_CMN_RETURNED_ATTRS | libc::ATTR_CMN_NAME | libc::ATTR_CMN_OBJTYPE | libc::ATTR_CMN_MODTIME;
    req.fileattr = libc::ATTR_FILE_DATALENGTH;
    let mut buf = vec![0u8; 256 * 1024];
    let mut out = Vec::new();
    let ok = loop {
        let n = unsafe {
            libc::getattrlistbulk(fd, (&raw mut req).cast(), buf.as_mut_ptr().cast(), buf.len(),
                                  libc::FSOPT_PACK_INVAL_ATTRS as u64)
        };
        if n < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            break false;
        }
        if n == 0 {
            break true;
        }
        let mut at = 0;
        for _ in 0..n {
            let Some(e) = unpack(&buf[at..]) else { break };
            at += e.0;
            if let Some((name, kind, stamp)) = e.1 {
                let kind = match kind { VREG => Kind::File, VDIR => Kind::Dir, _ => Kind::Other };
                out.push(Entry { name: OsString::from_vec(name), kind, stamp: if kind == Kind::File { stamp } else { None } });
            }
        }
    };
    unsafe { libc::close(fd) };
    // a file system that refuses the call is listed the plain way
    return ok.then_some(out);

    // one entry: its length, then the attributes asked for, in the order
    // of their bits, each at a 4-byte boundary. FSOPT_PACK_INVAL_ATTRS
    // keeps that layout for an attribute an entry lacks (a folder's size),
    // and `returned` says which are real
    #[allow(clippy::type_complexity)]
    fn unpack(b: &[u8]) -> Option<(usize, Option<(Vec<u8>, u32, Option<String>)>)> {
        let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_ne_bytes(s.try_into().unwrap()));
        let i64_at = |o: usize| b.get(o..o + 8).map(|s| i64::from_ne_bytes(s.try_into().unwrap()));
        let len = u32_at(0)? as usize;
        if len == 0 || len > b.len() {
            return None;
        }
        // attribute_set_t: common, vol, dir, file, fork
        let (common, file) = (u32_at(4)?, u32_at(16)?);
        // the name: an attrreference_t, its offset from where it sits
        let off = u32_at(24)? as i32;
        let name_len = u32_at(28)? as usize;
        let start = (24 + off as isize) as usize;
        let name = b.get(start..start + name_len.saturating_sub(1))?.to_vec();
        let kind = u32_at(32)?;
        // a timespec, then an off_t
        let (sec, nsec) = (i64_at(36)?, i64_at(44)?);
        let size = i64_at(52)?;
        let stamp = (common & libc::ATTR_CMN_MODTIME != 0 && file & libc::ATTR_FILE_DATALENGTH != 0 && sec >= 0)
            .then(|| crate::cache::stamp_of(size as u64, sec as u128 * 1_000_000_000 + nsec as u128));
        let named = !name.is_empty() && name != b"." && name != b"..";
        Some((len, named.then_some((name, kind, stamp))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // what the listing says of each file is what a stat says
    #[test]
    fn listing_agrees_with_stat() {
        let dir = std::env::temp_dir().join(format!("immage-listing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.jpg"), [0u8; 1234]).unwrap();
        std::fs::write(dir.join("b.CR3.xmp"), "x").unwrap();
        std::fs::write(dir.join("é.jpg"), "").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("sub"), dir.join("link")).unwrap();
        let got: HashMap<String, Entry> = list(&dir).into_iter()
            .map(|e| (e.name.to_string_lossy().into_owned(), e)).collect();
        let mut names: Vec<&String> = got.keys().collect();
        names.sort();
        let mut want = vec!["a.jpg", "b.CR3.xmp", "sub", "é.jpg"];
        if cfg!(unix) {
            want.insert(2, "link");
        }
        assert_eq!(names, want);
        assert_eq!(got["sub"].kind, Kind::Dir);
        assert_eq!(got["sub"].stamp, None);
        if cfg!(unix) {
            assert_eq!(got["link"].kind, Kind::Other);
        }
        for f in ["a.jpg", "b.CR3.xmp", "é.jpg"] {
            assert_eq!(got[f].kind, Kind::File);
            if cfg!(any(target_os = "macos", windows)) {
                let stat = crate::cache::stamp(&std::fs::metadata(dir.join(f)).unwrap());
                assert_eq!(got[f].stamp.as_deref(), Some(stat.as_str()), "{f}");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // a folder listed and each file stat'ed (as before this module) against
    // the listing alone, timed. the second can find the first's answers
    // cached, so run it both ways round, a minute apart:
    //   IMMAGE_LIST_DIR=<folder> cargo test --release list_timing -- --ignored --nocapture
    //   IMMAGE_LIST_DIR=<folder> IMMAGE_LIST_BULK_FIRST=1 cargo test ...
    #[test]
    #[ignore]
    fn list_timing() {
        let Ok(dir) = std::env::var("IMMAGE_LIST_DIR") else { return };
        let dir = Path::new(&dir);
        let one_by_one = || {
            let t = std::time::Instant::now();
            let mut stamps = HashMap::new();
            for e in plain(dir) {
                if e.kind == Kind::File {
                    if let Ok(m) = std::fs::metadata(dir.join(&e.name)) {
                        stamps.insert(e.name, crate::cache::stamp(&m));
                    }
                }
            }
            (t.elapsed(), stamps)
        };
        let bulk = || {
            let t = std::time::Instant::now();
            let got = list(dir);
            (t.elapsed(), got)
        };
        let first = std::env::var("IMMAGE_LIST_BULK_FIRST").is_ok();
        let ((a, stamps), (b, listed)) = if first {
            let b = bulk();
            (one_by_one(), b)
        } else {
            let a = one_by_one();
            (a, bulk())
        };
        let differ = listed.iter().filter(|e| e.kind == Kind::File)
            .filter(|e| stamps.get(&e.name) != e.stamp.as_ref()).count();
        println!("{} entries, {} files. listed and stat'ed one by one: {a:?}; listed in bulk: {b:?} ({} first). \
                  {differ} stamps differ", listed.len(), stamps.len(), if first { "bulk" } else { "one by one" });
    }
}
