# Visible-app GUI verification plan

Status: design agreed; the runner and test cases are not implemented yet.
This suite will run alongside `verify/run.py`, with its own command and report.
The existing suite continues to check the editing pipeline and performance.

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
run, not a pass. Initial runs are local and opt-in; CI integration comes after
the cases are reliable. Reference: https://v2.tauri.app/develop/tests/webdriver/

## Files and results

| Path | Purpose | Git |
|---|---|---|
| `verify/gui/README.md` | Shared design, then setup and run instructions | tracked |
| `verify/gui/AGENTS.md` | Instructions for any agent working on this suite | tracked |
| `verify/gui/run.mjs` | Planned command-line runner | tracked when implemented |
| `verify/gui/specs/` | Independent interaction scenarios | tracked when implemented |
| `verify/gui/support/` | App launch, controls, waits, evidence and desktop lock | tracked when implemented |
| `verify/gui/local.example.json` | Documented machine-settings template | tracked when implemented |
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

The Windows pointer-over-icon regression also needs a compositor/OS capture that
includes the native cursor. Webview screenshots do not establish cursor stacking.
Treat that visual observation separately from DOM hit-testing and computed cursor
style. If cursor-inclusive capture is unavailable, report that part as unverified.

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

1. Implement configuration validation, isolated app state, desktop lock and
   cleanup. Validate a blocked run leaves the user's app and photos untouched.
2. Launch the visible app with its native driver. Implement startup and Exposure
   pointer drag/reset using a copied fixture and real engine rendering.
3. Produce the report and screenshots. Deliberately break a control's CSS or
   interaction in a disposable checkout and demonstrate a diagnostic failure.
4. Add slider input, panels, rail tools and undo/redo. Repeat a clean smoke run
   three times to identify instability; retain reports for every attempt.
5. Add mask editing, themes/scales and Windows. Document exact prerequisites and
   coverage gaps, including native-pointer capture and packaged webview matching.
6. Consider desktop CI and broader manifest coverage after local runs are stable.

Planned interface (not runnable yet):

```sh
node verify/gui/run.mjs --config verify/gui/local.json --suite smoke
node verify/gui/run.mjs --config verify/gui/local.json --case exposure
```

The runner should default to a visible window and return nonzero for failures or
blocked required cases. A separate explicit reference-accept operation must name
the source run and environment. Before calling this suite ready, replace these
proposed commands with verified installation and execution instructions, and have
another agent follow the checked-in guide without private conversation context.
