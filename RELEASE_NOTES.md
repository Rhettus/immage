# Release notes

The section for each version is the text of its release on GitHub, and
what Immage's update banner shows under Release Notes.

## 0.35.0

Improvements

- the Tone Curve's Parametric sliders are named as in Basic and run light
  to dark: Whites, Highlights, Midtones, Shadows and Blacks. Midtones is
  new, and bends the middle of the curve. Curves made with the earlier
  sliders open with the same settings under the new names
- the Zone System's Color mask takes an object as well as Sky, Rocks,
  Vegetation and Subject: + Object, then drag a box around the object on
  the photo or click it, and the AI outlines it. Each object gets a
  button of its own, Object A, Object B, and so on
- the History card's rows of the opened edit have buttons on hover: a
  module added in darktable can be switched off or deleted, and one
  behind Immage's sliders reset, each as one undo step
- Preferences › New Photos has Exposure compensation: every new raw
  starts brighter or darker by the amount set, +1 EV for instance, while
  Basic's Exposure still starts at 0 and adds to it. Auto allows for it,
  and each photo keeps the amount it started with. Off by default
- Basic's Auto sets Blacks more gently: about half as far as before, and
  not at all when a photo's darkest parts are close to black already. A
  photo with nothing dark in it, such as a plane against clear sky, keeps
  its blacks; before, Auto darkened the sky to navy
- Post-Crop Vignetting's Amount no longer shows the vignette's guides
  while it moves, so the photo can be judged without them. Midpoint,
  Roundness and Feather still show them, and so does the pointer over
  the photo

Bug fixes

- O and the eye in the Masks panel hide the red overlay while a brush
  adds to or subtracts from a mask; before, the overlay stayed on until
  the brush was put down with Esc, whichever mask was selected. Moving
  one of the mask's sliders now also hides it, until the next stroke

## 0.34.0

Bug fixes

- Color Range and Luminance Range masks work on JPEG and TIFF photos;
  before, picking a color failed with "the image is not in RGB at the
  mask stage", and the range's overlay never showed
- a range mask's overlay no longer streaks across the photo after
  zooming in to 100% and back out
- AI masks and AI Denoise download their models on Linux systems without
  curl or unzip installed, such as Arch and CachyOS, which have no unzip;
  before, the download or the unpacking failed
- an AI model left half installed, such as by an install cut short, is
  downloaded again the next time it is used; before, Select Object, the
  other AI masks and AI Denoise failed with "cannot load the model" until
  Immage's data folder was deleted
- on Linux, sliders respond several times faster when other programs are
  busy, such as on a system drawing in software without its graphics
  driver; before, a slider like Clarity could take over a second a frame
- on Linux with an NVIDIA graphics card, sliders, zooming and the rest of
  the window respond about ten times faster; before, NVIDIA's driver held
  the window to a few updates a second, on Wayland and X11 alike. Immage
  now has Mesa draw its window, when Mesa is installed and
  `__EGL_VENDOR_LIBRARY_FILENAMES` isn't set

## 0.33.0

Bug fixes

- Sharpening's Masking and Noise Reduction's Detail change the photo as
  they are moved; before, the change showed only once the photo was
  opened again
- Remove Chromatic Aberration in Lens Corrections works; before, the
  correction stayed on whatever it was set to. On a photo edited in an
  earlier version, switch it off and on again for it to take effect
- a mask's Dehaze removes haze on every photo; before, a positive amount
  did nothing on some. A mask made in an earlier version keeps the old
  behavior: draw it again
- moving a slider on a mask just drawn no longer stops the photo from
  updating until it is opened again

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
