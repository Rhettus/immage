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

# Documentation

Whenever adding or changing a feature, update both the user guide in
`app/docs/` and the developer documentation in `app/docs/dev/` as part of
the same change. Describe the final behavior, settings and interactions for
users, and the relevant architecture, code paths and verification for developers.
Revise or remove outdated descriptions in related guides and the project README.
Documentation updates are required alongside the release notes.
