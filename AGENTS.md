# Local instructions

Read `AGENTS.local.md` in this directory when it exists. It contains personal,
machine-specific instructions and is intentionally excluded from Git. Keep
shared project instructions in this tracked file so all agents can find them.

# Release notes

Update `RELEASE_NOTES.md` for user-visible changes, including performance work.
Add entries to the current unreleased or experimental section and describe the
final behavior; remove or revise entries when features are changed or removed.

Follow the format of previous releases:

- Keep version titles as Markdown level-two headings.
- Use plain section labels: `Improvements`, `Performance`, and `Bug fixes`.
  Include only sections that have entries.
- Put performance changes under `Performance`, other new features and
  enhancements under `Improvements`, and corrections under `Bug fixes`.
- Leave a blank line before each section's bullet list, use contiguous bullets
  without blank lines between entries, and wrap continuation lines with two
  spaces of indentation.
- Write concise descriptions of what changes for the user. Group related commits
  into one entry where useful; release notes do not need one bullet per commit.
- Commit the release notes in the same commit as the change they describe, not
  in a commit of their own. `darktable/AGENTS.md` asks for a separate
  `RELEASE_NOTES.md` commit; that applies only to darktable's own
  `RELEASE_NOTES.md`, for changes sent upstream to darktable.

# Documentation

Whenever adding or changing a feature, update the user guide in `app/docs/`
as part of the same change. Describe the final behavior, settings and
interactions for users, and revise outdated related guides and the project README.
Documentation updates are required alongside the release notes.

Keep agent implementation notes, status, verification run notes and handoffs in
the gitignored `notes/` directory. Do not add these to `app/docs/`; that directory
is reserved for user-facing documentation.
