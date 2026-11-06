# GUI coverage ledger

The target is every slider, menu, module and option, including fixes recorded
in Git. This is an incremental suite, not complete coverage. `inventory.json`
expands the editing manifest into 19 panels and 375 control declarations plus
global/mask module choices. All declarations start **pending**: merely appearing
in source or being discovered at runtime is never a GUI pass. Non-manifest
preferences, dialogs, library menus and service workflows must also be covered.
Regenerate with `node verify/gui/inventory.mjs`; check drift with `--check`.
This imports pure manifest/math code using Node >= 22.18, without launching an app.

## Implemented cases

| Case | Checks | Verification status |
|---|---|---|
| startup, exposure | Real fixture, final photo, drag lighter/darker, exact reset | Previously passed on Linux system WebKit |
| gui-benchmark | Run existing benchmark via Preferences, retain/validate report and final pixels | Passed on Linux ARM64 VM, system WebKitGTK 2.54.2, Wayland DPR 2; timings approximate |
| gui-benchmark-screen | Same benchmark with fractional draft on | Passed on Linux ARM64 VM, Wayland 125%, DPR 2, draftScale 0.625 |
| gui-benchmark-whole | Same benchmark with fractional draft off | Passed on Linux ARM64 VM, Wayland 125%, DPR 2, draftScale 1 |
| slider-input | Arrow keys, focus retention, double-click numeric editing, Enter, reset/photo | Passed on Linux system WebKit, Wayland, DPR 2 |
| shift-range | Five random plain-click then Shift-click ranges in the grid with random delays; selection must be exactly the run | Written; awaiting approved GUI run |
| batch-paste | Two selected JPEGs, Kodak look/amount, one batch undo/redo, both sidecars, reopening and unselected image | Written; awaiting approved GUI run |
| history | Slider edit, toolbar undo/redo, value/photo agreement, basic Reset All | Awaiting approved GUI run |
| rail | Presets, masks, zones, heal, adjustments, active state, hit geometry, screenshots | Awaiting approved GUI run |
| splash | Launch splash size stays 640x427 (not tiled to fill the workspace) | Fails on Hyprland 0.57: floats but opens 1710x1107 (run 2026-11-03T05-56-54.119Z_f7db416); not in smoke |
| panel-scroll | 81d4441: a first open of Presets starts at the top; Adjustments returns to its own offset | Passed (run 2026-11-03T06-06-31.255Z_0f9ba08) |
| sliders | Current reachable panel ranges, pointer change, reset, final pixels, CSS, screenshots | Awaiting approved GUI run; hidden branches excluded |
| module-switch | Panel icon beside multi-module tools, its menu, pick, Escape and Set as default | Passed, Linux release build (run 2026-11-05T22-18-54.889Z_e76d528_2a7cfb97); global Contrast only, masks not driven |
| module-options | Every available Global/Masks option, independent Contrast choices, folding persistence | Awaiting a GUI run; preference UI only. Generated module-masks-contrast-1 passed (run 2026-11-03T06-28-57.870Z_8e9b538) |

`node verify/gui/run.mjs --list` lists selections without launching anything.
`--suite controls` runs all implemented control cases; `--suite regressions`
selects the linked cursor-CSS and module-scope cases. Both include startup.
A successful suite means only that selection passed. Review per-control
`photoChanged` observations: some controls legitimately need enabling another
option, a RAW, suitable image content, or a different module. Such observations
are not assertions of correct effect. Disabled controls are recorded as blocked
for the fixture, never as successfully exercised.

## Commit regressions

Use the commit's final behavior as the oracle. Link the commit in case metadata,
reproduce its original trigger, assert both interaction and visible output, then
retain before/after/reset evidence. A broad smoke case is insufficient when the
original trigger differs. Compare against the parent revision in a disposable
checkout where practical, after approval for each GUI run; keep the failing
report. Do not mutate production state or inject DOM events to reproduce a bug.

| Fix | Original trigger and acceptance | State |
|---|---|---|
| fe5dbc2 | Windows pointer over rail icon/SVG: cursor CSS stays default throughout subtree | `rail` implemented; native pointer stacking remains manual Windows verification |
| faa19d7, 9d956c7 | Choose different global/mask Contrast modules; fold/reopen and retain both | `module-options` implemented; actual mask rendering pending |
| b1d7c4c | Change a native module option, edit, Reset All; defaults restored in UI and photo; undo restores native choice | Pending; `history` covers basic Exposure only |
| 1f2f8b8 | Portrait-oriented fixture, resize each crop edge; orientation and displayed aspect stay correct | Pending portrait fixture/crop geometry case |
| b22bd4b | Locked crop, drag corner inward on only one axis; rectangle must shrink and retain aspect | Pending crop pointer case |
| 323cfa9 | First entry into crop; guides align before any drag | Pending crop screenshot/geometry case |
| 630672c | Scaled display, alternate draft/final previews; frame edges stay aligned | Pending approved scale environments, no compositor automation |
| de6adf7 | Synthetic dark/bright endpoint fixture; histogram endpoint peaks remain visible | Pending dedicated fixture and histogram assertions |
| 29b1591 | Enable loupe, enter grid; loupe rendering pauses | Pending loupe/grid observation and timing case |
| f023c4f | Disable loupe; detail edit still renders full resolution | Pending RAW/detail fixture and resolution oracle |
| 17ac5e6, 74cedc9 | Slow unrelated folder load, expand/open another folder; correct results arrive without stale replacement | Pending isolated folder fixture and reproducible delayed backend |
| baa8def | Reject/delete copied fixture; UI removes it promptly and visible thumbnails get priority | Pending disposable library fixture; never originals |
| 7b20937 | Same camera model, different body serials; filter independently and handle missing serial | Pending metadata fixture family/filter case |
| 33949b6, 22840b4 | Immich results and generated images: browse parent/show new image | Blocked until dedicated local service fixture; no real account/network UI |

Compiler/linker/packaging fixes belong to CI and release verification; GUI passes
do not prove compatibility or installation behavior.

## Full control matrix to build

| Area | Required coverage and prerequisites | State |
|---|---|---|
| Every manifest slider | Neutral, both directions, limits, step, nonlinear track mapping, keyboard, typed commit/cancel/clamp, wheel on/off, reset; actual effect on suitable photo | Reachable drag/reset scaffold; Exposure stronger oracle |
| Panel/section/tab variants | Expand/collapse, focus mode/Alt, advanced controls, each tab, every module-controlled branch | Panel walk implemented; branches pending |
| Choices, menus and toggles | Every option, disabled states, selected label, persistence, keyboard, popup placement and clipping | Module preferences implemented; other choices pending |
| Every module | Global and mask scope, each backend option, effect/reset/undo, keep existing edits, reopen sidecar | Preference options only; output cases pending |
| Curves/wheels/graphs | Drag points, boundaries, channels, reset, photo effect, graph hit targets | Pending |
| Crop/transform | Free/locked/portrait, corners/edges, aspect options, rotation/flip, guides, cancel/apply, undo | Pending |
| Portrait automatic Transform | Crop a native/EXIF portrait, click Auto, Level, Vertical and Full; verify a rendered correction without a working-space error, then restore the crop and repeat | GUI case pending; headless CPU sampling covered by `verify/transform-sampling.py` |
| Masks/heal/negative/film simulation/zones | Creation and deletion, every shape/option, local module controls, outside-region invariance, reset/undo | Rail opening only; editing pending |
| Preferences | Every safe local setting, persistence, theme/canvas/font/preview, disabled hardware states | Module tab, and General's Overlay opacity (`overlay-opacity`, live-validated); external apps/services/relaunch excluded |
| Library/filter/history/presets | Every menu and option with disposable folder/metadata fixtures | Pending |
| Import/export/panorama | In-app settings, validation, format/projection options, preview/output | Pending; native chooser blocked, launch fixture argument only |
| Print/soft proof | Printer, paper, media, orientation, margins, size, place, profile, intent, BPC; soft proof and gamut warning on the photo; Print and Save PDF | `print` case written, pending live run: soft proof, gamut, S, layout and Save PDF readiness with a seeded profile. Printing and the save dialog are native or need a real printer; `verify/print.py` checks profiles, proof pixels and the engine's PDF headlessly |
| Visual correctness | Supported OS/webview/theme/scale/viewport, contrast/focus/clipping, approved regional references/diffs | Geometry/CSS and diagnostic screenshots only; approved references pending |

Before marking an area complete, enumerate its options, add suitable fixture
prerequisites, link cases, run with approval, inspect app screenshots, and record
which environments passed. References must be explicitly reviewed and approved,
never automatically blessed. A visible CSS fault in a disposable checkout must
be caught before claiming reliable visual regression protection.

## First expanded run

Approved `controls` run `2026-11-01T23-39-31.087Z_f8f31aa_bc0fb5a5`
passed startup and slider-input, then stopped at history: Undo was unreachable
in the 1025×600 viewport. The screenshot showed a horizontally overflowing
toolbar; the reveal helper supported only vertical scrolling. Horizontal
WebDriver wheel support and axis-specific clipping were added afterward and
passed non-GUI boundary checks, but have not yet been GUI-verified. The user
requested an empty workspace for the next run. Rail, slider walk and module
options did not execute. Preserve the failed report; this was not a suite pass.

## Expanded implementation status

The registry now contains 310 named declarations. Generated range cases exercise
both pointer directions, keyboard limits/steps, typed minimum/maximum clamping,
Escape and reset; generated choices enumerate mounted options. Global/mask module
variants exercise a candidate control and rendered effect. These are unverified
implementations, not 310 passes. RAW-only controls and neutral/gated effects
can block or need stronger dedicated oracles.

A control that only one option of a module choice shows (the contrast
equalizer's 30 bands, contrast & texture's Clarity and Texture bands,
diffuse or sharpen's Amount/Radius/Sensitivity) records that option as
`module` in its generated case. The case chooses it in Preferences >
Modules first and restores the previous choice afterwards
(`withModule` in `specs/ranges.mjs`). Defringe has no module choice, so
its global and mask sliders always run on chromatic aberrations.

The saturation curve's `sc_*`/`sb_*` points are drawn on its graph, so they
generate no control cases either (`graphCoverage` in `generated.mjs`): the
`saturation-curve` case drives the global graph (passed live on Linux
2026-11-04, run `2026-11-04T04-47-50.800Z_0bf0f4f_8df48d28`), and the
`module-*-saturation-2` variants lift its muted end globally and in a mask.

Hidden panels generate no control cases (their state has no slider):
`hiddenPanelCoverage` in `generated.mjs` maps the point curve to `curves`,
crop and orientation to `crop-options`, zones to `zones`, negative to
`negative`, film simulation to `film` and modules to `module-options`. Upright, vignette center, exposure
compensation and the tone mapper have no written case yet: a coverage gap,
not a pass.

Written cases now include crop guides/locked corners/portrait edges/aspects,
crop Auto straighten (and Auto's being disabled while Upright is on; passed
live on Linux 2026-11-04 with P1030105.RW2, run
`2026-11-04T15-39-13.889Z_73c0bc2_c06b6626`),
curves, wheels, equalizer bands, masks, heal, negative conversion, film
simulation (on, the Film and Paper menus, a preset, off; the runner copies the
installed data pack into the run's profile; passed live on Linux 2026-11-03), zones,
preferences, wheel settings, export settings, filter layout, presets, shortcuts,
histogram endpoints, scaled final-frame alignment, loupe frame delivery in grid,
detail without loupe, camera-body options and native reset. Earlier table entries
marked pending for these areas now mean **pending live validation and oracle
review**, rather than no implementation. Use `--list` for exact case metadata.

Important incomplete triggers:

- Native reset does not yet seed hidden nondefault native parameters from b1d7c4c.
- Preview alignment checks final geometry; it does not fully assert a live draft.
- Camera-body/filter cases inspect options/layout, not complete filtered results.
- Deletion blocks before native confirmation; deletion scheduling is untested.
- Folder race and panorama need fixture adapters not provided by the CLI yet.
- Immich is a blocked prerequisite declaration, not an implemented service flow.
- Export covers settings only; output files and native destination selection are untested.
- Native Windows cursor, packaged WebKit, themes/scales and approved visual
  references still need their own environments and approved runs.

The second expanded run, `2026-11-01T23-45-21.396Z_f8f31aa_970ba574`,
was interrupted when systemd-oomd killed its terminal scope. It has screenshots
through Basic Shadows but no completed report; no additional case passes are
claimed. Memory admission, runtime sampling and durable checkpoints were added
subsequently. GUI execution remains paused while VM memory is increased.
