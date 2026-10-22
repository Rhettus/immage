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
- **Focus mode**: opening a panel closes the others; ⌥-click opens one
  alongside. On by default.
- **Auto-hide panels**: the side panels and filmstrip slide away when the
  pointer leaves them, and back at their edge: the rail, or the window's
  bottom edge below the toolbar. A pin keeps one open.
- **Scroll adjusts sliders**: off by default, so scrolling over the panels
  only scrolls them and an edit can't change by accident.
- **Preview**: how much the photo gives up for speed while you edit.
  Export is never affected.
  - **Quality** renders every frame in full, even while you drag.
  - **Balanced**, the default, renders at half size while a slider, wheel
    or curve moves, about four times as fast, and in full on release.
    Grain, Texture and Sharpening are left out until release, unless they
    are what you are dragging. They are also left out of the zoomed-out
    picture behind the photo, which the navigator and histogram read and
    you see at the edges while zooming and panning.
  - **Performance** drags at quarter size, also without noise reduction and
    HSL, and renders the picture behind the photo only at the viewer's
    size, so zooming in shows it softer until the sharp view arrives.

**Library**

- **Stack RAW+JPEG pairs as one photo**: a raw and the JPEG, HEIF or OM
  System .ORI of the same name show as one, and a rating, reject or delete
  takes them all.

**AI Acceleration**

- **GPU**: what AI upscaling at export runs on. **Automatic** picks the
  first one found. If none is found, AI upscaling isn't offered.
- **Device**: which graphics card, when there is more than one.

**Performance**

- **Performance overlay**: shows, over the photo, the frame rate, the time
  from a slider moving to the photo changing, where that time went, and
  every darktable module instance in the last frame with its time. Its
  Session tab keeps the slowest response so far and each module
  instance's runs, last, average, slowest and total times, until Reset or
  quitting. × or ⇧⌘P closes it.
- **GUI benchmark**: **Run** drags the main sliders on the open photo and
  back, zooms in and out, and saves a timing report. Every slider ends where
  it started, but use a copy of a photo you care about.

**Startup**

- **Quick start guide**: the short tour when Immage opens.

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
