# Immage branch test plan

Build: **record the tested artifact commit** · `experiment/linux-webkit-renderer`

Run in order on Mac, Windows and Linux. Mark **PASS / FAIL / N/A**.
Record OS, CPU/GPU, RAM, build artifact, display scaling and window size.
Use RAW copies: a typical photo and a heavy edit with masks, texture,
sharpening and noise reduction. Use your normal window size; close busy apps.

1. **Install and launch.** Use the matching Mac ARM64 DMG, Windows x64 installer,
   or Linux x64/ARM64 AppImage. Open and edit a RAW.
   **Expect:** correct rendering, responsive controls, no crash.
   Experimental Linux WebKit builds need Ubuntu 26.04 or compatible newer libraries.

2. **Restart.** Quit with a photo open; relaunch. Repeat from the library grid.
   **Expect:** the last photo/grid returns, saved edits intact; no empty viewer.

3. **Compare previews.** Try Quality, Balanced 100%, Balanced 75%, Balanced 50% and Performance
   in Preferences → Performance. Drag Exposure and detail sliders; release.
   Check fit and 100% zoom.
   **Expect:** 100% Balanced avoids resolution shrinking; smaller previews can
   soften during dragging. Release restores the accurate full preview.

4. **Cached detail preview.** Compare Texture, Clarity, Contrast and Dehaze
   drags with Cached detail preview on/off. Allow two native renders, then
   move nearby values. Release; zoom, switch controls and switch photos.
   **Expect:** nearby cached previews follow the rendered detail; release is
   accurate. No stale frames or cached Exposure approximation remain.

5. **Detail loupe.** Check that its label/handle are hidden normally. Drag detail sliders on the heavy edit. Move the
   loupe if it appears, then release. Repeat with it disabled.
   **Expect:** slow previews can narrow to the selected area; release updates
   the whole view. Fast machines may never trigger the loupe.

6. **Clarity/Texture alternatives.** In Preferences → Modules → Custom, choose
   contrast & texture for both. Open a fresh photo where those tools are unused.
   Exercise all eight native controls, globally and in a mask; reopen the photo.
   **Expect:** matching controls, independent adjustments, local masks, saved edits.

7. **GUI benchmark.** Run it on the typical RAW at your normal window size.
   **Expect:** sliders return to their starting values; a report records timing,
   frame pacing and resources. Unavailable hardware counters are acceptable.

8. **Preview tuner.** Check the representative-RAW/window-size guidance. Choose
   FPS/latency targets and Find best preview. Cancel once; rerun, then Apply.
   **Expect:** starts at Quality, stops at the highest tested quality meeting
   both targets, restores settings before approval, and remeasures after Apply.
   Check the default 80 ms latency target and trimmed-median results.
   Try a demanding target: unmet targets must be clearly reported.

9. **Other tuner settings.** Change one included option at a time. Test available
   transport/scaling/cache controls and a GPU/memory change requiring relaunch.
   Record identical navigation before/after changing read ahead; test Immich
   originals if configured.
   **Expect:** changes apply, verification resumes after relaunch, navigation
   timing stays separate. AI and thumbnail-cache settings are excluded.

10. **Linux renderers — Linux only.** Compare available Automatic/Mesa/NVIDIA
    choices, relaunching and benchmarking the same photo/window each time.
    Compare standard/experimental builds where compatible.
    **Expect:** correct drawing, no flicker/blank frames; photo-GPU choice stays independent.

11. **Final checks.** Reopen edits, undo/redo and export. If available, disconnect
    a test network share while opening a RAW; reconnect and open a local photo.
    **Expect:** correct saved/exported images; share failure causes an error,
    not a crash, and local editing still works.

Send failures with **step number, expected/actual result, reproduction steps,
screenshot/recording and benchmark report**, plus machine/build details.
