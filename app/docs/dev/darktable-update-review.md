# darktable update review: 2747ed2 → 8790676

Status: source-impact audit recorded; adoption blocked, pin unchanged.
Build, image compatibility and platform validation are separate gates in the
[progress checklist](#progress-checklist).

Follow [Pinning darktable](darktable-pin.md). Candidate frozen at
`879067695ea85f42d238a5c1603a021d14d71d3f`; current pin is
`2747ed2a0d162515bd9c91d02201653de895dddb`. Upstream master was fetched
on 2026-11-03 UTC. Fetch updated master successfully but returned nonzero
because upstream moved its `nightly` tag; the local tag was preserved.

## Findings so far

- Range: 365 commits, including 308 non-merge commits, affecting 235 files.
  Every commit is accounted for by source-impact scope below. The
  [file ledger](darktable-update-files.tsv) covers all 235 changed paths.
  This is an Immage integration audit, not independent verification of every
  upstream UI algorithm or translation. Merge resolutions are assessed separately.
- The complete current engine patch passes `git apply --cached --check` against
  an isolated temporary index populated from the candidate. This verifies textual
  application only, not the behavior of the patched pipeline.
- Contrast & Texture OpenCL arrives in `7d7dac363d`, followed by common-kernel
  helper changes in `8075f03504`. Its parameter structure does not change in
  this range. It uses tone equalizer kernels and adds kernel program 46.
  CPU processing remains available; parity, allocation failure and device
  fallback still need execution.
- AgX introspection advances 7→8 and sigmoid 3→4. Both add output-peak
  controls and legacy conversions preserving the old follow-output setting as
  false. Output headroom is initialized, derived from the output profile, and
  included in the pipeline cache hash. Existing edit conversion and SDR/HDR
  exports need reference comparisons; textual preservation is not pixel proof.
- Masks gain variable-length preset/style blend blobs carrying forms. The
  pre-repair engine discarded these through fixed-size/legacy conversion.
  The compatibility repair below uses the upstream reader and preserves
  preview ownership, mask history and cache identity. Candidate headless
  verification passes; native/platform validation remains required.
- Linux database lock checking now reads `/proc/<pid>/cmdline` and checks for
  the string `darktable`. Test live and stale locks with the actual packaged
  engine executable name, including concurrent engine startup.
- Cache hashes now use committed parameters rather than module parameters.
  Recheck drag cache hits, external raster masks, invalidation and cancellation
  with Immage’s cache instrumentation and output sink.
- Lens correction switches to a coarse coordinate grid; diffuse, denoise,
  highlight reconstruction, rawprepare, colorspace arithmetic and final scaling
  also change. These can alter pixels or performance independently of Texture.
  Ashift changes CPU coordinate accumulation in pixel processing only; the
  copied fitting code in `engine/upright.c` needs no change from this range.
- `src/libs/neural_restore.c` changes wording/formatting in the inspected diff;
  no `src/ai`, `src/common/ai` or external dependency submodule commits occur
  in this range. Integration fixtures advance to `52f404eeab`.
- Grain gains OpenCL as part of upstream. Keep it outside the performance
  initiative and headline comparison, per project scope.

## Focused compatibility audit

This section records the incompatibilities identified before the repair below.
Engine line references describe the pre-repair source at `1920a95`; upstream
line numbers refer to the frozen candidate. Runtime results are recorded
separately under Style compatibility repair and verification.

### Confirmed incompatibility: style blend blobs (repair verified headlessly)

`engine/main.c:_item_params` (line 8433) copies current blend parameters only
when the blob is exactly `sizeof(dt_develop_blend_params_t)`. A valid version-15
blob with an appended mask tree instead reaches
`dt_develop_blend_legacy_params`. Candidate `src/develop/blend.c:2419–3004`
converts older versions (through 14), not current-version blobs. The resulting
failure makes Immage copy default blend parameters and still return success.
Thus the look can appear to load while losing its blend settings and mask.
This is a source-confirmed incompatibility, not an observed render failure.

Upstream's `src/common/styles.c:912–925` now uses
`dt_develop_blend_params_read` (`src/develop/blend.c:3031`). It decodes the
variable-length blob, imports forms with fresh IDs, migrates classic masks
in current-version fixed-size blobs, and can preserve a locked target mask.
Simply accepting a larger blob and copying its prefix would retain foreign
mask IDs without importing the forms. The engine's existing fixed-size fast
path also bypasses the new classic-mask migration.

The repair below adapts the loader and its preview/history interactions.
Headless fixtures now cover version-15 attached forms, current-version and
version-14 classic masks, truncated tails, repeated application with ID
collisions, a locked destination mask, look removal, save/reopen and fresh-process
sidecar import. Switching between two distinct circle-masked exposure looks also
passes. Native/platform verification and broader saved-style coverage remain
required before pin adoption.

### Lock handling: Linux executable checks pass; native platforms pending

Candidate `src/common/database.c:3934–3984` fixes an existing Linux procfs
lookup to read `/proc/<pid>/cmdline`. `strstr` examines only the first
NUL-terminated argument, not every command argument. The normal application
path uses `darktable-engine` plus the platform executable suffix
(`app/src-tauri/src/main.rs:2607`), which satisfies the Linux substring check.
The synthetic argv passed to `dt_init` in `engine/main.c:9752` does not change
procfs argv and is not the reason this is compatible. A renamed executable
selected through `DT_ENGINE_BIN` can fail the check if its actual argv[0]
contains no `darktable`.

The engine defaults its library to `:memory:` but passes a persistent config
folder from Rust; this does not establish that all database locks are absent.
`verify/database-locks.py` passed against both isolated candidate builds
(AI/OpenCL off and on), invoking their actual `bin/darktable-engine` executable.
With the default in-memory library, `config/data.db.lock` exists and contains
the owning engine PID. A second engine using that config exits with a database
lock error without replacing the lock, while the first remains responsive.
Killing the owner leaves a stale lock; a new engine replaces it with its own
PID, responds, and removes the lock on graceful exit. A subsequent clean startup
also succeeds. The runner uses temporary config/cache/data only and kills only
its owned children. This verifies sequential live-owner exclusion, not a
simultaneous first-start race or an installed application bundle.

```sh
python3 -I verify/database-locks.py --build build/darktable-pin-review/cpu
python3 -I verify/database-locks.py --build build/darktable-pin-review/features
```

Windows already requires a `darktable.exe` suffix in this
function, which `darktable-engine.exe` does not satisfy; that predicate is
unchanged in this range and needs a separate existing-behavior check. Native
Windows/macOS, renamed overrides and simultaneous first-start checks remain open;
these Linux results establish no cross-platform lock guarantee.

### Upright, module versions and build inputs

- The entire range diff for `src/iop/ashift.c` only adds an FMA matrix helper
  and calls it from pixel `process()`. Neither `ashift_lsd.c` nor
  `ashift_nmsimplex.c` changes. There is no fitting-code change to copy into
  `engine/upright.c` from this range. CPU/OpenCL transformed pixel parity still
  needs testing because coordinate rounding changes.
- Searching all `src/iop` diffs finds introspection version changes only in
  AgX (7→8) and sigmoid (3→4). Their new output-follow flags default true;
  legacy conversion sets them false. This does not establish that defaults
  or parameter meanings in other modules are unchanged.
- Top-level CMake removes optional JSON-schema validation, adding no build
  dependency there. `src/CMakeLists.txt` adds `common/filter.c` and
  `develop/masks/blend_blob.c`. No external dependency gitlink, `src/ai` or
  `src/common/ai` file changes occur in this range.
- Kernel program IDs 46, 47 and 48 belong to Contrast & Texture, RGB chromatic
  aberrations and grain respectively. Candidate `data/kernels/CMakeLists.txt`
  globs all `.cl` files and copies them at configure time. Reconfigure the
  candidate build and verify the packaged kernel directory and manifest agree;
  a stale build-tree copy is insufficient. Grain remains outside this initiative.
- The cache parameter hash change is specifically in
  `src/develop/imageop.c:2566`: it hashes the `params` argument supplied to
  `dt_iop_commit_params` rather than `module->params`. This is not a switch to
  hashing `piece->data`. Cache invalidation and output-sink execution checks
  remain required.

## Source-impact audit disposition

The frozen range is assessed by integration boundary, final source changes and
upstream history. The inventory's scope labels describe the strongest relevant
impact of each non-merge commit; they are not runtime pass marks. All 308
non-merge commits and 57 merges are accounted for. A `--remerge-diff` inspection
of every merge found resolution differences in 14 merges, all confined to
`RELEASE_NOTES.md`; there are no source-code merge resolutions in that report.

### Required repairs and highest risks

1. **Style masks, preview ownership and history:** the confirmed blob reader
   mismatch above is the largest saved-edit blocker. `_item_params` is shared by
   `_look` and `_preview`. The upstream reader mutates `module->dev->forms`, so
   replacing the call without isolating preview forms would contaminate the live
   image merely by generating look tiles. Applied forms must also be recorded
   with `dt_dev_add_masks_history_item_ext`; ordinary history insertion does not
   snapshot forms. The pre-repair `_preview_commit` overrides the upstream piece
   hash and omits mask-tree content. Preserve mask identity in preview hashes as
   part of the repair. These form one ownership/serialization repair, implemented
   and checked headlessly below.
2. **AI-disabled build:** an isolated Release Linux ARM64 candidate configure
   with AI/OpenCL off succeeded. Compiling `darktable-engine` compiled `main.c`
   and `upright.c`, but failed in `engine/hdrmerge.c:245` because `M_PI_F` is not
   declared. Include its owning `common/math.h` explicitly. This is an observed
   build failure in that configuration; it has not been shown to originate in
   the pin update rather than an existing transitive-include dependency.
3. **Image changes:** preserving parameter layouts does not preserve pixels.
   The reference comparison matrix below is mandatory before adopting the pin.
4. **Database ownership:** packaged Linux naming is compatible in source, but
   persistent config/data-database live/stale/concurrent locking is unverified;
   the unchanged Windows name predicate warrants a dedicated test.

### Engine, saved-edit and module boundaries

- All changed public headers were checked for engine-facing removals/signature
  changes, and the candidate compiled the main engine and Upright translation
  units. Added interfaces include blend-blob reading, history merge targeting,
  tile resampling, PQ peak selection and display transforms. The changed
  `dt_control_export` signature belongs to upstream job submission; Immage uses
  its own export path. No direct engine call repair was identified there.
- Parameter-struct and introspection review identifies AgX and sigmoid as the
  versioned layout changes. Other changed IOP structs add processing/global/GUI
  data rather than new saved parameter layouts. Existing `manifest.ts` fields
  therefore need execution against generated introspection, not speculative
  renames. Contrast & Texture's CPU function and saved params are unchanged.
- AgX/sigmoid old-edit conversion disables output following. New defaults enable
  it, and headroom now comes from the output profile and PQ peak setting. Immage
  display pipes explicitly select sRGB; its export UI offers SDR profiles.
  Upstream HDR export job/CLI options do not add an Immage setting by themselves.
  Old-style tone mappers and SDR exports still need image comparisons.
- Blob decoding validates tails, form sizes/types and point records, strips
  pixel-backed AI objects when styles are created, and remaps imported IDs.
  Current-version classic masks migrate too. History auto-apply now shifts mask
  history numbers with module history. Immage's sidecar/mask serialization and
  paste settings must retain their existing contracts with these changes.
- Path resize/rotation, multi-selection, mask panel hosting, raster hover tint,
  preset layout/help and slider changes are upstream interactive UI paths.
  Immage supplies its own mask UI. Stored path loading, blob decoding and
  migration remain relevant and are included in mask fixtures; upstream panel
  declarations are not claimed as Immage GUI coverage.
- Lightroom import changes crop/rotation, curves, exposure defaults, working
  profile, clarity, retouch, split toning and post-crop vignette, and adds a
  foreign-XMP-applied image flag. Automatic develop-time import is gated on
  `dev->full.pipe` and `loading`; Immage initializes its render pipe after
  `dt_dev_load_image`. Test foreign sidecars explicitly rather than assuming
  the upstream darkroom's new import behavior runs in Immage.
- Spektrafilm changes film exposure/scan ordering, D65 compressor input, glare,
  density models, grain seeding and memory use. It is not a mapped adjustment,
  but imported styles can enable it; include such a style in compatibility
  references. Grain timing remains excluded from this performance initiative.
- Rawspeed now releases read/metadata locks during exception unwinding. Exif
  changes Nikon Active D-Lighting detection. The engine's dropped-share patch
  still applies; neither source result replaces dropped-share execution checks.
- Cache changes hash the supplied committed params and output headroom. The
  important-input checkpoint patch and synchronous byte-output sink still apply
  at their existing boundaries; cache reuse, failure recovery, cancellation,
  follower pipes and external raster masks need execution on the rebuilt engine.
- Collection filter SQL moves into `common/filter.c` without a schema-version
  bump in the range. Workspace restart is guarded by GUI initialization; the
  engine initializes with GUI disabled. Upstream filmstrip, shortcuts, themes,
  dialog and catalog filter UI changes do not alter Immage's frontend.

### Required image and performance comparisons

| Area | Source change | Required comparison |
| --- | --- | --- |
| AgX / sigmoid | Output-dependent tone mapping, legacy conversion | Old and new edits, SDR previews/exports; HDR if supported later |
| Vignette | CPU falloff smoothing now runs with dithering off | Existing nondithered vignette, crop/rotation and CPU/OpenCL |
| Diffuse / negative / equalizer | More accurate exponentials; EAW tap accumulation and flat-weight fast path | Texture, negative conversion and contrast equalizer, low/high strength |
| Lens | Adaptive coarse grid, retained grids, nonfinite/noisy fallback, OpenCL Lanczos correction | Wide-angle corners, inverse mode, vignetting/TCA, repeated/changed params and ROI |
| Denoise | Mirrored borders, corrected middle search-row counting, memory factors | Edges/corners, tiny images, CPU/OpenCL and memory-limited fallback |
| Highlights / rawprepare | Late chroma correction, per-channel clipping, bounds fixes, linear-raw OpenCL, invalid white fallback | Bayer/X-Trans/linear raws, clipped colors, disabled temperature, invalid white |
| Demosaic / curves / color | Markesteijn/PPG fixes, initialized lanes, curve extrapolation, precise color math and hue wrapping | X-Trans/Bayer edges, out-of-range curves, color grading near hue wrap |
| Scale / transforms | Correct tile phase/extent, upscale device checks, pixel-aspect transforms, ashift FMA | Tiled versus untiled exports, odd dimensions, upscales, masks on non-square pixels |
| New OpenCL paths | C&T, RGB CA and enlargecanvas; allocation-error cleanup | CPU/OpenCL pixels, unsupported devices and allocation fallback |
| Imported styles | Blob masks and Spektrafilm behavior | Masked looks, old parameter versions, tile/apply consistency, save/reopen |

### Build and packaging disposition

No new mandatory engine dependency is introduced by the range. Upstream adds
cmocka to its Brew test dependencies and moves JSON validation from ordinary
builds into scripts/CI; noise profiles and white-balance data are still installed.
Immage's own bundlers copy the complete installed share directory. Upstream's
macOS cache relocation and Inno Setup context-menu/uninstall changes belong to
its installers, not Immage's DMG/NSIS paths. OpenCL kernel ABI version advances
7→8; ship a fresh configure/install tree and the matching kernel manifest,
including the three new programs. No external dependency gitlink changes beyond
the integration fixture update were found. AI source/interfaces and model-version
selection are unchanged in the range; both AI build modes still require checks.

The source audit supports starting the compatibility repairs. It does **not**
approve the candidate pin, pixel parity, performance gains or platform support.

## Progress checklist

Checked items have completed evidence described in this review. An unchecked
item is pending or only partially verified; passing a narrower check does not
complete its broader adoption gate. Update this checklist as checks finish.
The production pin remains unchanged until the adoption gates pass.

### Source audit and compatibility repair

- [x] Freeze the candidate and account for all 365 commits and 235 changed paths.
- [x] Review all 57 merge resolutions; source resolutions require no extra repair.
- [x] Apply the complete engine patch in an isolated candidate source tree.
- [x] Repair variable-length style blend blobs, mask import, preview isolation,
  history snapshots and mask-sensitive cache identity.
- [x] Add the explicit HDR merge math header required by the candidate AI-off build.
- [x] Update release notes and user/developer guides for the compatibility repair.
- [x] Check current-pin engine and HDR merge source syntax with original build flags.

### Candidate headless validation (Linux ARM64)

- [x] Build engine, IOP/imageio modules and deploy data with AI/OpenCL both off.
- [x] Build the same targets with AI/OpenCL both on (render checks force CPU).
- [x] Verify masked-style import, colliding IDs, repeated previews/application,
  locked geometry, malformed blobs, failure recovery and classic-mask migration
  in both builds.
- [x] Verify look removal, save/reopen and fresh-process XMP import in both builds,
  using the exact/bounded comparisons documented below.
- [x] Verify full/drag/base output-sink equality, resize/cache/reuse, output failure
  recovery, pre-start cancellation, preview and JPEG export in both builds.
- [x] Verify persistent data-database live-owner exclusion, stale-lock recovery,
  graceful cleanup and restart with the actual engine name in both builds.
- [x] Read live/default scalars and individually rewrite initial values for all
  444 global/local mapped fields across 28 modules in both builds.
- [x] Change and restore each of 444 mapped scalars, preserving neighbors, in
  both candidate builds and the existing original-pin build.
- [x] Compare synthetic-PNG mapped live/default values and enabled flags across
  those builds; compare all 14 mapped enum type declarations between pins.
- [x] Write production global/local control boundary/neutral values and every
  choice declared on mapped controls through both candidate builds and the
  existing original-pin build (1,280 scenarios, including 86 choice scenarios).
- [x] Compare production read-back and recognition/activation/enable/visibility
  predicates for all 1,280 control-write scenarios against the existing original
  build in both candidate builds (synthetic PNG, base modules only).
- [x] Exercise production session preference/history selection, foreign exclusion,
  negative overrides, snapping, bypass and combined tone-mapper choices against
  original/candidate synthetic-PNG snapshots (headless; masks/rendering stubbed).
- [x] Check candidate AgX/sigmoid output-follow defaults and direct/wrapped legacy
  conversion with byte-exact old-prefix preservation in both builds.
- [x] Compare mapped defaults/live values and flags for a disposable Nikon D3S
  NEF across the existing original build and both candidates (444 scalar checks).
- [x] Repeat the mapped RAW defaults comparison with an Olympus ORF in all three
  builds; all 444 scalar checks pass and snapshots match exactly.
- [x] Check sigmoid v1/v2 migration chains and on-disk synthetic legacy style
  imports (sigmoid v1/v2/v3 and AgX v7) in both candidate builds.
- [x] Apply and render those synthetic legacy tone-mapper styles: exact tile/applied
  pixels and converted bytes, visible contribution and exact disable restoration.
- [x] Load constructed AgX v7 and sigmoid v1/v2/v3 historical XMP in fresh
  processes; verify complete converted params/blend bytes and exact reference pixels.
- [x] Build a coherent isolated old-pin engine/module reference; compare fresh
  PNG, Nikon NEF and Olympus ORF CPU pixels at 96/512 bounds against both
  candidate configurations (all RGBA bytes exact).
- [x] Compare old-created exposure, sigmoid v3, AgX v7 and non-dithered vignette
  histories after fresh-process XMP loading on PNG/NEF/ORF at 96/512 bounds;
  record exact matches and nonzero differences separately (details below).
- [ ] Resolve saved-edit appearance policy for the measured vignette differences
  and assess the small AgX RAW deltas before adopting the candidate.
- [x] Trace vignette serialization and CPU/OpenCL falloff semantics, including
  the production mapper's explicit 16-bit dithering (compatibility analysis below).
- [x] Compare six old-saved vignette variants on PNG/NEF/ORF at 96/512 bounds:
  both dithered cases exact; non-dithered brightness/saturation/shape cases differ.
- [x] Compare old-saved anisotropic diffuse smoothing/sharpening on PNG/NEF/ORF
  and non-local-means denoise on PNG at 96/512 bounds; record nonzero differences.
- [x] Compare old-saved rotation/perspective, lowered-threshold Bayer highlights
  and Lensfun/metadata-selected lens histories at 96/512 bounds; repeat metrics
  and frame hashes, recording nonzero differences separately.
- [x] Isolate measured transform differences to ashift FMA and lens differences
  to the changed lens module, then separate coordinate-grid and vignetting
  contributions using independent diagnostic plugins (details below).
- [x] Isolate the larger Olympus Lensfun differences to negative-value clipping
  lost by factor multiplication; verify isolated clamp and step-1 diagnostics.
- [x] Compare Olympus Lensfun and metadata-selected histories at actual
  4640×3472 output; isolate the larger full-size difference with step-1/clamp.
- [x] Separate full-size Olympus coordinate and vignetting-grid effects: direct
  coordinates reproduce the old frame exactly without a negative clamp.
- [x] Compare both RAWs' forward/metadata/reverse lens histories at 96/512
  using bilinear, bicubic, Lanczos2 and Lanczos3 warp interpolation.
- [x] Compare Olympus full-size reverse Lensfun and confirmed 2×2 CPU lens
  tiling; compare saved 0.75/1.5 pixel-aspect histories at 96/512 bounds.
- [x] Isolate old CPU tile-layout sensitivity with split-row Lensfun probes and
  correction-selector histories, including unit-scale vignetting-only renders.
- [x] Compare saved Olympus 0.75/1.5 pixel-aspect histories at full-size bounds
  without lens tiling; direct-coordinate/clamp diagnostic reproduces both frames.
- [x] Compare full-size Olympus forward/reverse pixel-aspect histories under
  mini/unrestricted budgets; confirm 0.75 uses 3×3 lens tiles and 1.5 is untiled.
- [ ] Assess lens and transform appearance deltas, including the isolated rotation
  boundary pixel; cover reverse lens, interpolation modes, tiling and pixel aspect.
- [ ] Assess diffuse and denoise saved-edit appearance differences with broader
  references, including RAW denoise, image borders and full-resolution processing.
- [ ] Verify production control read/selection semantics, RAW-specific defaults, new
  unmapped HDR fields and enum processing semantics with reference renders.
- [x] Verify A→B→A switching between two exported/imported masked exposure looks,
  with distinct geometry, exposure and opacity, in both candidate builds.
- [x] Extend B to a two-module look with an independently masked color-balance
  item and rotated ellipse; verify exact tile/application/switching pixels and
  live blend/mask isolation for both modules in both builds.
- [x] Save/reopen the two-module circle/ellipse look and import its sidecar in a
  fresh process; compare both modules’ params, all blend bytes, mask hashes and
  rendered pixels in both candidate builds.
- [ ] Verify broader real saved styles, additional mask shapes and module combinations.
- [ ] Verify pixel-backed masks and external raster-mask cache invalidation.
- [ ] Verify simultaneous first-start locking and installed/native lock behavior,
  including executable-name predicates on Windows/macOS/Linux.
- [ ] Preserve current-pin headless baseline and exported reference renders, then
  complete the old/new saved-edit and image comparison matrix described above.
- [ ] Complete broader RAW, transforms, AI, foreign-XMP and export checks.

### Platform, device and final adoption gates

- [ ] Run device OpenCL pixel comparisons, allocation/fallback and mid-render
  cancellation checks, including the new Contrast & Texture kernel dependencies.
- [ ] Run fresh platform CI and native CPU/OpenCL performance comparisons across
  supported Windows/macOS/Linux and x86-64/ARM64 configurations.
- [ ] Complete any required GUI validation with fresh explicit per-run approval.
- [ ] Adopt the candidate pin after validation; preserve the original patched
  source and unrelated ONNX CMake delta, and rebuild/package from a fresh
  configure/install tree with matching kernel manifest and ABI.
- [ ] Update release notes and user/developer documentation for the final pin bump.

Keep Texture/Clarity defaults unchanged until matched visual-strength tests
establish the benefit. A checked build or scalar-access item does not establish
pixel parity, native platform support or a performance gain.

## Complete commit inventory

| Commit | Kind | Source impact | Subject |
| --- | --- | --- | --- |
| [`3310020bd8`](https://github.com/darktable-org/darktable/commit/3310020bd85f45020c1d102da1666a0a2259a419) | non-merge | Upstream UI / catalog boundary | thumbnail: keep the filmstrip triangle when thumbnail is reused |
| [`beef57f539`](https://github.com/darktable-org/darktable/commit/beef57f53955ed63196f784e9b3e8914326f5829) | non-merge | Documentation / translation | RELEASE_NOTES.md: the filmstrip triangle stays after scrolling off screen |
| [`69a1df6abf`](https://github.com/darktable-org/darktable/commit/69a1df6abfb7db599af1c01bea8d1e4c926ce389) | non-merge | Engine / saved edits | Fix broken cmdline check in pid_is_alive |
| [`90bfc5b673`](https://github.com/darktable-org/darktable/commit/90bfc5b673707dcaeb536d8de9768f380b86408e) | non-merge | Engine / saved edits | We don't actually use content length |
| [`426a2ce2ea`](https://github.com/darktable-org/darktable/commit/426a2ce2eac4215cdbf790ec8408f2ec940fb45a) | non-merge | Engine / saved edits | presets: migrate classic masks of presets stored by the startup upgrade |
| [`f88ae4197a`](https://github.com/darktable-org/darktable/commit/f88ae4197ab2581173633d623a1f022bf1f0044f) | non-merge | Engine / saved edits | masks: migrate constant and uniform masks to flexi with no group |
| [`528489c8ab`](https://github.com/darktable-org/darktable/commit/528489c8ab77acac204025799d213b32c18252e6) | non-merge | Upstream UI / catalog boundary | masks: only offer 'a' on parametric channels with an alternative scale |
| [`fbbe530f13`](https://github.com/darktable-org/darktable/commit/fbbe530f13beb6718141f3c09be02fa7ad541a3f) | non-merge | Upstream UI / catalog boundary | masks: fix the mask panel's claims for modules without masks |
| [`74e9b4e794`](https://github.com/darktable-org/darktable/commit/74e9b4e79441461a1aef8771c137eb41d4598047) | non-merge | Engine / saved edits | masks: carry flexi mask forms in preset and style blend params |
| [`2b7dd1ca56`](https://github.com/darktable-org/darktable/commit/2b7dd1ca567924363565764a99376eb8577993c8) | non-merge | Upstream UI / catalog boundary | gtk: center yes/no dialogs on the main window when none is active |
| [`d67cb4e490`](https://github.com/darktable-org/darktable/commit/d67cb4e4906bd49252c04bb427ee605b5e8abca3) | merge | Merge resolutions checked | Merge pull request #22704 from victoryforce/pid_is_alive |
| [`ebb51118c7`](https://github.com/darktable-org/darktable/commit/ebb51118c73fb1366bd76193c1db08b9ba95dab0) | non-merge | Engine / saved edits | presets, styles: ask before saving a mask with an AI object as pixels |
| [`652880a8ca`](https://github.com/darktable-org/darktable/commit/652880a8ca063ceab886e9d19d59ab0418564a15) | non-merge | Engine / saved edits | presets, styles: leave AI objects stored as pixels out of the mask |
| [`91ca8e5f59`](https://github.com/darktable-org/darktable/commit/91ca8e5f596d1dea4a4665fe525f1fafc5bdd642) | non-merge | Engine / saved edits | presets: leave a locked mask alone when applying a preset or style |
| [`b8c8dad349`](https://github.com/darktable-org/darktable/commit/b8c8dad349d07f0740993230eec9f91acc4727e8) | non-merge | Engine / saved edits | history: shift masks history nums when auto-apply prepends |
| [`8ab6a6c2a4`](https://github.com/darktable-org/darktable/commit/8ab6a6c2a4521d8d821e4836b24a6f0df68485ef) | non-merge | Documentation / translation | RELEASE_NOTES.md: masks history kept in step with a prepended history |
| [`ef0660e8d3`](https://github.com/darktable-org/darktable/commit/ef0660e8d35f0842179dd922778817b0b15bcaa5) | non-merge | Engine / saved edits | masks: delete the selection from a header button or the delete key |
| [`4b45d64503`](https://github.com/darktable-org/darktable/commit/4b45d645036822284cfbf002056801b4c3421f96) | non-merge | Upstream UI / catalog boundary | masks: open an actions menu on a cluster's right-click |
| [`913c3a8a6d`](https://github.com/darktable-org/darktable/commit/913c3a8a6dec8629720f0ec17c1d5aca6e730126) | merge | Merge resolutions checked | Merge pull request #22705 from masterpiga/flexi-22688 |
| [`c86d24980b`](https://github.com/darktable-org/darktable/commit/c86d24980b83e2b3c13675c56ff4b9362f948e8a) | non-merge | Pixels / module compatibility | filmicrgb: release matrix buffers when displaying the mask in process_cl |
| [`4563a470c0`](https://github.com/darktable-org/darktable/commit/4563a470c02d287ed6c55ffebe4f9bb00b50f35b) | non-merge | Pixels / module compatibility | iop: initialize profile_info_cl before early error exits |
| [`46708dcbdf`](https://github.com/darktable-org/darktable/commit/46708dcbdfad395cfbb107a86c00ee455ceca1ec) | non-merge | Engine / saved edits | blend: free host luminance buffer on detail mask OpenCL errors |
| [`33ad7bec8d`](https://github.com/darktable-org/darktable/commit/33ad7bec8d64dae18e2b3ad91ec2fb63dea6600e) | merge | Merge resolutions checked | Merge pull request #22703 from masterpiga/flexi-fix-presets |
| [`70409b7e47`](https://github.com/darktable-org/darktable/commit/70409b7e47c4113dc6d8a8719c0c4f9196f292a2) | non-merge | Engine / saved edits | Improved --opencl-diffstat data |
| [`ad31c669fe`](https://github.com/darktable-org/darktable/commit/ad31c669fe387289ff651a33a16fbc4968794294) | merge | Merge resolutions checked | Merge pull request #22707 from masterpiga/flexi-delete-element |
| [`f2083b35bf`](https://github.com/darktable-org/darktable/commit/f2083b35bf5f370fc42e517fa43aac52c3528a67) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`18ea855483`](https://github.com/darktable-org/darktable/commit/18ea85548345b5c759c1c3b28c18bb072c831b7c) | non-merge | Upstream UI / catalog boundary | fix month collection filter layout issue |
| [`37c4dd2e98`](https://github.com/darktable-org/darktable/commit/37c4dd2e9806fbbf4919a9c06b4292a36335c7e6) | non-merge | Documentation / translation | add release note for month collection filter fix |
| [`02f2fe6d25`](https://github.com/darktable-org/darktable/commit/02f2fe6d251d3aeb4541d2cd10152c18ed198181) | non-merge | Documentation / translation | release notes: OpenCL resource leaks in iop error paths |
| [`e4a55efe2f`](https://github.com/darktable-org/darktable/commit/e4a55efe2fd31ba716f0dadb62314a69b7cb107a) | non-merge | Upstream UI / catalog boundary | themes: makes popup menus stand out a bit more |
| [`9907eba731`](https://github.com/darktable-org/darktable/commit/9907eba731d1e911da7a37cdb60d711442c4be12) | non-merge | Engine / saved edits | masks: UX improvements to import menu |
| [`c1827d0aad`](https://github.com/darktable-org/darktable/commit/c1827d0aad1b20bdef024b927c17729d1e6a818a) | non-merge | Engine / saved edits | Correctly reposition a misplaced NULL check |
| [`57340f7d12`](https://github.com/darktable-org/darktable/commit/57340f7d129ced5a807ae2af6a709f4908d40d9d) | merge | Merge resolutions checked | Merge pull request #22714 from zisoft/filter-month-layout |
| [`7e99c8c703`](https://github.com/darktable-org/darktable/commit/7e99c8c703329e35252a3bd54d7744f63969252b) | merge | Merge resolutions checked | Merge branch 'opencl_memleak_fixes' of https://github.com/piratenpanda/darktable |
| [`60a58713ef`](https://github.com/darktable-org/darktable/commit/60a58713ef79e99735db265dc470525828e41576) | non-merge | Engine / saved edits | pixelpipe: carry the output's peak luminance as output_headroom |
| [`c10bf49424`](https://github.com/darktable-org/darktable/commit/c10bf49424dd1e61eeb2d6cab53e4c5aae0e575a) | non-merge | Pixels / module compatibility | agx: form the image for the output's peak, as Blender's AgX HDR |
| [`228cbffe88`](https://github.com/darktable-org/darktable/commit/228cbffe880cd2760dfbd5ae1511ea0f2d578aba) | non-merge | Pixels / module compatibility | sigmoid: scale target white to the output's peak |
| [`89f1be0ec8`](https://github.com/darktable-org/darktable/commit/89f1be0ec86d604507b9d14d0f75c5aabcb298f6) | non-merge | Documentation / translation | RELEASE_NOTES.md: tone mappers follow the output's peak |
| [`e5d050c91e`](https://github.com/darktable-org/darktable/commit/e5d050c91efa873840c94075354046707232576a) | non-merge | Pixels / module compatibility | agx: group the HDR output fields of the tone mapping params |
| [`ecb9c6344d`](https://github.com/darktable-org/darktable/commit/ecb9c6344d06725a730fc8f5eba4672293c15a23) | non-merge | Engine / saved edits | export: keep the PQ peak an export was started with |
| [`5372ab35a9`](https://github.com/darktable-org/darktable/commit/5372ab35a9f9f982169c0793ef802549e1116228) | non-merge | Upstream UI / catalog boundary | export: store the PQ peak in export presets |
| [`ec545b8073`](https://github.com/darktable-org/darktable/commit/ec545b807330a646f95c90a0b3b8eee1a8a21a7f) | non-merge | Upstream UI / catalog boundary | cli: add --pq-peak to set the peak of PQ output |
| [`c4fb0bf54f`](https://github.com/darktable-org/darktable/commit/c4fb0bf54f439251950c2e719fa16f660e1823dc) | non-merge | Documentation / translation | RELEASE_NOTES.md: PQ peak in export presets and darktable-cli |
| [`a7053e1369`](https://github.com/darktable-org/darktable/commit/a7053e1369eb43d0a333184efcc028c765c16be3) | non-merge | Pixels / module compatibility | agx: keep the shoulder fit finite when the pivot reaches target white |
| [`84532d8eae`](https://github.com/darktable-org/darktable/commit/84532d8eae7d12a1091d1f14918bd47c9c9de8c1) | non-merge | Pixels / module compatibility | agx: pick the pivot on the SDR curve, also on an HDR display |
| [`020d1a5ac9`](https://github.com/darktable-org/darktable/commit/020d1a5ac9fce08b829f04f9aaa14e3d5f2aaea1) | non-merge | Upstream UI / catalog boundary | export: keep presets from changing a PQ peak they don't use |
| [`9430cb4af4`](https://github.com/darktable-org/darktable/commit/9430cb4af432a9a0bb44745d84498fc6188e5580) | non-merge | Documentation / translation | RELEASE_NOTES.md: AgX black highlights with pivot output at 100% |
| [`fff1aaca34`](https://github.com/darktable-org/darktable/commit/fff1aaca34414083c8722355fbb8480f8054458f) | non-merge | Pixels / module compatibility | overexposed: free iccprofile OpenCL params in process_cl |
| [`926bed03fe`](https://github.com/darktable-org/darktable/commit/926bed03feef26c7ce19973cc93b1fb693613f51) | non-merge | Pixels / module compatibility | overexposed: check colorspace transform result in process_cl |
| [`d05a3afd76`](https://github.com/darktable-org/darktable/commit/d05a3afd764d505b9a82c25e31e05f328f2f5964) | non-merge | Documentation / translation | release notes: overexposed OpenCL memory leak |
| [`f95eacd2cb`](https://github.com/darktable-org/darktable/commit/f95eacd2cbfe42fd3f9cca003dfad581225bd72c) | non-merge | Engine / saved edits | imageio: release the rawspeed locks when a raw read throws |
| [`e78dd567a6`](https://github.com/darktable-org/darktable/commit/e78dd567a660ab904e7e4eae928f8ff19705f4cd) | non-merge | Engine / saved edits | imageio: annotate the rawspeed lock guard for -Wthread-safety |
| [`121b1043ff`](https://github.com/darktable-org/darktable/commit/121b1043ffb81e029059b41f12ee6ad6d4a21f72) | non-merge | Documentation / translation | RELEASE_NOTES.md: hang on exit after a failed raw read |
| [`bbb9d73772`](https://github.com/darktable-org/darktable/commit/bbb9d73772489367557c995ac944eb6ec7d4b36b) | non-merge | Upstream UI / catalog boundary | fix memory leaks in camera polling, collection, range, shortcuts and styles |
| [`bf7e430126`](https://github.com/darktable-org/darktable/commit/bf7e4301265240e8c3b55c54be705ecfb4033519) | non-merge | Engine / saved edits | database: return when the data file has no parent in snaps_to_remove |
| [`c853b766ec`](https://github.com/darktable-org/darktable/commit/c853b766ec958a6a9dc0e6eee9e234ac6d0ae836) | non-merge | Upstream UI / catalog boundary | Prevent OOB read on a file with a name shorter than 4 characters |
| [`08010e2adc`](https://github.com/darktable-org/darktable/commit/08010e2adc92b6fefb9afd4cad2dc72e3accfd9f) | non-merge | Engine / saved edits | Make dt_focuspeaking avoid dereferencing NULL |
| [`46e5e53825`](https://github.com/darktable-org/darktable/commit/46e5e538256a097af825fe1db40100de03ef5c27) | non-merge | Engine / saved edits | spektrafilm: reduce CPU peak memory |
| [`7de9c3d4f9`](https://github.com/darktable-org/darktable/commit/7de9c3d4f9cce83be658fd587cd6c06b7fa575d7) | non-merge | Build / packaging | Run Windows installer silently when in silent mode |
| [`18e1137297`](https://github.com/darktable-org/darktable/commit/18e1137297d0456a46da95261f8a6bff361b5b2f) | non-merge | Documentation / translation | Add release notes entry for Windows installer silent mode |
| [`a0c75cfa21`](https://github.com/darktable-org/darktable/commit/a0c75cfa21390e3a005d4ce81540e3e559448860) | non-merge | Engine / saved edits | Visualize OpenCL vs CPU diffs add-on to --opencl-diffstat |
| [`5647467b25`](https://github.com/darktable-org/darktable/commit/5647467b25909276665e0aa81012d5058d4861b3) | non-merge | Upstream UI / catalog boundary | collect: point the folder/film roll context menu at the clicked row |
| [`c57e176834`](https://github.com/darktable-org/darktable/commit/c57e1768344ce6e582a0ba5e55505ccd9008de70) | non-merge | Pixels / module compatibility | Two markesteijn stability fixes |
| [`e6a548d764`](https://github.com/darktable-org/darktable/commit/e6a548d7645daf5e037ee70bb21f2a7115881670) | non-merge | Upstream UI / catalog boundary | masks: persistent channel overlay with shift+click |
| [`d3dde845dd`](https://github.com/darktable-org/darktable/commit/d3dde845dd8eb15fdef484b66c25ceb89c7a3766) | non-merge | Documentation / translation | Traductions bruno et manu 20261021 (#22737) |
| [`f369bd7042`](https://github.com/darktable-org/darktable/commit/f369bd7042d7797c3eb8954f2e9ecc362734be35) | non-merge | Upstream UI / catalog boundary | masks: stop the parametric expander tooltip naming the boost factor |
| [`1f12ef1bf1`](https://github.com/darktable-org/darktable/commit/1f12ef1bf18e5393618ec5b2c6cb8c02688b3e8e) | non-merge | Upstream UI / catalog boundary | masks: make "invert all elements" flip nested groups too |
| [`0cf6d9e0f7`](https://github.com/darktable-org/darktable/commit/0cf6d9e0f73e2d70bc9d7cbdf5ef170223c2f846) | non-merge | Engine / saved edits | Two addition OpenCL capabilities reported |
| [`a3423424f3`](https://github.com/darktable-org/darktable/commit/a3423424f30477331320ced343db187ec180e08d) | merge | Merge resolutions checked | Merge pull request #22729 from piratenpanda/more_memory_leaks |
| [`8f277bf47e`](https://github.com/darktable-org/darktable/commit/8f277bf47e53b282befb634f48ffa7919eccf82e) | merge | Merge resolutions checked | Merge branch 'overexposed_fixes' of https://github.com/piratenpanda/darktable |
| [`aa2346d7b9`](https://github.com/darktable-org/darktable/commit/aa2346d7b9143be1878b8ae674c784ee4b286b50) | merge | Merge resolutions checked | Merge pull request #22701 from yankeppey/fix/rawspeed-mutex-leak-on-exception |
| [`2af685755d`](https://github.com/darktable-org/darktable/commit/2af685755d806c27af43fcc132cf68fb268962b1) | merge | Merge resolutions checked | Merge branch 'output-headroom' of https://github.com/nicknezis/darktable |
| [`835997a4a5`](https://github.com/darktable-org/darktable/commit/835997a4a5c05726f4d6783ba4116f9aced72bf7) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`f4aeea4404`](https://github.com/darktable-org/darktable/commit/f4aeea440486b0a7a6ccc0b9ad26b17c8ea53c6b) | non-merge | Documentation / translation | Update French translation. |
| [`d4af396ae3`](https://github.com/darktable-org/darktable/commit/d4af396ae343a1a08251cab1f6ed8e863b381913) | merge | Merge resolutions checked | Merge branch 'fix-silent-windows-install' of https://github.com/AsjerS/darktable |
| [`6556cd7dbb`](https://github.com/darktable-org/darktable/commit/6556cd7dbb0e69f95d165dda8b69e7270c327f6d) | non-merge | Upstream UI / catalog boundary | fix underscore handling of menu items |
| [`4a67b36f52`](https://github.com/darktable-org/darktable/commit/4a67b36f523de6a4e3395410963762a81f3531db) | non-merge | Engine / saved edits | exif: recognize Nikon Active D-Lighting outside HLG |
| [`ff03c9a755`](https://github.com/darktable-org/darktable/commit/ff03c9a755067c8039b1e8502cd0775a56c87c90) | non-merge | Documentation / translation | RELEASE_NOTES.md: note Nikon Active D-Lighting compensation fix |
| [`67e2e0e66d`](https://github.com/darktable-org/darktable/commit/67e2e0e66da461e241a46fb86b1d7f264b32b3ee) | non-merge | Documentation / translation | Ukrainian translation update |
| [`296e919996`](https://github.com/darktable-org/darktable/commit/296e919996e0f41545bdd95ddbc7eda130d0f9cf) | non-merge | Upstream UI / catalog boundary | Update release dates in appdata file |
| [`5dc2392e86`](https://github.com/darktable-org/darktable/commit/5dc2392e865edeb56b16412ca02812a3d6397c68) | non-merge | Upstream UI / catalog boundary | libs: fix crash on right-click of a lib module header |
| [`1c892f58cd`](https://github.com/darktable-org/darktable/commit/1c892f58cd7bfe35b676d31c91fe4d7caf2a9ad8) | non-merge | Upstream UI / catalog boundary | masks: keep the utility host lib reachable from the modules list |
| [`f3fd9fc6c2`](https://github.com/darktable-org/darktable/commit/f3fd9fc6c2dfedb066ea7f07ad066f06f14cd68c) | non-merge | Pixels / module compatibility | Tooltip: fix number formatted like a list |
| [`6b388943f0`](https://github.com/darktable-org/darktable/commit/6b388943f089b7e0cec73e23772f736aed10bc99) | non-merge | Engine / saved edits | masks: show the focused module under the panel header |
| [`d01c1527dc`](https://github.com/darktable-org/darktable/commit/d01c1527dcbeb9142f976f310f6f265006cf7006) | non-merge | Upstream UI / catalog boundary | blend: show the blend opacity slider's own label |
| [`95feb93d10`](https://github.com/darktable-org/darktable/commit/95feb93d10294a34bd1a07a273e9adbeabbed77c) | non-merge | Upstream UI / catalog boundary | gtk: don't scroll side panel when clicking notebook tabs |
| [`c4d5b5a02c`](https://github.com/darktable-org/darktable/commit/c4d5b5a02c5eb163c51b4fbf3b53983721a38572) | non-merge | Engine / saved edits | spektrafilm: don't clamp grain USM output at the density floor |
| [`c93abe9e3e`](https://github.com/darktable-org/darktable/commit/c93abe9e3e7ca45a17a75a1658717a01f10e4146) | non-merge | Engine / saved edits | masks: selection panel layout, without the context menu and clusters |
| [`6a4830844b`](https://github.com/darktable-org/darktable/commit/6a4830844be8f3a08712429dfec5c37bc49afdea) | non-merge | Engine / saved edits | colorspaces: encode PQ and HLG thumbnails the way the pipe does |
| [`7076cab103`](https://github.com/darktable-org/darktable/commit/7076cab1033da4ba4e5e009bbca3b78f76f1c0e3) | non-merge | Pixels / module compatibility | satcurvergb: fix histogram calculation |
| [`7cb4369080`](https://github.com/darktable-org/darktable/commit/7cb4369080da6b3dc3850ae756a78b9021ca6e36) | non-merge | Pixels / module compatibility | Minor style fixes. |
| [`c8792dec77`](https://github.com/darktable-org/darktable/commit/c8792dec771edf8fe6560a74072dbb5c808b53c2) | merge | Merge resolutions checked | Merge pull request #22752 from Woodman3/codex/fix-nikon-active-d-lighting |
| [`1756979b67`](https://github.com/darktable-org/darktable/commit/1756979b674c3964cbf9da5e99a8d5ed4ce8578c) | non-merge | Upstream UI / catalog boundary | masks: group layout presets popover and default layout |
| [`f74a55a66f`](https://github.com/darktable-org/darktable/commit/f74a55a66f712f152dbac9ea1b9b1d0654c1a6a6) | non-merge | Upstream UI / catalog boundary | masks: show what ctrl+shift+click will delete in the layout list |
| [`5b25d7377f`](https://github.com/darktable-org/darktable/commit/5b25d7377f26893bc328eb75cde0995f4f7f5cde) | non-merge | Engine / saved edits | masks: name the parts of the tree element, group and member |
| [`ff93cf64c5`](https://github.com/darktable-org/darktable/commit/ff93cf64c5e393a903c57ebf9accf655091bf972) | merge | Merge resolutions checked | Merge pull request #22748 from masterpiga/flexi-ui-revamp |
| [`a5653de80e`](https://github.com/darktable-org/darktable/commit/a5653de80e61eb36b0c45ca03866b4378b6e838e) | non-merge | Upstream UI / catalog boundary | fix capture time based collection filter |
| [`cc75a50443`](https://github.com/darktable-org/darktable/commit/cc75a504438f4e8c533f6703099c8487de159c90) | non-merge | Documentation / translation | add release note for capture time collection filter |
| [`2d01539304`](https://github.com/darktable-org/darktable/commit/2d01539304a90a650656abfbb3a868145bcaffe5) | non-merge | Upstream UI / catalog boundary | Add more information to the failure message |
| [`e0185d092e`](https://github.com/darktable-org/darktable/commit/e0185d092e65cf85bc7d3b7b7874a60183f58051) | non-merge | Upstream UI / catalog boundary | Minor code readability maintenance |
| [`841871f6fc`](https://github.com/darktable-org/darktable/commit/841871f6fce6da29303d8c05a222cd33143dc5d0) | non-merge | Engine / saved edits | spektrafilm: salt grain and glare seeds with the image id |
| [`e1e2e26baa`](https://github.com/darktable-org/darktable/commit/e1e2e26baacde918ccfb07c192c32b832b60f87c) | non-merge | Pixels / module compatibility | The profiled denoise tabs should say "luma" and "chroma" |
| [`b11af51ca5`](https://github.com/darktable-org/darktable/commit/b11af51ca5454a7a4f436352646d776db72e57b3) | non-merge | Engine / saved edits | masks: keep path resize faithful and its nodes steady |
| [`441ebd2f7d`](https://github.com/darktable-org/darktable/commit/441ebd2f7d2e5eeffac1fa51b1ca5302ba3d1644) | non-merge | Engine / saved edits | masks: move the masking preferences into the masks panel |
| [`04d483b769`](https://github.com/darktable-org/darktable/commit/04d483b769189c6d40c0fd3abe1404c7e7b30cbd) | non-merge | Documentation / translation | RELEASE_NOTES.md: note the path mask resize fix |
| [`a45d5edb7e`](https://github.com/darktable-org/darktable/commit/a45d5edb7eb3c5f6c45c06d933051486e0b1f58c) | non-merge | Documentation / translation | RELEASE_NOTES.md: note the masking preferences moving to the masks panel |
| [`fee19b421f`](https://github.com/darktable-org/darktable/commit/fee19b421fdbf1bddd74307b68499943394993b6) | merge | Merge resolutions checked | Merge pull request #22770 from masterpiga/fix-22470 |
| [`bb6c3db489`](https://github.com/darktable-org/darktable/commit/bb6c3db489f414f00a610ed60b3b8a4e821640b7) | non-merge | Upstream UI / catalog boundary | masks: make a typed 0 on a relative property slider reach the minimum |
| [`6175cd5f68`](https://github.com/darktable-org/darktable/commit/6175cd5f6898f03cffee3377510609f26d0f4ecc) | non-merge | Upstream UI / catalog boundary | masks: start the property slider range at the minimum and explain it |
| [`456b0f9162`](https://github.com/darktable-org/darktable/commit/456b0f9162cd86510f6881968f6d3ee6a27fb8e8) | non-merge | Engine / saved edits | masks: tint a raster element's area when its panel row is hovered |
| [`1e5b3178e5`](https://github.com/darktable-org/darktable/commit/1e5b3178e5f7d6a30da533367b4b43e2033ea474) | non-merge | Documentation / translation | RELEASE_NOTES.md: note the raster mask tint on the canvas |
| [`0364e4a936`](https://github.com/darktable-org/darktable/commit/0364e4a936a210e8ec3ed93980d40ea70a924341) | non-merge | Build / packaging | refactor database routines |
| [`b0a32f084c`](https://github.com/darktable-org/darktable/commit/b0a32f084c9cb10f103ecd17a5ee81e0594bafa9) | merge | Merge resolutions checked | Merge pull request #22780 from masterpiga/fix-22777 |
| [`1bfbd851f4`](https://github.com/darktable-org/darktable/commit/1bfbd851f4c1d8cb53f268020fa2781f080810e2) | merge | Merge resolutions checked | Merge pull request #22760 from zisoft/capture-time-collection-filter |
| [`4e20953da4`](https://github.com/darktable-org/darktable/commit/4e20953da4f0255bd8aeb7cb176d758f874d2f21) | merge | Merge resolutions checked | Merge pull request #22781 from masterpiga/flexi-raster-overlay |
| [`df8be67253`](https://github.com/darktable-org/darktable/commit/df8be67253ef5fd75231d6b5b659007b25c0a6d7) | merge | Merge resolutions checked | Merge pull request #22775 from victoryforce/better-tethering-warning |
| [`2f3237ad23`](https://github.com/darktable-org/darktable/commit/2f3237ad231260295d17822a269a79fc3f684bab) | non-merge | Upstream UI / catalog boundary | "Pre-demosaiced" is incorrect if we meant "already demosaiced" |
| [`81f806c2ff`](https://github.com/darktable-org/darktable/commit/81f806c2ff39e2d7958e40f0993c521e654527a1) | non-merge | Pixels / module compatibility | spektrafilm: derive grain seed salt from the capture date and time |
| [`66c61cb1ce`](https://github.com/darktable-org/darktable/commit/66c61cb1ceb4015e992b657455df70e85ffe17d5) | non-merge | Engine / saved edits | spektrafilm: match the reference's fallback filters and coupler gammas |
| [`e231adbdc3`](https://github.com/darktable-org/darktable/commit/e231adbdc3a2b9b470ebbb3dc0c166ab723db1e4) | non-merge | Engine / saved edits | spektrafilm: run the OkLCh output compressor on D65-relative XYZ |
| [`84416b26a7`](https://github.com/darktable-org/darktable/commit/84416b26a71f22e44a464bddc3d0e97e310cd342) | non-merge | Engine / saved edits | spektrafilm: derive the density curves from the curve model throughout |
| [`ca67d4fd92`](https://github.com/darktable-org/darktable/commit/ca67d4fd92aac113ec0685aa664210966fe6e6d7) | non-merge | Engine / saved edits | spektrafilm: apply a positive scan's black/white exposure after halation |
| [`37d12f6b98`](https://github.com/darktable-org/darktable/commit/37d12f6b98a5daa2dec8912f8dc23e02272dc1dc) | non-merge | Engine / saved edits | spektrafilm: add the viewing glare in XYZ ahead of the compressor |
| [`cfd6aae58e`](https://github.com/darktable-org/darktable/commit/cfd6aae58e52ede6a4710c6198dc636b46b0c21e) | merge | Merge resolutions checked | Merge pull request #22785 from piratenpanda/spektra_reference |
| [`a06cd94a85`](https://github.com/darktable-org/darktable/commit/a06cd94a85cc66b8f83e2a2d15e74a3c64a02142) | non-merge | Engine / saved edits | masks: make canvas scaling and rotation reset the path resize baseline |
| [`fa09a49446`](https://github.com/darktable-org/darktable/commit/fa09a49446e75e9d4a9841f0cfeb9a0b99cc7d77) | non-merge | Documentation / translation | Nb update (#22787) |
| [`14958755b8`](https://github.com/darktable-org/darktable/commit/14958755b87f4a6c6418549204c46a613d473e90) | non-merge | Engine / saved edits | masks: support multiple selection with shift+click |
| [`27276e5a40`](https://github.com/darktable-org/darktable/commit/27276e5a4087d531579e591fc80702597617822d) | non-merge | Upstream UI / catalog boundary | geotagging: use binary search for GPX timestamp lookup |
| [`b0d3d61626`](https://github.com/darktable-org/darktable/commit/b0d3d61626eac91657779a6884ae0aa17ed03542) | non-merge | Pixels / module compatibility | scalepixels: fix the position of drawn shapes |
| [`ec2d490b40`](https://github.com/darktable-org/darktable/commit/ec2d490b407039d063cf56f3f9da6588b7733da7) | non-merge | Documentation / translation | RELEASE_NOTES.md: note the scale pixels drawn shape fix |
| [`0b74ecfbdf`](https://github.com/darktable-org/darktable/commit/0b74ecfbdfd757331f51f8ee4a9ef4a2e9856962) | non-merge | Pixels / module compatibility | opencl: initialize the unused lanes in filmic and the noise generator |
| [`a7318ae963`](https://github.com/darktable-org/darktable/commit/a7318ae9635da1abc224e0b55a395a6c179ce302) | non-merge | Documentation / translation | RELEASE_NOTES.md: filmic and noise fixes on macOS OpenCL |
| [`c61fdb6495`](https://github.com/darktable-org/darktable/commit/c61fdb64958c5104e219cf52f0b79b9ff0b51226) | merge | Merge resolutions checked | Merge pull request #22793 from da-phil/pl/fix_position_of_drawn_shapes_in_scalepixels |
| [`3a37ee0154`](https://github.com/darktable-org/darktable/commit/3a37ee01541190f1462c16e78104f987596d493e) | merge | Merge resolutions checked | Merge branch 'opencl-uninit-float4' of https://github.com/nicknezis/darktable |
| [`891e46cd57`](https://github.com/darktable-org/darktable/commit/891e46cd57b64d67dbde183d5d3c0e430edd11d6) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`624410e85c`](https://github.com/darktable-org/darktable/commit/624410e85c85aa9ab144d115541cc01dbbebe986) | non-merge | Tests / upstream CI | Run ctest in all Linux CI jobs |
| [`1cd4205b46`](https://github.com/darktable-org/darktable/commit/1cd4205b46edceb426cf695e3560ce03bbd4573c) | non-merge | Build / packaging | Add ctest run to macOS CI job |
| [`fd127daf54`](https://github.com/darktable-org/darktable/commit/fd127daf545086f4f2bd192b6ab36205fb29472f) | non-merge | Upstream UI / catalog boundary | gradientslider: don't move the marker on release |
| [`d43943ec51`](https://github.com/darktable-org/darktable/commit/d43943ec51c1522f996d1f9662f2101de7531061) | non-merge | Tests / upstream CI | Bump libheif version to the latest for AppImage build |
| [`e758c1ea92`](https://github.com/darktable-org/darktable/commit/e758c1ea9287437c8735c05ab0f3c671c7febbe2) | merge | Merge resolutions checked | Merge pull request #22799 from victoryforce/more-ci-with-ctest-run |
| [`69d5214b33`](https://github.com/darktable-org/darktable/commit/69d5214b33112655c73f3504a5f97c0491f82588) | non-merge | Engine / saved edits | Don't diffdump-visualize while in pipe masking mode |
| [`0a31984b89`](https://github.com/darktable-org/darktable/commit/0a31984b89e5803f88554450df34b303f0c0f2fc) | non-merge | Upstream UI / catalog boundary | unify filter structs |
| [`1730022177`](https://github.com/darktable-org/darktable/commit/17300221772a267e1c43258cfcfd1b3eefed41c6) | non-merge | Upstream UI / catalog boundary | refactor iso collection filter |
| [`4c193aebc3`](https://github.com/darktable-org/darktable/commit/4c193aebc3b2df5fc8d2a458d5cafca13773f07e) | non-merge | Upstream UI / catalog boundary | refactor aperture collection filter |
| [`ddf8f70684`](https://github.com/darktable-org/darktable/commit/ddf8f70684bac0838ee758a24a605bb18eb8c097) | non-merge | Upstream UI / catalog boundary | refactor exposure collection filter |
| [`6163629e2d`](https://github.com/darktable-org/darktable/commit/6163629e2d1e5919e5347c0c14831a6b0fe26cca) | non-merge | Upstream UI / catalog boundary | refactor exposure bias collection filter |
| [`11399bbe3f`](https://github.com/darktable-org/darktable/commit/11399bbe3fcd6f1cff1cb5272511077622911ebd) | non-merge | Upstream UI / catalog boundary | refactor focal length collection filter |
| [`69dcadf46e`](https://github.com/darktable-org/darktable/commit/69dcadf46ed418f2f11e6d6e48de2d815e783d8e) | non-merge | Upstream UI / catalog boundary | refactor aspect ratio collection filter |
| [`93b9c50ba1`](https://github.com/darktable-org/darktable/commit/93b9c50ba12f78fd9b3cd3b60fc0d45b07fc9a1b) | non-merge | Upstream UI / catalog boundary | refactor duplicate collection filter |
| [`0450e72e75`](https://github.com/darktable-org/darktable/commit/0450e72e7526b64ce3e840c1924e9f750b0fcf04) | non-merge | Upstream UI / catalog boundary | refactor filename collection filter |
| [`39b22680e7`](https://github.com/darktable-org/darktable/commit/39b22680e75207df9cf6f31b4907da81e8a4ef35) | non-merge | Upstream UI / catalog boundary | refactor history collection filter |
| [`6530855b8b`](https://github.com/darktable-org/darktable/commit/6530855b8ba4bb4bb23431d14499a5916c45f75e) | non-merge | Upstream UI / catalog boundary | add struct for int keys |
| [`1b914a5fa6`](https://github.com/darktable-org/darktable/commit/1b914a5fa651e7857c9f75e0f9136ff59a747050) | non-merge | Upstream UI / catalog boundary | refactor local copy collection filter |
| [`08a5e1d244`](https://github.com/darktable-org/darktable/commit/08a5e1d244f096b2ed4778688e386e9f091894ff) | non-merge | Upstream UI / catalog boundary | refactor module order collection filter |
| [`6cba09f48c`](https://github.com/darktable-org/darktable/commit/6cba09f48cd33dbab845e24956b1a522499bf95d) | non-merge | Upstream UI / catalog boundary | refactor rating range collection filter |
| [`62ed04d929`](https://github.com/darktable-org/darktable/commit/62ed04d9294b7af9a0b93407f3050e31d4cfec74) | non-merge | Upstream UI / catalog boundary | refactor 'misc' collection filters |
| [`073aac5069`](https://github.com/darktable-org/darktable/commit/073aac506991d874acc058b4ad7f407893896900) | non-merge | Upstream UI / catalog boundary | fix SQL error in date filter |
| [`77550ced56`](https://github.com/darktable-org/darktable/commit/77550ced569cf016ad641249fbab4dccb08af257) | non-merge | Build / packaging | windows installer: add option to enable/disable right click menu entries being added |
| [`c44ba726e8`](https://github.com/darktable-org/darktable/commit/c44ba726e89ded6822ee806556a93c9c5071d5ee) | non-merge | Tests / upstream CI | add unit tests for collection filters |
| [`8e5143e608`](https://github.com/darktable-org/darktable/commit/8e5143e608d9eb97146c208fcc8510ea4e9e18d0) | non-merge | Documentation / translation | release note for windows installer change |
| [`0316b203a4`](https://github.com/darktable-org/darktable/commit/0316b203a48ed6376aa50597cc4e18e1fabf0fb4) | non-merge | Engine / saved edits | lightroom: import crop and rotation into crop and ashift modules |
| [`fe11f7a68a`](https://github.com/darktable-org/darktable/commit/fe11f7a68a4bbdc0075481e2ae3b121e4969532d) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom import uses crop and rotate and perspective |
| [`9d1419fb29`](https://github.com/darktable-org/darktable/commit/9d1419fb294f2a5be259aa1e37abcdcdaaca91a7) | non-merge | Engine / saved edits | lightroom: set the working profile to linear ProPhoto RGB |
| [`8c0f5f3d16`](https://github.com/darktable-org/darktable/commit/8c0f5f3d1694feb48cfb11669c75e0b31fbbfcc5) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom import works in linear ProPhoto RGB |
| [`120c83f70a`](https://github.com/darktable-org/darktable/commit/120c83f70af01d019f5cf0c39f0a164250e6003b) | non-merge | Engine / saved edits | lightroom: add exposure adjustments to the module defaults |
| [`0fa0761b8e`](https://github.com/darktable-org/darktable/commit/0fa0761b8eca262dac1e65e5458e35713cc0dde2) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom exposure adds to darktable's default |
| [`690e944e96`](https://github.com/darktable-org/darktable/commit/690e944e96612013d3037f6c5a3b073321c6bd85) | non-merge | Engine / saved edits | lightroom: import tone curves at the current tonecurve version |
| [`92a6a7bcfa`](https://github.com/darktable-org/darktable/commit/92a6a7bcfa0a2c460448f4c16ad95397a06ac751) | non-merge | Engine / saved edits | lightroom: import clarity with the local laplacian filter |
| [`55f994b9e1`](https://github.com/darktable-org/darktable/commit/55f994b9e1daf6ee5f252a3c10bfd03489c6ee6d) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom tone curve and clarity import |
| [`c720a95745`](https://github.com/darktable-org/darktable/commit/c720a957455534f7fe95be2daf28bb01817e6466) | non-merge | Engine / saved edits | lightroom: import spot removals into the retouch module |
| [`5f7449c8af`](https://github.com/darktable-org/darktable/commit/5f7449c8af1428eaa7340ca12fd42ee7b33700ea) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom spot removals use the retouch module |
| [`a008235f41`](https://github.com/darktable-org/darktable/commit/a008235f41e36b828a3412e76fce799b58dcf613) | non-merge | Engine / saved edits | lightroom: model the parametric tone curve after Lightroom's |
| [`ae7d08025a`](https://github.com/darktable-org/darktable/commit/ae7d08025a8c093e0b69f9c9b9f2285ff2940968) | non-merge | Engine / saved edits | lightroom: fix split toning hue and balance |
| [`4a139f6313`](https://github.com/darktable-org/darktable/commit/4a139f6313238f5d13eeb5f44e87a5d3acfdba16) | non-merge | Engine / saved edits | lightroom: name the copied params structs after their version |
| [`6fc8f4a24d`](https://github.com/darktable-org/darktable/commit/6fc8f4a24db9744bd86e48942c79fe03d1c165e0) | non-merge | Engine / saved edits | lightroom: fit the post-crop vignette to Lightroom's |
| [`a2ab66efd1`](https://github.com/darktable-org/darktable/commit/a2ab66efd1e7ebbaafa64b5d102c01e60289884d) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom tone curve, split toning and vignette fixes |
| [`ad2d685742`](https://github.com/darktable-org/darktable/commit/ad2d685742be7c014e8029003619328c47e66376) | non-merge | Build / packaging | macosx: fix Homebrew paths left in the bundled GTK module caches |
| [`1051fe0939`](https://github.com/darktable-org/darktable/commit/1051fe09396655b573be5ea497913805ee3019e8) | non-merge | Documentation / translation | Update darktable.pot for translators. |
| [`8dce053102`](https://github.com/darktable-org/darktable/commit/8dce053102f425ce03b118d194700f4c7282d0ce) | non-merge | Pixels / module compatibility | spektrafilm: clamp negative film exposure before the pre-film blurs |
| [`a0627a29f2`](https://github.com/darktable-org/darktable/commit/a0627a29f28658b84624e2ba7cf9710c791531e6) | merge | Merge resolutions checked | Merge pull request #22804 from zisoft/refactor-filter-db-access |
| [`8fbd33238e`](https://github.com/darktable-org/darktable/commit/8fbd33238ee4d415ff33bb0936e1686ef5fafbce) | merge | Merge resolutions checked | Merge pull request #22806 from anoderay/windows-installer-rightclickmenu |
| [`1516618625`](https://github.com/darktable-org/darktable/commit/1516618625f528a741de234c2e211ded9056d035) | non-merge | Documentation / translation | RELEASE_NOTES.md: minor edit. |
| [`78905f8dbd`](https://github.com/darktable-org/darktable/commit/78905f8dbdfe118d45469ce45c07429895a98622) | non-merge | Engine / saved edits | lightroom: keep table lookups inside the table |
| [`9e43618052`](https://github.com/darktable-org/darktable/commit/9e436180529b741fba53081e6c662654cac265d6) | non-merge | Engine / saved edits | lightroom: free the values and document the import leaked |
| [`09cfb8a6e5`](https://github.com/darktable-org/darktable/commit/09cfb8a6e57fbd911b21336b5d5a1a4457d70b70) | non-merge | Upstream UI / catalog boundary | Remove unneeded gettext calls |
| [`8c2c63f221`](https://github.com/darktable-org/darktable/commit/8c2c63f221022817198f6079f53eb47332e1e5ab) | non-merge | Documentation / translation | RELEASE_NOTES.md: macOS app no longer loads GTK modules from Homebrew |
| [`d7eaf16cc0`](https://github.com/darktable-org/darktable/commit/d7eaf16cc08cd7077161dc9eba59427e691a52fd) | non-merge | Pixels / module compatibility | channelmixerrgb: square the ratios in the v1 saturation of the OpenCL path |
| [`8e2a9d65a8`](https://github.com/darktable-org/darktable/commit/8e2a9d65a87e811971125860b9678a8993576727) | non-merge | Documentation / translation | RELEASE_NOTES.md: color calibration v1 saturation on OpenCL |
| [`39853a90b0`](https://github.com/darktable-org/darktable/commit/39853a90b024d379eb61b4c50997d85211759a2f) | non-merge | Pixels / module compatibility | vignette: smooth the falloff on the CPU when dithering is off |
| [`4768e9bd44`](https://github.com/darktable-org/darktable/commit/4768e9bd449d9afc0f344ceece7b749ec3b44c6a) | non-merge | Documentation / translation | RELEASE_NOTES.md: vignetting smooth falloff on the CPU |
| [`2000a95ddb`](https://github.com/darktable-org/darktable/commit/2000a95ddb24c1f6d64088a8497b9aea9d8d3ecd) | non-merge | Documentation / translation | Update French translation. |
| [`9307ccbd2e`](https://github.com/darktable-org/darktable/commit/9307ccbd2e8ef2f165258f16594f21af04beb8c8) | non-merge | Documentation / translation | Minor edit. |
| [`3ac405f8c8`](https://github.com/darktable-org/darktable/commit/3ac405f8c87dc931e1bd1f8a33272d2c335310b3) | non-merge | Engine / saved edits | lightroom: shape the vignette after the cropped, upright frame |
| [`426368050a`](https://github.com/darktable-org/darktable/commit/426368050a943730252801290a28b169abaa930a) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom vignette shape |
| [`7c5da0fe20`](https://github.com/darktable-org/darktable/commit/7c5da0fe20f5c0df6e859b660c0af17fd345c13b) | non-merge | Engine / saved edits | lightroom: name the imported history items "lr import" |
| [`5fb0d017aa`](https://github.com/darktable-org/darktable/commit/5fb0d017aa75bae13e2b6ccc2c696ae356f37d28) | non-merge | Documentation / translation | RELEASE_NOTES.md: Lightroom import history label |
| [`978b7433c7`](https://github.com/darktable-org/darktable/commit/978b7433c7a83a6ff5c9f333a47e03cbbe8b8427) | non-merge | Pixels / module compatibility | colorreconstruction: sum every pixel of a run in the OpenCL splat |
| [`e210f17760`](https://github.com/darktable-org/darktable/commit/e210f17760845bb8341a31f647c90051b7cae639) | non-merge | Pixels / module compatibility | colorreconstruction: clamp the zoom scale in process_cl() as in process() |
| [`1ee072a9f0`](https://github.com/darktable-org/darktable/commit/1ee072a9f01fd47e1625e439797c226d5e2fe801) | non-merge | Documentation / translation | RELEASE_NOTES.md: color reconstruction OpenCL matches the CPU path |
| [`6c39669eef`](https://github.com/darktable-org/darktable/commit/6c39669eefaa798c2401ee7e5f789cf0ebf8bd0c) | non-merge | Pixels / module compatibility | censorize: pixelate up to the image border |
| [`6eb2e86350`](https://github.com/darktable-org/darktable/commit/6eb2e8635024f4b9a2ed634f6240e4992653e032) | non-merge | Documentation / translation | RELEASE_NOTES.md: censorize pixelates up to the image border |
| [`a9262000dc`](https://github.com/darktable-org/darktable/commit/a9262000dcdb32f7e4a5606f3a3bedcc134c1344) | merge | Merge resolutions checked | Merge pull request #22789 from Sciencentistguy/lrimport |
| [`a1b5074200`](https://github.com/darktable-org/darktable/commit/a1b5074200d23e1177ef1663fb35b5bf2ccaa044) | non-merge | Engine / saved edits | Fix Lr import not done on the darkroom. |
| [`dd4296b368`](https://github.com/darktable-org/darktable/commit/dd4296b3683e4868e7a9a6d085b3a2c1f1d22e43) | merge | Merge resolutions checked | Merge branch 'vignette-smooth-falloff-without-dither' of https://github.com/nicknezis/darktable |
| [`a5243e25d3`](https://github.com/darktable-org/darktable/commit/a5243e25d3162855a5eeae37e4124bf4138ea3e8) | merge | Merge resolutions checked | Merge branch 'opencl-colorcalibration-v1-saturation' of https://github.com/nicknezis/darktable |
| [`411909f672`](https://github.com/darktable-org/darktable/commit/411909f67285e6f1a916934e7cb7d320cc05cd14) | merge | Merge resolutions checked | Merge branch 'macos-bundle-gtk-cache-paths' of https://github.com/nicknezis/darktable |
| [`f9dbc77579`](https://github.com/darktable-org/darktable/commit/f9dbc77579fda6453a7e8c86870ebc0c2c447fcc) | non-merge | Engine / saved edits | tests: allow an ulp between the HDR Bayer and general CFA samplers |
| [`06a2ba46e7`](https://github.com/darktable-org/darktable/commit/06a2ba46e7fd3c580f5fd70dbf4fbfa8498cdc6b) | non-merge | Engine / saved edits | Use mixf() syntax |
| [`1f6066d2c1`](https://github.com/darktable-org/darktable/commit/1f6066d2c17c16bf9b78ba96e9daccc8274600d0) | non-merge | Documentation / translation | en@truecase update |
| [`af36325eb8`](https://github.com/darktable-org/darktable/commit/af36325eb8c929ac0bf012e992e42278447d781d) | non-merge | Documentation / translation | Update Finnish translation |
| [`bad59acb27`](https://github.com/darktable-org/darktable/commit/bad59acb2781286684e94d3dcca9f5c878cb534a) | non-merge | Pixels / module compatibility | diffuse: compute the diffusion weights with an accurate exp() on CPU |
| [`59c427dabe`](https://github.com/darktable-org/darktable/commit/59c427dabee1113ae05e989f32def0170198cee4) | non-merge | Documentation / translation | RELEASE_NOTES.md: diffuse CPU result now matches OpenCL |
| [`e07c0d21e6`](https://github.com/darktable-org/darktable/commit/e07c0d21e64a85cd5a4e3c03f08d6ed6373ca421) | non-merge | Documentation / translation | Ukrainian translation update |
| [`07da477ad7`](https://github.com/darktable-org/darktable/commit/07da477ad7f43ff130cf982137d41ac7ffcda770) | non-merge | Engine / saved edits | Fix usage of DT_DEBUG_VERBOSE |
| [`2c62e84927`](https://github.com/darktable-org/darktable/commit/2c62e849278655c45f4395f5413a8426e5d64fe9) | non-merge | Engine / saved edits | Log position of greatest diff for --opencl-diffstat |
| [`0eeff77515`](https://github.com/darktable-org/darktable/commit/0eeff775158d0bebe3644bacad5fd00f4caf5df9) | non-merge | Pixels / module compatibility | spektrafilm: correct tooltips that misdescribe the model |
| [`552442951f`](https://github.com/darktable-org/darktable/commit/552442951fe5d4552e10fe54d19d0a5e8032a875) | merge | Merge resolutions checked | Merge pull request #22831 from jenshannoschwalm/debug_verbosity |
| [`d87a6b9a8a`](https://github.com/darktable-org/darktable/commit/d87a6b9a8a4c70c2aa60af1bfe7e51b80d6b8653) | merge | Merge resolutions checked | Merge pull request #22826 from victoryforce/translations-261028 |
| [`25124eb2e9`](https://github.com/darktable-org/darktable/commit/25124eb2e932a3610155d26134a197289178969c) | non-merge | Pixels / module compatibility | spektrafilm: tile the Young-van Vliet row pass through local memory |
| [`2aaa4c19e5`](https://github.com/darktable-org/darktable/commit/2aaa4c19e5ada5c460458afec745ccbaa72e97dd) | non-merge | Documentation / translation | Update darktable.pot for translators. |
| [`093e10b207`](https://github.com/darktable-org/darktable/commit/093e10b207ccf201a85c0f2d951480c6df4dbd8d) | non-merge | Documentation / translation | Update French translation. |
| [`2998aad362`](https://github.com/darktable-org/darktable/commit/2998aad362e40a8e3d22dc75ff3248a7ae13f4e2) | non-merge | Documentation / translation | en@truecase update |
| [`b2f26c3127`](https://github.com/darktable-org/darktable/commit/b2f26c312793edce1820d01d029511d10c62f9ba) | non-merge | Engine / saved edits | develop: hash the committed params, not the module's copy, in piece hashes |
| [`cd4da202e7`](https://github.com/darktable-org/darktable/commit/cd4da202e7fad011205a04e85fdf257bda3bd22a) | non-merge | Documentation / translation | RELEASE_NOTES.md: note the fix for multiple external raster masks |
| [`3460d228b7`](https://github.com/darktable-org/darktable/commit/3460d228b73131f284b79bb04faa2647bb9665f8) | non-merge | Documentation / translation | Update ja.po |
| [`53eda6710a`](https://github.com/darktable-org/darktable/commit/53eda6710a0fdf8b5e333e4e4daef357d1fff7c8) | merge | Merge resolutions checked | Merge pull request #22837 from masterpiga/fix-22820 |
| [`152028f1f7`](https://github.com/darktable-org/darktable/commit/152028f1f7aefd5811bdbe1212ef99c45084eba1) | non-merge | Pixels / module compatibility | Finally markesteijn demosaicer has identical CPU/OpenCL results |
| [`6983e34ec4`](https://github.com/darktable-org/darktable/commit/6983e34ec4fbad7c4d2bef77c69473db2824e0b2) | non-merge | Pixels / module compatibility | Some subtle OpenCL demosaicer improvements |
| [`d13d53aee6`](https://github.com/darktable-org/darktable/commit/d13d53aee65fe9cbca5ebf3084ec4a1d626163ff) | non-merge | Upstream UI / catalog boundary | masks: avoid redundant mask list rebuilds during history reload |
| [`a584687c83`](https://github.com/darktable-org/darktable/commit/a584687c835ee404a32d33e952c2a1913d59a415) | non-merge | Upstream UI / catalog boundary | crawler: show the updated sidecar list from the main loop |
| [`4b17fef0e1`](https://github.com/darktable-org/darktable/commit/4b17fef0e190ee2abd5dbd6aa70b068afe9da31d) | non-merge | Upstream UI / catalog boundary | masks: use combos in preferences and rearrange options |
| [`da830b8734`](https://github.com/darktable-org/darktable/commit/da830b8734a3cfeec26c0b8cae5e9039a938642d) | merge | Merge resolutions checked | Merge pull request #22823 from nicknezis/censorize-pixelate-edges |
| [`08f84ad840`](https://github.com/darktable-org/darktable/commit/08f84ad840be45b732ff49d5f0a1ff08a1b8861e) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`93569b5c71`](https://github.com/darktable-org/darktable/commit/93569b5c7102e37dde51ab4b86e1ab43f41cadf5) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`0a8f0871f6`](https://github.com/darktable-org/darktable/commit/0a8f0871f64cbd35f2e4481ee43a9a0c34250625) | non-merge | Documentation / translation | Ukrainian translation update |
| [`36abf2dd8b`](https://github.com/darktable-org/darktable/commit/36abf2dd8b35c990aebb17264f5e3ce07ca05958) | non-merge | Pixels / module compatibility | Fix chroma late_correction if temperature is disabled |
| [`7f10ca3bfa`](https://github.com/darktable-org/darktable/commit/7f10ca3bfacac4ee660a1ce58a4117cb8ce4fac3) | merge | Merge resolutions checked | Merge branch 'colorreconstruction-opencl-match-cpu' of https://github.com/nicknezis/darktable |
| [`29e8e45741`](https://github.com/darktable-org/darktable/commit/29e8e457410d5d789bf43feeb9978d5903edd06e) | merge | Merge resolutions checked | Merge pull request #22841 from victoryforce/translations-261029 |
| [`cebc7abd4c`](https://github.com/darktable-org/darktable/commit/cebc7abd4c759eb64ffeb1396a9046173bd90095) | non-merge | Engine / saved edits | Always use precise maths in colorspace code |
| [`8dc85d38b1`](https://github.com/darktable-org/darktable/commit/8dc85d38b1fc0597aa76af3328bd44b4fadae978) | non-merge | Engine / saved edits | Various fixes for highlights opposed and segmentation |
| [`fe008dd013`](https://github.com/darktable-org/darktable/commit/fe008dd013f60132500e36cf19cbad080baadf99) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`e37863aa74`](https://github.com/darktable-org/darktable/commit/e37863aa74745eb4bef867fdd3974723c13d8290) | merge | Merge resolutions checked | Merge branch 'opencl-diffuse-fast-exp' of https://github.com/nicknezis/darktable |
| [`308a09d9a0`](https://github.com/darktable-org/darktable/commit/308a09d9a09b15faab9e11c9ea825489c0ae7e65) | non-merge | Documentation / translation | RELEASE_NOTES.md: Minor edit. |
| [`5f7cdf1511`](https://github.com/darktable-org/darktable/commit/5f7cdf1511fa915dcdedb615a6b08fd1279b178e) | non-merge | Pixels / module compatibility | lens: compute lensfun coordinates on a coarse grid |
| [`2f1601bf2a`](https://github.com/darktable-org/darktable/commit/2f1601bf2ae56e210b60de2301d6b6ce75ddd04b) | non-merge | Documentation / translation | RELEASE_NOTES.md: lensfun corrections on a coarse grid |
| [`fde1aae04f`](https://github.com/darktable-org/darktable/commit/fde1aae04faa3bb2487b7d7a744842a2c0e287ba) | non-merge | Pixels / module compatibility | lens: stop refining the lensfun grid when its error is noise |
| [`cd855475ad`](https://github.com/darktable-org/darktable/commit/cd855475ad78308d5fb1af5552ce2770edc128a2) | non-merge | Engine / saved edits | workspace: add in-app switcher in the top toolbar |
| [`6e486bd00a`](https://github.com/darktable-org/darktable/commit/6e486bd00a0d9031c6cf7ab0222e5c154a4c6b31) | non-merge | Documentation / translation | RELEASE_NOTES.md: in-app workspace switch from top toolbar |
| [`446c281399`](https://github.com/darktable-org/darktable/commit/446c28139991528d0805c91d877ada0c8c50fff0) | non-merge | Pixels / module compatibility | lens: use mixf() for the lensfun grid and shorten its comment |
| [`048077fbd8`](https://github.com/darktable-org/darktable/commit/048077fbd81301a1f7f8ab20b3d90c3ac5373c98) | non-merge | Documentation / translation | Updates to pt_BR |
| [`e8bb4b6d00`](https://github.com/darktable-org/darktable/commit/e8bb4b6d005531039d618b06b0ce554762852b22) | non-merge | Tests / upstream CI | Minor update to PR template |
| [`4d287b6ce2`](https://github.com/darktable-org/darktable/commit/4d287b6ce2c69eccca774ac93d2da4370115607c) | non-merge | Pixels / module compatibility | lens: keep the lensfun grid when its error is lensfun's own noise |
| [`51030a63c2`](https://github.com/darktable-org/darktable/commit/51030a63c27a8c39318add0e9ed6a6fed184b9c0) | non-merge | Documentation / translation | RELEASE_NOTES.md: lensfun grid precision in reverse mode |
| [`d7a6378d29`](https://github.com/darktable-org/darktable/commit/d7a6378d295b2833071ccc83debd01352cb36a27) | non-merge | Pixels / module compatibility | denoiseprofile, nlmeans: don't count the middle search row twice in OpenCL |
| [`b5023b770f`](https://github.com/darktable-org/darktable/commit/b5023b770f673de72b5f47cbb3946f8dbdb744a8) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL non-local means search window |
| [`329654f360`](https://github.com/darktable-org/darktable/commit/329654f360b4cc78393fe6e9f4efdf1528240268) | non-merge | Engine / saved edits | denoiseprofile, nlmeans: mirror the image borders on CPU and OpenCL |
| [`6dc30b0e06`](https://github.com/darktable-org/darktable/commit/6dc30b0e06ee8def44a22c470cb514d4083697a7) | non-merge | Documentation / translation | RELEASE_NOTES.md: non-local means mirrors the image edges |
| [`83fa9c86cb`](https://github.com/darktable-org/darktable/commit/83fa9c86cb32167605f788fe266a9ec09e15a388) | non-merge | Engine / saved edits | masks: show the controls of the selected member in one place |
| [`6fa12decb1`](https://github.com/darktable-org/darktable/commit/6fa12decb10da84f999e3599beb8d643f976810a) | non-merge | Engine / saved edits | masks: improve the styling of selection and hover in the list |
| [`e3ad8e6698`](https://github.com/darktable-org/darktable/commit/e3ad8e6698fde2ec1beddef1f3f30c89ad76518f) | non-merge | Engine / saved edits | masks: add an always-on option for the canvas panel |
| [`8dd09f2346`](https://github.com/darktable-org/darktable/commit/8dd09f2346399ac3d5720131debc689c14c6ba76) | non-merge | Upstream UI / catalog boundary | masks: drop the precise-entry popup's hide handler with its popover |
| [`0b47316b1c`](https://github.com/darktable-org/darktable/commit/0b47316b1ce76f394097a9d8e5b4c0e925e52153) | non-merge | Upstream UI / catalog boundary | bauhaus: hide the popup when its widget is destroyed |
| [`fa35d6b8cf`](https://github.com/darktable-org/darktable/commit/fa35d6b8cf8b9d5c0ba6ae09f194105668855824) | non-merge | Tests / upstream CI | spektrafilm tests: point test_spektra_pack at a real data pack |
| [`01877d7734`](https://github.com/darktable-org/darktable/commit/01877d7734f297c983ae36b9a94eb27545b5ff03) | non-merge | Tests / upstream CI | spektrafilm tests: make the rejected format 3 entry reachable |
| [`51a505fe72`](https://github.com/darktable-org/darktable/commit/51a505fe72aba63a120d43552b63dc8d5b1a3f40) | non-merge | Tests / upstream CI | spektrafilm tests: pin the ACES output compressor to its closed form |
| [`1bdbc99ab7`](https://github.com/darktable-org/darktable/commit/1bdbc99ab7dc83ddb94a653a9bf5118973bd7248) | non-merge | Tests / upstream CI | spektrafilm tests: cover the per-layer factors of the chemistry morph |
| [`51c2d11f5c`](https://github.com/darktable-org/darktable/commit/51c2d11f5c566f40290ac8913f2ee93f4db977a0) | non-merge | Tests / upstream CI | spektrafilm tests: cover the rest of the DIR coupler path |
| [`36a8c740a9`](https://github.com/darktable-org/darktable/commit/36a8c740a9895fcfd168e3eede78492c347893fc) | non-merge | Tests / upstream CI | spektrafilm tests: cover skewed and exhausted density curves |
| [`b65aabe967`](https://github.com/darktable-org/darktable/commit/b65aabe967efe104894de61e0f0c62882a21a2c3) | non-merge | Tests / upstream CI | spektrafilm tests: check the float knee against the double one |
| [`b4a4762254`](https://github.com/darktable-org/darktable/commit/b4a47622541f88a6a4f779417088c4db2a7bc33b) | non-merge | Engine / saved edits | spektrafilm tests: tidy the pack suite and the comparison helper |
| [`239fa0ccf6`](https://github.com/darktable-org/darktable/commit/239fa0ccf6ff79362c48173b85114b1301e872a8) | non-merge | Pixels / module compatibility | demosaic: leave the image border out of the OpenCL PPG median |
| [`1357f89de9`](https://github.com/darktable-org/darktable/commit/1357f89de9568f39861efb2ded41578aac6d488f) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL PPG median matches the CPU at the edges |
| [`55c8f037b3`](https://github.com/darktable-org/darktable/commit/55c8f037b3d5228a72b7d67008f5ba98853b6a8d) | non-merge | Pixels / module compatibility | opencl: initialize the alpha of PPG border_interpolate |
| [`4e3cf04a19`](https://github.com/darktable-org/darktable/commit/4e3cf04a19461c78f1447bdeb40ff613710f8a19) | non-merge | Pixels / module compatibility | filmicrgb: count clipped pixels atomically in the OpenCL mask |
| [`05129c4258`](https://github.com/darktable-org/darktable/commit/05129c4258bc3fce3feb756af1a5f861c8259039) | merge | Merge resolutions checked | Merge pull request #22850 from nicknezis/opencl-nlmeans-search-window |
| [`39732740df`](https://github.com/darktable-org/darktable/commit/39732740df31abbc33f5b03a585f9f7de65eb3da) | non-merge | Pixels / module compatibility | Fix graduatednd accumulating CPU errors |
| [`e08873c6b0`](https://github.com/darktable-org/darktable/commit/e08873c6b05ee98bcc0bcc9850d80c67b7873d04) | merge | Merge resolutions checked | Merge pull request #22833 from masterpiga/flexi-prefs |
| [`5b2cdee3b9`](https://github.com/darktable-org/darktable/commit/5b2cdee3b96eb25d57885d3d809f05ac22c1a614) | merge | Merge resolutions checked | Merge pull request #22858 from piratenpanda/spektrafilm_cmocka |
| [`eaeb5bc92c`](https://github.com/darktable-org/darktable/commit/eaeb5bc92cdf91d7e66a853850598712a6bf1015) | non-merge | Documentation / translation | Updates to pt_BR |
| [`ce00157fcd`](https://github.com/darktable-org/darktable/commit/ce00157fcd8598d249e597596dbe89ca5a1bd3e9) | non-merge | Upstream UI / catalog boundary | Add gettext context to the only place where "print" is used as a verb |
| [`4906434cc1`](https://github.com/darktable-org/darktable/commit/4906434cc1e2d9ad8093c0e3b1a3b947ba78001f) | non-merge | Pixels / module compatibility | diffuse: compute HF in the vertical B-spline pass on the GPU |
| [`ef295f3e94`](https://github.com/darktable-org/darktable/commit/ef295f3e94eeea5441a6773b315d5fd06305c1ab) | merge | Merge resolutions checked | Merge pull request #22844 from nicknezis/lens-lensfun-coord-grid |
| [`8b21381e08`](https://github.com/darktable-org/darktable/commit/8b21381e08fb22f05da5cdbee73fe536c0880b37) | merge | Merge resolutions checked | Merge pull request #22856 from nicknezis/opencl-nlmeans-mirror-borders |
| [`0a5af2e462`](https://github.com/darktable-org/darktable/commit/0a5af2e462e3f0825bf3825686b23278a7668db4) | merge | Merge resolutions checked | Merge branch 'opencl-ppg-median-border' of https://github.com/nicknezis/darktable |
| [`97c9abc0ae`](https://github.com/darktable-org/darktable/commit/97c9abc0aebac3741510d1ca00f6a3d5e8830a00) | merge | Merge resolutions checked | Merge pull request #22532 from rtmongold/feat/in-app-workspace-switch |
| [`c68ed1f87c`](https://github.com/darktable-org/darktable/commit/c68ed1f87c050dbee4925a098e7fd297ba79a6ab) | non-merge | Engine / saved edits | masks: keep the mask header of expanded modules that are not focused |
| [`03e00ab9c7`](https://github.com/darktable-org/darktable/commit/03e00ab9c74a96b7b6eeb3c4567e2d6acd2d22f2) | non-merge | Engine / saved edits | masks: slide the embedded panel open and closed |
| [`bc17589441`](https://github.com/darktable-org/darktable/commit/bc17589441bb597675f9b2e69dd9224766038c60) | non-merge | Documentation / translation | Ukrainian translation update |
| [`38ccb8648e`](https://github.com/darktable-org/darktable/commit/38ccb8648e4e2ed7a6fa9e70f7993710d8d48be9) | non-merge | Documentation / translation | Fr translation BM20261030 (#22864) |
| [`03eff7533c`](https://github.com/darktable-org/darktable/commit/03eff7533cec65d96d755ee6832cdf53013d4937) | non-merge | Documentation / translation | Update Russian translation |
| [`d595ce00fd`](https://github.com/darktable-org/darktable/commit/d595ce00fd323fd5c955dc7247b3f9af595c4d24) | merge | Merge resolutions checked | Merge pull request #22852 from masterpiga/flexi-fix-22843 |
| [`f38e304ce7`](https://github.com/darktable-org/darktable/commit/f38e304ce78e4332cc4528443e242dcd815c45a2) | non-merge | Documentation / translation | Update French translation. |
| [`ade33e7f09`](https://github.com/darktable-org/darktable/commit/ade33e7f0919c467dee69463291d873d471c1c18) | non-merge | Engine / saved edits | colorspaces: keep the RGB to HSL/HSV hue below 1 |
| [`96168323d1`](https://github.com/darktable-org/darktable/commit/96168323d11154d31935fa5271f30786fa33d03e) | non-merge | Documentation / translation | RELEASE_NOTES.md: magenta pixels in the CPU HSL and HSV blend modes |
| [`37b37e8ec5`](https://github.com/darktable-org/darktable/commit/37b37e8ec578b3434456cd19094e99c33969524b) | non-merge | Engine configuration | Ensure that strings used in UI are tagged as such. |
| [`5f2d71626b`](https://github.com/darktable-org/darktable/commit/5f2d71626bcf7cb70e6de7035254ea2ce0efeceb) | non-merge | Documentation / translation | Update darktable.pot for translators. |
| [`3959640e88`](https://github.com/darktable-org/darktable/commit/3959640e8870c1d504d45faeada35e161d078562) | non-merge | Documentation / translation | Update French translation. |
| [`548984d258`](https://github.com/darktable-org/darktable/commit/548984d258b7d66b6309bc8f7cd99c00c50bc394) | non-merge | Documentation / translation | Updates to pt_BR |
| [`eb367e5efa`](https://github.com/darktable-org/darktable/commit/eb367e5efaa98d25a183a520ffdcbda10bdf4b97) | non-merge | Pixels / module compatibility | lens: use lanczos taps for lanczos3 in the OpenCL metadata correction |
| [`6506497482`](https://github.com/darktable-org/darktable/commit/6506497482e1aaa523ce6e6ee6f394d4126a0e13) | merge | Merge resolutions checked | Merge pull request #22871 from nicknezis/hsl-hue-round-to-one |
| [`bdffceb1b7`](https://github.com/darktable-org/darktable/commit/bdffceb1b75b88fa285bd31fc2fc8f6ddb4dedf3) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`9e9c003b4e`](https://github.com/darktable-org/darktable/commit/9e9c003b4e817a883130af140855d3b1bfa7c367) | merge | Merge resolutions checked | Merge pull request #22672 from rtmongold/fix/22268-darkroom-filmstrip-triangle |
| [`c11b5face3`](https://github.com/darktable-org/darktable/commit/c11b5face393c828aa51c1dfac0c1336a61423b7) | non-merge | Documentation / translation | Updates to pt_BR |
| [`f090d6f8ab`](https://github.com/darktable-org/darktable/commit/f090d6f8ab8e4811ce8493aa133eee5edd3e927b) | non-merge | Pixels / module compatibility | opencl: extrapolate rgbcurve and tonecurve from their last node |
| [`41bf90cb1d`](https://github.com/darktable-org/darktable/commit/41bf90cb1d5415bad2e4a87a41facefb804f603d) | non-merge | Documentation / translation | RELEASE_NOTES.md: RGB and tone curve OpenCL extrapolation fix |
| [`a2f7aeca06`](https://github.com/darktable-org/darktable/commit/a2f7aeca06dc44f7f8fa79b4991874f71bdf294c) | merge | Merge resolutions checked | Merge pull request #22873 from nicknezis/opencl-rgbcurve-extrapolate-from-last-node |
| [`58c75cfe8b`](https://github.com/darktable-org/darktable/commit/58c75cfe8b51b8c11b3e1cc62f3f89afd5a74881) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`985bc95cc3`](https://github.com/darktable-org/darktable/commit/985bc95cc383fca9a3287eafc811fd5b19d86cda) | non-merge | Documentation / translation | update de.po |
| [`f28c5fe49b`](https://github.com/darktable-org/darktable/commit/f28c5fe49b9f4a293ec240156b1dc68adf261983) | non-merge | Engine / saved edits | Fix CPU vs OpenCL diffs for debinfo builds |
| [`039f096c3f`](https://github.com/darktable-org/darktable/commit/039f096c3f8db4ace42d522d44777f17d0bdcb57) | non-merge | Documentation / translation | en@truecase update |
| [`5b4073dfd1`](https://github.com/darktable-org/darktable/commit/5b4073dfd13a37327f17fc463d017561e31716b1) | non-merge | Pixels / module compatibility | opencl: read the float raw of rawprepare's unnormalized gain map kernel as float |
| [`98181f8cac`](https://github.com/darktable-org/darktable/commit/98181f8cac74864b5b1ef84185e7c33248810648) | non-merge | Pixels / module compatibility | opencl: interpolate rawprepare's gain maps as the CPU does |
| [`327d8ca6d3`](https://github.com/darktable-org/darktable/commit/327d8ca6d38e10c8e80e30e12d0fde432dd42f17) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL gain maps of floating-point raws |
| [`7d7dac363d`](https://github.com/darktable-org/darktable/commit/7d7dac363d7492db76aa8fa1cbba5712d9ead3a8) | non-merge | Pixels / module compatibility | contrastntexture: add OpenCL support |
| [`40cd7ea713`](https://github.com/darktable-org/darktable/commit/40cd7ea713e6e1521907c94067b9e6401509b574) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL code path for contrast & texture |
| [`707be06a70`](https://github.com/darktable-org/darktable/commit/707be06a70a54d27d150f07a257bf30c6af0b9a3) | non-merge | Pixels / module compatibility | enlargecanvas: add OpenCL support |
| [`9dec7bd0d2`](https://github.com/darktable-org/darktable/commit/9dec7bd0d22dd396335bb697e37355ee23845486) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL code path for enlarge canvas |
| [`2732e39c5f`](https://github.com/darktable-org/darktable/commit/2732e39c5fc62e0a5df0c12c6869d4e9feda7ecc) | non-merge | Pixels / module compatibility | highlights: OpenCL for inpaint opposed on linear raws |
| [`3712a0293b`](https://github.com/darktable-org/darktable/commit/3712a0293b5180bf2e6b823e1081c9fe59ceabbd) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL for inpaint opposed on linear raws |
| [`74538a6c33`](https://github.com/darktable-org/darktable/commit/74538a6c33c9c4fb87556fd632a5bad8f536c86a) | non-merge | Pixels / module compatibility | highlights: test each channel against its clip in the linear opposed mask |
| [`a96516d7fa`](https://github.com/darktable-org/darktable/commit/a96516d7fac299cf38956cbee413c6a9606f56de) | non-merge | Documentation / translation | RELEASE_NOTES.md: linear opposed highlight mask fix |
| [`8075f03504`](https://github.com/darktable-org/darktable/commit/8075f03504f43fc2e99fb310c4f549c503920382) | non-merge | Pixels / module compatibility | contrastntexture: use the common.h helpers in the OpenCL kernels |
| [`fabbcabf17`](https://github.com/darktable-org/darktable/commit/fabbcabf176d91aaede74aa89c0b9a769ec42b94) | non-merge | Documentation / translation | Ukrainian translation update |
| [`59958f8ca6`](https://github.com/darktable-org/darktable/commit/59958f8ca6e4c69507700857355bf77b8e8fa69d) | non-merge | Documentation / translation | Update de.po |
| [`1041e4dd38`](https://github.com/darktable-org/darktable/commit/1041e4dd38f5343fa376dcc39f469ae6ef252c2b) | merge | Merge resolutions checked | Merge pull request #22913 from victoryforce/translations-261101 |
| [`e68f243f2f`](https://github.com/darktable-org/darktable/commit/e68f243f2ff5dad7066dffcaa3ebfd26b1f42077) | merge | Merge resolutions checked | Merge pull request #22895 from nicknezis/highlights-opposed-linear-mask |
| [`e0c05e266b`](https://github.com/darktable-org/darktable/commit/e0c05e266b74b3c1482063171c9f8f100fc2d827) | merge | Merge resolutions checked | Merge branch 'opencl-rawprepare-gainmap-float' of https://github.com/nicknezis/darktable |
| [`d2d5474a2d`](https://github.com/darktable-org/darktable/commit/d2d5474a2d5349e7eca3230bd5fbdfddb8b0e68c) | non-merge | Tests / upstream CI | Change the virtual package name that is no longer provided for Clang environment |
| [`2544eebc47`](https://github.com/darktable-org/darktable/commit/2544eebc471ee6b831d8c6310ae2323d50b31b30) | non-merge | Documentation / translation | Correction de glare viewing par reflets visibles dans Spektrafilm |
| [`ba16e2b067`](https://github.com/darktable-org/darktable/commit/ba16e2b067f78f5231569188d5b509f0e0a136d3) | merge | Merge resolutions checked | Merge pull request #22892 from nicknezis/opencl-contrastntexture |
| [`69ebb7b4f3`](https://github.com/darktable-org/darktable/commit/69ebb7b4f332ab018c748e28c5cbf4f3ed6e30ef) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`dd3210ecf9`](https://github.com/darktable-org/darktable/commit/dd3210ecf9615e0aacd7676195da0b33242087dc) | non-merge | Engine / saved edits | presets: tell when a module's mask forms differ from its preset's |
| [`8e2295a6c2`](https://github.com/darktable-org/darktable/commit/8e2295a6c2a753545c98dd31e6f501c7989b4a3f) | merge | Merge resolutions checked | Merge branch 'opencl-highlights-opposed-linear' of https://github.com/nicknezis/darktable |
| [`1ee71c142e`](https://github.com/darktable-org/darktable/commit/1ee71c142e6036e1887018acff1d13ff664304ad) | merge | Merge resolutions checked | Merge branch 'opencl-enlargecanvas' of https://github.com/nicknezis/darktable |
| [`3c61dd2e68`](https://github.com/darktable-org/darktable/commit/3c61dd2e68df2d17b5fa23e312b9a67d88620113) | non-merge | Engine / saved edits | utility: accept a NULL list in dt_str_commasubstring() |
| [`8c67c82bb5`](https://github.com/darktable-org/darktable/commit/8c67c82bb568a27c786956f2affa1bda87dcdfb5) | non-merge | Engine / saved edits | finalscale: fix tiled scaled exports and upscale on OpenCL |
| [`f15ff678d1`](https://github.com/darktable-org/darktable/commit/f15ff678d1acc6e4e3114852bebe9a9b453d9333) | non-merge | Documentation / translation | RELEASE_NOTES.md: tiled upscaled exports fixed, upscale on OpenCL |
| [`18c3f67ea2`](https://github.com/darktable-org/darktable/commit/18c3f67ea240f78f866e7e87d3254aa1fb37c46b) | non-merge | Engine / saved edits | eaw, negadoctor: compute exp() accurately on the CPU |
| [`470216bcef`](https://github.com/darktable-org/darktable/commit/470216bcefa32f7b3e59891e2074237d9bbfcb8a) | non-merge | Documentation / translation | RELEASE_NOTES.md: contrast equalizer and negadoctor CPU exp() fix |
| [`76f33d941e`](https://github.com/darktable-org/darktable/commit/76f33d941e7fab6d647c80eb42182eed1001ad33) | non-merge | Pixels / module compatibility | highlights: test each channel in the linear opposed mask kernel |
| [`056e2fdb2f`](https://github.com/darktable-org/darktable/commit/056e2fdb2f49773253f074365a950c06fc978020) | merge | Merge resolutions checked | Merge pull request #22912 from nicknezis/finalscale-tile-alignment |
| [`0c67b46503`](https://github.com/darktable-org/darktable/commit/0c67b465033205c46735c5a194f2b23d55e68363) | non-merge | Upstream UI / catalog boundary | fix lib preset handling |
| [`ed927c8b72`](https://github.com/darktable-org/darktable/commit/ed927c8b721abafc236c842cb18eafeeea766f77) | non-merge | Engine / saved edits | eaw: compute the edge weights of all taps in one vectorized loop |
| [`74309abb69`](https://github.com/darktable-org/darktable/commit/74309abb690d6ec16c342c4c9682410da10fd61f) | non-merge | Engine / saved edits | eaw: accumulate right away when the edge sharpness is 0 |
| [`d9f726cb64`](https://github.com/darktable-org/darktable/commit/d9f726cb644c30c1e0f823a31b8778d7b262f847) | non-merge | Tests / upstream CI | Add action to validate noise profiles and WB presets JSON files |
| [`9bb0561e46`](https://github.com/darktable-org/darktable/commit/9bb0561e46eb72481fcef63c90bb3ebc3209153d) | non-merge | Build / packaging | Remove JSON schema validation from the build process |
| [`44dd8e5b53`](https://github.com/darktable-org/darktable/commit/44dd8e5b5309cdfe03a28016643576b0a1231bbe) | non-merge | Build / packaging | Remove mention of JSON schema validation package from Windows build instructions |
| [`dec65cabf5`](https://github.com/darktable-org/darktable/commit/dec65cabf5950e21942ca30c5ba42bcbb6773234) | non-merge | Tests / upstream CI | Add helper scripts for JSON validation |
| [`6b263e363f`](https://github.com/darktable-org/darktable/commit/6b263e363f63bb4c6680f60c7630ddbbb61baf32) | non-merge | Upstream UI / catalog boundary | add a context differentiator for print view |
| [`56b0ca0081`](https://github.com/darktable-org/darktable/commit/56b0ca0081587fe906860e579db21f732a28625f) | non-merge | Pixels / module compatibility | rawprepare: fall back to full range when white point is not above black (#22890) |
| [`c00ed37ed7`](https://github.com/darktable-org/darktable/commit/c00ed37ed7409cc912bc1d1b151c3087749db927) | merge | Merge resolutions checked | Merge pull request #22886 from nicknezis/cpu-accurate-exp-equalizer-negadoctor |
| [`499769e72f`](https://github.com/darktable-org/darktable/commit/499769e72fc1dae39bf706ec8486fb007cea4681) | non-merge | Engine / saved edits | ashift: match OpenCL and CPU source coordinate computation |
| [`e58544408d`](https://github.com/darktable-org/darktable/commit/e58544408dc9396dde06d564aadc64bcccf65327) | non-merge | Tests / upstream CI | src/tests/integration: Update sub-module. |
| [`1daef3db4b`](https://github.com/darktable-org/darktable/commit/1daef3db4b8adf08e3d0ada47232bfdcda215e6d) | non-merge | Pixels / module compatibility | cacorrectrgb: add OpenCL support |
| [`04781af969`](https://github.com/darktable-org/darktable/commit/04781af9697391a785cabc7f67c159cd54f68950) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL code path for chromatic aberrations (RGB) |
| [`44ded714e7`](https://github.com/darktable-org/darktable/commit/44ded714e788af7596804f651e7a89ca2261bdfb) | non-merge | Pixels / module compatibility | grain: add OpenCL support |
| [`c92b9ecd72`](https://github.com/darktable-org/darktable/commit/c92b9ecd725691b5777340a6a15023f6a6d62435) | non-merge | Documentation / translation | RELEASE_NOTES.md: OpenCL code path for grain |
| [`0ffeb366dc`](https://github.com/darktable-org/darktable/commit/0ffeb366dcd43e56393b4a19a5ed34f20000c3c3) | non-merge | Pixels / module compatibility | grain: give the OpenCL path a tiling callback |
| [`ad655e6c6e`](https://github.com/darktable-org/darktable/commit/ad655e6c6ec005aa16c82cd739dfc80ecea4f86f) | merge | Merge resolutions checked | Merge pull request #22885 from victoryforce/optimize-json-validation |
| [`4bca44e5f7`](https://github.com/darktable-org/darktable/commit/4bca44e5f7fb36a085271b25bd31546aa11f7143) | merge | Merge resolutions checked | Merge pull request #22898 from nicknezis/opencl-cacorrectrgb |
| [`4505e4d823`](https://github.com/darktable-org/darktable/commit/4505e4d823f94b11d21f8146ee3146955b877f85) | merge | Merge resolutions checked | Merge pull request #22900 from nicknezis/opencl-grain |
| [`30f69e6120`](https://github.com/darktable-org/darktable/commit/30f69e6120bea7412d2d1d374c6d40c9040b6194) | non-merge | Pixels / module compatibility | Use American spelling of characterize |
| [`d06f6805e2`](https://github.com/darktable-org/darktable/commit/d06f6805e233b4c0a644086ad2bef4873be25085) | non-merge | Upstream UI / catalog boundary | modulegroups: scroll to the first matching module when searching |
| [`b87acdf93c`](https://github.com/darktable-org/darktable/commit/b87acdf93ce4e2e76053b85088d4747e2055716b) | non-merge | Documentation / translation | Update darktable.pot for translators. |
| [`879067695e`](https://github.com/darktable-org/darktable/commit/879067695ea85f42d238a5c1603a021d14d71d3f) | non-merge | Documentation / translation | Update French translation. |

## Style compatibility repair and verification

The repair is prepared without moving the pin. `engine/CMakeLists.txt` detects
`dt_develop_blend_params_read` in the bundled header and defines
`IMMAGE_STYLE_BLEND_READER` for that engine build. Current-pin builds retain the
older blob conversion path; the candidate uses upstream's decoder, classic-mask
migration and fresh-ID import. Invalid candidate blend blobs return a look error
instead of silently substituting defaults. Locked destination look instances keep
their mask geometry while taking the style's blend mode and opacity.

Applied look items use `dt_dev_add_masks_history_item_ext` so their imported
forms enter history snapshots. Thumbnail rendering deep-copies the active form
list and restores the original on every success/failure return. Preview commits
use upstream's complete parameter/blend/bypass hashing, temporarily supplying the
preview params as `module->params` for older pins and request-local blend storage
as `module->blend_params` so commits preserve the applied settings.
Because `darktable.develop`
is not the engine's `_s.dev`, the engine also hashes its own referenced mask
trees explicitly. The fix does not redirect the process-wide develop pointer.
HDR merge explicitly includes `common/math.h`, which owns `M_PI_F`.

`verify/look-compat.c` includes the real engine implementation with its program
entry renamed and links the same supporting sources/libraries. It initializes
libdarktable with GUI disabled, creates and exports a masked exposure style,
imports the `.dtstyle` again, and opens a different disposable PNG. It exercises
ID collisions, repeated previews/application, locked masks, malformed tails,
a failure after a valid first style item already imported forms, subsequent
recovery, shape-sensitive cache identity, look removal, save/reopen, fresh-process
XMP import and version-14/current-version classic-mask migration. The Python runner creates all photos,
config, cache, data and sidecars in a temporary directory, uses two OpenMP threads,
and enforces a subprocess timeout. No models or original photos are needed.

Example, after configuring the isolated candidate with `IMMAGE_ROOT` pointing
to this repository:

```sh
cmake --build <candidate-build> --target darktable-engine immage-look-check \
  lib/darktable/plugins/all lib/darktable/plugins/imageio/all deploy --parallel 2
python3 -I verify/look-compat.py --build <candidate-build>
python3 -I verify/transient-engine.py --build <candidate-build>
```

The module aggregate target paths above are Ninja targets. `immage-look-check`
is excluded from ordinary builds and exists only when the new reader exists.
`transient-engine.py` retains its default `build/` target when `--build` is omitted.

Linux ARM64 Release results with AI/OpenCL **both disabled and both enabled**:
engine, IOP and imageio module builds passed after the explicit math include.
Look-mask checks and the full existing output-sink integration smoke passed in
both configurations, with CPU rendering forced. Tile/repeated/applied
pixels match exactly. After save/reopen, module parameter and mask-tree hashes
match exactly; three of 27,648 byte values differ by one code value when the
float pipeline is rebuilt. The test explicitly permits at most one code value
in at most 0.1% of bytes for that rebuild comparison only. This is a bounded
rounding comparison, not a claim of byte-exact same-process save/reopen output.
A second process with a fresh in-memory library imports only the saved XMP:
parameter and geometry hashes match exactly, and all 27,648 output bytes match
exactly in both configurations. Current-pin `main.c` and `hdrmerge.c` pass syntax
checks against the original build's flags.

Device OpenCL execution, native Windows/Mac, masks backed by AI pixels, broader
saved styles and multi-module looks, and broad old-edit reference/performance
comparisons remain adoption gates. An unrestricted `all`
build also encountered a local missing Perl `Pod::Parser` while translating man
pages; the engine and module targets above do not require that documentation
target. No system package was installed to bypass it.

## Executed manifest field access

`python3 -I verify/mapped-fields.py --build build/darktable-pin-review/cpu`
and the same command with `features` pass against the actual candidate engines.
`verify/mapped-fields.mjs` imports the production TypeScript manifest and unions
all global/local mapping fields by base operation: 444 unique fields across 28
modules. The engine reads each live/default scalar through generated introspection,
then writes each initial value separately and rereads the module's entire mapped
field set to check preservation of neighboring values. Temporary synthetic PNG,
configuration and cache are isolated; rendering is CPU configured and no GUI runs.

This is an access/schema check, not a control-response test: writing initial
values cannot establish changed-value behavior, enum meanings, old/new defaults,
RAW-specific processing or pixel equivalence. Those gates remain open. The runner
requires Node and the app's installed dependencies to load the actual manifest.

## Distinct masked-look switching and blend isolation

The extended look checker exports/imports two styles with different
circle positions, exposure values and blend opacities. B also includes color
balance with an independent rotated ellipse mask. With A applied, it previews
B, verifies all live blend bytes, referenced mask-tree hashes, form-list identity,
form count and history position are unchanged, and checks the current frame still
matches A. It applies B and requires exact tile/applied pixels, then repeats the
reverse preview/application and checks A's exact pixels and opacity return.
B's forms remain available to history after switching back. Existing removal,
save/reopen and fresh-process sidecar checks still run afterward.

Before the fix, this test failed because `dt_iop_commit_params` calls
`dt_iop_commit_blend_params`, which copies preview blending into the module's live
blend storage. Restoring only the form list left a live mask ID pointing at freed
temporary forms. `_preview_commit` now temporarily supplies request-local blend
storage as well as preview module params, then restores the original pointer.
The piece retains its own committed blend copy for rendering.

The extended look checks pass with AI/OpenCL both off and both on on Linux ARM64
(CPU rendering). Both applied B modules retain all blend bytes and referenced
mask hashes while A is previewed; applying A disables B's color-balance item.
Temporarily disabling color balance changes B's pixels and restoring it returns
the exact frame, proving the second module contributes to the rendered result.
Logs are in ignored `build/darktable-pin-review/{cpu,features}-multilook.log`.
The existing exposure-only save/reopen and fresh-process checks still pass.
The two-module look now also saves to a separate temporary photo and reopens in
the same process, then imports its XMP in a fresh process with an empty in-memory
library. Both enabled modules retain exact parameter bytes, all blend bytes and
referenced mask hashes; their mask groups remain distinct. Same-process rebuilds
change 6/27,648 bytes by one code value (within the existing 0.1% bound); fresh
processes reproduce the frame exactly. Three consecutive complete runs pass in
each candidate configuration. Logs are in ignored
`build/darktable-pin-review/{cpu,features}-multi-roundtrip-final{0,1,2}.log`.

An intermittent pixel failure during this extension came from the unused fourth
BGRX byte: upstream gamma `_copy_output` writes only the three color channels.
The fixture now copies the buffer and initializes padding to 255, matching the
engine’s opaque RGBA output contract; all exact and bounded comparisons use that
normalized copy. RGB values and tolerances are unchanged. Earlier raw-buffer
comparisons included uninitialized padding and should not be treated as evidence
about alpha. No production fix was needed. Additional shapes/combinations and
real saved styles remain pending, as do pixel/raster masks and native-device
validation.
The preceding output-sink smoke and current-pin engine syntax checks passed
with the blend-isolation repair; this extension changes only the fixture.


## Changed scalar storage, enum declarations and PNG defaults

`verify/mapped-fields.py` now changes each scalar to a distinct exactly
representable value, checks all mapped neighbors, restores the original and
checks the entire mapped module again. All 444 fields across 28 modules pass in
both candidate configurations and the existing original-pin `build/` engine.
The checker does not render arbitrary scalar values: 0/1 and binary fractions
are storage probes, not a claim that each probe is a meaningful processing setting.

`--snapshot PATH` records the initial module responses. Comparing snapshots from
`build/`, `build/darktable-pin-review/cpu` and `features` found identical mapped
live values, defaults, enabled and default-enabled flags for the synthetic PNG.
These are existing local original-pin executable results, not a fresh baseline
build or native-platform certification. Snapshots are ignored build artifacts:
`build/darktable-pin-review/{old,cpu,features}-defaults.json`.

`python3 -I verify/mapped-enums.py --build build/darktable-pin-review/cpu
--old 2747ed2a0d --new 879067695e` discovers mapped enum types from generated
introspection and compares their complete source declarations at both Git
revisions. All 14 types are unchanged, including enumerator ordering and explicit
numeric assignments: adaptation, illuminant, orientation, AgX primaries, ashift
mode, color-balance saturation formula, vignette dithering, exposure mode, lens
flags, tone-equalizer mask/filter, negative film stock and RGB/tone-curve autoscale.
This catches declaration changes; it does not prove unchanged implementation of
those choices. The source check requires both revisions in the local submodule.

Production `ModuleMap.write/read` control scenarios and all choice values remain
unverified by this scalar test. RAW/camera defaults, unmapped new AgX/sigmoid HDR
fields and legacy conversion, output-headroom behavior and old/new image references
remain open. No production defaults or pin changed; no GUI was launched.

## Production control writes and declared choices

The headless `mapped-fields.py --controls` extension imports the actual global
and local `ModuleMap.write` functions and control definitions. It seeds values
with production reads of the synthetic PNG defaults, then exercises each mapped
control individually at its minimum, neutral (or initial value) and maximum;
choices exercise every declared option, including grouped options. Parameters
emitted by each map, including fixed fields outside its read inventory, are
written through the actual engine and reread alongside neighboring mapped fields.
Float storage is compared with relative/absolute tolerance 2e-6; restoration is
exact. Nonfinite map outputs and missing control declarations fail the check.

All 1,280 scenarios (86 declared-choice scenarios) passed in each of the two
candidate builds and the existing original-pin build, together with the previous
444 changed-scalar checks:

```sh
python3 -I verify/mapped-fields.py --build build/darktable-pin-review/cpu --controls
python3 -I verify/mapped-fields.py --build build/darktable-pin-review/features --controls
python3 -I verify/mapped-fields.py --build build --controls
```

These checks verify storage of production write outputs, not useful rendering,
independent correctness of the mapping formulas, control read-back semantics,
module-choice activation/ordering, multi-control interactions, tagged/local
instance isolation or RAW-dependent values. Each map writes to its base module
in temporary state; no render or GUI is launched. The existing original-pin
binary remains an existing-build comparison, not a newly certified baseline.
Those limits keep the broader control/default/image gate unchecked.

### Production read-back and activation comparison

`mapped-fields.py --controls --read-report PATH` now sends the actual engine's
stored parameters back through each production `ModuleMap.read`. The report
records returned controls, recognized controls, `choiceOn`, explicit `enabled`
and `choiceShows`, using the same input values that produced each write.
All 1,280 scenarios passed on the existing original-pin build and both candidate
builds. Their 51,058 returned control values matched with relative/absolute
2e-6 tolerance; recognition lists and all predicates matched exactly. Existing
444-scalar changed-write/restore checks also passed in each run.

Reports are ignored local artifacts under `build/darktable-pin-review/`:
`old-reads.json`, `cpu-reads.json`, `features-reads.json`. Generate each with:

```sh
python3 -I verify/mapped-fields.py --build BUILD --controls --read-report REPORT
```

This establishes cross-pin equivalence for these production reads and predicates,
not an independent formula oracle or exact control-value roundtrip. Some maps
intentionally return no controls for foreign parameter combinations. Input seeds
still merge all base-module reads; this is not Session.open/chooseModules or
moduleEdit orchestration. Preference/history selection, neutral snapping,
negative overrides, conflicting active modules, combined tone-mapper choices,
tagged/local-instance isolation and RAW/image processing remain open. No pin,
default, GUI or rendering behavior changed.

### Headless session choice orchestration

`verify/session-choices.mjs SNAPSHOT` imports the production Session and manifest.
It supplies saved engine parameters through a command stub to actual
`Session.open`, while stubbing mask loading and render scheduling. It also calls
actual `chooseModules`, `snap` and `moduleEdit`; no GUI or engine is launched.
All 975 assertions pass for each of the original, candidate CPU and candidate
features snapshots from the mapped-fields checks:

```sh
node verify/session-choices.mjs build/darktable-pin-review/old-defaults.json
node verify/session-choices.mjs build/darktable-pin-review/cpu-defaults.json
node verify/session-choices.mjs build/darktable-pin-review/features-defaults.json
```

Coverage includes every declared global preference on fresh and unused edited
photos; 16 constructible nonneutral option cases where edited history wins,
fresh preferences override history, and foreign maps are excluded; negative
choice overrides and disabled modules; nonfinite/near-neutral snapping; module
bypasses; and all 24 combinations of tone mapper, Contrast, Blacks and Saturation
choices. The latter assert exactly one tone mapper enabled and finite emitted
parameters. Input parameters are synthesized with production writes, so this is
an orchestration check, not an independent mapping-formula oracle.

Conflicting simultaneous nonneutral alternatives, preference refresh, masked
choices, tagged-instance isolation, actual engine edits from this session,
RAW/HDR defaults and rendered pixels remain unverified by this harness. Existing
snapshots have identical mapped defaults; this does not extend default coverage
to RAW cameras or newly added unmapped HDR fields. The broad adoption checkbox
remains open. No production behavior or pin changed.


## RAW defaults and HDR migration checks

`verify/look-compat.c` now checks the actual loaded AgX v8 and sigmoid v4
modules after opening the synthetic PNG. New default output-follow flags are
true; converting AgX v7/sigmoid v3 sets them false. A distinct contrast edit
survives byte-exact preservation of the entire old parameter prefix. Direct
module conversion and the production `dt_iop_legacy_params` wrapper agree on
all converted bytes. AgX new and migrated HDR purity is 0.5. Both candidate
configurations pass, together with the existing look/sidecar regression checks.
Logs: ignored `build/darktable-pin-review/{cpu,features}-hdr{,-build}.log`.
The follow-up also checks sigmoid v1/v2: historical prefix lengths come from
loaded introspection offsets, distinct old edits survive byte-exactly, added
v3 fields are zero-filled, and the wrapper's conversion to v4 matches explicit
two-step conversion. Synthetic on-disk `.dtstyle` files carrying AgX v7 and
sigmoid v1/v2/v3 parameters plus valid current blend data pass the actual style
importer and Immage `_item_params`, yielding the expected complete current
parameter and blend bytes. These are constructed historical layouts, not a
user-created style corpus or older blend-format coverage. Full look/sidecar
regressions still pass both builds. Logs:
`{cpu,features}-legacy-style{,-build}.log` in the ignored review build folder.
Applied-style follow-up checks all four historical layouts through `_preview`
and `_look`: complete applied parameter/blend bytes match conversion, tile and
applied pixels match exactly, each style changes the synthetic PNG, and disabling
it restores baseline pixels exactly. Both full candidate runners pass; logs are
`{cpu,features}-legacy-applied{,-build}.log`. This establishes internal rendering
consistency, not agreement with the old pin.

Historical XMP follow-up serializes actual sidecars after replacing the selected
operation’s history parameter blob/version with the historical fixture. Each of
the four sidecars loads in its own fresh process and empty in-memory library:
complete converted parameters and current blend bytes match the applied-style
reference, and all 27,648 BGRX bytes match exactly. Both full candidate runners
pass, including the existing mask and sidecar regressions. Logs:
`{cpu,features}-legacy-xmp{,-build}.log`. This covers constructed historical
module layouts inside current structured XMP, not a historical XMP schema,
user-created sidecar corpus or legacy blend versions. HDR output pixels and
display-dependent headroom behavior remain unverified.

`verify/mapped-fields.py --photo PATH` copies only the photo into temporary
state, excluding adjacent sidecars. An existing ignored Nikon D3S NEF opens as
RAW (4288 by 2844); all 444 changed-scalar checks pass in the existing original
build and both candidates. Their mapped live/default values and enable flags
are identical (`{old,cpu,features}-raw-defaults.json` in the ignored review build
folder). Channel mixer, demosaic, exposure and sigmoid differ from the PNG
snapshot, confirming this exercises a distinct initialization path. This is
the mapped field inventory, not full camera/default coverage or render equivalence.
An Olympus ORF also opens as RAW (4640 by 3472) and passes all 444 scalar checks
in all three builds, with exactly identical mapped live/default/enable snapshots
(`{old,cpu,features}-orf-defaults.json`, corresponding `*-orf.log`). Both camera
inputs are existing ignored local fixtures. No originals, production defaults
or pin changed; no GUI ran.

```sh
python3 verify/mapped-fields.py --build build/darktable-pin-review/cpu \
  --photo /path/to/copied-camera.NEF --snapshot /tmp/raw-defaults.json
```

The initial fresh-image comparison against the existing `build/` was invalid:
its core library and gamma IOP had incompatible custom pipeline layouts. Debug
symbols show the old gamma plugin expected `mask_display` at offset 672 and a
2,816-byte `dt_dev_pixelpipe_t`, without output-sink fields. The core placed
`mask_display` at 688 and had a 2,832-byte struct; its offset 672 is `shutdown`.
Thus the plugin read the shutdown field as a display-mask selector, producing
grayscale output from the colored PNG. This was stale local build state, not a
candidate pixel regression. Original binaries and failed-probe evidence remain
untouched. Diagnostic logs: `old-mixed-abi.log` and `old-coherent-abi.log` in the
ignored review build folder. Rebuild all IOP/imageio modules whenever custom
shared headers change; successful loading/scalar access is insufficient proof
of binary compatibility.

A new isolated `old-source` clone is pinned to
`2747ed2a0d162515bd9c91d02201653de895dddb`, with the full existing engine patch
and copied unchanged external sources. The unrelated ONNX finder edit is excluded.
`old-cpu` uses the candidate CPU build's Release/options, AI/OpenCL disabled,
local OpenCV, current Immage engine sources and an explicit isolated LibRaw path.
Engine/core, all plugin targets and deploy data build successfully. Gamma and
core now agree on offset 688 and struct size 2,832; the grayscale artifact is gone.
Logs: `configure-old-cpu.log`, `build-old-cpu.log`, `build-old-modules.log`,
`deploy-old-cpu.log`. The coherent old build also passes the 444 scalar and
1,280 production-control-write scenarios (86 choices); its mapped PNG snapshot
still exactly matches the candidate (`old-coherent-controls.log`,
`old-coherent-defaults.json`).

`verify/pin-pixels.py` runs isolated CPU fresh-default comparisons using disposable
photo copies without adjacent sidecars, two OMP threads, and 96/512 pixel bounds.
The synthetic colored PNG, Nikon D3S NEF and Olympus ORF produce **byte-identical
RGBA output** in the coherent old build and both candidate configurations for
all six input/size combinations. JSON reports include hashes of inputs, engine,
core and plugins; frames and logs are retained in ignored
`build/darktable-pin-review/pixel-defaults/`, with summary `pixel-defaults.log`.
This validates fresh engine defaults on these inputs, not app Session edits,
saved-history pixel equivalence, a broader camera corpus, HDR or device output.

```sh
python3 verify/pin-pixels.py --old build/darktable-pin-review/old-cpu \
  --candidate build/darktable-pin-review/cpu \
  --candidate build/darktable-pin-review/features \
  --photo /path/to/copied-camera.NEF --photo /path/to/copied-camera.ORF \
  --output build/darktable-pin-review/pixel-defaults
```

### Old-created edited histories and measured pixel differences

`verify/pin-pixels.py --edited` adds independent exposure (+1.25 EV), sigmoid
(contrast 1.9), AgX (contrast 2.5), and vignette (brightness -0.7, scale 50,
falloff 40, dithering off) cases. Each case starts from a disposable fresh image;
tone-mapper cases explicitly disable the alternative mappers. The coherent old
build renders and saves each history, then fresh processes with isolated empty
state load that same sidecar in all three builds. The retained XMP contains real
old module versions, including sigmoid v3 and AgX v7 with current blend v15.
Every edit changes its old reference at both sizes. This is constructed unmasked
history coverage, not a real saved-style corpus or production Session orchestration.

PNG, Nikon NEF and Olympus ORF at 96/512 bounds give these observations in both
candidate configurations, all processing on CPU:

| Case | Old fresh-process reload | Candidate versus old applied reference |
| --- | --- | --- |
| Fresh defaults | Not a saved history | Exact RGBA on all inputs/sizes |
| Exposure | Exact RGBA | Exact RGBA on all inputs/sizes |
| Sigmoid v3 | Exact RGBA | Exact RGBA on all inputs/sizes |
| AgX v7 | Exact RGBA | Exact on PNG and 96-bound RAW; at 512 bounds, 4 NEF and 5 ORF RGB channels differ by 1 code |
| Vignette, dithering off | Exact RGBA | Nonzero on every input/size; maximum RGB difference 12–14 codes |

Vignette changed-channel counts at 96/512 bounds are PNG 9,375/16,677,
NEF 6,934/196,505 and ORF 7,629/207,227. Mean absolute RGB differences are
1.780093/1.787272, 0.887235/0.880381 and 0.878766/0.847070, respectively.
Both candidate configurations produce the same frame bytes. The upstream
`39853a90b0` change applies cosine smoothing to the CPU falloff even when
no dithering is requested; previously smoothing was conditional on dithering.
The measured change is consistent with this intentional processing correction,
but is **not accepted saved-edit appearance compatibility**. Parameter migration
alone cannot preserve that appearance. AgX also changes curve scale calculations
from float to double; its tiny RAW deltas have not been isolated to that change
or accepted under a project tolerance.

Artifacts: ignored `build/darktable-pin-review/pixel-edited/` and
`pixel-edited-repeat/`, each retaining frames, old sidecars, engine logs and a
JSON report; corresponding summary logs sit in the review build directory.
A second complete run reproduced all 84 comparison metrics and frame hashes;
old reloads were exact throughout and both candidate configurations agreed.
No production code, defaults or pin changed. The coherent old build and Claude's
worktree remain untouched; no GUI or device OpenCL ran.

```sh
python3 verify/pin-pixels.py --old build/darktable-pin-review/old-cpu \
  --candidate build/darktable-pin-review/cpu \
  --candidate build/darktable-pin-review/features --edited \
  --photo /path/to/copied-camera.NEF --photo /path/to/copied-camera.ORF \
  --output build/darktable-pin-review/pixel-edited
```

### Vignette compatibility design

Both pins serialize vignette parameters as version 4. The only upstream change
in `src/iop/vignette.c` is the CPU falloff branch; its parameter layout and
`legacy_params` are unchanged. Versions 1/2 migrate to version 4 with dithering
off, and version 3 preserves its dithering setting. Consequently the risk also
includes older imported histories after conversion, not just native version 4.

The old and candidate OpenCL `vignette` kernel in `data/kernels/extended.cl`
already applies cosine smoothing regardless of dithering. Old version-4 data
does not identify whether the reference was produced by CPU or OpenCL. A blanket
version-4-to-linear conversion would therefore preserve one backend's appearance
while changing the other's. XMP schema version, module version and the existing
history hashes do not resolve this provenance ambiguity.

Production `vignetteMap.write` in `app/src/manifest.ts` explicitly sets dithering
to 16-bit (`2`) to obtain smooth falloff on the old CPU path. The earlier
non-dithered fixture is therefore a compatibility probe for imported/preserved
module data, not representative of parameters emitted by the current Vignette
control. Do not change that setting as part of pin adoption: doing so would
introduce a second processing change. Loading external history and applying
styles still require coverage; this source trace does not prove Session leaves
every such incoming field untouched.

Recommended repair direction, if preserving old CPU-origin non-dithered edits is
required: introduce an explicitly serialized falloff mode and a new module
version, keep smooth falloff for newly created edits, and implement the selected
legacy semantics consistently in CPU and OpenCL. Migration must cover versions
1–4, styles, XMP, thumbnails, copied history and save/reload. Unknown-provenance
version-4 imports need an explicit policy; module version alone cannot select
the correct historical backend. An engine-only `dithering` rewrite or an
unversioned upstream revert cannot provide that contract. No such production
repair or migration policy has been adopted here.

Headless follow-up (`pin-pixels.py --vignette`, same old/candidate builds and
photos as above) tested six independent old-created saved histories at 96/512
bounds. All 36 old reload comparisons are exact. Both candidates agree byte for
byte on every frame. Dithering 8-bit and 16-bit are exact against the old
reference on all inputs/sizes. Non-dithered negative brightness, positive
brightness, saturation-only and off-center shape cases differ on every
input/size; maximum RGB differences across sizes are:

| Non-dithered case | PNG | Nikon NEF | Olympus ORF |
| --- | ---: | ---: | ---: |
| Negative brightness | 14 | 14 | 14 |
| Positive brightness | 27 | 32 | 41 |
| Saturation alone | 9 | 8 | 14 |
| Off-center shape | 16 | 13 | 13 |

Every edited old reference visibly differs from defaults. Artifacts and binary/
sidecar hashes are in ignored `build/darktable-pin-review/pixel-vignette/`, with
summary `pixel-vignette.log`. These are constructed module histories, not edits
generated by Session or proof of device parity. Python compile/help and diffcheck
passed. No baseline, candidate binary, pin or production behavior changed.

Next: resolve the remaining imported non-dithered vignette appearance policy,
then extend changed-module references (lens, highlights and
transforms). Do not silently bless the measured change or revert upstream
processing while the compatibility policy is unresolved.
Broader camera/native/device and adoption gates remain unchecked. No additional
historical CPU benchmark capture is needed.

### Diffuse and non-local-means saved histories

`verify/pin-pixels.py --detail` saves two independent old-pin diffuse histories:
five iterations, radius 64, regularization 1, active-order anisotropy 2. Smoothing
uses first/second speeds +0.5; sharpening uses second/fourth speeds -0.5.
Nonzero anisotropy exercises the diffusion-weight path changed from
`dt_vector_exp` to `dt_vector_exp2(x / ln(2))`. These are constructed engine
histories, not production-control edits or an independent numerical oracle.

Fresh old/candidate processes load the same old-saved XMP for PNG, Nikon NEF and
Olympus ORF at 96/512 bounds. All 12 edited old reloads are exact; every edit
visibly changes old defaults. Both candidate configurations have identical frame
hashes throughout, but differ from the old reference at every input/size:

| Diffuse case | PNG maximum RGB delta | NEF maximum RGB delta | ORF maximum RGB delta |
| --- | ---: | ---: | ---: |
| Smoothing | 1 | 4 | 9 |
| Sharpening | 2 | 38 | 51 |

Maximums span both sizes. Sharpening mean absolute RGB differences at 96/512
bounds are PNG 0.071470/0.046631, NEF 0.114087/0.214959 and ORF
0.257776/0.320964 codes. This is consistent with a changed diffusion-weight
implementation; the cause has not been isolated with a one-change build and no
appearance tolerance or migration policy is accepted.

`--nlmeans` separately saves patch size 2, strength 10000, full luma/chroma.
On the synthetic PNG, both old reloads are exact and visibly differ from defaults.
Candidates match each other; versus old they differ in 1,229/4,023 RGB channels
at 96/512 bounds, maximum 1/2 codes and mean 0.059269/0.120687. The source range
adds mirrored border padding to the common CPU denoise core. Spatial attribution,
profiled denoise, full-resolution tiling and device parity remain unverified.

Initial smaller-radius diffuse and RAW denoise attempts failed the visible-
contribution guard. Stronger diffuse fixtures pass; RAW denoise still showed no
visible contribution at a requested preview size and is excluded from completed
coverage. Partial runs remain in ignored `pixel-detail*` directories/logs.
Completed artifacts, XMP and binary hashes are in ignored `pixel-diffuse/` and
`pixel-nlmeans/`, with corresponding logs. A second full diffuse run in
`pixel-diffuse-repeat/` reproduces all 48 comparison metrics/frame hashes with
unchanged binary identities; serialized sidecar hashes differ between runs.
Python compile/help
and diffcheck pass. No binary, baseline, production pin
or defaults changed. Next: lens/highlights/transforms references and assessment
of the measured diffuse differences; broader camera/native/device gates stay open.


### Lens, highlights and transform saved histories

`pin-pixels.py --transforms --highlights` creates independent old-saved ashift
rotation (+7 degrees), perspective (-3 degrees, shifts vertical 0.2/horizontal
-0.15, shear 0.05), and RAW highlight clipping/opposed/segmentation histories
with threshold 0.1. PNG receives the two transforms; Nikon NEF and Olympus ORF
receive all five cases. At 96/512 bounds every edit contributes, all 24 edited
old reloads are exact, and both candidates agree in dimensions and bytes.
A full repeat reproduces all 84 comparison metrics/frame hashes and unchanged
build identities. Fresh defaults remain exact.

Highlight clipping is exact on both RAWs/sizes. Opposed and segmentation differ
by at most one RGB code: NEF 0/1 changed channels at 96/512 for each method;
ORF opposed 3/25, segmentation 4/32. These are two Bayer inputs with ordinary
white balance; disabled temperature/late chroma correction, invalid white,
X-Trans and linear RAW paths remain unverified. No reconstruction accuracy or
accepted appearance tolerance follows from agreement at these preview bounds.

Transform dimensions match across pins. Most nonzero deltas are one code, but
ORF rotation at 512 bounds has 55 changed RGB channels and maximum delta 118.
The three changes above one code are a single output pixel at zero-based
(481, 102) in a 512 × 408 frame: old RGB (1,1,1), candidate (87,119,52).
Its neighborhood lies on the rotated image/empty-area boundary. This reproduces
exactly; it is consistent with the changed ashift FMA coordinate accumulation,
and the isolated-change experiment below proves attribution for these fixtures.
This does not accept the boundary shift.
Other transform maximums are one code (or exact); automatic fitting, transformed
masks, tiling, non-square pixels and device parity remain open.

`--lens` separately saves Lensfun method 1 and metadata-selected method 0 on
both RAWs. All eight edited old reloads are exact; every edit contributes and
both candidates agree. A full repeat reproduces all 36 comparison metrics/frame
hashes with unchanged build identities. Nikon changes 160/3,181 RGB channels at 96/512 for either
selection, maximum one code. Olympus metadata selection is exact; explicit
Lensfun changes 328/1,994 channels, maximum 24/72 codes, mean absolute difference
0.031250/0.005679. Above-one deltas occupy 93/150 channels; their module-level cause is
isolated below; appearance acceptability remains open. The source range changes the Lensfun
coordinate grid, while the metadata Lanczos fix is device-specific. Metadata
selection can fall back to Lensfun, so the saved method value does not establish
executed-path coverage. No reverse-mode, interpolation matrix or full-resolution
lens acceptance is claimed.

Evidence is retained under ignored `pixel-geometry-highlights{,-repeat}/` and
`pixel-lens-methods{,-repeat}/`, with corresponding logs, saved XMP, frames and
binary hashes. System Lensfun is 0.3.4.0; `lensfun-environment.json` records XML
database hashes beside the first lens-method report. Earlier `pixel-lens/`
requested only method 0 and must not be treated as explicit Lensfun coverage.
These constructed CPU histories do not close broader native/device/corpus gates.
No binary, coherent baseline, production pin or defaults changed; diffuse and
non-dithered vignette appearance decisions remain unresolved.

### Isolating lens and transform differences

Independent diagnostic trees under ignored `build/darktable-pin-review/isolation/`
use the candidate CPU core, generated introspection and compiler/link flags.
Each replaces only one plugin with its old-pin source: `ashift/` replaces
`libashift.so`; `lens/` replaces `liblens.so`. No reference source, object or
binary is overwritten. `pixel-isolation/report.json` verifies that each diagnostic
tree differs from the candidate in exactly that plugin among all hashed engine
and module files. The build script, source copies, logs and source-hash manifest
are retained beside the diagnostic trees. These are attribution experiments,
not candidate builds proposed for adoption.

Using the same `--transforms --lens` histories, PNG/NEF/ORF and 96/512 bounds,
restoring ashift makes every transform byte exact against old-cpu, including
ORF pixel (481,102). Restoring lens makes both methods exact on both RAWs/sizes.
The untouched plugin retains the original differences in each diagnostic tree.
Defaults and fresh old-history reloads are exact; all edits visibly contribute.
This isolates the transform deltas to the sole ashift CPU FMA change, and lens
deltas to the changed lens module. It does not establish acceptable image error
or device parity. Upstream explicitly introduced FMA to match OpenCL accumulation;
reverting it in production would require assessing that parity tradeoff.

A second diagnostic changes only `_lens_grid_build` to start at step 1,
retaining the candidate vignetting-factor multiplication. Nikon becomes exact;
Olympus Lensfun still changes 215/325 channels at 96/512, maximum 24/72.
A third diagnostic also restores direct `ApplyColorModification` on the actual
image rows instead of multiplying factors evaluated on synthetic 0.5 pixels.
Both RAWs and both lens selections then become exact. Thus the larger Olympus
deltas survive removal of coarse interpolation and disappear when the vignetting
evaluation is restored. This isolates a vignetting-path contribution; it does not
yet identify the internal Lensfun arithmetic or establish a general correction.
Evidence: `pixel-lens-step1/`, `pixel-lens-direct-vig/` and their logs; source
variants/build scripts and hashes are in `isolation/`. All fresh old reloads and
defaults are exact, every lens edit contributes.

A fourth diagnostic retains adaptive coordinates but restores direct vignetting.
Nikon retains its original 160/3,181 changed channels, maximum one code; Olympus
Lensfun drops to 125/1,570 changed channels, maximum one code. Olympus metadata
remains exact. `pixel-lens-grid-direct-vig/` therefore separates coordinate-grid
rounding from the larger vignetting-path error for these fixtures. No claim of
full-resolution, reverse-mode, other lens profiles or device correctness follows.

The original old-cpu and candidate CPU engine/module hashes match the earlier
`pixel-lens-methods` report exactly. Diagnostic trees reference unchanged candidate
files except their independently linked plugin. To reproduce the comparison, use
the preceding `pin-pixels.py --old .../old-cpu --candidate .../cpu` command with
`--transforms --lens` and both RAWs, adding candidates `.../isolation/ashift` and
`.../isolation/lens`. For each factor experiment use `--lens` with the same RAWs
and candidate `.../isolation/lens-step1`, `.../isolation/lens-step1-direct-vig`
or `.../isolation/lens-direct-vig`, respectively. Retained scripts reconstruct
these diagnostic plugins using the original compile database and Ninja link rule.

### Lensfun negative-value evaluation

A standalone probe linked to installed Lensfun 0.3.4.0 loads the same system
database and selects Olympus Imaging Corp. E-M5MarkII and Panasonic Lumix G Vario
12-32mm, crop 2, focal 27, aperture 5.6, distance 1000. It compares direct float
RGBA modification against factors extracted from 0.5 and doubled, as in
`_lens_grid_eval`. At row widths 96, 512 and 4,640, height three quarters of width,
and both correction/simulation directions, all tested nonnegative values
(0, 0.01, 0.5, 1, 2, 10) agree exactly. For input -1, direct RGB becomes zero;
factor multiplication remains negative at every tested RGB component. This
demonstrates a nonlinear clipping difference, rather than merely multiplication
rounding. It is a library probe, not full-resolution image or reverse-pipeline
coverage. Source, executable, report and hashes remain under ignored
`build/darktable-pin-review/lensfun-eval/`.

Two independently linked diagnostic plugins change only the CPU factor
multiplication to `fmaxf(pixel * factor, 0.0f)` in both directions:

- `isolation/lens-clamp` retains adaptive coordinates and vignetting. Nikon keeps
  160/3,181 changed channels at 96/512, maximum one code. Olympus Lensfun drops
  from maximum 24/72 to one code, with 125/1,685 changed channels; metadata stays
  exact. This does not produce exactly the same residual as direct vignetting,
  because vignetting-grid interpolation remains active.
- `isolation/lens-step1-clamp` also starts grid construction at step 1. Both RAWs,
  both selectors and both sizes then match old-cpu exactly. Together with the
  earlier direct-vignetting experiments, this isolates the larger measured
  Olympus error to lost negative clipping. It does not establish that every
  remaining grid error is acceptable.

Both runs use the preceding `pin-pixels.py --lens` command, both RAWs and unchanged
old-cpu. Reports/logs are `pixel-lens-clamp` and `pixel-lens-step1-clamp`; every
old saved-history reload and fresh default is exact, and every lens edit visibly
contributes. Runtime engine/module hashes confirm only `liblens.so` differs from
the original candidate; old-cpu hashes still match `pixel-lens-methods`.
Build scripts and copied source remain in `isolation/`, with additional hashes in
`lensfun-eval/manifest.json`. No original plugin or baseline was overwritten.

There is an appearance policy choice before adopting a correction. The old
OpenCL `lens_vignette` kernel already multiplies extracted factors without a
zero clamp; the candidate kernel retains that behavior. The old CPU instead
delegates actual pixels to Lensfun, whose installed float path clips negatives.
Therefore a blanket CPU/OpenCL clamp would preserve the measured old CPU behavior
while changing old OpenCL behavior. Saved module version/backend provenance must
be considered before choosing a compatibility path; this is separate from the
remaining grid tolerance decision. No device execution or serialized compatibility
mode has been validated, and these diagnostic clamps are not production repairs.

The proposed import policy is to expose a serialized compatibility choice rather
than infer the historical backend from the module version. Preserving old CPU
appearance requires both its negative handling and its direct coordinate path;
preserving old OpenCL appearance needs its own reference, since its negative
handling already differed. Unknown-provenance imports cannot satisfy both
automatically. Keep this decision explicit and unresolved until a default import
policy is approved. Any compatibility mode would need consistent CPU/device
behavior, versioned migration, styles, XMP, preview and save/reload validation.
The diagnostic plugins do not implement such a mode.

### Full-size Lensfun comparison

`pixel-lens-fullsize` runs `pin-pixels.py --lens --size 4640` with the Olympus
fixture, original candidate and isolated adaptive-grid/clamp candidate. Actual
output is 4640×3472, matching the RAW dimensions, rather than an enlarged preview.
Defaults and metadata-selected correction are exact. The Lensfun history changes
5,714,599 of 48,330,240 RGB channels, maximum 14 codes, mean absolute difference
0.119891; candidate and clamp frames have identical hashes. Old saved-history
reloads remain exact and each edit visibly contributes.

`pixel-lens-fullsize-step1` repeats against the isolated step-1/clamp candidate:
every frame is exact, including the Lensfun history. Thus the measured full-size
difference survives a negative clamp and disappears when grid approximation is
removed. A clamp alone is insufficient. The smaller preview residuals must not
be generalized to full-size output or accepted as a one-code bound. These are
CPU RGBA renders, not tiled export or device execution. Reports, sidecars, engine
logs and hashed binary identities are retained under the ignored build directory;
the coherent old-cpu baseline was not rebuilt or modified.

`pixel-lens-fullsize-isolation` separates these effects using the same command
and fixture, with `isolation/lens-direct-vig` and `isolation/lens-step1` as the
two candidates. Adaptive coordinates with direct Lensfun vignetting still change
5,714,351 RGB channels, maximum 14 codes, MAE 0.119886. Direct coordinates with
the candidate factor-based vignetting reproduce the old Lensfun frame exactly,
without a clamp. Defaults, metadata-selected frames and old saved-history reloads
are exact; contribution guards pass. This isolates the dominant measured full-size
difference to coordinate approximation, while vignetting has a smaller interaction
with that approximation. It does not establish that the vignetting paths are
universally equivalent: their negative-value difference remains demonstrated in
previews and the standalone probe. Old frame hashes match the prior full-size
report. Only each diagnostic lens plugin differs from the original candidate
build; old-cpu and the concurrent worktree remain untouched.

### Reverse lens and interpolation matrix

The runner now accepts `--lens-reverse` and `--interpolation`. Reverse fixtures
keep initialized camera/lens defaults, explicitly set Lensfun method 1,
`inverse=1` and `has_been_set=1`, then save with old-cpu and reload in fresh
processes. The latter flag matters: without it, `commit_params` replaces inverse
with autodetected defaults. The runner checks the reviewed saved v10/356-byte
layout, initialized flag, reverse selector and nonempty camera/lens names and
records them in the report. This targets the reviewed old layout deliberately;
a changed layout fails rather than silently claiming reverse coverage.

`pixel-lens-{bilinear,bicubic,lanczos2,lanczos3}` each runs both RAWs, both sizes,
`--lens --lens-reverse`, original candidate and adaptive-grid/clamp candidate.
The selected `plugins/lighttable/export/pixel_interpolator_warp` preference is
passed identically to every engine and recorded. All six old saved-history
reloads per mode are exact at both sizes, all edits visibly contribute, and defaults are exact.
Runtime binary identities match the full-size report and prior originals.

| Warp interpolator | Olympus forward maximum, 96 / 512 | Olympus reverse maximum, 96 / 512 |
| --- | --- | --- |
| Bilinear | 45 / 96 | 6 / 15 |
| Bicubic | 24 / 72 | 6 / 16 |
| Lanczos2 | 29 / 70 | 6 / 15 |
| Lanczos3 | 22 / 69 | 6 / 12 |

The isolated clamp reduces every Olympus forward/reverse preview maximum to one
code in this matrix. Olympus metadata-selected frames are exact; Nikon forward,
metadata-selected and reverse frames differ by at most one code with or without
the clamp. These bounds apply only to the measured previews. They are not
acceptance thresholds or evidence that the full-size grid discrepancy is small.
Other lenses/images, full-size pixel-aspect combinations, tiled exports and
device parity remain open, along with the explicit import/appearance decision
above. Narrow CPU coverage follows.

Reproduce a matrix row with the preceding lens command, adding `--lens-reverse
--interpolation MODE` and using both `cpu` and `isolation/lens-clamp` as separate
`--candidate` arguments. For the full-size checks, use only the Olympus photo,
`--lens --size 4640`, and the candidates named above. No GUI was launched or
production pin/default changed. Python compilation, runner help and diff checks
pass; these audit/verification changes do not alter user-facing behavior.

### Full-size reverse, CPU tiling and pixel aspect

`pixel-lens-fullsize-reverse` uses `--lens-reverse --size 4640` on the same
Olympus fixture, original candidate and `isolation/lens-step1` (no clamp).
The saved reverse selector, initialized flag and camera/lens names pass the
existing guard. Actual output is 4640×3472; defaults and old saved-history reload
are exact, and the history visibly contributes. The original candidate changes
4,862,506 RGB channels, maximum 13 codes, MAE 0.101825. Direct coordinates reduce
this to 435 channels, maximum 3, MAE 0.000009125. Coordinate approximation is
again dominant, but direct coordinates alone do not reproduce this reverse frame.

`pixel-lens-fullsize-mini` adds `--lens --lens-reverse --size 4640
--resource-level mini`, comparing the original candidate and
`isolation/lens-step1-clamp`. Lens-specific logs show 2×2 CPU tiles, their four
individual ROIs and successful completion without tiling fallback, for both
directions on all three builds and old reloads. This is the engine's full CPU
pipe, not a file export or device test. Defaults, metadata-selected histories
and old reloads are exact. Against the tiled old reference:

| Lensfun direction | Original candidate changed channels | Maximum | MAE | Direct coordinates plus clamp |
| --- | ---: | ---: | ---: | --- |
| Forward | 3,018,101 | 14 | 0.063116 | Exact |
| Reverse | 2,564,093 | 13 | 0.053717 | Exact |

`pixel-lens-unrestricted-reference` reloads these same saved sidecars using
`render()` with `resource_level='unrestricted'` on old, original candidate and
step-1/clamp builds. Logs show ordinary lens processing without tiles. Old and
original-candidate hashes reproduce the earlier full-size forward/reverse
references; step-1/clamp reproduces old exactly in both directions. Tiled output
differs from untiled output even on the old pin, so tile-layout differences must
be assessed separately from the update's adaptive-grid difference. Exactness
against a tiled reference is not proof of tile-layout invariance.
The saved `versus-prior-reference.json` records old tiled/untiled differences of
2,861,836 channels/max 12 forward and 2,433,173/max 11 reverse. The original
candidate differs by 18,377/max 1 and 17,360/max 2 respectively. These observations
do not establish which layout is more accurate or an acceptable tolerance.

`pixel-lens-aspect` adds `--lens-aspect` at 96/512 bounds on Olympus, original
candidate and step-1 without clamp. Saved `scalepixels` v1 histories are enabled
with exact ratios 0.75 and 1.5; output dimensions respectively become 96×95 /
512×510 and 96×47 / 512×255. Old reloads and defaults are exact, with visible
edited contributions. Original maximum differences are 32/73 and 25/68 codes;
step-1 without clamp retains 32/73 and 26/68. The follow-up
`pixel-lens-aspect-clamp` checks both ratios and reverse at 96/512 against
step-1/clamp: every frame is exact. This supports the existing negative-value
diagnosis in these constructed non-square-pixel histories; it does not approve
an import policy or establish camera-metadata, full-size aspect or device parity.

Reports, sidecars and per-process logs remain in the named ignored build
directories. These diagnostics retain the coherent old-cpu baseline, production
pin/defaults and concurrent worktree. No GUI was launched.


### Old CPU tile-layout isolation

`pixel-old-lens-tile-isolation` reloads the preceding saved forward/reverse
Olympus histories on the unchanged old CPU build at 4640×3472, using `mini`
and `unrestricted` resource budgets. It saves histories with initialized lens
parameters and correction selectors 5 (distortion/TCA without vignetting) and
2 (vignetting with the saved scale retained). Saved v10/356-byte parameter,
selector, inverse, initialized and scale values are recorded in `guards.json`.
Logs confirm lens tiling only for `mini`, successful completion and no fallback.
These selector cases retain scaling; selector 2 alone is not a pure vignetting
isolation. The differences between layouts are:

| Corrections | Forward changed / max / MAE | Reverse changed / max / MAE |
| --- | --- | --- |
| Distortion/TCA, no vignetting | 2,641,451 / 12 / 0.055081 | 2,641,818 / 12 / 0.055090 |
| Vignetting, saved scale | 2,834,097 / 17 / 0.059084 | 2,393,273 / 15 / 0.049932 |
| Vignetting, scale explicitly 1 | 16,312 / 1 / 0.000338 | 14,644 / 1 / 0.000303 |

The unit-scale follow-up is `pixel-old-lens-vig-only`; guards verify selector 2
and scale exactly 1. Thus substantial old-layout sensitivity persists without
vignetting, while the unit-scale vignetting-only case has a much smaller
measured difference. These are final RGB observations, not additive module-error
components or a proof that every changed channel originates inside Lensfun.

The standalone `lensfun-eval/row-split.cc` probe uses the same system Lensfun,
Olympus profile, crop 2, focal 27, aperture 5.6, distance 1000, unit scale and
4640×3472 modifier. At rows 0/100/1736/3471, it compares one 4640-pixel call
with calls at x=0/width=2321 and x=2321/width=2319. Both forward and reverse
coordinate results differ by up to 0.0522461 pixels despite matching global
positions; vignetting results on constant 0.5 input differ by up to 0.000016809.
The source, executable and output hashes are saved in `row-split-manifest.json`.
This demonstrates library call-partition sensitivity independent of the engine.
The split is a controlled probe, not a replay of every overlapping tile ROI;
it does not establish the library's internal arithmetic cause, an accuracy
ranking, or an acceptable compatibility tolerance. No baseline plugin changed.


### Full-size pixel-aspect histories

`pixel-lens-aspect-fullsize` runs `--lens-aspect --size 4640
--resource-level unrestricted` on the Olympus fixture against the original
candidate and `isolation/lens-step1-clamp`. Saved enabled `scalepixels` v1
ratios pass the exact layout/value guard. Defaults and old saved-history reloads
are exact, and both histories visibly contribute. Lens logs show untiled CPU
processing without fallback. The report's old build identity matches the prior
full-size/tiled report exactly; the diagnostic differs from the original
candidate only in `liblens.so`.

| Saved ratio | Actual output | Original changed RGB channels | Maximum | MAE | Direct coordinates plus clamp |
| --- | --- | ---: | ---: | ---: | --- |
| 0.75 | 4640×4630 | 10,617,541 | 42 | 0.170236 | Exact |
| 1.5 | 4640×2314 | 849,955 | 11 | 0.026389 | Exact |

The evidence extends the diagnostic's old CPU appearance reproduction to these
constructed full-size non-square-pixel histories. It does not select an import
policy or cover camera-metadata-driven aspect, broader profiles, file export
or device execution. Tiled/reverse aspect follow-up is recorded below.
The production pin, defaults, baseline plugins and other worktree are unchanged.


### Full-size reverse/aspect and tile-layout follow-up

`verify/pin-pixels.py --lens-aspect --lens-aspect-reverse --size 4640`
now constructs both directions at ratios 0.75/1.5. Reverse/aspect histories
must pass both the existing saved lens v10 initialization/direction guard and
the saved enabled `scalepixels` v1 exact-ratio guard. Diagnostic log filenames
now append `.log` to the complete case name: replacing the suffix previously
collapsed decimal-ratio case names and overwrote process logs.

Ignored `pixel-lens-aspect-fullsize-mini-repeat` and
`pixel-lens-aspect-reverse-fullsize` run these switches on the Olympus fixture
with `--resource-level mini` and `unrestricted`, respectively, against the
original candidate and `isolation/lens-step1-clamp`. Both reports retain identical
build identities; old CPU matches the prior baseline. All defaults and old
saved-history reloads are exact, all four edits visibly contribute, and the
direct-coordinate/clamp diagnostic reproduces every old frame exactly.

| Budget | Direction | Ratio | Actual output | Original changed RGB channels | Maximum | MAE |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| mini | Forward | 0.75 | 4640×4630 | 3,527,416 | 23 | 0.054857 |
| mini | Reverse | 0.75 | 4640×4630 | 3,037,033 | 6 | 0.047202 |
| unrestricted | Forward | 0.75 | 4640×4630 | 10,617,541 | 42 | 0.170236 |
| unrestricted | Reverse | 0.75 | 4640×4630 | 9,606,854 | 21 | 0.153432 |
| Both | Forward | 1.5 | 4640×2314 | 849,955 | 11 | 0.026389 |
| Both | Reverse | 1.5 | 4640×2314 | 693,269 | 8 | 0.021524 |

Separate logs for old creation/reload and both candidates confirm 3×3 CPU lens
tiling for ratio 0.75 under mini, in both directions; ratio 1.5 fits untiled
under mini. Every unrestricted lens render is untiled. No tiling fallback or
failure is reported. This is CPU full-pipe coverage, not file export or device
coverage. The first mini run (`pixel-lens-aspect-fullsize-mini`) predates the log
filename fix; its repeat reproduces every frame hash and metric, build identity
and saved module history. Whole-XMP hashes differ with save timestamps.

`pixel-lens-aspect-reverse-fullsize/layout-comparison.json` compares matching
saved module histories between budgets. At ratio 0.75, old CPU and the diagnostic
each change 7,263,441 RGB channels (max 42, MAE 0.116065) forward and 6,677,592
(max 21, MAE 0.106909) reverse. The original candidate changes only 27,477
(max 1, MAE 0.000426) and 24,937 (max 1, MAE 0.000387), respectively. Ratio
1.5 is exact across budgets for every build, consistent with untiled lens logs.
These observations reinforce old CPU call-layout dependence; they do not rank
accuracy or establish a universal candidate tolerance. Appearance/import policy,
other profiles, metadata aspect, file export and device checks remain open.
