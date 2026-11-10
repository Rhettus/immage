# Architecture

How Immage's three processes fit together, in detail: the process
boundary and its binary formats, the parts of App.tsx, every file's job,
the engine's pipes and commands, how each operation moves through the
app, and where data lives. [code-map.md](code-map.md) is the short
version, loaded into every agent session; this is read when a change
needs it. Paths below are relative to this file.

## Entry points and process boundary

`main.tsx` marks the document root with `windows` when the webview's user
agent identifies Windows. `styles.css` uses that class to give `.tool`
buttons and their descendants the native arrow cursor. This avoids the
hand cursor's apparent overlap with icon strokes while preserving native
pointer sizing, hover highlights, tooltips and click handling. Other
platforms retain the hand cursor. To verify on Windows, move slowly across
the rail buttons (including Presets, Crop and Adjustments), from their
padding onto the SVG strokes: the arrow should remain stable. Check
tooltips, clicks and disabled buttons as well.

| File | Responsibility |
|---|---|
| [index.html](../../index.html), [main.tsx](../../src/main.tsx) | The main window: mounts `App`. |
| [splash.html](../../splash.html), [Splash.tsx](../../src/Splash.tsx) | The splash window: shows `build` (version and commit, without the engine) at once, asks `about`, shows the main window, closes itself. |
| [App.tsx](../../src/App.tsx) | The whole editor's shell and state. See [inside App.tsx](#inside-apptsx). |
| [main.rs](../../src-tauri/src/main.rs) | `main()`: on Linux selects the web view's EGL before GTK starts (`renderer::init`), migrates the old app name, registers the dialog, opener, updater, process, window state (the main window's size, position and maximized state) and immporter plugins. On Linux `setup()` builds the windows itself, with the frames web extension's folder (`webext_dir`). `setup()` picks the engine: `build/bin/darktable-engine` with runtime state in `build/app-runtime` for a dev build, the bundled `resources/darktable` with the app data folder for a release, or `DT_ENGINE_BIN`. Holds `AppState` and nearly every command. |
| [renderer.rs](../../src-tauri/src/renderer.rs) | Linux window renderer: Automatic leaves EGL vendor selection to the system on every GPU; explicit Mesa or NVIDIA selects that EGL vendor. Stored as `webview-renderer` in the runtime directory so startup can read it before GTK. An inherited marker allows Relaunch to change the selection, while a user-supplied EGL environment override takes priority. Only the web view receives the override; benchmark display metadata records the running and next selections. |
| [engine.rs](../../src-tauri/src/engine.rs) | The engine child. Spawns it (`--core --configdir --cachedir -d perf`, darktable's resource level from Preferences (`resource_level`), OpenCL on with export's pipe type allowed the GPU, which the base borrows, and the full pipes (edits and drags) too with Preferences' Edit on the GPU (`gpu_edits`, on by default); on Linux, ROCm's platform on and its kernels built as OpenCL C 2.0 when no RustiCL is installed, `rocm_only`), retrying while an old one holds darktable's database lock. `request()` writes one JSON line with a request number (`rid`, never reused) and reads replies until the one echoing it, dropping a late reply to an earlier request; an engine that never echoes `rid` (an old build) is read in order. `rid` is not `id`, which `render` uses for a base's number. Thumbnails and background exports (`Tagged`) are tagged and sent without the engine's mutex, and AI Denoise's DNG and the AI selections' outlines come as a tagged answer after the main loop's own (`expect`, `on_engine_thread` in main.rs); a stdout thread (`read_stdout`) hands each tagged reply to its caller, a merge's progress lines to what follows them (`request_with_progress`, as `merge-progress`), and the rest to `request()`. A stderr thread writes the log and keeps darktable's `-d perf` timings apart for the performance overlay. |
| [engine/main.c](../../../engine/main.c) | `main()`: keeps the real stdout for replies, starts darktable with an in-memory library (`dt_init`), sets its confs, then loops: read a line, `_handle()` it, reply. |

The boundary is strict. The front end never touches files or darktable
directly. It calls `invoke(...)` commands, and every command that needs the
engine goes through the one `Mutex<Engine>` in `AppState`, so engine work is
serialized, one request at a time. Thumbnails, folder imports and
exports are the exceptions: the engine builds thumbnails on two threads
of its own (`_thumb_run`), and reads folders (`_import_run`), exports
(`_export_run`), runs AI Denoise (`_denoise_run`) and the AI selections'
models (`_ai_run`) on one each, beside
whatever the mutex's holder is doing. Large results are binary and travel as
`tauri::ipc::Response`:

| Result | Format |
|---|---|
| Frames | a 64-byte header (six u32: size, image size, window x/y; six f32 timings; darktable's u64 hash; the edits' f32 timing; padding), then RGBA |
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

Linux does the same through `/dev/shm`. WebKitGTK delivers a reply at
about 25 ms a megapixel, and more while a page at 2× draws. `render`
writes the frame to a file there named for the page's token and the
frame's id (`shm_frame` in main.rs). A WebKit web extension loaded into
the window's web process,
[webext/frames.c](../../src-tauri/webext/frames.c), gives the page
`immageFrame()`, which copies the file in and deletes it. It can't hand
over the mapped file itself: WebKit stops the web process when a page is
given memory it didn't allocate.

## Front end

State lives in React `useState` and refs, mostly in `App`, plus four small
module stores: [activity.ts](../../src/activity.ts),
[background.ts](../../src/background.ts), [probe.ts](../../src/probe.ts) and
[perf.ts](../../src/perf.ts). Preferences
are `localStorage` keys named `immage.*`.

### Shell

| File | Responsibility |
|---|---|
| [App.tsx](../../src/App.tsx) | Library, viewer, panels, tools, undo, before/after, compare, keyboard, plugins; also the small components `PanelView`, `Slider`, `Filmstrip`, `HistogramView`, `Navigator`, `Toolbar`. Hover previews (`showHover`) render on the preview pipe: Presets tiles at up to 1600 pixels, a panel's swatches (`hoverValues`; grain, B&W filters) at the displayed size up to 3200, so grain is not stretched. |
| [Tour.tsx](../../src/Tour.tsx), [Shortcuts.tsx](../../src/Shortcuts.tsx) | The quick-start tour; the keyboard shortcuts sheet. |
| [menu.ts](../../src/menu.ts), [MenuBar.tsx](../../src/MenuBar.tsx) | The File, Edit, Photo, View and Help menus, defined once for both platforms (`forPlatform`; `nativeSpec` for the macOS bar). MenuBar always draws them in the existing title strip on Windows and Linux. Menu items use the same `ActionId`s as the keys. On macOS, `menu_set` in main.rs builds the menu bar from the native description; a click emits the `menu` event, which `runMenuAction` in App.tsx handles. |
| [ImportView.tsx](../../src/ImportView.tsx) | The SD card importer, loaded from `@immporter/embed`. |
| [Collapse.tsx](../../src/Collapse.tsx), [keys.ts](../../src/keys.ts), [paths.ts](../../src/paths.ts) | Folding panels (a fold that shrinks a scrolled list clamps its offset: WebKitGTK left it past the end); ⌘ or Ctrl by platform; path helpers for either separator. |
| [activity.ts](../../src/activity.ts) | The busy indicator's job store (`begin`, `progress`, `end`, `useWorking`). |
| [background.ts](../../src/background.ts) | Work in the background, for the activity lines under the photo: exports (`runExport`), HDR and Panorama Merge (`runMerge`: the photos read, then the merge's own stages, from the engine's `_merge_report`) and AI Denoise (`runInBackground`), each one's progress and Stop (`stopJob`: `export_cancel`, `merge_cancel`), then what it did, with a next step such as Open (`useJobs`). |
| [styles.css](../../src/styles.css) | All styling. |

### Inside App.tsx

| Part | What it holds |
|---|---|
| Viewer core | refs `session`, `canvas`, `baseCanvas`, `center`, `viewZ`; `dragging` / `draftShown` (drag drafts); `scheduleBase` (the idle whole-image render) |
| `currentView` | the `View` asked for: fitted to the viewer (capped at `MAX_PREVIEW`), a zoomed window, or a half-size draft while dragging |
| `paintFrame` / `drawFrame` | a `Frame` onto the canvas; the histogram; `showOverview` for a whole-image frame (base layer, navigator) |
| `animateTo`, `setZoom` | eased zoom; renders wait until it settles |
| `openFile` / `openEntry` | open a photo: the filmstrip's thumbnail as a stand-in, `Session.open`, then the new-photo defaults (tone mapper, profile, exposure compensation, preset, Edit In returns); once it is idle, `prefetchNext` has the engine decode the photos the arrow keys open next (Preferences' Read ahead) |
| `change` / `changeMany` | every control edit: undo step, `values` state, `Session.set` |
| undo (`record`, `restore`, `Snap`) | snapshots of values, masks, spots and look |
| before/after, compare | `setBaMode`, `setBefore` (`Session.showBefore`), `toggleCompare` |
| crop and turns | `enterCrop`, `leaveCrop`, `turn` (`Session.turned`) |
| `runGuiBenchmark` | the GUI benchmark in Preferences |
| `runGpuCheck` | the GPU check in Preferences: [gpuCheck.ts](../../src/gpuCheck.ts) cases through `changeMany`, `gpu_check_parity` for each |
| keyboard | one `keydown` handler for every shortcut; `fieldKeeps` (`keys.ts`) leaves a focused field its keys: text all, a slider its arrows, a switch Space, a menu its arrows, Home/End, Page Up/Down, Space and Enter |
| `openLaunched`, `dropped` | a photo handed over (`launch-file`), or photos and folders dragged onto the window (`onDragDropEvent`, `path_kind`) |

`enterCrop` snapshots the displayed placement before `prepareCropView` clears
it, so the initial aspect orientation follows the current photo or crop. Edge
drags in `CropTool.tsx` preserve that orientation; only corner drags across the
diagonal can swap it. `node --test verify/crop-transition.test.mjs
verify/crop-corner.test.mjs` checks orientation initialization, crop view resets
and constrained resizing.

Undo and redo work while cropping: `stepHistory` restores the step as usual,
then `followCrop` keeps the tool's own guide (`cropRect`, applied only at
Done) in line. An orientation change is replayed on the guide with
`turnPath` (manifest.ts, the fewest `Turn`s between two orientations) and
`turnRect`, so a dragged guide keeps its shape; any other change to the crop
settings reloads guide and aspect with `loadCrop`, shared with `enterCrop`.
Batch paste steps stop with a status message, because restoring them reopens
the photo. `leaveCrop` keeps `crop_rd`/`crop_rn` at 0:0 on a whole photo left
at Original. `enterCrop` reads 0:0 as Original there, and the change alone
would be an invisible Crop step that the next ⌘Z took first. The GUI case
`crop-undo` checks a turn and Rotate undone by keyboard inside the tool, redo,
and one undo after Done.

### Session and engine bridge

| File | Responsibility |
|---|---|
| [session.ts](../../src/session.ts) | One open photo. `Session.open` reads every mapped module (`get_params`) into control values. `set`/`setMany` update model values immediately and ignore unchanged values. Interactive calls defer dispatch until the next display frame; discrete edits and release flush it immediately. `pump()` sends each dirty module's merged edit (`moduleEdit`) with one `render`, in the one call, so moves made during a render are coalesced, latest wins. It also holds masks, spots, look and the Before view, and saves 600 ms after the last edit. `renderView` decodes the frame header; `preview` renders one-off settings on the engine's preview pipe. Until the image changes (`changed`), it shows the full frames it was sent (`frames`, by view and darktable's hash) and a copy of the whole image at the zoom's scale (`requestCopy`, rendered on the base pipe once idle; at 100% while fitted, so the first zoom in is cut from it), so a view seen before or a pan's window is shown without the engine. Zoomed in, `requestFit` renders the fitted view on the base pipe once idle and keeps it as that view's frame (`current`), so zooming back out needs no render, and the main pipe keeps its cache of the window shown. App's `scheduleCopy` asks for both after each settled frame; App shows the copy as a layer under the sharp frame (`onCopy`). After a change, a render sends the hashes it holds for the view (`have`), and the engine names one rather than render it when the image is back as it was (the Before view and back, undo); a copy set aside comes back the same way. |
| [pixelRatio.ts](../../src/pixelRatio.ts) | Linux on Wayland at a fractional scale: `draftScale()`, how much smaller drag drafts are (`draftK` and `fullDraftK` in App.tsx; the latter also sizes `exactView`, the detail sliders' whole-view draft), the screen's scale from `display_scale` over `devicePixelRatio`, as GTK 3 draws the window at the next whole scale; Preferences' "Drag drafts at the screen's scale"; `settledScale()` does the same for the settled Fit frame (`viewAt(1)` in App.tsx), behind "Fit frames at the screen's scale" (on by default). |
| [sharedFrames.ts](../../src/sharedFrames.ts) | Windows: `renderFrame` asks `render` to post the frame in a WebView2 shared buffer tagged with an id, then matches the `sharedbufferreceived` event to the reply, copies the frame out and releases the buffer. Linux: it asks `render` to write the frame to `/dev/shm` and reads it with the web extension's `immageFrame()`. On the Mac, on WebView2 runtimes before 1.0.1661, on Linux without the extension, or with Preferences' "Shared-memory frames" off, the frame comes in `render`'s reply. |
| [HistoryPanel.tsx](../../src/HistoryPanel.tsx) | darktable's history plus this session's undo steps; a row's switch, delete or reset (`historyChange` in App.tsx, `Session.setModuleState`, the engine's `_module_state`). |
| [CopySettings.tsx](../../src/CopySettings.tsx) | Copy/Paste Settings: which groups, and the clip. |
| [batchPaste.ts](../../src/batchPaste.ts) | Exact selection targets; shared single/batch clip application; sequential background Sessions, native snapshot commit and rollback. |

### Control mapping (pure math, no Tauri)

| File | Responsibility |
|---|---|
| [manifest.ts](../../src/manifest.ts) | The panels and controls (`panels`, `Control`), and the `ModuleMap`s that translate control values to darktable params and back (`modules`, per-mask `localMaps`). `boundFields` lists every field the app reads. `"op#name"` is a named module instance. |
| [wb.ts](../../src/wb.ts) | Temp/Tint and color calibration's illuminant. |
| [tonecurve.ts](../../src/tonecurve.ts) | Parametric and point curves and tonecurve nodes. |
| [transform.ts](../../src/transform.ts), [colorgrading.ts](../../src/colorgrading.ts) | Rotate/ashift and auto-crop; color balance hues. |
| [colorequal.ts](../../src/colorequal.ts) | HSL and the B&W Mix at the hues their bands are named for: the mix of the color equalizer's eight nodes each slider sets (`toNodes`) and back (`fromNodes`), fitted to darktable's own curve through them. |
| [GuideOverlay.tsx](../../src/GuideOverlay.tsx) | The Transform grid and Guided Upright's guides on the photo. |
| [autoTone.ts](../../src/autoTone.ts), [bwauto.ts](../../src/bwauto.ts) | Basic's Auto and the B&W Mix's Auto, from the rendered frame. Auto's five tone sliders are all judged from one frame with them at 0, so they compound: Contrast adds at half the gain it removes with (`CONTRAST_ADD_GAIN`), because Whites and Blacks stretch a flat photo's spread about as much again. `benchmarking/autoexp.py` runs Auto over the corpus headless. |

### Panels and controls

| File | Responsibility |
|---|---|
| [ColorWheel.tsx](../../src/ColorWheel.tsx), [PointCurve.tsx](../../src/PointCurve.tsx) | Color grading wheels; the point curve editor. |
| [CropTool.tsx](../../src/CropTool.tsx), [VignetteOverlay.tsx](../../src/VignetteOverlay.tsx) | Crop overlay and aspects; vignette guides. |
| [MetadataPanel.tsx](../../src/MetadataPanel.tsx), [Keywording.tsx](../../src/Keywording.tsx) | The left panel's metadata and keywords cards. |

### Masks, heal and zones

| File | Responsibility |
|---|---|
| [masks.ts](../../src/masks.ts) | `Mask` and `Shape` (ellipse, gradient, brush, luminance/color/parametric ranges, AI object or depth), in shown-image units 0-1; overlay and thumbnail pixels. The overlay's opacity (Preferences, `OverlayColor.opacity`, default `OVERLAY_OPACITY`) rides as the optional fourth entry of the `Rgb` that `maskOverlayRgb` returns, so the overlays' existing color dependencies redraw on a change; `tint` scales alpha by it. The overlay keeps each shape's coverage per grid (`cover`), and a brush stroke being painted is stamped around its newest segment only (`brushCover`). |
| [localMerge.ts](../../src/localMerge.ts) | `planMerge`: which masks share instances of a `merge` module (color balance rgb, color equalizer for HSL, diffuse for Texture, denoise, chromatic aberrations for Defringe), grouped by direction or by slider and sign, whichever needs fewer; each shared instance's strength and each mask's opacity in its combined mask. Masks share only with masks of the same ranges and refinements, which the shared instance carries; an inverted mask with ranges, ranges alone and refine Contrast keep their own instances (`canMerge`). |
| [MaskOverlay.tsx](../../src/MaskOverlay.tsx), [MasksPanel.tsx](../../src/MasksPanel.tsx), [ParametricEditor.tsx](../../src/ParametricEditor.tsx) | Drawing shapes on the photo; the Masks panel; darktable's parametric (blendif) editor. |
| [spots.ts](../../src/spots.ts), [SpotOverlay.tsx](../../src/SpotOverlay.tsx), [HealPanel.tsx](../../src/HealPanel.tsx) | Heal/Clone spots, sent to darktable's retouch module. |
| [negadoctor.ts](../../src/negadoctor.ts), [NegativePanel.tsx](../../src/NegativePanel.tsx) | Film negatives: input and working profile choices on `colorin`, plus negadoctor's presets and its pickers, ported from `src/iop/negadoctor.c` and fed `sample` at negadoctor's input; the Negative panel. A converted photo (`neg_on`) has the modules of `NEG_OFF` (manifest.ts) forced off in `Session.moduleEdit`, read as if on when it opens if the history has them, and kept in the history by the engine's `_held_for_mode`. Converting writes the switch-off only for modules that are on (`Session.conversionChanged`), so one that was never on is not switched on when the photo, opened again, is turned back; `NEG_CHOICES` moves Basic's tools after it. Export to Library and Turn Off sit in [PositiveFooter.tsx](../../src/PositiveFooter.tsx), shared with Film Simulation. |
| [spektrafilm.ts](../../src/spektrafilm.ts), [FilmPanel.tsx](../../src/FilmPanel.tsx) | Film Simulation: darktable's spektrafilm. `SF_FIELDS` makes one `sf_<field>` control per param (the hidden `film` panel and the `spektrafilm` map in manifest.ts); `SF_PRESETS` is `init_presets()` over `_preset_defaults()` (`PRESET_BASE`), stocks by name; `stockHash` is the module's `_name_hash()` (djb2 xor, folded to 32 bits), which must stay identical or presets name no stock (`verify/film-simulation.test.mjs` compares it with the engine's for every stock); `filmOf`, `autoPaper`, `filmChanges` and `paperChanges` port `_current_film_entry`, `_auto_paper_entry`, `_film_changed` and `_paper_changed`. A simulated photo (`sf_on`) has `SF_OFF` (the tone mappers) off and `SF_CHOICES` moving Contrast, Saturation and Blacks off them. The two conversions are listed in `CONVERSIONS` (manifest.ts), which Session (`conversionChanged`, `moduleEdit`, `open`, `chooseModules`) and `batchPaste.applyClip` read; App.tsx keeps them mutually exclusive (the `exclusive` dialog). The panel reads the pack with `spektra_stocks` when it opens and polls `spektra_fetch` while downloading. |
| [zones.ts](../../src/zones.ts), [ZoneSystem.tsx](../../src/ZoneSystem.tsx) | The Zone System: zone statistics, the placement curve (a tone equalizer instance ahead of the [mask anchor](masks.md#where-the-instances-run)), zone masks. |

### Presets and looks

| File | Responsibility |
|---|---|
| [Presets.tsx](../../src/Presets.tsx) | Develop presets (control values in `presets.json`, versioned), looks (darktable styles from `app/looks`), the preview tile cache, the panel and the New Preset dialog. |

### Library and filmstrip

| File | Responsibility |
|---|---|
| [library.ts](../../src/library.ts) | `ImageEntry`, and `Known`: a photo as the folder's last read found it; `openFolder` (batches arriving as `folder-progress` events); `withKnown`, the read and known photos in one order; RAW+JPEG pairing; `ThumbLoader`, which fetches two thumbnails from the engine at a time, alongside editing, shows a known photo's last thumbnail until it is checked, and lets those off screen longest go past Preferences' Thumbnail memory. |
| [FolderTree.tsx](../../src/FolderTree.tsx) | The folder tree; with folders on more than one drive, a heading per drive (`folder_volumes`, read again every 10 s), its dot green while the drive answers and red while it does not. |
| [filter.ts](../../src/filter.ts) | The filmstrip's `Filter` over a folder's photos (`passes`), and what the photos hold to filter by (`facets`): kinds, cameras, lenses, keywords, exposure settings. |
| [HdrDialog.tsx](../../src/HdrDialog.tsx) | HDR Merge's dialog (Auto Align, when the engine has OpenCV: `hdr_can_align`); `runHdrMerge` in App.tsx runs it in the background. |
| [PanoDialog.tsx](../../src/PanoDialog.tsx) | Panorama Merge's dialog (reduced-resolution preview above projection and Auto Crop; `pano_preview`, `merge_cancel`, `pano_can_merge`); `runPanoMerge` in App.tsx runs it in the background, and the DNG's first open takes a raw's new-photo defaults with Lens Corrections off (`pano` in `openFile`). |
| [FilterPopup.tsx](../../src/FilterPopup.tsx) | The toolbar's Filters popup: the folder's fields, or on Immich results the server search's filters (the `ImmichSearch` App holds, shared with the Immich card). |

### Export

| File | Responsibility |
|---|---|
| [exportSettings.ts](../../src/exportSettings.ts) | Export `Settings`, presets (built-in, local, shared file) and frame items (borders, keylines, captions). |
| [exportTokens.ts](../../src/exportTokens.ts) | File name and caption tokens. |
| [ExportDialog.tsx](../../src/ExportDialog.tsx), [ExportFrame.tsx](../../src/ExportFrame.tsx) | The Export dialog, its live preview, the Immich target; the Frame & Captions editor. The dialog asks what an export needs (the upscale model, names that clash), hands it to `runExport` and closes. |

### Print

| File | Responsibility |
|---|---|
| [print.ts](../../src/print.ts), [PrintPanel.tsx](../../src/PrintPanel.tsx) | The Print panel (`RightMode` `"print"`, the rail's last button under Export, ⌘P): settings kept in `localStorage`, PDF papers, the page `layout()` and the Cells grid `cellsLayout()`, the requests for `print_photo` and `print_sheet`; the soft proof (`applyProof`), which App.tsx keeps on across panels (S, the `Soft Proof:` badge) and follows with `Session.redraw()`. Design and verification in [print.md](print.md). |

### Immich and plugins

| File | Responsibility |
|---|---|
| [immich.ts](../../src/immich.ts), [ImmichPanel.tsx](../../src/ImmichPanel.tsx), [ImmichPrefs.tsx](../../src/ImmichPrefs.tsx) | Search, remote assets as `ImageEntry`, path maps from Immich to local files; the Library's Immich card (library, words, mode; its filters are in the Filters popup); connection settings (from the immporter). |
| [plugins.ts](../../src/plugins.ts), [PluginPrefs.tsx](../../src/PluginPrefs.tsx) | Edit In: plugin kinds (`KINDS`: DxO PureRAW, and Macro Studio, whose `handoff` is a job rather than files), configs, returns; the Plugins preferences tab. |

[canvasLayers.ts](../../src/canvasLayers.ts) preserves canvas allocations when dimensions
match and tracks immutable frame identity to skip repeated uploads. A fitted
CPU frame copies the sharp canvas into the base instead of uploading its bytes
again. External writes on photo/crop reset clear the tracked identities. Layer
placement skips unchanged styles and navigator/crop placement snapshots.
Navigator drawing runs in a deferred task and checks the session and base frame
identity before drawing, so replacement frames cancel obsolete work.

### Preferences, histogram, probe, performance

| File | Responsibility |
|---|---|
| [Preferences.tsx](../../src/Preferences.tsx), [PrefsUI.tsx](../../src/PrefsUI.tsx) | The Preferences dialog and its `load*`/`store*` pairs; `PrefCard`, `PrefRow`, `PrefSwitch`; `ABOUT_LINKS` (homepage, Discord, GitHub icons under the sidebar version). |
| [SelectMenu.tsx](../../src/SelectMenu.tsx) | Mounted once in `main.tsx`. Intercepts `mousedown` on any single-choice `<select>`, shows its options in a `.context-menu.select-menu` (inside the enclosing `.filter-pop`, `.icon-picker`, `.modal` or `.context-menu`, so outside-click handlers don't close it), and writes the choice back to the `<select>` and fires `change`. Handlers and `data-*` test hooks are unchanged. Space and Alt-arrow open it; arrows, Home/End, Enter and Escape drive it. |
| [histogram.ts](../../src/histogram.ts) | Histogram and scope kernels (worker with main-thread fallback), clipping overlay. |
| [probe.ts](../../src/probe.ts) | The color under the pointer, for the Tone Curve, HSL and B&W cards. |
| [PerformanceTuner.tsx](../../src/PerformanceTuner.tsx), [previewTuning.ts](../../src/previewTuning.ts), [tunerOptions.ts](../../src/tunerOptions.ts), [tunerWorkload.ts](../../src/tunerWorkload.ts) | Performance profiles (`PROFILES` in Preferences.tsx: preview size, smallest draft, draft time and loupe defaults; `applyProfile` stores them, Reset re-applies the selected one; one drag-draft path in App.tsx `draftK`, `DRAFT_SKIP` in session.ts is the same for all three) and quality-first preview search with trimmed-median metrics with FPS/latency targets, explicit apply and remeasurement, restart/resume and navigation workload comparisons; AI and thumbnail settings excluded. |
| [perf.ts](../../src/perf.ts), [PerfHud.tsx](../../src/PerfHud.tsx) | Edit-to-pixels timing by stage, the performance overlay and the GUI benchmark's recording. |
| [gpuCheck.ts](../../src/gpuCheck.ts) | The GPU check's cases (a module choice, then sliders moved by a share of their range), `resolveCase` and the pass verdict. |

## Rust layer

| File | Responsibility |
|---|---|
| [main.rs](../../src-tauri/src/main.rs) | `AppState` (the engine, scratch file paths, looks and models folders, the folder-read token, perf state); every command except plugins'; AI model download (`install_model`, `install_extra`, through reqwest, sha256 checked, darktable's archives unpacked by the engine's `unpack`); export (naming conflicts, Immich upload); presets and looks files; launch-file handling. |
| [engine.rs](../../src-tauri/src/engine.rs) | The engine child and its protocol (above); `perf_mark` and the `-d perf` parser. |
| [immich_search.rs](../../src-tauri/src/immich_search.rs), [immich_upload.rs](../../src-tauri/src/immich_upload.rs) | Immich: search, thumbnails, originals (cached); album and upload calls. The API key never reaches the front end. |
| [listing.rs](../../src-tauri/src/listing.rs) | A folder's entries with each file's size and modified time from the listing itself (`getattrlistbulk` on macOS, the listing's own on Windows; elsewhere left to a stat), so a folder on a network share is listed and its thumbnails checked without a round trip per file. |
| [volumes.rs](../../src-tauri/src/volumes.rs) | The drive a library folder is on, its name and whether it is a network share (the mount table on macOS and Linux, the volume calls on Windows), for the folder tree's headings. `answering()`: whether a path's drive answers a stat within 3 s, tried on a thread of its own, as a share whose server has gone away holds a stat in the kernel for good; a drive that doesn't is skipped until that stat returns. `open_folder`, `list_subfolders`, `folder_volumes` and `path_exists` ask it first. |
| [scale.rs](../../src-tauri/src/scale.rs) | Linux on Wayland: the screen's real scale, its output's mode over its xdg-output logical size on a Wayland connection of its own, for `display_scale`. |
| [plugins.rs](../../src-tauri/src/plugins.rs) | Edit In: find apps, launch with files, poll their output folders, remember each result (`plugin-returns.json`). Macro Studio's protocol (`plugin_job`): a job manifest in `plugin-jobs/<id>/`, its receipt read until every stack is saved or closed, and a ledger (`plugin-jobs/pending.json`) drained at start and on each `open_folder` (`drain_jobs`), for stacks saved later. |
| [Cargo.toml](../../src-tauri/Cargo.toml), [tauri.conf.json](../../src-tauri/tauri.conf.json), [capabilities/](../../src-tauri/capabilities) | Dependencies (each with its reason); windows, bundle resources (`resources/darktable`, `looks`, `sample`); window permissions. |

Commands by what they reach:

| Reaches | Commands |
|---|---|
| The open photo, through the engine | `open_image`, `get_params`, `set_params`, `module_state`, `render`, `cancel_base`, `preview`, `save`, `before_view`, `history`, `masks`, `mask_shapes`, `combine`, `mask_delete`, `mask_rename`, `mask_map`, `range_map`, `sample`, `zones`, `tone_key`, `lenses`, `agx_auto`, `spots`, `spots_enable`, `spot_source`, `look_apply`, `look_amount`, `positive_export`, `ai_object`, `ai_mask`, `ai_depth`, `ai_denoise`, `ai_denoise_preview` |
| The library, through the engine | `open_folder` (engine `import` in batches), `thumb`, `thumb_cached`, `thumb_known`, `prefetch`, `meta`, `meta_set`, `capture_times`, `keywords`, `keywords_set`, `create_virtual_copy`, `remove_virtual_copy`, `hdr_merge`, `hdr_can_align`, `pano_merge`, `pano_can_merge`, `trash_files`, `export_images`, `export_cancel`, `export_preview`, `fonts`, `print_photo`, `print_profiles`, `print_profile_add`, `printers`, `printer_info`, `softproof`, `spektra_stocks`, `spektra_fetch`, `ai_accel`, `about` |
| Files only | `list_subfolders`, `folder_volumes`, `path_exists`, `path_kind`, `export_existing`, `presets_load`, `presets_save`, `export_presets_load`, `export_presets_save`, `preset_file_read`, `preset_file_write`, `looks_list`, `sample_folder`, `launch_file` |
| AI models (download, then the engine's `version`) | `ai_model_ensure`, `ai_model_reinstall` |
| Immich (HTTP) | `immich_albums`, `immich_create_album`, `immich_export_check`, `immich_browse_check`, `immich_search`, `immich_libraries`, `immich_suggestions`, `immich_people`, `immich_tags`, `immich_thumb`, `immich_resolve` |
| Plugins | `plugin_find_apps`, `plugin_launch`, `plugin_watch`, `plugin_job`, `plugin_cancel`, `plugin_returns`, `plugin_return_applied` |
| Performance | `perf_set`, `perf_modules`, `perf_report_write`, `perf_ping` |
| The window | `preview_fullscreen`, `display_scale` |
| The build | `build`: the version and commit, answered without the engine. `build.rs` sets `IMMAGE_BUILD_COMMIT` and `IMMAGE_BUILD_DIRTY` from Git; `build_label` in main.rs shortens the commit to ten digits with `-dirty`, as `about` and `build` return it, and `perf_report_write` stores the full commit and the dirty flag as every report's `build`. Built outside Git, all are absent. |

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

Printing and soft proofing are in [engine/print.c](../../../engine/print.c):
printer profiles added to darktable's output list at run time, colorout's
soft proof mode (`softproof`, with every pipe recommitted from colorout and
the proof mixed into `_frame_hash`), CUPS or Windows printers, and a print
job (`print`, tagged on the export thread) that renders through an in-memory
format, converts with the printer profile and writes a PDF for CUPS or a
file, or spools on Windows. A sheet of photos in cells (`print` with `pages`,
`print_sheet`) is composed a page at a time into one buffer, filenames
included, and goes out the same way. See [print.md](print.md).

Film Simulation's engine side is a section of main.c. spektrafilm builds its
film and paper lists only in its GUI, so `_spektra_stocks` reads the pack's
`profiles/*.json` headers itself with `sf_profile_load()`, from the pack
`sf_fetch_resolve_pack_dir(0, ...)` resolves for a new edit, and copies the
module's `_name_hash`, `_shorten_name` and `_nat_cmp` so names, order and
hashes match its combobox. `_spektra_fetch` wraps darktable's own fetcher
(`sf_fetch_start(0, 0)`, `sf_fetch_status`, `sf_fetch_cancel`), which runs on
its own thread and posts nothing back without a GUI. The module notices a new
pack by `sf_fetch_generation()` and reloads at its next `process()`, but the
pipes' caches still hold the passthrough it rendered without one under the same
hashes, so `_sf_follow_pack` invalidates every pipe from spektrafilm's
`iop_order` when the generation moves. `_held_for_mode` keeps the disabled
entries of the modules a conversion holds off (negadoctor's list, or
spektrafilm's tone mappers) through `_prune_off`.

Verified: an engine export of a film edit matches `darktable-cli` on the same
XMP exactly (16-bit TIFF, CPU, "film|portrait" on the sample photo). It is the
slowest module Immage runs: a 1600x900 render with "film|portrait" took about
360 ms on an 8-core ARM CPU without OpenCL, against about 35 ms on AgX, so
drags lag. Drafts do not skip it, as they skip grain and diffuse, because it
is the photo's tone mapping.

The GUI case `film` (verify/gui) turns the simulation on, checks that Film and
Paper are menus of stock names, applies "film|portrait" from the Preset menu
with the keyboard and turns it off again. WebKitGTK fires `change` on each
arrow step of a closed select, so the Preset menu keeps the last preset as
its value; a menu that snapped back to its placeholder applied the first
preset on every step. The runner copies the installed pack into the run's
isolated profile.

[`engine/upright.c`](../../../engine/upright.c) is Upright: the
structure detection and fit of darktable's rotate and perspective
(`src/iop/ashift.c`). darktable runs these only from its GUI, so the
GUI-free parts are copied unchanged, with the outlier removal and fit
rewritten to take the lines rather than `gui_data`. Its header names the
ashift.c revision it was copied from. Compare the two when taking a new
darktable release. `upright` in main.c reads the image as it enters
rotate and perspective from the preview pipe (`_working_at`,
`_STAGE_ASHIFT`). `points` maps points between the shown image and the
input, for Guided's guides. The crop tool's Auto (`runAutoStraighten` in
App.tsx) asks `upright` for the `level` fit and writes only `tf_rotate`,
converted by `rotateOf` in manifest.ts as `transformMap.read` does, so
`tf_upright` and the `tf_base_*` fit stay untouched; it is disabled while
Upright is on.

[`engine/hdrmerge.c`](../../../engine/hdrmerge.c) is HDR Merge:
darktable's HDR merge of raw brackets into a float DNG, which darktable
runs only as a lighttable job on its selection
(`src/control/jobs/control_jobs.c`). The merge is copied from there
with only its messages changed, and calls darktable's own alignment
(`src/common/hdr_alignment.cc`, with OpenCV); its header names the
revision it was copied from. Compare the two
when taking a new darktable release. `_hdr_merge` in main.c imports the
DNG; a tagged one runs on the export thread (`_export_run`), as it reads
each bracket through an export pipe.
The float writer receives no EXIF; `hdr_merge` then merges it through
`rendered_metadata` so the generated DNG tags and CFA pattern survive, and
stamps the source camera orientation explicitly because the TIFF writer's
top-left default is not the camera's orientation.
An EXIF-write failure removes the temporary output instead of importing it.
The RAW regression in `verify/panorama.test.mjs` checks HDR as well as panorama
thumbnails, rendering and reopening after engine restart.

AI Denoise's `_denoise_write` likewise calls the CFA or linear DNG writer
without EXIF, then uses `rendered_metadata` and `denoised_metadata` in
`strip.cc`. The latter reads existing metadata before stamping the source
camera orientation and adding the `Xmp.darktable.neural_restore` marker,
preserving DNG tags and previews while preventing automatic denoise presets.
Either metadata failure deletes the output.

[`engine/pano.cc`](../../../engine/pano.cc) is Panorama Merge, which
darktable doesn't have: OpenCV's stitching pipeline (`cv::detail`, as
its `stitching_detailed.cpp` sample runs it), kept linear, with the
blend log-encoded into the 15 bits OpenCV's blender takes. `_pano_frame`
in main.c renders each raw through an export pipe with only the modules
before `colorin` (`_pano_keep`) and its white balance divided out, so
the panorama stays in the camera's color;
[`engine/dng.c`](../../../engine/dng.c) writes it as a 16-bit float
LinearRaw DNG with the first raw's matrix and white balance as shot,
which darktable opens as a raw. Selections containing non-RAW images instead
render into common linear Rec.2020 with white balance applied, write the DNG
in that space and use `_positive_import` for neutral starting history.
Both paths merge source EXIF through `rendered_metadata`, which reads the
generated TIFF metadata first and preserves its DNG identification, calibration,
orientation and software tags. Do not use `dt_exif_write_blob` here: it drops
the generated DNG tags, causing RAW-camera decoders to be selected instead.
Metadata-write failures remove the incomplete output. Run
`IMMAGE_TEST_RAW=/path/to/photo.ORF node --test verify/panorama.test.mjs`
to check RAW-merge tags, thumbnails, rendering and reopening after engine restart.
`_pano_merge` imports it; a tagged one
runs on the export thread. Both are built only when OpenCV's stitching
module is found (`HAVE_PANO`, `engine/CMakeLists.txt`).

`pano_preview` uses the same `_pano_merge` input validation and `_pano_frame`
lens-corrected export pipe, with every input rendered into linear Rec.2020
at a maximum long edge of 1280 pixels. `pano_preview` in pano.cc shares
`_stitch` with the full merge: feature matching, camera estimation, Auto
projection selection, warping, seams and blending. Its output warper bounds
the canvas to about 1600 pixels on the long edge. It returns sRGB RGBA8
(base64 `rgba`, `width`, `height`), the resolved `projection`, `used` count
and `[x, y, width, height]` `crop` from the same coverage-based `_auto_crop`.
Empty pixels have zero alpha. This branch writes no DNG and imports nothing;
full-resolution merges keep their existing color and output paths. Preview
geometry and color are approximate, especially when reduced features differ
from the full-resolution alignment; no creative tone mapper is applied.

The Rust `pano_preview` command uses the tagged export queue and existing
merge cancellation. PanoDialog debounces projection changes, serializes
requests across mounts, cancels obsolete work and ignores late replies.
Successful previews are cached per selection and projection for that dialog;
Auto Crop redraws the returned rectangle locally without engine work. A new
projection clears the old preview while loading so it cannot be mistaken for
the new result. Errors offer Retry and keep Merge available; builds without
stitching disable Merge and explain that preview is unavailable. Stopping
occurs at the next photo or stitch stage; an individual alignment stage can
take time to finish.

Verification: `node --test verify/panorama.test.mjs` exercises all four preview
choices, resolved Auto, RGBA dimensions, transparent coverage and crop bounds,
no-file preview behavior, duplicate input rejection and the final DNG color
round trip. `node verify/panorama-ui.mjs` checks canvas cropping, cached
switches, stale responses, cancellation, retry and Merge settings in Chromium.
Run `cmake --build build --target darktable-engine`, `npm run build --prefix app`
and `cargo check --offline --manifest-path app/src-tauri/Cargo.toml` for the
engine, frontend and bridge respectively.


Whether a photo is edited is darktable's own test, `dt_image_altered()`:
the history hash against its basic and automatic baselines, which the
sidecar carries. `open` replies `fresh` when the photo had no history
before loading; the client then applies its new-photo defaults, and every
`_save` stamps them as the automatic baseline (`history_auto_hash`) until
`baseline_end`, which `Session.endBaseline()` sends ahead of the user's
first recorded change. So the defaults never mark a photo edited, in
Immage or in darktable.

`_open` copies the image cache's colorspace into the session after
`synch_all`. Colorin marks a photo with an sRGB or Adobe RGB input profile
as `USER_RGB`, in the cache only; darktable's import thumbnails do that
before the darkroom loads a photo, the engine's import does not. Without
the copy, a JPEG's first session scaled its input without gamma correction
and rendered unlike every later session, so a batch paste's undo could not
match it (`verify/batch-paste.test.mjs`, "a fresh photo renders the same").

| Section | Main functions |
|---|---|
| Session, open, close | `_open_image`, `_close_session`, `_import`, `_compress_history` |
| Set and get params | `_set` (fields by introspection, `instance`, `mask`, `after`/`before` moves), `_get`, `_write_field`, `_named_instance` |
| Render | `_render` (and the `render` command's `skip`; with `have`, a frame of no size naming the client's frame of the hash it would get), `_write_rgba`, `_ppipe_ready`, `_preview` |
| Library | `_folder`, `_import_files` (a tagged `import` on the import thread, `_import_run`), `_thumb` (a tagged `thumb` on the thumbnail threads, `_thumb_run`, routed there by `_read_requests`), `_prefetch` (raws decoded ahead, a few at once, on a thread pool of its own), `_image_json`, `_meta_set`, `_keywords_set`, `_copy`, `_remove_copy`, `_sidecars`, `_forget` (a deleted file's rows, so a new file at its path imports fresh) |
| HDR Merge | `_hdr_merge` (hdrmerge.c's `hdr_merge`, on the export thread when tagged) |
| Panorama Merge (`HAVE_PANO`) | `_pano_merge`, `_pano_frame` (pano.cc's `pano_stitch`, dng.c's `dng_write_linear_half`, on the export thread when tagged) |
| Export | `_export` (darktable's export with flags, then `strip_metadata` in [strip.cc](../../../engine/strip.cc), with exiv2, for what the flags do not reach: serial numbers, camera info, the source's own text fields and keywords); `_frame_style` (borders and a watermark SVG as a temporary style; a fixed canvas as one last border, sized so the file comes out exactly W x H); the AI upscale proxy format (`_upscale_ctx`) |
| Masks | `_mask` (shapes into a darktable flexi mask group, prefixed `immage: `, with its ranges as parametric elements in a product group, prefixed `immage ranges: `; `_flatten` reads any flexi tree back to shapes), `_masks` (with `merged_in`), `_mask_delete`, `_mask_rename`, `_attach_mask`. The [mask anchor](masks.md#where-the-instances-run), `colorbalancergb`, is where every mask's instances run, so a range sampled at its output holds for all of them. `_combine`: a flexi sum of the masks' groups, each at its opacity (prefixed `immage combined: `), with the members' ranges, driving a shared instance, which `_attach_mask` attaches only to a combined mask; `_combined_member_changed` keeps it current when a member is reshaped or deleted. `_prune_off` keeps a mask's own switched-off instances (`_holds_mask_settings`). `_named_instance` places a mask's own instance after the shared ones of its module |
| AI (`HAVE_AI`) | `_ai_object` (SAM), `_ai_mask` (sky, subject, ...), `_ai_depth` (with a tag, the main loop renders the model's input unless its last result holds, `_ai_job`, and answers; the model runs on the AI thread, `_ai_run`, which answers again with the tag); outlines are traced at `_TRACE_SIZE` against the photo rendered at it (`_guide`, which the models' inputs are made from), moved onto its edges first by `_snap_edges`, a guided filter kept to where the model is unsure (`_trace_json`), `_ai_denoise` (darktable's raw denoise into a DNG, repeating `src/libs/neural_restore.c`'s job on its public calls; with a tag, the main loop snapshots the edit and answers, and the denoise runs on its own thread, `_denoise_run`, answering again with the tag), `_ai_denoise_preview` (its 1:1 before and after, as the lib's raw preview makes them); on Linux, `_ort_exports` keeps darktable from probing a GPU provider the bundled ONNX Runtime lacks, and `main()` sets the provider to CPU when it has none |
| Spots | `_spots_set`, `_spots_json`, `_spot_source` (the retouch module) |
| Ranges and zones | `_sample` (at the mask anchor, or with `stage` "negadoctor" at negadoctor's input), `_range_map`, `_zones`, `_mask_map`, `_tone_key`, `_agx_auto` |
| Looks | `_look`, `_look_amount` (a darktable style, its instances scaled) |
| Save | `_save` (history to the database, compressed, history hash and `darktable\|changed`, XMP sidecar written) |

The commands `_handle()` serves:

| Group | Commands |
|---|---|
| Session | `open`, `history`, `module_state`, `save`, `baseline_end`, `before`, `close`, `quit`, `version`, `unpack`, `ai_accel`, `opencl`, `parity`, `fonts`, `spektra_stocks`, `spektra_fetch` |
| Library (no photo needed) | `folder`, `import`, `thumb`, `prefetch`, `meta`, `meta_set`, `capture_times`, `keywords`, `keywords_set`, `copy`, `remove_copy`, `sidecars`, `forget`, `export`, `export_hold`, `export_release`, `hdr_merge`, `pano_merge` |
| Edit | `set`, `get`, `render`, `preview`, `look`, `look_amount` |
| Masks and spots | `mask`, `combine`, `masks`, `mask_rename`, `mask_delete`, `mask_map`, `range_map`, `sample`, `spots`, `spots_enable`, `spot_source` |
| Tone | `tone_key`, `agx_auto`, `zones` |
| Lens Corrections | `lenses` (`_lens_menu`: the matched lens and the camera's Lensfun lenses, from [lenses.cc](../../../engine/lenses.cc), which loads its own lfDatabase the way lens.cc's `init_global()` does); the virtual field `lens_pick` of the `lens` module (`_write_lens_pick`, `_read_field`): 0 is the EXIF match (default params), else `lenses_hash()` of the chosen lens, written as the params' `lens` name and `target_geom`, with `method` set to Lensfun (a raw with embedded correction defaults to the embedded method, which ignores the database); 0 restores the default params' three. Shown by [LensPicker.tsx](../../src/LensPicker.tsx) (`matchLenses` filters by words), which refetches when the photo or the pick changes |
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
| `src/develop/pixelpipe_hb.c` | `important_input` also holds without a GUI, for the module the engine's `_set` names in `history_last_module`, so a GPU drag's frames start from the cached input of the dragged module rather than the raw. darktable only does this for the focused module of its GUI. |
| `src/common/exif.cc`, `src/imageio/imageio_tiff.c` | Photos are read, not memory-mapped: exiv2 parses a file read whole (`_open_read`), and libtiff opens with `"rbm"`. A mapped file on a network share that drops, as when the computer sleeps, kills the engine with SIGBUS; a read only fails. verify's [trapmap.c](../../../verify/trapmap.c) checks it. |

## How an operation moves through the app

1. **Open a photo.**
   1. `openFile` in App.tsx calls `Session.open`.
   2. That sends `open_image`, which reaches the engine's `open`: import into the in-memory library (reading an existing sidecar), `dt_dev_load_image`, build the main pipe on the full raw.
   3. It then calls `get_params` for every mapped field, and each `ModuleMap.read` turns them into control values. `history`, `masks` and `spots` follow.
   4. A never-edited raw then gets the new-photo defaults: tone mapper, profile, exposure compensation (an exposure instance of its own), color noise reduction, the new-photos preset.
2. **Move a slider.**
   1. `Slider` calls `change()`, which records an undo step, updates `values` and calls `Session.set`.
   2. During pointer/wheel interaction, `Session` waits until the next display frame before dispatching; discrete keyboard/undo edits dispatch immediately. Release cancels the queued callback and requests the latest exact frame, including when no draft has been shown. A frame whose view changed while it rendered (a draft finishing after release) is discarded and sets `needRender`, so the pump renders the current view: a click on a track, let go while its draft was in flight, left the edit unrendered until the next input. `pump()` sends `render` for `currentView()` with each dirty module's edit (`edits`), which Rust sends to the engine as `set`s ahead of the render: one call from the page however many modules moved, as a call cost 20 ms or more on Linux while the page drew. Moves made meanwhile only mark modules dirty, so the next round sends the latest values once.
   3. In the engine, `_set` writes the fields and adds a history item, then `_render` calls `dt_dev_pixelpipe_process`. Only modules from the changed one onwards run; the rest come from the pipe cache.
   4. The frame is written to `frame.rgba`, read back by Rust and returned with its header (on Windows and Linux, in shared memory beside it).
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
   4. AI masks first ensure the model (`ai_model_ensure`, event `ai-model`), then `ai_mask` / `ai_object` return paths that become shapes. The model runs on the engine's AI thread, so editing goes on meanwhile; an outline that comes back after the photo was left is dropped (`runAi`). A model the engine cannot load is deleted and downloaded again once (`withModel`, `ai_model_reinstall`).
5. **Save.**
   1. 600 ms after the last edit, `Session.scheduleSave` sends `save`. The engine writes history to the database, compresses it and writes the XMP sidecar beside the photo.
   2. `onSaved` refreshes the filmstrip thumbnail.
6. **Export.**
   1. `ExportDialog` asks what it needs, then `runExport` ([background.ts](../../src/background.ts)) calls `export_images` and the dialog closes.
   2. Rust sends `export_hold`: the engine takes a snapshot of the open photo's edit (a darktable duplicate at a version from `_SNAPSHOT_VERSION` up, which listings leave out), and of each other photo as it is opened (`_hold_open`) or reached. Each photo is exported as it was edited when the export was asked for.
   3. Each photo is a tagged `export` on the engine's export thread (`_export_run`), outside the engine mutex, so editing goes on. The frame and captions become a temporary darktable style (borders plus a watermark SVG), and AI upscale wraps the chosen format. `export_release` then drops what is left of the job's snapshots.
   4. For Immich, Rust uploads each file and adds it to the album. Progress comes as `export-progress`, shown on the activity line with a Stop (`export_cancel`) and then a summary.
7. **Import a folder.**
   1. `openFolder` calls `open_folder`. For a folder read before, Rust first sends the folder's snapshot (`known`): its photos as the last whole read found them, from the runtime folder, so the filmstrip fills before the folder is even listed. Each known photo shows its last thumbnail (`thumb_known`, by its path alone, without looking at the file, which on a network share is a round trip each) and its rating, labels and capture time, through the filters, in the order the read will end with (`withKnown`), and opens on a click.
   2. Rust walks the folder, skipping packages and sidecars, from the listing alone (`listing.rs`, no look at each file), keeping each file's size and time (`cache::Listed`), and sends engine `import` in batches sized to take about 150 ms, reported as `folder-progress` at most once a second (`Progress`): each event redraws the filmstrip, a cell for every file. The batches are tagged and read on the engine's import thread (`_import_run`), so editing goes on meanwhile. Known photos no longer listed go; a photo read takes its known cell's place, and its thumbnail is then checked against the file's size and time as listed (`thumb_cached`), else rendered again. A thumbnail rendered takes the file as it is then (`cache::refresh`), so an edit saved here is not checked against the listing's sidecar.
   3. A newer folder request cancels the older one through `folder_token`. A whole read writes the folder's snapshot. Each batch carries the token as `job` and a `budget` of twice `IMPORT_TARGET`; the engine's `_import_files` stops before its next file once the request reader has queued another read's batch (`_import_latest`, the newest job rather than the highest, as the client's tokens restart on reload) or the budget has passed after at least one file, and replies with `done`, the files it went through. Rust sends the rest in the next batch. Without this, a network share's batches left queued on the single import thread, each holding `_import_lock` per file, held up the next folder's import and `open` (whose `_import` takes the same lock) for minutes on wifi. `[engine] import` in `engine.log` is logged as a batch is queued, `[engine] imported k of n in t ms` as it finishes. Foreground first: the import and thumbnail threads call `_background_yield()` before each file or thumbnail and wait while the main loop is inside `_handle`, has requests queued, or finished one under 300 ms ago (`_foreground`, `_fg_busy`, `_fg_last`), for at most 2 s so a batch still progresses and stays inside Rust's 30 s timeout. A zoom or edit render therefore does not compete with a folder read for CPU or `_import_lock`. Verify with `python3 verify/background-priority.py` (headless, no GUI): it times 100% zoom renders of an edited photo idle and while 120 files import and thumbnail, and fails if the median slows more than 1.5x; before the change it measured 1.59x, after 1.04x. Under back-to-back renders the background work waits its 2 s cap per file, so it finishes slowly until the user pauses. Verify headlessly by queuing a large batch with one `job`, then a small one with another: the first replies with `done` below its file count, and a 1 ms `budget` imports one file per batch. The budget and job checks only run between files, so a read that blocks inside one file (a half-dead SMB share held one for 129 s, with `_import_lock` held) is cut short differently: `_import_files` first has `_file_answers()` read the file's first bytes and its `.xmp`'s on a throwaway thread, waited on for `probe_ms` (default 5 s, `_PROBE_TIMEOUT_US`) before `_import` takes the lock. A file that does not answer is left out of `images` and listed in the reply's `unanswered`, and its folder is skipped at once for 30 s (`_quarantine`); the abandoned thread ends when the mount answers or fails. Rust drops to batches of one after an `unanswered` and returns the list from `open_folder`; skipped files come back when the folder is read again. `python3 verify/import-stall.py` (headless, POSIX) uses a FIFO sidecar as the stall and checks the skip, the quarantine, that `open` is not blocked and that other folders import.
   4. Thumbnails follow from `ThumbLoader` (engine `thumb`) while the editor is idle.
8. **Edit In.**
   1. `editIn` calls `plugin_launch`, which opens the app with the files, then `plugin_watch`.
   2. Rust polls the output folder and emits `plugin-returned` for each finished file, saved in `plugin-returns.json`.
   3. Opening a returned file applies the plugin's return values, for example lens corrections off after PureRAW.
9. **Immich browse.**
   1. `ImmichPanel` searches through `immich_search`.
      The result's FileMenu shows Import Parent Folder only while `immichBase`
      confirms a configured server URL and stored API key. The action is enabled
      when `remote.localPath` is available (disabled otherwise).
      `importImmichParent` cancels debounced searches, calls
      `addPathToLibrary` to add/unhide the parent or expand its existing root,
      opens the Folders card and Library panel, and calls `showFolder` in grid
      view. Normal subfolder settings apply; cached downloads never supply a
      parent. Verify unopened and opened mapped results, a parent already under
      a library root, and unmapped/downloaded results (disabled action).
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
| Macro Studio jobs | `plugin-jobs/` in the runtime folder: each job's manifest and receipt, and `pending.json` | until every stack is saved or closed, or 30 days |
| Engine config, cache, log | `config/`, `cache/`, `engine.log` in the runtime folder (`build/app-runtime` in dev, the app data folder in a release) | permanent; the log restarts past 5 MB |
| Frames, thumbnails, previews, maps | `frame.rgba`, `thumb-<tag>.rgba`, `preview.rgba`, `range.bin` in `/dev/shm/immage-engine-XXXXXX` on Linux (the runtime folder if it can't be made; shared-memory objects on the Mac and Windows) | overwritten per request; a thumbnail's deleted once read; the folder goes when the app quits, and one a killed app left (no lock held on its `owner.lock`) at the next start |
| Frames handed to the page (Linux) | `/dev/shm/immage-frame-<token>-<id>` | until the page reads it; left over past a minute, deleted at the next start |
| AI models | `build/ai-models` (dev) or `<app data>/models` | until deleted |
| Library thumbnails | `cache/thumbs`: a JPEG named for the photo, its sidecar and their times; a `.last` beside, by path alone, naming the newest | cache |
| Folder snapshots | `folders/` in the runtime folder: each folder's photos as its last whole read found them | permanent; written again at each read |
| Immich thumbnails and originals | `cache/immich-thumbs`, `cache/immich-originals` | cache |
| Import catalog, Immich key | the immporter's SQLite catalog under the app data folder (`immporter/`); the key in the system keychain | permanent |
| spektrafilm data packs | `<user data>/darktable/spektrafilm/packs/<hash>/` (`~/.local/share` on Linux), downloaded by darktable's `spektra_fetch.c` from darktable-org/darktable-spektrafilm; a hand-installed pack in `<user data>/darktable/spektrafilm` wins | permanent, shared with darktable |
| Benchmark results | `benchmarking/results/` (see [benchmarking guide](../../../benchmarking/README.md)) (GUI reports under `gui/` in a dev build, `<app data>/benchmarks` in a release) | permanent, tracked |
| Source photos | wherever the user keeps them | never written, except the sidecar |

## Tests and reference tools

| File | Coverage |
|---|---|
| `#[cfg(test)]` in [main.rs](../../src-tauri/src/main.rs), [engine.rs](../../src-tauri/src/engine.rs) | `cargo test` in `app/src-tauri`: model release lookup, folder listing, sha256, the `-d perf` parser, the window renderer's selection (including Automatic with NVIDIA loaded and both vendors installed), persistence and inherited environment handling. |
| [test_release_assets.py](../../../scripts/test_release_assets.py) | Release assembly checks: both Linux downloads and updater entries, missing bundles or signatures, duplicate architectures and mismatched versions. Run by the build workflow. |
| `npm run build` in `app/` | Type checking (`tsc --noEmit`) and the production bundle; there is no front-end unit test runner (the release checks run the front end's `Session`). |
| [verify/](../../../verify/README.md) | The release checks: the app's `Session` run under Node against the engine (`harness.mjs`, with `shim.mjs` for Tauri's invoke), every slider and mask slider measured, an edit saved and opened again, old edits rendered, a check per bug fixed and per decision about Immage's behavior, and the benchmark's main timings against the last run. |
| [verify/print.py](../../../verify/print.py), [verify/print.test.mjs](../../../verify/print.test.mjs) | Print and soft proof: printer profiles, the proof's and gamut warning's pixels and frame hashes, PDF output and refused requests against the engine; the page layout and `Session.redraw()` after a proof through the app's code ([print.md](print.md)). |
| [benchmarking/](../../../benchmarking/README.md) | The engine benchmark (driven with the app's own manifest), the GUI benchmark's reports, the dashboard. |
| `build/spike/*.py` | Untracked, local scripts that drive the engine headless, one per feature (masks, zones, frames, spots, AI). Useful patterns, not a suite. |
| `darktable/src/tests/integration/` | darktable's pixel tests; run them when a change reaches the pixelpipe or `src/iop/`. |
| `darktable-cli` | darktable's own headless render, for comparing against the engine. |

## Build, packaging and documentation

| File | Responsibility |
|---|---|
| `cmake --build build` | darktable, `libdarktable` and `build/bin/darktable-engine`. |
| [package.json](../../package.json) | `npm run tauri dev` (dev build, engine from `build/bin`), `npm run tauri build`. |
| [webext/frames.c](../../src-tauri/webext/frames.c) | The Linux web extension for shared-memory frames, built by [build_appimage.sh](../../scripts/build_appimage.sh) into `src-tauri/resources/webext` (gitignored). |
| [bundle_engine.py](../../scripts/bundle_engine.py), [build_dmg.sh](../../scripts/build_dmg.sh) | The engine and its libraries copied into `src-tauri/resources/darktable` (gitignored) and made relocatable; the macOS disk image. |
| [fetch_lensfun_db.py](../../scripts/fetch_lensfun_db.py) | Downloads the current lensfun database from lensfun's site into `build/lensfun-db`; both bundle scripts ship it as `share/lensfun` instead of the package copy (0.3.4, from 2023, which lacks newer cameras such as the Sony ZV-1). It fails the build if the download fails or `ZV-1` is missing, and writes `timestamp.txt` (the snapshot's date). |
| [build_engine_windows.sh](../../scripts/build_engine_windows.sh), [bundle_engine_windows.sh](../../scripts/bundle_engine_windows.sh), [WINDOWS.md](../../WINDOWS.md) | The Windows (MSYS2 UCRT64) build. |
| [prune_target.mjs](../../scripts/prune_target.mjs) | Frees `src-tauri/target` of earlier builds, which cargo never removes: keeps what the last two builds of each profile use, as cargo lists it. npm runs it before and after every `npm run tauri ...`. |
| [build_opencv.sh](../../scripts/build_opencv.sh) | OpenCV for HDR Merge's alignment and Panorama Merge: the five modules darktable links and stitching, which the engine links, static, into `build/opencv/install`, which `scripts/build.sh` and `build_engine_windows.sh` hand darktable as `OpenCV_ROOT`. |
| [fetch_immporter.sh](../../scripts/fetch_immporter.sh), [immporter.rev](../../immporter.rev) | The importer, cloned into the gitignored `immporter/` at a pinned commit. |
| [app/docs/](../README.md) | The user guide, for photographers. |
| [benchmarking/README.md](../../../benchmarking/README.md) | Performance suite, results and findings. |
| [darktable/dev-doc/](../../../darktable/dev-doc/README.md) | darktable's own developer docs: the module API, pixelpipe, introspection. Read them before changing the engine's calls into darktable. |

For MinGW, `engine/CMakeLists.txt` excludes the five static OpenCV archives
from `lib_darktable`'s automatic DLL exports. Otherwise the engine's import
library supplies OpenCV symbols before its own stitching/core archives are
linked, producing duplicate definitions. Darktable's own symbols remain
exported. Verify the Windows engine link succeeds as well as the configure
check and panorama smoke test below.

Windows engine configuration also sets `OpenCV_STATIC=ON`: OpenCV's Windows
root package otherwise searches for shared libraries and can miss the installed
`x64/mingw/staticlib` package. `IMMAGE_REQUIRE_PANO=ON` makes missing stitching
a configuration error instead of shipping an engine without panorama support.
Verify the Windows configure log says `Panorama Merge enabled`, then select two
overlapping local photos and check the projection preview and Merge action.

## Module options and metadata editing

`MODULE_CHOICES` in [manifest.ts](../../src/manifest.ts) is the source of truth
for the alternatives, preferred defaults, global controls and local controls.
Each choice's `preferred` option follows darktable's AgX workflow except
Clarity and Texture, which prefer `contrastntexture` for its OpenCL path
(GPU check: 8 ms against diffuse's 17 on an Apple M4). A new raw no longer
gets `capture` set on open (App.tsx `openFile`), and Reset all leaves it at
its neutral 0; `verify/harness.mjs` opens photos the same way. Reset all
(`resetAll` in App.tsx) keeps the other module settings (`isModuleSetting`:
the tone mapper) but sets each `MODULE_CHOICES` control to
`Session.preferredModules()`, the Preferences pick, in the same
`changeMany`, so the panels show that module's sliders after a reset.
`MASK_MODULE_CHOICES` filters these to the alternatives implemented by
`localMaps`; masked Contrast offers color balance rgb (default) and atrous,
and masked Saturation color balance rgb (default) and satcurvergb, excluding
AgX because tone mappers cannot be masked. Their color balance rgb option is
the shared `localBalanceMap`, which has no choice of its own, so both are
special-cased there and in Session (`MASK_SHARED_SLIDER`: the slider that
says the tool is used, and the fallback to 1 for a mask with neither
module's instance).
[moduleChoice.ts](../../src/moduleChoice.ts) resolves global and mask scopes
separately: `immage.modules.choices` and `immage.modules.choices.masks` in
localStorage share the `immage.modules.mode` Default/Custom switch.
[ModulePrefs.tsx](../../src/ModulePrefs.tsx) renders Global and Masks chevrons
using the `focusMode` prop passed by PreferencesDialog. Focus mode initially
opens Global only; opening either group closes the other. Alt-click keeps
both open. With focus mode off, groups toggle independently; Alt-click opens
one alone (or closes it if it is already the only open group).

[ModuleSwitch.tsx](../../src/ModuleSwitch.tsx) is the icon and fixed-position
menu beside a tool's name, for a `MODULE_CHOICES` entry with two or more
options. `PanelView` (App.tsx) finds each choice's host with `switchHosts`:
the first of `choiceCovers` that `choiceShows`, or `ce_0_0` / `sc_pn` when the
equalizer or saturation curve replaces the slider (their headings take a
`module` prop). It passes `moduleChoice`, `moduleValue` and `onModule` as
primitives and stable callbacks so `SliderWidget` stays memoized. A pick
calls the hidden `mod_*` control's `onChange`, which reuses the Session
render path above. In masks, `MasksPanel` builds its own `switchHosts` from
`MASK_MODULE_CHOICES` and the mask's `localControls`, and a pick is
`setLocal(mask, mod_*, v)`. **Set as default** calls `storeModuleMode("custom")`
and `storeModuleChoice` (global or masks scope). GUI case: `module-switch`.
Choice and toggle controls (Black & White's `bw_mode`) host no icon yet.

Session preserves used global choices in `chooseModules` and infers each
loaded mask's choices from its module instances in `loadMasks`. New masks
start with the mask preferences in `Mask.values`. Closing Preferences calls
`Session.adjustedModules` lists, live, every module of a tool that holds edits: those `chooseModules` found on open (`usedModules`, while the opened module stays shown), those whose own sliders (`ModuleOption.controls`) are off neutral, and the shared-slider module holding a value the shown module hides (`sharedHolder`, set in `set()`); headless check `verify/module-others.test.mjs`. `ModuleSwitch`'s `adjusted` prop draws the icon dot (any module but the shown one) and a dot per module in the menu (masks: `maskAdjusted`, from `localControls`). `refreshModuleChoices`, updating unused global and mask tools and notifying
the UI without replacing used adjustments. Mask rendering, `planMerge` and
MasksPanel resolve choices from mask values before global values; mask modules
no longer select the global tool's module. `setLocal` accepts module-choice
controls as well as adjustment controls so undo and copied masks retain them.
[ContrastEqualizer.tsx](../../src/ContrastEqualizer.tsx) replaces global Contrast
when `mod_contrast` is 2. `equalizerMap` maps 30 `ce_<channel>_<band>` values to
`atrous`'s `y[channel][band]`: five channels, six bands, range 0–1. The first
three channels are neutral at 0.5, noise channels at 0. Reset restores every
channel; the module is disabled at neutral. The graph's viewBox pads the 260×140 plot by
a handle's reach (`PAD`), so end and top/bottom points draw whole; pointer
positions map back to plot units through `plot`. A press focuses the point it grabs:
its `preventDefault` otherwise left focus where it was, and the arrows went
there. The same map and graph support
masked Contrast when the mask's `mod_contrast` is 2. Local curve values retain
their 0.001 precision on reload. Each mask has its own atrous instance; it does
not participate in shared-instance merging. Color balance rgb continues to
carry the mask's Whites, Hue, Saturation and Color Grading, with its Contrast
neutralized while atrous is selected.
[SaturationCurve.tsx](../../src/SaturationCurve.tsx) replaces global Saturation
when `mod_saturation` is 2 (`MOD_SATCURVE`; `choiceShows` hides the slider).
`satcurveMap` maps `sc_pn`, `sc_p<k>x/y` (saturation) and `sb_*` (brilliance),
up to 20 points each as the tone curve's point ids, to `satcurvergb`'s
`channel[c].curve_num_nodes` and `channel[c].curve[k].x/y`; slots past the last
point are written as 0, as darktable leaves them. y is half the factor
satcurvergb applies (`curve_to_factor`), so the neutral curve is flat at 0.5
and unused control slots hold (1, 0.5). The formula, curve type and guided
filter keep darktable's defaults. The graph is `PointCurve` with
`guide="flat"`, drawn with `monotone` (Fritsch-Carlson, as darktable's
MONOTONE_HERMITE); there is no saturation histogram. Color balance rgb's
global Saturation is `active` only on its own option, or AgX's on a photo on
sigmoid, so it never runs beside the curve. Masks reuse the same ids on their
own satcurvergb instance (not merged) when the mask's `mod_saturation` is 2;
MasksPanel draws the curve in Presence, hidden in black and white, and
`localBalanceMap` writes the mask's Saturation at neutral meanwhile.
`detailMap` uses separate `contrastntexture` instances for Clarity and Texture,
with local counterparts; [DetailControls.tsx](../../src/DetailControls.tsx)
folds everything except Medium and Fine details under Advanced. Global
Defringe uses `cacorrectrgb` globally and in masks, with no module choice:
darktable deprecates `defringe`. A mask saved with the old `defringe` option
keeps that instance in its history, which still renders and is disabled when
the mask is deleted, but no slider reads or writes it.

Verification: `node verify/contrast-equalizer.test.mjs` checks parameter round
trips, independent preference scopes and mask choices in shared rendering.
`node verify/mask-modules.mjs` uses the built engine and a temporary sample
photo to check global AgX alongside masked atrous, preservation of used mask
choices, and rendering, saving and reloading the mask's curves and module
selection. `node --test verify/saturation-curve.test.mjs` checks the
saturation curve's choice, its single active Saturation module, both curves'
round trips and its mask option; `node verify/saturation-curve-engine.mjs`
renders, saves and reloads global and masked curves with the built engine
and checks that they raise the frame's chroma. `npm run build --prefix app`
checks TypeScript and the front-end bundle.

[CaptureTimeDialog.tsx](../../src/CaptureTimeDialog.tsx) builds before/after
entries for a shared offset, skipping invalid recorded times. App.tsx retains
the last batch for confirmed restoration. Rust `capture_times` forwards to
engine `_capture_times`, which checks expected times before writing sidecars.
[LocationEditor.tsx](../../src/LocationEditor.tsx) saves GPS through `meta_set`;
[map_tiles.rs](../../src-tauri/src/map_tiles.rs) supplies the optional map tiles.

Rust `positive_export` (`kind` "negative" or "film") exports a converted
negative or a film simulation as a losslessly compressed 16-bit float DNG or
32-bit float TIFF, `<name>-positive` or `<name>-film`, with the engine's
`export` flag `positive_copy` (`negative_copy` is still accepted). Engine
`_positive_import` gives the baked image a persistent neutral starting
history. App.tsx's generated-result
handling observes Open generated photos for merges, AI denoise, positives and
the first plugin result, and clears incompatible Immich filtering so the result
can be edited. Successful activity notifications expire after 30 seconds.

Folder reads use a token to reject stale progress/results and time out an
engine batch after 30 seconds. FolderTree loads expanded branches independently.
Engine shutdown in Rust is bounded to five seconds even without a quit reply;
Linux parent-death handling also terminates an orphan engine after an app crash.

## Batch settings paste

`App.pasteSettings` freezes the clip and exact selected local imgids (or the
open photo when selection is empty). It does not expand paired photos; virtual
copies retain their own ids. `Previous` still calls the single-photo path.
The modal plus synchronous busy ref block overlapping edits/shortcuts and
navigation. The viewer leaves Before, drains/saves its Session and clears base
and copy timers before relinquishing the engine. The same photo is reopened
in `finally` without clearing the selection or the UI undo stacks.
`Session.inheritUndo` retains earlier native-module opening states across that
reload. Each batch appears as one `Snap.batch` edge; multi-step History jumps
cross batch edges sequentially, and discarded edges release their snapshots.
Undo remains scoped to the current editor history, not a persistent library log.

`batchPaste.applyClip` uses the same `Session.setMany`, look, negative-module
and mask operations as single-image Paste. Masks replace the target collection,
including resetting values absent from a same-named source mask. An unavailable
look path fails rather than removing the look silently. Each target opens a
background Session: normal per-image mappings and mask transports run, but
previews and delayed autosaves do not. Explicit close drains all pending work
(including native module changes), propagates background pump failures and
saves before advancing. Before snapshots, `pasteDefaults.preparePastePhoto`
establishes an unedited baseline for never-opened photos using the frozen
new-photo profile, exposure compensation, capture sharpening, preset and Auto
preferences. Existing saved edits are untouched. Auto may request a small
measurement preview; ordinary target edits do not render full previews.

The Rust `paste_batch` command serializes each engine request. Engine
`_paste_batch` supports `begin`, `commit`, `undo`, `redo`, `abort`, `release`.
Begin validates all ids/paths/duplicates before taking private native history
snapshots with `_snapshot`. Commit records the completed state. Restore copies
full history, module order and mask data, restores baseline/current hashes and
the edited tag, invalidates mipmaps and explicitly writes XMP. Sidecar failures
are returned per image; failed recovery keeps the token so Undo can retry.
Stale undo/redo is checked for the whole target list before any restore. Snapshot
versions are excluded from library listings and released with their UI entries
or at engine shutdown. These tokens do not survive an engine restart.

Verification: `node --test --test-isolation=none verify/batch-paste.test.mjs`
runs production Session/mapping/batch code through `verify/shim.mjs` and the real
engine in isolated temporary photo/runtime directories. It covers targeting,
native look parameters/strength, rendered undo/redo, untouched groups, virtual copies, mask/crop preservation,
persistence, undo/redo, stale edits and failed sidecar recovery. The separate
`batch-paste` visible-app case uses actual Copy/Paste controls and modifier
selection, then checks values, look amount, rendered output, both sidecars,
undo/redo, reopening and an unselected image. See the GUI coverage ledger for
execution status; writing the case is not a GUI pass.

## Keeping this current

- Update the entry when a file is added, moved or changes its job, here
  and in its one line in [code-map.md](code-map.md).
- Refer to code by symbol, not line number.
- Contracts belong in comments beside the code. Measured results belong in [benchmarking/](../../../benchmarking/README.md), and decisions about darktable internals belong in darktable's `dev-doc/`. This file only says where things are and how they connect.
- After changing a diagram's spec in [`diagrams/build_diagrams.py`](diagrams/build_diagrams.py), rerun it so the `.excalidraw` and `.svg` files agree.

GUI benchmark resource sampling: [resources.rs](../../src-tauri/src/resources.rs)
records CPU, process memory, Linux threads and available GPU counters on a
background worker; `App.tsx` attaches phase timestamps to report version 5.
The GUI dashboard plots these alongside timing summaries.

[detailPreview.ts](../../src/detailPreview.ts) identifies controls eligible for
native loupe rendering. Detail and grain drags start directly in the loupe at
the display scale, without probing whole-image rendering first. Disabling the
loupe keeps eligible detail drags at full visible preview resolution. Release renders the exact full view.

`renderLoupe(id)` in `App.tsx` builds each loupe; every mounted display
registers in `loupeDisplays` by id and is redrawn from the shared
`loupeCanvas`. The main panel passes `detail` and `presence`; MasksPanel
takes `presenceLoupe` (id `mask-presence`) and shows it atop its Presence
group. The point pick runs in the viewer's pointer-down capture phase
(`onLoupePickDown`), ahead of MaskOverlay's handles and brush, which stop
propagation.

In headless screen pipes, the engine pixelpipe patch retains the last edited
module's input and the scaled output of `demosaicscale`, identified at the next
active piece. Three recent scaled checkpoints survive ordinary replacement;
upstream invalidation and memory cleanup still apply. This does not retain
full-resolution GPU demosaiced pixels. Ordinary darktable GUI pipes keep their
module-requested checkpoints.

Histogram/scope inputs coalesce before copying at 12.5 Hz during interaction.
Release flushes pending input, and final frames bypass the cadence delay.
Copies are deferred until after drawing, with separate histogram and clipping
workers. Surface generations reject stale results after a frame, photo or crop
change. Workers support synchronous fallback and dispose on cleanup.

Adaptive cached preview interpolation was removed after latency and visual
quality regressed.

### Rejected-photo deletion

`deleteRejected` in `App.tsx` hides confirmed targets through `updateImages`
before awaiting navigation or `trash_files`. Originals hide their virtual
copies too; deleting a copy hides only that copy. Pending deletion predicates
filter library updates so refreshes cannot restore thumbnails during the job.
The open session saves and closes before the Rust command moves files and
sidecars to Trash. Failed navigation aborts deletion. On error, release the
pending filter and refresh only if the same local folder is still displayed,
recovering actual disk state even after a partially successful batch.

Verify with slow Trash operations: thumbnails should disappear immediately,
including copies of deleted originals. Refresh while pending, test a deletion
failure, and switch folders before completion to verify recovery stays in the
correct folder. Check that sidecars are saved before files move.

### Thumbnail scheduling while scrolling

Filmstrip's IntersectionObserver tracks the actual viewport, clearing its
visible IDs when rebuilt or unmounted. ThumbLoader partitions its queue by
current visibility on every scheduling pass, including after asynchronous disk
reads and render completions. Visible cache checks run first, in batches of
eight; visible cache misses then take the two engine slots before off-screen
cache checks. Already running reads and renders finish normally. A rendering
ID set prevents repeat viewport requests from queueing duplicate renders.

Verify on an uncached large folder: scroll far down while thumbnails load,
then back up. The next free render slots should serve the current viewport
before the previous region; also check horizontal filmstrip scrolling and
switching between grid and filmstrip. Cached thumbnails should still appear
without rendering, and folder thumbnail progress should eventually finish.

Loupe grid behavior: `App.tsx` suppresses requests from completed frames and
preferences in grid view. The session’s `detailView` callback returns null
while `gridRef.current` is true, preventing queued loupe work from starting;
frame delivery also ignores late loupe results. The grid-dependent effect
cancels point picking on entry and requests a refresh on exit when enabled.
Verify by browsing grid selections with the loupe enabled: no new loupe
renders should start, and leaving the grid should refresh the selected area.
Native rendering uses the full-resolution buffer loaded when opening the
session; loupe updates add processing but do not independently reopen the file.

### Camera body filtering

`engine/main.c::_image_json` sends `exif.body_serial` for folder and metadata
replies. `engine/strip.cc::camera_body_serial` reads the original with Exiv2,
under darktable's Exiv2 mutex: standard `Exif.Photo.BodySerialNumber`, then
DNG `Exif.Image.CameraSerialNumber`, then Exiv2's camera serial easy accessor
for recognized maker notes. It never searches arbitrary serial tags (which
could identify a lens). Missing, unsupported, all-zero and common unknown
values return an empty string. Strings preserve leading zeros.

The request/import threads share a mutex-protected cache of up to 4096 source
paths by modification time, change time and size, avoiding repeated EXIF reads for metadata requests and
virtual copies. Sidecars do not determine body identity. The optional field in
`library.ts::Exif` tolerates old folder snapshots and Immich results; normal
folder progress replaces snapshots with current engine metadata.

`filter.ts::bodyOf` uses a JSON tuple of make, model and complete serial as
the identity, or the empty string for **Serial not recorded**. `passes`,
`facets`, `popupCount` and `needsRead` include `bodies`; selections use OR
within the category and AND with other categories. `FilterPopup.tsx` places
Camera body below Camera, uses existing draft/Search/Clear semantics and
faceted counts, and wraps long serial labels. Immich server search is unchanged.

Verify with `node --test verify/camera-body.test.mjs` after building the engine.
The checks cover standard and DNG serial extraction, leading zeros, lens-only
metadata, unknown values, identical models with swapped lenses, combined
filters and facet counts. Run `npm run build` in `app` for frontend validation.

### Linux WebKitGTK packaging

WebKitGTK release versions (for example, 2.52 or the pinned 2.54.2) are separate
from the API/ABI package name `webkit2gtk-4.1`. Here `4.1` identifies the GTK 3 /
libsoup 3 API used by both runtime modes, not an older engine release. See the
[WebKitGTK API documentation](https://webkitgtk.org/reference/webkit2gtk/2.42.1/).
The bundled mode pins 2.54.2; system mode uses the installed distribution version
if compatibility checks pass. Do not document Mint's version as 2.52 without
runtime/package evidence. User-facing instructions should say "system-installed
WebKitGTK" or "bundled WebKitGTK 2.54.2" instead of "WebKitGTK 4.1".

The normal Linux jobs in `.github/workflows/build.yml` build x86-64 and ARM64
AppImages on Ubuntu 22.04 (glibc 2.35), retaining compatibility with Linux Mint
22.x. The image libraries from `build_linux_deps.sh` are installed first so
ARM64 has JPEG XL available. `.github/ubuntu-packages.txt` lists WebKit's
GTK3 build dependencies explicitly, including LibXslt development headers. Do not install Jammy's broad WebKit
source build dependencies or `libgstreamer-plugins-bad1.0-dev`: they pull in
distribution OpenCV, VTK and FFmpeg, conflicting with the image-library PPAs
and ARM64's source-built OpenEXR/Imath. WebKit keeps video and WebAudio enabled;
MPEG-TS and GStreamer WebRTC are disabled. The pinned WebKit source is patched
by `patches/webkitgtk-optional-mpegts.patch` so its CMake component list honors
`USE_GSTREAMER_MPEGTS=OFF` with video enabled; upstream's C++ code already guards
the MPEG-TS includes and calls with that flag. Apply the patch to the pinned
tarball and check CMake component resolution with the flag both off and on when
updating WebKit. The patch hash participates in the staged WebKit cache key.
CI pins libunwind runtime and headers to Ubuntu together and removes conflicting LLVM 14 development headers.
Verify both Linux package-install steps before checking compilation and the
packaging tests; local shell checks cannot establish APT resolution. With those installed,
`app/scripts/build_webkitgtk.sh` builds SHA-256-pinned WebKitGTK 2.54.2 using
GTK 3, JavaScriptCore and matching helpers, then installs them into `/usr`
for Tauri to bundle. Both architectures use GCC 14 from the Ubuntu toolchain
PPA; GCC 12 rejects ANGLE's assertion in a discarded template branch. A C++23 compiler probe runs
before source download to catch this immediately. The compiler name is included
in the staged installation cache key. Non-release CI caches the staged
installation by Ubuntu baseline, architecture and script/patch hashes. Release
jobs can reuse these caches when dispatched on the branch that owns them; see
[Releasing](releasing.md).
WebKit compilation uses two jobs and the Linux job allows six hours.

After packaging, `app/scripts/check_webkit_bundle.py` requires both bundled
libraries to report 2.54.2 and checks for WebKitWebProcess, WebKitNetworkProcess
and the injected bundle. `--max-glibc 2.35` scans undefined dynamic symbols in
all packaged ELF files, including helpers and engine libraries, and rejects
newer glibc imports. These checks run before artifact upload. Run the script
with the AppDir path, `2.54.2` and `--max-glibc 2.35` to repeat them. They
establish library versions and the glibc baseline, not a complete desktop
compatibility test; launch the resulting AppImage on Mint and benchmark it.
Packaging regressions run with `python3 -I scripts/test_webkit_bundle.py`,
including missing helpers/libraries, mismatched JavaScriptCore and newer glibc
imports. GUI reports obtain the runtime version through `tauri::webview_version()`.
The published 0.41.0 bundled runtime showed a Mint/X11/NVIDIA regression;
selecting Mesa after an initial launch with
`GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 ./Immage.AppImage` was the
confirmed workaround for that release. Starting with 0.41.1, automatic system
WebKit selection and the GBM default described below resolve the reported
Mint startup and rendering issue without requiring Mesa. Manual testing also
confirmed normal launch on Ubuntu/Wayland. These observations do not establish
performance on every NVIDIA system. Automatic window renderer selection still
uses system EGL selection, independently of the launcher's WebKit selection.

Starting with 0.41.1, Linux runtime selection is installed by
`app/scripts/prepare_appimage_launcher.py` after Tauri deploys the AppDir.
`AppRun.bundled` preserves the generated launcher and GTK hook. The new
`AppRun` selects `IMMAGE_WEBKIT=auto|system|bundled` before either runs.
An explicit single `GDK_BACKEND` wins over `XDG_SESSION_TYPE`, then Wayland/DISPLAY
presence is used only if the session type is unavailable. Backend lists are
uncertain and retain the bundle. Known backends are pinned for launch.
Automatic system selection requires X11 and a loaded NVIDIA driver, detected
through DRM driver links or `/proc/driver/nvidia/version`; hybrid systems can
qualify even if NVIDIA is not driving the window.

System mode bypasses both bundled AppRun and its GTK environment. A separate
`usr/bin/immage-system` copy has its ELF RPATH/RUNPATH removed. Its entire UI
library closure comes from the host, avoiding mixed GLib/GTK/WebKit/JSC stacks.
The existing frame extension in `usr/lib/Immage/webext` also has its private
search path removed: it uses the WebKit/JSC already loaded by either runtime,
with AppRun supplying bundled search paths only in bundled mode. Its resource
location stays unchanged, so the launcher can be applied to an existing release
without recompiling the app. The engine retains its own resource library
RPATHs; photo processing is unchanged. The launcher clears inherited loader,
GTK module/schema and WebKit helper overrides in system mode, checks `ldd -r`
for missing dependencies/symbols or bundled UI paths, and checks host WebKit
helpers and injected bundle adjacent to the resolved host library or in
`/usr/libexec/webkit2gtk-4.1`. Host WebKit uses its compiled helper paths;
matching helper override paths are also exported for builds supporting them.
This validates dynamic symbol availability, including the frame extension's JSC
typed-array calls; it does not prove rendering performance or runtime ABI behavior.
Auto falls back before app startup if checks fail; forced system stops with an
error. An app failure after startup is never retried automatically.

Once system preflight succeeds, X11 plus NVIDIA defaults
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM` to `1` only if the variable is unset.
Explicit `0` enables GBM, explicit `1` disables it; all supplied values are
preserved. The setting is applied before exec and inherited by WebKit helpers
and relaunch. Wayland (including forced system mode), non-NVIDIA hosts, bundled
mode and preflight fallback get no automatic GBM override. The system launch
message records `GBM-disable`. This follows a manual Mint report: confirmed
`WebKit=system backend=x11` still aborted with NVIDIA selected, while adding
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM=1` launched quickly. Ubuntu testing also
succeeded. The user subsequently confirmed the updated automatic launcher
works on both Mint/X11 and Ubuntu/Wayland. These are manual results on the
reported machines, not automated GUI passes or measurements across hardware.
The launcher tests cover scoped defaults, explicit on/off overrides and no
changes on Wayland, non-NVIDIA, ambiguous backend or fallback paths.

`repack_appimage.sh` installs the selector and repacks with the AppImage output
plugin, reusing the base image's runtime instead of downloading another.
`build_appimage.sh` uses Tauri's cached output plugin and regenerates updater
signatures over the final bytes.
It fails if a release configuration lacks signing credentials. The normal
bundled copy and packaged 2.54.2 verification remain intact. Headless launcher
and ELF search-path regressions run with
`python3 -I scripts/test_appimage_launcher.py`; no real app or GUI is started.
Dispatch `build.yml` on the experiment branch with `launcher_experiment=true`
(`gh workflow run build.yml --ref release-0.41.1 -f launcher_experiment=true`).
This skips all ordinary build jobs and calls `launcher-experiment.yml`, which
builds only x86_64. It verifies
the published v0.41.0 x86_64 AppImage and output plugin against pinned SHA-256s,
extracts the baseline, applies the launcher and repacks it. It runs headless
packaging tests, verifies the 2.54.2 bundle/glibc baseline and launcher wiring,
and uploads `immage-launcher-experiment-linux-x86_64` with a checksum and build
identity. The editor remains the released 0.41.0 binary (including its reported
version/commit); later changes such as batch paste are absent. This isolates
the launcher comparison and avoids WebKit compilation. The workflow neither
launches the editor nor signs/publishes an updater or release. The ordinary
source build also includes the launcher for subsequent builds.
Compare forced system and bundled runs on Mint/X11/NVIDIA with matching photos,
renderer settings and scale, then verify Wayland retains the bundle. Confirm the
reported WebKit version, frame delivery and helper processes, as well as speed.
The user guide and README provide explicit Mint/X11/system/GBM-off and
Ubuntu/Wayland/bundled launch recipes. Verify normal launch and the renderer's
in-app Relaunch against these recipes, with no inherited shell overrides, then
check explicit `WEBKIT_DMABUF_RENDERER_DISABLE_GBM=0` and `=1` take precedence.
Manual result: the user confirmed run 41391144072's x86_64 artifact (launcher
commit cb4f987) works on both reported systems. Detailed helper/frame checks,
individual override combinations and broader hardware coverage are not established
by those confirmations. No local GUI automation was run.

Fractional-scale drag compensation (`scale.rs`, `pixelRatio.ts`, `draftK` in
`App.tsx`) remains active: at 125% on a GTK 2x surface, reduced drafts use a
0.625 scale multiplier. Full-quality release frames keep the GTK pixel size.
The adaptive cached-preview experiment remains removed; native previews and
scaled GPU checkpoint retention remain in use. Verify the scaling behavior
with the existing `decisions` check and placement with `verify/preview-placement.py`.

### Visible-app GUI verification

`verify/gui/run.mjs` launches the checkout's release app and real engine through
Tauri WebDriver on a visible Linux desktop. XDG directories isolate app state
and the webview profile; a cross-worktree desktop lock serializes input. Only
that session's main app URL/window can receive actions or screenshots. Config
contains paths, never injected scripts; checked-in observation functions read
DOM/CSS/geometry/canvas pixels without calling Tauri or changing application state.

`paintFrame` marks the sharp canvas with `data-render-quality` (`draft` or `final`)
when it presents a frame. The suite combines that read-only marker with stable
pixels to avoid accepting a drag draft after release. It drags Exposure using
WebDriver pointer actions, checks displayed and range values and brightness in
both directions, and resets through a label double-click. Expected mean pixel
error after reset is below 1/255. See `verify/gui/README.md` for setup, evidence,
coverage limits and remaining scenarios. Results stay in `verify/results/gui/`;
fixture originals and the user's running app are not test state.
