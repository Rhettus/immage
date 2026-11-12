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

Modules that Immage's masks and looks manage do not get cards. The other groups
show "No darktable modules yet" for now.

Masks, Heal, Zones, Film Simulation, Negative, Crop and Presets work as they do
in Simple. Your edits are kept, and Simple shows them again when you switch
back.
