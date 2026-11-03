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
matrix are exact RGB; exceptional-profile whole-image coverage remains pending.
