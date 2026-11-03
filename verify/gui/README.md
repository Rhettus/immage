# Visible-app GUI verification plan

Status: startup/Exposure and slider-input have previous Linux live passes.
The expanded registry contains 544 named cases, including generated control and
module variants. New cases are written but have not run; declarations are not
coverage passes. Some scenarios block on unsupported fixtures or native dialogs.
See `COVERAGE.md` for limitations. Real GUI execution is currently paused by
local instructions; non-GUI development and checks may continue.

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

Exposure includes startup as its prerequisite. A comma list runs several cases
in one launch, after startup. The runner launches a new driver
and app, dismisses the tour through
its Skip button, and uses the app's supported file argument to open the copy.
XDG data/config/cache/state variables isolate the release app's storage and its
webview profile. A successful run also checks that `engine.log` was created in
that profile and verifies the original fixture's checksum. Use release binaries;
debug builds use shared development runtime paths and are blocked. Initially
only this checkout’s `app/src-tauri/target/release/immage` is accepted.

The smoke test measures the visible sharp canvas, waits for stable pixels and
its `data-render-quality="final"` marker, drags Exposure to approximately +1 and
-1 through pointer actions, compares brightness, and double-clicks the label to
reset. Reset must restore pixels within a mean difference of 1/255. It does not
use approved screenshot references yet; PNGs are diagnostic evidence.

Before launching on a tiling desktop, prepare an empty workspace so the app
gets sufficient space. Workspace switching is outside the runner's app-only
boundary; prepare it manually or authorize that one-time desktop action.
The runner leaves the compositor configuration untouched.

A kernel `flock` keyed by user and display serializes runs across worktrees.
Missing tools/display/config or a busy lock yield a blocked report and exit 1.
Failed assertions also exit 1. Signals clean up only the run's own process group;
reports and copied fixtures remain available. No automatic retries or reference
acceptance are provided.

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
Module-options exercises preference selection, not every engine implementation.
Diagnostic screenshots require review and are not approved visual baselines.

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
Suites are `smoke`, `controls`, `regressions`, `crop`, `workflows`, and `inventory`.
`--suite all` selects every declaration, but mixes incompatible prerequisites;
it is not a turnkey full-coverage run. Prefer one case and its required fixture:

```sh
# GUI commands: obtain fresh approval for each command first.
node verify/gui/run.mjs --config verify/gui/local.json --case crop-portrait --fixture portrait
node verify/gui/run.mjs --config verify/gui/local.json --case histogram-endpoints --fixture endpoints
node verify/gui/run.mjs --config verify/gui/local.json --case negative --fixture negative
```

The default `configured` fixture copies the configured photo. Synthetic choices
are `landscape`, `portrait`, `endpoints`, `negative`, `camera-a`, `camera-b`, and
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

`--case batch-paste` (also in `--suite regressions`) requires a JPEG fixture.
Before launch the runner makes three more copies in its own fixture directory:
two targets and one unselected control. The case applies Kodak Gold 200 at 35%,
copies Tone and Look through Copy Settings, selects two targets with a guarded
modifier click, and exercises Paste, whole-batch Undo and Redo. It checks the
selection/active photo, Exposure, look/amount, rendered pixels and both saved
sidecars, then reopens the second target and the unselected photo. Inspection
is read-only and limited to the app and this run's fixture sidecars. No system
clipboard or native dialog is used. This case is written, not live-validated.

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
