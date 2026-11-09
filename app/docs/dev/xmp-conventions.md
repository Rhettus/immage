# Immage XMP conventions

Immage saves its persistent edit state in darktable XMP sidecars. This page
inventories the additional meaning Immage assigns to native mask and module
names, and its custom metadata property. Keep it current when adding, changing
or removing a convention.

## Compatibility contract

**None of these Immage conventions prevents a compatible darktable from loading
the photo and XMP, or changes the rendering darktable gets from the saved edit.**
The masks, blending operations and module parameters are native darktable data.
darktable renders those directly; it does not need to interpret Immage's names
or run AI. The extra AI recipe groups are disabled and contain no rendered
shapes. The custom location property is metadata and has no rendering effect.

“Compatible” still means a darktable version that supports the saved module and
mask versions. Immage uses development darktable formats, including flexi masks;
these conventions do not make older releases able to read newer formats. See
the [user compatibility guide](../darktable.md#compatibility).

Loading and rendering are distinct from preserving Immage's editing controls.
Renaming module instances or mask forms, deleting disabled forms, or rebuilding
mask trees in darktable can remove information Immage uses to recognize an edit.
Do not assume arbitrary edits in darktable preserve every Immage convention.
Likewise, darktable need not implement Immage's GPS deletion semantics.

## Inventory

Unless stated otherwise, storage below is ordinary darktable mask history or
module history serialized by darktable into the sidecar, without custom XML
fields. Implementations are in [engine/main.c](../../../engine/main.c).

| Convention | Storage and meaning | Reader/writer |
|---|---|---|
| Mask identity | Root group `immage: <name>` identifies an Immage mask. Local module instances use the mask name, optionally followed by `#<tag>` to distinguish controls using the same module. | `_mask`, `_mask_name`, `_mask_instance_tag`, `_named_instance` |
| Range organization | `immage ranges: <root group name>` identifies a product group containing the drawn mask and its parametric range elements. | `_set_ranges_group`, `_ranges_group`, `_instance_group` |
| Shared local adjustments | `immage combined: <name>` identifies a combined mask group; module instances beginning `immage local: ` associate shared adjustments with it. The actual combination is native flexi mask data. | `_combine`, `_combined_group`, `_instance_group` |
| AI component identity | Path names `immage: <mask> #<component>.<path>` associate traced paths with one selection. A trailing `-` identifies a hole for reconstruction; native mask operations implement its rendering. | `_object_paths`, `_masks` |
| Depth Range recipe | Path-name suffix `@<near>,<far>,<feather>` retains the depth band and feather setting alongside the traced paths. | `_object_shapes`, `_masks` |
| Fit to Background | Path suffixes `~` and `^` identify edge and plain outlines; `#<component>~` identifies the background color range, with `off` recording the option being off. Unused alternatives remain disabled. Native paths, parametric elements and group operations implement the result. | `_object_shapes`, `_backdrop_shape`, `_masks` |
| Background mask support | A path named `immage: <mask> #0` surrounds the input image and supports background selection. | `_base_shape`, `_is_base_shape` |
| AI selection recipe | Disabled, marker-only groups named `immage-ai-v1:<component>:<chunk>:<payload>` carry base64 JSON in chunks of up to 80 characters. The recipe stores the tool kind, normalized object clicks/box where applicable, and inset/backdrop options. Coordinates are stored in input-image space. | `_store_recipes`, `_read_recipe`, `_recipe_coordinates` |
| Heal/Clone organization | `immage spots` names the retouch group; `immage spot #<number>` names its forms. Geometry, source positions and algorithms use native masks and retouch parameters. | `_spots_group`, `_spots_set`, `_spots_json` |
| Applied Look identity | Module instance names beginning `look: ` identify modules belonging to an applied Look, with its label in the name. Their parameters and blending remain native module data. | `_is_look`, `_look_instance`, `_look`, `_look_name` |
| Authoritative location metadata | `Xmp.immage.locationManaged=True` means missing GPS coordinates or altitude in the sidecar are intentional and must override embedded source GPS when Immage imports it. Namespace URI: `https://github.com/Rhettus/immage/ns/1.0/`. This is a custom XMP property. | `location_sidecar_mark`, `location_sidecar_missing` in [engine/strip.cc](../../../engine/strip.cc); save/import in `main.c` |

For mask construction and recipe lifecycle, see [Masks in darktable's pipe](masks.md)
and [AI recipes and paste](masks.md#ai-recipes-and-paste).

## Related native metadata

AI Denoise writes `Xmp.darktable.neural_restore=raw-denoise` into the generated
DNG, together with its camera orientation. This is darktable's own marker,
not an Immage namespace extension. It prevents automatic denoise presets from
denoising the result again. See `denoised_metadata` in
[engine/strip.cc](../../../engine/strip.cc).

Standard descriptive metadata, GPS values, keywords, ratings and color labels
also use existing metadata or darktable fields. They are not additional Immage
conventions merely because Immage writes them.

## Why keep this in XMP?

The sidecar is Immage's permanent edit record; its darktable library is rebuilt
in memory. Storing these conventions with the edit allows them to survive
reopening and travel with the photo and sidecar. Mask-associated information
also stays in the same history as the geometry it describes, including virtual
copies and paste snapshots.

A separate database or companion file could technically store this information,
but would introduce another persistent record to copy and synchronize. Embedded
XMP is also technically possible for some formats; Immage's edit persistence
uses sidecars rather than writing edit history into source photos.

## Maintenance

For each new convention, document its encoding, owning reader/writer, rendering
effect and behavior when information is missing. Keep native darktable rendering
independent of Immage-only interpretation. Version structured payloads, as with
`immage-ai-v1:`, and define how older edits behave when they lack the payload.
Do not infer an AI tool from a user-editable mask name.
