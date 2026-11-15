# Immage

Immage is a raw photo editor with familiar panels, sliders and shortcuts,
powered by [darktable](https://www.darktable.org/). It is for photographers
who want a straightforward editing workflow, sensible defaults and photos
organized in folders rather than an editor’s catalog.

A personal, non-commercial project, Immage is available for macOS, Windows
and Linux. **All builds are alpha; bugs are expected.**

[Website](https://immage.photo/) ·
[Download Immage](https://github.com/Rhettus/immage/releases) ·
[Getting started](app/docs/getting-started.md) ·
[User guide](app/docs/README.md) ·
[Release notes](RELEASE_NOTES.md)

ORF metadata reads try a small prefix before reading the whole photo when
possible. **Preferences > Performance > Memory > Library workers** controls
thumbnail generation, ORF metadata preparation and photo moves/copies with
separate worker limits. Transfers keep each photo and its sidecars together;
metadata and database updates remain ordered and serial. See the
[library guide](app/docs/library.md#orf-metadata-reads-and-library-workers).

Unchanged folders reuse a disposable [local metadata cache](app/docs/library.md#cached-folder-metadata).
Photos enter the in-memory editing library when an action needs them; cached
thumbnails can appear without importing the photo. Metadata caching does not
download search models or upload your photos. Optional local analysis uses
verified model packages and runs on the CPU. Preferences > Performance > Local
photo cache provides status, pause, clear/rebuild and optional model controls.
Local retrieval keeps selected unknown metadata out of filtered results.

Library thumbnails support embedded TIFF previews in DNG photos and can use
a smaller preview when an unedited photo's RAW data cannot be decoded.

<a href="app/docs/images/workspace.png"><img src="app/docs/images/workspace.png" width="960" alt="Immage editing a photo"></a>

## What you can do

- Edit with familiar tone, color, detail and lens correction tools.
- Find commands in File, Edit, Photo, View and Help menus that show their keyboard shortcuts.
- Make local adjustments with brushes, gradients, range masks and AI selections.
  Consistent rail headers let you switch between Simple and Advanced in any tool.
  Advanced mode adds darktable module cards inside each mask. Copied AI masks
  are recalculated for each destination photo.
- Heal and clone, simulate film stocks and papers, convert film negatives with input and working color profiles, and merge HDR photos or panoramas.
- Apply presets and film looks, compare edits, and copy settings across photos.
- Choose the Dark, Darktable Grey or Light interface theme, or import a custom
  color theme.
- Back up your settings, presets, looks, Edit In plugins and keywords to one
  file, and restore the parts you choose from it.
- Add optional Geoapify place-name search to the location map; map tiles and
  manual pin placement work without a search key.
- Browse folders with non-photo files hidden even while scanning, import
  from a card with the built-in Immporter,
  and optionally search and export to an [Immich](app/docs/immich.md) library.
- Drag photos onto a folder to move or copy them, for example to a NAS, with
  their sidecars and a checksum check of every copied file.
- Export to a folder or an Immich album, with borders and file-name templates.
- Print a photo, or a contact sheet of many with their file names, or save a
  PDF, with your printer's ICC profile, and [soft proof](app/docs/print.md) the
  photo on screen first.

Your originals stay untouched. Edits are saved automatically in XMP sidecars
beside your photos. Immage offers a selected set of darktable’s tools in a
fixed workflow; photographers who need every module and pipeline control
can continue editing in a compatible version of darktable.

**Using darktable already?** Try Immage on copies first. Immage uses a
development version of darktable, and stable releases may not read its newer
module or mask formats. See [darktable compatibility](app/docs/darktable.md).
Immage-specific sidecar conventions are documented in the
[developer XMP inventory](app/docs/dev/xmp-conventions.md).

## Download and install

Choose your platform on the [Releases page](https://github.com/Rhettus/immage/releases):

| Platform | Requirements | Download |
| --- | --- | --- |
| macOS | Apple silicon, macOS 15 or newer | `.dmg` |
| Windows | Windows 10 or 11, x64; Windows on ARM through x64 emulation | `-setup.exe` installer |
| Linux | x86-64 or ARM64, glibc 2.35 or newer (Ubuntu 22.04 and later, including Linux Mint 22.x) | AppImage |

Immage needs at least 8 GB of memory; 16 GB and a GPU with OpenCL are
recommended. See [System requirements](app/docs/getting-started.md#system-requirements).

The Windows installer offers **Just for me** (under
`%LOCALAPPDATA%\Programs\Immage`, without administrator permissions) or
**Everyone on this computer** (under Program Files, requesting permission after
selection). Updates preserve the installation's location and scope.

Builds are not yet signed with a developer certificate; the release page
explains how to open them the first time. Immage checks for updates daily;
you can install them through **Preferences › About › Updates**.

For Linux launch options, see [Linux setup and troubleshooting](app/docs/preferences.md#performance).

At startup, Immage shows the grid while restoring your last photo and switches
to the photo when its first preview is ready. If it cannot load, you can choose
another photo from the grid.

## Learn more

- [User guide](app/docs/README.md): getting started, editing tools and settings.
- [darktable compatibility and module reference](app/docs/darktable.md).
- [Troubleshooting and reporting issues](app/docs/troubleshooting.md): diagnostics, the support bundle and the bug report form.
- [Developer docs](app/docs/dev/README.md): building, architecture and contributing to the code.
- [Credits and licenses](app/docs/credits.md): projects, AI models and map attribution.

## License

Immage is GPL-3.0-or-later. Bundled third-party content keeps its own license.
See [license details and source availability](app/docs/credits.md#license).

Grid culling: **K** keywords selected photos; **F** previews in a fixed 80% window frame without opening the editor, with arrow navigation and rating shortcuts. The bottom bar provides ratings and color labels. Nearby previews are retained in memory; preview prefetch honors **Read ahead** and **Read ahead both ways**, without decoding editor RAWs. See the [library guide](app/docs/library.md).

The Search photos card queries cached local metadata without Immich and can
combine independent local and Immich results, merging exact verified local paths
and preserving metadata edits while additional results arrive. Metadata edits
refresh search results without a folder reload or optional model. Saved edits
also stay indexed as you switch photos through bounded queued refreshes.
After the optional model download, background CPU analysis builds original and
edited embeddings, backfilling metadata for reconciled library paths through
bounded lazy imports, respecting removed and excluded folders. Image queries use the grid
context menu’s Show more like this action and retain active filters. Cached
capture metadata preserves source fractions and known UTC offsets. Search keeps
original and virtual-copy identities consistent with the metadata cache.
Metadata-only pages stop after enough filtered matches; repeatable headless
measurements are described in [benchmarks](benchmarking/README.md#local-cache-and-search).

Immich local path mappings keep resolved files within the configured folder,
including when subfolders contain symbolic links.
