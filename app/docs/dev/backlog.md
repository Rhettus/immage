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
3. Reduce worker input copies: validation currently copies three full images and
   allocates a full predicted frame to inspect sampled error. Compute prediction
   error directly at sample positions; consider retaining anchors in the worker
   and reducing histogram inputs while preserving sampling quality.
4. Retain reusable GPU anchor textures across exact native refreshes. Drawing
   an exact frame as A=B currently retires the older anchor; the next estimate
   may upload it again. Bound the texture pool and test memory/context recovery.
5. Give histogram/scope updates a slower interactive cadence (e.g. 10–15 Hz),
   always update after release, and prioritize preview work over auxiliary
   pixel jobs. Subscription isolation alone does not reduce computation rate.
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
