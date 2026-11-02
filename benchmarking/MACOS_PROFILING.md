# Mac CPU capture

Run Apple's Time Profiler while Immage runs its existing GUI benchmark. This
collects CPU evidence for the app, engine and WebKit helpers without changing
preferences or automating the desktop. Full Xcode is required; Command Line
Tools alone may not include Instruments. Confirm `xcrun xctrace list templates`
lists `Time Profiler`. Allow macOS's profiling authorization if prompted. The
script does not use sudo or change permissions/settings.

1. Open the exact Immage build to investigate, open a copied photo, and let
   loading finish. Keep its matching app/engine binaries and any dSYMs; stripped
   symbols may limit attribution. Record build commit, photo, viewport, display
   scale, preview settings and GPU setting. Use the same configuration as the
   earlier native benchmark.
2. From this checkout run:

   ```sh
   python3 -I benchmarking/capture-macos.py \
     --output benchmarking/results/mac-cpu-01 --seconds 600 --all-processes
   ```

   The output directory must be new. This explicitly captures **all processes**,
   including unrelated apps. Close unrelated workloads first; review the trace
   before sharing. `--pid 123` instead limits capture to one process, but misses
   the engine and WebKit helpers in other processes.
3. Wait for xctrace's recording-start message. Run **Preferences → Performance →
   Measuring → GUI benchmark** once. Keep Immage visible, avoid other work and
   do not resize it. The script stops recording automatically at the time limit;
   choose a duration long enough to cover the complete benchmark. Leave a short
   idle interval before and after the workload. Do not interrupt the script
   merely because the benchmark has finished.
4. Copy the benchmark JSON into the capture directory. Keep `cpu.trace`,
   `cpu-stacks.xml`, `toc.xml`, `capture.json` and process snapshots together.
   If XML export fails, the original trace remains available in Instruments.
   A successful export is not proof that samples or symbols are complete.
5. Retain the existing same-build unprofiled benchmark as an overhead reference.
   If one is unavailable, collect a separate matching unprofiled run. Compare
   frame dimensions, completed frames, latency and backgrounding before treating
   the profiled run as representative.

Native execution of this script still needs validation on a Mac. No Mac capture
has been collected by adding it. The script's terminal output includes the real
recording-start message; metadata timestamps bracket the **command**, not the
exact trace start. Use the trace's own time origin for analysis. Benchmark resource
samples and phases provide wall-clock timestamps; frontend/native/engine clocks
are independent and must not be equated. Correlate render stages by request ID,
then locate phase windows in the trace using its recording time and the report's
wall-clock phase/resource observations. Check that the entire benchmark is covered.

## Evidence and implementation plan

First rank CPU samples by process, thread and leaf function, retaining callers.
Filter WebKit helpers using trace process identity and benchmark evidence; parent
PID snapshots alone may miss XPC-managed processes. Report missing symbols and
unattributed samples rather than assigning them to a guessed stage. CPU sampling
is statistical: it does not enumerate every operation or directly explain GPU
execution or blocked waits. Native stacks may not resolve JavaScript functions;
if WebKit's JS/GC dominates, follow with a focused Web Inspector JavaScript
recording. If GPU/compositor work dominates, use a separate graphics capture.

For each expensive benchmark phase, produce:

| Finding | Evidence to retain | Decision |
|---|---|---|
| Serial engine/module work | Thread, leaf/caller samples, module timing, dimensions | Split independent rows/tiles only where dependencies permit |
| OpenMP overhead/spinning | Runtime stacks, worker CPU, useful module work | Tune task size/team use; adding threads may worsen it |
| Conversion, first touch or copies | Conversion/memory stacks and bytes per frame | Remove passes/copies before parallelizing bandwidth-bound work |
| Rust and webview transport | Read/IPC stacks, transport events and retries | Move independent reads or redesign buffer ownership |
| Canvas upload/rasterization | WebKit stacks plus canvas timings | Prototype worker-owned OffscreenCanvas if supported |
| JS, React or garbage collection | JS profile, frontend counts and allocation evidence | Reduce repeated work/allocations; move independent compute |
| Waiting or GPU stalls | Elapsed spans vs sampled CPU; follow-up graphics evidence | Fix dependencies/queueing instead of treating wait time as CPU |

Prioritize by sampled self CPU and impact on the render critical path. Record
expected benefit, thread/API constraints, buffer lifetime, cancellation and stale
frame behavior for each proposal. Validate one change at a time with matching
unprofiled runs; preserve image quality and compare completed frames as well as
latency. Existing histogram/clipping workers are already parallel; inspect
`workerFallback`, `pixels.copy` and worker timings before proposing more workers.
Do not add overlapping stage timings or nested stack percentages together.

Apple's [Time Profiler explanation](https://developer.apple.com/videos/play/wwdc2025/308/)
describes sampling running threads. The [Chromium Mac debugging guide](https://chromium.googlesource.com/chromium/src/+/master/docs/mac/debugging.md)
documents the system-wide xctrace capture command used here.
