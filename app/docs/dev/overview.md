# Implementation overview

darktable is a git submodule (`darktable/`), pinned to one commit, and
built unchanged apart from a few lines that add one new program to its
build ([patches/darktable-engine.patch](../../../patches/darktable-engine.patch)).
Everything else in this repository is Immage's own.

- **A headless engine** (`engine/`): a small program that keeps one
  image open in darktable's pixelpipe and takes JSON requests on stdin.
  The requests open, set module parameters, render, save and export. They
  also cover looks (styles), drawn and range masks, AI selections and
  preview renders. It runs darktable with no GUI and an in-memory
  library, so the XMP sidecar is the only thing written.
- **A new interface** (`app/`): a [Tauri 2](https://tauri.app/) app with a
  Rust backend and a [React](https://react.dev/) front end that drives the
  engine. It replaces darktable's lighttable and darkroom with:
  - the familiar panels: Basic, Tone Curve (parametric, point, R/G/B),
    HSL / Color, B&W Mix, Color Grading wheels, Detail, Lens Corrections,
    Transform and Effects, each mapped onto darktable modules
    (`app/src/manifest.ts` holds the mapping)
  - masks: brush, linear and radial gradients, color, luminance and depth
    ranges, and AI selection of an object, the subject, the background,
    people, the sky or parts of a landscape, with local adjustments; they
    are stored as darktable drawn and parametric masks
  - Heal and Clone spots with an automatically chosen source and a
    Visualize Spots view, stored in darktable's retouch module
  - film simulation in darktable's spektrafilm: a film stock exposed,
    developed and printed on a paper or scanned, from measured data
    downloaded on first use
  - film negative conversion, color or black and white, picked from the
    film border and the photo, in darktable's negadoctor
  - HDR Merge, in darktable's HDR merge, and Panorama Merge, stitched
    with OpenCV, each into a new DNG; panorama projection and crop can be
    previewed before merging
  - presets, film looks with live preview tiles, undo/redo, a before/after
    view, crop and straighten, a white balance picker, export with
    borders and file-name templates (to a folder or an Immich album), a
    filmstrip, and metadata editing
  - an import screen (Immporter, below), and Preferences for what new
    photos start with and for the Immich connection
- **No catalog**: folders are opened directly and browsed as a tree;
  there are no film rolls and no collections.

## Import integration

The import screen is [Immporter](https://github.com/Rhettus/immporter),
a separate project that Immage builds in as a Tauri plugin. It copies
photos off a card or a folder into dated folders, verifying every copy,
and marks the photos already in the destination or in Immich. After an
import, the destination joins Immage's folder list and the new photos
open. Its source is cloned into `immporter/` (ignored by this
repository's git); `app/immporter.rev` pins the commit Immage builds
against, and `app/scripts/fetch_immporter.sh` checks it out. To move to a
new Immporter version, put its commit in `app/immporter.rev`; the next build
checks it out, and a clean existing `immporter/` checkout is moved to it.
Immage uses only Immporter's plugin and its `embed`, `api` and
`immich-form` modules, so check those for changes when updating the pin.
The importer's grid, selection and source tree come with it unchanged; the
user guide's [Import](../import.md) page describes them.

See [Architecture](architecture.md) for code paths and [Building](building.md) for local builds.
