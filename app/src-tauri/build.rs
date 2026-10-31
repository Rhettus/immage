// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .args(args)
            .current_dir(&root)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
    };
    if let Some(commit) = git(&["rev-parse", "HEAD"]) {
        println!("cargo:rustc-env=IMMAGE_BUILD_COMMIT={commit}");
    }
    if let Some(status) = git(&["status", "--porcelain", "--untracked-files=no"]) {
        println!("cargo:rustc-env=IMMAGE_BUILD_DIRTY={}", !status.is_empty());
    }
    for path in [
        ".git/HEAD",
        ".git/index",
        ".git/refs",
        "app/src",
        "app/src-tauri/src",
        "app/src-tauri/build.rs",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
    }
    tauri_build::build()
}
