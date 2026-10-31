# Preferences

Open **Preferences** with ⌘, or the gear at the bottom of the rail. Changes
apply as you make them; **Done** closes the window.

![Preferences, General tab](images/preferences-general.png)
<!-- screenshot: Preferences > General -->

## General

**Workspace**

- **Canvas**: what is behind the photo, in full screen preview too.
  **Dark**, **Neutral Gray** to judge tones without a dark surround, or
  **White** to see the photo as on a print. L steps through them.
- **Guide color**: the color of the lines drawn over the photo: the crop
  frame and its grid, the straighten line, Transform's grid and guides,
  the vignette's guides and a mask shape's outline. **White**, **Yellow**,
  **Red** or a color of your own. Each line has a thin dark edge, so even
  white shows on a light photo or a White canvas.
- **Focus mode**: opening a panel closes the others; ⌥-click opens one
  alongside. On by default.
- **Auto-hide panels**: the side panels and filmstrip slide away when the
  pointer leaves them, and back at their edge: the rail, or the window's
  bottom edge below the toolbar. A pin keeps one open.
- **Scroll adjusts sliders**: off by default, so scrolling over the panels
  only scrolls them and an edit can't change by accident.

**Library**

- **Stack RAW+JPEG pairs as one photo**: a raw and the JPEG, HEIF or OM
  System .ORI of the same name show as one, and a rating, reject or delete
  takes them all.

**Startup**

- **Quick start guide**: the short tour when Immage opens.

## Performance

How fast the photo responds while you edit, and the memory and disk
Immage keeps to make it so.

**Interface rendering** (Linux)

- **Window renderer**: **Automatic** keeps the Mesa workaround on NVIDIA;
  **Mesa** selects Mesa's EGL explicitly, and **NVIDIA** selects NVIDIA's.
  Only installed drivers can be selected. On NVIDIA, Mesa normally draws
  the interface on the CPU. This setting is separate from **Edit on the
  GPU**, which controls darktable's photo processing.
- The row shows the active EGL selection. **Relaunch** saves the photo and
  restarts Immage to apply a change. An explicit
  `__EGL_VENDOR_LIBRARY_FILENAMES` in the launch environment takes priority.
- For an A/B benchmark, select Mesa, relaunch, open the test photo and run
  the GUI benchmark. Repeat with NVIDIA on the same build, photo, window
  size and editing settings. The reports record the selected path,
  environment, WebKitGTK version and WebGL renderer.

**Editing**

- **Preview**: how much the photo gives up for speed while you edit.
  Export is never affected.
  - **Quality** renders every frame in full, even while you drag.
  - **Balanced**, the default, renders at half size while a slider, wheel
    or curve moves, about four times as fast, and in full on release.
    **Balanced preview size** offers 50% (the default), 75%, and 100%. At 100%,
    drag previews stay full size and automatic smaller drafts are disabled.
    Grain, Texture and Sharpening are left out until release, unless they
    are what you are dragging. They are also left out of the zoomed-out
    picture behind the photo, which the navigator and histogram read and
    you see at the edges while zooming and panning.
  - **Performance** drags at quarter size, also without noise reduction and
    HSL, and renders the picture behind the photo only at the viewer's
    size, so zooming in shows it softer until the sharp view arrives.
- **Shared-memory frames** (Windows and Linux): hands each frame to the
  window in memory both share, rather than copying it. On by default; turn
  it off only to compare the two in the GUI benchmark.

**Memory**

- **darktable memory**: how much of this computer's memory darktable may
  take for its pipes and caches. **Small** keeps to about an eighth, for
  working beside other large programs, though more of each edit is then
  worked out again; **Default** about half; **Large** about two thirds,
  for when Immage is the only large program running. It applies once
  Immage starts again: **Relaunch** saves the photo and restarts.
- **Frame cache**: memory for the views of the photo already shown, so
  zooming back out or going back to a view seen before shows it at once,
  without a render. A view at 100% is about 30 MB on a 4K screen and 45 MB
  on a 5K one. 512 MB on a 4K screen or larger, 256 MB on a smaller one.
- **Thumbnail memory**: for the library's thumbnails. Past it, those
  scrolled out of sight longest are let go and read from the disk cache
  again when you scroll back. A thumbnail takes about 1 MB, so the
  default, 1 GB, holds some 900.
- **Read ahead**: how many photos have their raws decoded while you edit,
  in the direction you last stepped, so the arrow keys open them without
  waiting for the decode. Up to three are decoded at once. Each holds its
  raw in memory, about 50 MB for a 24-megapixel photo. One by default.
- **Read ahead both ways**: as many photos behind the open one too, for
  stepping back. Off by default.

**Cache**

How much disk each cache may take, with what it holds now. **Clear**
empties one.

- **Library thumbnails**: so a folder seen before opens at once. 1 GB by
  default.
- **Immich thumbnails**: search results scrolled through. 512 MB by
  default.
- **Immich originals**: photos opened from Immich. One you have edited is
  kept whatever the limit, as its edit is beside it. 10 GB by default.

The thumbnail caches keep nothing while the disk has under 5 GB free.

**AI Acceleration**

- **GPU**: what AI upscaling at export runs on. **Automatic** picks the
  first one found. If none is found, AI upscaling isn't offered.
- **Device**: which graphics card, when there is more than one.

**Measuring**

- **Performance overlay**: shows, over the photo, the frame rate, the time
  from a slider moving to the photo changing, where that time went, and
  every darktable module instance in the last frame with its time. Its
  Session tab keeps the slowest response so far and each module
  instance's runs, last, average, slowest and total times, until Reset or
  quitting. × or ⇧⌘P closes it.
- **GUI benchmark**: **Run** drags the main sliders on the open photo and
  back, zooms in and out, and saves a timing report. Every slider ends where
  it started, but use a copy of a photo you care about.

## New Photos

What a photo starts with the first time it is opened, if it has no history
yet in Immage or darktable. A photo darktable has opened already keeps its
own settings, even if nothing was changed there. These settings are the
photo's starting point: they don't mark it as edited.

- **Profile**: the color look a raw starts with: one of AgX's looks
  (**AgX Default**, the default) or one of color balance rgb's
  (**Standard**, **Natural Skin**, **Vibrant Colors**, **Legacy**). JPEGs
  keep the camera's look.
- **Exposure compensation** and **Amount**: brightens or darkens every new
  raw by an amount in EV, for a camera whose raws come out too dark or too
  light; +1 is common. Exposure in Basic still starts at 0 and adds to it,
  so Exposure +0.5 makes +1.5 in all, and **Auto** allows for it. The
  photo keeps the amount it started with: changing the setting later
  leaves photos already opened alone. It isn't an adjustment, so **Reset
  all**, the Before view, Copy Settings and presets leave it as it is; to
  take it off one photo, reset or delete the **exposure • compensation**
  row in History once the photo has been opened again. JPEGs get none.
  Off by default; the amount starts at +1.
- **Apply Auto** (Auto Tone): runs Basic's **Auto** once a raw has
  rendered. Off by default.
- **Apply preset**: **Default** gives a raw lens corrections; JPEGs get
  nothing. Or **None**, or any preset.
- **Save current settings…**: makes a preset from the open photo, with only
  the settings you tick.
- **Keywords for edited photos**: keywords a photo gets once you edit it,
  `immage` for instance. They go into the photo's sidecar, where Immich
  reads them, so its Tags filter finds what you edited in Immage. A photo
  reset or undone back to unedited loses them again, even if you had also
  added them yourself. Unlike the settings above, they apply to photos
  edited in darktable too, once you change something in Immage. None by
  default.
- **Copyright** and **Creator**: filled in once you edit a photo, like the
  keywords, but only where the photo has none yet. A copyright or artist
  the camera recorded, or one you typed in the Metadata panel, stays.
  `{year}` becomes the year the photo was taken, so `© {year} Your Name`
  reads `© 2026 Your Name`. Resetting the photo keeps them. Empty by
  default.

## Modules

Which darktable module each tool runs on. **Default** uses the module of
darktable's AgX workflow for each; **Custom** lets you pick one per tool,
from these:

- **Contrast**, **Blacks**, **Saturation**: AgX (or sigmoid, on a photo
  started under it), or color balance rgb for Contrast and Saturation and
  exposure for Blacks
- **Highlights and Shadows**: the tone equalizer, or shadows and
  highlights. A mask's Highlights and Shadows use the same one
- **Black & White**: color calibration, or the color equalizer
- **Sharpening**: sharpen, or diffuse or sharpen
- **Defringe** (masks only): chromatic aberrations, or defringe

Clarity and Texture can each use **contrast & texture** under Custom modules.
Selecting it replaces the corresponding slider with the module's Coarse,
Medium and Fine details, Base detail level, Halo control, Noise bias, Shadows
and Highlights sliders, using darktable's ranges and defaults. This also
applies to masks. Clarity and Texture use separate instances. The existing
modules remain the defaults; contrast & texture currently runs on the CPU.

The tab also lists the module behind each of the other tools. A photo that
already uses one of a tool's modules keeps it, so its edit looks the same;
the choice applies to the tools a photo hasn't used yet, from the next
photo you open.

## Immich

The server, API key, duplicate checking and path map. See
[Immich](immich.md) for setting it up step by step.

## Plugins

Applications a photo can be sent to with right-click › **Edit In**. See
[Edit In](edit-in.md).

## About

Versions, the license, and where the source is. Under **Updates**:

- **Check automatically**: once a day, Immage asks its releases on GitHub
  whether a newer version is out, and sends nothing else. On by default.
- **Check Now**: asks at once, and says what it found.

A newer version shows as a card in the bottom-left corner, with its
release notes. **Install and Relaunch** downloads it, saves the photo you
are editing, and opens the new version where you were. **Later** puts the
card away until Immage next starts; **Skip This Version** waits for the
one after. Updates are signed, and one whose signature does not match is
not installed.

Cached detail preview (Performance → Editing) is experimental and off by default.
For global Texture, Clarity, Contrast, Dehaze and detail controls, it interpolates
recent full renders of the same control while the native pipeline keeps working.
It needs two distinct rendered values and only extrapolates near those values;
other changes, a new view, or release discard the cache. Release always renders
the accurate result. Exposure uses the normal native preview. The loupe controls
appear only while detail sliders are in use, and the move handle appears only
when the loupe itself is shown.

The performance tuner defaults to an 80 ms latency target. It uses the median
of the middle 10–90% of measured frame intervals and input-to-paint latencies,
then selects the highest tested preview quality meeting both targets.
