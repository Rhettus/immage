# GUI performance tracing

The existing [slider sequence](diagrams/slider-sequence.svg) describes the
three-process rendering flow. This diagram shows the diagnostic points:

```mermaid
flowchart TD
    Input[Input ID, control, active operations] --> Coalesce[Coalescing wait span]
    Coalesce --> Pump{Render pump available?}
    Pump -->|busy| Wait[Blocking command, render or base-wait span]
    Wait --> Cancel[Base cancellation requested / signal sent]
    Cancel --> Pump
    Pump -->|available| Throttle{Adaptive refresh due?}
    Throttle -->|later| Timer[Throttle wait span]
    Timer --> Pump
    Throttle -->|now| Decision[Requested and selected view / reason]
    Decision --> Request[Render start: request and represented input IDs]
    Request --> Lock[Native mutex wait, owner and release spans]
    Lock --> Native[Engine pipeline, module timings and transport]
    Native --> End[Render end / cancelled / failed]
    End --> Stale{Frame still eligible?}
    Stale -->|no| Discard[Discarded frame and reason flags]
    Stale -->|yes| Draw[Frame ID and source; draw start / end / skipped]
    Draw --> RAF[Next animation callback: latency sample]
    Input --> Cache[Cache eligibility, validation and recovery decisions]
    Cache --> Estimate[Estimate rejected / cancelled / worker span]
    Estimate --> Draw
```

## Collection

Run the existing GUI benchmark in Preferences → Performance → Measuring. Report
schema 8 includes diagnostics by default, independently of the overlay. For an
overhead comparison, set `localStorage.setItem("immage.perfDiagnostics", "0")` in
the webview developer console before a run; set it to `"1"` to restore diagnostics.
This leaves legacy timing, resource and frontend-work metrics enabled. Alternate
multiple on/off runs with fixed photo, edits, viewport, display and preferences.
Unit tests do not establish profiler overhead on a user's hardware.

## Report fields

- `build`: compile-time Git commit and tracked-dirty state, or null when metadata
  is unavailable. A dirty commit does not uniquely identify source contents.
- `diagnostics.events`: frontend `performance.now()` timestamps and monotonic IDs.
  At most 30,000 events are kept. `droppedEvents` and `unfinished` expose gaps.
- `diagnostics.native`: up to 30,000 engine-mutex spans on an independent native
  clock, with wait, acquisition and release markers, operation names, render
  request IDs, dropped counts and unfinished operations. The release marker
  precedes guard destruction; tracing/unlock overhead can remain unattributed.
- Sample `diagnostic`: frame ID, request ID where applicable, first/latest
  represented input IDs, first-input timestamp, source and dispatch-phase label.
  Sources are `native`, `engine-reuse`, `local-reuse` and `estimated`.
- `latestInputLatency` / `oldestInputLatency`: callback time minus represented
  input timestamps. New input during rendering is not represented in that frame.
  Legacy `total` retains its existing start: the native batch's oldest input or
  an estimate's latest input. Legacy labels and tuner metrics remain unchanged.
- `moduleTimings.status`: pending, complete or unavailable. During diagnostics,
  timings are retrieved by request ID so a later render cannot replace the
  frame's module costs. The bounded pending-module store reports evictions as
  `droppedModuleTimings`.

`command` spans identify auxiliary calls. Commands awaited by the pump carry
`blockingPump`; concurrent saves do not. Coalescing, base waiting and adaptive
throttling have separate elapsed spans. Render events record geometry and
input attribution. `preview.decision` / `preview.selected` explain size changes.
Cache events show replacement, validation results, recovery state and rejected
estimates. Estimate-worker spans include off-thread waiting, not just compute.
Shared-transport events identify retries and failures. Hooks do no console logging.

`preview.decision` reports `detail-loupe` when a native detail or grain drag
starts directly in the loupe. Cached detail previews retain their whole-image
anchor path. Compare first frames and queue delays separately from sustained
frames when checking this policy; full-view probe frames no longer precede the
loupe. The native cache patch retains the scaled GPU checkpoint rather than
the full-resolution input to scaling. Check both `demosaic` and
`demosaicscale` costs on subsequent downstream edits at the same geometry;
size changes can still require upstream processing. Pipe debug logs identify
the retained checkpoint with `scaled_input`. Compare process memory as well
as latency.

For repeated raw processing, launch the engine with separate `-d perf -d pipe`
arguments (the verification harness enables these with `pipeTrace`). Headless
`checkpoint lookup` lines for `demosaic` and `demosaicscale` include pipe identity, run number,
ROI, full lookup `hash`, ROI-independent parameter `state`, bytes, hit status,
and mask/detail/Scharr state. A changed full hash with unchanged parameter state
requires checking ROI and the other reported fields; it does not establish an
upstream edit. `cache replace`, `cache invalidate`, `cache clear`, and
`cache evict` lines record the affected hashes so a missing buffer can be traced
to replacement, explicit invalidation, or memory trimming. These are opt-in
native debug logs; GUI benchmark JSON does not collect them.

`demosaicscale.modify_roi_in()` requests the whole input at scale 1 even when
its output is a smaller preview. Preview geometry changes therefore do not by
themselves prove that demosaic geometry changed. A GPU checkpoint must preserve
its buffer against subsequent in-place colorspace conversion and blending,
respect device ownership and memory limits, and invalidate with upstream
state. Existing per-module GPU inputs are released after processing; a cache
importance hint alone cannot retain GPU storage across requests.

A CPU probe on `nikon.NEF` with successive exposure edits and requested draft
sizes 1000x750, 1000x750, 700x525, 1000x750 confirmed that the smaller render
missed the scaled checkpoint but hit the same demosaic hash and full-resolution
ROI (4286x2844). Only scaling reran; returning to the larger size hit the old
scaled checkpoint. This establishes that geometry changes can reuse the
demosaiced CPU buffer. It does not explain individual macOS GPU misses; those
need the native logs above from the affected machine.

Cancellation request and signal-sent events are separate. Signal-sent means the
cancel command was written, not that rendering stopped. Render cancelled/end
outcomes and native release spans show completion; stale completed base frames
are explicitly discarded.

## Analysis and timeline export

```bash
python3 -I benchmarking/diagnose.py /path/to/gui-report.json \
  --json /tmp/gui-analysis.json --trace /tmp/gui-trace.json
```

Older reports remain readable. The analyzer separates first frame, sustained drag
and release by phase, source and actual dimensions; P95 uses nearest rank. Grouped
frame intervals may skip intervening frames of another source or size, so they
are not the tuner's whole-phase FPS measurement.

Slow frames include stages, largest module costs, frontend queue blockers and
native lock owners. Blocker intervals can overlap: covered time uses their union,
and uncovered time remains unattributed. Dropped/unfinished spans reduce coverage.
The analysis also includes cancellation completion delays and frame/estimate
outcome counts.

`--trace` writes separate Chrome trace-event files for Perfetto or Chrome's trace
viewer: the frontend file and a sibling `gui-trace.native.json`. Their clocks are
not aligned; request IDs connect them. Frontend lanes show elapsed asynchronous
operations, not CPU-execution tracks.

## Measurement boundaries

The native trace covers every acquisition of the app's main engine mutex,
including auxiliary commands. Tagged thumbnails, imports, exports and AI jobs use
separate engine threads outside that mutex. Their hardware contention cannot be
proven from mutex ownership alone.

The legacy `paint` field measures the next animation callback, not actual screen
presentation or input-to-photon latency. Those need platform profiling or external
measurement. CPU/GPU saturation and memory-bandwidth contention also need platform
profiling; recorded waiting and module wall times establish where to investigate.
