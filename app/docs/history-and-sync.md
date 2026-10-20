# History, undo and copying settings

Every edit is a step you can undo, and any part of an edit can be copied
to other photos.

**If you've used another editor:** the History card is the usual history
panel, and Copy / Paste / Previous are the usual copy settings, paste
settings and paste settings from the previous photo, with the usual keys.

## Undo and redo

⌘Z undoes the last edit; ⇧⌘Z redoes it. The undo and redo buttons at the
top corner of the photo do the same. A continuous slider drag counts as
one step.

## The History card

The **History** card in the Library panel lists the edit, newest at the
top:

- this session's steps, named after what changed, such as
  **Exposure** or **New mask**. Click one to go back to it; steps above it
  turn gray, and redo brings them back.
- below them, what the photo opened with: **original**, any edit from
  darktable or an earlier session, and what Immage started it with (the
  tone mapper, profile, the new-photos preset, Auto).

The eye button hides modules that are in the history but switched off.

The compress button, beside the eye, is darktable's **compress history
stack**: the session's steps fold into the photo's history, which then
lists each module once, as darktable stores it. Steps you have undone are
dropped, and the steps before cannot be undone any more. Immage saves the
history compressed in any case, so the photo's sidecar stays small whether
you press it or not.

![The History card with a few steps](images/history.png)
<!-- screenshot: Library panel, History card open, several steps above the opening stack -->

## Reset all

**Reset all**, in the Adjustments panel's head, takes the photo back to its
starting point: sliders, crop, look, masks and spots. It is one step, so
⌘Z brings everything back.

## Copying settings to other photos

The buttons at the bottom of the right panel:

- **Copy…** (⇧⌘C) opens **Copy Settings**: tick what to copy, then copy
  it.
- **Paste** (⇧⌘V) pastes those settings onto the open photo. To give
  several photos the same settings, open each and paste; ← and → step
  through them.
- **Previous** (⌥⌘V) pastes the previous photo's settings, the parts ticked
  in Copy Settings.

**Copy Settings** groups: **Profile**, **Treatment**, **White Balance**,
**Tone**, **Presence**, **Tone Curve**, **HSL / Color**, **B&W Mix**, **Color
Grading**, **Sharpening**, **Profiled Denoise**, **Lens
Corrections**, **Transform**, **Post-Crop Vignetting**, **Grain**,
**Crop**, **Look** and **Masks**. **Crop** and **Masks**
start unticked. Your choice is remembered.

Each paste is one step: ⌘Z undoes it.
