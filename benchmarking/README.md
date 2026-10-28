# Immage benchmarks

A repeatable performance suite for Immage: the darktable engine driven
headless the way the app drives it, plus a GUI benchmark run inside the app.
Every run is recorded under `results/`, so the next run shows what got
faster or slower. Runs, SUMMARY.md, the dashboard's data and `corpus.json`
are your machine's own and stay out of git: a fresh clone starts with none.

| file | what it is |
|---|---|
| SUMMARY.md | the latest numbers, and the change since the last run over the same photos (generated, gitignored) |
| [dashboard/index.html](dashboard/index.html) | interactive dashboard; open the file in a browser, no network needed |
| `bench.py` | the engine benchmark |
| `report.py` | rewrites SUMMARY.md and `dashboard/data.js` from every recorded run |
| `compare.py` | two runs side by side, as markdown |
| `lib/edits.mjs` | Immage's control-to-module mapping (`app/src/manifest.ts`), for the benchmark |
| `corpus/` | your photos, and `corpus.json`, the list of what the last full run used (both gitignored) |
| `results/` | one folder per run, `results/gui/` for the app's GUI reports (gitignored) |
| `awb.py`, `awb-neutral.json` | Auto white balance against neutral patches in the corpus; not a timing benchmark |
| `autoexp.py` | Basic's Auto over the corpus, old and new side by side; not a timing benchmark |

## Running it

```bash
cmake --build build                          # the engine under test: build/bin/darktable-engine
python3 -I benchmarking/bench.py             # about an hour over 11 photos, CPU then OpenCL
python3 -I benchmarking/report.py            # SUMMARY.md + dashboard data
python3 -I benchmarking/compare.py           # optional: the latest run against the previous one
```

`bench.py` needs only Python 3 and Node (for `lib/edits.mjs`). Useful options:

- `--all` runs every photo in the corpus. By default it takes the largest and
  smallest file of each format: the most and fewest megapixels each camera brings.
- `--opencl off|on|both` (default both) and `--repeat N` (samples per step, default 7)
- `--only sliders,roi,heavy,heavydrag,longdrag,draftpipe,zoom,preview,modules,export,masks` runs some scenarios only
- `--images name1,name2` runs only photos whose names contain these
- `--note "..."` is kept with the run and shown in the dashboard

Put the machine's setup in `--note`, for example `--note "external fan"`:
a fanless laptop without one may throttle, and runs only compare when
the conditions match. Keep the machine otherwise idle while it runs. A build, or the app rendering,
skews the timings of a run that is going on at the same time.

The photos are copied, contents only, into `build/bench-work/` before the
engine sees them, a fresh copy for each mode. The engine writes XMP sidecars
next to what it opens, so it never touches the corpus itself, and every
mode starts from unedited photos.

### The GUI benchmark

The engine benchmark cannot see the app's own costs: IPC, drawing, the
histogram, React. For those:

1. `npm run tauri dev` in `app/` and open a photo. Use a copy: every slider is
   put back, but the photo's history gets the moves.
2. Preferences → Performance → Measuring → **Performance overlay** shows live
   timings over the photo.
3. **GUI benchmark → Run** drags 16 main sliders out and back at about 60
   moves a second, through the same code a hand would, then releases each
   one. It zooms to 100% and back, drags Exposure once the base after that
   has started (which cancels it: "drag during base"), and waits for the
   idle base render.
4. The report is written to `results/gui/gui-<time>.json` in a dev build
   (in the app's data folder `benchmarks/` in a bundled one). Run
   `report.py` to bring it into SUMMARY.md and the dashboard.

## What each scenario measures

All engine timings are wall time of the request, as the app waits for it.
The `-d perf` per-module times come from darktable's own instrumentation
(`src/develop/pixelpipe_hb.c`). The viewer is 2560×1600, the app's
`MAX_PREVIEW`, with drafts at half that (the app's `DRAFT`) and the idle
base at 3072 (`baseSize`).

| scenario | steps |
|---|---|
| `open` | open the photo, apply what a new photo gets (AgX), and the first frame; an unchanged re-render (pipe cache hit) |
| `sliders` | for each of 21 controls, set + render at full size and as a drag draft (without grain, diffuse and sharpen unless the control is theirs, as the app drags); each sample is a new value, as in a real drag |
| `roi` | one drag cycle: draft, full frame on release, the idle 3072 px base, the next edit's full frame, and an unchanged repeat |
| `heavy` | Grain, Texture, Sharpening and luminance denoise on, then an Exposure drag cycle: the draft (also as the Performance preview's, at quarter size without denoise and HSL), the release, and the idle 3072 px base as today, without grain, and without grain or diffuse |
| `heavydrag` | The heavy edit on, then a 12-frame drag of Temp, Exposure, Highlights, Clarity, Vibrance and Vignette, early to late in the pipe, on the drag pipe without grain, diffuse or sharpening; the draft frames after each drag's first. Shows whether the modules before the dragged one stay cached, which on the GPU needs the dragged module marked as last edited |
| `longdrag` | for Highlights and Exposure, the release after a 40-frame drag on the drag pipe (as the app drags), the same drag with its frames on the main pipe (as before 0.20, when the release reran from the raw), and a 4-frame drag; 3 drags each |
| `draftpipe` | the draft pipe prototype (`render` with `"draft": true`): drags at draft size on today's main pipe against the small-mip draft pipe, the first draft after a full frame, and how different the two frames look. Skipped by an engine without it, which today is every engine: the prototype measured slower and was removed |
| `zoom` | 100% at the centre, 4 pans, an exposure edit at 100%, and back to fit |
| `preview` | the second pipe: preset tiles (160 px) and the hover preview (1600 px) |
| `modules` | each of Immage's module choices against darktable alternatives for the same job, with the pipe cache off so every repeat runs the module; its own time per frame and Mpx/s |
| `export` | a full-size JPEG at quality 90 |
| `prefetch` | opening a copy of the photo no engine has opened, cold and with its raw decoded ahead (`prefetch`, 2 s before), as the arrow keys' next photo is; after the engine's first open, which carries its start-up work |
| `masks` | 1, 5 and 10 masks (an ellipse, a gradient or a 120-point brush stroke each), each with its own Exposure and Contrast and every other one Saturation, built as the app's `Session` sends them two ways (`MaskModel` in `bench.py`): `chain`, an instance per mask and module, and `shared`, color balance rgb on instances the masks share (`app/src/localMerge.ts`), with the dragged mask lifted out onto its own instances until the release. For each: a local Contrast drag on the oldest and on the newest mask (drafts, then the release), a global Exposure drag under them, the newest shape moved, and how far the two models' frames are apart. `recomputed` shows how much of the chain each frame reran |
| `overhead` | the same edit loop with and without `-d perf`, per mode |

Things the engine benchmark does not do, deliberately or not yet:

- No new-photos preset: it depends on Preferences.
- No AI masks, AI features or looks; masks are drawn shapes only.
- Alternative modules run at darktable's defaults, so they are compared on
  cost, not on how they look.

## Auto white balance

`python3 -I benchmarking/awb.py` scores white balance over the corpus, in
about three minutes. Each photo listed in `awb-neutral.json` has a box over
something neutral, and a method's error is how far that box's linear color
sits from gray, in degrees: under about 2 is hard to see. Every photo also
records how far each method moved Temp/Tint from as shot, which shows a
sunset or a field of green being pulled toward gray.

It compares as shot, the app's Auto (`app_auto`, through the app's own
`wb.ts`), the gray world Auto it replaced (`old_auto`), and estimators run
on a linear frame (`--methods`) or on the display frame (`--display`).
`--tune` scores the anchored blend's settings. PNGs of each result land in
`build/awb-work/out/` unless `--no-png`.

Every corpus photo was shot on the camera's auto white balance, so the
corpus cannot show how Auto does when the camera was set wrong
(`app_auto_free` is the closest it gets). Photos with a gray card or a known
white under tungsten, fluorescent or mixed light would.

## Auto exposure

`python3 -I benchmarking/autoexp.py` runs Basic's Auto (Exposure, AgX's
range, then Contrast, Highlights, Shadows, Whites and Blacks) over the
corpus as the app runs it, through the app's own `autoTone.ts` (`app`),
beside the Auto it replaced (`old`), which judged exposure by the mean
alone. Nothing says what the right exposure is, so it prints each photo's
key and its 5th and 99th percentiles at the tone mapper's input, in EV from
middle gray, with the exposure each method set and the result's mean
display luminance. PNGs as opened and after each method land in
`build/autoexp-work/out/` unless `--no-png`; look at them side by side.

The corpus has night and low-key photos (`P1020037`, `P1020437`,
`P6060404`, `P9302109`, `P9302168`, `P9302182`) and bright ones (`IMG_2586`,
`IMG_2588`, `IMG_2589`), but no snow. Some JPEGs have no RGB image at the
tone mapper's input, so Auto fails on them in the app too; they are skipped.

## The result format

`results/<date>_<git sha>_<host>/run.json`:

```text
env      machine, OS, git sha/branch/dirty, build type, view sizes, repeat, scenarios,
         OpenCL device report and the modules that ran on the GPU
corpus   [{name, sha256, mb, sensor: [w, h], raw}]
records  one per mode x photo x scenario x step:
         {mode, image, scenario, step,
          wall_ms / process_ms / write_ms / set_ms / recomputed: {p50, p95, min, max, n},
          modules_ms: {module: median ms}, gpu_modules, tiled_modules,
          control, size (sliders); job, candidate, immage, own_ms, mpix_per_s (modules)}
```

`compare.py` keys records by (mode, photo, scenario, step). A step counts as
changed when its median moves by more than 10% and 2 ms. For `modules` it
judges the module's own time, for everything else the request's wall time.
It compares a run only with earlier runs over the same photos (matched by
sha256).

GUI reports (`results/gui/gui-*.json`) hold every frame: its kind (edit,
view, base), size, moves carried, total input-to-paint ms, and the stage
times from `app/src/perf.ts`. The stages are queue, set, lock, pipeline,
write, read, probe, ipc, handoff, draw, histogram and paint. Each report also
carries a per-step summary. From 0.25.0 a report's `transport` says how
frames reached the page: `invoke` (in `render`'s reply) or `shared` (a
WebView2 shared buffer, Windows only). With `shared`, ipc also covers
posting the frame and the page's copy out of the buffer. From 0.32.0 a
report's `machine` names the computer it ran on: host, OS, CPU, cores,
memory, and `id`, a hash of the system's own machine id (macOS
IOPlatformUUID, Windows MachineGuid, Linux /etc/machine-id). Engine runs
carry the same hash as `env.machine_id`. The dashboard's GUI tab can
pick one machine's reports. Each system has its own machine id, so a
computer that boots Windows and two Linux distributions shows as three
machines.

From 0.35.0 (report version 3), `machine.opencl` lists darktable's OpenCL
devices and whether OpenCL is running, `machine.display` holds the
session type (`wayland` or `x11`), the desktop, and the GDK, WebKit, EGL and
NVIDIA environment variables the app ran with, and `machine.webview` the
web view's own version (WebKitGTK, WebView2 or WKWebView; the user agent's
is frozen). `webview` holds the user agent, the GPU WebGL reports (the
card, or a software renderer such as llvmpipe, which means the page is
drawn without the GPU) and `frameRateHz`, how often the page ran
animation frames while idle before the run: the display's refresh rate,
or less where WebKit throttles them (macOS halves them in Low Power
Mode). It bounds the paint stage.

From 0.37.0 (report version 4), `invokeMs` times the round trip of a
call that does nothing (`perf_ping`): `idle`, 100 in a row while the page
is idle before the run, and `drag`, one every 50 ms during the slider
drags, beside the renders. Each has n, p50, p95, min and max in ms. Slow
`idle` means the web view's IPC itself is slow; slow `drag` alone means
the page's drawing holds it up.

## For the next session (Claude included)

1. Read SUMMARY.md: the latest state.
2. Run the suite on the same commit as before if the machine changed, then on
   the new one. `compare.py` with no arguments shows the change.
3. Add a scenario by adding a block to `run_image()` in `bench.py`, recorded
   with `rec.add(mode, photo, scenario, step, samples)`. Add a module
   comparison by adding a group to `ALTERNATIVES`. Add a control to `CONTROLS`
   with its drag distance.
4. SUMMARY.md is regenerated; keep conclusions in your own notes.
