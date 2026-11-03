# Releasing

A release is a tag. Pushing `v<version>` runs
[release.yml](../../../.github/workflows/release.yml), which builds
macOS, Windows and Linux (x86-64 and ARM64), reuses dependency caches, signs the
updater's bundles, makes the source archive, and leaves a **draft** release
with all of it attached. Nothing
reaches users until you publish that draft.

A release is made entirely on its branch, `release-<version>`: the work,
the version bump, the checks and the tag. Nothing is pushed or committed
to `main` directly; `main` takes the branch through its pull request once
the release is published.

Windows builds produce only the NSIS `-setup.exe` installer, configured in
`app/src-tauri/tauri.windows.conf.json`. The build uploads its `.exe` and updater
signature; `scripts/release_assets.py` requires that installer and publishes
`windows-x86_64` and `windows-x86_64-nsis` feed entries. It does not require or
publish MSI artifacts. The generic key remains available to the updater's
fallback lookup from older MSI-installed copies; the updater detects the
installer format from the downloaded bytes. Test assembly without an MSI using
`python3 -I scripts/test_release_assets.py`.

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
   Entries are written along the way, with each change, but left out of
   that change's commit: the section goes in as one commit per release,
   `RELEASE_NOTES.md: 0.32.0`.
3. **Run the release checks** on the commit to be released, with the
   engine built from it:

   ```bash
   cmake --build build && python3 -I verify/run.py
   ```

   About 10 minutes; every slider, global and on a mask, a saved edit
   opened again, and the main timings against the last run
   ([verify/README.md](../../../verify/README.md)). Don't tag while
   anything fails, unless the report's failure is understood and written
   down.
4. **Open the pull request and push the tag together.** The pull request
   goes from `release-0.32.0` to `main`; don't merge it yet. The tag goes
   on the branch's last commit, the one the checks ran on:

   ```bash
   git tag v0.32.0 && git push origin v0.32.0
   ```

   The pull request's CI and the release run then go at the same time
   rather than one after the other. A draft reaches nobody, so when either
   fails, fix the branch and move the tag (below).
5. **Wait for both runs** (Actions › build and Actions › release, about
   30 minutes). The release run fails early when the tag and a version
   disagree or the notes section is missing, and at the end when a
   platform's bundle has no signature.
6. **Try the draft.** Download the macOS `.dmg`, the Windows installer and
   both Linux AppImages from the draft release, and open each one. Check
   the release text, and edit it on GitHub if it needs it (that edit does not
   reach the banner, which reads `latest.json`; fix RELEASE_NOTES.md too).
7. **Publish** the draft. From then on
   `/releases/latest/download/latest.json` points at it, and installed
   copies offer the update at their next daily check. Then run
   `python3 -I verify/run.py --accept --skip-perf`, so the next release's
   checks compare old edits with this one's.
8. **Merge the pull request** into `main`, then delete the branch. The
   next release starts a new `release-<version>` branch from `main`.

## The website

The [website](https://rhettus.github.io/immage-site/) is built in its own
repository, [immage-site](https://github.com/Rhettus/immage-site). It has no
copy of the guide: each build takes `app/docs` (without `dev/`) and
`RELEASE_NOTES.md` from the latest published release's tag, and its download
buttons link to that release's `.dmg`, `-setup.exe` and AppImages, matched
by file name. Renaming those assets therefore needs a change there too.

A published release reaches the site at its next daily build. To publish it
straight away, run Actions › Pages in immage-site by hand; its `immage_ref`
input previews a branch's guide instead. The guide's sidebar follows the
Contents list in [app/docs/README.md](../README.md), and the build fails on
a link between guide pages that does not resolve.

## Cached release builds from a branch

GitHub caches are scoped to refs. A tag run cannot restore caches saved on
`release-<version>`. To reuse those caches, commit the final version and notes
with `[skip ci]`, push the branch and its `v<version>` tag, then dispatch the
release workflow on that branch:

```bash
gh workflow run release.yml --ref release-0.41.0 -f tag=v0.41.0
```

The skip marker prevents duplicate push/PR/tag builds; manual dispatch still
runs. The version job fetches tags and requires the requested tag to resolve
to the exact checked-out commit. It also checks the app versions and release
notes. The reusable build retains release configuration and updater signing,
while restoring npm, Rust, ccache and Linux WebKit caches using the same keys
as normal builds. A cache miss builds the dependency normally. Source and
release assets come from the dispatched commit; publication remains manual.

Verify workflow syntax, `python3 -I scripts/test_release_assets.py`, and all
five version files before dispatch. In Actions, confirm WebKit cache hits on
both Linux jobs; cache existence alone does not prove a restore succeeded.
This path rebuilds the app; it does not promote an earlier run's installers.

## When something goes wrong

- **The release run fails before publish:** fix the cause on the release
  branch, then move the tag to the new commit and push it again:

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

The shared Installing and Known issues text in `scripts/release_assets.py`
is appended to generated GitHub release bodies. Keep it aligned with the
user guide. The resolved NVIDIA/X11 startup issue is omitted from future Known
issues; automatic system WebKit and GBM defaults apply from 0.41.1 and remain
documented in the user guide. Fractional Wayland scaling still uses integer-sized GTK surfaces and
full-quality frames; only reduced drag drafts follow the actual screen scale
when enabled. Do not promise equivalent performance under X11 or at 100%.
Verify generated release bodies with `python3 -I scripts/test_release_assets.py`.
