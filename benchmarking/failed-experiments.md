# Failed experiments

## Adaptive cached preview — removed November 1, 2026

Decision: remove the experiment, its setting and its performance tuner choices.
Keep native adaptive preview sizing, native detail loupe rendering, exact output
on release, and the three-checkpoint native retention policy.

The experiment interpolated display RGB pixels between two native renders to
provide nearby slider feedback. It used WebGL blending with CPU/worker fallback,
periodic native anchors, bounded extrapolation, prediction-error validation and
private recovery after failed predictions. Accurate release output did not make
intermediate feedback acceptable: the user reported visibly worse results than
with caching disabled.

Paired GUI reports from clean commit `0748d9a`:

- Off: `gui-2026-11-01T00-56-54.json`
- On: `gui-2026-11-01T00-58-01.json`

Both used `2EM10375.ORF`, Apple M4/macOS, the same 2516×1784 DPR2 viewport,
50% Balanced preview, GPU edits enabled, and matching other recorded settings.
Both remained foregrounded with approximately 59 Hz browser callbacks and no
callbacks over 50 ms. Diagnostics reported no dropped records or unfinished work.
The reports are local benchmark artifacts, not committed fixtures.

| Pooled drag-labelled edit samples | Off | On |
| --- | ---: | ---: |
| Displayed samples | 634 | 298 |
| Median input-to-rAF latency | 44 ms | 100.5 ms |
| P95 latency, nearest rank | 116 ms | 311 ms |
| Samples over 200 ms | 3 | 51 |
| Native demosaic executions during drags | 2 | 7 |
| Peak engine RSS | 1.50 GiB | 2.28 GiB |

The enabled result includes 55 estimated frames (median 26 ms); native-only
frames had a 115 ms median. Fast predictions did not offset the native cost.
Using the tuner's strict drag phase windows gives 44/115 ms median/P95 and
30.30 FPS off, versus 100/294 ms and 20 FPS on. rAF is a callback proxy, not
proof of compositor presentation.

The cache path requested full-view 2298×1720 native anchors instead of the usual
1149×860 selected preview, adaptive 804×602 draft, or 480×480 loupe. A typical
anchor therefore had four times the selected preview's pixels. It bypassed
normal draft-size adaptation and loupe selection while a detail cache existed.
The enabled run recorded 382 memory-budget evictions, including six scaled
checkpoints; the disabled run recorded none. Protection against ordinary
replacement deliberately does not prevent memory-driven eviction.

This was one sequential pair in the same engine process, with the enabled run
starting at higher RSS. Memory peaks are observations, not isolated allocation
or leak measurements. These results do not prove interpolation can never help
on other hardware or under a different design. They do show this implementation
failed its responsiveness and visual-quality goals in the tested configuration.
A future experiment would need an explicit quality criterion and equal preview
geometry before claiming an interpolation benefit.
