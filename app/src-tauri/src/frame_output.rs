// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Engine output storage, independent of persistent runtime/configuration data.
use std::path::{Path, PathBuf};

pub struct FrameOutput {
    dir: PathBuf,
    private: bool,
}

impl FrameOutput {
    pub fn new(runtime: &Path) -> Self {
        #[cfg(target_os = "linux")]
        match Self::private_in(Path::new("/dev/shm")) {
            Ok(output) => return output,
            Err(error) => eprintln!("memory-backed engine frames unavailable; using {}: {error}", runtime.display()),
        }
        Self { dir: runtime.to_owned(), private: false }
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
        Ok(Self { dir: std::ffi::OsString::from_vec(bytes).into(), private: true })
    }

    pub fn path(&self, name: &str) -> PathBuf { self.dir.join(name) }
}

impl Drop for FrameOutput {
    fn drop(&mut self) {
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
    fn fallback_does_not_remove_runtime_data() {
        assert!(FrameOutput::private_in(Path::new("/dev/null")).is_err());
        let runtime = std::env::temp_dir();
        let output = FrameOutput { dir: runtime.clone(), private: false };
        assert_eq!(output.path("frame.rgba"), runtime.join("frame.rgba"));
        drop(output);
        assert!(runtime.exists());
    }
}
