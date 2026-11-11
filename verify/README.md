# Release checks

What to run before tagging a release ([releasing.md](../app/docs/dev/releasing.md)):
every slider of every panel, and of a mask, moved through the app's own
code and the engine, with the photo it renders measured; a saved edit
opened again; and the engine benchmark's main scenarios timed against the
last time this was run.

```bash
cmake --build build                      # the engine under test
python3 -I verify/run.py                 # about 10 minutes; exits 1 on a failure
python3 -I verify/run.py --accept        # after publishing a release: its edit becomes the reference
python3 -I verify/run.py --cpu           # the checks with edits on the CPU
```

The report goes to `verify/results/<date>_<sha>/report.md`, with every
measurement in `report.json`. Both, and `verify/references/`, are your
machine's own and stay out of git.

The headless persistent database lock check uses temporary state and the actual
engine executable from a selected build:

```bash
python3 -I verify/database-locks.py --build build
```

It checks live-owner exclusion, recovery after killing its own owner process,
lock cleanup and clean restart. It does not test simultaneous first startup.

The import stall check (POSIX, headless, no GUI) makes a sidecar that blocks
reads like a half-dead network share and checks the import skips the file and
its folder, reports them as `unanswered`, and leaves `open` and other folders
unblocked:

```bash
python3 -I verify/import-stall.py
```

The export metadata check (headless, no GUI, needs the `exiv2` command) gives a
TIFF every field the export dialog's Metadata section decides (GPS, serial
numbers and owner, camera and exposure, title, description, creator, rights,
keywords and an edit history), exports it with each of the 64 combinations of
those options, and reads each file back. A field must be there exactly when it
was asked for, and the capture date always:

```bash
python3 -I verify/export-metadata.py
```

The sidecar safety check (headless, no GUI, needs exiv2 and a C compiler)
fails a save in each way it can fail: a read-only folder and sidecar, a full
disk while the copy is made and while darktable writes it, and the engine
killed while each of those files is half written. The old sidecar must stay
byte for byte as it was, the error must name it, and the next save must work.
The full disk and kill cases run on Linux only:

```bash
python3 -I verify/sidecar-safety.py
```

The background-priority check (headless, no GUI) times foreground renders while
the engine imports, exports, prefetches or denoises. `--load all` is stage 0 of
the background-priority plan: for each load it times a 100% zoom render and a
slider edit at fit size idle and under the load, times the load alone and under
renders, flags busy/idle above 1.2x, and tallies from the engine's `-d perf`
lines whether the foreground modules ran on the GPU or the CPU. Run it on bare
metal; timing in a VM is indicative only:

```bash
python3 -I verify/background-priority.py --load all --opencl --raw PHOTO.ARW \
  --models ~/.local/share/app.immage/models --report background-priority.json
```

Without `--load` it is the original import check. Prefetch has no completion
reply, so its decode time is read from the engine's CPU use (Linux and macOS).

The focused batch-paste regression check drives production Session and settings
code through the real engine, with isolated photos and sidecars:

```bash
node --test --test-isolation=none verify/batch-paste.test.mjs
```

It checks exact selection, untouched groups, look/strength, native history
undo/redo, virtual copies, mask/crop preservation, restart persistence, stale
undo and sidecar failure recovery. The separate visible-app `batch-paste` case
is registered in `verify/gui/`; it requires an approved GUI run.

The Negative panel's color-profile check uses installed profile menus and verifies
the values through Session, Copy Settings, Reset and reopening the photo from its
sidecar:

```bash
node --test verify/color-profiles.test.mjs
```

The Print panel's checks run with the built engine and print nothing:

```bash
python3 -I verify/print.py          # profiles, soft proof and gamut pixels, PDFs; --keep DIR keeps them
node --test verify/print.test.mjs   # page layout, Session redraw after a proof, a PDF through print_photo
```

Real printers (CUPS, the Windows spooler) are checked by hand
([print.md](../app/docs/dev/print.md)); the visible-app `print` case is in `verify/gui/`.

The focused panorama and negative-export regression checks run with the built engine:

```bash
node --test verify/panorama.test.mjs verify/negative-export.test.mjs
```

The panorama check also verifies previews for all projections, Auto's resolved
projection, RGBA coverage and crop bounds, and that previewing writes no DNG.
Set `IMMAGE_TEST_RAW=/path/to/photo.ORF` to additionally check HDR and all-RAW panorama merges:
DNG identification and calibration tags survive EXIF copying, the thumbnail
loads, and pixels render before and after an engine restart. The RAW fixture
is copied into the temporary workspace; its original is left untouched.
Run `node verify/panorama-ui.mjs` for the panel's canvas, caching, cancellation,
stale-reply, retry and merge-settings checks in headless Chromium.

The negative-export check checks compressed DNG and TIFF color metadata, conversion and crop
round-trips, export snapshots, further exposure edits and reopening after
an engine restart. It creates its own small fixture and temporary workspace.

The film simulation check runs the app's Session against the engine:

```bash
node --test verify/film-simulation.test.mjs
```

It checks that the panel's stock hashes match the engine's for every stock
in the pack, that turning the simulation on switches AgX off and leaves
exposure on, that two films render differently, and that a preset names its
stock. It also checks that the simulation survives a save and reopen with
its tools on their film modules, that a positive TIFF exports with a neutral
history, and that turning the simulation off brings AgX back. It needs
spektrafilm's data pack: when the pack is missing, it downloads it into
darktable's shared data folder (`~/.local/share/darktable/spektrafilm`), and
it skips, saying so, when the download fails. The release decisions in
`harness.mjs` check the on/off cycle without the pack.

The focused GPS check covers camera-embedded coordinates, XMP edits and removal,
altitude invalidation, invalid input, and persistence after restarting:

```bash
node --test verify/location.test.mjs
```

The WebKit preview-placement pixel check needs a desktop display, GTK 3,
WebKitGTK 4.1 and Python's gi/cairo bindings:

```bash
GDK_SCALE=2 python verify/preview-placement.py
```

It renders a synthetic texture at final and 75% preview sizes through the
production canvas placement helper and checks for position drift. Add `--legacy`
to reproduce the failure with fractional CSS canvas dimensions. The browser
test opens a temporary window; it does not need a photo or the engine.

## What it checks

`run.py` takes the largest raw in `benchmarking/corpus/` and the smallest
raw of another camera, and exports the second as a color JPEG and a
16-bit TIFF, for photos that are not raws (the corpus's own JPEGs are
black and white). `harness.mjs`
then runs the app's `Session` (`app/src/session.ts`) under Node, with
Tauri's `invoke` replaced by `shim.mjs`, which sends the engine what the
Rust commands would. So the checks cover `manifest.ts`, `localMerge.ts`,
`Session`'s edits and masks, and the engine together, as the app runs
them. The engine is started as the app starts it, with edits on the GPU
as by default; `--cpu` runs the checks as with Preferences' Edit on the
GPU off. Without an OpenCL device, both render on the CPU.

| check | what passes |
|---|---|
| `sliders` | every control in `panels` (`manifest.ts`), moved 60% of the way to each end, changes the frame, in the expected direction where one is known (Exposure up, brighter; Saturation up, more chroma; ...), and the frame comes back when it is reset. Negative input and working profiles use the installed choices returned by the engine; at least one choice must change the frame, since the default and some profile pairs can render identically. The dedicated color-profile test checks profile values through Session, Reset and sidecar reopening. Point curves and the crop are tried as the editors send them. Sharpening, noise and grain are judged on a 100% crop |
| `masks` | every mask slider changes the middle of an ellipse on the left of the photo, and leaves the right of the photo alone; three masks sharing instances each change only their own ellipse; an inverted mask changes the rest; a luminance range darkens the highlights more than the shadows. A mask's Highlights and Shadows pass on any one photo, as a photo may have nothing bright or dark under the ellipse; the harness's own `tones.tif`, six black-to-white ramps across every hue, always has both |
| `choices` | each Preferences › Modules option other than the default: a new photo and a new mask take it, and the tool's sliders, global and on a mask, work on that module. Highlights and Shadows are also tried on `tones.tif` on each of their modules. `--controls` limits these trials too |
| `fixes` | bugs fixed before these checks existed, each as the release that fixed it left it: a renamed mask, a deleted one, the last edit before quitting, subtracting from a range, a warm daylight white balance, masks over a crop and its undo, a stopped base render, export in the Before view, a refined mask with no adjustment, a range map after zooming in, range masks on a JPEG or TIFF, Clarity at ±1 changing less than at ±10, AI models unpacked without a system unzip, a model that won't load downloaded again (with Select Object's model from `build/ai-models`, else skipped), Auto, sampling, the zones and Upright with edits on the GPU (skipped without OpenCL); on a strip of every hue, HSL's Blue graying blue more than Purple does, Aqua still working with Blue at -100, Luminance and the B&W Mix at -100 leaving a saturated red visible, and an older HSL band unchanged at the next edit |
| `decisions` | what Immage decided it does, as the README, the code map and the backlog's Decisions say: the new-photo defaults leave a photo unedited; the photo file is never written; the filmstrip is in capture order; drag drafts are sized for the screen's scale on Wayland at 125%, and nowhere else; the Filters popup narrows by camera, keywords (with those under them) and ISO, from what the folder lists, and each of its lists by the other choices; frames and the zoomed-in copy come back without a render when the image does (the Before view and back, a slider put back); a prefetched photo opens as it would cold; darktable's own edit is kept; a photo keeps its tool's module; a tone curve saved before Midtones opens on the same sliders; drag frames and previews leave the edit as it is; the default modules; which local modules masks share, and which masks can't; O and an adjustment hide the overlay of a brush adding to a mask, and of a mask an AI selection just made, which shows it until then; a Zone System mask narrowed to an object boxed for Select Object changes only the object, and keeps it when opened again (with Select Object's model from `build/ai-models`, else skipped); a converted negative turns its modules off, opens again so and turned back has them as they were; the negative's pickers read negadoctor's input; a starved channel does not set its White Point |
| `roundtrip` | an edit of a dozen sliders and two masks, saved, the engine restarted and the photo opened: the same values read back (every other mask slider still at zero), and the same frame |
| `reference` | the roundtrip's edit as `--accept` kept it, from the build that made it: this build renders it the same. This is how a change to how old edits look shows up |
| timing | `benchmarking/bench.py --only sliders,roi,masks --opencl app`, on the CPU and on the app's GPU engine, 5 samples a step, compared with the last run made by `verify/run.py` of the same photos on the same machine: a step whose fastest sample is more than 25% and 5 ms slower fails. The fastest, because the median of a few samples moves by up to 40% between runs on an idle machine. The first run on a machine only records, as does the first GPU run after runs that timed the CPU alone |

`expect.mjs` says what each control should do; a control it doesn't name
is still tried, and must change the photo. Its thresholds are mean
differences in 8-bit levels over the frame (or the mask's middle).

## When a bug is fixed

Every bug fixed gets a check here that fails without the fix: run it once
with the fix taken back out to see it fail. Where an existing check
already caught the bug, that is enough; otherwise add one to `fixes` in
`harness.mjs`, or beside the check it belongs with, naming the release
that fixed it in a comment, as the masks check's "mask added mid-send"
does. A bug that only shows when requests overlap can change the edit as
a request goes to the engine, through `sent.hook` in `shim.mjs`. The shim
also refuses a command `main.rs` doesn't register, as the app would.

A decision about how Immage behaves gets a check in `decisions`, citing
where it is written down. Changing the decision changes its check in the
same commit.

## Reading a failure

- **no visible change**: the control moved and the photo didn't. Before
  0.32.0, a mask's Highlights, Shadows and Whites failed this way. A
  control that only shows on some photos (a color band, a lens correction)
  is marked `anyPhoto` and passes if one photo shows it.
- **moved ..., expected up/down**: it changed the photo the wrong way.
- **put back, the frame stays different**: back at its starting value, the
  control left something behind, such as a module still on.
- **changed the photo outside the mask**: a mask's slider leaked.
- **roundtrip values**: what was saved isn't what reads back, or one
  slider's value shows up in another's.
- **reference**: the build renders a saved edit differently from the build
  that recorded it. Intended, after a darktable update say, or not: look
  at the edit, then run `--accept` to make this build the reference.
- **timing**: see the table in the report; run it again on an idle
  machine, on mains power, before trusting a slowdown.

To look into one control: `python3 -I verify/run.py --skip-perf --checks
sliders --controls usm_amount --images DSC07636`.

For the headless pipeline checkpoint policy, run
`python3 -I verify/run.py --skip-perf --checks checkpoints --images PHOTO`.
This checks pipe debug hints for the scaled checkpoint and excludes retention
of the full-resolution input to scaling. It also checks repeated GPU drags
for unnecessary demosaicing when OpenCL is available; that portion is reported
as skipped when no module runs on the GPU.

## Visible-app GUI suite

The separate [visible-app suite in `gui/`](gui/README.md) now checks startup and
real Exposure pointer drags/reset, CSS/hit-testing and rendered photo pixels in
the Tauri window. Run `node verify/gui/run.mjs --config verify/gui/local.json
--suite smoke` after following its setup guide. Results and application screenshots
live in ignored `verify/results/gui/`. The broader GUI matrix remains planned;
these smoke checks supplement the pipeline tests below.

## What it doesn't cover

- The interface itself: whether a click on a slider reaches `change()` in
  `App.tsx`, panels showing, the canvas. Open a photo in the release
  build and move a few sliders by hand.
- Upright's automatic modes (`tf_upright`, the guides), which come from
  the engine's line detection; the Transform sliders are checked.
- AI masks and AI Denoise, looks, presets, export settings and Immich.
- The GUI benchmark (IPC, drawing): run it from Preferences in the app
  ([benchmarking/README.md](../benchmarking/README.md)).

## Folder metadata and embedded thumbnails

Build and run the focused checks with an isolated scratch directory:

```bash
cmake --build build --target immage-thumbnail-check
build/bin/immage-thumbnail-check /tmp/immage-thumbnail-check /path/to/camera.CR2 /path/to/camera.NEF
```

The check generates TIFFs with two embedded JPEG sizes, rotated orientation,
metadata beyond the prefix limit, and truncated data. It verifies metadata,
compares extracted JPEG bytes with Exiv2's full-file previews, and decodes
four thumbnail sizes. It also writes a small DNG and checks all eight camera
orientations through the production denoise and HDR metadata helpers, including
the imported orientation, DNG calibration tags and denoise marker. Optional
RAW paths must contain an embedded preview.
On Linux it also prints logical bytes read from `/proc/self/io`; these include
buffering and other reads during each call and do not measure network traffic
or physical disk reads. Camera fixtures are supplied locally and stay out of git.


## Native detail preview checks

Check detail eligibility, native loupe selection, view/release invalidation,
tuner search, exact frame delivery, and histogram/clipping worker lifecycle:

```bash
node --test verify/detail-preview.test.mjs verify/performance-tuner.test.mjs verify/preview-handoff.test.mjs verify/pixel-worker.test.mjs
```

Check histogram endpoint widths and black/white clipping in headless Chromium:

```bash
node verify/histogram-rendering.mjs
```

## Scaled checkpoint retention

Exercise cache churn beyond its entry count, the three-checkpoint bound,
invalidation, memory trimming and the two-buffer fallback:

```bash
cmake --build build --target immage-checkpoint-check
build/bin/immage-checkpoint-check
```

After cache structure changes, rebuild the full tree before rendering so the
engine and dynamically loaded image-processing modules use the same layout.


Module switch dot (`Session.adjustedModules`): run `node verify/module-others.test.mjs`.
Independent module preferences: run `node verify/contrast-equalizer.test.mjs`
for mapping and scoped-choice checks, and `node verify/mask-modules.mjs` with
the built engine for a render/save/reload check of global AgX alongside masked
contrast equalizer. The latter uses a temporary copy of the sample photo.
The saturation curve has the same pair: `node --test
verify/saturation-curve.test.mjs`, and `node verify/saturation-curve-engine.mjs`
with the built engine, which also checks that the curves raise the chroma.

Camera body filtering: after building the engine, run
`node --test verify/camera-body.test.mjs` (requires the `exiv2` CLI).
Fixtures cover standard EXIF and DNG body serial tags, leading zeros,
missing/placeholder serials and lens-only metadata through import and meta
replies. Filter checks cover identical models with swapped lenses, multiple
bodies, unknown bodies, combined filters, facet counts and active filter counts.

## Portrait Transform corpus

`python3 verify/transform-sampling.py --write-corpus benchmarking/corpus`
runs the real engine without a GUI and adds reproducible synthetic TIFFs to
the ignored local corpus: landscape, native portrait, clockwise and
counterclockwise EXIF portraits, and mirrored portrait. Existing corpus files
are never replaced with different content. Tests edit temporary copies only.
All fixtures exceed Upright's 1600-pixel sampling limit so downscaling is covered.
The check fits Auto, Level, Vertical and Full before cropping, after cropping
and after restoring the frame, with intervening renders and applied corrections.
These fixtures supplement real camera portrait RAWs; they do not establish RAW,
GPU or visible-app coverage. Run without `--write-corpus` for temporary fixtures.

## Pin image comparisons

Run the headless comparison with coherent engine, core and plugin builds:

```sh
python3 verify/pin-pixels.py --old build/darktable-pin-review/old-cpu \
  --candidate build/darktable-pin-review/cpu \
  --candidate build/darktable-pin-review/features \
  --photo /path/to/camera.NEF --output build/darktable-pin-review/pixel-defaults
```

A synthetic colored PNG is always included. Repeat `--photo` for more inputs and
`--size` for render bounds (defaults: 96 and 512). Only disposable photo copies
are imported, without adjacent sidecars; each input/build has isolated state.
CPU processing uses two OMP threads. The output directory retains RGBA frames,
engine logs and `report.json` with input/binary hashes and RGB difference metrics.
Nonzero differences are reported for review, not automatically accepted or
rejected. Without a history switch, this covers fresh engine defaults.

Add `--edited` to create four independent old-build histories: exposure +1.25 EV,
sigmoid contrast 1.9, AgX contrast 2.5, and vignette brightness -0.7 / scale 50 /
falloff 40 / dithering off. Tone-mapper cases explicitly disable the other
mappers. Each edit must change the old reference at every requested size. The
old build saves each sidecar; fresh processes with empty state reload the same
old-created sidecar in the old and every candidate build. Reports retain the
requests, sidecar hashes and saved module versions alongside RGB metrics. Old
reload results expose any baseline roundtrip differences separately. Schema v2
groups comparisons under `inputs` → input → `cases` → case → `comparisons`.

Use `--vignette` for six independent saved-history variants: dithering off,
8-bit and 16-bit dithering, positive brightness, saturation alone, and an
off-center shape. It uses the same old-save/fresh-reload/contribution checks
and can be combined with `--edited`. This narrows the falloff compatibility
question; it does not choose a migration policy or exercise an OpenCL device.

Use `--detail` for independent anisotropic diffuse smoothing and sharpening
histories. Both diffuse cases use five iterations,
radius 64 and edge sensitivity 1; smoothing sets first/second speeds to 0.5,
sharpening sets second/fourth speeds to -0.5. Active orders use anisotropy 2
to exercise the changed diffusion weights. Use `--nlmeans` separately for
non-local-means denoise with patch size 2,
strength 10000 and full luma/chroma. These cases use the same saved-sidecar and
visible-contribution checks. They cover CPU output at the requested bounds,
not full-resolution tiling, profiled denoise, a noise corpus or device parity.

Use `--transforms` for saved ashift rotation (+7 degrees) and perspective
(rotation -3, vertical shift 0.2, horizontal shift -0.15, shear 0.05).
Dimensions may change from defaults; old reload and candidate dimensions must
match the old edited reference. This exercises pixel sampling, not automatic
line fitting, tiled exports, pixel-aspect transforms or transformed masks.

Use `--highlights` for supplied NEF/ORF photos: clipping, opposed and segmentation
methods with threshold 0.1 to force visible reconstruction. Use `--lens` for
independent Lensfun (method 1) and metadata-selected (method 0) histories on
these RAW formats. Metadata selection can fall back to Lensfun when metadata
is absent; a saved method value alone does not prove which path executed.
Lensfun profiles come from the installed database, so retain its identity with
local evidence. Use `--lens-reverse` for an additional Lensfun simulation history:
it retains initialized camera/lens defaults and sets `inverse=1` and
`has_been_set=1`, avoiding autodetection replacing the requested direction.
Use `--lens-aspect` for Lensfun histories combined with `scalepixels` ratios
0.75 and 1.5. The saved version, enabled flag and exact ratio are checked before
reporting coverage. Add `--lens-aspect-reverse` for the same ratios combined
with reverse correction; both saved lens initialization/direction and aspect
parameters are guarded. These are constructed histories, not camera metadata tests.
Use `--interpolation bilinear|bicubic|lanczos2|lanczos3` to set the same warp
interpolation preference in every fresh engine process; run each preference into
a separate output directory. The report records the requested preference.
Diagnostic log names retain the complete case name, including decimal ratios,
so each process has its own log.
These switches share the fresh-process reload/contribution guards
and can be combined. PNG receives only the transform cases; unsupported photo
suffixes receive neither highlight nor lens cases. No X-Trans/linear RAW,
invalid-white, disabled-temperature or device coverage is established by these
fixtures. Explicit `--size` values can request full-size processing; verify the
actual reported dimensions rather than assuming a large target proves it.
Use `--resource-level minimum|mini|reference|unrestricted` to apply the same memory budget
to every process and retain pipe/tiling diagnostics. A requested budget is not
proof of tiled execution: check lens-specific tile-processing logs, successful
completion and absence of fallback, and compare with an untiled reference.
`minimum` selects `small` with `resource_small=1 1 128 400`, using the reviewed
engines' CPU floor of 512 MiB available; single-buffer memory is total/1024,
with a 2 MiB floor (11 MiB on this audit host). This is an
isolated diagnostic configuration; it does not change application preferences.

These are constructed, unmasked engine histories, not production Session edit
orchestration, a user-created style corpus, HDR/device output or a broad image
corpus. In particular, upstream processing fixes can change a saved edit even
when its parameters migrate correctly; inspect nonzero metrics before adoption.

Rebuild all IOP/imageio modules after changing shared engine headers. An older
plugin can load despite an incompatible custom struct layout, producing wrong
pixels even when scalar field access succeeds. Do not mix freshly linked core
libraries with stale plugins when constructing references.

## Candidate mapped scalar access

Run `python3 -I verify/mapped-fields.py --build build/darktable-pin-review/cpu`
(or another complete engine build) to read live/default values and individually
change and restore every global/local manifest field through the real engine. Node and app
dependencies are required. The manifest is imported directly, including array
paths; photos and state are temporary. This headless check verifies scalar access
and preservation of neighboring mapped values. Use `--snapshot PATH` to save
initial live/default responses for comparisons. It does not verify UI control responses,
enum semantics, RAW processing or image compatibility across pins.
Add `--controls` to exercise actual global/local production map writes at control
boundaries/neutral values and every declared option on mapped controls. It checks
all emitted fields and mapped neighbors, allowing float storage rounding, then
restores original values exactly. Add `--read-report PATH` to save production reads, recognized controls and
activation/enable/visibility predicates evaluated on the stored engine parameters
and original input values. Compare reports across builds using 2e-6 relative/absolute
tolerance for returned control values and exact recognition/predicate equality.
This tests cross-build equivalence, not an independent formula oracle, session
preference/history selection, tagged/local instance isolation, rendering or GUI behavior.

## Candidate masked-look sidecars

Run `python3 -I verify/look-compat.py --build build/darktable-pin-review/cpu`
(or the complete features build) for actual-engine style import, preview isolation,
A→B→A switching and save/reload checks. Temporary photos include a single-module
exposure look and a two-module exposure/color-balance look with independent circle
and rotated-ellipse masks. Both are reopened and imported from XMP in fresh
processes with empty in-memory libraries. The multi-module case checks exact
parameters, all blend bytes, mask hashes and distinct mask groups. Rebuilt frames
allow one code value in at most 0.1% of bytes; other pixel comparisons are exact.
The copied BGRX buffer’s unused fourth byte is initialized to opaque, matching
RGBA output; upstream gamma leaves that byte unwritten. Rendering forces CPU;
this does not establish real-style corpus, pixel/raster-mask or GPU coverage.


Run `python3 -I verify/mapped-enums.py --build BUILD --old OLD_REV --new NEW_REV`
to discover mapped enum types from generated introspection and compare their
source declarations between local darktable Git revisions. This verifies enum
names/order/assignments, not processing semantics or pixel equivalence.

### Session choice selection from engine snapshots

Run `node verify/session-choices.mjs SNAPSHOT` with a JSON snapshot produced by
`mapped-fields.py --snapshot`. This imports actual Session/manifest code and
checks preference/history choice selection, foreign exclusion, negative
overrides, neutral snapping, bypasses and combined tone-mapper choices.
Engine commands use the supplied snapshot; mask loading and rendering are stubbed.
It launches no GUI or engine and does not verify rendered output or RAW defaults.
See the darktable update review for the three comparison inputs and limits.


`mapped-fields.py --photo PATH` uses a disposable copy of a local input photo
without its sidecar instead of the generated PNG. Use `--snapshot PATH` to
compare mapped RAW camera defaults across builds; a single camera does not
establish broad RAW or pixel equivalence. The candidate `look-compat.py` check
also exercises loaded AgX/sigmoid new HDR defaults and previous-version legacy
conversion, including prefix preservation and the production conversion wrapper.
Sigmoid v1/v2 chains check preserved old bytes and zero-filled additions. Synthetic
on-disk styles with sigmoid v1/v2/v3 and AgX v7 parameters exercise the actual
style importer and Immage item conversion. Each style also checks complete applied
parameter/blend bytes, exact preview/applied pixels, a visible pixel contribution
and exact baseline restoration when disabled. Real sidecars containing those
historical parameter layouts then load in separate fresh processes with empty
libraries: complete converted params/blend and reference pixels must match.
These use current structured XMP and current blend data; they do not establish
historical XMP schema, user-style/sidecar corpus or old/new rendered-pixel equivalence.

### Lensfun profile library probe

To compare direct CPU float vignetting with factors extracted from 0.5 across
installed calibrated profiles, build and run the standalone diagnostic:

```sh
c++ -std=c++17 -O2 -Wall -Wextra verify/lensfun-profiles.cc \
  $(pkg-config --cflags --libs lensfun) -o /tmp/lensfun-profiles
/tmp/lensfun-profiles /usr/share/lensfun/version_1 > /tmp/lensfun-profiles.tsv
```

It uses each eligible profile's first vignetting calibration, three row widths,
both directions and seven constant values. TSV records direct/factor differences,
zero-clamped differences and nonfinite counts. Missing XML, failed loading,
inactive vignetting or failed evaluation exits nonzero. Compare library/database
versions and hashes when interpreting results. The default samples the top row only;
it does not verify engine image output, profile matching, OpenCL or import policy.
A zero clamp reproduces the original Olympus probe but fails for some other
profiles; see the developer pin review for measured coverage and exceptions.

Pass `--all-calibrations` to sample every eligible stored calibration at the top,
center and bottom rows. The TSV appends zero-based `calibration` and `y` columns
in both modes. Widths, constant values and directions remain the same. This
expands library sampling; it does not supply whole-image or device references.

### Isolated Lensfun direct CPU diagnostic

Build a separate candidate plugin without changing either source/build tree:

```sh
python3 verify/pin-lens-direct.py \
  --source build/darktable-pin-review/source \
  --build build/darktable-pin-review/cpu \
  --output build/darktable-pin-review/isolation/lens-direct-reference
```

The output must be new. This Linux Ninja diagnostic checks source anchors and
reuses the configured candidate compiler/link flags; it copies deployment trees
with symlinks and replaces only its own lens plugin. Generated source, build log
and input/output hashes remain in the output. Use it as `--candidate` in
`pin-pixels.py`. Hold the source build unchanged while using the symlinked tree.

It forces direct row coordinates, replaces factor-grid vignetting with
actual-pixel Lensfun calls and disables the committed Lensfun OpenCL readiness
flag. Unused factor grids and per-thread factor allocations are removed. Metadata
and manual processing are unchanged. It adds no serialized mode or import default;
it is an isolated CPU compatibility experiment, not a production pin update.

### Signed Lensfun boundary diagnostic

`pin-lens-signed.py` builds a separate instrumented plugin using either a
configured old source or the generated direct-prototype source. It supports the
local Makefiles old build and Ninja candidate build; no original files are
written. For example:

```sh
python3 verify/pin-lens-signed.py \
  --source build/darktable-pin-review/old-source \
  --build build/darktable-pin-review/old-cpu \
  --output build/darktable-pin-review/isolation/lens-signed-old
python3 verify/pin-lens-signed.py \
  --source build/darktable-pin-review/source \
  --input-source build/darktable-pin-review/isolation/lens-direct-reference/lens-direct.cc \
  --build build/darktable-pin-review/cpu \
  --output build/darktable-pin-review/isolation/lens-signed-direct
python3 verify/pin-lens-signed-check.py \
  --old build/darktable-pin-review/isolation/lens-signed-old \
  --direct build/darktable-pin-review/isolation/lens-signed-direct \
  --fixtures build/darktable-pin-review/pixel-lens-direct-exceptional-full \
  --photo /path/to/copied/Sample.ORF \
  --output build/darktable-pin-review/pixel-lens-signed \
  --size 512 --size 4640
```

The checker requires the 24 previously prepared assigned-profile XMP fixtures.
Immediately before each actual forward/reverse Lensfun color call, the diagnostic
replaces RGB with a repeating coordinate-based pattern of -1, -0.01, signed zero,
zero, 0.01, 0.5, 1, 2 and 10, and sets the fourth channel to 0.25. It hashes each
complete floating output row, including the fourth channel, before subsequent
pixelpipe stages. `SIGNED_LENS` records retain direction, coordinates, dimensions,
sign counts, nonfinite counts, fourth-channel changes and SHA256. The checker
compares record multisets because OpenMP completion order varies, rejects empty
traces/nonfinite outputs/fourth-channel changes, and requires exact final RGBA.
Temporary photo/config copies and the minimum CPU budget follow `pin-pixels.py`.
Reports, frame/log evidence and file identities remain in the new output directory.

This deliberately changes intermediate pixels in diagnostic copies. It tests the
actual module call sites with signed inputs; it does not establish the occurrence
of these values in real photos, matching-camera imports, OpenCL behavior, or a
production compatibility policy. Hold the underlying builds unchanged while using
the symlinked deployments. Do not ship these instrumented plugins.

The signed checker also accepts `--interpolation bilinear|bicubic|lanczos2|lanczos3`
and `--aspect 0.75|1.5`. Use a fresh output directory for each configuration.
Aspect edits are applied to the assigned sidecar in temporary state, saved as
per-engine XMP evidence, and checked for enabled version-1 parameters with the
exact requested ratio. The report records both settings. These assigned fixtures
enable vignetting only: interpolation preferences do not by themselves test
geometric lens warping. Both ratios pass at 512-pixel bounds with all four
preferences and at 4640-pixel bounds with bicubic (48 full-size comparisons,
920,227 matching floating-row records). Reproduce full-size aspect runs by
adding `--size 4640 --interpolation bicubic --aspect 0.75` or `--aspect 1.5`
to a fresh checker invocation. Other preferences at these ratios remain
preview-only. The earlier full-size signed run uses the original aspect.


For signed geometric processing, add `--geometry` to **both** plugin-builder
invocations, choose fresh deployment directories, then pass those deployments
and `--geometry` to the checker. The checker enables distortion plus vignetting
(flags 6), saves each engine's XMP and verifies enabled version-10 parameters.
The builder injects the same pattern into a private module-input buffer instead
of overwriting values at the vignetting boundary. Bypass, grid failure or absence
of an active geometry modifier aborts the diagnostic. Floating rows are sampled
after the complete CPU Lensfun operation, covering the direction-dependent order
of geometry and vignetting. Only RGB is measured: packed trace alpha is a fixed
synthetic value because normal geometry output alpha is unspecified outside mask
display. Thus geometry-mode alpha counts are not alpha-preservation evidence.
Use `--size 512 --interpolation bicubic` for the initial preview configuration;
repeat with bilinear, lanczos2 and lanczos3 using fresh output directories.

Preview geometry results: all 96 comparisons pass across 12 assigned exceptional
profiles, both directions and bilinear/bicubic/Lanczos2/Lanczos3 at 512×383.
All 36,768 floating RGB row records and final RGBA frames match old CPU exactly;
outputs are finite. Forward output retains negative RGB with bicubic and both
Lanczos preferences; bilinear and all reverse outputs have none for this pattern.
Ignored `build/darktable-pin-review/pixel-lens-signed-geometry-{mode}/`
directories retain reports, frames, logs, saved XMP and identity manifests.
Full-size bicubic geometry also passes all 24 comparisons at 4640×3472 with
minimum-budget tiling: 487,199 floating RGB rows and all final RGBA frames match
exactly. Outputs are finite; all forward cases retain negative RGB and reverse
cases have none for this pattern. All 179 run-manifest file hashes were independently
reverified. Evidence is retained in ignored
`build/darktable-pin-review/pixel-lens-signed-geometry-full-bicubic/`, with counts
in `lens-signed-geometry-full-summary.json`. Reproduce using the same geometry
deployments and checker with a fresh output directory and
`--geometry --size 4640 --interpolation bicubic`.

Changed-aspect preview geometry also passes all 192 comparisons across ratios
0.75 and 1.5, four interpolators, 12 assigned profiles and both directions.
All 73,440 floating RGB rows and final RGBA frames match exactly at 512×510
and 512×255 respectively; outputs are finite. Forward bicubic/Lanczos cases
retain negative RGB; bilinear and all reverse cases have none for this pattern.
Saved XMP verifies the aspect ratio and geometry flags. All 1,432 run-manifest
hashes were independently reverified. Evidence is retained in ignored
`pixel-lens-signed-geometry-aspect-{mode}-{075,15}/` directories under
`build/darktable-pin-review/`; `lens-signed-geometry-aspect-summary.json`
aggregates counts. Reproduce with the geometry deployments, a fresh output
and `--geometry --size 512 --interpolation MODE --aspect 0.75` or `--aspect 1.5`.
Full-size changed-aspect bicubic geometry at ratio 1.5 also passes all 24
comparisons at 4640×2314: 163,595 floating RGB rows and every final RGBA frame
match exactly. Outputs are finite; all forward cases retain negative RGB and
reverse cases have none for this pattern. Saved XMP verifies the aspect ratio
and geometry flags; all 179 run-manifest hashes were independently reverified.
Evidence is retained in ignored
`build/darktable-pin-review/pixel-lens-signed-geometry-aspect-full-bicubic-15/`,
with counts in `lens-signed-geometry-aspect-full-summary.json`. Reproduce with
fresh output and `--geometry --size 4640 --interpolation bicubic --aspect 1.5`.
The ratio 0.75 full-size run remains pending: only 2.4 GB of disk space remained
after preserving this evidence.

Full-size ratio 0.75 geometry, full-size alternative interpolators,
mask/alpha behavior, natural-image negatives, matching-camera imports and native
devices remain outside these results.

For a small CPU display-alpha diagnostic, build both signed plugins with
`--geometry --mask-display` and pass the same flags to the checker. This forces
only the local lens CPU mask-display branch, injects a spatial alpha ramp
`((x + 3*y) % 17) / 16`, and hashes actual intermediate RGBA. The trace's last
count measures nonfinite alpha in this mode; zero is required. Plugin manifests
must agree with the checker mode. This does not exercise the separate
`distort_mask` entry point or prove end-to-end mask display. Use `--size 128`
for a disk-conscious first pass and retain manifests with the reports.

Build both plugins with `--geometry --distort-mask`, then pass those flags to
`pin-lens-signed-check.py` to exercise `_distort_mask_lf` directly using each
active image transform's ROIs. Three single-channel inputs cover a coordinate
ramp, hard step, and repeating -0.5/0.5/1.5 values. NaN-initialized output must
be finite within [0,1]; `MASK_LENS` records hash each actual floating mask row.
The checker compares exact row multisets and requires all three patterns for
every image row. `exact_mask_rows` is separate from `exact_float_rows` (image
RGB or RGBA). This tests active CPU transforms, not mask UI/routing or injected
grid-failure cases. At 128x95, all four interpolators matched 96 cases and
27,360 mask rows; display-alpha previews also match all four interpolators.
Each pattern must cover the exact image-row coordinate multiset, so duplicate
coordinates cannot hide missing rows.

Add `--mask-bypass` to both builder and checker (requires `--distort-mask`) to
exercise missing-lens, zero-crop, missing-maker and inactive-modifier bypasses
for every pattern. The inactive case disables correction flags, sets unit scale
and matches the lens projection; reported geometry flags must be zero. A local piece/data
copy and equal input/output ROIs isolate these calls from the active transform.
The plugin requires byte-exact input copies, including out-of-range samples,
and emits `MASK_BYPASS` hashes; the checker requires all four cases for each pattern
and reports `exact_bypass_copies` separately. Differing ROI shapes and
grid/allocation failure remain untested.
The bicubic 128x95 bypass run passed 24 profile/direction cases and 288 copies
per plugin, with 6,840 active mask rows and 2,280 image RGB rows still exact.
All 179 run hashes verified; an omitted bypass-pattern trace was rejected.

The expanded mask-bypass deployments also passed bicubic previews with
`--aspect 0.75` and `--aspect 1.5` (add to the checker). Each run covered
24 cases and 288 exact bypass copies per plugin. Active mask/image row totals
were 9,144/3,048 at 128x127 and 4,536/1,512 at 128x63; final frames matched.
All 179 hashes per run verified. Evidence is under ignored
`pixel-lens-mask-bypass-aspect075-bicubic-128/` and
`pixel-lens-mask-bypass-aspect150-bicubic-128/` in the pin-review directory.
Changed-aspect bilinear coverage is recorded below; full-size masks and
fault-injected grid failure remain open.

Bilinear changed-aspect CPU mask follow-up: the expanded bypass deployments
also passed all 24 cases at each aspect, 0.75 (128x127) and 1.5 (128x63).
Active mask rows matched 9,144/4,536, image RGB rows matched 3,048/1,512,
and final frames matched exactly. Each run passed 288 byte-exact bypass copies
per plugin. All 179 manifest hashes per run were independently verified with
scripts unchanged during execution. Ignored evidence:
`build/darktable-pin-review/pixel-lens-mask-bypass-aspect075-bilinear-128/`
and `pixel-lens-mask-bypass-aspect150-bilinear-128/`. Changed-aspect preview
masks cover bilinear and bicubic here; Lanczos preview and full-size coverage
are recorded below. Invalid ROIs, grid failure and nonfinite coordinates remain
open. No production or pin change.

Lanczos changed-aspect CPU mask follow-up: Lanczos2 and Lanczos3 each passed
24 cases at aspect 0.75 (128x127) and 24 at aspect 1.5 (128x63), using the
same expanded bypass deployments and unchanged checker. Each interpolator
matched 9,144/4,536 active mask rows and 3,048/1,512 RGB rows respectively,
with exact final frames and 288 byte-exact bypass copies per plugin per run.
All 716 manifest hashes across the four runs were independently verified.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-aspect075-lanczos2-128/`,
`pixel-lens-mask-bypass-aspect150-lanczos2-128/` and corresponding `lanczos3` directories.

Full-size bicubic CPU mask follow-up: all 24 assigned-profile/direction cases
passed at 4640×3472 under the minimum CPU budget. Old and direct plugins match
exactly across 487,199 signed RGB rows, 1,461,597 single-channel mask rows,
9,720 bypass copies per plugin and all final RGBA frames. All 179 evidence
manifest hashes were independently verified. This closes ordinary-aspect
full-size bicubic mask coverage only; full-size alternative interpolators and
changed aspects, grid failure, nonfinite coordinates and native OpenCL remain
open. Inputs are synthetic patterns on an unrelated RAW, not camera calibration
validation. Production pin/defaults remain unchanged.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-bicubic-full/`.

Full-size bilinear CPU mask follow-up: all 24 cases passed at 4640×3472
under the minimum CPU budget, using unchanged diagnostics and deployments.
Old/direct results match across 487,203 signed RGB rows, 1,461,609 active
mask rows, 9,720 byte-exact bypass copies per plugin and every final RGBA
frame. All 179 evidence hashes were independently verified. Ordinary-aspect
full-size masks now cover bilinear and bicubic; Lanczos full-size masks,
changed-aspect full-size masks and the fault/native gates remain open.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-bilinear-full/`.
Full-size Lanczos2 CPU mask follow-up: all 24 cases passed at 4640×3472
under the minimum CPU budget with unchanged diagnostics and deployments.
Old/direct results match across 487,199 signed RGB rows, 1,461,597 active
mask rows, 9,720 byte-exact bypass copies per plugin and every final RGBA
frame. All 179 evidence hashes were independently verified. Ordinary-aspect
full-size masks now cover bilinear, bicubic and Lanczos2. Full-size Lanczos3,
changed aspects and the fault/native gates remain open. Synthetic inputs on
an unrelated RAW do not establish matching-camera accuracy.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-lanczos2-full/`.

Full-size Lanczos3 CPU mask follow-up: all 24 cases passed at 4640×3472
under the minimum CPU budget with unchanged diagnostics and deployments.
Old/direct results match across 487,195 signed RGB rows, 1,461,585 active
mask rows, 9,720 byte-exact bypass copies per plugin and every final RGBA
frame. All 179 evidence hashes were independently verified. Ordinary-aspect
full-size masks now cover all four CPU interpolators. Changed-aspect full-size
masks and the fault/native gates remain open. Synthetic inputs on an unrelated
RAW do not establish matching-camera accuracy.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-lanczos3-full/`.

Changed-aspect synthetic preview masks cover all four CPU interpolators.
Remaining full-size cases, invalid ROIs, grid failure, nonfinite coordinates
and native OpenCL remain open. No production behavior or pin change.

## GPU check

`python3 -I verify/gpu-parity.py` runs the engine headless on a synthetic
TIFF: the `opencl` reply's counters, `cl_errors` on `render`, and `parity`
with both passes on the CPU, whose frames must be identical, plus its pass
markers on stderr. Without an OpenCL device it also checks that a GPU
comparison is refused; with `--opencl` on a machine with one, it compares
the CPU and the GPU and requires ΔE p99 < 2.
`node --test verify/gpu-check.test.mjs` checks the app's cases against the
real manifest controls and the pass verdicts. Neither launches the app.

## Unpack containment

`python3 -I verify/unpack-containment.py [--engine path]` runs the real engine
without a GUI and sends `unpack` crafted zips (`.dtmodel` is a zip): `../`
and absolute entries, a symlink followed by a file through it, a symlink
overwritten by a file, and a benign control. It fails if anything outside the
target folder is created or changed; tar archives must be refused.
