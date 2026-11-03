# Visible GUI verification

Shared setup: [verify/gui/README.md](../../../verify/gui/README.md).
Coverage and prior-fix triggers: [COVERAGE.md](../../../verify/gui/COVERAGE.md).

`run.mjs` resolves named cases/suites from `suites.mjs`, launches an isolated
production app and records each case definition, measurements, screenshots and
failure. Startup is a prerequisite for every case. Startup/Exposure have previous live passes; the first expanded run also passed
slider-input, then stopped at history because Undo was outside the narrow
viewport. Horizontal toolbar scrolling was added afterward and awaits a new
approved visible run. See the coverage ledger for exact evidence.

`App.tsx` exposes read-only `data-panel-id` on manifest panels and
`data-control-id` on SliderWidget. Existing `data-render-quality` identifies
final photo frames. These attributes observe production behavior and do not
provide setters or test-only engine paths. Rebuild with Tauri's production
command before using new hooks. Manifest-only inventory imports the actual
expanded controls/math modules using Node's native TypeScript stripping and a
local extension resolver; it never imports App or launches WebDriver.

`support/controls.mjs` reads range values, formatted labels, computed styles,
viewport/ancestor clipping, hit tests, options and scroll geometry. `reveal`
sends guarded WebDriver wheel actions to the owning scroll area, never DOM
scroll mutations. Keyboard and pointer actions verify the dedicated app's URL
and original window first. Configuration cannot supply scripts or commands.

The slider walker records currently mounted controls and disabled prerequisites.
It records whether rendered pixels changed, but lacks a universal effect oracle:
RAW/module dependencies and neutral gating need dedicated cases. Module preference
coverage checks UI choices and independent scopes, not the output of every
engine backend. History's basic Reset All case does not reproduce the native
module reset bug until a dedicated branch scenario is added.

Non-GUI checks (no desktop/app launch):

```sh
node verify/gui/inventory.mjs --check
node verify/gui/support.test.mjs
node verify/gui/run.mjs --list
cd app && npm run build
```

Before each GUI command, follow `AGENTS.local.md` approval requirements. Retain
all reports, inspect screenshots and update the coverage ledger with actual
scope/environment. Do not infer visual correctness from value changes, claim
unrun tests passed, or accept references automatically. Add a negative CSS-fault
validation in a disposable checkout before claiming visual regression coverage.

## Memory admission

`support/memory.mjs` parses Linux `/proc/meminfo` and fails closed for missing or
inconsistent counters. `run.mjs` records checks before setup and immediately
before spawning the driver, requiring MemAvailable >= 4 GiB and swap usage <=
50%. A rejected check yields the normal blocked report and exit 1, without
launching an app. Limits are fixed and do not treat swap as spare RAM. Verify
threshold boundaries, no-swap and malformed readings with
`node verify/gui/memory.test.mjs` (no GUI). This preflight does not establish
runtime safety; the interrupted slider run needs separate memory investigation.

## Expanded registry and evidence

`generated.mjs` expands `inventory.json`; `registry.mjs` resolves 540 named
case declarations to implementations. Range contracts use physical pointer and
keyboard input for limits, steps, typed clamping/cancel and reset. Workflow files
cover crop, graphs, masks, dialogs and regression targets. Missing fixture or
UI prerequisites raise `Blocked`; they are not successes. See the coverage ledger
for incomplete original triggers and service/slow-folder/panorama fixture gaps.

Additional read-only observations identify sections, choices, detail controls,
preference labels, export fields and mask groups. The root exposes chosen module
names; `html.dataset.loupeFrames` counts delivered loupe frames, not scheduling
requests. These do not expose application commands. None of the expanded cases
has been live-validated yet; rebuild the production executable before testing.

`support/journal.mjs` fsyncs event records and atomically replaces report snapshots.
`recover.mjs` reads interrupted evidence without modifying it or inferring passes.
`support/process-memory.mjs` samples owned descendants every two seconds, including
RSS, PSS when available, swap and root start identity. Runtime system pressure
attempts an owned-tree stop below 1 GiB available or above 85% swap; this cannot
guarantee prevention of an OOM. Shared RSS can be counted multiple times.

`fixtures.py` generates deterministic TIFFs with orientation, endpoint pixels and
camera serial metadata inside a run. `support/pixels.mjs` implements PNG decoding,
encoding and regional pixel comparison; `visual.mjs` requires reviewed acceptance
and matching environment metadata. References and output remain ignored. Synthetic
comparator fault tests are not an application CSS fault-injection result.

Run `infrastructure.test.mjs`, `memory.test.mjs`, `support.test.mjs`,
`fixtures.test.py`, inventory freshness and the frontend build without a GUI.
The README documents the full commands and offline recovery/reference tools.

## Website screenshot case

`site-shots` (`specs/site.mjs`) takes the screenshots for the website and the
user guide on a copied photo. It presses I to hide the photo info and skips
any shot whose visible text includes a home, temporary or drive path. Each
shot records the photo canvas bounds, so a before/after pair can be cropped
to the photo. `SITE_SHOTS=masks,heal` retakes only those steps. The window
is floated and sized from outside the runner. Like every visible case, it
runs only with approval.

## Batch paste case

`batch-paste` adds copied JPEG targets before launch and uses guarded WebDriver
modifier-pointer selection. `data-action="copy-settings"` / `paste-settings`
and `data-copy-group` identify real production controls. `sidecarsNamed` reads
only XMP files in the run's fixture directory; tests cannot name arbitrary
paths. The case checks the Kodak look/amount, selected targets, whole-batch
undo/redo, pixels, persisted sidecars, reopening and an unselected control.
It awaits approved visible execution; backend checks do not establish a GUI pass.
