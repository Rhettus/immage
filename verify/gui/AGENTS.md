# GUI verification agents

Read `README.md` here and the repository's `AGENTS.local.md` when present.
The initial Linux startup/Exposure runner exists; the broader suite remains
planned. Report only runs actually executed and distinguish smoke coverage
from the full scenario matrix.

Keep tests, shared setup and assertions checked in. Keep reports, screenshots,
fixtures copied for a run, app profiles and machine settings at the ignored
paths listed in the README. Never commit personal photo paths or private notes.

Exercise the visible Tauri window through actual pointer/keyboard actions.
Use real photo rendering for editing cases. Do not replace interactions with
state mutations or mark a headless/component check as a full-app GUI pass.

Before sending input, acquire the runner's exclusive desktop lock. Until that
mechanism exists, GUI execution requires an explicitly coordinated desktop.
Separate worktrees do not make shared mouse focus safe. Never stop another
agent's or the user's app to make a test pass.

Every run must identify its executable, environment and coverage, and retain
failure evidence. Report missing prerequisites and skipped coverage honestly.
Do not automatically accept screenshot references or retry away failures.

## App-only automation boundary

GUI automation may interact only with the dedicated test Immage process and
its main webview, through that run's WebDriver session. Verify the expected
app URL and main-window identity before each group of input actions. Abort if
the session navigates away, loses its expected window, or cannot establish its
identity. Never attach to the user's existing Immage session.

Use only WebDriver element/pointer/keyboard actions scoped to that webview.
No desktop-wide input tools, compositor control, global shortcuts, window
switching, clipboard access, shell-based UI input, OS/file-manager automation,
or interaction with other applications. Do not operate native file choosers;
launch with a copied fixture through Immage's supported file argument instead.

Capture only screenshots of the dedicated test application: its window,
webview or elements. Never capture the whole desktop or
other windows. Native-cursor/compositor observations are outside this suite's
boundary and must be reported as unverified or checked manually by the user.

JavaScript inspection is read-only: DOM, computed styles, geometry and canvas
pixels. Do not use it to call Tauri APIs, invoke engine commands, mutate app
state, inject input events or navigate to external pages. Tests must exercise
real controls. No arbitrary script or shell commands from local configuration.

The runner may start and stop only its own driver/app process tree and write
only its own fixture/profile/evidence directories. Never kill unrelated
processes, change desktop settings, read unrelated user data or modify originals.
If a case requires crossing this boundary, stop the case with a clear blocked
reason. Do not broaden access automatically to finish a test.

These are suite and agent instructions, not an OS sandbox for the coding agent.
Do not claim they technically revoke access to tools the agent still possesses.
