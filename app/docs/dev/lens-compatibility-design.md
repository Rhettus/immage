# Lensfun compatibility design for the pin audit

Status: design proposal, without a selected import default or production change.
See the [audit evidence and adoption gates](darktable-update-review.md#lensfun-negative-value-evaluation).

The old pin is `2747ed2a0d162515bd9c91d02201653de895dddb`; the frozen
candidate is `879067695ea85f42d238a5c1603a021d14d71d3f`. The following contracts
apply to Lensfun processing, not embedded metadata or manual vignetting.

## Reference contracts

| Path | Coordinates | Vignetting on RGB | Execution evidence |
| --- | --- | --- | --- |
| Old CPU | Lensfun calls for each row | `ApplyColorModification` on actual pixels | Coherent old-cpu image references and standalone library probe |
| Old OpenCL | Lensfun calls for each row, uploaded to device | Host evaluates a row initialized to 0.5; kernel multiplies RGB by twice that result | Source contract only; device reference pending |
| Candidate CPU/OpenCL | Adaptive coordinate and factor grids | Multiply RGB by sampled factors | CPU image references; device validation pending |

At the old pin, `src/iop/lens.cc::_process_lf` applies actual-pixel vignetting
before geometric correction in the forward direction (`roi_in` rows), and after
geometric correction in the reverse direction (`roi_out` rows).
`_process_cl_lf` uses the same ordering and row domains, but evaluates 0.5-valued
rows instead. `data/kernels/basic.cl::lens_vignette` computes
`scale = 2.0f * pi[y * width + x]`, then `pixel.xyz *= scale.xyz`; it leaves
alpha unchanged and has no explicit clamp. This is the arithmetic already
compared against direct Lensfun in `verify/lensfun-profiles.cc`, executed on the
host. It does not emulate image reads, geometric kernels or device arithmetic.

The candidate `_lens_grid_eval` extracts doubled factors on the host and its
`lens_vignette` samples the grid before multiplying RGB. Starting grid construction
at step 1 can remove interpolation, but does not restore actual-pixel Lensfun
vignetting. The profile probe also rules out a universal replacement with
`max(pixel * factor, 0)`: twelve profiles disagree in the all-calibration, three-row sample. The comment that Lensfun
only multiplies factors in `_lens_grid_eval` is therefore insufficient to justify
old CPU compatibility for installed Lensfun 0.3.4.0.

## Mask and alpha source contracts

Source review of both frozen trees distinguishes three paths that need separate
runtime references:

- `_process_lf` writes geometric output alpha only when
  `mask_display & DT_DEV_PIXELPIPE_DISPLAY_MASK` is set. Both directions sample
  alpha using the green coordinate pair, clamp coordinates to the input bounds,
  and write zero for nonfinite green coordinates when checks are enabled. Outside
  that display mode, active geometry does not initialize output alpha. A final
  opaque RGBA frame therefore cannot establish intermediate alpha preservation.
- `_distort_mask_lf`, called through `distort_mask`, transforms a separate
  single-channel mask. It requests distortion, geometry and scale without TCA or
  vignetting, samples the green coordinates without the image path's explicit
  coordinate clamp, then applies `CLIP` to the interpolated value. The old tree
  calls Lensfun directly per row; the candidate builds a coordinate grid and
  copies the input mask if grid construction fails. The isolated direct prototype
  also reaches this grid builder, whose step is forced to one. Its RGB diagnostic
  does not invoke or validate this separate mask entry point.
- The OpenCL bilinear geometric kernel samples green and alpha together through
  `pixel.yw` in both trees, independently of the CPU display-mask condition.
  Candidate coordinates come from `_lens_grid_sample`; old coordinates come from
  the uploaded per-pixel array. This is source evidence, not device parity.

A useful next headless diagnostic must explicitly enable CPU mask display and
hash real, spatially varying alpha after `_process_lf`; constant synthetic alpha
cannot reveal coordinate errors. Test the separate `distort_mask` entry point
with gradients, hard edges and values outside [0, 1], including boundary ROIs,
both directions and all four interpolators. Check bypass and grid failure
separately. Do not equate these two mask contracts or mark either runtime gate
complete from the existing signed RGB results. Manual-vignette mask generation,
metadata processing and actual device execution remain separate coverage.

## Proposed implementation boundary

Use an explicit serialized processing choice if multiple appearances are retained.
Names below describe contracts, not approved UI labels or enum values:

- **Direct CPU reference:** use direct row coordinates and actual-pixel Lensfun
  vignetting, preserving stage ordering, row width, global ROI origin, channel roles
  and alpha handling. Initially disable OpenCL for this Lensfun mode through
  committed `piece->process_cl_ready`, so ordinary scheduling/fallback always uses
  that same implementation. Do not claim GPU support by substituting a clamp or
  factor kernel. A later device implementation needs a separately validated
  equivalent or explicit transfers of actual pixels through the library.
- **Old OpenCL factor reference:** retain direct row coordinates and factor
  extraction, without a new clamp. A CPU implementation of this contract is needed
  before enabling it, so unavailable devices and allocation failures cannot silently
  switch appearance to old actual-pixel CPU processing. Old geometric kernel
  behavior, including interpolation changes, still needs device references; direct
  coordinates alone do not prove whole-frame old OpenCL equivalence.
- **Adaptive candidate:** keep the candidate grid contract available for evaluation.
  Its measured changes and device fallback need acceptance independently of the
  historical contracts.

Keep the choice in versioned module parameters, copy it into committed data and
include it in cache identity. Review all historical `legacy_params` exits and
new-module defaults. Module version alone does not identify which backend made
an old edit. Unknown-provenance imports therefore require a deliberate policy;
no automatic default or migration value is chosen here. Limit this choice to
Lensfun so metadata/manual processing is not changed accidentally.

Direct evaluation preserves a processing contract, not a universal historical
frame. Existing evidence shows old CPU results depend on tile layout. Hold tile
layout, Lensfun binary/database, image dimensions, ROI, interpolation and module
history fixed when assessing equivalence. Cross-layout or cross-library identity
would be a separate requirement and could require a different algorithm.

## Required validation before implementation is accepted

1. Capture old OpenCL references on an actual available device with engine/module,
   kernel, driver, Lensfun and database identities. Record that the lens module
   actually executed on OpenCL, plus device/CPU fallback and tile layout.
2. Compare signed floating intermediate RGB and final frames, both directions,
   full-size and preview, four interpolation modes, tile budgets and pixel aspect.
   Include profiles where the zero-clamp diagnostic fails, beyond the two RAWs.
3. Validate each chosen contract with CPU-only execution, successful device
   execution where supported, allocation fallback and cancellation/recovery.
4. Verify migration, styles, applied history, preview, XMP save/reload and fresh
   process import; switching modes must invalidate cached results. Preserve masks
   and unrelated parameters. Test metadata/manual modes as unchanged controls.
5. Approve the unknown-provenance import and new-edit defaults, document user-visible
   behavior and run platform/performance checks before moving the pin.

Local capability check: `clGetPlatformIDs(0, NULL, &count)` through installed
`libOpenCL.so.1` returned `-1001` (`CL_PLATFORM_NOT_FOUND_KHR`), count 0.
No device run was attempted. The loader's presence and features-enabled engine
build are not old OpenCL image references. Native device capture remains open.


## Isolated prototype

`verify/pin-lens-direct.py` builds a separate diagnostic plugin from the frozen
candidate. It forces direct CPU coordinate rows, evaluates vignetting on actual
pixels in the historical stage order and disables committed Lensfun OpenCL
readiness. It skips factor-grid construction and per-thread factor allocations.
The [audit](darktable-update-review.md#all-calibration-lensfun-sampling-and-isolated-direct-cpu-prototype)
records measured coverage. No parameter layout, import policy or production
mode is implemented by this diagnostic. Broader image, migration and native
fallback validation remains necessary.

The direct prototype also matches saved Olympus forward/reverse 0.75/1.5 aspect
histories at both 512 pixels and full-size bounds in all four warp interpolators,
with matching 7×7/3×3 minimum-budget lens tiles at full size. See the [measured matrix](darktable-update-review.md#direct-cpu-prototype-pixel-aspect-interpolation-and-full-size-tiling).
This remains one RAW/profile, not acceptance of exceptional-profile imports or
native device fallback. All 40 comparisons in the explicit full-size interpolation
matrix are exact RGB; matching-camera exceptional-profile coverage remains pending.


Two exceptional compact-camera profiles also match old CPU in a 512-pixel
whole-frame assignment diagnostic, both directions, while the adaptive candidate
differs. Exact library selection and visible correction are checked. The profiles
are assigned to an unrelated Olympus RAW, so matching-camera imports remain open. See the [assignment evidence](darktable-update-review.md#exceptional-profile-assignment-diagnostic).


The same preview-size assignment diagnostic now covers the remaining ten
exceptional installed profiles: all 20 additional forward/reverse frames match
old CPU exactly with the direct prototype. Exact camera/lens selection and a
visible correction are required in every case. This closes preview assignment
coverage for all 12 exceptional profiles; matching-camera imports, signed intermediates and native fallback remain open.
See the [broader assignment evidence](darktable-update-review.md#broader-exceptional-profile-assignments).

All 12 assigned exceptional profiles also match old CPU exactly at 4640×3472
in both directions (24 comparisons), with minimum-budget lens tiling and
visible-correction guards. This extends the fixed-layout diagnostic evidence;
it does not establish matching-camera imports, signed intermediate behavior
or native device/fallback compatibility. See the [full-size evidence](darktable-update-review.md#full-size-exceptional-profile-assignments).


The isolated signed boundary diagnostic now compares injected negative, zero,
positive and HDR floating inputs immediately around the actual CPU Lensfun
vignetting calls. All 12 assigned exceptional profiles, both directions, match
old CPU exactly at preview/full size under the minimum budget: 48 final frames
and 489,642 floating-row records. No nonfinite output or fourth-channel change
was observed. These are deliberately injected values on the unrelated Olympus
RAW. Another 192 preview comparisons cover ratios 0.75/1.5 and all four warp
interpolation preferences: 71,004 floating rows and final frames match exactly.
These fixtures enable vignetting only, so geometric-warp interpolation is not
exercised by changing preferences. Another 48 full-size comparisons at ratios
0.75/1.5 with bicubic match exactly: 920,227 floating rows and all final frames
(4640×4630/4640×2314), finite outputs and unchanged fourth channels. Other
preferences at these ratios remain preview-only. Real-camera inputs, natural
negative intermediates and native devices remain open. Signed geometric processing
has a separate module-input diagnostic described below.
See the [signed boundary evidence](darktable-update-review.md#signed-floating-vignetting-boundary-diagnostic)
and reproduction commands in the verification guide. This does not approve a
production contract or close the full signed-intermediate acceptance gate.


The geometry diagnostic injects signed/HDR RGB before CPU Lensfun processing,
enables distortion plus vignetting and compares RGB after both operations in
both directions. It rejects bypass, inactive geometry and grid failures; saved
XMP verifies requested flags. Alpha is excluded from this comparison because
normal geometry output does not define it outside mask display. This complements
the vignetting-boundary diagnostic without establishing a production policy.

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

CPU display-alpha preview diagnostic: the isolated old and direct Lensfun
plugins now support `--geometry --mask-display`. This forces the local CPU
display-mask interpolation branch and injects a spatial alpha ramp alongside
signed RGB; actual intermediate RGBA is hashed, with nonfinite alpha rejected.
At 128x95 with bicubic interpolation, all 24 assigned-profile/direction cases
match exactly across 2,280 floating RGBA rows and final frames. Evidence is in
ignored `pixel-lens-alpha-bicubic-128/`; its manifest hashes were independently
verified. This synthetic unrelated-camera preview does not cover separate
`distort_mask`, full-size/other-interpolator alpha, or native OpenCL. Production
behavior and pin remain unchanged.

CPU mask/alpha preview follow-up: bilinear, Lanczos2 and Lanczos3 display-alpha
checks each matched all 24 assigned-profile/direction cases at 128x95. Including
bicubic, all four modes match 9,120 intermediate RGBA rows and final frames.
The separate `_distort_mask_lf` entry point now has a diagnostic mode exercising
a spatial ramp, hard step, and repeating -0.5/0.5/1.5 inputs; outputs are
initialized to NaN and must be finite within [0,1]. All four preview interpolators matched 96 cases
and 27,360 single-channel rows exactly, alongside 9,120 image RGB rows. The checker
requires the exact image-row coordinate multiset for each of the three patterns;
a duplicate replacing a missing coordinate is rejected. Each run's 179 hashes
were independently verified. Ignored evidence is in `pixel-lens-alpha-*-128/`
and `pixel-lens-mask-*-128/`. The three new runs each had all 179 manifest
hashes independently verified. Executed scripts are archived under
`isolation/alpha-interpolation-scripts/` and `isolation/mask-diagnostic-scripts/`;
manifest script entries refer to these immutable copies. Alpha provenance notes
record correction of script identities after source edits during execution.
These remain synthetic unrelated-camera previews. Separate mask full-size behavior, grid failure, nonfinite coordinates and
native OpenCL remain open; changed-aspect and inactive-modifier follow-ups
are recorded below. No production or pin change.

CPU mask bypass diagnostics: `--geometry --distort-mask --mask-bypass` builds
isolated plugins that call the actual `_distort_mask_lf` entry with a missing
lens, a zero crop factor, a lens with no maker, and inactive modifiers.
The inactive case disables corrections, uses unit scale and the lens projection,
and independently requires Lensfun to report no geometry flags. Each call uses
equal input/output ROIs and a local copy of the piece/data, leaving the active image transform
unchanged. NaN-initialized destinations must match the complete input byte for
byte, including the -0.5 and 1.5 values that active transforms clip. The checker
requires all four bypass cases for all three patterns and compares `MASK_BYPASS`
hashes between old and direct-coordinate plugins. This does not exercise
invalid ROI combinations or allocation/grid failure. The bicubic 128x95 run
passed all 24 assigned-profile/direction cases: 288 byte-exact bypass copies per plugin, 6,840 active mask rows,
2,280 image RGB rows, and exact final frames. All 179 run-manifest hashes were
independently verified; removing a bypass-pattern trace was rejected. Evidence:
`build/darktable-pin-review/pixel-lens-mask-bypass-expanded-bicubic-128/` (ignored).
No production code or pin changes.

Changed-aspect CPU mask follow-up: the same expanded bypass plugins and
bicubic checker passed 24 cases each at pixel aspects 0.75 (128x127) and
1.5 (128x63). Active masks matched 9,144 and 4,536 rows respectively;
image RGB matched 3,048 and 1,512 rows, and final frames were exact.
Each run also passed 288 byte-exact bypass copies per plugin. All 179 hashes
per run were independently verified with scripts unchanged throughout execution.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-aspect075-bicubic-128/`
and `pixel-lens-mask-bypass-aspect150-bicubic-128/`. This establishes bicubic synthetic
preview mask coverage at these aspects; the bilinear follow-up and remaining
gates are recorded below.
The old pin has no precomputed mask grid, so grid-failure diagnostics need a
candidate-only assertion rather than an old/direct trace-equality claim.

Bilinear changed-aspect CPU mask follow-up: the expanded bypass deployments
also passed all 24 cases at each aspect, 0.75 (128x127) and 1.5 (128x63).
Active mask rows matched 9,144/4,536, image RGB rows matched 3,048/1,512,
and final frames matched exactly. Each run passed 288 byte-exact bypass copies
per plugin. All 179 manifest hashes per run were independently verified with
scripts unchanged during execution. Ignored evidence:
`build/darktable-pin-review/pixel-lens-mask-bypass-aspect075-bilinear-128/`
and `pixel-lens-mask-bypass-aspect150-bilinear-128/`. Changed-aspect preview
masks cover bilinear and bicubic here; the Lanczos follow-up is below. Full-size masks, invalid ROIs,
grid failure and nonfinite coordinates remain open. No production or pin change.

Lanczos changed-aspect CPU mask follow-up: Lanczos2 and Lanczos3 each passed
24 cases at aspect 0.75 (128x127) and 24 at aspect 1.5 (128x63), using the
same expanded bypass deployments and unchanged checker. Each interpolator
matched 9,144/4,536 active mask rows and 3,048/1,512 RGB rows respectively,
with exact final frames and 288 byte-exact bypass copies per plugin per run.
All 716 manifest hashes across the four runs were independently verified.
Ignored evidence: `build/darktable-pin-review/pixel-lens-mask-bypass-aspect075-lanczos2-128/`,
`pixel-lens-mask-bypass-aspect150-lanczos2-128/` and corresponding `lanczos3` directories.
Changed-aspect synthetic preview masks now cover all four CPU interpolators.
Full-size masks, invalid ROIs, grid failure, nonfinite coordinates and native
OpenCL remain open. No production behavior or pin change.
