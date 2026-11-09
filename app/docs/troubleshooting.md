# Troubleshooting and reporting issues

Report problems through the [GitHub bug report form](https://github.com/Rhettus/immage/issues/new?template=bug_report.yml).
Search [existing issues](https://github.com/Rhettus/immage/issues) first; if someone
has reported the same problem, add your details there.

## Suggesting a feature

Use the [feature request form](https://github.com/Rhettus/immage/issues/new?template=feature_request.yml)
to suggest an improvement. Search existing issues first and add your use case
to an existing request when it matches your idea. Describe the problem, your
proposed change, and how it would benefit Immage users.

Requests are reviewed for their benefit to Immage and prioritized accordingly.
Submitting a request does not guarantee inclusion or an implementation timeline.

## What to include in a bug report

- [ ] **Immage version and build commit** from **Preferences → About**.
- [ ] **What you were doing** when the problem happened: the photo or folder
  you opened, the tool or control you used, and the steps leading up to it.
- [ ] **Expected and actual behavior**, including exact error messages,
  how often it happens, and the approximate time of the problem.
- [ ] **Operating system and version**. On Linux, include the distribution,
  desktop environment (such as GNOME or KDE Plasma), and Wayland or X11 session.
- [ ] **Screenshots** for interface problems, including display scaling and
  the control involved.
- [ ] **GUI benchmark JSON** for performance problems (instructions below).
- [ ] **engine.log** for crashes (instructions below).

Report the problem even if you cannot collect all this information. Say which
diagnostics are unavailable and why. Logs and benchmark reports may contain
local file paths and machine details; review attachments before posting them
publicly. Share photos or sidecars only if you are comfortable making them public.

## Performance problems

Describe what feels slow and roughly how long it takes. Include your CPU, GPU,
RAM, display scaling, and relevant **Preferences → Performance** settings.

1. Open a copy of a photo that shows the problem.
2. Open **Preferences → Performance → Measuring → GUI benchmark → Run**.
3. Wait for it to finish and attach the JSON report from the path shown in
   the status bar. Installed builds save reports in the app data folder's
   `benchmarks` folder, beside `engine.log` (locations below).

The benchmark moves sliders and zooms the photo. Sliders return to their starting
values, but benchmark moves can add history, so use a copy. For comparisons,
keep the same photo, window size, display scaling and preview settings, and
identify the app version and settings used for each report.

See [Performance preferences](preferences.md#performance) for settings and
Linux launch and rendering troubleshooting. If the benchmark fails, include its
error and describe the slow action instead.

## Crashes

Attach **engine.log** and describe the last action before the crash, the time,
and whether the whole app closed or the photo engine stopped responding.
Collect the log promptly: it survives restarts, but is reset on engine startup
once it exceeds 5 MB. It may not explain every application crash; still report
what happened if it is missing or has no relevant error.

For installed builds:

| Platform | Log location | How to open the folder |
| --- | --- | --- |
| Linux | `~/.local/share/app.immage/engine.log` | Open `~/.local/share/app.immage` in your file manager. If `XDG_DATA_HOME` is set, use `$XDG_DATA_HOME/app.immage` instead. |
| macOS | `~/Library/Application Support/app.immage/engine.log` | In Finder, choose **Go → Go to Folder** and paste `~/Library/Application Support/app.immage`. |
| Windows | `%APPDATA%\app.immage\engine.log` | Paste `%APPDATA%\app.immage` into File Explorer's address bar. |

Development builds keep the log at `build/app-runtime/engine.log` and GUI
benchmark reports in `benchmarking/results/gui`, relative to the checkout.
