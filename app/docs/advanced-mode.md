# Advanced mode

Advanced mode is for working with darktable's own modules. Turn it on in
[Preferences](preferences.md#general) > General > **Editing mode**, and
back to **Simple** the same way. Switching does not change the photo or its
edits.

In Advanced, the **Adjustments** panel looks like this:

- A **Search modules** box at the top. It does not find anything yet.
- The same groups as Simple (Basic, Tone Curve, HSL / Color, B&W, Color
  Grading, Detail, Lens, Transform and Effects), in the same order. They fold
  open and shut as in Simple, follow Focus mode, and Alt-click opens one alone.
  HSL / Color and B&W both show whether or not the photo is black and white,
  where Simple shows one or the other.
- A **Technical** group at the end, which exists only in Advanced.
- No **More controls** sliders icon; that icon is only in Simple.

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

- **White balance**: the channel coefficients, **Red**, **Green** and
  **Blue**, and **Emerald** on cameras with a fourth color channel. The card
  does not yet have darktable's settings list (as shot, camera reference and
  the camera's presets) or its temperature and tint sliders; Simple's White
  Balance sliders change the same module. darktable allows one instance.
- **Color calibration**: tabs as in darktable. **CAT** has the adaptation,
  the illuminant (with its fluorescent or LED source, or a temperature for
  daylight and Planckian) and gamut compression; **R**, **G** and **B** mix the
  input channels into each output channel; **Colorfulness**, **Brightness** and
  **Gray** set the input weights of each, all with **Normalize channels**. Not
  yet on the card: the hue and chroma of a custom illuminant, the color
  picker, area color mapping and color checker calibration. Simple's
  calibration and Black & White's calibration use their own instances; only
  the first shows here.
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
  **Luminance masking threshold**.
- **Color balance rgb**: three tabs. Master has **Hue shift**, **Global
  vibrance** and **Contrast**, then linear chroma, perceptual saturation and
  perceptual brilliance grading, each with a global slider and shadows,
  mid-tones and highlights. 4 ways has luminance, hue and chroma for the global
  offset, shadows lift, highlights gain and power. Masks has the **Saturation
  formula**, the shadows and highlights fall-off, the mask and contrast gray
  fulcrums and the **White fulcrum**. The luminance range graph, mask previews,
  color pickers and mask preview settings are not on the card yet.

## Tone Curve modules

The Tone Curve group has these darktable modules:

- **Tone curve**: **Color space**, and **Preserve colors** for RGB, linked
  channels. The curve itself and its interpolation method need a curve editor
  and are not on the card yet; Simple's Tone Curve edits the same module.
- **RGB curve**: **Mode** (linked or independent channels), **Compensate
  middle gray**, and **Preserve colors** for linked channels. The curves are
  not on the card yet; Simple's R, G and B curves edit the same module.
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
- **Saturation curve**: **Saturation formula** and, under Guided filter, its
  switch, radius, edge feathering and noise protection. The saturation and
  brilliance curves are not on the card yet.
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
