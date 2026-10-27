# Immage user guide

Immage is a photo editor for people who know the mainstream raw editors.
It has their familiar panels, slider names and shortcuts, and runs on
darktable's raw processing underneath.

- **Every edit is a darktable module.** Immage adds no image processing of
  its own, so darktable opens an Immage edit and renders it the same.
- **Edits live beside your photos**, in an XMP sidecar next to each file.
  The photo itself is never changed, and there is nothing to save.
- **No catalog.** You open folders directly. For a library you can search,
  Immage works with [Immich](immich.md): imports check against it, the
  Library panel searches it, and exports can go straight into an album.

New to Immage? Start with [Getting started](getting-started.md).

![Immage editing a photo](images/workspace-labeled.png)

## Contents

**Start here**

- [Getting started](getting-started.md): first launch, a five-minute
  walk-through, and familiar terms in Immage
- [The workspace](workspace.md): the parts of the window, zooming, before
  and after, compare, histogram and scopes

**Library**

- [Library](library.md): folders, the filmstrip and grid, rating and
  filtering, virtual copies, metadata and keywords
- [Import](import.md): copying photos off a card, verified, without
  duplicates
- [Immich](immich.md): connecting your server, searching it, exporting to
  albums

**Editing**

- [Adjustments](adjustments.md): Basic, Tone Curve, HSL / Color, B&W Mix,
  Color Grading, Detail, Lens Corrections, Transform and Effects
- [Crop](crop.md): crop, straighten, rotate and flip
- [Masks](masks.md): AI selections, brushes, gradients and ranges, and the
  adjustments inside them
- [Heal and clone](heal.md): removing spots and distractions
- [Film negatives](negative.md): converting a photo of a film negative,
  color or black and white, and a whole roll from one frame
- [Zone System](zone-system.md): see a black and white photo's tones as
  zones 0-X, place them where you want them, and fine-tune any band of
  tones
- [Presets and looks](presets-and-looks.md): presets with live previews,
  and 53 film looks
- [History, undo and copying settings](history-and-sync.md): undo, the
  History card, and copying an edit to other photos

**Sharing**

- [Export](export.md): to a folder or an Immich album, with file names,
  borders and captions
- [Edit In](edit-in.md): sending photos to DxO PureRAW or Macro Studio and back

**Reference**

- [Preferences](preferences.md): every setting
- [Keyboard shortcuts](shortcuts.md)

Working on Immage's code? See the [developer docs](dev/README.md).

## About this guide

This is a first pass, written from the app's own labels and hints.

**Screenshots.** Each page marks where a screenshot belongs, with a note
in the page source saying what to capture. Until the file is in `images/`,
it shows as a missing image. To list the ones still to take:

```sh
python3 -I app/docs/check_images.py
```

**To check in the app.** Things this pass describes from the code and has
not yet confirmed by hand:

- Dropping a photo on Immage's Dock icon, and whether Immage appears in
  Finder's **Open With** menu ([Library](library.md)).
- The menu path to API keys in Immich's web page ([Immich](immich.md)).
- How long AI features take on your machine: the guide quotes the app's
  own estimates.
- The quick start guide says "1 to 5 rate it"; the shortcut sheet and this
  guide say 0-5, as 0 clears a rating.

Windows and Linux: the guide shows Mac keys. Use Ctrl for ⌘, Alt for ⌥.
