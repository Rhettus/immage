# Releasing

A release is a tag. Pushing `v<version>` runs
[release.yml](../../../.github/workflows/release.yml), which builds the
three platforms from scratch, signs the updater's bundles, makes the source
archive, and leaves a **draft** release with all of it attached. Nothing
reaches users until you publish that draft.

## Cutting a release

1. **Bump the version** everywhere it is kept. The tag run fails if any
   of them disagrees with the tag:
   - `app/package.json` and `app/package-lock.json`: run
     `npm version 0.32.0 --no-git-tag-version` in `app/`
   - `app/src-tauri/tauri.conf.json`: `"version"`
   - `app/src-tauri/Cargo.toml`: `version`, then `cargo check` in
     `app/src-tauri/` so `Cargo.lock` follows
2. **Write the release notes.** Add a `## 0.32.0` section to
   [RELEASE_NOTES.md](../../../RELEASE_NOTES.md), above the previous one.
   That section, and nothing else in the file, becomes the text of the
   GitHub release and what the update banner shows under Release Notes.
   Write what the user gets, not how it was done. Line breaks inside a
   paragraph or a list item are joined, so wrap the file as you like.
3. **Run the release checks** on the commit to be released, with the
   engine built from it:

   ```bash
   cmake --build build && python3 -I verify/run.py
   ```

   About 5 minutes; every slider, global and on a mask, a saved edit
   opened again, and the main timings against the last run
   ([verify/README.md](../../../verify/README.md)). Don't tag while
   anything fails, unless the report's failure is understood and written
   down.
4. **Merge to `main`** as for any change, and wait for CI to pass.
5. **Tag** the commit on `main`:

   ```bash
   git tag v0.32.0 && git push origin v0.32.0
   ```

6. **Wait for the release run** (Actions › release, about 30 minutes). It
   fails early when the tag and a version disagree or the notes section is
   missing, and at the end when a platform's bundle has no signature.
7. **Try the draft.** Download the macOS `.dmg`, the Windows installer and
   the AppImage from the draft release, and open each one. Check the
   release text, and edit it on GitHub if it needs it (that edit does not
   reach the banner, which reads `latest.json`; fix RELEASE_NOTES.md too).
8. **Publish** the draft. From then on
   `/releases/latest/download/latest.json` points at it, and installed
   copies offer the update at their next daily check. Then run
   `python3 -I verify/run.py --accept --skip-perf`, so the next release's
   checks compare old edits with this one's.

## When something goes wrong

- **The release run fails before publish:** fix the cause on `main`,
  then move the tag to the new commit and push it again:

  ```bash
  git tag -f v0.32.0 && git push -f origin v0.32.0
  ```

  A re-run for a tag that already has a draft replaces the draft's files
  and text. A run never touches a release that has been published.
- **A published release is bad:** turn it back into a draft, or mark it a
  pre-release. GitHub's "latest" skips both, so the feed falls back to the
  previous release and no more copies update to the bad one. Copies that
  already updated stay on it until a fixed version is released, so ship
  the fix as a new version and do not reuse the number.

## The signing key

The updater installs only bundles signed with the key whose public half
is in `tauri.conf.json` (`plugins.updater.pubkey`). The private key and its
password are the repository's Actions secrets `TAURI_SIGNING_PRIVATE_KEY`
and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, with the maintainer's copy in
`~/.tauri/immage.key` and `~/.tauri/immage.key.password`.

Keep a backup of both. If the key is lost, no installed copy can ever
update again, and every user has to download a new version by hand.

Each secret must hold exactly its file, with nothing before or after it.
Copy it with `pbcopy < ~/.tauri/immage.key` (and the same for the
password) and paste that, rather than selecting text in an editor. A
secret with anything extra fails the builds at the very end, with "failed
to decode base64 key: Invalid symbol".

## The source offer

Each release attaches `immage-<version>-source.tar.gz`
([scripts/source_archive.sh](../../../scripts/source_archive.sh)), and its
text offers, for three years, the source of any GPL or LGPL library in the
binaries. If someone asks, Preferences › About lists each bundled library
with its version and where its source is published: fetch that version
from Homebrew, MSYS2 or Ubuntu and attach it to the issue.

## Moving darktable

A release that moves the darktable pin needs the checks in
[Pinning darktable](darktable-pin.md) before it is tagged.
