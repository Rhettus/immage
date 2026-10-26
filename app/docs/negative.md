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

## Converting a negative

1. **Film Type.** Choose Color or Black & White. Black & White also sets
   Basic's Treatment to Black & White.
2. **Pick Film Border.** Click it, then drag a box over the unexposed
   film border, clear of any pre-exposed edge or printed numbers. This
   converts the photo. Its border color shows in the swatch beside the
   button.
3. **Pick Photo Area.** Drag a box over the picture inside the border,
   clear of dust. White Point, Black Point, Blacks and Exposure are set
   from it. Until you pick one, the conversion reads the whole frame
   bar a thin edge.

While an eyedropper waits for a box, the photo shows uncropped, so the
film border can be reached; your crop comes back once the pick is read.
Crop the border out with the Crop tool when you are done.

## The controls

Each control has an eyedropper beside it that sets that control alone
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
moves the highlights too. Reset Color sets both back. Advanced holds the
Border Color, Shadow Tint and White Balance as red, green and blue
sliders.

Turn Off Conversion takes the photo back to the negative, with Basic's
tools as they were. Undo does the same.

## A whole roll

Convert one well-exposed frame, then copy its settings to the rest of the
roll: Copy… in the right-hand panel, tick **Negative** (it starts
unticked), and paste onto the other frames. Each one is converted and its
modules turned off as if you had converted it. A frame exposed very
differently may need its own picks.

## In darktable

The edit is darktable's negadoctor module, with the modules above
switched off, so darktable of the same version opens it the same. In
darktable the controls are in negadoctor's three tabs, under the names
the tooltips give.
