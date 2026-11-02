// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Engine output storage, independent of persistent runtime/configuration data.
use std::path::{Path, PathBuf};

pub struct FrameOutput {
    dir: PathBuf,
    private: bool,
    #[cfg(any(unix, windows))]
    shared: Option<Shared>,
}

impl FrameOutput {
    pub fn new(runtime: &Path) -> Self {
        #[cfg(target_os = "linux")]
        match Self::private_in(Path::new("/dev/shm")) {
            Ok(output) => return output,
            Err(error) => eprintln!("memory-backed engine frames unavailable; using {}: {error}", runtime.display()),
        }
        #[cfg(any(target_os = "macos", windows))]
        { return Self { dir: runtime.to_owned(), private: false,
            shared: Some(Shared { id: uuid::Uuid::new_v4().simple().to_string(),
                                  names: std::sync::Mutex::new(std::collections::HashSet::new()) }) }; }
        #[cfg(not(any(target_os = "macos", windows)))]
        Self { dir: runtime.to_owned(), private: false,
            #[cfg(unix)]
            shared: None,
        }
    }

    #[cfg(target_os = "linux")]
    fn private_in(root: &Path) -> std::io::Result<Self> {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        let template = root.join("immage-engine-XXXXXX");
        let template = std::ffi::CString::new(template.as_os_str().as_bytes())?;
        let mut bytes = template.into_bytes_with_nul();
        // mkdtemp atomically creates an unpredictable directory with mode 0700.
        let result = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
        if result.is_null() { return Err(std::io::Error::last_os_error()); }
        bytes.pop();
        Ok(Self { dir: std::ffi::OsString::from_vec(bytes).into(), private: true, shared: None })
    }

    pub fn path(&self, name: &str) -> PathBuf {
        #[cfg(any(unix, windows))]
        if let Some(shared) = &self.shared {
            use sha2::{Digest, Sha256};
            let hash = format!("{:x}", Sha256::digest(format!("{}:{name}", shared.id)));
            let object = format!("/i{}", &hash[..24]);
            #[cfg(unix)]
            {
                let mut names = shared.names.lock().unwrap();
                if !names.contains(&object) {
                    let c = std::ffi::CString::new(object.as_str()).unwrap();
                    let fd = unsafe { libc::shm_open(c.as_ptr(), libc::O_RDWR | libc::O_CREAT | libc::O_EXCL, 0o600) };
                    if fd < 0 {
                        // Do not mix regular-file fallback into a selected transport.
                        eprintln!("cannot create intermediate buffer: {}", std::io::Error::last_os_error());
                    } else {
                        unsafe { libc::close(fd); }
                        names.insert(object.clone());
                    }
                }
            }
            return PathBuf::from(format!("shm:{object}"));
        }
        self.dir.join(name)
    }

    pub fn read(path: &Path) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        Self::append(path, &mut out)?;
        Ok(out)
    }

    pub fn append(path: &Path, out: &mut Vec<u8>) -> std::io::Result<()> {
        #[cfg(any(unix, windows))]
        if let Some(name) = path.to_str().and_then(|p| p.strip_prefix("shm:")) {
            return shared_read(name, out);
        }
        use std::io::Read;
        std::fs::File::open(path)?.read_to_end(out)?;
        Ok(())
    }

    pub fn remove(&self, path: &Path) {
        #[cfg(unix)]
        if let Some(name) = path.to_str().and_then(|p| p.strip_prefix("shm:")) {
            let c = std::ffi::CString::new(name).unwrap();
            unsafe { libc::shm_unlink(c.as_ptr()); }
            if let Some(shared) = &self.shared { shared.names.lock().unwrap().remove(name); }
            return;
        }
        let _ = std::fs::remove_file(path);
    }
}

impl Drop for FrameOutput {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(shared) = &self.shared {
            for name in shared.names.lock().unwrap().iter() {
                let c = std::ffi::CString::new(name.as_str()).unwrap();
                unsafe { libc::shm_unlink(c.as_ptr()); }
            }
        }
        if self.private {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn private_outputs_are_isolated_and_cleaned() {
        let first = FrameOutput::private_in(Path::new("/dev/shm")).unwrap();
        let second = FrameOutput::private_in(Path::new("/dev/shm")).unwrap();
        assert_ne!(first.dir, second.dir);
        assert_eq!(std::fs::metadata(&first.dir).unwrap().permissions().mode() & 0o777, 0o700);
        let dir = first.dir.clone();
        for name in ["frame.rgba", "preview.rgba"] {
            let bytes = vec![123u8; 4096];
            std::fs::write(first.path(name), &bytes).unwrap();
            assert_eq!(std::fs::read(first.path(name)).unwrap(), bytes);
        }
        drop(first);
        assert!(!dir.exists());
        assert!(second.dir.exists());
    }

    #[test]
    fn mapped_output_resizes_preserves_bytes_and_cleans_up() {
        use std::os::fd::{AsRawFd, FromRawFd};
        let owner = std::sync::Arc::new(FrameOutput { dir: PathBuf::new(), private: false,
            shared: Some(Shared { id: uuid::Uuid::new_v4().to_string(),
                names: std::sync::Mutex::new(std::collections::HashSet::new()) }) });
        let other = FrameOutput { dir: PathBuf::new(), private: false,
            shared: Some(Shared { id: uuid::Uuid::new_v4().to_string(),
                names: std::sync::Mutex::new(std::collections::HashSet::new()) }) };
        let path = owner.path("frame.rgba");
        let isolated = other.path("frame.rgba");
        assert_ne!(path, isolated);
        let name = std::ffi::CString::new(&path.to_str().unwrap()[4..]).unwrap();
        let fd = unsafe { libc::shm_open(name.as_ptr(), libc::O_RDWR, 0) };
        assert!(fd >= 0);
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        assert_eq!(file.metadata().unwrap().permissions().mode() & 0o777, 0o600);
        for size in [0, 4096, 100_000, 17] {
            let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            file.set_len((size + 8) as u64).unwrap();
            let view = unsafe { libc::mmap(std::ptr::null_mut(), size + 8,
                libc::PROT_READ | libc::PROT_WRITE, libc::MAP_SHARED, file.as_raw_fd(), 0) };
            assert_ne!(view, libc::MAP_FAILED);
            unsafe {
                std::ptr::copy_nonoverlapping((size as u64).to_le_bytes().as_ptr(), view.cast(), 8);
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), view.cast::<u8>().add(8), size);
                libc::munmap(view, size + 8);
            }
            let mut out = vec![42];
            FrameOutput::append(&path, &mut out).unwrap();
            assert_eq!(&out[1..], bytes);
            assert_eq!(out[0], 42);
        }
        // An async thumbnail worker keeps ownership beyond the AppState drop.
        let worker = owner.clone();
        drop(owner);
        assert!(FrameOutput::read(&path).is_ok());
        drop(worker);
        assert!(FrameOutput::read(&path).is_err());
        assert!(FrameOutput::read(&isolated).is_err()); // zero-length, never written
        other.remove(&isolated);
        assert!(FrameOutput::read(&isolated).is_err());
    }

    #[test]
    fn malformed_mapping_length_is_rejected() {
        let mut out = vec![7];
        assert!(payload([0u8; 7].as_ptr(), 7, &mut out).is_err());
        assert!(payload(u64::MAX.to_le_bytes().as_ptr(), 8, &mut out).is_err());
        assert_eq!(out, [7]);
    }

    #[test]
    fn fallback_does_not_remove_runtime_data() {
        assert!(FrameOutput::private_in(Path::new("/dev/null")).is_err());
        let runtime = std::env::temp_dir();
        let output = FrameOutput { dir: runtime.clone(), private: false, shared: None };
        assert_eq!(output.path("frame.rgba"), runtime.join("frame.rgba"));
        drop(output);
        assert!(runtime.exists());
    }
}

#[cfg(any(unix, windows))]
struct Shared {
    id: String,
    #[allow(dead_code)]
    names: std::sync::Mutex<std::collections::HashSet<String>>,
}

#[cfg(any(unix, windows))]
fn payload(view: *const u8, available: usize, out: &mut Vec<u8>) -> std::io::Result<()> {
    if available < 8 { return Err(std::io::Error::other("truncated intermediate header")); }
    let count = unsafe { u64::from_le(std::ptr::read_unaligned(view.cast::<u64>())) };
    let count = usize::try_from(count).ok().filter(|n| *n <= available - 8)
        .ok_or_else(|| std::io::Error::other("invalid intermediate length"))?;
    out.extend_from_slice(unsafe { std::slice::from_raw_parts(view.add(8), count) });
    Ok(())
}

#[cfg(unix)]
fn shared_read(name: &str, out: &mut Vec<u8>) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let name = std::ffi::CString::new(name)?;
    let fd = unsafe { libc::shm_open(name.as_ptr(), libc::O_RDONLY, 0) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let length = usize::try_from(file.metadata()?.len()).ok().filter(|n| *n >= 8 && *n <= isize::MAX as usize)
        .ok_or_else(|| std::io::Error::other("invalid intermediate size"))?;
    let view = unsafe { libc::mmap(std::ptr::null_mut(), length, libc::PROT_READ, libc::MAP_SHARED, file.as_raw_fd(), 0) };
    if view == libc::MAP_FAILED { return Err(std::io::Error::last_os_error()); }
    let result = payload(view.cast(), length, out);
    unsafe { libc::munmap(view, length); }
    result
}

#[cfg(windows)]
fn shared_read(name: &str, out: &mut Vec<u8>) -> std::io::Result<()> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenFileMappingW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn MapViewOfFile(handle: *mut c_void, access: u32, high: u32, low: u32, size: usize) -> *mut c_void;
        fn UnmapViewOfFile(base: *const c_void) -> i32;
        fn OpenEventW(access: u32, inherit: i32, name: *const u16) -> *mut c_void;
        fn SetEvent(handle: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    // Always acknowledge consumption, including read failures, so the engine
    // can close its pagefile mapping on its next output without racing us.
    let done = unsafe { OpenEventW(2, 0, wide(&format!("{name}-done")).as_ptr()) };
    if done.is_null() { return Err(std::io::Error::last_os_error()); }
    let result = (|| {
        let handle = unsafe { OpenFileMappingW(4, 0, wide(name).as_ptr()) };
        if handle.is_null() { return Err(std::io::Error::last_os_error()); }
        let result = (|| {
            let header = unsafe { MapViewOfFile(handle, 4, 0, 0, 8) };
            if header.is_null() { return Err(std::io::Error::last_os_error()); }
            let count = unsafe { u64::from_le(std::ptr::read_unaligned(header.cast::<u64>())) };
            unsafe { UnmapViewOfFile(header); }
            let length = usize::try_from(count).ok().and_then(|n| n.checked_add(8))
                .filter(|n| *n <= isize::MAX as usize)
                .ok_or_else(|| std::io::Error::other("invalid intermediate size"))?;
            let view = unsafe { MapViewOfFile(handle, 4, 0, 0, length) };
            if view.is_null() { return Err(std::io::Error::last_os_error()); }
            let result = payload(view.cast(), length, out);
            unsafe { UnmapViewOfFile(view); }
            result
        })();
        unsafe { CloseHandle(handle); }
        result
    })();
    unsafe { SetEvent(done); CloseHandle(done); }
    result
}
