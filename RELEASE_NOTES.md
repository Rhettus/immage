# Release notes

The section for each version is the text of its release on GitHub, and
what Immage's update banner shows under Release Notes.

## Unreleased

Improvements

- GUI benchmark reports include shared-frame write, reply and WebKit read timings
  to help diagnose native Linux preview latency.
- A Linux AI diagnostic script collects model-loading logs and file checksums
  into one report without requiring an application rebuild.

Bug fixes

- Release instructions describe automatic NVIDIA/X11 startup handling and
  the remaining Wayland fractional-scaling overhead without requiring the
  older Mint launch workaround.

## 0.41.1

Improvements

- Paste Settings applies the copied groups to every selected local photo,
  including virtual copies, while keeping the active photo and selection.
  Looks retain their strength. One undo or redo restores the whole batch;
  failures report recovery and sidecar write problems.

Bug fixes

- Select Object correctly recognizes installed AI models, including downloads
  made during the current session, fixing loading errors and repeated downloads.
- Linux AppImages use compatible system WebKitGTK with GBM disabled on
  NVIDIA/X11, fixing the startup failure and slow rendering seen on Mint.
  Wayland and other GPUs keep bundled WebKitGTK 2.54.2. Automatic selection
  falls back to the bundle if needed; environment switches override the
  WebKit selection and enable or disable GBM.

## 0.41.0

Improvements

- Preferences > Modules adds Contrast equalizer as a Contrast option, replacing
  the Contrast slider with a draggable graph for luminance, chroma, edges and
  noise thresholds across coarse-to-fine detail bands.
- Preferences > Modules offers Contrast & Texture alternatives for Clarity
  and Texture, with the module's native controls in adjustments and masks.
  Medium and Fine details stay visible; an Advanced chevron reveals the
  remaining controls in both adjustments and masks. Existing defaults remain
  in place.
- Optional compact 100% loupes above the Detail and Presence controls show
  the same selected area. It defaults to off; enable it in General > Workspace. Use its point
  picker, then click the photo to choose the area; Escape cancels picking.
  Disabling the loupe also disables its rendering. Detail and grain drags
  preview the selected area directly when the loupe is enabled; otherwise,
  they keep the visible image at full preview resolution while dragging,
  including Texture, Sharpening, and luminance and color Denoise. Release
  updates the full visible view. Contrast and tone adjustments keep their
  normal whole-image previews.
- Panorama Merge supports JPEGs and other non-RAW photos, including mixed
  RAW and non-RAW selections, and saves an editable DNG beside the first photo.
  A preview above the projection choices lets you compare
  projections, see which one Auto chooses, and toggle Auto Crop to see the
  edges it removes before merging.
- Adjust Capture Time in the photo context menu or Metadata panel shifts
  selected photos by the same amount to synchronize camera clocks. Preview
  and confirm the adjustment before saving it to XMP sidecars; the context
  menu can undo the last batch. Photos without a recorded time are skipped.
- Metadata adds Location: enter coordinates or drop and drag a pin on an
  optional OpenStreetMap map, then Apply to save GPS information to the photo's
  XMP sidecar. Remove location clears GPS coordinates and altitude. Maps offer
  dark and standard styles and require no API key.
- Negative adds Export to Library to save a separate positive beside the
  original, with the conversion and current edits baked in and normal editing
  tools available. Preferences > General > Workspace chooses losslessly
  compressed DNG (16-bit float, the default) or TIFF (32-bit float).
- Filters adds a Rejected category with All photos, Hide rejected and Only
  rejected options. The selection counts as an active filter and resets with
  Clear all.
- Filters adds Camera body: distinguish identical camera models by their body
  serial numbers, independently of the lens, or find photos without a serial.
- Immich search results add Import Parent Folder to the right-click menu:
  add a locally available result's folder to Folders and browse its photos.
  The action appears only when Immich is configured in Preferences.
- Generated HDR merges, panoramas, AI denoise results, positive exports and
  the first result from a plugin open for editing automatically. Preferences >
  General > Workspace can disable this. Successful completion notifications
  close after 30 seconds, or immediately when Open or OK is selected.
- Preferences > Modules groups settings under collapsible Global and Masks
  sections that follow Focus mode; Alt-click keeps both open. Custom module
  choices are independent, including contrast equalizer for masks while using
  AgX globally. Existing adjustments keep their modules.
- Windows downloads now provide a single `.exe` installer, with a choice of
  installation for your account or for everyone on the computer.
- The user guide now includes compact screenshots of the workspace and Basic
  adjustment controls, with links to the full-size images.
- User and developer guides now cover all module choices, the contrast equalizer
  graph, detail previews, metadata editing and generated-photo workflows.

Performance

- Linux AppImages bundle WebKitGTK and JavaScriptCore 2.54.2 while keeping
  the Ubuntu 22.04 runtime baseline, including Linux Mint 22.x, on x86-64
  and ARM64. Fractional-scale drag previews remain supported.
- Detail and Presence loupes pause while browsing or selecting photos in grid
  view and refresh on return to the photo view, avoiding extra detail renders.
- Thumbnail loading follows the visible grid or filmstrip as you scroll,
  rendering on-screen photos before checking the rest of the folder.
- Deleting rejected photos removes their thumbnails immediately after
  confirmation while the files move to the Trash in the background.
- Preview layers reuse canvas allocations and already uploaded frames,
  skip unchanged placement updates, and defer navigator drawing to reduce
  work when an exact frame arrives.
- Histogram, scope and clipping calculations run in background workers,
  with a fallback where workers are unavailable. Histogram input copies
  wait until after drawing to reduce work on the window's main thread.
- The engine retains scaled preview checkpoints on the GPU for reuse by
  downstream edits. Three recent scaled checkpoints survive ordinary cache
  replacement, while upstream changes and memory cleanup still invalidate
  them. This avoids retaining full-resolution demosaiced GPU buffers.
- Slider drags avoid redundant panel updates. Histograms and scopes update at
  a reduced cadence during interaction and refresh on release. Slider drags
  and wheel gestures combine engine edits once per display frame and skip
  unchanged values, while release immediately submits the final edit.
- Opening folders reads TIFF-based RAW metadata from small prefixes where
  possible. Grid thumbnails read suitable embedded JPEGs directly and decode
  them closer to the grid size, reducing file reads and temporary memory.
  Other preview layouts retain the full-read fallback.
- Balanced previews add a 75% size. The tuner uses median timing from the
  middle 10–90% of frames, defaults to an 80 ms latency target, and groups
  setup, targets and recommendations with advanced comparisons folded away.
- Preferences > Performance adds a tuner that starts at full preview quality
  and finds the highest tested quality meeting your FPS and latency targets.
  Review its recommended changes, apply them, and verify with another run.
  Load a representative RAW and use your usual window size for useful results.
  Other performance settings support measured comparisons and relaunch
  verification; AI and thumbnail caches are excluded.
- GUI benchmarks now record CPU usage per core and process, RAM and swap,
  supported GPU/VRAM counters, and the busiest Linux threads to help identify
  single-thread bottlenecks. The dashboard shows resource use by step,
  frame pacing, UI stalls and rendering-path evidence.
- GUI benchmark diagnostics trace input-to-frame latency, render queues,
  engine mutex waits, module timings and raw checkpoint cache reuse and
  eviction. Reports include the build commit and tracked-change status;
  a bottleneck analysis tool helps interpret the collected traces.
- Preferences > Performance has a Window renderer choice: Automatic,
  Mesa or NVIDIA. Relaunch to switch paths, then run the GUI benchmark
  to compare them on the same build. Photo processing keeps its own
  GPU setting. Automatic uses the system default renderer on all GPUs,
  removing the forced Mesa override on NVIDIA.

Bug fixes

- Fix Windows engine linking with the bundled OpenCV used by HDR alignment
  and Panorama Merge.
- Fix conflicting Linux build dependencies for the bundled webview on x86-64
  and ARM64.
- Windows icon buttons use a consistent arrow cursor so toolbar icons no
  longer appear to overlap the hand pointer.
- Windows builds correctly detect the bundled static OpenCV libraries, enabling
  Panorama Merge and its projection preview. Builds fail if stitching is missing.
- Opening Crop preserves portrait orientation, so resizing from the top edge
  no longer snaps a vertical photo to a horizontal crop.
- HDR, RAW panorama and AI Denoise DNGs retain their format and color
  calibration metadata, so thumbnails display and the generated photo opens
  for editing in Immage and darktable.
- Reset All clears native module settings as well as sliders, including edits
  imported from darktable that Immage has no controls for. Legacy Filmic and
  Base Curve tone mappers switch off so they cannot compress highlights after
  Immage's tone mapper. The reset remains undoable.
- Histogram graphs give clipped black and white peaks their full bin width,
  keeping endpoint spikes visible in scopes and tone curves.
- Preview and final frames stay aligned on scaled displays when adjusting
  sliders, including 75% previews with odd pixel dimensions.
- Expanding a folder shows its subfolders without waiting for other expanded
  folders on slow or disconnected drives to finish loading.
- Closing Immage stops an unresponsive engine after five seconds, even if
  it never answers the quit request. On Linux, an Immage crash also stops
  its engine so it cannot keep the library locked and block relaunching.
- Folder reads report an error after 30 seconds without an engine batch reply
  instead of waiting indefinitely. Switching folders ignores the previous
  read's progress and results.
- Changes in Preferences > Modules apply to unused tools on the current photo
  when Preferences closes, without restarting. Tools with edits keep their module.
- Object mask backdrop ranges use double precision when read back to avoid
  intermediate overflow with large boost values.
- Opening a generated positive or other local result from an Immich search
  switches the grid to its local folder, so the new image is visible there.
  Generated images also retain their information while the folder loads.
- Crop corners respond to the first inward drag with a locked aspect ratio,
  including pulls that are mostly horizontal or vertical.
- Windows builds compile positive export with or without panorama support
  and with Exiv2 builds that use UTF-8 paths.
- Crop guides appear immediately when entering crop and selecting an aspect
  ratio, including on photos that have not been cropped before.
- Clipping overlays and histogram/scope updates discard results from
  replaced frames, including same-sized frames and GPU/CPU transitions.
  Old clipping overlays clear as their source frame changes.

## 0.40.0

This release comes early, for one bug big enough to have a release of
its own: in a big folder, editing a photo all but stopped while its
thumbnails were made. It is the last of the bug fixes below.

Improvements

- the folder tree's drive headings have a dot, green while the drive
  answers and red while it doesn't, as when a network share has been
  disconnected. Its folders show their subfolders again when it comes
  back
- Preferences' Cache card shows a bar of how much of its limit each
  cache holds, red once it is full and letting the thumbnails or
  originals not looked at longest go

Bug fixes

- a folder on this computer opens while a network share is
  disconnected: if a photo had been sent to Edit In on that share,
  every folder stayed at "Reading folder…" until Immage was quit and
  the share reconnected
- Immage no longer waits for ever on a network share whose server has
  gone away, or a disk that stops answering: opening one of its folders
  says it isn't answering after a few seconds, and the folder tree, the
  drive headings and thumbnails carry on without it
- a photo can be edited while a big folder on a network share is read:
  the filmstrip redrew after every photo or two the share gave, and
  sliders and zoom barely moved until the folder was read
- a photo can be edited while a big folder's thumbnails are made: with
  the filmstrip hidden, its thousands of cells were still laid out
  again at every change on screen, seconds each, and sliders hardly
  moved

## 0.39.1

Improvements

- a folder you've opened before shows its photos at once, even on a
  NAS: the thumbnails, ratings and labels from last time fill the
  filmstrip in their final order, and the filters work on them, while
  the folder is read again behind them. A photo changed since is
  updated when the read reaches it, and you can open any photo before
  then
- reading a folder on a network share asks the share less on macOS and
  Windows: the folder is listed, and its thumbnails checked against
  their files, without a request for each file
- Select Subject, People and Select Object leave less halo on a plain,
  vivid background such as water or blue sky: a new mask over one goes
  just over the subject's edge and stops at the background's color, so a
  bird over water lifted a stop shows almost no glow around it, and its
  rim keeps the lift, even where its own colors match the background.
  Over a busy, gray or pale background the mask is made as before. The
  shape's Fit to Background switch turns it off, to the outline it would
  have had
- on Linux, sliders answer sooner: a slider's change now goes to the
  engine with the frame it asks for, in one request instead of one for
  each tool it moves, where each request could take 20 ms or more while
  the window was drawing
- sliders early in darktable's pipe, such as Exposure, White Balance,
  Highlights and noise reduction, follow the mouse more closely while
  dragged: where darktable takes longer than 60 ms on a frame, the next
  ones render smaller, down to 70% each way, and the size is remembered
  for that slider's next drag. The frame after letting go is full size
  as before. Preferences, Performance sets the time and how small the
  frames may get, or turns it off
- editing runs on the GPU where there is one: a slider's frames while
  dragged, and the frame after letting go, come about one and a half to
  three times sooner than on the CPU, and look the same. Measured on a
  Mac M4 and on an NVIDIA RTX 4070 Ti SUPER under Windows and Linux.
  Preferences, Performance, Edit on the GPU turns it off, for a GPU that
  is slower than the computer's CPU

Bug fixes

- Auto in the Basic panel works again with editing on the GPU, the
  default since 0.39.0: it stopped with "the working-space image is
  not at hand". Picking a color or luminance range for a mask, the
  Zone System and Upright failed the same way
- AI selections give their memory back: after Select Subject, Immage
  held on to as much as 18 GB until it was quit. The AI models are now
  let go half a minute after the last selection, which takes no longer
  to make again
- O shows and hides a mask's overlay straight after a switch in the
  Masks panel, such as Invert, is clicked: until something else was
  clicked, the switch took every key
- the photo no longer shifts by a pixel or so when a slider is let go:
  the smaller frames shown while dragging were placed half a pixel or
  more off the full frame that follows

## 0.39.0

Improvements

- a folder you've opened before shows its photos at once, even on a
  NAS: the thumbnails, ratings and labels from last time fill the
  filmstrip in their final order, and the filters work on them, while
  the folder is read again behind them. A photo changed since is
  updated when the read reaches it, and you can open any photo before
  then
- reading a folder on a network share asks the share less on macOS and
  Windows: the folder is listed, and its thumbnails checked against
  their files, without a request for each file
- Select Subject, People and Select Object leave less halo on a plain,
  vivid background such as water or blue sky: a new mask over one goes
  just over the subject's edge and stops at the background's color, so a
  bird over water lifted a stop shows almost no glow around it, and its
  rim keeps the lift, even where its own colors match the background.
  Over a busy, gray or pale background the mask is made as before. The
  shape's Fit to Background switch turns it off, to the outline it would
  have had
- on Linux, sliders answer sooner: a slider's change now goes to the
  engine with the frame it asks for, in one request instead of one for
  each tool it moves, where each request could take 20 ms or more while
  the window was drawing
- sliders early in darktable's pipe, such as Exposure, White Balance,
  Highlights and noise reduction, follow the mouse more closely while
  dragged: where darktable takes longer than 60 ms on a frame, the next
  ones render smaller, down to 70% each way, and the size is remembered
  for that slider's next drag. The frame after letting go is full size
  as before. Preferences, Performance sets the time and how small the
  frames may get, or turns it off
- editing runs on the GPU where there is one: a slider's frames while
  dragged, and the frame after letting go, come about one and a half to
  three times sooner than on the CPU, and look the same. Measured on a
  Mac M4 and on an NVIDIA RTX 4070 Ti SUPER under Windows and Linux.
  Preferences, Performance, Edit on the GPU turns it off, for a GPU that
  is slower than the computer's CPU

Bug fixes

- AI selections give their memory back: after Select Subject, Immage
  held on to as much as 18 GB until it was quit. The AI models are now
  let go half a minute after the last selection, which takes no longer
  to make again
- O shows and hides a mask's overlay straight after a switch in the
  Masks panel, such as Invert, is clicked: until something else was
  clicked, the switch took every key
- the photo no longer shifts by a pixel or so when a slider is let go:
  the smaller frames shown while dragging were placed half a pixel or
  more off the full frame that follows

## 0.38.0

Improvements

- the Folders card tells drives apart: with folders on more than one
  drive, each drive is a heading over its folders, and a NAS share shows
  a network icon and its server's name, so a 2026 on the Mac and a 2026
  on the NAS no longer look the same. A folder on a share that isn't
  connected stays under its share, dimmed. Double-click a server's name
  or address to give it a name of your own
- reading a large folder and loading its thumbnails no longer slow down
  editing: zooming, sliders and resizing the window stay responsive.
  The folder is read and its thumbnails load while you edit, beside the
  photo's own rendering, so a big folder fills in without waiting for
  you to stop
- exports run in the background: the Export dialog closes as soon as
  the export starts, and you go on editing while it runs. The bottom
  left of the photo shows how far it has got, with Stop, and then what
  it did. Each photo is exported as it was when you clicked Export, even
  if you edit it meanwhile
- AI Denoise runs in the background too: you go on editing while it
  writes the DNG, and when it's done, Open at the bottom left opens it.
  The DNG has the edit as it was when you clicked Denoise
- AI selections (Select Subject, Sky, People, an object, Depth Range
  and the rest) no longer hold up editing while the model runs: sliders
  and zoom stay responsive during the seconds it takes to find the
  subject. A selection that finishes after you have moved to another
  photo is left out
- AI selections fit more closely: the outline follows the photo's own
  edges, such as a treeline against the sky or the rim of a subject,
  instead of rounding them off, so less of the sky is left out around
  trees and less of the background is taken in around a subject. Select
  Sky and the Landscape choices look at the photo in more detail, and
  take about half a second longer. A new Sky or Landscape mask starts
  with Edge Aware at 20, which takes in the sky between branches without
  a halo along the horizon, and its overlay shows once, as Edge Aware
  leaves it, rather than first without it. An adjustment on a selected
  subject or object no longer spills onto a band of the background
  around it, and still reaches the subject's own rim, such as a bird's
  crest or the edge of its beak
- HDR Merge: select bracketed raws and press ⌃H (Ctrl+H on Windows
  and Linux), or right-click them, to merge them into one DNG with the
  range of them all, using darktable's HDR merge. Auto Align lines up
  brackets shot handheld. The DNG is written beside the first bracket
  while you go on editing, with its progress and Stop at the bottom
  left of the photo, and edits like any raw
- Panorama Merge: select overlapping raws and press ⌃M (Ctrl+M on
  Windows and Linux), or right-click them, to stitch them into one wide
  DNG, as Lightroom's Photo Merge does. Choose Spherical, Cylindrical or
  Perspective, or let Auto pick, and Auto Crop cuts the empty edges. The
  DNG is written beside the first photo while you go on editing, with
  each stage's progress and Stop at the bottom left of the photo, and
  opens like that photo's raw, with the lens corrections made. It is
  stitched with OpenCV, as darktable has no panorama tool
- Edit In › Macro Studio, for focus stacking: select a focus bracket,
  right-click and choose Edit In › Macro Studio. The stack opens in
  Macro Studio to check and retouch, and when you save it there it
  comes back beside the first photo and opens, even if you save it after
  closing Immage. Set it up in Preferences › Plugins, sending the raws
  (the stack comes back as a raw DNG) or 16-bit TIFFs with the edit
- Linux on Wayland with fractional scaling (125%, 150%, ...): sliders
  update about twice as fast. Such a window is drawn at 200% and shrunk
  by the desktop, and the photo was rendered for the 200% while a slider
  moved; it is now rendered for the screen's own scale, which shows the
  same. The photo after you let go is as sharp as before. Preferences ›
  Performance › Editing › "Drag drafts at the screen's scale" turns it
  off

Bug fixes

- AI Denoise's small photo shows the part being previewed again: the
  box was drawn far too large, over the dialog and the photo behind it,
  instead of on the small photo
- a new photo with the name of one deleted from the same folder, such
  as a panorama or HDR merged again, no longer comes back rejected and
  with the deleted photo's edit
- picking another folder clears the grid at once: on a NAS, the last
  folder's photos stayed on show for seconds while the new one was read
- Edit In's Results folder is looked in again: a DxO PureRAW set to
  save somewhere other than beside the photo or its DxO folder had its
  DNGs never come back
- the overlay of a selected subject or object has a smooth edge when
  zoomed in, rather than one in steps, and shows the mask's soft edge
- Linux: the filmstrip and grid keep their thumbnails once a photo is
  open, where they went blank, all but the open photo's
- Linux: Immage's engine stops as soon as it is asked, where it was
  stopped only after five seconds, when quitting Immage
- a photo with no capture time, such as one from a camera whose clock
  battery was flat, is placed in the filmstrip, and in the Filters'
  Captured dates, by the date its file was last changed. It went to the
  end, and was left out of every date range

## 0.37.0

Immage is in alpha. Large changes are made often, from one release to the
next, so keep copies of photos you care about, and expect parts of the
interface to move.

Improvements

- exports leave out the camera's and lens's serial numbers, which sites
  such as Flickr show to everyone. The export dialog's Privacy section is
  now Metadata, with a box for each part of what a file carries: camera
  and lens, serial numbers and owner name, location, title and caption,
  keywords, and darktable's edit history. Presets keep the boxes
- the navigator stays the same size whatever the photo's shape: a
  portrait photo no longer makes it tall enough to push the panels
  below it down
- the crop frame is easier to take hold of: its corners can be grabbed
  further out, and an edge anywhere along it rather than only at its
  middle bar
- on the Mac, the first click in Immage while another app is in front
  goes to the photo or control under it, rather than only bringing
  Immage to the front
- film negatives: the Negative panel, on the film strip button in the
  rail, turns a photo of a color or black and white negative into a
  positive with darktable's negadoctor. Pick the film border, then the
  photo area, and the rest is set for you; each control has an
  eyedropper of its own. A converted negative turns off Temp, Tint,
  Exposure, Whites, Blacks, Dehaze and the tone mapper, which work before
  the inversion, after a warning, and runs Contrast, Saturation,
  Highlights and Shadows after it. Copy Settings' Negative group converts
  a whole roll from one frame
- the crop frame and its grid, and the other guides over the photo, have
  a thin dark edge, so they show on a light photo or a White canvas, and
  Preferences › General › Guide color sets their color: white, yellow,
  red or your own
- the toolbar's file type button is now Filters, which narrows the
  folder by file type, camera, lens, keywords (a keyword includes those
  under it), capture date (or a recent span, year or month), ISO,
  aperture, focal length and shutter speed, then shows the result in the
  grid. Each list holds only what your other choices leave: pick a camera
  and Lens lists the lenses used on it. On Immich results it holds the
  search's filters, which were under Advanced on the Immich card, and the
  stars filter the search too, so they cover all of Immich's photos and
  not only those loaded
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
- Clarity is fine near zero: ±1 already flattened the photo's contrast,
  more than ±10 did, and now each step adds a little. ±100 looks as
  before, and photos edited before keep their look until Clarity is moved
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
