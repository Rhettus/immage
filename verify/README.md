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

The focused batch-paste regression check drives production Session and settings
code through the real engine, with isolated photos and sidecars:

```bash
node --test --test-isolation=none verify/batch-paste.test.mjs
```

It checks exact selection, untouched groups, look/strength, native history
undo/redo, virtual copies, mask/crop preservation, restart persistence, stale
undo and sidecar failure recovery. The separate visible-app `batch-paste` case
is registered in `verify/gui/`; it requires an approved GUI run.

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
| `sliders` | every control in `panels` (`manifest.ts`), moved 60% of the way to each end, changes the frame, in the expected direction where one is known (Exposure up, brighter; Saturation up, more chroma; ...), and the frame comes back when it is reset. Point curves and the crop are tried as the editors send them. Sharpening, noise and grain are judged on a 100% crop |
| `masks` | every mask slider changes the middle of an ellipse on the left of the photo, and leaves the right of the photo alone; three masks sharing instances each change only their own ellipse; an inverted mask changes the rest; a luminance range darkens the highlights more than the shadows |
| `choices` | each Preferences › Modules option other than the default: a new photo takes it, and the tool's sliders, global and on a mask, work on that module |
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
four thumbnail sizes. Optional RAW paths must contain an embedded preview.
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


Independent module preferences: run `node verify/contrast-equalizer.test.mjs`
for mapping and scoped-choice checks, and `node verify/mask-modules.mjs` with
the built engine for a render/save/reload check of global AgX alongside masked
contrast equalizer. The latter uses a temporary copy of the sample photo.

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
