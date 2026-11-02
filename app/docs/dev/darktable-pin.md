# Pinning darktable

Immage builds one exact darktable commit: the one the `darktable/`
submodule points at. CI, releases and every developer build that commit
and nothing else, so darktable never changes under Immage by accident.
This page is how to move the pin, what breaks when it moves, and how to
check the result.

## Where it is pinned

- **The submodule commit** is the pin. `git submodule status darktable`
  shows it, and `git -C darktable describe --tags --match 'release-*'`
  names it (`release-5.7.0-1428-g2747ed2a0d` is master, 1,428 commits
  past the 5.7.0 tag).
- **[patches/darktable-engine.patch](../../../patches/darktable-engine.patch)**
  is the only change to darktable. It adds the engine to darktable's
  `src/CMakeLists.txt` when `IMMAGE_ROOT` is set, and lets a pipe without
  a GUI keep its GPU results in the pipe cache
  (`src/develop/pixelpipe_hb.c`, `important_input`), and has exiv2 and
  libtiff read photos rather than memory-map them, so a network share
  dropping fails a read instead of killing the engine
  (`src/common/exif.cc`, `_open_read`; `src/imageio/imageio_tiff.c`).
  Folder metadata also uses `_read_metadata`: it grows TIFF prefixes while
  Exiv2 reports missing metadata, ignoring missing pixel strips, then falls
  back to a heap-backed read that reuses the prefix. JPEG and other seekable
  metadata readers use file I/O with the same heap-backed mapping fallback.
  Sized thumbnails use `_read_jpeg_thumbnail` to read absolute JPEG ranges
  or reuse previews already in metadata; unsupported layouts retain Exiv2's
  full-file preview loader. The mipmap cache passes its requested size to
  `dt_imageio_thumbnail`, which uses JPEG scaled decoding. Existing full-size
  thumbnail entry points retain their behavior.
  [scripts/patch_darktable.sh](../../../scripts/patch_darktable.sh) applies
  it once (`scripts/build.sh` calls it), and `.gitmodules` sets
  `ignore = dirty`, so the patched submodule does not show as changed.

## Which commits to pin

- Today Immage follows darktable **master**, to be on the 5.8 line when
  it is released.
- When **darktable 5.8.0** is released, pin to its tag, `release-5.8.0`.
  From then on, move only to 5.8.x release tags (bug fixes), until Immage
  moves to the next feature release on purpose.
- Odd minor versions (5.7, 5.9) are darktable's development cycles: never
  pin a release to a development tag once a stable one exists.

To see what is newer than the pin:

```sh
git -C darktable fetch origin --tags
git -C darktable tag -l 'release-*' | sort -V | tail -5
git -C darktable log --oneline HEAD..origin/master | wc -l
```

## Moving the pin

1. Prepare: a clean tree, a benchmark baseline
   (`python3 -I benchmarking/bench.py --note "before darktable <new>"`),
   and a folder of edited reference photos with exported 16-bit TIFFs, to
   compare renders against.
2. Move the submodule, its own submodules, and re-apply the patch:

   ```sh
   git -C darktable apply --reverse "$PWD/patches/darktable-engine.patch"   # drop the old patch
   git -C darktable checkout release-5.8.0           # or a master commit
   git -C darktable submodule update --init src/external/rawspeed src/external/OpenCL \
       src/external/libxcf src/external/whereami src/external/LibRaw
   sh scripts/patch_darktable.sh
   ```

   `scripts/build.sh` takes the patch off and puts it back by itself, so
   once the new commit is staged (`git add darktable`) a plain
   `sh scripts/build.sh` does steps 2 and 3. Without staging, it checks
   the old pin out again.

   If the patch no longer applies, darktable moved the lines around it:
   apply it by hand at the same places (after the `add_subdirectory(mcp)`
   block in `src/CMakeLists.txt`, the `important_input` condition in
   `_dev_pixelpipe_process_rec`, exif.cc's `ImageFactory::open` calls
   that read a photo, and imageio_tiff.c's `TIFFOpen` modes), and
   regenerate it with
   `git -C darktable diff > patches/darktable-engine.patch`.
3. Rebuild: `cmake --build build`, a fresh configure if CMake asks. Then
   `(cd app && npm run build)` and `(cd app/src-tauri && cargo build && cargo test)`.
4. Repair what broke (below), and run the checks under [Verify](#verify).
5. Commit the bump on its own, with the repairs in their own commits
   before it, so every commit builds:
   `darktable: pin to release-5.8.0`. Say in `RELEASE_NOTES.md` which
   darktable the next release carries.

To undo, check out the old commit in `darktable/` and commit that.

## Build breaks

| Symptom | Where to look | Repair |
| --- | --- | --- |
| `engine/main.c` no longer compiles: a darktable function was renamed, changed its arguments or vanished | `git -C darktable log -S<symbol> <old>..<new> -- src` finds the commit that changed it | Read how upstream's own callers changed in that commit. darktable-cli (`src/cli/main.c`) and, from 5.8 on, `src/mcp/` use the same develop, pixelpipe and export calls the engine does, and the engine was cloned from `src/mcp`. |
| AI calls (`dt_ai_*`, `dt_seg_*`, `dt_restore_*`, `dt_imageio_dng_*`) changed | `src/ai/`, `src/common/ai/` | Follow the new signatures; check `src/iop/` and `src/libs/` callers. The engine's `_ai_denoise` repeats `src/libs/neural_restore.c`'s raw denoise job, so diff that file between releases and carry its fixes over. |
| `engine/upright.c` no longer compiles, or Upright fits differently | `src/iop/ashift.c`, `ashift_lsd.c`, `ashift_nmsimplex.c` | upright.c copies ashift.c's line detection and fit at the revision its header names, and includes the other two files. Diff ashift.c from that revision and carry the changes over. |
| Windows link error about darktable's AI data | the engine used a *variable* from the AI backend | The engine may call only *functions* from darktable's AI backend, never use its data: the static `darktable_ai` library pulls in `dt_conf_*` (fixed once, in 0.9.8). |
| A `USE_AI=OFF` engine build fails | code outside `#ifdef HAVE_AI` | Wrap it; darktable's AGENTS.md wants both builds to work. |

Commit each repair separately, with its reason in the message.

## Things that build but go wrong

These break silently, and are the reason this page has a checklist:

- **A module's params changed.** A field was renamed or its meaning
  changed, which comes with a version bump. The app addresses fields by
  name (`app/src/manifest.ts`, through the engine's `get` and `set`). Find
  the changes:

  ```sh
  for f in $(git -C darktable diff --name-only OLD NEW -- src/iop); do
    git -C darktable diff OLD NEW -- "$f" | grep -q DT_MODULE_INTROSPECTION && echo "$f"
  done
  ```

  For each module Immage maps (the code map's tables), read its params
  struct diff and update `manifest.ts` to match.
- **A module's defaults changed**, for example sigmoid's or AgX's. New
  photos look different.
- **A conf key was renamed.** The engine's `main()` sets
  `write_sidecar_files`, `plugins/ai/enabled`, `cache_disk_backend`,
  `cache_disk_backend_full`, `ui_last/import_initial_rating` and the
  metadata import flags. Check that each still exists in
  `darktable/data/darktableconfig.xml.in`.
- **GPU drags slow down again.** The `pixelpipe_hb.c` hunk keeps the
  input of the module last edited (the engine's `_set` names it in
  `history_last_module`) when darktable has no GUI. If upstream reworks
  `important_input` the patch may still apply but no longer work: each
  GPU drag frame then reruns from the raw. The `heavydrag` benchmark
  shows it, at about 10 ms a frame with the hunk and 100 or more without.
- **The engine crashes when a share drops again.** A new
  `ImageFactory::open(path)` reading a photo in exif.cc, or a new
  `TIFFOpen` without `m`, maps the file again. The `fixes` check "a
  dropped share's photo" fails then.
- **Old edits load differently.** A newer darktable reads older params
  through each module's `legacy_params()`, so this direction is usually
  safe. Compare the reference renders anyway.

## Verify

- `git -C darktable describe --tags --match 'release-*'` names the new commit, and the
  app's About line shows it.
- The engine smoke test:
  `python3 -I benchmarking/bench.py --only sliders --opencl off --repeat 3 --images <one raw>`.
  It runs `get` and `set` on every field the app maps, so a missing field
  fails here.
- The integration tests, CPU:
  `git -C darktable submodule update --init src/tests/integration`, then
  `cd darktable/src/tests/integration && DARKTABLE_CLI=$PWD/../../../../build/bin/darktable-cli ./run --disable-opencl --no-deltae`
- The reference photos: each opens with its masks, spots and look, and the
  re-exported TIFFs match the reference renders.
- AI: each mask kind, upscale on export, Detail's Denoise… on a Bayer and an X-Trans raw. Models are picked by darktable's version, so a new version may
  download new models.
- Performance: `python3 -I benchmarking/bench.py`, then
  `python3 -I benchmarking/compare.py`.
- A GUI pass: every panel, crop, masks, heal, presets, looks, export,
  Immich, Edit In.

## Log

| Date | darktable from → to | Breaks fixed | Time | Notes |
| --- | --- | --- | --- | --- |
| | | | | |
