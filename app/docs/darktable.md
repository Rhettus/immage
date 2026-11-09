# Working with darktable

Immage uses darktable’s processing modules and saves edits as darktable XMP
sidecars. Panorama Merge is the exception: OpenCV stitches a new DNG that
can then be edited with darktable’s modules.

## Compatibility

**If you already edit in a stable darktable, try Immage on test images
first.** Immage is built from darktable's development branch (5.7 at
present), not from a stable release, so its modules can be newer than
yours. Once Immage saves an edit, the photo's XMP sidecar may hold module
versions that a stable darktable cannot read: it then warns of a version
mismatch and leaves those modules out, or resets them to their defaults,
so the photo looks different there. Masks are saved in the format of
darktable's new flexi masks, which no released darktable reads; a photo
whose masks an earlier Immage made opens with the same masks, and is saved
in the flexi format once it is edited again. Work on
copies, or on photos you have not edited in darktable, until you know how
the two fit your workflow.

## Immage information in sidecars

Immage also saves information for its own editing controls, such as the AI tool
used to create a selection. Most of this uses names in ordinary darktable mask
and module history. A custom `immage:locationManaged` metadata property records
when missing sidecar GPS fields mean the location was deliberately removed.

These conventions do not prevent a compatible darktable from loading the photo
and sidecar or change its rendering of the saved edit. AI selections are saved
as native paths; darktable does not need the AI recipe to render them. Editing
or renaming these structures in darktable may affect Immage's ability to recover
its controls, and other applications need not interpret the GPS removal marker.
The version requirements above still apply. Developers can consult the
[XMP conventions inventory](dev/xmp-conventions.md) for the encodings.

## Tool and module reference

Each Immage tool is a darktable module, or darktable's masking, so the same
edit opens in darktable as these modules. `app/src/manifest.ts` holds how
each slider maps onto its module's parameters.

**A photo edited in darktable keeps all of its edit.** Immage loads and
renders the whole darktable history, including modules it has no controls
for, and saves them back unchanged. Only the modules in this table can be
adjusted in Immage; anything else stays as darktable left it, and is still
edited in darktable. Where darktable set one of these modules in a way
Immage's sliders cannot show, such as a tone curve drawn by hand, Immage
leaves its settings alone until one of its sliders is moved.

Some tools can run on more than one module. Preferences › Modules picks
which for the tools a photo has not used yet: Default takes the module
darktable's [AgX workflow](https://avidandrew.com/agx-workflow.html) uses
for each, except contrast & texture for Clarity and Texture: the first one
listed below. Custom lets each be set. A
photo that already uses one of a tool's modules keeps it. The collapsible
Global and Masks sections choose modules independently: for example, use AgX
globally and contrast equalizer inside masks. They follow Focus mode; Alt-click
keeps both sections open. See the [module preferences guide](preferences.md#modules)
for the available mask alternatives.

A tool with more than one module also has a small icon beside its name
(Contrast, Saturation, Highlights and Shadows, Clarity, Texture, Sharpening,
in the panels and inside masks). It is always shown, dim until you point at
it. Click it for a menu of the tool's modules, with a check on the current
one: picking another changes the module for this photo (or this mask), and
the slider's value carries over. **Set as default** in the same menu also
stores that module as the tool's choice in Preferences › Modules, switching
it to Custom. When the contrast equalizer or saturation curve is chosen, the
icon sits on that editor's heading, since the slider is replaced.
Menus open above the icon when there is not enough room below, stay inside
the window, and scroll if the available height is too small for all options.

| Immage | darktable module |
|---|---|
| **Basic** | |
| Treatment (Color, Black & White) | color calibration's gray (`channelmixerrgb`), on an instance of its own after the color equalizer, or the color equalizer (`colorequal`) |
| White Balance: Temp, Tint, the picker | color calibration (`channelmixerrgb`) |
| Exposure | exposure (`exposure`) |
| Contrast | AgX (`agx`), or sigmoid (`sigmoid`) on a photo started under it; or color balance rgb (`colorbalancergb`); or contrast equalizer (`atrous`), which replaces the global or masked slider with five channels of six coarse-to-fine bands, chosen independently |
| Highlights, Shadows | tone equalizer (`toneequal`), or shadows and highlights (`shadhi`) |
| Blacks | AgX's lift, or sigmoid's target black; or exposure's black level (`exposure`) |
| Vibrance | color balance rgb (`colorbalancergb`) |
| Saturation | AgX's saturation; or color balance rgb (`colorbalancergb`), which the AgX option falls back to on a photo on sigmoid; or saturation curve (`satcurvergb`), which replaces the global or masked slider with saturation and brilliance curves of up to 20 points each, using darktable's default formula and filter, chosen independently |
| Whites | AgX (`agx`), with color balance rgb's highlights brilliance (`colorbalancergb`); sigmoid (`sigmoid`) on a photo started under it |
| Texture | contrast & texture (`contrastntexture`), on its own instance, or diffuse or sharpen (`diffuse`) |
| Clarity | contrast & texture (`contrastntexture`), or local contrast (`bilat`) |
| Dehaze | haze removal (`hazeremoval`) |
| **Tone Curve** | |
| Parametric and point curve | tone curve (`tonecurve`) |
| Red, green and blue point curves | rgb curve (`rgbcurve`) |
| **HSL / Color**, **B&W Mix** | color equalizer (`colorequal`) |
| **Color Grading** | color balance rgb (`colorbalancergb`) |
| **Detail** | |
| Sharpening | sharpen (`sharpen`), or diffuse or sharpen (`diffuse`), its "sharpness \| normal" preset on an instance of its own |
| Noise Reduction: Luminance | denoise (profiled) (`denoiseprofile`) |
| **Lens Corrections** | lens correction (`lens`), with the lensfun database |
| Defringe: Amount, Radius | chromatic aberrations (`cacorrectrgb`) |
| Hot Pixels | hot pixels (`hotpixels`) |
| **Transform**: Vertical, Horizontal, Rotate | rotate and perspective (`ashift`) |
| **Effects** | |
| Post-Crop Vignetting | vignetting (`vignette`) |
| Grain | grain (`grain`) |
| **Crop tool** | |
| Crop and aspect | crop (`crop`) |
| Angle and Straighten | rotate and perspective (`ashift`) |
| Rotate and Flip | orientation (`flip`) |
| **Masks** | |
| Brush, Linear Gradient, Radial Gradient | drawn masks: brush, gradient, ellipse |
| Color Range, Luminance Range | parametric masks (blending) |
| Select Object, Subject, Background, Sky, People, Landscape, Depth Range | drawn path masks, traced from the AI model's selection |
| Local Exposure, Blacks, Contrast, Whites, Saturation, Hue | an instance of exposure or color balance rgb per mask; Contrast and Saturation can instead use their own contrast equalizer or saturation curve instance |
| Local Highlights, Shadows | an instance of tone equalizer or shadows and highlights (as the photo's) per mask |
| Local Temp, Tint | an instance of color calibration per mask |
| Local Texture, Clarity, Dehaze | an instance of the chosen Texture or Clarity module (including contrast & texture), or haze removal per mask |
| Local Noise, Defringe, Sharpness | an instance of denoise (profiled), chromatic aberrations (`cacorrectrgb`), or sharpen or diffuse or sharpen (as the photo's Sharpening) per mask |
| **Heal and Clone** | retouch (`retouch`) |
| **HDR Merge** | darktable's HDR merge (lighttable's "create HDR"), with its auto-alignment, into a float DNG |
| **Panorama Merge** | no darktable module: OpenCV stitches RAW and non-RAW photos rendered by darktable into a float DNG |
| **Negative** | input color profile (`colorin`) for Input Profile and Working Profile; negadoctor (`negadoctor`); a converted negative switches off color calibration, exposure, the tone equalizer, haze removal and the tone mapper, and runs Contrast and Saturation on color balance rgb, Highlights and Shadows on shadows and highlights |
| **Film Simulation** | spektrafilm (`spektrafilm`), with its film and paper data downloaded into darktable's data folder; it switches off the tone mapper (AgX, sigmoid, filmic, base curve) and runs Contrast and Saturation on color balance rgb, Blacks on exposure |
| **Looks** | darktable styles, applied as extra module instances |
| **Export** borders | framing (`borders`), added at export only |
| **Print**, **Soft Proof** | the print view's printer profile conversion, PDF and CUPS or Windows printing; output color profile's (`colorout`) soft proof and gamut check. Neither changes the edit |
| **Keywords** | darktable tags (`dc:subject`, `lr:hierarchicalSubject` in the XMP) |
