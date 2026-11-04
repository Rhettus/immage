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

| Immage | darktable module |
|---|---|
| **Basic** | |
| Treatment (Color, Black & White) | color calibration's gray (`channelmixerrgb`), on an instance of its own after the color equalizer, or the color equalizer (`colorequal`) |
| White Balance: Temp, Tint, the picker | color calibration (`channelmixerrgb`) |
| Exposure | exposure (`exposure`) |
| Contrast | AgX (`agx`), or sigmoid (`sigmoid`) on a photo started under it; or color balance rgb (`colorbalancergb`); or contrast equalizer (below) |
| Contrast equalizer (Contrast option) | contrast equalizer (`atrous`): five channels, each with six coarse-to-fine bands; replaces the global or masked Contrast slider, chosen independently |
| Highlights, Shadows | tone equalizer (`toneequal`), or shadows and highlights (`shadhi`) |
| Blacks | AgX's lift, or sigmoid's target black; or exposure's black level (`exposure`) |
| Vibrance | color balance rgb (`colorbalancergb`) |
| Saturation | AgX's saturation; or color balance rgb (`colorbalancergb`), which a photo on sigmoid always uses |
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
| Local Exposure, Blacks, Contrast, Whites, Saturation, Hue | an instance of exposure or color balance rgb per mask |
| Local Highlights, Shadows | an instance of tone equalizer or shadows and highlights (as the photo's) per mask |
| Local Temp, Tint | an instance of color calibration per mask |
| Local Texture, Clarity, Dehaze | an instance of the chosen Texture or Clarity module (including contrast & texture), or haze removal per mask |
| Local Noise, Defringe, Sharpness | an instance of denoise (profiled), chromatic aberrations (`cacorrectrgb`), or diffuse or sharpen or sharpen (as the photo's Sharpening) per mask |
| **Heal and Clone** | retouch (`retouch`) |
| **HDR Merge** | darktable's HDR merge (lighttable's "create HDR"), with its auto-alignment, into a float DNG |
| **Panorama Merge** | no darktable module: OpenCV stitches RAW and non-RAW photos rendered by darktable into a float DNG |
| **Negative** | negadoctor (`negadoctor`); a converted negative switches off color calibration, exposure, the tone equalizer, haze removal and the tone mapper, and runs Contrast and Saturation on color balance rgb, Highlights and Shadows on shadows and highlights |
| **Film Simulation** | spektrafilm (`spektrafilm`), with its film and paper data downloaded into darktable's data folder; it switches off the tone mapper (AgX, sigmoid, filmic, base curve) and runs Contrast and Saturation on color balance rgb, Blacks on exposure |
| **Looks** | darktable styles, applied as extra module instances |
| **Export** borders | framing (`borders`), added at export only |
| **Keywords** | darktable tags (`dc:subject`, `lr:hierarchicalSubject` in the XMP) |
