# GUI verification agents

Read `README.md` here and the repository's `AGENTS.local.md` when present.
The README currently describes a plan: do not report the suite as implemented
or invent successful runs of its proposed commands.

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
