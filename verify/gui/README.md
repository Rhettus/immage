# Visible-app GUI verification plan

The registry combines named workflows with generated control and module cases.
Use `--list` for the current matrix; declarations are not coverage passes. A run
covers only the cases it executes, with its recorded fixtures and environment.
Some scenarios require additional fixtures or native interactions outside this
suite. Follow local approval rules before each run and see `COVERAGE.md` for
limitations.

## Setup and execution (Linux)

Use Node.js 22 or newer, `flock`, a visible desktop, and a production Immage
binary built with `cd app && npx tauri build --no-bundle`. Plain `cargo build`
does not enable Tauri's production frontend configuration. Build the engine with
the normal project build instructions first. The runner does not build the app.

Install `tauri-driver` (`cargo install tauri-driver --version 2.1.0 --locked`)
and obtain a `WebKitWebDriver` matching the installed system WebKitGTK. On this
VM the matching driver was extracted from the distribution's WebKitGTK 6.0
package into `/tmp`; it drives the application's GTK3 webview through automation,
not a separate browser. No system package installation is required when an
extracted matching binary and its dependencies are available.

Copy `local.example.json` to ignored `local.json` and set the five absolute or
repository-relative paths. `binaryRevision` is an optional annotation, not proof
of the binary's identity: reports also record its SHA-256 and modification time.
Use the bundled sample JPEG or another suitable fixture. The source photo is
copied without its sidecar and never opened directly by the test app.

```sh
node verify/gui/run.mjs --config verify/gui/local.json --suite smoke
node verify/gui/run.mjs --config verify/gui/local.json --case startup
node verify/gui/run.mjs --config verify/gui/local.json --case exposure
node verify/gui/run.mjs --config verify/gui/local.json --case masks,panel-scroll
```

The `ai-mask-paste` case needs an installed
`build/ai-models/mask-object-sam21-small/` model. The runner copies it into the
isolated test profile before launch; it exercises real Select Object inference,
batch paste, Previous, undo/redo and saved-mask reopening. When using a development
engine, set `DT_ORT_LIBRARY` to its installed ONNX Runtime library if that library
is outside the engine's normal search path. The report records this selection.

Exposure includes startup as its prerequisite. A comma list runs several cases
in one launch, after startup. The runner launches a new driver and app, dismisses
the tour with Escape, and uses the app's supported file argument to open the copy.
XDG data/config/cache/state variables isolate the release app's storage and its
webview profile. A successful run also checks that `engine.log` was created in
that profile and verifies the original fixture's checksum. Any content security
policy violation the app logged to that profile's `webview.log` fails the run,
whatever its other outcome (`cspViolations` in the report). Use release binaries;
debug builds use shared development runtime paths and are blocked. Initially
only this checkout’s `app/src-tauri/target/release/immage` is accepted.

The smoke test measures the visible sharp canvas, waits for stable pixels and
its `data-render-quality="final"` marker, drags Exposure to approximately +1 and
-1 through pointer actions, compares brightness, and double-clicks the label to
reset. Reset must restore pixels within a mean difference of 1/255. It does not
use approved screenshot references yet; PNGs are diagnostic evidence.

Before launching on a tiling desktop, prepare an empty workspace and maximize
the test app so it gets sufficient space. Workspace switching and maximization
are outside the runner's app-only boundary; prepare them externally. Pass
`--viewport WIDTHxHEIGHT` when the run needs a particular logical viewport.
The runner waits for that size after launch and before its first test input, and
records the observed geometry. The runner leaves compositor configuration
untouched.

A kernel `flock` keyed by user and display serializes runs across worktrees.
Missing tools/display/config or a busy lock yield a blocked report and exit 1.
Failed assertions also exit 1. Signals clean up only the run's own process group;
reports and copied fixtures remain available. No automatic retries or reference
acceptance are provided.

## Local search and Find cases

Find exists only in the grid, as the right-hand column (`.find-pop` in `aside.right`,
`role="search"`). The toolbar's Find button enters the grid from any view, shows the
column, and focuses its box; pressing it again in the grid keeps Find open. Leaving the
grid (the rail's Library button) removes the column and brings the Adjustments panel
back, and filters stay on. There is no popup, no Show N, no grip, and no Escape or
click-away close. Find's rows are `.fr-row` (`.on` when active, `aria-expanded` when
open), with `.fr-x`, `.fr-editor`, `.find-clear` and `.find-active`.

`--case local-search` (or `--suite search`) checks filename search without an Immich
server or CLIP model: Search in offers This folder and All folders only, Filename mode,
the words typed and Enter pressed (there is no Search button). It waits for a cached
local result and thumbnail, rates only the disposable copy, retains a rating filter,
and returns to its folder.

`--case find-no-clip` (the `find` suite also runs it) checks the grid's Find column in
the isolated profile, which has no CLIP model: the Smart/Filename switch shown with
Smart unavailable (tooltip, no effect on click), the dimmed analysis indicator, the
file-name placeholder, narrowing by a file-name fragment, the CLIP tip (its Set up
button opens Preferences > General at the local photo cache card; dismissing hides it,
also after re-entering the grid), the head row's controls on one centre line, and no
Show more like this in the photo menu.

`--suite find` runs `find-live` (a filter narrows the grid as it is set; a filter row
turns on and its x turns it off; one editor is open at a time under its row; the Filters
title bar's reset icon (Clear search and filters) clears every filter and the search words, keeping Search in and the mode; the column is titled Find and, with auto-hide,
its pin ends the title row; the Library button enters and leaves the grid; the magnifier
opens the culling preview), `find-sizes` (Find only in the grid: no column in the
filmstrip view; the toolbar button enters the grid, shows Find in `aside.right` and
focuses the box; Adjustments hides while Find shows; Find is not a floating popup and has
no grip or Show N; from the Print panel the same button brings Find back; leaving the
grid removes Find and restores Adjustments), `find-saved` (Save filter…, changed and
Update, Alt+1 after Clear, Manage) and `find-no-clip`. The `filters` and `camera-body`
cases open Find's rows and their inline editors. Whether each case has passed live is
recorded in `suites.mjs` (`liveValidated`) and its verification note.

`--case find-panel-memory` exercises the bottom toolbar's view-specific toggles,
drags both panel splitters to different widths, and checks that switching views
preserves each panel's width and open or closed state. With auto-hide on, it
opens Find from the toolbar, moves into the panel, then checks that the panel
hides when the pointer leaves and returns when the pointer rests over the rail.

## Color calibration chart

Run `--case advanced-checker --fixture checker` to check the chart overlay and
corner dragging, then compute, apply, validate and undo the profile on a
synthetic 24-patch target.

## Positive hot-pixel fixture

Ordinary RAW photos may have no visible hot pixels. Generate an isolated,
sample-derived Bayer DNG with known defective sensor sites for the hot-pixel
Strength and Threshold rendered-effect contracts (requires ImageMagick):

```sh
python3 verify/gui/hotpixels-fixture.py --output verify/results/gui-fixtures/hotpixel-positive.dng
```

Set a local GUI config's fixture to that DNG. Its JSON companion records the
source and output checksums, defect locations, and sensor values. This fixture
validates the controls on deliberately introduced defects; it does not establish
that any particular camera photo contains hot pixels. The source is read only.

## What a run must exercise

Launch the actual Tauri app on a visible desktop, with its real engine and
platform webview. Use WebDriver pointer and keyboard actions to click, drag,
scroll and type into the rendered controls. Do not replace those interactions
with calls to Session, React handlers, DOM value assignments or engine commands.
DOM inspection is allowed for finding controls and observing results.

Every case combines interaction assertions with visible evidence: displayed
values, computed CSS, element bounds, hit targets and screenshots. Photo-editing
cases also check the rendered photo. A changed value alone does not prove the
photo rendered; a screenshot alone does not prove the control received input.

Linux is the first implementation target, using Tauri WebDriver and a matching
WebKitWebDriver. Windows follows using WebView2 and Edge WebDriver. Record exact
app, engine and webview versions. The bundled WebKit build currently disables
its WebDriver executable; establish a matching driver and automation-capable
app build before claiming packaged-WebKit coverage. A system-webview run must
identify itself as such. macOS automation is a separate follow-up, not assumed
to work through the Linux driver or through Docker on a Mac.

A visible desktop is required. Missing display or driver support is a blocked
run, not a pass. Runs are local and opt-in; CI integration remains a follow-up. Reference: https://v2.tauri.app/develop/tests/webdriver/

## Files and results

| Path | Purpose | Git |
|---|---|---|
| `verify/gui/README.md` | Shared design, then setup and run instructions | tracked |
| `verify/gui/AGENTS.md` | Instructions for any agent working on this suite | tracked |
| `verify/gui/run.mjs` | Initial command-line runner | tracked |
| `verify/gui/specs/` | Smoke, controls and module-preference scenarios | tracked |
| `verify/gui/support/` | App launch, observations, waits, evidence and desktop lock | tracked |
| `verify/gui/local.example.json` | Documented machine-settings template | tracked |
| `verify/gui/local.json` | Binary, driver, display and fixture paths | ignored |
| `AGENTS.local.md` | Personal agent instructions and machine notes | ignored |
| `verify/results/gui/<run-id>/` | Reports, screenshots, logs, copied fixtures and isolated state | ignored |
| `verify/references/gui/<environment>/` | Locally approved screenshot references | ignored |

Run IDs include UTC time, Git commit and a random suffix. Reports record dirty
working-tree status and the actual binary's identity; the checkout commit alone
must not imply that an older executable contains the current source.

Each run writes `report.json` and a readable `report.md`, plus per-case input
steps, before/after screenshots, expected/actual/diff images when applicable,
computed-style and geometry observations, browser logs, engine logs and timings.
Record OS, architecture, backend (Wayland/X11), display scale, viewport, theme,
fonts, renderer/GPU, webview version, fixture checksums and reference identity.
Keep a failed case's evidence even if cleanup or a later case also fails.

## App-only interaction boundary

Only the dedicated test Immage window's main webview may receive automation.
Use the run's own WebDriver session and verify app/window identity before input.
No global desktop input, switching apps, clipboard access, native dialogs,
file-manager actions or desktop screenshots. Opening the fixture uses Immage's
normal launch-file argument; all subsequent edits use the visible controls.
Only screenshots scoped to the test application window, webview or elements
are captured. DOM/CSS/canvas inspection is
read-only and may not call Tauri APIs or change application state. Local config
contains data paths and settings, not arbitrary scripts or shell commands.
A case needing broader UI access is blocked; it does not expand its permissions.

These rules govern the suite and agent behavior. They are not an OS sandbox
that removes the coding agent's other tools. Enforced process/filesystem/network
isolation would require a separately restricted execution environment.

## Isolation and multiple agents

Each run uses copied fixtures and a fresh app profile, preferences, localStorage,
XMP sidecars and output directory. Prove the profile-isolation mechanism on each
platform before enabling editing tests. Do not open originals or reuse a user's
running app. Keep updater checks and external-service work out of the scenarios.

Acquire an exclusive desktop/display lock before launching or sending input.
Record owner, process ID, machine, checkout and run ID. A second agent must wait
or choose an independent desktop; it must never steal the lock or kill another
agent's app. Recover a stale lock only after verifying its owner is gone. Distinct
worktrees alone do not isolate mouse focus. Ports and app state must also be
unique. Cleanup stops only processes started by that run and releases its lock.

Agents can implement separate cases concurrently in separate worktrees. Actual
GUI execution on the same desktop is serialized. A failure report must contain
enough information for another agent to reproduce it without conversation history.

## First scenarios

| Case | Actions | Required observations |
|---|---|---|
| Startup | Launch, open a copied fixture through the UI | Main window visible, photo rendered, no error dialog |
| Exposure | Open panel, drag both directions, release, reset | Thumb/value agree, photo brightness changes in the expected direction and returns within tolerance |
| Slider input | Focus, arrow keys, wheel where enabled, double-click reset | Correct value changes, visible focus, no unintended page scrolling |
| Panels | Expand/collapse, scroll, resize to minimum supported size | Controls visible and clickable, labels/value text not clipped, no unexpected overlap |
| Rail tools | Hover and click Presets, Crop and Adjustments | Correct tool opens, tooltip/hover style visible, button and SVG hit targets work |
| Undo/redo | Edit with a real slider, undo, redo | Value, thumb and rendered photo return to the expected states |
| Theme/scale | Repeat key controls in supported themes and scales | Track/thumb contrast, focus and popup placement remain usable |
| Mask adjustment | Create a simple mask through the UI, drag Exposure | Masked region changes, control remains usable, outside region stays within tolerance |

Start with startup and Exposure. Add the remaining cases after the runner proves
that it can drive and observe the full app. Extend coverage from the manifest to
all applicable sliders later, with explicit prerequisites and suitable fixtures;
controls hidden by module choices must not silently count as tested.

The Windows pointer-over-icon regression cannot be fully verified by this
app-only suite: webview screenshots do not establish native cursor stacking.
Test DOM hit-testing and computed cursor style here, and leave the native-cursor
observation to a manual check by the user. Do not capture the desktop.

## Stable checks and references

Find controls by accessible role and name, with narrowly scoped stable test IDs
where needed. Resolve element geometry at interaction time; avoid fixed screen
coordinates. Keep app semantics intact when adding accessibility/test hooks.

Wait for observable state: photo loaded, control value published, final render
completed, fonts loaded and layout settled. Use bounded waits with diagnostics;
do not use long fixed sleeps to hide races. Do not accept an in-flight drag draft
as the final image. Optional read-only readiness hooks must be documented and
must not bypass the control or alter rendering behavior.

Check computed properties and relationships (visibility, clipping, bounding-box
containment, hit-testing) before pixel comparisons. Use region-specific screenshot
comparisons with explicit tolerances and masks for genuinely dynamic content.
Keep references separate by OS/webview/theme/scale/renderer. Do not compare Linux
pixels to a Windows reference or automatically bless images from a failed run.
A named person/agent must inspect and explicitly accept new references, recording
that decision. Expected results and thresholds remain in the checked-in cases.

Distinguish pass, failure, blocked prerequisite and unsupported/skipped coverage.
Skipped or blocked required cases make the selected suite incomplete. Capture
all failing evidence; do not retry until green and discard the first failure.

## Implementation order and acceptance

1. Implement configuration validation, the app-only input boundary, isolated
   app state, desktop lock and cleanup. Validate a blocked run leaves the user's app and photos untouched.
2. Launch the visible app with its native driver. Implement startup and Exposure
   pointer drag/reset using a copied fixture and real engine rendering.
3. Produce the report and screenshots. Deliberately break a control's CSS or
   interaction in a disposable checkout and demonstrate a diagnostic failure.
4. Add slider input, panels, rail tools and undo/redo. Repeat a clean smoke run
   three times to identify instability; retain reports for every attempt.
5. Add mask editing, themes/scales and Windows. Document exact prerequisites and
   coverage gaps, including the manual native-pointer check and packaged webview matching.
6. Consider desktop CI and broader manifest coverage after local runs are stable.

Current smoke interface:

```sh
node verify/gui/run.mjs --config verify/gui/local.json --suite smoke
node verify/gui/run.mjs --config verify/gui/local.json --case exposure
```

The runner should default to a visible window and return nonzero for failures or
blocked required cases. Any future reference-accept operation must explicitly name
the source run and environment. Before calling the broader suite ready, have another agent follow the
checked-in guide without private conversation context and complete the remaining
scenario matrix. Do not infer full coverage from the initial smoke test.

## Verified scope

The initial smoke suite passed three consecutive visible runs on the ARM64
Wayland development VM using system WebKitGTK 2.54.2, and then passed with the
app alone on an empty workspace. Reports retain the earlier development failures.
A deliberately occupied desktop lock was verified to produce a blocked report
without launching another app. The boundary checks run separately with
`node --test verify/gui/support.test.mjs`; they supplement the visible tests.

The rail and reachable-slider cases are now implemented but await live
verification. Expanded panel/branch/mask cases await live validation. Windows automation,
approved reference baselines and deliberate application CSS fault-injection
validation remain outstanding. A smoke pass does not establish those capabilities or verify the
CI AppImage's bundled webview. On this VM GTK reported software rendering;
performance and GPU-renderer coverage are not established by these passes.

## Expanded control and regression cases

See [COVERAGE.md](COVERAGE.md) for commit-linked regression targets, verification
status and the complete control-area backlog. The generated [inventory.json](inventory.json)
contains expanded manifest declarations, including conditional/RAW-only controls;
it is an inventory, not a pass list. Regenerate using Node >= 22.18:

```sh
node verify/gui/inventory.mjs
node verify/gui/inventory.mjs --check
node verify/gui/run.mjs --list
```

These commands do not launch or interact with a GUI. After obtaining the approval
required by `AGENTS.local.md`, a single run may select:

```sh
node verify/gui/run.mjs --config verify/gui/local.json --suite regressions
node verify/gui/run.mjs --config verify/gui/local.json --suite controls
node verify/gui/run.mjs --config verify/gui/local.json --case module-options
```

Each command is a separate GUI run requiring its own approval. New cases are
implemented but await live validation. Build the production app again before
running: `data-panel-id` and `data-control-id` are read-only observation attributes
on manifest panels and range widgets. They never bypass UI interactions.
The range walker visits mounted sliders in available panels, records disabled
controls as blocked, and captures changes and reset frames. It does not reach
hidden tabs/sections/module branches or establish every slider's image effect.
Use `--failure-screenshots-only` for long control batches on a space-constrained
machine. Assertions, measurements, and action logs still run, and failed cases
retain their screenshots. Use the default capture mode for screenshot workflows.
Module-options exercises preference selection, not every engine implementation.
Diagnostic screenshots require review and are not approved visual baselines.

## Generated control prerequisites

Generated cases select the module that owns each control. Mask module defaults
apply to newly created masks, so module-specific local cases create a temporary
mask after selecting the default, then remove that mask and restore the prior
default. Ordinary range cases exercise pointer changes, keyboard limits and
steps, typed clamping, cancellation and reset.

Contrast Equalizer values are SVG graph points. Their per-band cases select the
channel, focus the point through its pointer action, use Home to restore its
neutral value, and check arrow-key adjustment and exact value/pixel restoration.
The point remains a separately reported case in both global and mask scope.

Choice cases restore their initial selection. Profile selection excludes the
Load/Delete command entries, whose flows belong to the dedicated AgX preset
case; it retains installed profile options. Cases explicitly open their required
tool before finding its panels, so a previous case can leave another tool open.

## Memory admission check

Before setup and again immediately before starting the driver/app, the Linux
runner reads `/proc/meminfo`. It requires at least **4 GiB MemAvailable** and
**no more than 50% swap used**. Swap is not counted as available RAM. A machine
without swap can qualify on RAM alone. Missing or inconsistent counters block
launch. Reports retain both snapshots, thresholds and any blocking reason;
blocked launches return exit 1. No configuration override lowers these limits.

This is a conservative preflight, not a guarantee against later memory growth.
The expanded slider run on 2026-11-01 was interrupted by systemd-oomd while
exercising Shadows; its final report could not be written. Keep its screenshots
and engine log as incomplete evidence. It is not a suite pass. Investigating
runtime memory growth and adding per-process monitoring remain follow-ups.
Do not stop unrelated apps, drop caches or change swap automatically to qualify.
Check resources before workspace preparation where practical; every actual GUI
run still requires approval, an empty workspace and restoration afterward per
local instructions.

The read-only check can be exercised without launching any GUI:

```sh
node verify/gui/memory.test.mjs
node --input-type=module -e 'import { availableMemory } from "./verify/gui/support/memory.mjs"; console.log(await availableMemory())'
```

## Expanded selections and fixtures

List cases without starting an app with `node verify/gui/run.mjs --list`.
Suites are `smoke`, `controls`, `regressions`, `crop`, `workflows`, `search`, `find`, and `inventory`.
`--suite all` selects every declaration, but mixes incompatible prerequisites;
it excludes the standalone `startup-restore` and `dng-thumbnail` cases and is
not a turnkey full-coverage run. Prefer one case and its required fixture:

```sh
# GUI commands: obtain fresh approval for each command first.
node verify/gui/run.mjs --config verify/gui/local.json --case crop-portrait --fixture portrait
node verify/gui/run.mjs --config verify/gui/local.json --case histogram-endpoints --fixture endpoints
node verify/gui/run.mjs --config verify/gui/local.json --case negative --fixture negative
```

The default `configured` fixture copies the configured photo. Synthetic choices
are `landscape`, `portrait`, `endpoints`, `negative`, `camera-a`, `camera-b`, `hostile` (markup in the file name and metadata, for `hostile-text`), and
`camera-missing`; the runner generates TIFFs inside its own results directory
using Python 3's standard library. These do not replace RAW, overlapping panorama,
slow-folder or isolated service fixtures. Missing prerequisites block the case.

## Durable evidence and memory diagnostics

The runner fsyncs `events.jsonl` and atomically checkpoints `report.json` before
launch and during cases. Abrupt termination may prevent the final Markdown
report; surviving screenshots do not prove case success. Inspect a run offline:

```sh
node verify/gui/recover.mjs verify/results/gui/RUN_ID
```

Every two seconds, memory events sample the owned driver/app descendants and
system pressure, with the current case. RSS totals can double-count shared pages;
PSS is recorded when available. Short-lived children may be missed. The sampler
checks the root process start identity to avoid attributing a reused PID.
The runner attempts to stop its own tree if available RAM drops below 1 GiB or
swap use exceeds 85%. This is best effort and cannot guarantee OOM prevention
or identify a crash cause. Admission still requires 4 GiB / at most 50% swap.

## Offline screenshot comparison

Evidence PNGs have adjacent JSON environment metadata. Review an app screenshot
and obtain explicit authorization before accepting a reference:

```sh
node verify/gui/visual.mjs accept --source verify/results/gui/RUN_ID/CASE/IMAGE.png --destination verify/references/gui/ENV/IMAGE.png --reviewer NAME
node verify/gui/visual.mjs compare --reference verify/references/gui/ENV/IMAGE.png --actual verify/results/gui/RUN_ID/CASE/IMAGE.png
```

Use actual evidence paths from the run. These commands do not launch a GUI.
Acceptance refuses overwrite. Comparison requires matching environment metadata
and an approved reference; its policy defines channel tolerance, changed-pixel
fraction, optional region and exclusion rectangles. It writes a diff PNG and
JSON summary next to the actual image. No references have been accepted yet.
Synthetic pixel tests prove the comparator detects a moved region; they do not
prove the suite detects a CSS regression in the real application.

## Non-GUI checks

```sh
node verify/gui/infrastructure.test.mjs
node verify/gui/memory.test.mjs
node verify/gui/support.test.mjs
node verify/gui/benchmark.test.mjs
python3 verify/gui/fixtures.test.py
node verify/gui/inventory.mjs --check
cd app && npm run build
```

These checks do not approve or replace a visible-app run. Rebuild the native
production executable before a future approved run using the new observations.

## Batch settings paste

`--case batch-paste` and `--case shift-range` (both in `--suite regressions`) require a JPEG fixture.
`--case jpeg-preset` also needs a JPEG fixture; the runner copies it to `preset-jpeg-1.jpg` and `preset-jpeg-2.jpg`.
`--case space-pan` needs a photo larger than the viewer at 2:1.
Before launch the runner makes three more copies in its own fixture directory:
two targets and one unselected control. The case applies Kodak Gold 200 at 35%,
copies Tone and Look through Copy Settings, selects two targets with a guarded
modifier click, and exercises Paste, whole-batch Undo and Redo. It checks the
selection/active photo, Exposure, look/amount, rendered pixels and both saved
sidecars, then reopens the second target and the unselected photo. Inspection
is read-only and limited to the app and this run's fixture sidecars. No system
clipboard or native dialog is used. This case is written, not live-validated.

## Moving photos by drag

`--case move-photos,move-copy` works with any fixture. Before launch the runner
lays out the run's own fixture folder: `move-a`, `move-b` and `move-c` as copies
of the fixture, `dest/inner/` to drop into, and `clash/` with an identical
`move-c` and a `move-b` that has one byte more. `move-photos` covers the
following:

- spring-opening a shut folder under the drag
- Esc during a drag
- a refused drop on the photos' own folder
- Cancel in the confirmation
- a move into `dest/inner`, after which it checks the moved file's SHA-256,
  the rated sidecar, and that no part files remain

`move-copy` drops two selected photos with Alt held. It checks the copy
confirmation (identical and clashing photos), uses Keep both for all, and
checks the numbered copy. Everything stays inside the run's fixture folder.
The confirmation is drawn by the app, so no native dialog is involved.

### Move options

Three further cases cover the confirmation's newer options. They passed live
on Linux on 2026-11-24 (`move-companions,move-subfolders` in one launch,
`move-menu-items` alone). They need no `--fixture`; the runner builds its own
files beside the fixture:

- `move-companions` copies a RAW from `benchmarking/corpus/` (three `pair-*`
  copies, each with a same-named JPEG from `app/sample/`), seeds
  `immage.stackPairs` in the isolated profile's `settings.json` and sets the
  File type filter to All RAW through Find. The confirmation's "Include the
  stacked JPEG, HEIF or ORI file" box must be unticked and only the raw and its
  sidecar arrive; ticking it plans again and both arrive; without the filter it
  is ticked. The case is blocked when the corpus has no RAW.
- `move-subfolders` drops a JPEG with an injected Exif capture date (2021-03-14)
  with Alt held, ticks "Sort into subfolders", checks the default pattern,
  hint and "Into 1 folder: 2021/03/14" example, types a pattern (Confirm should
  be disabled during the 400 ms debounce; a miss is recorded, not failed), then
  copies and checks the file and rated sidecar in `sort-dest/2021/03/14`.
- `move-menu-items` checks that Move to Folder... and Copy to Folder... are in
  the photo right-click menu and the Photo menu. It never clicks them: they
  open a native folder picker, outside the app-only boundary, so the picker
  flow stays a manual check. Run it after the drag cases or in its own launch.

## Export subfolders

`--case export-subfolders` passed live on Linux on 2026-11-24 and needs no `--fixture`. The runner copies two JPEGs
with injected Exif capture dates (2021-03-14 and 2022-11-05) beside the default
fixture, which has no capture date, and seeds the export destination
(`export-dest/` in the run's fixture folder) into the isolated profile's saved
export settings with "If a file exists" set to a unique name, so the native
folder chooser is never operated. The case opens Export, ticks "Inside a new
folder", types `{year}/{month}/{day}`, checks the "First photo" example, exports
every shown photo and checks on disk that the dated photos are in
`YYYY/MM/DD/` folders (the fixture, which has no Exif date, gets the file's own
date from the library) with no date folder outside the destination. It then
exports with `{year}/{camera}/{month}`, where no photo has a camera model, and
checks that the empty part is dropped, and finally with the plain name `Export`,
checking that every photo lands in `export-dest/Export/`.

## Renaming photos in the Library grid

`--case rename-photos` uses three disposable copies of the launch fixture. It
checks that an existing filename blocks confirmation, then renames one photo
and checks its bytes and XMP rating. It selects two photos, checks the photo
count and one filename example, checks that selection follows the new
names, and finds one renamed photo by its new filename.

## Recent library and culling workflows

The focused cases added for the 0.46.0 library changes are `move-photos`,
`move-copy`, `photo-filter`, `dng-thumbnail`, `startup-restore`, and
`grid-culling`, and `library-workers`. They use copied fixtures and an isolated profile. The DNG case
generates an unsupported main-image compression with an embedded TIFF preview;
the photo-filter case adds non-photo decoys beside the copied image; the
startup-restore case seeds only the test profile with a saved folder and photo
and launches without a file argument. `grid-culling` creates three extra photo
copies and drives fitted and full-resolution previews, navigation, Space-drag
panning, rating/reject/label shortcuts, keyword selection and Recent keywords,
the selected-photo context action, and double-click editing through actual
WebDriver input. Its context-menu selection subcheck is recorded as a failure:
WebKitWebDriver right-clicks a selected tile, but the app opens keywording for
one photo. The report records the target and selection before and after the
secondary click; manual confirmation is needed to separate app behavior from
the system WebKit driver. `library-workers` checks the 2-worker default, saves
6→2→6, then the following move-copy case passes with six workers selected.
The headless DNG verifier covers all EXIF orientations and edited-photo
behavior; the GUI DNG case verifies the visible fallback thumbnail only.

`edited-culling-preview` checks the render-ahead of an edited RAW's culling
preview. The feature is RAW-only, so the runner ignores the configured fixture
and copies a RAW from the local `benchmarking/corpus/` (`P6060404.ORF`, else any
ORF/ARW/CR2/RW2; the case is blocked when there is none) as `ecp-a` and `ecp-b`,
launching with `ecp-a`. The case opens culling once (which stores the preview
size), edits `ecp-a`'s Exposure in the editor, moves to `ecp-b`, and polls this
run's `cache/app.immage/thumbs` folder, read from the Node runner, for a new
`edit-` file (up to 30 s). It then culls `ecp-a` from the grid and requires a
non-blank preview within 3 s and no further `edit-` file. Last it edits `ecp-b`,
presses G before the autosave (the photo stays open behind the grid), and
requires `ecp-b`'s `edit-` file and the same quick cull. Timings are recorded.
It runs alone, after startup, and is left out of `all`:
`node verify/gui/run.mjs --config verify/gui/local.json --case edited-culling-preview`.

`morfphoto-mirror` checks the local copy of the morfPhoto catalog against an
in-process fake server (loopback, bearer key `gui-mirror-key`, every request
logged). It needs `/mnt/mac` to be a 9p mount (the host share stands in for the
network share) and otherwise reports Blocked. The runner makes
`/mnt/mac/.immage-gui-test-<run id>/photos/` (three copies of the fixture at the
root, two in `2024/`) and a plain local twin beside the run's fixtures, seeds
both as library folders, and removes that whole scratch tree afterwards, on
failure and on signals (only a path under that prefix is ever removed). It also
starts its own `dbus-daemon --session` on a socket in a private temp folder and
`gnome-keyring-daemon --foreground --components=secrets --unlock` (empty password
on stdin) as its own children, and hands the app only that
`DBUS_SESSION_BUS_ADDRESS`, so saving the API key never reaches the user's
keyring; either daemon failing to start makes the case Blocked. The case waits
for the 60 s sync tick twice, so allow about five minutes. It runs alone, after
startup, and is left out of `all`:
`node verify/gui/run.mjs --config verify/gui/local.json --case morfphoto-mirror`.

For a floating Hyprland test window, maximize each newly opened ws9 app window
only when its client is not already maximized. The maximize dispatch is a
toggle; do not send it repeatedly to an already maximized window. Confirm the
window geometry before interacting. The automation wrapper should restore the
original workspace and ws9 layout on exit.

`grid-zoom` remains a separate case: Ctrl+- easing is covered, while Ctrl+wheel
is blocked by WebKitWebDriver dropping the modifier from its wheel action. Do
not count that skipped half as GUI coverage.

## Folder menu

`--case folder-menu` works with any fixture and needs no layout. It
right-clicks the fixture's row in Folders and checks the three items. It
creates `Picks` in the run's fixture folder and `Picks/Inner` inside it,
checks both on disk, has a second `Picks` refused, and removes `Inner` from
the list while it stays on disk. Show in the file manager is checked as
offered only: clicking it would open another application. The case
right-clicks, so run it after any drag case or in a launch of its own.

## Scaling benchmark collection

The generic case has approved Linux ARM64 VM passes at DPR 1 and 2, and both
fractional draft variants passed at 125%:

```sh
# Obtain fresh approval for each GUI run first.
node verify/gui/run.mjs --config verify/gui/local.json --case gui-benchmark
node verify/gui/run.mjs --config verify/gui/local.json --case gui-benchmark-screen
node verify/gui/run.mjs --config verify/gui/local.json --case gui-benchmark-whole
```

Each includes startup, opens Preferences → Performance, tabs to GUI benchmark →
Run and presses Enter. The app runs its own existing scripted workload. This is not a test of
WebDriver drag latency. `gui-benchmark` uses the fresh profile's defaults;
the other cases set **Drag drafts at the screen's scale** on or off through
its real checkbox with keyboard focus/Space. They block if that option is absent, including at integer
scales. No case changes compositor settings. Prepare output scale separately.

Use `--viewport WIDTHxHEIGHT` to require an exact logical inner window size
after startup and before subsequent cases, for example `--viewport 1979x1171`. This is a read-only
gate with a 30-second timeout, not a resize command. External authorized setup
must size only the dedicated test app. The runner records the requirement and
blocks the measurement if it is not reached; display/compositor changes and
restoration stay outside the runner.
Startup completes the tour and first photo before external sizing begins.
On a preparation failure, the runner retains a DOM/geometry observation and
app screenshot only if the previously verified main URL and handle still match.
The deferred gate passed at DPR 1 in run
`2026-11-02T15-20-43.128Z_ee28973_46f49c76` at 1979x1171 logical pixels.
An earlier attempt to size before startup completed failed; keep its report
`2026-11-02T15-16-10.106Z_ee28973_860de160` as preparation failure evidence.

The runner waits up to ten minutes for the app's saved-report status or error,
copies the report only from its own profile's benchmark folder into the case's
`benchmark.json`, and validates schema, nonempty phases, frame dimensions and
timings, unchanged before/after viewport/DPR and recorded visibility. It checks
that final fit pixels return to baseline. Raw reports survive validation failure.
For fractional cases it also verifies the recorded setting and effective draft
scale. It does not establish that viewport geometry stayed fixed between endpoint
observations. Keep the window unchanged throughout each run.

Use `python3 -I benchmarking/diagnose.py PATH/benchmark.json` for offline
analysis. Compare like configurations and logical viewport dimensions across
display scales, separating native pipeline costs, drag frames and release
frames. See [the investigation procedure](../../app/docs/dev/performance-tracing.md#wayland-fractional-scale-investigation).
VM results are approximate comparisons within that VM; shared host resources,
software rendering and virtual display timing prevent predicting native GPU or
NVIDIA performance. Animation callbacks do not measure compositor presentation.

Two approved collection attempts on the ARM64 VM passed startup but could not
reach Run using repeated WebDriver wheel input; the scroll position remained
at 180 pixels. No benchmark ran in either attempt. Keyboard navigation replaces
that path and passed in run `2026-11-02T15-05-22.535Z_ee28973_5104c5ed`
on Linux ARM64, Wayland DPR 2, system WebKitGTK 2.54.2. The run retained 805
samples and restored the photo pixels. Retain both failed reports; neither
is a performance measurement or proof of a user-facing scrolling defect.

The screen-scale case passed at 125% in run
`2026-11-02T15-34-27.864Z_ee28973_66140df8`, with DPR 2 and draftScale 0.625.
Its 1979x1171 logical viewport matched the integer baselines. External setup
used supported 3840x2160@60 because the earlier custom mode did not accept
125%; therefore absolute timings are not a controlled comparison against the
integer runs' display mode. A drafts-off comparison must keep the same
fractional output mode, refresh rate and floating test-window setup.
The drafts-off counterpart passed in run
`2026-11-02T15-40-01.172Z_ee28973_e7cc09e0` with the same supported output
mode/rate and logical app size. It confirmed screenScale false and draftScale 1.
These are one VM run per configuration, not repeatability or native-GPU evidence.

## Demo clip

The `demo` case records the announcement clip: a scripted tour of the layout
(auto-hide with a pinned right column, focus mode), Basic sliders, masks, the
contrast equalizer, panorama and HDR merge, presets, Film Simulation, the Zone
System and Print. It is evidence capture, not a feature check: it asserts
nothing, and a segment it cannot reach is recorded as skipped.

```sh
DEMO_PHOTOS=benchmarking/corpus/a.ARW,benchmarking/corpus/b.ARW \
DEMO_SEGMENTS=sliders,masks \
node verify/gui/run.mjs --config verify/gui/local.json --case demo
node verify/gui/demo-assemble.mjs verify/results/gui/demo
```

`support/recorder.mjs` takes webview screenshots through the run's WebDriver
session and logs the scripted pointer's path; nothing is injected into the page
and no desktop capture is used. `demo-assemble.mjs` runs afterwards with ffmpeg:
it draws a cursor and a click ring from the log, adds each segment's caption and
writes `immage-demo.mp4` (`--width`, `--fps`). Setup a viewer would not enjoy (Preferences, module
choices) runs with recording paused and is cut. `DEMO_PHOTOS` copies extra
photos into the fixture folder for the merge segment; `DEMO_SEGMENTS` retakes
only the named segments (`layout`, `focus`, `sliders`, `masks`, `equalizer`,
`merge`, `presets`, `film`, `zones`, `print`). Output goes to the ignored
`verify/results/gui/demo/`. The Film segment needs the spektrafilm data pack and
Print needs no profile for the tour. Like every GUI run, it needs approval and
the workspace and memory preparation above.

## AgX preset import

`node verify/gui/run.mjs --config verify/gui/local.json --case agx-presets`
runs the visible Profile > Load AgX Preset workflow on the copied photo. Before
launch, `support/agx-fixture.py` generates an AgX v8 user preset and two rows
that must be excluded (a builtin and a different module) in the run's isolated
darktable `data.db`. It never reads or changes the user's darktable database.

The case checks checkbox/Add enablement, cancel without changing the photo,
import and visible rendering, duplicate names, switching to a builtin and back,
the action spacer and labels, user-only deletion without changing the photo,
and the saved menu entries and photo after restarting only the test app with
the same isolated profile. Restart waits for the previous test app's engine and webview processes to exit,
performs fresh memory admission checks, and requires the original viewport to be
restored before comparing pixels. Maximize each restarted window too.
Evidence stays in the usual run directory. The case **passed** on Linux ARM64,
system WebKitGTK 2.54.2, Wayland DPR 2, maximized 1276x660 viewport, with the
sample JPEG: run `2026-11-08T23-06-46.100Z_3890fc3_2fe8198f`. Startup and Exposure
also passed in that run. It covers refresh, cancel deletion and deletion of the
last preset. Earlier failed runs are retained; the final run includes the
viewport/restart cleanup and Exposure scrolling fixes. Use a release app and
engine built from this change.
Native `.dtpreset`/`.dtstyle` chooser interaction remains a manual check;
`verify/agx-presets.py` checks file decoding headlessly.

The default-replacement extension also passed in run
`2026-11-08T23-16-29.185Z_3c1857f_6d3f975a` (Linux ARM64/system-WebKit, maximized 1596x840 at DPR 2).
Through Preferences, the test makes an imported preset the new-raw default,
checks that deletion requires an explicit surviving replacement, verifies that
cancel leaves the old default intact, and verifies the chosen replacement after
restart. Deleting the last user preset explicitly selects AgX Default.

## Running the whole registry

A full clean run is many launches, not one. Cases that leave app state behind
need their own launch or an ordering rule; a case that fails only after
another case in the same launch is an ordering effect, so rerun it alone:

- `menus` makes a virtual copy and leaves it open, so run it last or alone
  (`color-range` restarts the app on the original file and then finds no mask).
- `negative` and `negative-profile-memory` each leave the negative photo
  converted, so whichever runs second in a launch fails: give them a launch each.
- `panel-scroll` needs a launch of its own (it asserts Presets opens at its
  top the first time); `native-reset` must not follow `module-options`, which
  leaves another Contrast backend selected.
- `splash` asserts the window keeps its 640x427 size, which a maximized test
  window on a tiling desktop does not; run it on a floating window.
- Fixture groups: the default JPEG; `--fixture portrait|negative|endpoints|camera-a|hostile`
  for `crop-portrait`, `negative`/`color-profiles`/`negative-profile-memory`,
  `histogram-endpoints`, `camera-body` and `hostile-text`; a raw as the config's
  `fixture` for `control-detail-*`, `control-lens-hp_enable`, `crop-auto-straighten`,
  `lens-pick` and `lens-profile`; the hot-pixel DNG for `control-lens-hp_strength`
  and `control-lens-hp_threshold`.
- Each launch writes about 8 MB per case; clear `fixtures/` and `profile/cache`
  of finished runs when disk is short.
