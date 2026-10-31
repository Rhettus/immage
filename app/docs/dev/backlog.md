# Backlog

## Full-size adaptive preview performance

Preference: keep previews at 100% with adaptive caching whenever measured frame
rate and latency meet the user's targets. Release must always render exactly.

- [x] Prefer Balanced 100% with adaptive caching in the performance tuner before native and smaller previews; exclude full Quality from the search while keeping it available manually. Keep measured target checks and restore the original settings after trials.
- [x] GPU interpolation: retain native anchors as textures and blend with a shader, avoiding full-image JavaScript allocation, interpolation and canvas upload on every slider event. Native accuracy checks and CPU fallback remain. `verify/cached-preview-gpu.mjs` compares both paths at 1080p and 4K and checks pixels, texture reuse and context recovery; hardware and cross-platform GUI measurements remain to be collected.
- [x] Display-frame scheduling: coalesce cached slider feedback with `requestAnimationFrame`, computing and drawing only the latest value once per display frame on GPU and CPU fallback paths. Preserve native refresh scheduling, cancel obsolete callbacks and render exactly on release. Browser checks exercise 100 inputs producing one draw on both paths.
- [x] Accuracy-based native refresh: lengthen refresh intervals for reliable predictions and shorten them as error rises, with bounded intervals and periodic native validation. Uses native error to scale the timing seed by 0.5–2, bounded to 40–320 ms. Synthetic checks cover scheduling and error response; real-image drift and responsiveness measurements remain required before changing the 320 ms cap.
- [x] Prediction recovery: after an accuracy failure, retrain from fresh native anchors and resume estimates when reliable, rather than disabling them for the remainder of the drag. Discard failed pairs, require two consecutive low-error private native checks before resuming, and stop recovery after three accuracy failures per drag. CPU cost failures remain disabled until release.
