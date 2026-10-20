# Masks

Masks let you adjust one part of the photo: brighten a face, darken the
sky, warm the foreground. Each mask has its own set of sliders.

**If you've used another editor:** this is the usual masking panel. It
has the usual tools (AI Subject, Sky, Background, People, Select Object, brush,
linear and radial gradients, color, luminance and depth ranges) and the
same keys: K brush, M linear, ⇧M radial, ⇧J color range, ⇧Q luminance
range, O overlay.

Open it with **Masks** on the rail, or press one of the tool keys.

![The Masks panel with a Sky mask and the red overlay](images/masks-panel.png)
<!-- screenshot: Masks mode, a landscape with a Sky mask selected, overlay on, local sliders visible -->

## Creating a mask

Click **Create New Mask** and choose:

| Group | Tools |
| --- | --- |
| AI | **Subject**, **Sky**, **Background**, **People**, **Landscape** ▸ (**Sky**, **Water**, **Vegetation**, **Mountains**, **Natural Ground**, **Architecture**, **Artificial Ground**), **Select Object** |
| Shapes | **Brush** (K), **Linear Gradient** (M), **Radial Gradient** (⇧M) |
| Ranges | **Color Range** (⇧J), **Luminance Range** (⇧Q), **Parametric**, **Depth Range** |

- **AI** tools find the area for you. The first time you use one, its
  model downloads ("first use only"), which takes a moment. **Select
  Object**: click the object, or drag a box around it. **Background** is
  the subject's outline, inverted.
- **Brush**: paint; hold ⌥ to erase.
- **Linear Gradient**: drag across the photo where the change should
  happen.
- **Radial Gradient**: drag out an ellipse, or click for a circle.
- **Color Range**, **Luminance Range** and **Depth Range**: click the photo
  on the color, brightness or distance to select.

A new mask is named after its kind, such as **Sky** or **Radial**. Make a
second of the same kind and they become **Radial 1** and **Radial 2**.

## Shaping a mask

Select a mask, then use **+** to add to it or **−** to subtract from it,
with any of the same tools. Under **+**, the ranges are listed under
**Intersect**: they narrow the mask to a color, brightness or depth within
it. For example, add a Sky mask, then intersect a Luminance Range to keep
only its bright clouds.

Each part of the mask is listed under it, with a **+** / **−** switch and
**×** to delete it.

On the photo, drag a shape's handles: the center moves it, the edges size
it, the arrow rotates it, and the outer ring sets its feather.

## The mask list

- The eye shows or hides the mask's adjustments.
- Hover over a name for a moment to see that mask in red.
- Double-click a name to rename it.
- The **…** menu has **Duplicate Mask**, **Duplicate and Invert Mask**,
  **Rename Mask** and **Delete Mask**.
- O, or the eye in the panel's title, shows or hides the red overlay.

## Mask settings

- **Invert**: adjust everything except the mask.
- **Opacity**: 0-100%, how strongly the mask's adjustments apply.
- **Refine**:
  - **Edge Aware**: softens the edge so it follows edges in the photo
  - **Blur**: softens the edge
  - **Detail**: keeps the mask to detailed areas, or flat ones (raws only)
  - **Contrast**: hardens or softens the mask's falloff
- A part's own settings: **Feather** for brushes, radial gradients and
  objects; **Near**, **Far** and **Feather** for depth; **Low (EV)**,
  **High (EV)** and **Smoothness** for luminance; **Refine** and
  **Smoothness** for color.

## The brush

**Size** (0.5-40% of the photo), **Feather** (0-100), **Density** (1-100)
and **Erase (hold ⌥)**.

| Key | Action |
| --- | --- |
| [ and ] | brush size |
| Scroll | brush size; ⇧-scroll its feather |
| ⌥-drag | erase |
| Esc | put the brush down |

## Parametric

**Parametric** selects by darktable's blending channels: gray, red, green,
blue, and lightness, chroma and hue (Jz, Cz, hz). Each channel has a slider
with four markers that set the range and its soft edges, and a **+** / **−**
switch for inside or outside it. Drag a box on the photo to set a channel
from it. **Boost** raises the range for bright highlights, and **Invert
Polarities** flips every channel. Double-click a channel to reset it.

## Adjusting inside a mask

The selected mask's sliders sit below its settings, in six groups:

- **White Balance**: **Temp**, **Tint**
- **Tone**: **Exposure** (±4), **Contrast**, **Highlights**, **Shadows**,
  **Whites**, **Blacks**
- **Presence**: **Texture**, **Clarity**, **Dehaze**, **Hue**,
  **Saturation**
- **HSL**: **Hue**, **Saturation** and **Luminance** tabs, each with the
  eight color bands
- **Color Grading**: **3-Way**, **Global** or **Sliders**, for shadows,
  midtones, highlights and global
- **Detail**: **Sharpening**, **Noise**, **Defringe**

They work like the same sliders in [Adjustments](adjustments.md), only
inside the mask. A new mask opens its **Tone** group.

Where masks overlap, their adjustments add up. **Contrast**,
**Saturation**, **Whites**, **Color Grading**, **HSL**, **Texture**,
**Noise** and **Defringe** add up only to the end of their own slider, so two masks at +80 Contrast give
+100 where they meet.

## Keys

| Key | Action |
| --- | --- |
| K | Brush |
| M | Linear gradient |
| ⇧M | Radial gradient |
| ⇧J | Color range |
| ⇧Q | Luminance range |
| [ ] | Brush size |
| O | Show or hide the overlay |
| Esc | Put the tool down |
