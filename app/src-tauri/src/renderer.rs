// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// EGL must be selected before GTK starts, so this preference lives outside
// localStorage. the marker distinguishes our inherited override on relaunch
// from a vendor explicitly chosen by the user in their environment
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{atomic::Ordering, OnceLock};

pub const EGL_VENDOR: &str = "__EGL_VENDOR_LIBRARY_FILENAMES";
const MARKER: &str = "IMMAGE_WEBVIEW_EGL_VENDOR";
const MODES: [&str; 3] = ["auto", "mesa", "nvidia"];
static START: OnceLock<Started> = OnceLock::new();

struct Started {
    file: PathBuf,
    mode: String,
    active: &'static str,
    external: bool,
}

fn vendor(root: &Path, mode: &str) -> Option<PathBuf> {
    let name = match mode {
        "mesa" => "50_mesa.json",
        "nvidia" => "10_nvidia.json",
        _ => return None,
    };
    ["usr/share/glvnd/egl_vendor.d", "etc/glvnd/egl_vendor.d"]
        .iter().map(|p| root.join(p).join(name)).find(|p| p.is_file())
}

fn load(file: &Path) -> String {
    std::fs::read_to_string(file).ok().map(|s| s.trim().to_string())
        .filter(|s| MODES.contains(&s.as_str())).unwrap_or_else(|| "auto".into())
}

fn selection(root: &Path, mode: &str) -> Option<(&'static str, PathBuf)> {
    match mode {
        "mesa" => vendor(root, "mesa").map(|p| ("mesa", p)),
        "nvidia" => vendor(root, "nvidia").map(|p| ("nvidia", p)),
        // NVIDIA EGL held page replies to 72 ms versus Mesa's 2 ms in the
        // original RTX 4070 Ti SUPER benchmark (WebKit bug 303811).
        // keep that workaround unless the user selects a driver
        _ if root.join("proc/driver/nvidia").exists() => vendor(root, "mesa").map(|p| ("mesa", p)),
        _ => None,
    }
}

fn external(value: Option<&OsStr>, marker: Option<&OsStr>) -> bool {
    value.is_some() && value != marker
}

pub fn init(identifier: &str) -> Result<(), String> {
    let runtime = if cfg!(debug_assertions) {
        crate::repo_root().join("build/app-runtime")
    } else {
        // the same Linux data directory as Tauri's app_data_dir
        let data = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute())
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/share")))
            .ok_or("cannot find the app data directory")?;
        data.join(identifier)
    };
    let file = runtime.join("webview-renderer");
    let mode = load(&file);
    let value = std::env::var_os(EGL_VENDOR);
    let marker = std::env::var_os(MARKER);
    let external = external(value.as_deref(), marker.as_deref());
    let mut active = if external { "environment" } else { "system" };
    if !external {
        std::env::remove_var(EGL_VENDOR);
        if let Some((name, path)) = selection(Path::new("/"), &mode) {
            std::env::set_var(EGL_VENDOR, &path);
            std::env::set_var(MARKER, &path);
            crate::WEBVIEW_EGL_OVERRIDE.store(true, Ordering::Relaxed);
            active = name;
        }
    }
    if !crate::WEBVIEW_EGL_OVERRIDE.load(Ordering::Relaxed) {
        std::env::remove_var(MARKER);
    }
    START.set(Started { file, mode, active, external }).map_err(|_| "renderer initialized twice".to_string())
}

pub fn status() -> Value {
    let Some(s) = START.get() else { return Value::Null; };
    json!({ "running": s.mode, "next": load(&s.file), "active": s.active,
        "external": s.external, "mesa": vendor(Path::new("/"), "mesa").is_some(),
        "nvidia": Path::new("/proc/driver/nvidia").exists() && vendor(Path::new("/"), "nvidia").is_some() })
}

pub fn set(mode: &str) -> Result<(), String> {
    let s = START.get().ok_or("renderer has not started")?;
    if s.external { return Err("the renderer is set by __EGL_VENDOR_LIBRARY_FILENAMES".into()); }
    if !MODES.contains(&mode) { return Err(format!("unknown renderer '{mode}'")); }
    if mode != "auto" && vendor(Path::new("/"), mode).is_none() {
        return Err(format!("{mode}'s EGL driver is not installed"));
    }
    if mode == "nvidia" && !Path::new("/proc/driver/nvidia").exists() {
        return Err("the NVIDIA driver is not loaded".into());
    }
    std::fs::create_dir_all(s.file.parent().ok_or("no preference directory")?).map_err(|e| e.to_string())?;
    std::fs::write(&s.file, mode).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_and_persistence() {
        let root = std::env::temp_dir().join(format!("immage-renderer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let touch = |p: &str| {
            let p = root.join(p);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "{}").unwrap();
        };
        touch("etc/glvnd/egl_vendor.d/50_mesa.json");
        assert_eq!(selection(&root, "auto"), None);
        assert_eq!(selection(&root, "mesa").unwrap().0, "mesa");
        assert_eq!(selection(&root, "nvidia"), None);
        touch("proc/driver/nvidia/version");
        assert_eq!(selection(&root, "auto").unwrap().0, "mesa");
        touch("usr/share/glvnd/egl_vendor.d/10_nvidia.json");
        assert_eq!(selection(&root, "nvidia").unwrap().0, "nvidia");
        let file = root.join("webview-renderer");
        assert_eq!(load(&file), "auto");
        for mode in MODES {
            std::fs::write(&file, mode).unwrap();
            assert_eq!(load(&file), mode);
        }
        std::fs::write(&file, "invalid").unwrap();
        assert_eq!(load(&file), "auto");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn inherited_override_can_change_on_relaunch() {
        let mesa = Some(OsStr::new("/mesa.json"));
        let nvidia = Some(OsStr::new("/nvidia.json"));
        assert!(!external(None, None));
        assert!(!external(mesa, mesa));
        assert!(external(nvidia, mesa));
        assert!(external(nvidia, None));
    }
}
