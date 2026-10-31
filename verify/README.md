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


## Cached preview GPU checks

Run `node --test verify/cached-detail.test.mjs verify/performance-tuner.test.mjs`
for cache eligibility, GPU descriptors, CPU fallback, prediction rejection,
in-flight anchor ordering and exact release behavior. Display-frame tests also
cover burst coalescing, queued-preview cancellation and revalidation, native
refresh with paused animation callbacks, and release before the next frame.

Run `node verify/cached-preview-gpu.mjs` for browser pixel parity (including
alpha, extrapolation, rounding, clipping and orientation), anchor texture reuse,
resizing, context loss/recovery and a 1080p/4K CPU/GPU comparison. It also runs
`Session` with real browser animation callbacks and confirms that 100 inputs
produce one draw on either backend, with queued drafts canceled on release. It requires
installed app dependencies and Chromium (`CHROMIUM=/path/to/chromium` overrides
the executable). Set `WEBKIT_MINIBROWSER=/path/to/MiniBrowser` to run in WebKitGTK
instead. Profiles are isolated under the ignored `verify/results/` directory
and removed after the run.

The comparison reports CPU interpolation plus Canvas 2D upload, WebGL command
submission, and WebGL completion forced by a test-only one-pixel readback.
These are synthetic costs, excluding anchor upload, native rendering,
histograms and full-app composition. Repeated draws must upload no textures.
Software-rendered browser timings do not establish hardware GPU performance;
use the app's GUI benchmark for final input-to-paint latency and frame pacing.
