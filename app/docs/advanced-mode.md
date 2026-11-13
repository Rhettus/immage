# Advanced mode

Advanced mode is for working with darktable's own modules. Turn it on in
[Preferences](preferences.md#general) > General > **Editing mode**, and
back to **Simple** the same way. Switching does not change the photo or its
edits.

In Advanced, the **Adjustments** panel looks like this:

- A **Search modules** box at the top. It does not find anything yet.
- The same groups as Simple (Basic, Tone Curve, Color (HSL), B&W, Color
  Grading, Detail, Lens, Transform and Effects), in the same order. They fold
  open and shut as in Simple, follow Focus mode, and Alt-click opens one alone.
- A **Technical** group at the end, which exists only in Advanced.
- No **More controls** sliders icon; that icon is only in Simple.

## Module cards

The Basic group shows darktable's **exposure** module as a card. The card has:

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

Modules that Immage's masks and looks manage do not get cards. The other groups
show "No darktable modules yet" for now.

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
