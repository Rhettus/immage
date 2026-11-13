# Code map

Immage is a raw photo editor with familiar panels, built on darktable. It runs as three
processes:

- **The WebView**: the React front end in [`app/src`](../../src).
- **The Tauri core**: the Rust layer in
  [`app/src-tauri/src`](../../src-tauri/src), the one gate to the engine.
- **`darktable-engine`**: a headless darktable session in
  [`engine/`](../../../engine) (`main.c` serves the requests), a child of the Rust layer,
  spoken to in JSON, one line per request.

The front end never touches files or darktable: it calls the typed
`commands.x(...)` (generated bindings, never raw `invoke`), and engine work goes through the one `Mutex<Engine>` in Rust,
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
| A new panel or section | `panels` in [manifest.ts](../../src/manifest.ts) | `PanelView` in [PanelView.tsx](../../src/PanelView.tsx) for a custom graph; [CopySettings.tsx](../../src/CopySettings.tsx) groups |
| A per-mask (local) adjustment | [masks.md](masks.md) for the design; `LOCAL_CONTROLS` and `localMaps` in [manifest.ts](../../src/manifest.ts) (`merge` and `fixed` for a module masks share) | [MasksPanel.tsx](../../src/MasksPanel.tsx), [localMerge.ts](../../src/localMerge.ts); the engine's `masks_named_instance`, `masks_attach_mask` and `masks_combine` in [masks.c](../../../engine/masks.c) |
| A new mask shape or kind | [masks.ts](../../src/masks.ts) (`Shape`) | [MaskOverlay.tsx](../../src/MaskOverlay.tsx), `Session.addMask`, the engine's `_shape` / `masks_mask` in [masks.c](../../../engine/masks.c) |
| A typed Tauri command | [bindings.rs](../../src-tauri/src/bindings.rs) (`commands()`), then regenerate [bindings.ts](../../src/bindings.ts) (`IMMAGE_WRITE_BINDINGS=1 cargo test bindings`) | page calls go through [commands.ts](../../src/commands.ts); [architecture.md](architecture.md); a typed engine reply needs a fixture (`verify/engine-protocol.py --fixtures`), see there |
| A new engine command | the `_commands[]` table and a `_cmd_<name>` handler in [main.c](../../../engine/main.c), with the feature code in its section file (`session_`, `library_`, `export_`, `masks_`, ... below) | a `#[tauri::command]` with `#[specta::specta]` in the `*_cmds.rs` file for its group (below), listed in `collect_commands!` in [bindings.rs](../../src-tauri/src/bindings.rs), then `IMMAGE_WRITE_BINDINGS=1 cargo test --locked bindings` regenerates [bindings.ts](../../src/bindings.ts); the caller calls `commands.x(...)` from [commands.ts](../../src/commands.ts) in [session.ts](../../src/session.ts) or [App.tsx](../../src/App.tsx) (never `invoke`: [typed-commands.test.mjs](../../../verify/typed-commands.test.mjs) fails on it);  [engine-commands.test.mjs](../../../verify/engine-commands.test.mjs) and [engine-protocol.py](../../../verify/engine-protocol.py) check the table and the replies |
| Rendering, frames, zoom | `Session.pump` / `renderView` in [session.ts](../../src/session.ts) | `currentView`, `paintFrame`, `animateTo` in [App.tsx](../../src/App.tsx); `render` in [session_cmds.rs](../../src-tauri/src/session_cmds.rs); `session_render` in [session.c](../../../engine/session.c) |
| An export option | `Settings` in [exportSettings.ts](../../src/exportSettings.ts) | [ExportDialog.tsx](../../src/ExportDialog.tsx); `export_images` in [export_cmds.rs](../../src-tauri/src/export_cmds.rs); `export_export` / `_frame_style` in [export.c](../../../engine/export.c); its progress, [background.ts](../../src/background.ts) |
| An AI feature | `runAi` / `runDenoise` in [App.tsx](../../src/App.tsx) | `withModel` in [aiModel.ts](../../src/aiModel.ts); `ai_model_ensure` in [ai_cmds.rs](../../src-tauri/src/ai_cmds.rs); [ai.c](../../../engine/ai.c) (`HAVE_AI`) and [device.c](../../../engine/device.c); darktable's `src/ai` and `src/common/ai` |
| A preference | [Preferences.tsx](../../src/Preferences.tsx) (a `load*`/`store*` pair and a `PrefRow`) | [PrefsUI.tsx](../../src/PrefsUI.tsx); the consumer calls `load*()` live |
| A backup component (Preferences > General > Backup) | `COMPONENTS` in [backup.rs](../../src-tauri/src/backup.rs) (its zip folder, file and label), then the matching arms of `components`, `file_source`, `create`, `save_current`, `validate` and `replace` | [BackupDialog.tsx](../../src/BackupDialog.tsx); the `backup_*` commands in backup.rs; for darktable's data, the engine's `data_backup` in [library.c](../../../engine/library.c) |
| An Immich call | [immich_search.rs](../../src-tauri/src/immich_search.rs) or [immich_upload.rs](../../src-tauri/src/immich_upload.rs) | `immich_*` commands in [immich_cmds.rs](../../src-tauri/src/immich_cmds.rs); [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx) |
| An Edit In plugin kind | `KINDS` in [plugins.ts](../../src/plugins.ts) | [plugins.rs](../../src-tauri/src/plugins.rs); `editIn` in [App.tsx](../../src/App.tsx) |
| Printing, soft proofing | [print.md](print.md); [PrintPanel.tsx](../../src/PrintPanel.tsx), [print.ts](../../src/print.ts) | [engine/print.c](../../../engine/print.c); `print_*` (`print_photo`, `print_sheet`), `printers`, `printer_info`, `softproof` in [print_cmds.rs](../../src-tauri/src/print_cmds.rs); `session_frame_hash` in [session.c](../../../engine/session.c); `Session.redraw` |
| Performance | [benchmarking/README.md](../../../benchmarking/README.md), [tracing flow](performance-tracing.md) | [perf.ts](../../src/perf.ts), [perfDiagnostics.ts](../../src/perfDiagnostics.ts), [PerfHud.tsx](../../src/PerfHud.tsx); `perf_*` in [app_cmds.rs](../../src-tauri/src/app_cmds.rs), [perf_trace.rs](../../src-tauri/src/perf_trace.rs); [diagnose.py](../../../benchmarking/diagnose.py) |
| Move to another darktable commit or release | [darktable-pin.md](darktable-pin.md) | [patches/darktable-engine.patch](../../../patches/darktable-engine.patch) |
| A release | the five version files ([package.json](../../package.json), `package-lock.json`, [Cargo.toml](../../src-tauri/Cargo.toml), `Cargo.lock`, [tauri.conf.json](../../src-tauri/tauri.conf.json)) | [releasing.md](releasing.md): the work on `release-X.Y.Z`, tagged `vX.Y.Z` there; [build_dmg.sh](../../scripts/build_dmg.sh) |

## Files

Front end ([`app/src`](../../src)):

- [settings.ts](../../src/settings.ts): the synchronous settings store every module uses instead of localStorage; [main.tsx](../../src/main.tsx) waits for it, then [boot.tsx](../../src/boot.tsx) starts the app
- [App.tsx](../../src/App.tsx): the editor's shell and state, with its components in [Toolbar.tsx](../../src/Toolbar.tsx), [Filmstrip.tsx](../../src/Filmstrip.tsx), [ActivityBar.tsx](../../src/ActivityBar.tsx), [FileMenu.tsx](../../src/FileMenu.tsx), [HistogramView.tsx](../../src/HistogramView.tsx), [Navigator.tsx](../../src/Navigator.tsx), [PanelView.tsx](../../src/PanelView.tsx), [Controls.tsx](../../src/Controls.tsx), [icons.tsx](../../src/icons.tsx), [layoutPrefs.ts](../../src/layoutPrefs.ts) and [zoom.ts](../../src/zoom.ts); [session.ts](../../src/session.ts): one open photo, edits to the engine, renders, saves; [engineState.ts](../../src/engineState.ts): engine restarts and the restore after one
- [manifest.ts](../../src/manifest.ts): panels, controls, and their mapping to darktable params; math in [wb.ts](../../src/wb.ts), [tonecurve.ts](../../src/tonecurve.ts), [transform.ts](../../src/transform.ts), [colorgrading.ts](../../src/colorgrading.ts), [colorequal.ts](../../src/colorequal.ts), [autoTone.ts](../../src/autoTone.ts), [bwauto.ts](../../src/bwauto.ts)
- masks: [masks.ts](../../src/masks.ts) (shapes, overlay pixels), [localMerge.ts](../../src/localMerge.ts) (shared instances), [MaskOverlay.tsx](../../src/MaskOverlay.tsx), [MasksPanel.tsx](../../src/MasksPanel.tsx), [ParametricEditor.tsx](../../src/ParametricEditor.tsx); design in [masks.md](masks.md)
- heal, negatives, zones: [spots.ts](../../src/spots.ts), [SpotOverlay.tsx](../../src/SpotOverlay.tsx), [HealPanel.tsx](../../src/HealPanel.tsx); [negadoctor.ts](../../src/negadoctor.ts), [NegativePanel.tsx](../../src/NegativePanel.tsx) (including input and working color profiles); [zones.ts](../../src/zones.ts), [ZoneSystem.tsx](../../src/ZoneSystem.tsx)
- film simulation: [spektrafilm.ts](../../src/spektrafilm.ts) (params, stock hash, presets), [FilmPanel.tsx](../../src/FilmPanel.tsx) and [NegativePanel.tsx](../../src/NegativePanel.tsx) as numbered steps in [GuidedSteps.tsx](../../src/GuidedSteps.tsx); [PositiveFooter.tsx](../../src/PositiveFooter.tsx) (Export to Library and Turn Off, shared with Negative); `CONVERSIONS` in manifest.ts; the engine's `film_spektra_stocks` and `film_spektra_fetch` in [film.c](../../../engine/film.c), and `_held_for_mode` in [session.c](../../../engine/session.c)
- canvas layers: [canvasLayers.ts](../../src/canvasLayers.ts) keeps canvas allocations and immutable frame uploads, reuses a sharp canvas for the base, and skips unchanged placement styles
- frames to the page: [sharedFrames.ts](../../src/sharedFrames.ts) (Windows and Linux shared memory), [pixelRatio.ts](../../src/pixelRatio.ts) (Wayland draft scale)
- library: [library.ts](../../src/library.ts), [FolderTree.tsx](../../src/FolderTree.tsx), [filter.ts](../../src/filter.ts), [FilterPopup.tsx](../../src/FilterPopup.tsx); merges in [HdrDialog.tsx](../../src/HdrDialog.tsx), [PanoDialog.tsx](../../src/PanoDialog.tsx)
- export: [exportSettings.ts](../../src/exportSettings.ts), [exportTokens.ts](../../src/exportTokens.ts), [ExportDialog.tsx](../../src/ExportDialog.tsx), [ExportFrame.tsx](../../src/ExportFrame.tsx); background work in [background.ts](../../src/background.ts), [activity.ts](../../src/activity.ts)
- print: [print.ts](../../src/print.ts) (settings, papers, single and Cells page layouts, soft proof), [PrintPanel.tsx](../../src/PrintPanel.tsx); the engine's [print.c](../../../engine/print.c)
- [AdvancedPanel.tsx](../../src/AdvancedPanel.tsx): Advanced editing mode's Adjustments: the module search and a group body (`AdvancedGroup`, also the Technical group), hooked in from `PanelView`; `loadEditMode` in Preferences.tsx; groups render `ModuleCard` ([ModuleCard.tsx](../../src/ModuleCard.tsx), with its instance menu in [InstanceMenu.tsx](../../src/InstanceMenu.tsx)) from `Session.instances` / `Session.advanced`, with per-module layouts in [advancedLayout.ts](../../src/advancedLayout.ts)
- [LensPicker.tsx](../../src/LensPicker.tsx): Lens Corrections' lens drop-down with a search box (`lenses` in edit_cmds.rs and the engine's [main.c](../../../engine/main.c), [lenses.cc](../../../engine/lenses.cc); `lens_pick` in manifest.ts)
- [Presets.tsx](../../src/Presets.tsx) (presets, looks), [HistoryPanel.tsx](../../src/HistoryPanel.tsx), [CopySettings.tsx](../../src/CopySettings.tsx), [ColorWheel.tsx](../../src/ColorWheel.tsx), [PointCurve.tsx](../../src/PointCurve.tsx), [CropTool.tsx](../../src/CropTool.tsx), [VignetteOverlay.tsx](../../src/VignetteOverlay.tsx), [GuideOverlay.tsx](../../src/GuideOverlay.tsx), [MetadataPanel.tsx](../../src/MetadataPanel.tsx), [Keywording.tsx](../../src/Keywording.tsx)
- Immich and plugins: [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx), [ImmichPrefs.tsx](../../src/ImmichPrefs.tsx); [plugins.ts](../../src/plugins.ts), [PluginPrefs.tsx](../../src/PluginPrefs.tsx)
- [PerformanceTuner.tsx](../../src/PerformanceTuner.tsx), [previewTuning.ts](../../src/previewTuning.ts), [tunerOptions.ts](../../src/tunerOptions.ts), [tunerWorkload.ts](../../src/tunerWorkload.ts): quality-first preview search with trimmed-median metrics, performance option comparisons, relaunch verification and navigation workload recording
- [benchDrivers.ts](../../src/benchDrivers.ts): `runGuiBenchmark` and `runGpuCheck`, the Preferences GUI benchmark and GPU check drivers (App passes a `BenchContext`)
- [gpuCheck.ts](../../src/gpuCheck.ts): the GPU check's cases and verdicts (CPU vs OpenCL parity, `device_parity` in [device.c](../../../engine/device.c), `gpu_check_parity` in app_cmds.rs, [gpucheck.py](../../../benchmarking/gpucheck.py))
- [BackupDialog.tsx](../../src/BackupDialog.tsx): the Back Up and Restore dialog under Preferences > General, over backup.rs.
- [SelectMenu.tsx](../../src/SelectMenu.tsx): the app-drawn list every `<select>` opens (see architecture.md)
- [menu.ts](../../src/menu.ts): the File/Edit/Photo/View/Help menus, once for both platforms; [MenuBar.tsx](../../src/MenuBar.tsx) draws them in the title strip on Windows and Linux; `menu_set` in app_cmds.rs builds the macOS menu bar, its clicks come back as the `menu` event to `runMenuAction` in App.tsx; [actions.ts](../../src/actions.ts) is the table of key chords that run those same actions
- [Preferences.tsx](../../src/Preferences.tsx), [PrefsUI.tsx](../../src/PrefsUI.tsx); [histogram.ts](../../src/histogram.ts), [probe.ts](../../src/probe.ts); [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx); [aiModel.ts](../../src/aiModel.ts); [ImportView.tsx](../../src/ImportView.tsx) (the importer); [styles.css](../../src/styles.css)

Rust ([`app/src-tauri/src`](../../src-tauri/src)):

- [settings.rs](../../src-tauri/src/settings.rs): the settings store (`settings.json`; `settings_all`, `settings_set`)
- [main.rs](../../src-tauri/src/main.rs): `main()`, the setup, `AppState`; the commands live in one file per group: [session_cmds.rs](../../src-tauri/src/session_cmds.rs) (open, params, history, render and frames, save, preview), [library_cmds.rs](../../src-tauri/src/library_cmds.rs) (folders, import, thumbnails, metadata, trash, caches), [export_cmds.rs](../../src-tauri/src/export_cmds.rs) (export, merges, positives, presets files, file pickers), [immich_cmds.rs](../../src-tauri/src/immich_cmds.rs), [print_cmds.rs](../../src-tauri/src/print_cmds.rs), [edit_cmds.rs](../../src-tauri/src/edit_cmds.rs) (masks, spots, Upright, looks, AgX, film, lenses), [ai_cmds.rs](../../src-tauri/src/ai_cmds.rs) (AI, model downloads), [app_cmds.rs](../../src-tauri/src/app_cmds.rs) (Preferences, performance, GPU check, build, engine restart, native menu); [engine.rs](../../src-tauri/src/engine.rs): the engine child and its protocol
- [bindings.rs](../../src-tauri/src/bindings.rs): `collect_commands!`, the list of every command, and the exported [bindings.ts](../../src/bindings.ts); reply types in `typed_session.rs`, `typed_library.rs`, `typed_export.rs`, `typed_edit.rs` and `typed_app.rs` beside it
- [memory_budget.rs](../../src-tauri/src/memory_budget.rs) (the one memory budget from RAM x the Memory level; page side [memoryBudget.ts](../../src/memoryBudget.ts)); [immich_search.rs](../../src-tauri/src/immich_search.rs), [immich_upload.rs](../../src-tauri/src/immich_upload.rs); [plugins.rs](../../src-tauri/src/plugins.rs) (Edit In); [listing.rs](../../src-tauri/src/listing.rs) (folder listings with sizes and times); [volumes.rs](../../src-tauri/src/volumes.rs) (drives, and whether each answers); [scale.rs](../../src-tauri/src/scale.rs) (Wayland scale); [renderer.rs](../../src-tauri/src/renderer.rs) (Linux interface EGL selection before GTK starts); [webext/frames.c](../../src-tauri/webext/frames.c) (Linux shared frames); [backup.rs](../../src-tauri/src/backup.rs) (Backup: one .zip of the parts chosen, checked and staged before a restore).

Engine ([`engine/`](../../../engine)):

- [main.c](../../../engine/main.c): `main()`, the `_commands[]` table (`_cmd_<name>` handlers and flags), `_handle`, `_read_requests`, replies, yield, crash handler, memory pressure
- one file per area, with its prefix on what other files call: [session.c](../../../engine/session.c) (`session_`: open and close, four pipes (main, preview, drag, base) over the open photo, set and get, render, save), [library.c](../../../engine/library.c) (`library_`: folders, import, thumbnails, metadata, sidecars), [export.c](../../../engine/export.c) (`export_`: export, frames, positives, HDR and Panorama glue), [masks.c](../../../engine/masks.c) (`masks_`: masks, spots, ranges, zones, sampling, Upright), [ai.c](../../../engine/ai.c) (`ai_`, `HAVE_AI`), [device.c](../../../engine/device.c) (`device_`: OpenCL, GPU check), [looks.c](../../../engine/looks.c) (`looks_`), [film.c](../../../engine/film.c) (`film_`); [engine.h](../../../engine/engine.h) holds the shared types and prototypes, documents the lock order and checks it in debug builds
- [print.c](../../../engine/print.c) (printer profiles, soft proof, printers, print jobs and PDFs, from darktable's print view), [upright.c](../../../engine/upright.c) (Upright, from ashift.c), [hdrmerge.c](../../../engine/hdrmerge.c) (HDR Merge), [pano.cc](../../../engine/pano.cc) and [dng.c](../../../engine/dng.c) (Panorama Merge), [strip.cc](../../../engine/strip.cc) (export metadata)

Checks and tools: [release asset tests](../../../scripts/test_release_assets.py) (`python3 -I scripts/test_release_assets.py`), [engine-state tests](../../../verify/engine-state.test.mjs) (`node --test verify/engine-state.test.mjs`), [engine-command check](../../../verify/engine-commands.test.mjs) (sent commands exist in the `_commands[]` table in main.c); [engine-protocol.py](../../../verify/engine-protocol.py) (headless golden replies, `--record` / `--compare`), [verify/](../../../verify/README.md) (the release checks: `Session` under Node against the engine), [benchmarking/](../../../benchmarking/README.md), `cargo test` in `app/src-tauri`, `npm run build` (type check), [darktable-pin.md](darktable-pin.md), and darktable's own [dev-doc/](../../../darktable/dev-doc/README.md). CI's checks job runs `cargo test` and the `verify/*.test.mjs` files that need no engine (listed in [build.yml](../../../.github/workflows/build.yml)).

[verify/thumbnail-io.cc](../../../verify/thumbnail-io.cc) is the optional
`immage-thumbnail-check` CMake target: metadata prefixes, late metadata
fallback, embedded JPEG equality, orientation and scaled decoding.


## Keeping this map current

- Add a file to its line here and its entry in [architecture.md](architecture.md); keep this map short, as it is read at the start of every session.
- Refer to code by symbol, not line number.

Support bundle: [scrub.rs](../../src-tauri/src/scrub.rs) (the scrubber),
[support_bundle.rs](../../src-tauri/src/support_bundle.rs) (`support_bundle_*` commands, zip),
[SupportBundleDialog.tsx](../../src/SupportBundleDialog.tsx) (review and remove lines); opened from Help
(`support-bundle` in menu.ts) and from the engine-exit status in App.tsx.

GUI benchmark resource sampling: [resources.rs](../../src-tauri/src/resources.rs)
records CPU, process memory, Linux threads and available GPU counters on a
background worker; `App.tsx` attaches phase timestamps to report version 5.
The GUI dashboard plots these alongside timing summaries.

Module switch: [ModuleSwitch.tsx](../../src/ModuleSwitch.tsx) is the panel icon and menu beside a
multi-module tool's name, with a green dot when `Session.adjustedModules` (masks: `maskAdjusted`) finds
edits in another module (hosts chosen in `PanelView` and `MasksPanel`); its
Set as default writes the Preferences choice.

Module options: [moduleChoice.ts](../../src/moduleChoice.ts) resolves saved
choices and preferences; [ModulePrefs.tsx](../../src/ModulePrefs.tsx) displays
`MODULE_CHOICES` and `MASK_MODULE_CHOICES` from the manifest under Global and
Masks. It receives `focusMode` from PreferencesDialog and uses the panels'
normal/Alt-click folding behavior. Closing Preferences reapplies choices to
unused global and mask tools in the current session.
[ContrastEqualizer.tsx](../../src/ContrastEqualizer.tsx) edits global or per-mask
`atrous` curves (`EQ_IDS`, `equalizerMap` in manifest.ts); mask choices live
in each `Mask.values`, separate from `Session.values`.
[SaturationCurve.tsx](../../src/SaturationCurve.tsx) edits global or per-mask
`satcurvergb` saturation and brilliance curves (`SATCURVE_IDS`, `satcurveMap`).
[DetailControls.tsx](../../src/DetailControls.tsx) lays out contrast & texture
controls, with Medium/Fine always visible and the rest only when the panel's
advanced toggle is on, and, under the same toggle, Whites' Highlight
Brilliance (`whites_brilliance`, AgX only).
[advanced.tsx](../../src/advanced.tsx) holds `useAdvanced` (per-panel state,
remembered) and `AdvancedToggle` (the title-row icon, with a dot for hidden
edits).

Metadata: [CaptureTimeDialog.tsx](../../src/CaptureTimeDialog.tsx) previews and
confirms batch offsets and restoration; App.tsx owns the last batch and calls
`capture_times`. [LocationEditor.tsx](../../src/LocationEditor.tsx) edits GPS via
`meta_set`; [map_tiles.rs](../../src-tauri/src/map_tiles.rs) serves map tiles.
`positive_export` in Rust export_cmds.rs writes and imports a positive; engine export.c
uses `_positive_import` for its neutral starting history. App.tsx handles generated
results and the Open generated photos preference, including results outside
an active Immich search.

Native detail previews: [detailPreview.ts](../../src/detailPreview.ts) identifies controls eligible for the loupe. `Session.draftView` selects native whole-image drafts or the detail crop; release requests the exact full view. Adaptive cached preview interpolation was removed after latency and visual quality regressed.

### Transform sampling regression

`masks_upright` in `engine/masks.c` reads `_STAGE_ASHIFT` through `_working_at`,
before geometry. Rendering the current crop can request an input region with
nonzero x/y, including on EXIF-oriented portraits. Upright forces that region's
producer and later cache entries to rerender, accepts its offset, and passes
x/y/scale to `upright_detect` so detected lines remain in sensor coordinates.
Other working-space consumers retain their origin-zero check. Do not relax
that check for mask sampling: a stale zoom region would clamp mask samples.

Run `python3 verify/transform-sampling.py` after building the engine. This
headless CPU check generates landscape, native portrait, both EXIF quarter
turns and mirrored portrait TIFFs above the 1600-pixel detection limit. It
renders at a different scale, checks all four automatic modes before/after a
crop and after restoring the frame, and applies each result before the next
fit. `--write-corpus benchmarking/corpus` retains the synthetic photos in the
ignored local corpus. This verifies engine sampling, not visible controls,
OpenCL or camera RAW decoding; retain real portrait RAWs for those checks.
