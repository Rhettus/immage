# Release notes

The section for each version is the text of its release on GitHub, and
what Immage's update banner shows under Release Notes.

## 0.37.0

Improvements

- Preferences has a Performance tab, with the settings that were spread
  through General: Preview, the frame and disk caches, AI acceleration,
  the performance overlay and the GUI benchmark
- new in Performance: darktable memory, how much of the computer's memory
  darktable may take; Thumbnail memory, which caps what the library's
  thumbnails hold (a large folder could take gigabytes); and Read ahead,
  how many photos, ahead and optionally behind, are decoded while you edit
  so the arrow keys open them sooner, up to three at once
- a Frame cache setting, in Preferences › Performance under Memory,
  sets the memory kept for frames already shown, so zooming back out or
  returning to a view needs no render. On a 4K screen or larger it
  starts at 512 MB, double what 0.36.0 kept
- the Zone System's zones, and the overlay of a Color or Luminance Range
  mask, show as soon as they are ready, rather than after the render of
  the whole photo that follows an edit, which could take several seconds
  zoomed in
- H steps the scope over the photo's histogram: histogram, waveform, RGB
  parade, vectorscope, and waveform with vectorscope; ⇧H steps back
- opening another photo from Masks, Heal or the Zone System returns the
  right-hand panel to the adjustments; Presets stays open
- a mask made by an AI selection shows its overlay straight away, so
  you can see what was selected, until you press O or move one of its
  sliders
- a mask's handles and guides show while the pointer is over the photo,
  and step aside while it is over the panels, so the adjustment can be
  seen
- Whites reaches much further under AgX: it also brightens or darkens the
  photo's brightest tones, as a mask's Whites does, where it only reshaped
  the top of AgX's curve. Photos edited before keep their look until Whites
  is moved
- Lens Corrections has Hot Pixels, which removes the stuck and hot
  pixels of long exposures and high ISO, with Strength and Threshold;
  raws only, and off until turned on
- the Export dialog's preview renders several times faster on an edited
  photo, and shows again at once a frame or preset you have already
  tried; under it is the name the file will be exported with, not the
  original's

Bug fixes

- zoomed in, moving or reshaping a drawn mask shows it in its new place;
  since 0.36.0 the view could keep showing it where it had been, or not
  at all
- after a quick slider move, zoomed in especially, the photo sometimes
  stayed soft until the next change or zoom; it now always renders sharp
  once the slider is let go
- Compare works from the grid: it shows the two photos side by side, and
  with two photos selected, compares them, the first opened for editing
- hiding a mask with its eye no longer makes it vanish from the Masks
  panel after the import screen has been opened; the mask was never
  deleted, and shows again in this version
- Crop, Masks, Zone System and Heal in the tool rail no longer go dim
  and stop responding while a photo is open, as they could when the
  folder shown no longer listed it
- the History card's rows are no longer at times drawn over each other
- Before/After shows the Before at the same size as the After on a
  photo with lens corrections or Transform; before, it came out larger
- HSL / Color acts at Lightroom's colors: Blue on blue, which Purple
  used to gray, and Green on foliage. Saturation -100 turns its color
  gray and no more, where -50 already did and -100 grayed the colors
  around it too, so with Blue at -100 Aqua did nothing to the blues
  between them. Luminance and the B&W Mix at -100 darken a vivid color
  without turning it black. The same goes for HSL on a mask, and for
  saved presets, whose values are brought to the new strength. Photos
  edited before look as they did; their HSL sliders can read spread over
  neighboring bands, or past the end of a slider

## 0.36.0

Improvements

- Immage opens at the size and place it was closed at, and maximized if
  it was. On Linux under Wayland the size is kept but the desktop places
  the window
- the filmstrip and the grid show a folder's photos in the order they
  were taken, rather than by file name
- zooming is twice as quick, and a click, key or navigator zoom renders
  the sharp view while it zooms, so it is ready sooner. Zooming back to
  a view shown before, with nothing changed since, shows it at once.
  Zoomed in, the whole photo is kept sharp once rendered, so moving
  around it shows no blur and needs no wait
- switching between Before and After, undoing, or putting a slider
  back where it was shows the photo at once when it was shown that way
  before, zoomed in too
- a photo shows its thumbnail as soon as it is opened, rather than the
  photo before it, and the arrow keys' next photo is read ahead while
  the current one is open, so a compressed raw (an Olympus ORF, for
  one) opens about 0.3 s sooner

Bug fixes

- on Linux, an AMD graphics card with only AMD's ROCm OpenCL driver
  installed is used again for the whole-photo render and export; since
  darktable 5.6 it was left out unless Mesa's RustiCL driver was
  installed instead, and with ROCm 7.1 darktable's OpenCL code did not
  build, so Immage ran on the CPU alone
- on Linux with Mesa's RustiCL OpenCL driver and AMD's ROCm both
  installed, Immage no longer shows empty folders and a blank photo: its
  engine stopped at start while checking ROCm for AI acceleration, which
  the Linux build cannot use
- in Before/After's left and right split, the After label lines up
  with Before instead of sitting lower

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
- on Linux, installing an update from the banner no longer stays on
  "saving the edit and installing…" for good; an engine slow to stop is
  stopped after a few seconds, and an install that cannot finish says so
  and offers the release page. The update from 0.34.0 still runs
  0.34.0's installer, so on Linux it may stop there once more: download
  the AppImage from the release page instead

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
