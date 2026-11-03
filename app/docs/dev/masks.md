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

- the mask's shapes are a darktable **flexi mask group**
- each module a slider sets gets an **instance named after the mask**, with
  that group as its mask
- Immage places those instances in the pipe, after one fixed module, the
  [mask anchor](#where-the-instances-run), in an order the user cannot
  change

Everything is ordinary history, saved in the XMP sidecar. darktable opens the
photo with the same instances and masks and renders it the same.

## The shapes: one mask group

The engine's `mask` command (`_mask` in [main.c](../../../engine/main.c))
turns a mask's shapes into a darktable flexi group named `immage: <mask>`
(darktable's `dev-doc/masks_data_model.md`). A flexi group's first point
is a marker saying how its members combine. Runs of added shapes go into a
group whose members fold by maximum; a subtracted shape is taken away by a
flexi difference group. An instance using flexi groups has `mask_mode`
`DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI`. darktable converts the classic
groups it finds in older edits (`src/develop/masks/migrate_legacy.c`) when it
loads them, moving subtraction from each member's state to a marker, so
the engine writes flexi groups itself, which loading leaves alone. Its
readers (`_flatten`, `_shape_json`) walk any flexi tree back to the panel's
list of added and subtracted shapes, so an edit saved under the earlier
pin, which darktable migrates on load, reopens with the shapes it was made
with. Brush,
linear and radial gradients become darktable's brush, gradient and ellipse
forms. AI selections (Object, Subject, Sky, Depth Range and the rest) are
traced into path forms, so the model is needed only when the selection is
made, never to render. A Subject, People or Object selection over a plain,
colorful background is built so its feather stops at that color; see
[Selections over a plain background](#selections-over-a-plain-background).

Color and luminance ranges are not drawn shapes. The engine builds them as
darktable converts a classic parametric mask: one parametric element per
channel, multiplied with the mask's shapes in a flexi product group named
`immage ranges: <mask>` (`_set_ranges_group`). The instances that blend in
scene-referred RGB, where the ranges were measured, take that group; the
rest take the shapes alone (`_apply_ranges`). The refinements
(feather, blur, detail, contrast) are blend parameters in the same way. The
mask's Opacity slider is each instance's opacity.

## Selections over a plain background

darktable feathers a path outward only. An AI selection's outline is
therefore traced half a feather inside the subject's edge (`_trace_json`
in [main.c](../../../engine/main.c)), so the feather fades out about half
a feather beyond it. Lift that by a stop and the fade shows on the
background as a halo, worst over water or sky.

Where the background is one plain, vivid color that the subject's edge
stands clear of, the engine builds the selection so the feather stops at
that color instead:

```
Subject, People or Object, adding to a mask
│
├─ not the mask's first shape (the app asks only when it starts one),
│  or taking away from a mask ──────────────────────► default outline
├─ Fit to Background turned off ───────────────────► default outline
│
└─ _backdrop() looks at a ring 0.3-1.2% of the long side outside it
   │
   ├─ under 75% of the ring colorful (Cz/Jz ≥ 0.1) and near
   │  one hue ─────────────────────────────────────────► default outline
   ├─ the ring's median Cz/Jz under 0.25 (pale)  ──────► default outline
   ├─ over 10% of the band just outside the edge dull
   │  or near the window's ends (unclear) ─────────────► default outline
   ├─ the hue window crosses hz 0/1 ───────────────────► default outline
   │
   └─ otherwise ───────────────────────────────────────► backdrop mask
```

The **default outline** is the outline half a feather inside the edge, as
before.

The **backdrop mask** is three members in darktable's group, folded in
order (`_object_shapes`):

1. the outline on the edge, so its feather goes over the edge
2. ∩ a parametric shape that takes the background's hue window out
   (`_backdrop_shape`), so that feather stops at the color
3. ∪ the outline a whole feather inside the edge, whose feather ends at the
   edge, so the subject keeps its mask wherever its own colors match the
   background (a blue-shaded white chest over blue water)

That is max(inset, min(edge, not background)). It is never below the
inset outline, so the hue cannot cut holes in the subject, and outside the
edge it is the edge outline's feather less the background color.

The app keeps the edge outline, the window and the default outline on
the object shape as `backdrop` (`ObjectShape` in
[masks.ts](../../src/masks.ts)), and the engine reads them back from the
shapes' names (`#k.i~` for the edge paths, `#k~` for the hue shape,
`#k.i^` for the default outline). The shape's Feather section has a
**Fit to Background** switch, on by default: off, the engine uses the
default outline and names the hue shape `#k~off`. Whichever members are
not in use are kept with darktable's disabled state, which its group
passes over, so the switch, or moving the shape first in its mask, comes
back to them after the photo is opened again.

The app's own overlay drawn from the paths would show the inset outline
alone, missing the rim and any part thinner than two feathers, such as a
beak, so a mask using its backdrop shows the engine's `mask_map`
(`readsBackdrop`), as a refined mask does.

Each limit stands for a failure seen on a test photo:

| Limit | What fails without it |
|---|---|
| cover 75% | a busy background: the edge outline's wider feather goes through wherever the ring is another color |
| vivid 0.25 | a child before a cream wall: the faint hue drops in and out of the window with the noise, speckling the edge |
| clear 10% | a face before green leaves, hair over pale bokeh: the same speckle, from the pixels at the window's ends |

On a stilt over water, the mask 1-3 px outside the edge fell from 49% to
31% and 4-10 px from 16% to 11%, while the rim 1-3 px inside rose from 70%
to 80%. Blurring or feathering the hue shape cleared the speckle but gave
the halo back, which is why the limits keep such photos out instead.

darktable evaluates the hue shape with the module's own `mask_combine`
(`masks/parametric.c`). An inverted mask with ranges (`DEVELOP_COMBINE_INV`)
would invert the shape too, so `_backdrop_polarity` flips its channel to
match. Such a mask shares no instance (`canMerge`), so every instance of it
agrees.

## The adjustments: one instance per module

Each local slider maps to a module in `localMaps` in
[manifest.ts](../../src/manifest.ts). Sliders on the same module share an
instance:

| Local sliders | Instance of |
|---|---|
| Temp, Tint | color calibration |
| Exposure, Blacks | exposure |
| Contrast | color balance rgb, or contrast equalizer (`atrous`) |
| Whites, Saturation, Hue, Color Grading | color balance rgb |
| HSL | color equalizer |
| Highlights, Shadows | tone equalizer, or shadows and highlights |
| Texture | diffuse or sharpen, or contrast & texture (`<mask>#texture`) |
| Clarity | local contrast, or contrast & texture |
| Dehaze | haze removal |
| Noise | denoise (profiled) |
| Defringe | chromatic aberrations |
| Sharpening | sharpen, or a second diffuse or sharpen (`<mask>#sharpen`) |

Where a tool has alternatives, Preferences › Modules › Masks chooses them
independently from Global. `MASK_MODULE_CHOICES` lists the supported local
options; the default masked Contrast is color balance rgb, since AgX cannot
run inside a mask. Session initializes new masks from these scoped preferences
and infers loaded masks' choices from their instances. Each mask stores its
`mod_*` selections in `Mask.values`; rendering and sharing resolve those
before the photo's global values. Used adjustments keep their modules when
Preferences closes, while unused tools take the current mask preferences.

For masked contrast equalizer, `mod_contrast = 2` shows ContrastEqualizer in
the mask's Tone group. `equalizerMap` maps the same 30 `ce_*` controls as the
global graph to the mask's own atrous instance. Its first three channels are
neutral at 0.5 and the two noise channels at 0; enablement uses those defaults,
and reload keeps the values' 0.001 precision. Atrous instances are not merged.
Color balance rgb still carries the other local controls, with its Contrast
written at neutral when the mask selects atrous.

Local Whites is color balance rgb's highlights brilliance, not the tone
mapper's white point: AgX and sigmoid apply to the whole image and cannot be
masked. The `localMaps` comments give the reasons for the other mappings.

An instance is made when its first slider moves, starts from the module's
defaults for the photo rather than from the global instance's settings, and
is switched off, keeping its settings, when the mask is hidden or the Before
view is on.

## Where the instances run

The **mask anchor** is the one place in the pipe where masks' instances
run, with the two exceptions below: just after the photo's own **color
balance rgb** (`_MASK_ANCHOR` in main.c). In darktable's v5.0 module order
that is the last scene-referred color module before the tone mapper.
`_named_instance` moves each new mask instance there, and a color or
luminance range is sampled from the anchor's output (`sample`,
`_STAGE_ANCHOR`). Running there means:

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

With an instance per mask, a frame costs a run of the module for every
mask: color balance rgb is some 30 ms a draft frame, so ten masks on it are
ten runs. Worse, each new instance went in right after the anchor, ahead of
the older ones, so a drag on the newest mask reran every older mask's
instance as well. At ten masks a draft frame took about 340 ms, and the
cost grew with every mask added.

Sharing makes the cost depend on how many *kinds* of adjustment the masks
make, not on how many masks there are. It rests on how darktable blends a
module into the image. With the normal blend mode an instance's output is

    out = in + m · (module(in) - in)

where `m` is its mask at that pixel, 0 to 1. The module runs over the whole
image once; the mask only decides how much of its change each pixel keeps.
So one instance set to a strength `S` stands in for a mask that wants
strength `s` wherever its mask counts `s / S`. For a module whose change
grows roughly in step with its strength, which over a slider's range color
balance rgb's does, that is close to the mask's own instance.

Many masks then fit on one instance: its mask is the sum of theirs, each
member counted at `s / S` times its own opacity. darktable already has such
a mask, a flexi group whose members add (`DT_MASKS_STATE_FLEXI_SUM`), and
drawing it is far cheaper than running the module once per member. Overlapping masks add
up, as Lightroom's do.

In Immage, for the modules marked `merge` in `localMaps`, `planMerge` in
[localMerge.ts](../../src/localMerge.ts) does this (the
[sharing diagram](diagrams/mask-sharing.svg) shows four masks on two
shared instances):

- a shared instance, `immage local: <op> <n>`, runs once for several masks
- its drawn mask is a **combined mask**, `immage combined: <op> <n>`
  (`_combine` in main.c): the members' own groups, summed, each at an opacity
  that scales the shared instance's strength down to that member's own
- each mask keeps its own instance too, switched off, holding its settings
  so they can be read back

Only masks whose settings point the same way can share an instance, since
it has one set of params. Masks are grouped either by that direction, or one
group per slider and sign with the mask's other sliders at neutral,
whichever needs fewer instances. The second puts any number of masks with
the same ranges and refinements on at most two instances per slider. A
shared instance is set strong enough for where its members overlap most,
because the combined mask stops at 1, and never weaker than its strongest
member, which therefore renders exactly. The comments in `planMerge` give
the arithmetic.

Some masks cannot share (`canMerge`) and keep their own instance on: an
inverted mask with ranges (darktable inverts a drawn mask and its ranges as
a whole, which no member of a sum can be), a mask of ranges alone (no drawn
mask to be a member), and a mask with refine Contrast (it curves the mask
before the instance's opacity). Ranges and refinements are an instance's
blend parameters, so masks share only with masks that have the same ones,
which the shared instance carries.

While a mask is dragged, `Session.pump` lifts it out of the shared
instances onto its own (`Session.lifted`). Its own instances run after the
shared ones, so the drag frames rerun only those, and the others' combined
mask stays in darktable's cache. It joins the shared instances again before
the frame at release. `_combined_member_changed` keeps a combined mask
current when a member is reshaped or deleted.

What it bought, from the benchmark's masks table
([SUMMARY.md](../../../benchmarking/SUMMARY.md), median across photos,
CPU):

| Step | Instance per mask | Shared |
|---|---:|---:|
| 5 masks, drag on the newest, draft | 187 ms | 73 ms |
| 10 masks, drag on the newest, draft | 340 ms | 82 ms |
| 10 masks, drag on the newest, release | 1,377 ms | 409 ms |
| 10 masks, newest shape moved, draft | 358 ms | 99 ms |
| 10 masks, drag on the oldest, release | 192 ms | 396 ms |

The last row is the price: the oldest mask's instance used to run last, so
a change to it reran only that, where now its release reruns the shared
instance. The approximation is close: separate masks render within dE p99
of about 1 of 255 of their own instances, and where many masks overlap
within about 8.

A new darktable module could have done the same exactly, but would have
meant changing darktable (`src/common/iop_order.c`); sharing uses only
parts darktable already has, so the photo still opens and renders the same
there.

A photo whose masks were made before sharing keeps its own instances until a
mask is next edited; that edit sends every mask again, which moves the photo
over to shared instances.

## In darktable

Opened in darktable, a photo with a mask "Sky" shows:

- in the mask manager, the group `immage: Sky` with its shapes, a group
  `immage ranges: immage: Sky` when the mask has ranges, and a group
  `immage combined: ...` for each shared instance
- in the module list, the instances named `Sky` (and `Sky#sharpen`), and
  `immage local: ...` for the shared ones, each with its drawn mask, ranges
  and refinements in its blending panel
- the mask's own instances that a shared instance stands in for, switched
  off

Changes made there are kept by Immage, which finds a mask's instances by
name. An instance renamed in darktable is no longer one Immage recognizes as
the mask's, but it stays in the history and keeps rendering.

## Linux AppImage AI loading diagnostics

`app/scripts/diagnose_ai_appimage.sh` temporarily overrides `DT_ENGINE_BIN` with
a report-local shell wrapper. It resolves the packaged engine through `APPDIR`,
preserves its stdin/stdout protocol and arguments, adds `-d ai` after the core
arguments, and redirects native stderr into `engine-ai.log`. Native performance
lines also go there rather than through the app's performance parser for this
one diagnostic run. No application rebuild is needed, including for the
0.41.0-based launcher test image. The script collects launcher output, platform
and AppImage identity, and before/after Object model sizes/checksums/config,
then creates a tar.gz after the app exits. It does not gather arbitrary app
configuration or photos. Avoid Relaunch: a restarted process can outlive the
collector's original app process and continue writing after archiving.

The ordinary engine log only enables `-d perf`, so generic `cannot load` errors
can omit the ONNX session or segmentation failure. `withModel` reinstalls once
per request after that error; repeated downloads do not prove repeated network
failures. Check the native diagnostics before deleting models or changing the
runtime. Object requires `encoder.onnx` and `decoder.onnx`; Subject's independent
model success is not a complete Object load test.

Run `python3 -I scripts/test_ai_diagnostics.py` for command-line fixtures that
check wrapper argument preservation, AI logging, exit-status reporting, model
metadata and archive creation. These fixtures never start a GUI. The engine passes `--models` into core configuration as
`plugins/ai/models_path` and enables AI **before** `dt_init`, after incoming core
arguments. The global model registry and inference environment therefore inspect
the same folder, even with a stale saved path or an already-enabled profile.
Previously, Object loaded both ONNX files but checked the default darktable
folder for their version, reporting a valid model as incompatible version 0.0.
`_seg_ready` refreshes registry status alongside the inference environment before
loading, so downloads after startup are recognized. Minimum model version
validation remains enforced.

Run `DT_ORT_LIBRARY=/path/to/libonnxruntime.so python3 scripts/test_ai_model_path.py`
with a built AI engine and the cached model in
`build/ai-models/mask-object-sam21-small`. This headless regression uses isolated
profiles, copied configuration and read-only references to cached weights. It
checks enabled/disabled startup settings, a persisted enabled profile, conflicting
core model paths, paths with spaces, installation after startup, and rejection
of an incompatible version. It uses no GUI or downloads.
