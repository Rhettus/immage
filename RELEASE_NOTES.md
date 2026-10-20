# Release notes

The section for each version is the text of its release on GitHub, and
what Immage's update banner shows under Release Notes.

## 0.32.0

Bug fixes

- a mask's Highlights, Shadows and Whites sliders now change the photo;
  in 0.31.0 they moved but did nothing
- a mask's Defringe works on photos whose Defringe is set to the defringe
  module in Preferences › Modules
- a mask's Color Grading highlights luminance no longer shows up as its
  Whites when the photo is opened again

Improvements

- drag a photo onto the window to open it, or a folder to add it to
  Folders
- subfolders in the folder tree can be hidden, and stay out of Include
  subfolders
- undo, redo, before/after and compare move from over the photo into the
  toolbar, beside a new Grid button
- the grid's columns widen to fill the row, and the grid makes room for a
  side panel shown over it rather than hiding under it
- the canvas color is picked from swatches in Preferences
- a progress bar while the engine starts, which can take 20-30 seconds on
  a slower computer or the first start after an update

## 0.31.0

The first public release of Immage, with builds for macOS (Apple Silicon),
Windows and Linux.

- the panels of a mainstream raw editor on darktable's engine: Basic, Tone
  Curve, HSL / Color, B&W Mix, Color Grading, Detail, Lens Corrections,
  Transform and Effects
- masks: brush, linear and radial gradients, color, luminance and depth
  ranges, and AI selection of the subject, the sky, people and more
- Heal and Clone spots, presets, film looks, export to a folder or an
  Immich album, and an import screen for memory cards
- edits are darktable XMP sidecars: darktable of the same version
  (5.7, its development branch) opens them and renders them the same
- Immage checks for new versions and installs them from inside the app
