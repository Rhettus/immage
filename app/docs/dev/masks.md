# Masks in darktable's pipe

How a mask with its local sliders becomes darktable history, and why it is
built that way. The [diagram](diagrams/masks.svg) shows the same for one
mask. The [code map](code-map.md) says where each part lives; the comments
beside the code hold the details this page leaves out.

A mask in Immage works the way Lightroom's do: one mask, and every local
slider on it. darktable has no such thing. There, a mask belongs to a module
instance, so a darktable user who wants exposure and warmth in the sky makes
two instances and gives each the same mask. Immage builds exactly that, for
every slider the mask uses, out of ordinary darktable parts:

- the mask's shapes are a darktable **mask group**
- each module a slider sets gets an **instance named after the mask**, with
  that group as its drawn mask
- Immage places those instances in the pipe, in an order the user cannot
  change

Everything is ordinary history, saved in the XMP sidecar. darktable opens the
photo with the same instances and masks and renders it the same.

## The shapes: one mask group

The engine's `mask` command (`_mask` in [main.c](../../../engine/main.c))
turns a mask's shapes into a darktable group named `immage: <mask>`. Brush,
linear and radial gradients become darktable's brush, gradient and ellipse
forms. AI selections (Object, Subject, Sky, Depth Range and the rest) are
traced into path forms, so the model is needed only when the selection is
made, never to render.

Color and luminance ranges are not shapes in darktable. They are a module's
parametric (blendif) mask, so the engine keeps each mask's ranges and sets
them on every instance the mask drives (`_apply_ranges`). The refinements
(feather, blur, detail, contrast) are blend parameters in the same way. The
mask's Opacity slider is each instance's opacity.

## The adjustments: one instance per module

Each local slider maps to a module in `localMaps` in
[manifest.ts](../../src/manifest.ts). Sliders on the same module share an
instance:

| Local sliders | Instance of |
|---|---|
| Temp, Tint | color calibration |
| Exposure, Blacks | exposure |
| Contrast, Whites, Saturation, Hue, Color Grading | color balance rgb |
| HSL | color equalizer |
| Highlights, Shadows | tone equalizer, or shadows and highlights |
| Texture | diffuse or sharpen |
| Clarity | local contrast |
| Dehaze | haze removal |
| Noise | denoise (profiled) |
| Defringe | chromatic aberrations, or defringe |
| Sharpening | sharpen, or a second diffuse or sharpen (`<mask>#sharpen`) |

Where a tool can run on more than one module, the mask uses the same module
as the photo's global setting (Preferences › Modules).

Local Whites is color balance rgb's highlights brilliance, not the tone
mapper's white point: AgX and sigmoid apply to the whole image and cannot be
masked. The `localMaps` comments give the reasons for the other mappings.

An instance is made when its first slider moves, starts from the module's
defaults for the photo rather than from the global instance's settings, and
is switched off, keeping its settings, when the mask is hidden or the Before
view is on.

## Where the instances run

`_named_instance` in main.c moves each new instance to just after **color
balance rgb**, which the engine calls the mask anchor. In darktable's v5.0
module order that is the last scene-referred color module before the tone
mapper. Running there means:

- the data is linear and scene-referred, so a local +1 EV is exposure's
  own +1 EV under the mask, and AgX or sigmoid tone-maps it with the rest of
  the photo
- every instance sees the same input, so the values a color or luminance
  range was sampled at (`sample`, read at the anchor's output) are right for
  all of them
- the global modules ahead of the tone mapper have run, so a mask adjusts
  the photo as the global sliders left it, as in Lightroom

Two modules stay where darktable normally runs them, ahead of the anchor:

- **denoise (profiled)**, because its noise profile describes the camera's
  data at that point and not the data after exposure and color calibration
- **haze removal**, because after the anchor its ambient light estimate goes
  negative and a positive strength has nothing to remove

Modules that already run after the anchor, such as local contrast, stay
where they are.

The order is fixed. Immage has no way to move a module, so the question of
what a mask's instances do when a global module moves never comes up in
Immage. In darktable the user can move them like any instance.

## Sharing instances between masks

One instance per mask per module gets slow: ten masks on color balance rgb
are ten runs of the module, and a drag on any of them waits on the rest.
For the modules marked `merge` in `localMaps`, `planMerge` in
[localMerge.ts](../../src/localMerge.ts) lets masks share instead:

- a shared instance, `immage local: <op> <n>`, runs once for several masks
- its drawn mask is a **combined mask**, `immage combined: <op> <n>`
  (`_combine` in main.c): the members' own groups, summed, each at an opacity
  that scales the shared instance's strength down to that member's own
- each mask keeps its own instance too, switched off, holding its settings
  so they can be read back

Masks are grouped either by the direction their sliders point, or by slider
and sign, whichever needs fewer shared instances. A shared instance is set
strong enough for where its members overlap most, because the combined mask
stops at 1. The comments in `planMerge` give the arithmetic.

Some masks cannot share (`canMerge`) and keep their own instance on: an
inverted mask with ranges, a mask of ranges alone, and a mask with refine
Contrast. Masks share only with masks that have the same ranges and
refinements, since the shared instance carries those.

While a mask is dragged, `Session.pump` lifts it out of the shared
instances onto its own (`Session.lifted`). Its own instances run after the
shared ones, so the drag frames rerun only those, and the others' combined
mask stays in darktable's cache. It joins the shared instances again before
the frame at release. `_combined_member_changed` keeps a combined mask
current when a member is reshaped or deleted.

A photo whose masks were made before sharing keeps its own instances until a
mask is next edited; that edit sends every mask again, which moves the photo
over to shared instances.

## In darktable

Opened in darktable, a photo with a mask "Sky" shows:

- in the mask manager, the group `immage: Sky` with its shapes, and a
  group `immage combined: ...` for each shared instance
- in the module list, the instances named `Sky` (and `Sky#sharpen`), and
  `immage local: ...` for the shared ones, each with its drawn mask, ranges
  and refinements in its blending panel
- the mask's own instances that a shared instance stands in for, switched
  off

Changes made there are kept by Immage, which finds a mask's instances by
name. An instance renamed in darktable is no longer one Immage recognizes as
the mask's, but it stays in the history and keeps rendering.
