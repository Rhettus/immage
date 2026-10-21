# Code map

Immage is a Lightroom-style editor built on darktable. It runs as three
processes:

- **The WebView.** It runs the React front end in [`app/src`](../../src):
  every panel, the viewer, the library and export.
- **The Tauri core.** It runs the Rust layer in
  [`app/src-tauri/src`](../../src-tauri/src): windows, files, Immich, plugins,
  and the one gate to the engine.
- **`darktable-engine`.** A headless darktable session in
  [`engine/main.c`](../../../engine/main.c), started by the Rust layer
  as a child process and spoken to in JSON, one line per request.

All image processing is darktable's own pixelpipe and modules. Immage maps
Lightroom's controls onto darktable module parameters, and darktable's source
(the `darktable/` submodule) is changed only where listed under
[darktable additions](#darktable-additions).

Diagrams of the same ground:

- [data flow](diagrams/dataflow.svg)
- [entities](diagrams/entities.svg)
- [one slider move](diagrams/slider-sequence.svg)

The editable sources are `.excalidraw` files in [`diagrams/`](diagrams/).
Paths below are relative to this file.

## Where to start a change

| Work | Start here | Related work |
|---|---|---|
| Remap a slider, or add one to an existing panel | `modules` and `panels` in [manifest.ts](../../src/manifest.ts) | the module's math file ([wb.ts](../../src/wb.ts), [tonecurve.ts](../../src/tonecurve.ts), ...), and [lib/edits.mjs](../../../benchmarking/lib/edits.mjs), which reads the manifest for the benchmark |
| A new panel or section | `panels` in [manifest.ts](../../src/manifest.ts) | `PanelView` in [App.tsx](../../src/App.tsx) for a custom graph; [CopySettings.tsx](../../src/CopySettings.tsx) groups |
| A per-mask (local) adjustment | `LOCAL_CONTROLS` and `localMaps` in [manifest.ts](../../src/manifest.ts) (`merge` and `fixed` for a module masks share) | [MasksPanel.tsx](../../src/MasksPanel.tsx), [localMerge.ts](../../src/localMerge.ts); the engine's `_named_instance`, `_attach_mask` and `_combine` |
| A new mask shape or kind | [masks.ts](../../src/masks.ts) (`Shape`) | [MaskOverlay.tsx](../../src/MaskOverlay.tsx), `Session.addMask`, the engine's `_shape` / `_mask` |
| A new engine command | `_handle()` in [main.c](../../../engine/main.c) | a `#[tauri::command]` in [main.rs](../../src-tauri/src/main.rs), registered in `invoke_handler`; the caller in [session.ts](../../src/session.ts) or [App.tsx](../../src/App.tsx) |
| Rendering, frames, zoom | `Session.pump` / `renderView` in [session.ts](../../src/session.ts) | `currentView`, `paintFrame`, `animateTo` in [App.tsx](../../src/App.tsx); `render` in [main.rs](../../src-tauri/src/main.rs); `_render` in [main.c](../../../engine/main.c) |
| An export option | `Settings` in [exportSettings.ts](../../src/exportSettings.ts) | [ExportDialog.tsx](../../src/ExportDialog.tsx); `export_images` in [main.rs](../../src-tauri/src/main.rs); `_export` / `_frame_style` in [main.c](../../../engine/main.c) |
| An AI feature | `runAi` / `runDenoise` in [App.tsx](../../src/App.tsx) | `ai_model_ensure` in [main.rs](../../src-tauri/src/main.rs); the `HAVE_AI` section of [main.c](../../../engine/main.c); darktable's `src/ai` and `src/common/ai` |
| A preference | [Preferences.tsx](../../src/Preferences.tsx) (a `load*`/`store*` pair and a `PrefRow`) | [PrefsUI.tsx](../../src/PrefsUI.tsx); the consumer calls `load*()` live |
| An Immich call | [immich_search.rs](../../src-tauri/src/immich_search.rs) or [immich_upload.rs](../../src-tauri/src/immich_upload.rs) | `immich_*` commands in [main.rs](../../src-tauri/src/main.rs); [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx) |
| An Edit In plugin kind | `KINDS` in [plugins.ts](../../src/plugins.ts) | [plugins.rs](../../src-tauri/src/plugins.rs); `editIn` in [App.tsx](../../src/App.tsx) |
| Performance | [benchmarking/README.md](../../../benchmarking/README.md) | [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx); `perf_*` in [main.rs](../../src-tauri/src/main.rs) |
| Move to another darktable commit or release | [darktable-pin.md](darktable-pin.md) | [patches/darktable-engine.patch](../../../patches/darktable-engine.patch) |
| A release | the five version files ([package.json](../../package.json), `package-lock.json`, [Cargo.toml](../../src-tauri/Cargo.toml), `Cargo.lock`, [tauri.conf.json](../../src-tauri/tauri.conf.json)) | tag `immage-X.Y.Z`; [build_dmg.sh](../../scripts/build_dmg.sh) |

## Entry points and process boundary

| File | Responsibility |
|---|---|
| [index.html](../../index.html), [main.tsx](../../src/main.tsx) | The main window: mounts `App`. |
| [splash.html](../../splash.html), [Splash.tsx](../../src/Splash.tsx) | The splash window: asks `about`, shows the main window, closes itself. |
| [App.tsx](../../src/App.tsx) | The whole editor's shell and state. See [inside App.tsx](#inside-apptsx). |
| [main.rs](../../src-tauri/src/main.rs) | `main()`: migrates the old app name, registers the dialog, opener and immporter plugins. `setup()` picks the engine: `build/bin/darktable-engine` with runtime state in `build/app-runtime` for a dev build, the bundled `resources/darktable` with the app data folder for a release, or `DT_ENGINE_BIN`. Holds `AppState` and nearly every command. |
| [engine.rs](../../src-tauri/src/engine.rs) | The engine child. Spawns it (`--core --configdir --cachedir -d perf`, OpenCL on with only export's pipe type allowed the GPU, which the base borrows), retrying while an old one holds darktable's database lock. `request()` writes one JSON line and reads one back. A stderr thread writes the log and keeps darktable's `-d perf` timings apart for the performance overlay. |
| [engine/main.c](../../../engine/main.c) | `main()`: keeps the real stdout for replies, starts darktable with an in-memory library (`dt_init`), sets its confs, then loops: read a line, `_handle()` it, reply. |

The boundary is strict. The front end never touches files or darktable
directly. It calls `invoke(...)` commands, and every command that needs the
engine goes through the one `Mutex<Engine>` in `AppState`, so engine work is
serialized, one request at a time. Large results are binary and travel as
`tauri::ipc::Response`:

| Result | Format |
|---|---|
| Frames | a 48-byte header (six u32: size, image size, window x/y; six f32 timings), then RGBA |
| Thumbnails | an 8-byte header (u32 width, u32 height), then RGBA |
| Range and mask maps | an 8-byte header (u32 width, u32 height), then RGBA |

The engine writes these into scratch files in the runtime folder, and Rust
reads them back while it still holds the engine.

On Windows a frame doesn't come back in the reply. WebView2 copies a reply
into a COM stream on the UI thread and reads it across two process
boundaries, at 125-240 MB/s against the Mac's 3-4 GB/s. `render` instead
writes the frame into a WebView2 shared buffer (`shared_frame` in main.rs),
posts it to the page tagged with an id, and replies with the 48-byte
header alone; [sharedFrames.ts](../../src/sharedFrames.ts) puts the two
back together. [benchmarking/](../../../benchmarking/README.md) measures
its timings.

## Front end

State lives in React `useState` and refs, mostly in `App`, plus three small
module stores: [activity.ts](../../src/activity.ts),
[probe.ts](../../src/probe.ts) and [perf.ts](../../src/perf.ts). Preferences
are `localStorage` keys named `immage.*`.

### Shell

| File | Responsibility |
|---|---|
| [App.tsx](../../src/App.tsx) | Library, viewer, panels, tools, undo, before/after, compare, keyboard, plugins; also the small components `PanelView`, `Slider`, `Filmstrip`, `HistogramView`, `Navigator`, `Toolbar`. |
| [Tour.tsx](../../src/Tour.tsx), [Shortcuts.tsx](../../src/Shortcuts.tsx) | The quick-start tour; the keyboard shortcuts sheet. |
| [ImportView.tsx](../../src/ImportView.tsx) | The SD card importer, loaded from `@immporter/embed`. |
| [Collapse.tsx](../../src/Collapse.tsx), [keys.ts](../../src/keys.ts), [paths.ts](../../src/paths.ts) | Folding panels; ⌘ or Ctrl by platform; path helpers for either separator. |
| [activity.ts](../../src/activity.ts) | The busy indicator's job store (`begin`, `progress`, `end`, `useWorking`). |
| [styles.css](../../src/styles.css) | All styling. |

### Inside App.tsx

| Part | What it holds |
|---|---|
| Viewer core | refs `session`, `canvas`, `baseCanvas`, `center`, `viewZ`; `dragging` / `draftShown` (drag drafts); `scheduleBase` (the idle whole-image render) |
| `currentView` | the `View` asked for: fitted to the viewer (capped at `MAX_PREVIEW`), a zoomed window, or a half-size draft while dragging |
| `paintFrame` / `drawFrame` | a `Frame` onto the canvas; the histogram; `showOverview` for a whole-image frame (base layer, navigator) |
| `animateTo`, `setZoom` | eased zoom; renders wait until it settles |
| `openFile` / `openEntry` | open a photo: `Session.open`, then the new-photo defaults (tone mapper, profile, preset, Edit In returns) |
| `change` / `changeMany` | every control edit: undo step, `values` state, `Session.set` |
| undo (`record`, `restore`, `Snap`) | snapshots of values, masks, spots and look |
| before/after, compare | `setBaMode`, `setBefore` (`Session.showBefore`), `toggleCompare` |
| crop and turns | `enterCrop`, `leaveCrop`, `turn` (`Session.turned`) |
| `runGuiBenchmark` | the GUI benchmark in Preferences |
| keyboard | one `keydown` handler for every shortcut |
| `openLaunched`, `dropped` | a photo handed over (`launch-file`), or photos and folders dragged onto the window (`onDragDropEvent`, `path_kind`) |

### Session and engine bridge

| File | Responsibility |
|---|---|
| [session.ts](../../src/session.ts) | One open photo. `Session.open` reads every mapped module (`get_params`) into control values. `set`/`setMany` mark modules dirty, and `pump()` sends each dirty module's merged edit (`moduleEdit`) and one `render`, so moves made during a render are coalesced, latest wins. It also holds masks, spots, look and the Before view, and saves 600 ms after the last edit. `renderView` decodes the frame header; `preview` renders one-off settings on the engine's preview pipe. |
| [sharedFrames.ts](../../src/sharedFrames.ts) | Windows: `renderFrame` asks `render` to post the frame in a WebView2 shared buffer tagged with an id, then matches the `sharedbufferreceived` event to the reply, copies the frame out and releases the buffer. On the Mac, on WebView2 runtimes before 1.0.1661, or with Preferences' "Shared-memory frames" off, the frame comes in `render`'s reply. |
| [HistoryPanel.tsx](../../src/HistoryPanel.tsx) | darktable's history plus this session's undo steps. |
| [CopySettings.tsx](../../src/CopySettings.tsx) | Copy/Paste Settings: which groups, and the clip. |

### Control mapping (pure math, no Tauri)

| File | Responsibility |
|---|---|
| [manifest.ts](../../src/manifest.ts) | The Lightroom panels and controls (`panels`, `Control`), and the `ModuleMap`s that translate control values to darktable params and back (`modules`, per-mask `localMaps`). `boundFields` lists every field the app reads. `"op#name"` is a named module instance. |
| [wb.ts](../../src/wb.ts) | Temp/Tint and color calibration's illuminant. |
| [tonecurve.ts](../../src/tonecurve.ts) | Parametric and point curves and tonecurve nodes. |
| [transform.ts](../../src/transform.ts), [colorgrading.ts](../../src/colorgrading.ts) | Rotate/ashift and auto-crop; color balance hues. |
| [GuideOverlay.tsx](../../src/GuideOverlay.tsx) | The Transform grid and Guided Upright's guides on the photo. |
| [autoTone.ts](../../src/autoTone.ts), [bwauto.ts](../../src/bwauto.ts) | Basic's Auto and the B&W Mix's Auto, from the rendered frame. |

### Panels and controls

| File | Responsibility |
|---|---|
| [ColorWheel.tsx](../../src/ColorWheel.tsx), [PointCurve.tsx](../../src/PointCurve.tsx) | Color grading wheels; the point curve editor. |
| [CropTool.tsx](../../src/CropTool.tsx), [VignetteOverlay.tsx](../../src/VignetteOverlay.tsx) | Crop overlay and aspects; vignette guides. |
| [MetadataPanel.tsx](../../src/MetadataPanel.tsx), [Keywording.tsx](../../src/Keywording.tsx) | The left panel's metadata and keywords cards. |

### Masks, heal and zones

| File | Responsibility |
|---|---|
| [masks.ts](../../src/masks.ts) | `Mask` and `Shape` (ellipse, gradient, brush, luminance/color/parametric ranges, AI object or depth), in shown-image units 0-1; overlay and thumbnail pixels. The overlay keeps each shape's coverage per grid (`cover`), and a brush stroke being painted is stamped around its newest segment only (`brushCover`). |
| [localMerge.ts](../../src/localMerge.ts) | `planMerge`: which masks share instances of a `merge` module (color balance rgb, color equalizer for HSL, diffuse for Texture, denoise, chromatic aberrations for Defringe), grouped by direction or by slider and sign, whichever needs fewer; each shared instance's strength and each mask's opacity in its combined mask. Masks share only with masks of the same ranges and refinements, which the shared instance carries; an inverted mask with ranges, ranges alone and refine Contrast keep their own instances (`canMerge`). |
| [MaskOverlay.tsx](../../src/MaskOverlay.tsx), [MasksPanel.tsx](../../src/MasksPanel.tsx), [ParametricEditor.tsx](../../src/ParametricEditor.tsx) | Drawing shapes on the photo; the Masks panel; darktable's parametric (blendif) editor. |
| [spots.ts](../../src/spots.ts), [SpotOverlay.tsx](../../src/SpotOverlay.tsx), [HealPanel.tsx](../../src/HealPanel.tsx) | Heal/Clone spots, sent to darktable's retouch module. |
| [zones.ts](../../src/zones.ts), [ZoneSystem.tsx](../../src/ZoneSystem.tsx) | The Zone System: zone statistics, the placement curve (a tone equalizer instance ahead of the mask anchor), zone masks. |

### Presets and looks

| File | Responsibility |
|---|---|
| [Presets.tsx](../../src/Presets.tsx) | Develop presets (control values in `presets.json`, versioned), looks (darktable styles from `app/looks`), the preview tile cache, the panel and the New Preset dialog. |

### Library and filmstrip

| File | Responsibility |
|---|---|
| [library.ts](../../src/library.ts) | `ImageEntry`; `openFolder` (batches arriving as `folder-progress` events); RAW+JPEG pairing; `ThumbLoader`, which fetches thumbnails only while the engine is idle. |
| [FolderTree.tsx](../../src/FolderTree.tsx) | The folder tree. |

### Export

| File | Responsibility |
|---|---|
| [exportSettings.ts](../../src/exportSettings.ts) | Export `Settings`, presets (built-in, local, shared file) and frame items (borders, keylines, captions). |
| [exportTokens.ts](../../src/exportTokens.ts) | File name and caption tokens. |
| [ExportDialog.tsx](../../src/ExportDialog.tsx), [ExportFrame.tsx](../../src/ExportFrame.tsx) | The Export dialog, its live preview, the Immich target; the Frame & Captions editor. |

### Immich and plugins

| File | Responsibility |
|---|---|
| [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx), [ImmichPrefs.tsx](../../src/ImmichPrefs.tsx) | Search, remote assets as `ImageEntry`, path maps from Immich to local files; the Library's Immich card; connection settings (from the immporter). |
| [plugins.ts](../../src/plugins.ts), [PluginPrefs.tsx](../../src/PluginPrefs.tsx) | Edit In: plugin kinds (`KINDS`, DxO PureRAW today), configs, returns; the Plugins preferences tab. |

### Preferences, histogram, probe, performance

| File | Responsibility |
|---|---|
| [Preferences.tsx](../../src/Preferences.tsx), [PrefsUI.tsx](../../src/PrefsUI.tsx) | The Preferences dialog and its `load*`/`store*` pairs; `PrefCard`, `PrefRow`, `PrefSwitch`. |
| [histogram.ts](../../src/histogram.ts) | Histogram (computed on the main thread from the frame), clipping overlay, scopes. |
| [probe.ts](../../src/probe.ts) | The color under the pointer, for the Tone Curve, HSL and B&W cards. |
| [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx) | Edit-to-pixels timing by stage, the performance overlay and the GUI benchmark's recording. |

## Rust layer

| File | Responsibility |
|---|---|
| [main.rs](../../src-tauri/src/main.rs) | `AppState` (the engine, scratch file paths, looks and models folders, the folder-read token, perf state); every command except plugins'; AI model download (`install_model`, `install_extra`, through reqwest, sha256 checked, darktable's archives unpacked by the engine's `unpack`); export (naming conflicts, Immich upload); presets and looks files; launch-file handling. |
| [engine.rs](../../src-tauri/src/engine.rs) | The engine child and its protocol (above); `perf_mark` and the `-d perf` parser. |
| [immich_search.rs](../../src-tauri/src/immich_search.rs), [immich_upload.rs](../../src-tauri/src/immich_upload.rs) | Immich: search, thumbnails, originals (cached); album and upload calls. The API key never reaches the front end. |
| [plugins.rs](../../src-tauri/src/plugins.rs) | Edit In: find apps, launch with files, poll their output folders, remember each result (`plugin-returns.json`). |
| [Cargo.toml](../../src-tauri/Cargo.toml), [tauri.conf.json](../../src-tauri/tauri.conf.json), [capabilities/](../../src-tauri/capabilities) | Dependencies (each with its reason); windows, bundle resources (`resources/darktable`, `looks`, `sample`); window permissions. |

Commands by what they reach:

| Reaches | Commands |
|---|---|
| The open photo, through the engine | `open_image`, `get_params`, `set_params`, `render`, `cancel_base`, `preview`, `save`, `before_view`, `history`, `masks`, `mask_shapes`, `combine`, `mask_delete`, `mask_rename`, `mask_map`, `range_map`, `sample`, `zones`, `tone_key`, `agx_auto`, `spots`, `spots_enable`, `spot_source`, `look_apply`, `look_amount`, `ai_object`, `ai_mask`, `ai_depth`, `ai_denoise`, `ai_denoise_preview` |
| The library, through the engine | `open_folder` (engine `import` in batches of 24), `thumb`, `meta`, `meta_set`, `keywords`, `keywords_set`, `create_virtual_copy`, `remove_virtual_copy`, `trash_files`, `export_images`, `export_preview`, `fonts`, `ai_accel`, `about` |
| Files only | `list_subfolders`, `path_exists`, `path_kind`, `export_existing`, `presets_load`, `presets_save`, `export_presets_load`, `export_presets_save`, `preset_file_read`, `preset_file_write`, `looks_list`, `sample_folder`, `launch_file` |
| AI models (download, then the engine's `version`) | `ai_model_ensure` |
| Immich (HTTP) | `immich_albums`, `immich_create_album`, `immich_export_check`, `immich_browse_check`, `immich_search`, `immich_libraries`, `immich_suggestions`, `immich_people`, `immich_tags`, `immich_thumb`, `immich_resolve` |
| Plugins | `plugin_find_apps`, `plugin_launch`, `plugin_watch`, `plugin_cancel`, `plugin_returns`, `plugin_return_applied` |
| Performance | `perf_set`, `perf_modules`, `perf_report_write` |
| The window | `preview_fullscreen` |

Events from Rust: `folder-progress`, `export-progress`, `ai-model`,
`launch-file`, `plugin-returned`, `plugin-watch-end`. The immporter plugin
emits its own (`import-done`, `volumes-changed`, ...).

## Engine

[`engine/main.c`](../../../engine/main.c) is one file. The engine
holds one session, `_s` (`dt_engine_session_t`): the open image, its develop
(`dt_develop_t`, the module list and history) and four pipes over it.

| Pipe | Built by | Input | Used for |
|---|---|---|---|
| `pipe` | `_open_image` | the full raw (`DT_MIPMAP_FULL`) | every frame (`render`); `full_width` / `full_height`. `render`'s `skip` leaves ops out of one frame (drag drafts skip grain and diffuse) |
| `ppipe` | `_ppipe_ready` | the full raw | `preview`, AI input, sampling, mask maps |
| `drag` | `_follower_ready` | the full raw | `render` with `draft`: a drag's frames, kept off the main pipe's cache so the release finds its earlier modules there |
| `base` | `_follower_ready` | the full raw | `render` with `base`: the idle whole-image render, on the GPU when there is one. `cancel_base` stops it (`_cancel_base`, from the stdin reader thread `_read_requests`) |

The preview pipe exists so trying a setting never touches the edit or the
main pipe's cache.

[`engine/upright.c`](../../../engine/upright.c) is Upright: the
structure detection and fit of darktable's rotate and perspective
(`src/iop/ashift.c`). darktable runs these only from its GUI, so the
GUI-free parts are copied unchanged, with the outlier removal and fit
rewritten to take the lines rather than `gui_data`. Its header names the
ashift.c revision it was copied from. Compare the two when taking a new
darktable release. `upright` in main.c reads the image as it enters
rotate and perspective from the preview pipe (`_working_at`,
`_STAGE_ASHIFT`). `points` maps points between the shown image and the
input, for Guided's guides.

Whether a photo is edited is darktable's own test, `dt_image_altered()`:
the history hash against its basic and automatic baselines, which the
sidecar carries. `open` replies `fresh` when the photo had no history
before loading; the client then applies its new-photo defaults, and every
`_save` stamps them as the automatic baseline (`history_auto_hash`) until
`baseline_end`, which `Session.endBaseline()` sends ahead of the user's
first recorded change. So the defaults never mark a photo edited, in
Immage or in darktable.

| Section | Main functions |
|---|---|
| Session, open, close | `_open_image`, `_close_session`, `_import`, `_compress_history` |
| Set and get params | `_set` (fields by introspection, `instance`, `mask`, `after`/`before` moves), `_get`, `_write_field`, `_named_instance` |
| Render | `_render` (and the `render` command's `skip`), `_write_rgba`, `_ppipe_ready`, `_preview` |
| Library | `_folder`, `_import_files`, `_thumb`, `_image_json`, `_meta_set`, `_keywords_set`, `_copy`, `_remove_copy`, `_sidecars` |
| Export | `_export` (darktable's export with flags); `_frame_style` (borders and a watermark SVG as a temporary style; a fixed canvas as one last border, sized so the file comes out exactly W x H); the AI upscale proxy format (`_upscale_ctx`) |
| Masks | `_mask` (shapes into a mask group, prefixed `immage: `), `_masks` (with `merged_in`), `_mask_delete`, `_mask_rename`, `_attach_mask`; the anchor is `colorbalancergb`. `_combine`: a group of masks' groups summed, each at its opacity (prefixed `immage combined: `), with the members' ranges, driving a shared instance, which `_attach_mask` attaches only to a combined mask; `_combined_member_changed` keeps it current when a member is reshaped or deleted. `_prune_off` keeps a mask's own switched-off instances (`_holds_mask_settings`). `_named_instance` places a mask's own instance after the shared ones of its module |
| AI (`HAVE_AI`) | `_ai_object` (SAM), `_ai_mask` (sky, subject, ...), `_ai_depth`, `_ai_denoise` (darktable's raw denoise into a DNG, repeating `src/libs/neural_restore.c`'s job on its public calls), `_ai_denoise_preview` (its 1:1 before and after, as the lib's raw preview makes them) |
| Spots | `_spots_set`, `_spots_json`, `_spot_source` (the retouch module) |
| Ranges and zones | `_sample`, `_range_map`, `_zones`, `_mask_map`, `_tone_key`, `_agx_auto` |
| Looks | `_look`, `_look_amount` (a darktable style, its instances scaled) |
| Save | `_save` (history to the database, compressed, history hash and `darktable\|changed`, XMP sidecar written) |

The commands `_handle()` serves:

| Group | Commands |
|---|---|
| Session | `open`, `history`, `save`, `baseline_end`, `before`, `close`, `quit`, `version`, `unpack`, `ai_accel`, `fonts` |
| Library (no photo needed) | `folder`, `import`, `thumb`, `meta`, `meta_set`, `keywords`, `keywords_set`, `copy`, `remove_copy`, `sidecars`, `export` |
| Edit | `set`, `get`, `render`, `preview`, `look`, `look_amount` |
| Masks and spots | `mask`, `combine`, `masks`, `mask_rename`, `mask_delete`, `mask_map`, `range_map`, `sample`, `spots`, `spots_enable`, `spot_source` |
| Tone | `tone_key`, `agx_auto`, `zones` |
| AI | `ai_object`, `ai_mask`, `ai_depth`, `ai_denoise`, `ai_denoise_preview` |

It relies on these parts of darktable (paths inside `darktable/`):

| Area | Files |
|---|---|
| Develop and history | `src/develop/develop.c` |
| Pipes and their cache | `src/develop/pixelpipe_hb.c`, `pixelpipe_cache.c` |
| Module params, by name | `src/develop/imageop.c`, `src/common/introspection.h` |
| Masks and blending | `src/develop/masks/`, `src/develop/blend.c` |
| Module order | `src/common/iop_order.c` |
| Image buffers | `src/common/mipmap_cache.c` |
| Images, film rolls, database | `src/common/image.c`, `film.c`, `database.c` |
| Looks and the export frame | `src/common/styles.c` |
| Export | `src/imageio/` |
| Metadata | `tags.c`, `metadata.c`, `ratings.c`, `colorlabels.c` |
| AI | `src/ai/` (backend), `src/common/ai/` (segmentation, restore) |

The engine has no build options of its own. It is built by
[`engine/CMakeLists.txt`](../../../engine/CMakeLists.txt) whenever
darktable is, and it has AI features when darktable is configured with
`USE_AI`.

## darktable additions

| File | Responsibility |
|---|---|
| `src/CMakeLists.txt` | `add_subdirectory(${IMMAGE_ROOT}/engine)`, from [patches/darktable-engine.patch](../../../patches/darktable-engine.patch). |

## How an operation moves through the app

1. **Open a photo.**
   1. `openFile` in App.tsx calls `Session.open`.
   2. That sends `open_image`, which reaches the engine's `open`: import into the in-memory library (reading an existing sidecar), `dt_dev_load_image`, build the main pipe on the full raw.
   3. It then calls `get_params` for every mapped field, and each `ModuleMap.read` turns them into control values. `history`, `masks` and `spots` follow.
   4. A never-edited raw then gets the new-photo defaults: tone mapper, profile, color noise reduction, the new-photos preset.
2. **Move a slider.**
   1. `Slider` calls `change()`, which records an undo step, updates `values` and calls `Session.set`.
   2. `pump()` sends `set_params` for each dirty module, then `render` for `currentView()`. Moves made meanwhile only mark modules dirty, so the next round sends the latest values once.
   3. In the engine, `_set` writes the fields and adds a history item, then `_render` calls `dt_dev_pixelpipe_process`. Only modules from the changed one onwards run; the rest come from the pipe cache.
   4. The frame is written to `frame.rgba`, read back by Rust and returned with its header (on Windows, in a shared buffer beside it).
   5. `drawFrame` puts it on the canvas and computes the histogram. See [the sequence diagram](diagrams/slider-sequence.svg).
3. **Drag and release.**
   1. While a control is held, `currentView` asks for half-size drafts.
   2. On release, one full frame is rendered.
   3. After 500 ms of quiet (300 ms zoomed in), `scheduleBase` asks for the whole image at up to 3072 px, which becomes the base layer, the navigator and the histogram.
   4. An edit made while that base renders sends `cancel_base` (`Session.pump`). Rust writes it to the engine's stdin without the engine lock, the engine's reader thread stops the base pipe at its next module, and the base comes back "canceled". `scheduleBase` asks again once editing pauses.
4. **Masks.**
   1. A shape goes into the session's mask list, and `pump()` sends `mask_shapes` (the engine's `mask`: a darktable mask group).
   2. A local slider sets its `localMaps` module on an instance named for the mask (`set_params` with `instance` and `mask`), placed after the anchor.
   3. For a `merge` module, `planMerge` decides which masks share. Their own instances are sent switched off, holding their settings, and the shared ones follow: `combine` for each combined mask's members, then `set_params` on its instance (`immage local: <op> <k>`). Only what changed since the last plan is sent. A photo's first mask edit sends every mask again, which turns a photo from before sharing into one that shares; opening it or the Before view does not (`Session.edited`). During a drag, the mask being edited is lifted out of the combined masks onto its own instances (`Session.lifted`), and it joins again before the frame at release. Its own instances run after the shared ones (`_named_instance`), so a drag frame reruns only them and what follows, while the other masks' combined mask stays in darktable's drawn mask cache.
   4. AI masks first ensure the model (`ai_model_ensure`, event `ai-model`), then `ai_mask` / `ai_object` return paths that become shapes.
5. **Save.**
   1. 600 ms after the last edit, `Session.scheduleSave` sends `save`. The engine writes history to the database, compresses it and writes the XMP sidecar beside the photo.
   2. `onSaved` refreshes the filmstrip thumbnail.
6. **Export.**
   1. `ExportDialog` calls `export_images`, one engine `export` per photo.
   2. The frame and captions become a temporary darktable style (borders plus a watermark SVG), and AI upscale wraps the chosen format.
   3. For Immich, Rust uploads each file and adds it to the album. Progress comes as `export-progress`.
7. **Import a folder.**
   1. `openFolder` calls `open_folder`. Rust walks the folder, skipping packages and sidecars, and sends engine `import` in batches of 24, each reported as `folder-progress`.
   2. A newer folder request cancels the older one through `folder_token`.
   3. Thumbnails follow from `ThumbLoader` (engine `thumb`) while the editor is idle.
8. **Edit In.**
   1. `editIn` calls `plugin_launch`, which opens the app with the files, then `plugin_watch`.
   2. Rust polls the output folder and emits `plugin-returned` for each finished file, saved in `plugin-returns.json`.
   3. Opening a returned file applies the plugin's return values, for example lens corrections off after PureRAW.
9. **Immich browse.**
   1. `ImmichPanel` searches through `immich_search`.
   2. Each asset becomes an `ImageEntry`. Opening one calls `immich_resolve`: the local file through the path map if it exists, otherwise the original downloaded into the cache.

## Where data lives

| Data | Location | Lifetime |
|---|---|---|
| Edits (history, masks, spots, looks) | the photo's XMP sidecar, written by the engine's `save` | permanent, beside the photo |
| darktable's library | in memory (`--library :memory:`) | the engine's run; rebuilt from sidecars on import |
| Preferences, layout, library folders, export settings, plugins | `localStorage`, keys `immage.*` (for example `immage.preview`, `immage.export`, `immage.library`, `immage.plugins`) | permanent, per WebView profile |
| Develop presets | `presets.json` in the runtime folder | permanent |
| Export presets | `export-presets.json` in the runtime folder; shared files from Import…/Export… | permanent |
| Edit In results | `plugin-returns.json` in the runtime folder | permanent |
| Engine config, cache, log | `config/`, `cache/`, `engine.log` in the runtime folder (`build/app-runtime` in dev, the app data folder in a release) | permanent; the log restarts past 5 MB |
| Frames, thumbnails, previews, maps | `frame.rgba`, `thumb.rgba`, `preview.rgba`, `range.bin` in the runtime folder | overwritten per request |
| AI models | `build/ai-models` (dev) or `<app data>/models` | until deleted |
| Immich thumbnails and originals | `cache/immich-thumbs`, `cache/immich-originals` | cache |
| Import catalog, Immich key | the immporter's SQLite catalog under the app data folder (`immporter/`); the key in the system keychain | permanent |
| Benchmark results | [benchmarking/results/](../../../benchmarking/results/) (GUI reports under `gui/` in a dev build, `<app data>/benchmarks` in a release) | permanent, tracked |
| Source photos | wherever the user keeps them | never written, except the sidecar |

## Tests and reference tools

| File | Coverage |
|---|---|
| `#[cfg(test)]` in [main.rs](../../src-tauri/src/main.rs), [engine.rs](../../src-tauri/src/engine.rs) | `cargo test` in `app/src-tauri`: model release lookup, folder listing, sha256, the `-d perf` parser. |
| `npm run build` in `app/` | Type checking (`tsc --noEmit`) and the production bundle; there is no front-end unit test runner (the release checks run the front end's `Session`). |
| [verify/](../../../verify/README.md) | The release checks: the app's `Session` run under Node against the engine (`harness.mjs`, with `shim.mjs` for Tauri's invoke), every slider and mask slider measured, an edit saved and opened again, old edits rendered, a check per bug fixed and per decision about Immage's behavior, and the benchmark's main timings against the last run. |
| [benchmarking/](../../../benchmarking/README.md) | The engine benchmark (driven with the app's own manifest), the GUI benchmark's reports, the dashboard. |
| `build/spike/*.py` | Untracked, local scripts that drive the engine headless, one per feature (masks, zones, frames, spots, AI). Useful patterns, not a suite. |
| `darktable/src/tests/integration/` | darktable's pixel tests; run them when a change reaches the pixelpipe or `src/iop/`. |
| `darktable-cli` | darktable's own headless render, for comparing against the engine. |

## Build, packaging and documentation

| File | Responsibility |
|---|---|
| `cmake --build build` | darktable, `libdarktable` and `build/bin/darktable-engine`. |
| [package.json](../../package.json) | `npm run tauri dev` (dev build, engine from `build/bin`), `npm run tauri build`. |
| [bundle_engine.py](../../scripts/bundle_engine.py), [build_dmg.sh](../../scripts/build_dmg.sh) | The engine and its libraries copied into `src-tauri/resources/darktable` (gitignored) and made relocatable; the macOS disk image. |
| [build_engine_windows.sh](../../scripts/build_engine_windows.sh), [bundle_engine_windows.sh](../../scripts/bundle_engine_windows.sh), [WINDOWS.md](../../WINDOWS.md) | The Windows (MSYS2 UCRT64) build. |
| [prune_target.mjs](../../scripts/prune_target.mjs) | Frees `src-tauri/target` of earlier builds, which cargo never removes: keeps what the last two builds of each profile use, as cargo lists it. npm runs it before and after every `npm run tauri ...`. |
| [fetch_immporter.sh](../../scripts/fetch_immporter.sh), [immporter.rev](../../immporter.rev) | The importer, cloned into the gitignored `immporter/` at a pinned commit. |
| [app/docs/](../README.md) | The user guide, for photographers. |
| [benchmarking/README.md](../../../benchmarking/README.md) | Performance suite, results and findings. |
| [darktable/dev-doc/](../../../darktable/dev-doc/README.md) | darktable's own developer docs: the module API, pixelpipe, introspection. Read them before changing the engine's calls into darktable. |

## Keeping this map current

- Update the entry when a file is added, moved or changes its job.
- Refer to code by symbol, not line number.
- Contracts belong in comments beside the code. Measured results belong in [benchmarking/](../../../benchmarking/README.md), and decisions about darktable internals belong in darktable's `dev-doc/`. This map only says where things are.
- After changing a diagram's spec in [`diagrams/build_diagrams.py`](diagrams/build_diagrams.py), rerun it so the `.excalidraw` and `.svg` files agree.
