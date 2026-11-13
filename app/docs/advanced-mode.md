# Advanced mode

Advanced mode is for working with darktable's own modules. Turn it on in
[Preferences](preferences.md#general) > General > **Editing mode**, and
back to **Simple** the same way. Switching does not change the photo or its
edits.

Edits made in Advanced that Simple's sliders cannot show, such as a second
instance of a module or a module Simple has no sliders for, keep rendering in
Simple. At the end of each Adjustments group that holds such edits, Simple shows
**N advanced edits here keep rendering**. Click it to open Editing mode in
Preferences. Modules that darktable turns on by itself and that you have not
changed are not counted.

To copy these edits to other photos, tick **Advanced modules** in Copy
Settings (see [History and sync](history-and-sync.md)).

In Advanced, the **Adjustments** panel looks like this:

- A **Search modules** box at the top, described below.
- The same groups as Simple (Basic, Tone Curve, HSL / Color, B&W, Color
  Grading, Detail, Lens, Transform and Effects), in the same order. They fold
  open and shut as in Simple, follow Focus mode, and Alt-click opens one alone.
  HSL / Color and B&W both show whether or not the photo is black and white,
  where Simple shows one or the other.
- A **Technical** group at the end, which exists only in Advanced.
- No **More controls** sliders icon; that icon is only in Simple.

## Search modules

Type two or more characters to list the modules whose name matches, then
those with a setting whose name matches (for example `lowpass`, or `radius`
for the modules with a radius). Each row shows the module, its group and, for
a setting, the matching setting. A module appears once, with the first setting
that matched, and the list stops at about a dozen rows.

Use the arrow keys and **Enter**, or click a row. Escape clears the box, and a
click elsewhere closes the list. The group opens as a click on its title would
(Focus mode closes the others). If the module's card is shown, it opens, flashes
and scrolls into view. If not, the module is added as **Add module** would add
it, at its place in the group. For the tone mappers, which share one card, the
card switches to the one you picked.

A module darktable cannot apply to this photo is greyed out and cannot be
picked, as in Add module. With no photo open, every row is greyed out.

## Hiding modules

**Preferences > Modules > Advanced modules** lists every Advanced module by
group, each with a switch. Turn one off to hide it: it leaves Add module, the
module search and the tone mapper switch, so the lists you use hold only what you
want. A filter box narrows the list by name, **Show all** and **Hide all** act on
one group, and **Essentials only** hides every module without a Simple equivalent
(it keeps white balance, color calibration, exposure, the tone mappers, contrast
and texture tools, color balance rgb, the curves, denoise, lens correction, rotate
and perspective, vignetting, grain and the color profiles). A module that appears
in two groups, such as color balance rgb in Basic and Color Grading, hides in
each group on its own.

Hiding never takes away an edit. A photo that uses a hidden module (it is on,
in its history, or was added) still shows its card, with a small **hidden** tag
beside the name, and the card works as any other. Changes apply as soon as you
close Preferences.

## Module cards

Each group shows a card for every darktable module this photo uses: the ones
that are on, and the ones its edit has changed, even if they are now off.
Cards keep a fixed order in each group, the order of Simple's sections, and a
module's instances sit together.

Below the cards, **+ Add module** lists the group's modules. Choosing one
switches it on, opens its card and brings it into view, as one undo step. A
module already on the photo has a check mark; use its card's **...** menu to
add another instance. A module darktable cannot apply to this photo, such as
a raw-only module on a JPEG, is greyed out. Its card, where one shows, has its
switch greyed out too.

Where darktable splits a module's settings over pages, the card shows them as
tabs, and darktable's section headings appear above their settings.

The Basic group has darktable's **exposure** module. Its card has:

- An on/off switch and the module's name. If the module has a name of its own,
  such as a second exposure instance, the name follows it.
- A **darktable presets** button (three lines) beside the reset button; see
  [darktable presets](#darktable-presets).
- An instances menu (**...**) beside the reset button; see
  [Instances](#instances).
- A reset button that returns the module to darktable's defaults for this
  photo and leaves it on. These defaults can differ from how a new photo
  opens, since Immage's new-photo settings are not darktable's.
- A header you click to fold the card. The card opens unfolded when this photo
  has edited exposure.
- The module's settings. **Mode** is Manual or Automatic. In Manual, you see
  **Compensate camera exposure** and **Exposure** (in EV). In Automatic, you see
  **Percentile** and **Target level**. **Black level correction** is always
  shown.

Moving a setting switches the module on. Card changes are undone like any other
edit, with one undo step per slider drag, and they are saved with the photo.
Simple's Exposure and Blacks sliders change the same module, so a change made
on one side shows on the other.

## Basic modules

Besides exposure, the Basic group has these darktable modules:

- **White balance**: darktable's **Settings** list (as shot, user modified,
  camera reference, as shot to reference, and the white balance presets
  darktable has for your camera, such as Daylight or Cloudy), a **Finetune**
  slider for a camera preset that has a range, its **Temperature** and **Tint**
  sliders, and the channel coefficients, **Red**, **Green** and **Blue**, and **Emerald** on
  cameras with a fourth color channel. Temperature and tint are computed from
  the coefficients and your camera's color matrix as darktable does, and
  setting either one sets the coefficients (a photo whose camera has no color
  matrix cannot show them). Choosing a setting writes its coefficients, and
  editing a slider or coefficient switches the list to User modified; Settings
  shows the entry that matches the current coefficients. darktable's From image
  area entry, which needs its color picker, is not offered, and a photo without
  presets for its camera (a JPEG, for one) lists only the first four entries.
  Simple's White Balance sliders set color calibration, not this module. darktable allows one
  instance.
- **Color calibration**: tabs as in darktable. **CAT** has the adaptation,
  the illuminant (with its fluorescent or LED source, or a temperature for
  daylight and Planckian) and gamut compression; **R**, **G** and **B** mix the
  input channels into each output channel; **Colorfulness**, **Brightness** and
  **Gray** set the input weights of each, all with **Normalize channels**. Not
  yet on the card: the hue and chroma of a custom illuminant, the color
  picker, area color mapping and color checker calibration. Simple's Black &
  White conversion uses an instance of its own, which shows in the B&W group
  rather than here.
- **Highlight reconstruction**: **Method** and **Clipping threshold**, then
  the settings of the method chosen: segmentation's combine, candidating and
  rebuild (with strength and noise level), or guided laplacians' noise level,
  iterations, flat color and diameter. The card lists every method; darktable
  offers only those that suit the photo's sensor and switches to inpaint
  opposed if one does not. darktable allows one instance.
- **Tone mapper**: one card for darktable's four tone mappers, **AgX**,
  **Sigmoid**, **Filmic rgb** and **Base curve**, showing the one that is on.
  The switch button (two arrows) beside the card's name lists them; choosing
  another switches the current one off and the chosen one on, as one undo
  step. The old one keeps its settings, so switching back restores them. With
  none on, the card shows each tone mapper the photo has used. Add module lists
  them too, checked while the card shows one. Simple's tone mapper follows a
  switch made here.
  - AgX: tabs **Settings** (input exposure range, basic and advanced curve
    settings, look) and **Primaries** (before and after tone mapping). Its curve
    graph and pickers are not on the card yet.
  - Sigmoid: contrast, skew, color processing and preserve hue, then the
    **Primaries** and **Display luminance** sections.
  - Filmic rgb: tabs **Scene**, **Reconstruct**, **Look**, **Display** and
    **Options**. Its curve graph and pickers are not on the card yet.
  - Base curve: **Preserve colors** and exposure **Fusion**. The curve itself
    needs a curve editor and is not on the card yet.
- **Contrast & texture**: **Base detail level**, **Highlights** and
  **Shadows**, then **Coarse**, **Medium** and **Fine details** under Local
  contrast and **Halo control** and **Noise bias** under Filter settings. The
  detail mask preview buttons are not on the card yet.
- **Local contrast**: **Mode** (bilateral grid or local laplacian filter) and
  **Detail**, then **Coarseness** and **Contrast** for the bilateral grid, or
  **Highlights**, **Shadows** and **Midtone range** for the local laplacian
  filter.
- **Haze removal**: **Strength** and **Distance**.
- **Diffuse or sharpen**: under Properties, **Iterations**, **Central radius**
  and **Radius span**; under Speed, the four orders of speed; under Direction,
  the four orders of anisotropy; under Edge management, **Sharpness**, **Edge
  sensitivity** and **Edge threshold**; and under Diffusion spatiality, the
  **Luminance masking threshold**. Simple's Texture uses the first instance; the
  instance Simple's Sharpening uses is on the Detail group's card instead.
- **Color balance rgb**: three tabs. Master has **Hue shift**, **Global
  vibrance** and **Contrast**, then linear chroma, perceptual saturation and
  perceptual brilliance grading, each with a global slider and shadows,
  mid-tones and highlights. 4 ways has luminance, hue and chroma for the global
  offset, shadows lift, highlights gain and power, each with a color wheel
  above its sliders. Drag the wheel to set the hue and chroma together;
  double-click it to set chroma to 0. The wheel's edge is the end of the
  chroma slider, and a larger chroma typed in shows at the edge. Masks has the **Saturation
  formula**, the shadows and highlights fall-off, the mask and contrast gray
  fulcrums and the **White fulcrum**. The luminance range graph, mask previews,
  color pickers and mask preview settings are not on the card yet.

## Tone Curve modules

The Tone Curve group has these darktable modules:

- **Tone curve**: a point curve with **L**, **a** and **b** tabs, an
  **Interpolation method** (cubic, centripetal or monotonic spline, set for all
  three curves at once), **Color space**, and **Preserve colors** for RGB,
  linked channels. Click the graph to add a point, drag to move one,
  double-click a point or drag it off the graph to remove it. The **a** and
  **b** curves can be changed only when **Color space** is Lab, independent
  channels; in the linked modes they are shown but darktable leaves them alone.
  The graph draws the curve as darktable applies it. Simple's Tone Curve edits
  the same module.
- **RGB curve**: **Mode** (linked or independent channels), a point curve with
  the same editing and **Interpolation method**, **Compensate middle gray**,
  and **Preserve colors** for linked channels. Linked channels have the one
  curve; **R**, **G** and **B** tabs appear in independent mode. Simple's R, G
  and B curves edit the same module.
- **RGB levels**: **Mode** and, for linked channels, **Preserve colors**.
  The black, gray and white levels, their pickers and auto levels are not on
  the card yet.
- **Tone equalizer**: tabs **Simple** (the nine bands, -8 EV to +0 EV),
  **Advanced** (mask exposure and contrast compensation) and **Masking** (the
  luminance estimator, preserve details and, with a filter chosen, its
  diffusion, smoothing diameter, edge refinement and quantization). Its curve
  graph, curve smoothing, mask display and auto-adjust buttons are not on the
  card yet. Basic's Highlights and Shadows with tone equalizer chosen edits the
  same module.
- **Shadows and highlights**: **Shadows**, **Highlights**, **White point
  adjustment**, **Soften with**, **Radius**, **Compress** and the shadows and
  highlights color adjustments. Basic's Highlights and Shadows with shadows
  and highlights chosen edits the same module.

## HSL / Color modules

The HSL / Color group has these darktable modules:

- **Color equalizer**: **Node placement**, tabs **Hue**, **Saturation** and
  **Brightness** with a slider per hue (red to magenta), then the options:
  **White level**, **Hue curve** and **Use guided filter** with its radius,
  threshold and contrast settings. The node graph and its pickers are not on
  the card yet; Simple's HSL / Color edits the same module.
- **Saturation curve**: a graph of the **Saturation** and **Brilliance**
  curves (pick one from the menu; click to add a point, drag to move one,
  double-click a point or drag it off the graph to remove it), then
  **Saturation formula** and, under Guided filter, its switch, radius, edge
  feathering and noise protection. Simple's Saturation curve edits the same
  module.
- **Velvia**: **Strength** and **Mid-tones bias**.
- **Color contrast**: **Green-magenta contrast** and **Blue-yellow contrast**.
- **Color zones**: **Select by**, **Process mode** and **Mix**. Its curves
  are not on the card yet.
- **Color harmonizer**: **Harmony rule** (and **Nodes** for a custom rule),
  **Pull strength**, **Pull width**, **Neutral color protection** and
  **Smoothing**, then a saturation slider for each of the rule's hues. The
  anchor and custom hues and the swatches are not on the card yet.
- **RGB primaries**: hue (in degrees) and purity of red, green and blue,
  then **Tint hue** and **Tint purity**.
- **Color correction**: **Saturation**. Its color grid is not on the card
  yet.
- **Color look up table**: on/off, reset and darktable's presets (such as
  its film emulations). The patch grid and patch sliders are not on the card
  yet.
- **LUT 3D**: **Application color space** and **Interpolation**. Choosing
  the LUT file is not on the card yet.
- **Color mapping**: **Number of clusters**, **Color dominance** and
  **Histogram equalization**. Capturing the source and target colors is not
  on the card yet. darktable allows one instance.

## B&W modules

The B&W group has these darktable modules:

- **Color calibration**: the instance Simple's Black & White conversion uses
  when its module is color calibration, with the same tabs as in Basic, but
  **Gray** first. Add module turns on Simple's Black & White with color
  calibration, as one undo step. Switching Black & White or its module in
  Simple sets this instance's settings again.
- **Color equalizer**: the same instance as the HSL / Color group's card,
  with **Brightness** first, since Simple's B&W Mix sliders set its
  brightness. A change on one card shows on the other.
- **Monochrome**: **Highlights**, how much to keep the highlights. The color
  filter graph, which sets the filter's color and size, is not on the card
  yet.

## Color Grading modules

The Color Grading group has these darktable modules:

- **Color balance rgb**: the same instance as the Basic group's card, with
  **4 ways** first, since Simple's Color Grading wheels set its shadows lift,
  highlights gain, power and global offset. A change on one card shows on the
  other.
- **Color balance**: the **Mode** (lift, gamma, gain or slope, offset, power
  in ProPhoto RGB, or lift, gamma, gain in sRGB), then **Master**, with input
  and output saturation, the contrast fulcrum and contrast (not in the sRGB
  mode), and a factor with red, green and blue for shadows, mid-tones and
  highlights. darktable's hue and saturation sliders for each range, which it
  shows instead of red, green and blue by default, and the auto optimizers
  are not on the card yet.
- **Split-toning**: a hue and saturation for the shadows and for the
  highlights, then **Balance** and **Compress**. darktable's color buttons
  beside each are not on the card yet.
- **Colorize**: **Hue**, **Saturation**, **Lightness** and **Source mix**,
  how much of the photo's own lightness to keep.

## Detail modules

The Detail group has these darktable modules:

- **Demosaic**: the **Method**, with every method darktable has for any
  sensor, then the settings the method uses (**Dual threshold**, **Edge
  threshold**, **LMMSE refine**, **Color smoothing**, **Match greens**), and
  **Capture sharpen**, the switch Simple's Capture Sharpening sets, with its
  controls under it while it is on. darktable lists only your camera's
  methods and changes one for another sensor type to its nearest.
- **Sharpen**: **Radius**, **Amount** and **Threshold**. Simple's Sharpening
  with sharpen uses the first instance, so a change on one shows on the
  other.
- **Diffuse or sharpen**: the instance Simple's Sharpening uses when it is
  set to diffuse or sharpen, with the same settings as the Basic group's
  card, which shows the other instances. **Add module** makes it the way
  Simple does, at darktable's "sharpness | normal" preset.
- **Denoise (profiled)**: the **Mode** (non-local means or wavelets, each
  also auto), then the settings the mode uses and **Strength**. Simple's
  Profiled Denoise sets the wavelet curves, which are not on the card yet, nor
  is the profile choice: the card uses the profile darktable finds for the
  camera and ISO.
- **Highpass**: **Sharpness** and **Contrast boost**.
- **Astrophoto denoise**: **Patch size**, **Strength**, **Luma** and
  **Chroma**.
- **Raw denoise**: **Noise threshold**. Its curves are not on the card yet.
- **Surface blur**: **Radius**, then **Red**, **Green** and **Blue**.
- **Contrast equalizer**: a graph with a menu for its curves (**Luminance**,
  **Chroma**, **Edges**, **Luminance noise** and **Chroma noise**), each of six
  bands from coarse to fine; drag a point up or down, or use the arrow keys on
  a focused one. Then **Mix**. The bands sit at fixed positions, as in
  Simple's Contrast, which edits the same module for the first instance when
  Preferences set it to contrast equalizer.
- **Lowpass**: **Radius**, **Soften with**, **Contrast**, **Brightness** and
  **Saturation**.

## Lens modules

The Lens Corrections group has these darktable modules:

- **Lens correction**: the **Correction method** (darktable's Lensfun
  database, the corrections the camera or raw converter wrote into the file,
  or only a manual vignette), **Corrections**, then the method's own
  settings: for Lensfun, **Target geometry**, **Scale**, **Mode** and the
  **TCA override**; for embedded metadata, its **Fine-tuning**. **Manual
  vignette correction** works under every method. With the Lensfun method the
  card has Simple's **Lens** picker (Auto, the lens matched from the file, or
  a search of Lensfun's lenses), which sets that instance's lens. Simple's
  Lens Corrections uses the first instance and its Remove Chromatic
  Aberration sets **Corrections**; the card has no camera, focal length,
  aperture or distance menus. darktable offers embedded metadata only for a
  photo that has it.
- **Chromatic aberrations**: **Guide**, **Radius** and **Strength**, then
  **Correction mode** and **Very large chromatic aberration**. Simple's
  Defringe uses the first instance.
- **Raw chromatic aberrations**: **Iterations** and **Avoid colorshift**.
  It works only on raw photos from cameras with a Bayer sensor.
- **Hot pixels**: **Threshold**, **Strength**, **Detect by 3 neighbors** and
  **Mark fixed pixels**, for raw photos. Simple's Hot Pixels sets the same
  module, with its sliders on a 0 to 100 scale.

## Transform modules

The Transform group has these darktable modules:

- **Rotate and perspective**: **Rotation**, then under **Manual
  perspective** the vertical and horizontal **Lens shift** and **Aspect
  adjust**. Simple's Transform panel sets the same module, so its Upright,
  Vertical, Horizontal, Rotate and Aspect move these sliders. As in Simple,
  each edit crops to the largest rectangle of the photo's own shape, with no
  black corners; the card has no shear, lens model or automatic cropping
  settings. Upright's line detection stays in the Transform panel.
- **Orientation**: darktable's four buttons, rotate 90° left or right and
  flip horizontally or vertically. They turn the photo as the toolbar's
  buttons do, with the crop and masks. Reset puts back the orientation the
  camera recorded.
- **Scale pixels**: **Pixel aspect ratio**, for photos from cameras or
  scanners whose pixels are not square.
- **Enlarge canvas**: a border of plain color around the photo, as
  **Percent left**, **Percent right**, **Percent top** and **Percent
  bottom** of its width or height, and its **Color**.

## Effects modules

The Effects group has these darktable modules:

- **Vignetting**: **Fall-off start**, **Fall-off radius**, **Brightness**
  and **Saturation**, then under **Position / form** the **Horizontal
  center** and **Vertical center**, **Shape**, **Automatic ratio**,
  **Width/height ratio** and **Dithering**. Simple's Post-Crop Vignetting
  sets the same module, so its sliders move these.
- **Grain**: **Coarseness** (as an ISO value), **Strength** and **Mid-tones
  bias**. Simple's Grain sets the same module.
- **Bloom**: **Size**, **Threshold** and **Strength**.
- **Soften**: **Size**, **Saturation**, **Brightness** and **Mix**.
- **Blurs**: **Blur radius** and **Blur type**. A lens blur adds
  **Diaphragm blades**, **Concavity**, **Linearity** and **Rotation**; a
  motion blur adds **Direction**, **Curvature** and **Offset**; a gaussian
  blur has no more settings. The card has no preview of the blur's shape.
- **Lowlight vision**: **Blue shift**. The card does not yet have
  darktable's curve of how much each brightness level is affected.
- **Graduated density**: **Density**, **Hardness**, **Rotation**, **Hue** and
  **Saturation**. The card cannot yet move the filter's line on the photo,
  so the line stays through the center.
- **Censorize**: **Input blur radius**, **Pixelization radius**, **Output
  blur radius** and **Noise level**. Use it with a mask to hide part of a
  photo.
- **Framing**: **Basis**, **Border size**, **Aspect ratio**,
  **Orientation**, **Horizontal offset** and **Vertical offset**, then the
  frame line's **Frame line size** and **Frame line offset**. The card does
  not yet have darktable's aspect and position presets or the border and
  frame line colors, which stay white and black. **Aspect ratio** sets a
  custom ratio; by default the framed photo keeps its own.
- **Watermark**: **Opacity**, then under **Placement** **Rotation**,
  **Scale**, **Scale on** (with **Scale marker to** and **Scale marker
  reference** for its advanced options), **X offset** and **Y offset**. The
  card cannot yet choose the marker, its text, font or color, or its
  alignment, so it places darktable's default marker in the center.
- **Composite**: **Opacity**, then under **Placement** the same settings
  as Watermark. The card cannot yet choose the photo to place, so it has
  no visible effect yet.
- **Dither or posterize**: **Method**, and **Damping** for random dither.

## Technical modules

The Technical group, only in Advanced, has these darktable modules:

- **Raw black/white point**: **Black level 0** to **Black level 3**,
  **White point** and **Flat field correction**, for raw photos only. The
  card does not have darktable's raw crop margins, which darktable also
  hides unless a preference shows them.
- **Color reconstruction**: **Threshold**, **Spatial extent**, **Range
  extent** and **Precedence**, and **Hue** when the precedence is hue.
- **Input color profile**: **Input profile** and **Working profile**, each
  a list of the profiles this photo can use, and **Gamut clipping**. The
  Negative panel's profile menus set the same module.
- **Output color profile**: **Export profile**, from darktable's built-in
  profiles. Export always uses its own **Color space**, so this setting
  only matters when the photo's edits are opened in darktable.
- **Unbreak input profile**: **Mode**. Logarithmic shows **Middle gray
  luma**, **Black relative exposure**, **Dynamic range** and, under
  **Optimize automatically**, **Safety factor**, which scales both ranges
  as you change it; gamma shows **Linear** and **Gamma**. The card does
  not have darktable's auto tune button or its pickers.

## Instances

A module can have several instances, each with its own settings. Open the
**...** menu beside a card's reset button to:

- **New instance**: add another instance right after this one, at darktable's
  defaults and switched on. Its card opens.
- **Duplicate**: the same, with this instance's settings.
- **Rename...**: edit the name in the card's title. Enter or clicking away keeps
  it, Escape cancels, and an empty name goes back to darktable's own label.
  Names that Immage uses for masks and looks cannot be used.
- **Move up in the pipe** and **Move down in the pipe**: swap this instance
  with its neighbour among the module's instances. They are greyed out at the
  ends.
- **Delete**: remove the instance.

Modules that darktable allows only once grey out New instance, Duplicate and
Rename. Duplicating an instance that has a drawn darktable mask is refused with
a message for now.

An instance without a name shows darktable's own label after the module name:
the name of a matching preset, such as "scene-referred default", or the
instance number. A module's cards sit together, in pipe order: the top card is
earlier in the pipe, so it is applied first.

The first instance is the one Simple's sliders change. You can switch it off
but not delete it, and while a module has more than one instance its card shows
a small **Simple** tag.

Every action is one undo step, and Undo and Redo bring instances back with
their settings, names and order. A deleted instance is gone from the photo's
saved edit the next time it is saved. Extra instances look in Immage just as
they do in darktable, and open there.

Modules that Immage's masks and looks manage do not get cards. Groups whose
modules are not available yet show "No darktable modules yet".

Masks, Heal, Zones, Film Simulation, Negative, Crop and Presets work as they do
in Simple. Your edits are kept, and Simple shows them again when you switch
back.

## darktable presets

The **darktable presets** button on a card opens a menu headed **darktable
presets**. It lists darktable's presets for that module: built-in presets
first, then your own presets from Immage's darktable library, with a line
between the two, in darktable's order. A preset in a submenu shows as
"a › b".

- A check mark marks the preset that matches the instance now.
- Presets that do not apply to this photo, such as one for another version of
  the module or for another camera, lens or file format, are greyed out.
- An empty list shows **No presets**.

Choosing a preset replaces the instance's settings and blend settings with the
preset's, switches the module on or off as the preset says, and opens the card.
It is one undo step, named "Preset: <module>". darktable may rename the
instance after the preset, unless you renamed it yourself.

A preset cannot be applied to an instance that has a drawn mask, and a preset
that carries a mask cannot be applied at all. Immage shows an error in both
cases.

Not yet available: importing .dtpreset or .dtstyle files, saving the current
settings as a preset, and reading presets from a separate darktable
installation.
