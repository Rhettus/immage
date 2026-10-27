# Edit In

**Edit In** sends photos to another application for something Immage
doesn't do itself, and brings back the file it saves, ready to edit. It
works with **DxO PureRAW**, for its noise reduction and lens sharpening on
raws, and **Macro Studio**, for focus stacking
([below](#macro-studio-focus-stacking)).

**If you've used another editor:** this is the usual Edit In command and
PureRAW's own plugin in one. The returned file appears beside its original,
and Immage switches off the corrections PureRAW has already made.

## Setting it up

1. Open **Preferences** (⌘,), the **Plugins** tab.
2. Click **Add Plugin ▾** and choose **DxO PureRAW**. Immage looks for the
   application in your Applications folder. If it isn't found, click
   **Choose…** beside **Application**.
3. In PureRAW, set it to save **DNG** files.
4. Leave **Results folder** empty if PureRAW saves to a "DxO" folder beside
   the photo, or beside the photo itself. Otherwise choose where it
   saves.
5. Choose what to switch off on a returned file, the first time it opens:
   - **Turn off lens corrections**: on, as PureRAW has corrected the lens
   - **Turn off noise reduction**: on, as PureRAW has removed the noise
   - **Turn off sharpening**: off; turn it on if PureRAW's lens sharpness
     was on

**Name** sets what the Edit In menu calls it.

![Preferences, Plugins tab with DxO PureRAW set up](images/edit-in-prefs.png)
<!-- screenshot: Preferences > Plugins with one DxO PureRAW card, application found -->

## Sending photos

Select one or more raw photos, right-click, and choose **Edit In ›
DxO PureRAW**. PureRAW opens with them.

While PureRAW works, a banner reads **Waiting for DxO PureRAW · 1 of 3
back…**, with **Stop waiting**. You can keep editing meanwhile.

## What comes back

As each DNG is saved, it appears in the filmstrip beside its raw. The first
one opens. The first time each opens, the corrections you chose are
switched off, and the History card shows it, for example
**DxO PureRAW: lens corrections, noise reduction off**. After that it is a
photo like any other.

Immage stops waiting when every photo is back, when you click **Stop
waiting**, or after three hours.

## When Edit In is grayed out

| Reason shown | Why |
| --- | --- |
| **choose its application in Preferences** | PureRAW wasn't found; set **Application**. |
| **raw files only** | PureRAW only takes raws, and so does Macro Studio set to send **Raws**. |
| **select at least 2 photos** | Macro Studio stacks two or more. |
| **only photos on this computer** | An Immich result that hasn't been opened or downloaded yet. |

## Macro Studio: focus stacking

[Macro Studio](https://macrostudio.pro) merges a focus bracket, the same
subject shot at a run of focus distances, into one photo sharp from front
to back. Immage hands it the bracket and takes back the stack.

**If you've used another editor:** this is Macro Studio's own Lightroom
plugin: the stack opens in Macro Studio for you to check and retouch, and
comes back when you save it there.

### Setting it up

1. In **Preferences › Plugins**, click **Add Plugin ▾** and choose
   **Macro Studio**. Immage looks for it in your Applications folder; if
   it isn't found, click **Choose…** beside **Application**.
2. **Send**:
   - **Raws** (the default): the raw files go over as they are, with
     nothing clipped on the way, and the stack comes back as a raw DNG to
     edit here from the start. Your edit to the frames doesn't go with
     them.
   - **16-bit TIFFs**: each frame is written with its edit so far, as
     "-Edit" TIFFs beside the photos, and the stack has that edit baked
     in. Very saturated colors can clip. Takes photos that aren't raws.
3. **Look**: Macro Studio's finish on the stack. **Natural** leaves it
   as stacked, **Enhanced** sharpens it and adds clarity, and
   **Default** is what Macro Studio's own preferences say.

### Stacking

Select the frames of one bracket (two or more), right-click, and choose
**Edit In › Macro Studio**. Macro Studio stacks them and opens the result
in its editor. The banner reads **Waiting for Macro Studio…** meanwhile,
and you can keep editing.

Save the stack in Macro Studio, as DNG for the most latitude. It appears
in the filmstrip beside the first frame, named after it
(**P1010001-stacked.dng**), and opens. A stack made from raws starts
with the defaults a new raw gets. Saved again, it comes back again.

A stack saved after Immage stopped waiting, or while Immage was closed,
comes back the next time its folder is shown. Immage stops waiting when
the stack is saved or closed in Macro Studio, when you click **Stop
waiting**, or if Macro Studio doesn't start or stops responding.

