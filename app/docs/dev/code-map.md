# Code map

Immage is a Lightroom-style editor built on darktable. It runs as three
processes:

- **The WebView**: the React front end in [`app/src`](../../src).
- **The Tauri core**: the Rust layer in
  [`app/src-tauri/src`](../../src-tauri/src), the one gate to the engine.
- **`darktable-engine`**: a headless darktable session in
  [`engine/main.c`](../../../engine/main.c), a child of the Rust layer,
  spoken to in JSON, one line per request.

The front end never touches files or darktable: it calls `invoke(...)`
commands, and engine work goes through the one `Mutex<Engine>` in Rust,
one request at a time, except the engine's own threads for thumbnails,
folder reads, exports, AI and denoise. All image processing is
darktable's; its source changes only by
[patches/darktable-engine.patch](../../../patches/darktable-engine.patch).

This is the short version, loaded into every agent session.
[architecture.md](architecture.md) has the detail: each file's job in
full, the engine's pipes and commands, how each operation moves through
the app, where data lives, and the frame formats. Diagrams are in
[`diagrams/`](diagrams/). Paths below are relative to this file.

## Where to start a change

| Work | Start here | Related work |
|---|---|---|
| Remap a slider, or add one to an existing panel | `modules` and `panels` in [manifest.ts](../../src/manifest.ts) | the module's math file ([wb.ts](../../src/wb.ts), [tonecurve.ts](../../src/tonecurve.ts), ...), and [lib/edits.mjs](../../../benchmarking/lib/edits.mjs), which reads the manifest for the benchmark |
| A new panel or section | `panels` in [manifest.ts](../../src/manifest.ts) | `PanelView` in [App.tsx](../../src/App.tsx) for a custom graph; [CopySettings.tsx](../../src/CopySettings.tsx) groups |
| A per-mask (local) adjustment | [masks.md](masks.md) for the design; `LOCAL_CONTROLS` and `localMaps` in [manifest.ts](../../src/manifest.ts) (`merge` and `fixed` for a module masks share) | [MasksPanel.tsx](../../src/MasksPanel.tsx), [localMerge.ts](../../src/localMerge.ts); the engine's `_named_instance`, `_attach_mask` and `_combine` |
| A new mask shape or kind | [masks.ts](../../src/masks.ts) (`Shape`) | [MaskOverlay.tsx](../../src/MaskOverlay.tsx), `Session.addMask`, the engine's `_shape` / `_mask` |
| A new engine command | `_handle()` in [main.c](../../../engine/main.c) | a `#[tauri::command]` in [main.rs](../../src-tauri/src/main.rs), registered in `invoke_handler`; the caller in [session.ts](../../src/session.ts) or [App.tsx](../../src/App.tsx) |
| Rendering, frames, zoom | `Session.pump` / `renderView` in [session.ts](../../src/session.ts) | `currentView`, `paintFrame`, `animateTo` in [App.tsx](../../src/App.tsx); `render` in [main.rs](../../src-tauri/src/main.rs); `_render` in [main.c](../../../engine/main.c) |
| An export option | `Settings` in [exportSettings.ts](../../src/exportSettings.ts) | [ExportDialog.tsx](../../src/ExportDialog.tsx); `export_images` in [main.rs](../../src-tauri/src/main.rs); `_export` / `_frame_style` in [main.c](../../../engine/main.c); its progress, [background.ts](../../src/background.ts) |
| An AI feature | `runAi` / `runDenoise` in [App.tsx](../../src/App.tsx) | `withModel` in [aiModel.ts](../../src/aiModel.ts); `ai_model_ensure` in [main.rs](../../src-tauri/src/main.rs); the `HAVE_AI` section of [main.c](../../../engine/main.c); darktable's `src/ai` and `src/common/ai` |
| A preference | [Preferences.tsx](../../src/Preferences.tsx) (a `load*`/`store*` pair and a `PrefRow`) | [PrefsUI.tsx](../../src/PrefsUI.tsx); the consumer calls `load*()` live |
| An Immich call | [immich_search.rs](../../src-tauri/src/immich_search.rs) or [immich_upload.rs](../../src-tauri/src/immich_upload.rs) | `immich_*` commands in [main.rs](../../src-tauri/src/main.rs); [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx) |
| An Edit In plugin kind | `KINDS` in [plugins.ts](../../src/plugins.ts) | [plugins.rs](../../src-tauri/src/plugins.rs); `editIn` in [App.tsx](../../src/App.tsx) |
| Performance | [benchmarking/README.md](../../../benchmarking/README.md) | [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx); `perf_*` in [main.rs](../../src-tauri/src/main.rs) |
| Move to another darktable commit or release | [darktable-pin.md](darktable-pin.md) | [patches/darktable-engine.patch](../../../patches/darktable-engine.patch) |
| A release | the five version files ([package.json](../../package.json), `package-lock.json`, [Cargo.toml](../../src-tauri/Cargo.toml), `Cargo.lock`, [tauri.conf.json](../../src-tauri/tauri.conf.json)) | tag `immage-X.Y.Z`; [build_dmg.sh](../../scripts/build_dmg.sh) |

## Files

Front end ([`app/src`](../../src)):

- [App.tsx](../../src/App.tsx): the editor's shell and state; [session.ts](../../src/session.ts): one open photo, edits to the engine, renders, saves
- [manifest.ts](../../src/manifest.ts): panels, controls, and their mapping to darktable params; math in [wb.ts](../../src/wb.ts), [tonecurve.ts](../../src/tonecurve.ts), [transform.ts](../../src/transform.ts), [colorgrading.ts](../../src/colorgrading.ts), [colorequal.ts](../../src/colorequal.ts), [autoTone.ts](../../src/autoTone.ts), [bwauto.ts](../../src/bwauto.ts)
- masks: [masks.ts](../../src/masks.ts) (shapes, overlay pixels), [localMerge.ts](../../src/localMerge.ts) (shared instances), [MaskOverlay.tsx](../../src/MaskOverlay.tsx), [MasksPanel.tsx](../../src/MasksPanel.tsx), [ParametricEditor.tsx](../../src/ParametricEditor.tsx); design in [masks.md](masks.md)
- heal, negatives, zones: [spots.ts](../../src/spots.ts), [SpotOverlay.tsx](../../src/SpotOverlay.tsx), [HealPanel.tsx](../../src/HealPanel.tsx); [negadoctor.ts](../../src/negadoctor.ts), [NegativePanel.tsx](../../src/NegativePanel.tsx); [zones.ts](../../src/zones.ts), [ZoneSystem.tsx](../../src/ZoneSystem.tsx)
- frames to the page: [sharedFrames.ts](../../src/sharedFrames.ts) (Windows and Linux shared memory), [pixelRatio.ts](../../src/pixelRatio.ts) (Wayland draft scale)
- library: [library.ts](../../src/library.ts), [FolderTree.tsx](../../src/FolderTree.tsx), [filter.ts](../../src/filter.ts), [FilterPopup.tsx](../../src/FilterPopup.tsx); merges in [HdrDialog.tsx](../../src/HdrDialog.tsx), [PanoDialog.tsx](../../src/PanoDialog.tsx)
- export: [exportSettings.ts](../../src/exportSettings.ts), [exportTokens.ts](../../src/exportTokens.ts), [ExportDialog.tsx](../../src/ExportDialog.tsx), [ExportFrame.tsx](../../src/ExportFrame.tsx); background work in [background.ts](../../src/background.ts), [activity.ts](../../src/activity.ts)
- [Presets.tsx](../../src/Presets.tsx) (presets, looks), [HistoryPanel.tsx](../../src/HistoryPanel.tsx), [CopySettings.tsx](../../src/CopySettings.tsx), [ColorWheel.tsx](../../src/ColorWheel.tsx), [PointCurve.tsx](../../src/PointCurve.tsx), [CropTool.tsx](../../src/CropTool.tsx), [VignetteOverlay.tsx](../../src/VignetteOverlay.tsx), [GuideOverlay.tsx](../../src/GuideOverlay.tsx), [MetadataPanel.tsx](../../src/MetadataPanel.tsx), [Keywording.tsx](../../src/Keywording.tsx)
- Immich and plugins: [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx), [ImmichPrefs.tsx](../../src/ImmichPrefs.tsx); [plugins.ts](../../src/plugins.ts), [PluginPrefs.tsx](../../src/PluginPrefs.tsx)
- [Preferences.tsx](../../src/Preferences.tsx), [PrefsUI.tsx](../../src/PrefsUI.tsx); [histogram.ts](../../src/histogram.ts), [probe.ts](../../src/probe.ts); [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx); [aiModel.ts](../../src/aiModel.ts); [ImportView.tsx](../../src/ImportView.tsx) (the importer); [styles.css](../../src/styles.css)

Rust ([`app/src-tauri/src`](../../src-tauri/src)):

- [main.rs](../../src-tauri/src/main.rs): `AppState` and nearly every command; [engine.rs](../../src-tauri/src/engine.rs): the engine child and its protocol
- [immich_search.rs](../../src-tauri/src/immich_search.rs), [immich_upload.rs](../../src-tauri/src/immich_upload.rs); [plugins.rs](../../src-tauri/src/plugins.rs) (Edit In); [volumes.rs](../../src-tauri/src/volumes.rs) (drives); [scale.rs](../../src-tauri/src/scale.rs) (Wayland scale); [webext/frames.c](../../src-tauri/webext/frames.c) (Linux shared frames)

Engine ([`engine/`](../../../engine)):

- [main.c](../../../engine/main.c): `_handle()` serves every command; four pipes (main, preview, drag, base) over the open photo; sections for library, export, masks, AI (`HAVE_AI`), spots, ranges and zones, looks, save
- [upright.c](../../../engine/upright.c) (Upright, from ashift.c), [hdrmerge.c](../../../engine/hdrmerge.c) (HDR Merge), [pano.cc](../../../engine/pano.cc) and [dng.c](../../../engine/dng.c) (Panorama Merge), [strip.cc](../../../engine/strip.cc) (export metadata)

Checks and tools: [verify/](../../../verify/README.md) (the release checks: `Session` under Node against the engine), [benchmarking/](../../../benchmarking/README.md), `cargo test` in `app/src-tauri`, `npm run build` (type check), [darktable-pin.md](darktable-pin.md), and darktable's own [dev-doc/](../../../darktable/dev-doc/README.md).

## Keeping this map current

- Add a file to its line here and its entry in [architecture.md](architecture.md); keep this map short, as it is read at the start of every session.
- Refer to code by symbol, not line number.
