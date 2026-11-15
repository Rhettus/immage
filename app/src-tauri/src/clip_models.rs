// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Opt-in, immutable CLIP package provisioning. Opening the app never fetches assets.
//! The graph hashes are LFS SHA-256; small assets use their pinned Git blob IDs
//! (including the Git blob header), never an unverified checksum from a download.
use crate::AppState;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::State;

pub const REVISION: &str = "6b7c523703ae26e39be4b03774966f8571c7f523";
const REPOSITORY: &str = "Xenova/clip-vit-base-patch32";
struct Asset {
    path: &'static str,
    size: u64,
    digest: &'static str,
    git_blob: bool,
}
const ASSETS: &[Asset] = &[
    Asset {
        path: "onnx/text_model.onnx",
        size: 254058553,
        digest: "3f6571f5bad13a97c469c1622e1cfc4d9aef78b79fdbfcff804ca357bfada8cc",
        git_blob: false,
    },
    Asset {
        path: "onnx/vision_model.onnx",
        size: 351685709,
        digest: "fd6e1402a588279d1723c7534d4bcba5bc0b14b47dfab0e46f8c47b8270d7d40",
        git_blob: false,
    },
    Asset {
        path: "tokenizer.json",
        size: 2224119,
        digest: "bc1f77d20440541dd073ebae6f6c401087c7d34e",
        git_blob: true,
    },
    Asset {
        path: "preprocessor_config.json",
        size: 520,
        digest: "e0675735fd0052745f2f7b7291e4aa7859389998",
        git_blob: true,
    },
    Asset {
        path: "tokenizer_config.json",
        size: 775,
        digest: "c9b2a711cbdd039529fa5a66f1965e13eb14451d",
        git_blob: true,
    },
    Asset {
        path: "special_tokens_map.json",
        size: 472,
        digest: "2c2130b544c0c5a72d5d00da071ba130a9800fb2",
        git_blob: true,
    },
    Asset {
        path: "config.json",
        size: 4524,
        digest: "e79bad158b04c235740f9b2ec320b17f4030f7a5",
        git_blob: true,
    },
];

#[derive(Clone, serde::Serialize, specta::Type)]
pub struct ModelStatus {
    pub revision: String,
    pub bytes: u64,
    pub downloading: bool,
    /// Installation verified in this process; not an inference availability claim.
    pub verified: bool,
    pub error: Option<String>,
}
#[derive(Default)]
struct Progress {
    downloading: bool,
    verified: bool,
    error: Option<String>,
}
pub struct Models {
    root: PathBuf,
    progress: Arc<Mutex<Progress>>,
    cancelled: AtomicBool,
}
impl Models {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            progress: Arc::new(Mutex::new(Progress::default())),
            cancelled: AtomicBool::new(false),
        }
    }
    pub fn status(&self) -> ModelStatus {
        let progress = self.progress.lock().unwrap();
        ModelStatus {
            revision: REVISION.into(),
            bytes: ASSETS.iter().map(|a| a.size).sum(),
            downloading: progress.downloading,
            verified: progress.verified,
            error: progress.error.clone(),
        }
    }
    pub fn cancel(&self) {
        let _progress = self.progress.lock().unwrap();
        self.cancelled.store(true, Ordering::Release);
    }
    fn install(&self, consent: bool) -> Result<(), String> {
        // Check before any directory creation, client construction or network access.
        if !consent {
            return Err("Model download requires explicit opt-in".into());
        }
        {
            let mut p = self.progress.lock().unwrap();
            if p.downloading {
                return Err("Model download is already running".into());
            }
            self.cancelled.store(false, Ordering::Release);
            p.downloading = true;
            p.verified = false;
            p.error = None;
        }
        let result = self.install_with(ASSETS, |asset, dest| {
            // Blocking Response::read applies this per read, bounding a stalled
            // transfer without imposing a minute-long whole-model deadline.
            let client = reqwest::blocking::Client::builder()
                .https_only(true)
                .connect_timeout(std::time::Duration::from_secs(30))
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .map_err(|e| e.to_string())?;
            let url = format!(
                "https://huggingface.co/{REPOSITORY}/resolve/{REVISION}/{}",
                asset.path
            );
            let mut response = client
                .get(url)
                .send()
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?;
            if response
                .content_length()
                .is_some_and(|len| len != asset.size)
            {
                return Err(format!("Unexpected length for {}", asset.path));
            }
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dest)
                .map_err(|e| e.to_string())?;
            copy_verified(
                &mut Cancellable {
                    reader: &mut response,
                    cancelled: &self.cancelled,
                },
                &mut file,
                asset,
            )?;
            file.sync_all().map_err(|e| e.to_string())
        });
        let result = result.and_then(|()| {
            crate::clip_text::TextProcessor::load(&self.root.join(REVISION)).map(|_| ())
        });
        let mut p = self.progress.lock().unwrap();
        p.downloading = false;
        p.verified = result.is_ok();
        p.error = result.as_ref().err().cloned();
        result
    }
    fn install_with(
        &self,
        assets: &[Asset],
        mut fetch: impl FnMut(&Asset, &Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let final_dir = self.root.join(REVISION);
        if verify_package(&final_dir, assets).is_ok() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let staging = self
            .root
            .join(format!(".download-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&staging).map_err(|e| e.to_string())?;
        let result = (|| {
            for asset in assets {
                if self.cancelled.load(Ordering::Acquire) {
                    return Err("Model download cancelled".into());
                }
                let dest = staging.join(asset.path);
                std::fs::create_dir_all(dest.parent().unwrap()).map_err(|e| e.to_string())?;
                fetch(asset, &dest)?;
            }
            // Independently verify staged files, including their size and type, before publication.
            verify_package(&staging, assets)?;
            // Serialize cancellation with publication; a cancelled package cannot appear later.
            let _publication = self.progress.lock().unwrap();
            if self.cancelled.load(Ordering::Acquire) {
                return Err("Model download cancelled".into());
            }
            if final_dir.exists() {
                // Keep a damaged installation for diagnostics; never merge mixed revisions.
                std::fs::rename(
                    &final_dir,
                    self.root.join(format!(".invalid-{}", uuid::Uuid::new_v4())),
                )
                .map_err(|e| e.to_string())?;
            }
            std::fs::rename(&staging, &final_dir).map_err(|e| e.to_string())
        })();
        let _ = std::fs::remove_dir_all(&staging);
        result
    }
}
struct Cancellable<'a, R> {
    reader: &'a mut R,
    cancelled: &'a AtomicBool,
}
impl<R: Read> Read for Cancellable<'_, R> {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        if self.cancelled.load(Ordering::Acquire) {
            return Err(std::io::Error::other("Model download cancelled"));
        }
        self.reader.read(output)
    }
}
fn copy_verified(
    input: &mut impl Read,
    output: &mut impl Write,
    asset: &Asset,
) -> Result<(), String> {
    let mut sha256 = Sha256::new();
    let mut git = <sha1::Sha1 as sha1::Digest>::new();
    sha1::Digest::update(&mut git, format!("blob {}\0", asset.size).as_bytes());
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        // Consume at most one byte beyond the limit, even for a dishonest server.
        let limit =
            (asset.size.saturating_sub(size).saturating_add(1)).min(buffer.len() as u64) as usize;
        let n = input
            .read(&mut buffer[..limit])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > asset.size {
            return Err(format!("{} exceeds pinned size", asset.path));
        }
        sha256.update(&buffer[..n]);
        sha1::Digest::update(&mut git, &buffer[..n]);
        output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
    }
    let actual = if asset.git_blob {
        sha1::Digest::finalize(git)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    } else {
        format!("{:x}", sha256.finalize())
    };
    if size != asset.size || actual != asset.digest {
        return Err(format!("{} failed pinned integrity check", asset.path));
    }
    Ok(())
}
fn verify_package(root: &Path, assets: &[Asset]) -> Result<(), String> {
    for asset in assets {
        let path = root.join(asset.path);
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() || meta.len() != asset.size {
            return Err(format!("Invalid model asset {}", asset.path));
        }
        let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        copy_verified(&mut file, &mut std::io::sink(), asset)?;
    }
    Ok(())
}
#[tauri::command]
#[specta::specta]
pub fn search_model_status(state: State<'_, AppState>) -> ModelStatus {
    state.clip_models.status()
}
#[tauri::command]
#[specta::specta]
pub async fn search_model_download(
    state: State<'_, AppState>,
    consent: bool,
) -> Result<(), String> {
    let models = state.clip_models.clone();
    tauri::async_runtime::spawn_blocking(move || models.install(consent))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub fn search_model_cancel(state: State<'_, AppState>) {
    state.clip_models.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;
    const SHA: Asset = Asset {
        path: "model",
        size: 3,
        digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        git_blob: false,
    };
    const GIT: Asset = Asset {
        path: "tokenizer",
        size: 3,
        digest: "f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f",
        git_blob: true,
    };
    #[test]
    fn exact_pins_reject_truncation_corruption_and_oversize() {
        for asset in [&SHA, &GIT] {
            assert!(copy_verified(&mut &b"abc"[..], &mut Vec::new(), asset).is_ok());
            for bytes in [&b"ab"[..], &b"abd"[..], &b"abcd"[..]] {
                assert!(copy_verified(&mut &bytes[..], &mut Vec::new(), asset).is_err());
            }
        }
        let mut input = &b"abcdef"[..];
        assert!(copy_verified(&mut input, &mut Vec::new(), &SHA).is_err());
        assert_eq!(input, b"ef");
    }
    #[test]
    fn denied_consent_has_no_filesystem_or_network_effects() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path().join("absent"));
        assert!(models.install(false).unwrap_err().contains("opt-in"));
        assert!(!models.root.exists());
        assert!(!models.status().downloading);
        assert!(!models.status().verified);
    }
    #[test]
    fn failed_install_removes_staging_preserves_previous_package() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path().into());
        let old = dir.path().join(REVISION);
        std::fs::create_dir(&old).unwrap();
        std::fs::write(old.join("keep"), "previous").unwrap();
        let result = models.install_with(ASSETS, |_, path| {
            std::fs::write(path, "partial").unwrap();
            Err("interrupted".into())
        });
        assert_eq!(result.unwrap_err(), "interrupted");
        assert_eq!(
            std::fs::read_to_string(old.join("keep")).unwrap(),
            "previous"
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn publishes_complete_package_and_reuses_without_fetching() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path().into());
        let assets = [SHA, GIT];
        models
            .install_with(&assets, |_, path| {
                std::fs::write(path, "abc").map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(verify_package(&dir.path().join(REVISION), &assets).is_ok());
        models
            .install_with(&assets, |_, _| panic!("valid install must not fetch"))
            .unwrap();
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn cancellation_blocks_streams_and_publication() {
        let dir = tempfile::tempdir().unwrap();
        let models = Models::new(dir.path().into());
        let result = models.install_with(&[SHA], |_, path| {
            std::fs::write(path, "abc").unwrap();
            models.cancel();
            Ok(())
        });
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(!dir.path().join(REVISION).exists());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
        let mut source = &b"abc"[..];
        assert!(copy_verified(
            &mut Cancellable {
                reader: &mut source,
                cancelled: &models.cancelled
            },
            &mut Vec::new(),
            &SHA
        )
        .is_err());
        assert_eq!(source, b"abc");
    }
    #[test]
    fn package_requires_every_matching_asset() {
        let dir = tempfile::tempdir().unwrap();
        let assets = [SHA, GIT];
        std::fs::write(dir.path().join("model"), "abc").unwrap();
        assert!(verify_package(dir.path(), &assets).is_err());
        std::fs::write(dir.path().join("tokenizer"), "abc").unwrap();
        assert!(verify_package(dir.path(), &assets).is_ok());
        std::fs::write(dir.path().join("model"), "abd").unwrap();
        assert!(verify_package(dir.path(), &assets).is_err());
    }
}
