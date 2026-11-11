# Film negatives

The Negative panel turns a photo of a film negative, taken with a camera
or a scanner, into a positive. It runs darktable's negadoctor module,
which inverts the film by its densities and then simulates printing it on
paper. Open it with the film strip button on the right-hand rail.

## Before you start

- **Photograph the whole frame, with some of the border.** The unexposed
  film around the picture (the orange or clear edge, not the black
  frame gap) is what the conversion measures first.
- **Keep the light even and the negative clean.** Dust and scratches
  read as the darkest or brightest parts of the film and throw the
  automatic values off.
- **Expose the scan to the right.** Make the film border as bright as it
  goes without clipping. A color negative's orange mask lets little blue
  through, and an underexposed scan's blue sinks into the sensor's noise
  in the film's densest parts, the scene's highlights, which shows as
  noisy, cast shadows in the print.
- **Convert first, then edit.** Converting changes what Basic's tools
  work on, so do it before the rest of the edit.

## What converting turns off

Opening the panel on a photo that is not yet converted warns you what
changes. Some of Basic's tools work on the light before the negative is
inverted, or do the job the print now does, so a converted negative turns
them off:

- Temp and Tint (darktable's color calibration)
- Exposure, Whites, Blacks, Profile and Auto (exposure and the tone
  mapper, AgX or sigmoid)
- Dehaze (haze removal)

They are greyed out, marked "set in Negative". The panel's own Exposure,
White Point, Blacks and Neutral Highlights stand in for them.

Contrast and Saturation keep working, on color balance rgb, and
Highlights and Shadows on shadows and highlights: modules that run after
the conversion. Everything else (the tone curve, HSL, color grading,
detail, effects, masks, crop) works as on any photo.

The warning has a "Don't warn me again" box; Preferences › General ›
Warn before converting a negative turns it back on.

## The steps

The Negative panel is a list of numbered steps. One step is open at a time,
and the others fold to a line that shows their current values. Click a
folded step to open it. The open step has **Back** and **Next**, and
**Done** on the last one, which folds them all. A step you have been through
shows a check mark. Immage remembers the open step, so the panel opens where
you left it.

The steps are:

1. **Profiles**: Input Profile and Working Profile, described below.
2. **Border & Photo Area**: Film Type, **Pick Film Border** and **Pick Photo
   Area**. Picking the film border converts the photo.
3. **Film Base**: White Point and Black Point.
4. **Color**: Neutral Shadows, Neutral Highlights and **Reset Color**. It is
   listed only for color film.
5. **Tone**: Exposure, Contrast, Blacks and Highlight Roll-off.
6. **Advanced**: Border Color, Shadow Tint and White Balance. It appears only
   when the panel's sliders icon in its heading is on, and once the photo is
   converted.
7. **Export Positive**: **Export to Library**, its DNG and TIFF buttons, and
   **Turn Off Conversion**.

Steps 3 to 7 are locked until the film border is picked in step 2, and their
summaries say so. Profiles and Border & Photo Area are always open.

## Color management

Choose **Input Profile** and **Working Profile** in the Profiles step, the
first step of Negative, before picking the film border. These are darktable's input color profile settings;
they affect the whole photo, including when conversion is off.

- **Input Profile** describes the RGB supplied by your camera or scanner.
  Camera Standard Matrix and Camera Enhanced Matrix are intended for camera
  raw files, as described in the
  [darktable negadoctor guide](https://docs.darktable.org/usermanual/development/en/module-reference/processing-modules/negadoctor/).
  For rendered scans, use the embedded/default profile, the
  scanner's ICC profile, or the color space the scanner exported, such as
  sRGB or Adobe RGB.
- **Working Profile** is the RGB space in which negadoctor measures and
  converts film densities. Linear Rec2020 is a useful starting point; a
  suitable matrix ICC profile of the film emulsion is another option.
  The menu includes only profiles darktable supports as a working space.
- **Default for Photo** restores darktable's default for that setting on this
  photo. Raw files and rendered scans can have different input defaults.

Immage remembers the last profile you chose in each menu. When Pick Film
Border converts a photo whose profile is still its default, that profile is
set first, as part of the same undo step, so a roll scanned with one setup
needs its profiles chosen only once. A photo with a profile already set
keeps it, as does any photo you only open or view in Negative. Choosing
**Default for Photo** is remembered too, and stops the earlier choice being
applied. A remembered ICC file that is no longer installed is skipped.

For camera scans with excessive saturation or color casts, try **linear Rec2020
RGB in both menus**, then sample the film again and compare. Users in the
[Input color profile to use for negatives discussion](https://discuss.pixls.us/t/input-color-profile-to-use-for-negatives/20271)
and its [comparison thread](https://discuss.pixls.us/t/negatives-and-color-profiles/20293)
reported improvements from a linear Rec2020 input profile with some scanning
lights, while others preferred a camera matrix. These are setup-dependent
experiments, not a universal recommendation or a change to the defaults.

There is no single profile pair that suits every scanning setup. Changing
either profile changes the RGB values measured by the film pickers: pick
**Film Border**, then **Photo Area**, and redo neutral shadow/highlight picks
as needed after changing profiles. Existing conversion values stay in place
until you pick again. Undo restores a profile change; Reset all restores
both profiles along with the other adjustments; Undo after Reset all restores
the conversion and profiles together. Turn Off Conversion leaves the selected
profiles in place.

To install ICC files, put `.icc` or `.icm` files under Immage's engine
configuration directory: `color/in` for Input Profile and `color/out` for
Working Profile, then restart Immage. The configuration directory is:

- Linux: `~/.local/share/app.immage/config` (or `$XDG_DATA_HOME/app.immage/config`).
- macOS: `~/Library/Application Support/app.immage/config`.
- Windows: `%APPDATA%/app.immage/config`.

A development build uses `build/app-runtime/config` in the checkout.
These directories are separate from standalone darktable's configuration.
Working profiles must be RGB matrix profiles; installing an
unsupported profile does not make it appear in that menu.

Select **Negative** in Copy Settings to copy both profiles with the conversion.
The New Preset dialog also offers a Negative group, unchecked by default.
ICC files themselves are not bundled in copied settings, presets or sidecars;
install the same named files on the destination computer.

## Converting a negative

1. **Film Type**, in the Border & Photo Area step. Choose Color or Black &
   White. Black & White also sets Basic's Treatment to Black & White.
2. **Pick Film Border**, in the same step. Click it, then drag a box over
   the unexposed film border, clear of any pre-exposed edge or printed
   numbers. This converts the photo. Its border color shows in the swatch
   beside the button.
3. **Pick Photo Area**, in the same step. Drag a box over the picture inside
   the border, clear of dust. White Point, Black Point, Blacks and Exposure
   are set from it. Until you pick one, the conversion reads the whole frame
   bar a thin edge.

While an eyedropper waits for a box, the photo shows uncropped, so the
film border can be reached; your crop comes back once the pick is read.
Crop the border out with the Crop tool when you are done.

## The controls

The eyedropper beside a conversion control sets that control alone
from a box you drag. The tooltips give darktable's own names, to match
its manual and tutorials.

| Control | What it does | Where to pick |
|---|---|---|
| White Point | the film's densest part, which becomes white: left brightens the highlights, right darkens them | the brightest part of the scene |
| Black Point | where the scan's darkest tones sit: left brightens the shadows, right darkens them | the film border, or the whole photo |
| Neutral Shadows | takes a color cast out of the shadows (color film) | the film border, or a shadow that should be neutral |
| Neutral Highlights | the white balance (color film) | something white or gray |
| Exposure | the print's overall brightness; picked, as bright as it goes without clipping | the brightest part of the photo |
| Contrast | the print's contrast | |
| Blacks | how deep the blacks go; picked, what should be pure black | the film border, or a dark part of the photo |
| Highlight Roll-off | where the brightest tones start to compress: lower is gentler | |

Set Neutral Shadows before Neutral Highlights: the shadows' correction
moves the highlights too. Reset Color sets both back. The Advanced step, shown
when the sliders icon beside the pin in the panel heading is on, holds Border
Color, Shadow Tint and White Balance as red, green and blue sliders.

Turn Off Conversion, in the Export Positive step, takes the photo back to the
negative, with Basic's tools as they were. Undo does the same.

A photo is either a converted negative or a
[film simulation](film-simulation.md), not both. Converting a photo that
has a film simulation asks first, then turns the simulation off.

## A whole roll

Convert one well-exposed frame, then copy its settings to the rest of the
roll: Copy… in the right-hand panel, tick **Negative** (it starts
unticked), and paste onto the other frames. Each one is converted and its
modules turned off as if you had converted it. A frame exposed very
differently may need its own picks.

## Export a positive to the library

**Export to Library**, in the Export Positive step, writes a separate positive
beside the original, with the conversion and current edits baked in. It
opens with normal editing tools available, so you can continue editing
without the negative workflow's restrictions. The original keeps its
conversion edit. The **DNG** and **TIFF** buttons beside it choose
losslessly compressed **DNG (16-bit float)**, the default, or **TIFF (32-bit
float)**, the same setting as Preferences › General › Workspace ›
**Generated positive format**.
The result opens automatically unless **Open generated photos** is off.

## In darktable

The edit is darktable's negadoctor module, with the modules above
switched off, so darktable of the same version opens it the same. In
darktable the controls are in negadoctor's three tabs, under the names
the tooltips give.
