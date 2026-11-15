// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Bounded analysis admission and temporary tensor transport to the CPU engine worker.
use crate::{clip_models::Models, engine::Tagged, AppState};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;
struct TensorFile(PathBuf);
impl Drop for TensorFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
impl TensorFile {
    fn text(runtime: &Path, input: &crate::clip_text::TextInput) -> Result<Self, String> {
        if input.ids.len() != 77 || input.attention.len() != 77 {
            return Err("Invalid CLIP text tensor dimensions".into());
        }
        Self::create(runtime, |file| {
            for value in input.ids.iter().chain(input.attention.iter()) {
                file.write_all(&value.to_le_bytes())
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    fn image(runtime: &Path, input: &[f32]) -> Result<Self, String> {
        if input.len() != 3 * 224 * 224 || input.iter().any(|n| !n.is_finite()) {
            return Err("Invalid CLIP vision tensor".into());
        }
        Self::create(runtime, |file| {
            for value in input {
                file.write_all(&value.to_le_bytes())
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })
    }
    fn create(
        runtime: &Path,
        write: impl FnOnce(&mut std::fs::File) -> Result<(), String>,
    ) -> Result<Self, String> {
        let dir = runtime.join("clip-inputs");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.bin", uuid::Uuid::new_v4()));
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|e| e.to_string())?;
        let written = write(&mut file).and_then(|()| file.flush().map_err(|e| e.to_string()));
        // Close before cleanup on Windows; only remove a file we created.
        drop(file);
        let guard = Self(path);
        written?;
        Ok(guard)
    }
}
fn embedding(reply: Value) -> Result<Vec<f32>, String> {
    if reply["ok"].as_bool() != Some(true) {
        return Err(reply["error"]
            .as_str()
            .unwrap_or("CPU CLIP inference failed")
            .into());
    }
    let values = reply["embedding"]
        .as_array()
        .filter(|v| v.len() == 512)
        .ok_or("CLIP returned invalid embedding dimensions")?;
    let mut result = Vec::with_capacity(512);
    let mut squared = 0.0f64;
    for v in values {
        let n = v
            .as_f64()
            .filter(|n| n.is_finite() && n.abs() <= 1.00001)
            .ok_or("CLIP returned invalid embedding values")?;
        squared += n * n;
        result.push(n as f32);
    }
    if (squared - 1.0).abs() > 1e-4 {
        return Err("CLIP returned an unnormalized embedding".into());
    }
    Ok(result)
}
fn text(models: &Models, engine: &Tagged, runtime: &Path, query: &str) -> Result<Vec<f32>, String> {
    let (root, input) = models.prepare_text(query)?;
    let tensor = TensorFile::text(runtime, &input)?;
    embedding(engine.request(
        engine.tag(),
        json!({"cmd":"clip_embed","tower":"text","model_root":root,"input":tensor.0}),
    )?)
}
fn image(
    models: &Models,
    engine: &Tagged,
    runtime: &Path,
    rgb: &[u8],
    width: usize,
    height: usize,
) -> Result<Vec<f32>, String> {
    let (root, input) = models.prepare_image(rgb, width, height)?;
    let tensor = TensorFile::image(runtime, &input)?;
    embedding(engine.request(
        engine.tag(),
        json!({"cmd":"clip_embed","tower":"vision","model_root":root,"input":tensor.0}),
    )?)
}
#[derive(serde::Serialize, specta::Type)]
pub struct ProbeReply {
    pub dimensions: u32,
    pub image_dimensions: u32,
    pub elapsed_ms: f64,
}
/// Diagnostic only. Uses an already opted-in local package, never fetches one.
#[tauri::command]
#[specta::specta]
pub async fn search_model_probe(state: State<'_, AppState>) -> Result<ProbeReply, String> {
    if state.analysis_queue.status().paused {
        return Err("Background analysis is paused".into());
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    let (models, engine, runtime) = (
        Arc::clone(&state.clip_models),
        state.tagged.clone(),
        state.runtime.clone(),
    );
    if !state
        .analysis_queue
        .submit("clip:model-probe".into(), move |job| {
            if job.cancelled() {
                let _ = send.send(Err("Analysis cancelled".into()));
                return;
            }
            let started = std::time::Instant::now();
            let result = (|| {
                let v = text(&models, &engine, &runtime, "a photo of a cat")?;
                if job.cancelled() {
                    return Err("Analysis cancelled".into());
                }
                let visual = image(&models, &engine, &runtime, &[0, 0, 0], 1, 1)?;
                Ok(ProbeReply {
                    dimensions: v.len() as u32,
                    image_dimensions: visual.len() as u32,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                })
            })();
            // Clearing/rebuilding cannot publish an obsolete probe success.
            if let Some((send, result)) = job.commit(|| (send, result)) {
                let _ = send.send(result);
            }
        })
    {
        return Err("Background analysis is full or a probe is already running".into());
    }
    receive
        .await
        .map_err(|_| "Analysis cancelled".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_projection_size_values_and_normalization() {
        let mut v = vec![0.0f64; 512];
        v[0] = 1.0;
        assert_eq!(
            embedding(json!({"ok":true,"embedding":v})).unwrap().len(),
            512
        );
        for bad in [
            json!({"ok":false,"error":"unsupported graph"}),
            json!({"ok":true,"embedding":[1.0]}),
            json!({"ok":true,"embedding":vec![0.0;512]}),
            json!({"ok":true,"embedding":vec![2.0;512]}),
            json!({"ok":true,"embedding":vec![Value::Null;512]}),
        ] {
            assert!(embedding(bad).is_err());
        }
    }
    #[test]
    fn tensor_files_are_little_endian_private_and_removed_after_use() {
        let dir = tempfile::tempdir().unwrap();
        let mut ids = vec![49407; 77];
        ids[0] = 49406;
        let input = crate::clip_text::TextInput {
            ids,
            attention: vec![1; 77],
        };
        let file = TensorFile::text(dir.path(), &input).unwrap();
        let path = file.0.clone();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(bytes.len(), 154 * 8);
        assert_eq!(&bytes[..8], &49406i64.to_le_bytes());
        assert_eq!(&bytes[77 * 8..78 * 8], &1i64.to_le_bytes());
        let vision = vec![0.5; 3 * 224 * 224];
        let vision_file = TensorFile::image(dir.path(), &vision).unwrap();
        let vision_bytes = std::fs::read(&vision_file.0).unwrap();
        assert_eq!(vision_bytes.len(), 3 * 224 * 224 * 4);
        assert_eq!(&vision_bytes[..4], &0.5f32.to_le_bytes());
        assert!(TensorFile::image(dir.path(), &[]).is_err());
        let mut invalid = vision;
        invalid[0] = f32::NAN;
        assert!(TensorFile::image(dir.path(), &invalid).is_err());
        let other = TensorFile::text(dir.path(), &input).unwrap();
        assert_ne!(other.0, path);
        drop(file);
        assert!(!path.exists());
        assert!(TensorFile::text(
            dir.path(),
            &crate::clip_text::TextInput {
                ids: vec![],
                attention: vec![]
            }
        )
        .is_err());
    }
}
