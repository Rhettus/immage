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
| advanced-exposure | Advanced mode Basic group's Exposure card: present (initial switch state recorded), +1 EV typed turns it on and brightens the frame, undo restores value and frame, redo reapplies, reset returns darktable's defaults with the module on, switching to Simple leaves the photo unchanged | Passed 2026-11-13T02-18-12.473Z_c42c29f_ae9f4d7f |
| advanced-instances | Advanced mode Exposure card instances: New instance (second open card, first tagged Simple), slider changes the frame, Rename, Duplicate, Move up in the pipe, Delete disabled on the first and removing a later one, undo and redo of the delete, no error notice | Passed 2026-11-13T02-18-12.473Z_c42c29f_ae9f4d7f |
| advanced-presets | Advanced mode Exposure card presets menu: darktable presets listed without the _builtin_ prefix, applying magic lantern defaults switches the card to its deflicker page and turns it on, the preset is checked on reopen, undo returns the manual page and redo reapplies it, no error notice | Passed 2026-11-13T02-18-12.473Z_c42c29f_ae9f4d7f |
| advanced-tonemapper | Advanced mode Basic group's single tone mapper card: switch menu lists agx, sigmoid, filmic rgb and base curve with the current one checked, picking another swaps the card and changes the frame, undo and redo move between them | Passed 2026-11-13T02-18-12.473Z_c42c29f_ae9f4d7f |
| advanced-groups | Advanced mode Tone Curve, Color, B&W, Color Grading, Detail, Lens Corrections, Transform, Effects and Technical groups: tone equalizer card with its three tabs, -4 EV band brightens the frame, Masking tab swaps controls, undo; shadows and highlights' eight controls; Add velvia changes the frame and undo returns it; rgb primaries hue in degrees; B&W group listed on a color photo, its color calibration card (Gray first) from Add module turns the frame gray and undo returns it; Add monochrome changes the frame; Color Grading's color balance rgb card with 4 ways first, color balance's factor and RGB sliders, Add colorize changes the frame; Detail's diffuse or sharpen card from Add module is Simple's Sharpening instance at 3 iterations, the only one Detail shows; denoise (profiled) card; Add lowpass changes the frame; the lens correction card's typed manual vignette strength changes the frame (the card sets has_been_set); a typed rotate and perspective rotation changes the frame with no black corners (the card refits the crop); the orientation card's rotate 90 degrees CW swaps the frame's sides and undo turns it back; a typed bloom threshold of 40 changes the frame; the blurs card shows the lens blur's sliders and not the motion blur's; the input color profile card's profile menus list the photo's profiles with its current one; the color reconstruction card hides hue until the hue precedence | Passed 2026-11-13T18-09-51.513Z_9cac7c5_31d767a5 (small raw fixture) |
| advanced-search | Advanced mode Search modules: typing lowpass lists the module and picking it opens Detail with a Lowpass card; ArrowDown/ArrowUp and Enter; Escape clears; picking an existing card opens and flashes it; picking another tone mapper switches the shared card and undo returns it; a setting label lists its module | Passed 2026-11-13T17-58-07.735Z_f14b403_06116d13 |
| advanced-hidden | Advanced mode hidden modules in Preferences > Modules: Lowpass switched off in Detail leaves search and Add module; a used hidden module (Exposure) keeps its card with the hidden tag; Essentials only; Show all for a group | Passed 2026-11-13T17-58-07.735Z_f14b403_06116d13 |
| advanced-sync | Advanced mode sync: color balance rgb's global wheel click sets hue and chroma and tints the frame, undo returns it; an added lowpass is Simple's Detail badge (one advanced edit, no other group badged) and the badge opens Editing mode; Copy Settings' Advanced modules alone pastes the lowpass onto a second photo, whose badge counts it; a second paste keeps the frame and one lowpass card | Passed 2026-11-13T20-18-05.140Z_db953cc_f646903c (JPEG fixture) |
| advanced-editors | Advanced mode graph editors: rgb curve card point click brightens the frame and undo returns it, three interpolation methods, R/G/B tabs for independent channels; tone curve L/a/b tabs with a disabled outside Lab independent channels; contrast equalizer card without its own heading, a raised band changes the frame and undo returns it; saturation curve point click changes the frame; lens picker only with the Lensfun method; white balance temperature and tint readouts, a typed temperature moves the coefficients and the frame, undo returns them | Passed 2026-11-13T20-18-05.140Z_db953cc_f646903c (JPEG fixture) |
| editing-mode | Editing mode Simple/Advanced in Preferences: no Technical group or search in Simple; search above the same groups with Technical last in Advanced; photo pixels and history unchanged; setting stored; Simple layout returns | Passed 2026-11-12T23-32-04.094Z_159afeb_bb7dd929 |
| settings-store | settings.json upgrade from localStorage and loose files (marker in both stores, localStorage kept), Preferences showing migrated values, UI change written to settings.json and kept across relaunch, reset by moving settings.json away | Live-validated, run 2026-11-12T07-14-54.365Z_3fc4903_91c5644c |
| hostile-text | Markup in the photo name, Title, Caption, Creator, Copyright, Make, Model and keywords shown as text in the grid, Metadata panel and keyword chips: no element or script made from it, `window.__pwned` undefined; run with `--fixture hostile` | Live-validated on Linux 2026-11-10 |
| location-map | Photo-area expansion, wheel zoom, Escape collapse, dialog stacking, unchanged location draft | Passed Linux ARM64 system WebKitGTK, run 2026-11-09T23-59-45.887Z_ab0c885_6005ea2f. Provider/keyring integration unverified |
| preferences-help | Short descriptions, hover and keyboard help, tooltip bounds, ARIA and dismissal | Passed 2026-11-12T23-32-04.094Z_159afeb_bb7dd929 |
| workspace-layout | General Workspace row order, conditional Scroll amount, right-aligned theme swatches, separate import actions and hit targets across built-in themes | Passed Linux ARM64 system WebKitGTK, isolated floating/maximized workspace, run 2026-11-09T21-37-52.837Z_e47ad0c_edc54e26; native import chooser remains manual |
| color-range | Hue, Hue Range, Minimum Chroma and Smoothness: pointer/keyboard/numeric edits, overlay pixels and restoration, Escape, undo/redo, saved values and render after restart | Passed Linux ARM64 system WebKitGTK, maximized isolated floating workspace, run 2026-11-09T05-02-48.236Z_761252a_11ce1c3e |
| startup, exposure | Real fixture, final photo, drag lighter/darker, exact reset | Previously passed on Linux system WebKit |
| gui-benchmark | Run existing benchmark via Preferences, retain/validate report and final pixels | Passed on Linux ARM64 VM, system WebKitGTK 2.54.2, Wayland DPR 2; timings approximate |
| gui-benchmark-screen | Same benchmark with fractional draft on | Passed on Linux ARM64 VM, Wayland 125%, DPR 2, draftScale 0.625 |
| gui-benchmark-whole | Same benchmark with fractional draft off | Passed on Linux ARM64 VM, Wayland 125%, DPR 2, draftScale 1 |
| slider-input | Arrow keys, focus retention, double-click numeric editing, Enter, reset/photo | Passed on Linux system WebKit, Wayland, DPR 2 |
| shift-range | Five random plain-click then Shift-click ranges in the grid with random delays; selection must be exactly the run | Passed 2026-11-12T23-32-04.094Z_159afeb_bb7dd929 |
| agx-presets | Profile loader, database filtering, checkbox/Add state, cancel, rendered import, duplicates, profile switching, user-only deletion preserving pixels, restart persistence | Passed on Linux ARM64, system WebKitGTK 2.54.2, maximized, 2026-11-08T23-06-46.100Z_3890fc3_2fe8198f. Default-replacement extension passed in 2026-11-08T23-16-29.185Z_3c1857f_6d3f975a. Native file chooser remains manual |
| batch-paste | Two selected JPEGs, Kodak look/amount, one batch undo/redo, both sidecars, reopening and unselected image | Written; awaiting approved GUI run |
| space-pan | Zoomed to 2:1, hold Space and drag in Heal and Masks (brush armed): the view pans, no spot healed, no mask painted (bc893e8); not Crop, which always shows the whole photo | Passed on Linux ARM64, system WebKitGTK, maximized 1596x840, 2026-11-13T08-12-29.565Z_e017746_147838b3 (full clean matrix, release-0.45.0 build f1e564f). Grab cursor not observable mid-hold |
| heal-show-spots | Heal dot cursor with no native cursor; Show spots Always/Selected/Never; H hides and restores the earlier choice; a click on a hidden spot heals a new one (6382ad7) | Passed on Linux ARM64, system WebKitGTK, maximized 1596x840, 2026-11-13T08-13-46.650Z_e017746_9bc35e8d (full clean matrix, release-0.45.0 build f1e564f) |
| jpeg-preset | Preferences > New Photos > Also apply to JPEGs: off, a new JPEG gets no preset; on, it gets Bright & Airy's Exposure (bfbc555); JPEG fixture, runner copies two photos | Passed on Linux ARM64, system WebKitGTK, maximized 1596x840, 2026-11-13T08-13-46.650Z_e017746_9bc35e8d (full clean matrix, release-0.45.0 build f1e564f). Raw side and Paste Settings only in `verify/batch-paste.test.mjs` |
| brush-dot | One click with the mask brush then Tone Exposure: the click's pixels change, far pixels do not (79e45e7) | Passed on Linux ARM64, system WebKitGTK, maximized 1596x840, 2026-11-13T08-13-46.650Z_e017746_9bc35e8d (full clean matrix, release-0.45.0 build f1e564f) |
| history | Slider edit, toolbar undo/redo, value/photo agreement, basic Reset All | Awaiting approved GUI run |
| rail | Presets, masks, zones, heal, adjustments, active state, hit geometry, screenshots | Awaiting approved GUI run |
| splash | Launch splash size stays 640x427 (not tiled to fill the workspace) | Environment-unverified: per-window floating behavior was not captured, and compositor sizing is not confirmed as an app bug |
| panel-scroll | 81d4441: a first open of Presets starts at the top; Adjustments returns to its own offset | Passed (run 2026-11-03T06-06-31.255Z_0f9ba08) |
| sliders | Current reachable panel ranges, pointer change, reset, final pixels, CSS, screenshots | Awaiting approved GUI run; hidden branches excluded |
| module-switch | Panel icon beside multi-module tools, its menu, pick, Escape and Set as default | Older pass covered global Contrast only; current Clarity clipping finding and mask behavior remain unverified |
| module-options | Every available Global/Masks option, independent Contrast choices, folding persistence | Awaiting a GUI run; preference UI only. Generated module-masks-contrast-1 passed (run 2026-11-03T06-28-57.870Z_8e9b538) |

`node verify/gui/run.mjs --list` lists selections without launching anything.
`--suite controls` runs all implemented control cases; `--suite regressions`
selects the linked cursor-CSS and module-scope cases. Both include startup.
A successful suite means only that selection passed. Review per-control
`photoChanged` observations: some controls legitimately need enabling another
option, a RAW, suitable image content, or a different module. Such observations
are not assertions of correct effect. Disabled controls are recorded as blocked
for the fixture, never as successfully exercised.

## Interaction versus rendered-effect coverage

Generated slider cases validate pointer movement, keyboard limits and step,
typed clamping/cancel, reset, and the reported value. Ordinary range cases also
require a rendered-frame change with the effect enabled. Contrast Equalizer
graph cases record `photoChanged` without asserting it; lens CA on a JPEG
explicitly leaves rendering unverified. Those interaction passes must not be
reported as rendered-effect coverage.

Slider drags move by at least one declared step. When the initial small edits
show no rendered change, range cases also probe both endpoints before requiring
a pixel difference. The report records each probe; reset and owner-restoration
assertions still apply.

For rendered-effect coverage, first establish the owning effect, capture a
baseline, change the control, and assert a pixel/frame difference when that
control is expected to affect the selected photo. Restore both the control and
the owner parameter, then verify the baseline is restored. If a control changes
state without necessarily changing pixels (for example, an overlay coordinate),
assert the relevant state or overlay instead. Use an appropriate fixture when
RAW-only behavior, image content, or an available profile is required. These
requirements describe intended coverage; they do not claim that unrun cases
have passed.

Some controls are secondary parameters of an effect that is neutral or disabled
at the default values. Seed the owner effect before requiring a rendered delta:

| Secondary controls | Owner prerequisite |
|---|---|
| Vignette midpoint, roundness, feather, and center | `vig_amount > 0` |
| Grain size | `grain_amount > 0` |
| Global/local Clarity and Texture detail level, halo control, and noise bias | At least one corresponding `gain_*` band is nonzero |
| Diffuse sharpening radius, sensitivity, and masking | `sharp_amount > 0` |
| Unsharp Mask radius, threshold, and masking | `usm_amount > 0` |
| Profiled denoise detail | `nr_luminance > 0` or `nr_color > 0` |
| Defringe radius | `defringe_amount > 0` |
| Hot-pixel strength and threshold | `hp_enable = 1` (RAW fixture) |
| Lens chromatic-aberration correction | `lens_profile = 1`; use a matched profile for a rendered-effect assertion |

Mode-selected controls also need their intended mode or treatment selected;
examples include parametric Tone Curve, B&W Mix, AgX versus sigmoid controls,
negative conversion, and spektrafilm. Record which branch the case exercised.

Local range cases wait for the selected mask's adjustment groups to mount,
then open the appropriate group. HSL cases select Hue, Saturation or Luminance;
Color Grading cases select Sliders. Defringe belongs to Detail. Sharpening
masking seeds the amount control actually mounted by the selected module.
The manifest also contains internal state such as `l_fulcrum`, which has no
independent mask slider and must not be counted as an untested visible control.

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
| Every manifest slider | Neutral, both directions, limits, step, nonlinear track mapping, keyboard, typed commit/cancel/clamp, wheel on/off, reset; separate interaction and rendered-effect assertions on a suitable photo | Ordinary ranges assert frame change and reset; CE graph bands and unmatched lens CA have explicit rendering limits |
| Panel/section/tab variants | Expand/collapse, focus mode/Alt, advanced controls, each tab, every module-controlled branch | Panel walk implemented; branches pending |
| Choices, menus and toggles | Every option, disabled states, selected label, persistence, keyboard, popup placement and clipping | Module preferences implemented; other choices pending |
| Every module | Global and mask scope, each backend option, effect/reset/undo, keep existing edits, reopen sidecar | Preference options only; output cases pending |
| Curves/wheels/graphs | Drag points, boundaries, channels, reset, photo effect, graph hit targets | Pending |
| Crop/transform | Free/locked/portrait, corners/edges, aspect options, rotation/flip, guides, cancel/apply, undo | Pending |
| Portrait automatic Transform | Crop a native/EXIF portrait, click Auto, Level, Vertical and Full; verify a rendered correction without a working-space error, then restore the crop and repeat | GUI case pending; headless CPU sampling covered by `verify/transform-sampling.py` |
| Masks/heal/negative/film simulation/zones | Creation and deletion, every shape/option, local module controls, outside-region invariance, reset/undo | Rail opening only; editing pending |
| Preferences | Every safe local setting, persistence, theme/canvas/font/preview, disabled hardware states | Module tab, and General's Overlay opacity (`overlay-opacity`, live-validated); external apps/services/relaunch excluded |
| Application menus (Windows/Linux) | Title strip, open/hover/Escape/outside click, item labels and shortcuts, effects of items, modal and text-field guards, drag region | `menus`, `menus-guards` live-validated on Linux (run 2026-11-10T02-59-06.431Z); Quit, Add Folder and User Guide are outside the app-only boundary; macOS uses the native menu |
| Engine restart | Engine process killed after an edit; restart status and message, photo reopened from its sidecar, rendering, further edit saves | `engine-restart` (suite `engine`), live-validated on Linux 2026-11-10 |
| Failed save | Copied folder and sidecar made read-only after a saved edit: a lasting, visible notice names the sidecar and the reason, the old sidecar is unchanged, no copy is left; the next edit saves once the folder is writable and the notice goes | `save-failure` (suite `engine`), live-validated on Linux 2026-11-11 |
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

The registry now contains 335 named and generated declarations. Generated range cases exercise
both pointer directions, keyboard limits/steps, typed minimum/maximum clamping,
Escape and reset; generated choices enumerate mounted options. Global/mask module
variants exercise a candidate control and rendered effect. Declarations do not
establish 335 passes: consult retained run reports. RAW-only controls and neutral/gated effects
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
