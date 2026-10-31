# Backlog

## Full-size adaptive preview performance

Preference: keep previews at 100% with adaptive caching whenever measured frame
rate and latency meet the user's targets. Release must always render exactly.

- [x] Prefer Balanced 100% with adaptive caching in the performance tuner before native and smaller previews; exclude full Quality from the search while keeping it available manually. Keep measured target checks and restore the original settings after trials.
- [x] GPU interpolation: retain native anchors as textures and blend with a shader, avoiding full-image JavaScript allocation, interpolation and canvas upload on every slider event. Native accuracy checks and CPU fallback remain. `verify/cached-preview-gpu.mjs` compares both paths at 1080p and 4K and checks pixels, texture reuse and context recovery; hardware and cross-platform GUI measurements remain to be collected.
- [x] Display-frame scheduling: coalesce cached slider feedback with `requestAnimationFrame`, computing and drawing only the latest value once per display frame on GPU and CPU fallback paths. Preserve native refresh scheduling, cancel obsolete callbacks and render exactly on release. Browser checks exercise 100 inputs producing one draw on both paths.
- [x] Accuracy-based native refresh: lengthen refresh intervals for reliable predictions and shorten them as error rises, with bounded intervals and periodic native validation. Uses native error to scale the timing seed by 0.5–2, bounded to 40–320 ms. Synthetic checks cover scheduling and error response; real-image drift and responsiveness measurements remain required before changing the 320 ms cap.
- [x] Prediction recovery: after an accuracy failure, retrain from fresh native anchors and resume estimates when reliable, rather than disabling them for the remainder of the drag. Discard failed pairs, require two consecutive low-error private native checks before resuming, and stop recovery after three accuracy failures per drag. CPU cost failures remain disabled until release.

## UI performance audit — 2026-10-31

User requested separate commits for items 1 and 2. Preserve the remaining work
in this order; priorities are code-inspection estimates, not measured savings.
Validate with matching GUI benchmark builds on Linux, macOS and Windows. The
reported ~95% WebKit core utilization predates these changes; do not claim a
measured reduction until new reports exist.

1. Implemented: bound slider-driven App publications to display frames, isolate
   histogram subscriptions, and memoize unrelated panels/unchanged sliders with
   current callbacks and dependent tracks. The App shell still renders when its
   published values change; further extraction should follow measured costs.
2. Implemented in a separate commit: adaptive prediction validation has its own
   worker queue, is submitted after native frame delivery, and does not hold the
   render pump. Cache/generation/anchor guards reject obsolete results; accuracy
   recovery and exact release behavior remain.
3. Implemented: compute prediction error directly without allocating a predicted
   frame, preserving every RGB pixel and the existing rounding/error thresholds.
   Retain at most three validation frames in the worker; consecutive validations
   transfer only the new native frame instead of all three. Original renderer
   buffers remain available for failure/timeout fallback. Histogram input
   reduction remains a possible follow-up alongside item 5; its existing sample
   positions and spatial scope input are unchanged. Kernel/worker checks and the
   frontend build pass; matching GUI CPU measurements remain outstanding.
4. Implemented: exact A=B GPU draws preserve the preceding compatible anchor.
   The next estimate reuses both textures; the pool evicts the least recently
   used unrequested anchor before an upload, retaining at most two textures
   within the existing 256 MiB limit. Dimension changes, reset and context loss
   clear incompatible resources. Chromium/SwiftShader browser checks pass at
   1080p and 4K, including pixel parity, reuse, eviction and context recovery;
   hardware WebKit and cross-platform GUI measurements remain outstanding.
5. Implemented: histogram/scope inputs coalesce to the latest native frame at
   12.5 Hz during interaction, before any pixel copy. Release flushes pending
   input and final frames bypass the cadence delay. Auxiliary copies run in a
   deferred task after preview drawing; a separate histogram worker avoids
   blocking clipping jobs. Photo/crop changes and unmount cancel pending work.
   Cadence/release/cancellation tests and the frontend build pass; GUI CPU
   measurements remain outstanding.
6. Coalesce engine slider submissions per display frame and ignore unchanged
   values. Preserve immediate thumb feedback, final-value flushing, undo grouping,
   keyboard/wheel/fine adjustment behavior, and batched multi-control wheel edits.
   UI publication coalescing in item 1 deliberately keeps engine edits immediate.
7. Reduce repeated final-frame canvas/placement work: avoid unconditional base
   canvas resize, duplicate uploads and unchanged style writes; defer secondary
   navigator/base updates where appropriate without exposing stale images.
8. Tie async clipping and histogram results to the displayed frame generation.
   Matching session/dimensions/settings does not prove an overlay matches the
   pixels currently visible, especially across GPU estimates and native frames.
