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

The easiest way to gather the last three is a [support bundle](#support-bundle).

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

## Support bundle

**Help > Create Support Bundle…** collects what a bug report needs into one
.zip file. The same button appears beside the "the engine exited" message and
the "The engine keeps stopping" notice.

The bundle holds:

- **engine.log**, the whole log of the photo engine;
- **system.json**: Immage's version and build, the darktable version, an
  anonymous computer id, the operating system, processor, memory, graphics
  and OpenCL details;
- **preferences.json**: the preferences you have set;
- **benchmark.json**, only when you add a GUI benchmark report with
  **Add GUI Benchmark Report…** (pick one from the GUI benchmark folder).

Before anything is saved, Immage replaces private information with
placeholders: your user and computer names (`<user>`, `<host>`), your home
folder (`~`), folder and photo names (`folder-1`, `photo-1.ARW`), email
addresses, web addresses with credentials or private hosts, serial numbers and
other paths in user folders. The same name always gets the same placeholder, so
the log still reads sensibly. Timestamps are left alone.

The dialog shows the text of each file and how many replacements were made.
Click a line to leave it out of the bundle (it is struck through; click again to
bring it back), or Shift-click to leave out a range. **Save…** asks where to
put the file, named `immage-support-<date>.zip`. Nothing is uploaded; attach
the file to your issue yourself. Check the text before you save: the
replacement finds what it can, and you decide what is shared.

## Resetting settings

To start Immage with default settings, quit Immage and move `settings.json`
out of the app data folder (see
[Where settings are kept](preferences.md#where-settings-are-kept)), then start
Immage again. Keep the moved file if you may want those settings back: put it
back, with Immage closed, to restore them. Your photos and their edits are not
affected. To keep your settings first, use Preferences > General > **Backup**;
a restore keeps copies of what it replaces in the `backups` folder of the app
data folder, so you can undo it.

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

## The engine stops or does not answer

Photo editing runs in a separate engine. If it stops, Immage starts a new one
by itself and shows "Restarting the engine…" while it does. Afterwards it
reopens the folder or search you were viewing, with its filter, the soft proof
setting and the Before view. It also reopens the photo you had open, from its
last save, and then shows one of these messages:

- "The engine restarted. The photo was reopened from its last save; undo
  history was cleared." This is shown when a photo was open.
- "The engine restarted." This is shown when no photo was open.

Edits made in the last second or so before the stop may be lost, because they
had not been saved yet. Exports that were running fail with "the engine
restarted" and can be run again. Export holds and printer profiles you added
while Immage was running are not restored; add them again.

If the engine stops again while the same photo is reopening, that photo is not
opened again, and Immage shows "The engine stopped again while opening <file>.
It was not reopened." Open it again yourself once you have checked the file.

If the engine keeps stopping, Immage stops restarting it and shows "The engine
keeps stopping. Restart Immage to continue editing." Close Immage and open it
again. Then attach **engine.log** as described in [Crashes](#crashes).

Sometimes the engine is working but takes much longer than usual to answer,
for example while rendering a very large photo. Immage then shows "The engine is not
answering." with two buttons:

- **Wait** keeps waiting. The message goes away when the engine answers.
- **Restart** stops the engine and starts a new one, reopening the photo as
  described above. Running exports fail and can be run again.

Nothing is stopped automatically, so use **Wait** unless the work seems stuck.
