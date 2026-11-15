// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! CLIP RGB8 preprocessing: antialiased bicubic resize, center crop and CHW normalization.
//! Integer coefficients and per-axis rounding match Pillow's RGB8 bicubic behavior.
//! Independent pinned Pillow/NumPy golden hashes live in verify/clip-preprocess-reference.json.
use std::path::Path;
const EDGE: usize = 224;
const PIXELS: usize = EDGE * EDGE;
const MAX_PIXELS: usize = 64 * 1024 * 1024;
const MEAN: [f32; 3] = [0.48145466, 0.4578275, 0.40821073];
// Preserve the decimal constants from the pinned processor configuration.
#[allow(clippy::excessive_precision)]
const STD: [f32; 3] = [0.26862954, 0.26130258, 0.27577711];
const PRECISION: i64 = 1 << 22;

pub fn validate_config(root: &Path) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("preprocessor_config.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let v = &value;
    let flag = |key: &str, default| v[key].as_bool().unwrap_or(default);
    if !flag("do_resize", false)
        || !flag("do_center_crop", false)
        || !flag("do_normalize", false)
        || !flag("do_convert_rgb", true)
        || !flag("do_rescale", true)
        || v["size"]["shortest_edge"].as_u64() != Some(224)
        || v["crop_size"]["width"].as_u64() != Some(224)
        || v["crop_size"]["height"].as_u64() != Some(224)
        || v["resample"].as_u64() != Some(3)
        || (v["rescale_factor"].as_f64().unwrap_or(1.0 / 255.0) - 1.0 / 255.0).abs() > 1e-12
    {
        return Err("Unsupported CLIP image preprocessing configuration".into());
    }
    for c in 0..3 {
        if v["image_mean"][c]
            .as_f64()
            .is_none_or(|n| (n - f64::from(MEAN[c])).abs() > 1e-7)
            || v["image_std"][c]
                .as_f64()
                .is_none_or(|n| (n - f64::from(STD[c])).abs() > 1e-7)
        {
            return Err("Unsupported CLIP normalization".into());
        }
    }
    // Installation smoke check; no photo, engine import or model execution.
    let tensor = prepare_rgb(&[0, 0, 0], 1, 1)?;
    if tensor.len() != 3 * PIXELS || !tensor.iter().all(|n| n.is_finite()) {
        return Err("CLIP preprocessing failed compatibility check".into());
    }
    Ok(())
}
fn cubic(distance: f64) -> f64 {
    let t = distance.abs();
    if t < 1.0 {
        1.0 + t * t * (1.5 * t - 2.5)
    } else if t < 2.0 {
        -0.5 * (((t - 5.0) * t + 8.0) * t - 4.0)
    } else {
        0.0
    }
}
struct Kernel {
    start: usize,
    weights: Vec<i64>,
}
fn kernels(input: usize, output: usize) -> Vec<Kernel> {
    let scale = input as f64 / output as f64;
    let filter_scale = scale.max(1.0);
    let support = 2.0 * filter_scale;
    (0..output)
        .map(|p| {
            let center = (p as f64 + 0.5) * scale;
            let start = ((center - support + 0.5) as isize).max(0) as usize;
            let end = ((center + support + 0.5) as usize).min(input);
            let coefficients: Vec<f64> = (start..end)
                .map(|x| cubic((x as f64 - center + 0.5) / filter_scale))
                .collect();
            let sum: f64 = coefficients.iter().sum();
            Kernel {
                start,
                weights: coefficients
                    .iter()
                    .map(|c| (c / sum * PRECISION as f64).round() as i64)
                    .collect(),
            }
        })
        .collect()
}
fn byte(sum: i64) -> u8 {
    ((sum + (PRECISION / 2)) >> 22).clamp(0, 255) as u8
}
fn cropped_rgb(rgb: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    if width == 0
        || height == 0
        || width > 32768
        || height > 32768
        || width
            .checked_mul(height)
            .is_none_or(|n| n > MAX_PIXELS || n.checked_mul(3) != Some(rgb.len()))
    {
        return Err("Invalid or oversized CLIP RGB image".into());
    }
    let (w, h) = if width <= height {
        (EDGE, EDGE * height / width)
    } else {
        (EDGE * width / height, EDGE)
    };
    if w.checked_mul(h).is_none_or(|n| n > MAX_PIXELS)
        || w > 32768
        || h > 32768
        || w.checked_mul(height).is_none_or(|n| n > MAX_PIXELS)
    {
        return Err("CLIP resize exceeds memory limits".into());
    }
    let horizontal = if w == width {
        rgb.to_vec()
    } else {
        let k = kernels(width, w);
        let mut out = vec![0u8; w * height * 3];
        for y in 0..height {
            for (x, kernel) in k.iter().enumerate() {
                for c in 0..3 {
                    let sum = kernel
                        .weights
                        .iter()
                        .enumerate()
                        .map(|(dx, weight)| {
                            i64::from(rgb[(y * width + kernel.start + dx) * 3 + c]) * weight
                        })
                        .sum();
                    out[(y * w + x) * 3 + c] = byte(sum);
                }
            }
        }
        out
    };
    // Crop during the vertical pass. The omitted rows cannot influence output.
    let top = (h - EDGE) / 2;
    let left = (w - EDGE) / 2;
    let k = kernels(height, h);
    let mut out = vec![0u8; 3 * PIXELS];
    for y in 0..EDGE {
        for x in 0..EDGE {
            for c in 0..3 {
                let value = if h == height {
                    horizontal[((top + y) * w + left + x) * 3 + c]
                } else {
                    let kernel = &k[top + y];
                    byte(
                        kernel
                            .weights
                            .iter()
                            .enumerate()
                            .map(|(dy, weight)| {
                                i64::from(horizontal[((kernel.start + dy) * w + left + x) * 3 + c])
                                    * weight
                            })
                            .sum(),
                    )
                };
                out[(y * EDGE + x) * 3 + c] = value;
            }
        }
    }
    Ok(out)
}
/// Input must already be orientation-correct sRGB RGB8. Never silently accept
/// BGRA, linear RGB, an unconverted ICC space or an edited preview as original.
pub fn prepare_rgb(rgb: &[u8], width: usize, height: usize) -> Result<Vec<f32>, String> {
    let pixels = cropped_rgb(rgb, width, height)?;
    let mut tensor = vec![0.0; 3 * PIXELS];
    for (i, pixel) in pixels.as_chunks::<3>().0.iter().enumerate() {
        for c in 0..3 {
            let scaled = (f64::from(pixel[c]) * (1.0 / 255.0)) as f32;
            tensor[c * PIXELS + i] = (scaled - MEAN[c]) / STD[c];
        }
    }
    Ok(tensor)
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn matches_independent_pillow_and_numpy_goldens() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../verify/clip-preprocess-reference.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let w = case["width"].as_u64().unwrap() as usize;
            let h = case["height"].as_u64().unwrap() as usize;
            let mut rgb = Vec::with_capacity(w * h * 3);
            for y in 0..h {
                for x in 0..w {
                    for c in 0..3 {
                        rgb.push(((x * 17 + y * 31 + c * 73 + (x * y) % 251) % 256) as u8);
                    }
                }
            }
            let cropped = cropped_rgb(&rgb, w, h).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(&cropped)),
                case["rgb_sha256"].as_str().unwrap(),
                "RGB {w}x{h}"
            );
            let tensor = prepare_rgb(&rgb, w, h).unwrap();
            let bytes: Vec<_> = tensor.iter().flat_map(|v| v.to_le_bytes()).collect();
            assert_eq!(
                format!("{:x}", Sha256::digest(&bytes)),
                case["tensor_sha256"].as_str().unwrap(),
                "tensor {w}x{h}"
            );
        }
    }
    #[test]
    fn rejects_incompatible_processor_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let config = serde_json::json!({"do_resize":true,"do_center_crop":true,"do_normalize":true,"size":{"shortest_edge":224},"crop_size":{"width":224,"height":224},"resample":3,"image_mean":[0.48145466,0.4578275,0.40821073],"image_std":[0.26862954,0.26130258,0.27577711]});
        let write = |value: &serde_json::Value| {
            std::fs::write(
                dir.path().join("preprocessor_config.json"),
                serde_json::to_vec(value).unwrap(),
            )
            .unwrap()
        };
        write(&config);
        assert!(validate_config(dir.path()).is_ok());
        for (key, value) in [
            ("do_resize", serde_json::json!(false)),
            ("resample", serde_json::json!(2)),
            ("image_mean", serde_json::json!([0.5, 0.5, 0.5])),
            ("rescale_factor", serde_json::json!(1.0)),
        ] {
            let mut bad = config.clone();
            bad[key] = value;
            write(&bad);
            assert!(validate_config(dir.path()).is_err(), "{key}");
        }
    }
    #[test]
    fn rejects_bad_buffers_dimensions_and_extreme_aspect_ratios() {
        for (rgb, w, h) in [
            (&[][..], 0, 1),
            (&[0][..], 1, 1),
            (&[0, 0, 0][..], usize::MAX, 1),
        ] {
            assert!(prepare_rgb(rgb, w, h).is_err());
        }
        assert!(prepare_rgb(&vec![0; 32768 * 3], 1, 32768).is_err());
    }
}
